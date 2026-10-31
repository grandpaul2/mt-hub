package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

func TestLogin(t *testing.T) {
	failDelay = 0
	us, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	us.SetPassword("patmc", "right password")
	s := &Server{users: us, logins: newLimiter(loginTries, loginWindow), accounts: newLimiter(accountTries, accountWindow)}
	try := func(pw, remote string, hdr map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"name":"patmc","password":"`+pw+`"}`))
		r.RemoteAddr = remote
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		s.login(w, r)
		return w
	}
	cookie := func(w *httptest.ResponseRecorder) *http.Cookie { return w.Result().Cookies()[0] }

	// Over the LAN (plain http): a cookie without Secure, or the browser would drop it.
	// Through Caddy (loopback + X-Forwarded-Proto: https): Secure. The header alone, from
	// a LAN address, is ignored.
	https := map[string]string{"X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9"}
	if w := try("right password", "192.168.1.5:5000", nil); w.Code != 200 || cookie(w).Secure {
		t.Fatalf("lan: %d secure=%v", w.Code, cookie(w).Secure)
	}
	if w := try("right password", "127.0.0.1:5000", https); w.Code != 200 || !cookie(w).Secure {
		t.Fatalf("proxied: %d secure=%v", w.Code, cookie(w).Secure)
	}
	if w := try("right password", "192.168.1.5:5000", https); cookie(w).Secure {
		t.Fatal("trusted X-Forwarded-Proto from a LAN address")
	}

	// Five wrong passwords from one internet address lock that address out, even with the
	// right password; another address, and the LAN, are unaffected.
	for i := 0; i < loginTries; i++ {
		if w := try("wrong", "127.0.0.1:5000", https); w.Code != 401 {
			t.Fatalf("wrong password %d: %d", i, w.Code)
		}
	}
	if w := try("right password", "127.0.0.1:5000", https); w.Code != 429 {
		t.Fatalf("locked out: %d", w.Code)
	}
	other := map[string]string{"X-Forwarded-Proto": "https", "X-Forwarded-For": "198.51.100.7"}
	if w := try("right password", "127.0.0.1:5000", other); w.Code != 200 {
		t.Fatalf("other address: %d", w.Code)
	}
	// A spoofed X-Forwarded-For can't dodge it: Caddy puts the real client last.
	spoof := map[string]string{"X-Forwarded-Proto": "https", "X-Forwarded-For": "1.2.3.4, 203.0.113.9"}
	if w := try("right password", "127.0.0.1:5000", spoof); w.Code != 429 {
		t.Fatalf("spoofed: %d", w.Code)
	}
}

// A burst of guesses sent at once gets no more than the limit: each is counted before its
// password is checked. Many addresses guessing one account hit the account's limit, and the
// current-password check in Change Password counts too.
func TestGuessLimits(t *testing.T) {
	failDelay = 0
	us, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	us.SetPassword("patmc", "right password")
	s := &Server{users: us, logins: newLimiter(loginTries, loginWindow), accounts: newLimiter(accountTries, accountWindow)}
	try := func(remote string) int {
		r := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"name":"patmc","password":"wrong"}`))
		r.RemoteAddr = remote
		w := httptest.NewRecorder()
		s.login(w, r)
		return w.Code
	}

	codes := make(chan int, 40)
	var wg sync.WaitGroup
	for range 40 {
		wg.Add(1)
		go func() { defer wg.Done(); codes <- try("192.168.1.5:5000") }()
	}
	wg.Wait()
	close(codes)
	checked := 0
	for c := range codes {
		if c == 401 {
			checked++
		}
	}
	if checked != loginTries {
		t.Fatalf("burst: %d passwords checked, want %d", checked, loginTries)
	}

	// 5 more from a second address: the account has had 10 and is closed to a third.
	for range loginTries {
		try("192.168.1.6:5000")
	}
	if c := try("192.168.1.7:5000"); c != 429 {
		t.Fatalf("account limit: %d", c)
	}

	// Change Password's current-password check uses the same counts.
	s.accounts = newLimiter(accountTries, accountWindow)
	for i := range accountTries + 1 {
		r := httptest.NewRequest("POST", "/api/password", strings.NewReader(`{"old":"wrong","new":"whatever123"}`))
		r.RemoteAddr = "192.168.1." + strconv.Itoa(20+i) + ":5000"
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, account{Name: "patmc"}))
		w := httptest.NewRecorder()
		s.password(w, r)
		if want := map[bool]int{true: 403, false: 429}[i < accountTries]; w.Code != want {
			t.Fatalf("password try %d: %d, want %d", i, w.Code, want)
		}
	}
}

// A right password forgives only that address's tries at that account: your own typos don't
// count, but logging in to your own account between guesses at others no longer resets them
// (the bug sweep sprayed guesses at seven accounts without ever hitting the limit).
func TestLoginForgivesOwnTries(t *testing.T) {
	failDelay = 0
	us, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	us.SetPassword("Alex", "alex password")
	s := &Server{users: us, logins: newLimiter(loginTries, loginWindow), accounts: newLimiter(accountTries, accountWindow)}
	try := func(name, pw string) int {
		r := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"name":"`+name+`","password":"`+pw+`"}`))
		r.RemoteAddr = "192.168.1.5:5000"
		w := httptest.NewRecorder()
		s.login(w, r)
		return w.Code
	}
	for range loginTries - 1 { // typos at your own account, then the right one
		try("Alex", "typo")
	}
	if c := try("Alex", "alex password"); c != 200 {
		t.Fatalf("own login after typos: %d", c)
	}
	codes := []int{}
	for i := range 2 * loginTries {
		codes = append(codes, try("Victim"+strconv.Itoa(i), "guess"))
		try("Alex", "alex password")
	}
	if !slices.Contains(codes, 429) {
		t.Fatalf("guesses at other accounts never hit the limit: %v", codes)
	}
}

// A password bcrypt can't take is refused plainly, not with "internal error".
func TestPasswordTooLong(t *testing.T) {
	failDelay = 0
	us, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	us.SetPassword("Alex", "alex password")
	s := &Server{users: us, logins: newLimiter(loginTries, loginWindow), accounts: newLimiter(accountTries, accountWindow), bus: newBroker()}
	for pw, want := range map[string]int{strings.Repeat("b", 73): 400, strings.Repeat("😀", 19): 400, strings.Repeat("b", 72): 200} {
		r := httptest.NewRequest("POST", "/api/password", strings.NewReader(`{"old":"alex password","new":"`+pw+`"}`))
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, account{Name: "Alex"}))
		w := httptest.NewRecorder()
		s.password(w, r)
		if w.Code != want {
			t.Errorf("%d-byte password: %d %s, want %d", len(pw), w.Code, w.Body, want)
		}
		if w.Code == 200 {
			us.SetPassword("Alex", "alex password")
		}
	}
}

// Log Out Everywhere ends every other copy of the session; the browser that asked gets a
// new cookie and stays in.
func TestLogoutAll(t *testing.T) {
	us, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	us.SetPassword("patmc", "right password")
	s := &Server{users: us, logins: newLimiter(loginTries, loginWindow), accounts: newLimiter(accountTries, accountWindow), bus: newBroker(), mux: http.NewServeMux()}
	s.accountRoutes()
	old, _ := us.Login("patmc", "right password")
	call := func(method, path, cookie string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	w := call("POST", "/api/logout-all", old)
	if w.Code != 200 || len(w.Result().Cookies()) != 1 {
		t.Fatalf("logout-all: %d %v", w.Code, w.Result().Cookies())
	}
	if c := call("GET", "/api/me", old).Code; c != 401 {
		t.Fatalf("old cookie after logout-all: %d", c)
	}
	if c := call("GET", "/api/me", w.Result().Cookies()[0].Value).Code; c != 200 {
		t.Fatalf("new cookie: %d", c)
	}
}
