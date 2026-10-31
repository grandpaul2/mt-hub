package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// Relay streams: the list follows the relay's ready "-web" channels and names them by
// relay.json; watching needs a login, goes to the relay with the hub's account and comes back
// with its answer; viewers are the relay's sessions the hub made; you can end only your own;
// a banned streamer or viewer goes; an unreachable relay or no relay.json means no streams.
func TestRelay(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	names := []string{"Pat", "Steve", "Alex", "Eve"}
	for _, n := range names {
		us.SetPassword(n, n+"-password")
	}

	// The stub relay: MediaMTX's API and WHEP, checking the account.
	var mu sync.Mutex
	ready := map[string]bool{} // path -> live
	type sess struct{ path, query, secret string }
	sessions := []sess{}
	var badAuth, deleted []string
	down := false
	started := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if down {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		if u, p, ok := r.BasicAuth(); !ok || u != "hub" || p != "hub-pass" {
			badAuth = append(badAuth, r.URL.Path)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.URL.Path == "/api/v3/paths/list":
			items := []map[string]any{}
			for p, on := range ready {
				it := map[string]any{"name": p, "ready": on, "readyTime": nil}
				if on {
					it["readyTime"] = started.Format(time.RFC3339Nano)
				}
				items = append(items, it)
			}
			json.NewEncoder(w).Encode(map[string]any{"items": items})
		case r.URL.Path == "/api/v3/webrtcsessions/list":
			items := []map[string]any{{"created": started, "state": "publish", "path": "live-web", "query": ""}}
			for i, x := range sessions {
				items = append(items, map[string]any{"created": started.Add(time.Duration(i) * time.Second), "state": "read", "path": x.path, "query": x.query})
			}
			json.NewEncoder(w).Encode(map[string]any{"items": items})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/whep"):
			p := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"), "/whep")
			body, _ := io.ReadAll(r.Body)
			if !ready[p] || r.Header.Get("Content-Type") != "application/sdp" || !strings.HasPrefix(string(body), "v=0") {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			secret := fmt.Sprintf("secret%d", len(sessions))
			sessions = append(sessions, sess{p, r.URL.RawQuery, secret})
			w.Header().Set("Location", "whep/"+secret)
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, "v=0 answer for "+p)
		case r.Method == "DELETE" && strings.Contains(r.URL.Path, "/whep/"):
			secret := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			deleted = append(deleted, secret)
			sessions = slices.DeleteFunc(sessions, func(x sess) bool { return x.secret == secret })
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer stub.Close()

	s := New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil)
	srv := httptest.NewServer(s)
	defer srv.Close()
	cookie := map[string]string{}
	for _, n := range names {
		cookie[n], _ = us.Login(n, n+"-password")
	}
	call := func(who, method, path, body string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if who != "" {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie[who]})
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	type listed struct {
		Relay []struct {
			Name    string
			Started time.Time
			Viewers []string
		}
		RelayDelay int
	}
	list := func() listed {
		t.Helper()
		s.relayCheckOnce()
		code, body := call("Alex", "GET", "/api/streams", "")
		var out listed
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil || out.Relay == nil {
			t.Fatalf("GET /api/streams: %d %s", code, body)
		}
		return out
	}
	namesOf := func(l listed) string {
		out := []string{}
		for _, x := range l.Relay {
			out = append(out, x.Name+"("+strings.Join(x.Viewers, ",")+")")
		}
		return strings.Join(out, " ")
	}
	offer := `{"sdp":"v=0 offer"}`

	// No relay.json: nothing listed, nobody to watch, and the relay isn't asked.
	mu.Lock()
	ready["live-web"] = true
	mu.Unlock()
	if l := list(); len(l.Relay) != 0 {
		t.Fatalf("without relay.json: %s", namesOf(l))
	}
	if code, _ := call("Alex", "POST", "/api/relay/Pat/watch", offer); code != 404 {
		t.Fatalf("watch without relay.json: %d", code)
	}

	conf := func(delay string) {
		os.WriteFile(filepath.Join(dir, "relay.json"), []byte(`{"url":"`+stub.URL+`","user":"hub","pass":"hub-pass","channels":{"live":"Pat","steve":"Steve","gone":"Nobody"}`+delay+`}`), 0o600)
		os.Chtimes(filepath.Join(dir, "relay.json"), time.Now(), time.Now().Add(time.Duration(len(delay))*time.Second)) // a new mod time each time
	}
	conf("")

	// A ready -web channel is listed under its person's name; the channel itself, a channel
	// that isn't ready, one nobody is named for and one whose account doesn't exist are not.
	mu.Lock()
	ready["live"], ready["steve-web"], ready["other-web"], ready["gone-web"] = true, false, true, true
	mu.Unlock()
	l := list()
	if namesOf(l) != "Pat()" || !l.Relay[0].Started.Equal(started) || l.RelayDelay != 700 {
		t.Fatalf("list: %s started %v delay %d", namesOf(l), l.Relay, l.RelayDelay)
	}
	conf(`,"delay_ms":450`)
	if l := list(); l.RelayDelay != 450 {
		t.Fatalf("delay_ms: %d", l.RelayDelay)
	}

	// Watching: a login, a real offer, someone live.
	if code, _ := call("", "POST", "/api/relay/Pat/watch", offer); code != 401 {
		t.Fatalf("watch without a login: %d", code)
	}
	if code, _ := call("Alex", "POST", "/api/relay/Pat/watch", `{"sdp":"hello"}`); code != 400 {
		t.Fatalf("watch with no offer: %d", code)
	}
	if code, body := call("Alex", "POST", "/api/relay/Steve/watch", offer); code != 404 || !strings.Contains(body, "Steve isn't streaming") {
		t.Fatalf("watch someone not live: %d %s", code, body)
	}
	if code, _ := call("Alex", "POST", "/api/relay/Eve/watch", offer); code != 404 {
		t.Fatalf("watch someone with no channel: %d", code)
	}
	watch := func(who string) string {
		t.Helper()
		code, body := call(who, "POST", "/api/relay/Pat/watch", offer)
		var out struct{ ID, SDP string }
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil || out.ID == "" || out.SDP != "v=0 answer for live-web" {
			t.Fatalf("%s watching: %d %s", who, code, body)
		}
		return out.ID
	}
	alex := watch("Alex")
	eve := watch("Eve")
	watch("Alex") // a second tab: counted once
	if n := namesOf(list()); n != "Pat(Alex,Eve)" {
		t.Fatalf("viewers: %s", n)
	}
	mu.Lock()
	if len(badAuth) != 0 {
		t.Fatalf("the hub asked the relay without its account: %v", badAuth)
	}
	mu.Unlock()

	// Ending a session: only your own.
	call("Alex", "DELETE", "/api/relay/sessions/"+eve, "")
	if n := namesOf(list()); n != "Pat(Alex,Eve)" {
		t.Fatalf("Alex ended Eve's session: %s", n)
	}
	call("Eve", "DELETE", "/api/relay/sessions/"+eve, "")
	mu.Lock()
	if !slices.Equal(deleted, []string{"secret1"}) {
		t.Fatalf("sessions ended on the relay: %v", deleted)
	}
	mu.Unlock()
	if n := namesOf(list()); n != "Pat(Alex)" {
		t.Fatalf("after Eve left: %s", n)
	}
	_ = alex

	// A banned viewer's sessions are ended on the relay; a banned streamer isn't listed.
	us.Change("Alex", func(u *auth.User) { u.Banned = true })
	cookie["Alex"], _ = us.Login("Steve", "Steve-password") // someone still allowed asks from here on
	if n := namesOf(list()); n != "Pat()" {
		t.Fatalf("a banned viewer still counted: %s", n)
	}
	mu.Lock()
	if len(deleted) != 3 || len(sessions) != 0 {
		t.Fatalf("a banned viewer's sessions: ended %v, left %v", deleted, sessions)
	}
	mu.Unlock()
	us.Change("Pat", func(u *auth.User) { u.Banned = true })
	if n := namesOf(list()); n != "" {
		t.Fatalf("a banned streamer listed: %s", n)
	}
	us.Change("Pat", func(u *auth.User) { u.Banned = false })

	// The relay unreachable: nothing listed, and back when it is.
	if n := namesOf(list()); n != "Pat()" {
		t.Fatalf("unbanned: %s", n)
	}
	mu.Lock()
	down = true
	mu.Unlock()
	if n := namesOf(list()); n != "" {
		t.Fatalf("relay down: %s", n)
	}
	if code, _ := call("Eve", "POST", "/api/relay/Pat/watch", offer); code != 502 {
		t.Fatalf("watch with the relay down: %d", code)
	}
	mu.Lock()
	down = false
	mu.Unlock()
	if n := namesOf(list()); n != "Pat()" {
		t.Fatalf("relay back: %s", n)
	}

	// The stream ends on the relay: gone from the list.
	mu.Lock()
	ready["live-web"] = false
	mu.Unlock()
	if n := namesOf(list()); n != "" {
		t.Fatalf("ended: %s", n)
	}
}
