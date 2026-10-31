package server

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

func TestAdmin(t *testing.T) {
	us, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Pat owns the hub, Eldridge is an admin, Steve and Alex are members.
	for name, role := range map[string]auth.User{"Pat": {Owner: true, Admin: true}, "Eldridge": {Admin: true}, "Steve": {}, "Alex": {}} {
		us.SetPassword(name, name+"-password")
		us.Change(name, func(u *auth.User) { u.Owner, u.Admin = role.Owner, role.Admin })
	}
	s := &Server{users: us, logins: newLimiter(loginTries, loginWindow), accounts: newLimiter(accountTries, accountWindow), bus: newBroker(), mux: http.NewServeMux()}
	s.accountRoutes()
	srv := httptest.NewServer(s)
	defer srv.Close()

	cookies := map[string]string{}
	login := func(name string) string {
		c, err := us.Login(name, name+"-password")
		if err != nil {
			t.Fatal(err)
		}
		cookies[name] = c
		return c
	}
	for _, n := range []string{"Pat", "Eldridge", "Steve", "Alex"} {
		login(n)
	}
	call := func(who, method, path, body string) (int, map[string]any) {
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookies[who]})
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	want := func(label string, got, wantCode int) {
		t.Helper()
		if got != wantCode {
			t.Errorf("%s: %d, want %d", label, got, wantCode)
		}
	}

	// Who may do what.
	code, _ := call("Steve", "GET", "/api/admin/users", "")
	want("member opens the admin page", code, 403)
	code, _ = call("Steve", "PATCH", "/api/admin/users/Alex", `{"banned":true}`)
	want("member bans", code, 403)
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Pat", `{"banned":true}`)
	want("admin bans the owner", code, 403)
	code, _ = call("Eldridge", "POST", "/api/admin/users/Pat/password", "")
	want("admin resets the owner", code, 403)
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Steve", `{"admin":true}`)
	want("admin makes an admin", code, 403)
	code, _ = call("Eldridge", "POST", "/api/admin/users", `{"name":"Herobrine","admin":true}`)
	want("admin adds an admin", code, 403)
	code, _ = call("Pat", "DELETE", "/api/admin/users/Pat", "")
	want("owner deletes themselves", code, 403)
	code, _ = call("Pat", "PATCH", "/api/admin/users/Nobody", `{"banned":true}`)
	want("no such user", code, 404)

	// Admin tag colours: yours, or anyone's for the owner; admins only; one of the set colours.
	code, _ = call("Eldridge", "PUT", "/api/admin/users/Eldridge/tag", `{"tag":"teal"}`)
	want("admin sets their own tag", code, 200)
	code, _ = call("Eldridge", "PUT", "/api/admin/users/Pat/tag", `{"tag":"red"}`)
	want("admin sets the owner's tag", code, 403)
	code, _ = call("Steve", "PUT", "/api/admin/users/Steve/tag", `{"tag":"red"}`)
	want("member sets a tag", code, 403)
	code, _ = call("Pat", "PUT", "/api/admin/users/Alex/tag", `{"tag":"red"}`)
	want("tag for a member", code, 400)
	code, _ = call("Pat", "PUT", "/api/admin/users/Eldridge/tag", `{"tag":"#ff0000"}`)
	want("a colour not in the set", code, 400)
	code, _ = call("Pat", "PUT", "/api/admin/users/Eldridge/tag", `{"tag":"pink"}`)
	want("owner sets an admin's tag", code, 200)
	tagReq, _ := http.NewRequest("GET", srv.URL+"/api/users", nil)
	tagReq.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookies["Alex"]})
	tagRes, err := http.DefaultClient.Do(tagReq)
	if err != nil {
		t.Fatal(err)
	}
	var tags []account
	json.NewDecoder(tagRes.Body).Decode(&tags)
	tagRes.Body.Close()
	gotTags := map[string]string{}
	for _, a := range tags {
		gotTags[a.Name] = a.Tag
	}
	if gotTags["Eldridge"] != "pink" || gotTags["Pat"] != "gold" || gotTags["Alex"] != "" {
		t.Errorf("tags in /api/users: %v (want Eldridge pink, Pat gold by default, Alex none)", gotTags)
	}

	// A ban: Steve's open stream ends at once, his session is refused (saying why), and
	// logging in again says banned.
	r, _ := http.NewRequest("GET", srv.URL+"/api/events", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookies["Steve"]})
	stream, err := http.DefaultClient.Do(r)
	if err != nil || stream.StatusCode != 200 {
		t.Fatalf("stream: %v %v", err, stream)
	}
	ended := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stream.Body)
		for sc.Scan() {
		}
		close(ended)
	}()
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Steve", `{"banned":true}`)
	want("admin bans a member", code, 200)
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Error("banned user's stream still open")
	}
	code, body := call("Steve", "GET", "/api/me", "")
	if code != 401 || body["error"] != "this account is banned" {
		t.Errorf("banned session: %d %v", code, body)
	}
	res, _ := http.Post(srv.URL+"/api/login", "", strings.NewReader(`{"name":"Steve","password":"Steve-password"}`))
	want("banned login", res.StatusCode, 403)

	// Unban: the old session works again.
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Steve", `{"banned":false}`)
	want("unban", code, 200)
	code, _ = call("Steve", "GET", "/api/me", "")
	want("unbanned session", code, 200)

	// A new password: the same one is refused (a temporary one would stay one others have
	// seen); a new one ends the other pages' streams at once, not 25 s later.
	code, body = call("Steve", "POST", "/api/password", `{"old":"Steve-password","new":"Steve-password"}`)
	want("same password again", code, 400)
	r, _ = http.NewRequest("GET", srv.URL+"/api/events", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookies["Steve"]})
	stream, err = http.DefaultClient.Do(r)
	if err != nil || stream.StatusCode != 200 {
		t.Fatalf("stream: %v %v", err, stream)
	}
	ended = make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stream.Body)
		for sc.Scan() {
		}
		close(ended)
	}()
	code, _ = call("Steve", "POST", "/api/password", `{"old":"Steve-password","new":"Steve-password-2"}`)
	want("new password", code, 200)
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Error("stream still open after a new password")
	}

	// Reset: a temporary password; old sessions end.
	code, body = call("Eldridge", "POST", "/api/admin/users/Alex/password", "")
	want("reset", code, 200)
	code, _ = call("Alex", "GET", "/api/me", "")
	want("session after reset", code, 401)
	if _, err := us.Login("Alex", body["password"].(string)); err != nil {
		t.Errorf("temp password: %v", err)
	}

	// Add and delete.
	code, body = call("Eldridge", "POST", "/api/admin/users", `{"name":"Herobrine"}`)
	want("add", code, 200)
	if _, err := us.Login("Herobrine", body["password"].(string)); err != nil {
		t.Errorf("new user's password: %v", err)
	}
	code, _ = call("Eldridge", "POST", "/api/admin/users", `{"name":"herobrine"}`)
	want("add a taken name", code, 409)
	code, _ = call("Eldridge", "DELETE", "/api/admin/users/Herobrine", "")
	want("delete", code, 200)
	// The name is retired: chats know people by name, so a new Herobrine would get the old
	// one's DMs and private chats.
	for _, n := range []string{"Herobrine", "HEROBRINE"} {
		code, body = call("Pat", "POST", "/api/admin/users", `{"name":"`+n+`"}`)
		if code != 409 || body["error"] != auth.ErrRetired.Error() {
			t.Errorf("re-add %s: %d %v", n, code, body)
		}
	}

	// Admins set Minecraft names: someone's, their own, and with a new account. A member can't
	// set their own any more. One name goes to one account.
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Alex", `{"mc":"Notch"}`)
	want("admin sets someone's Minecraft name", code, 200)
	if u, _ := us.Get("Alex"); u.MC != "Notch" {
		t.Errorf("not set: %q", u.MC)
	}
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Eldridge", `{"mc":"notch"}`)
	want("a name another account has", code, 409)
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Eldridge", `{"mc":"El_dridge"}`)
	want("admin sets their own", code, 200)
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Eldridge", `{"mc":"x","banned":true}`)
	want("but nothing else on themselves", code, 403)
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Alex", `{"mc":"no spaces"}`)
	want("not a Minecraft name", code, 400)
	code, _ = call("Eldridge", "POST", "/api/admin/users", `{"name":"Lennox","mc":"Notch"}`)
	want("a new account with a taken Minecraft name", code, 409)
	if _, ok := us.Get("Lennox"); ok {
		t.Error("the account was made anyway")
	}
	code, _ = call("Eldridge", "POST", "/api/admin/users", `{"name":"Lennox","mc":"Lennox_mc"}`)
	want("a new account with its Minecraft name", code, 200)
	if u, _ := us.Get("Lennox"); u.MC != "Lennox_mc" {
		t.Errorf("new account's Minecraft name: %q", u.MC)
	}
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Alex", `{"mc":""}`)
	want("admin unlinks a Minecraft name", code, 200)
	if u, _ := us.Get("Alex"); u.MC != "" {
		t.Errorf("still linked: %q", u.MC)
	}
	if err := us.SetMC("Alex", "ab"); err == nil {
		t.Error("a 2-letter Minecraft name was accepted")
	}

	// The owner manages admins.
	code, _ = call("Pat", "PATCH", "/api/admin/users/Steve", `{"admin":true}`)
	want("owner makes an admin", code, 200)
	code, _ = call("Eldridge", "PATCH", "/api/admin/users/Steve", `{"banned":true}`)
	want("admin bans an admin", code, 403)
	code, _ = call("Pat", "PATCH", "/api/admin/users/Steve", `{"admin":false}`)
	want("owner removes an admin", code, 200)

	// The list (with who's on) and the log.
	r, _ = http.NewRequest("GET", srv.URL+"/api/admin/users", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookies["Pat"]})
	res, _ = http.DefaultClient.Do(r)
	var list []adminUser
	json.NewDecoder(res.Body).Decode(&list)
	if len(list) != 5 || list[0].Name != "Alex" || !list[1].Admin || list[1].MC != "El_dridge" || list[2].MC != "Lennox_mc" || !list[3].Owner || !list[3].Online {
		t.Errorf("list: %+v", list)
	}
	log, _ := us.ReadLog(100)
	var got []string
	for _, e := range log {
		got = append(got, e.By+" "+e.Action+" "+e.User)
	}
	wantLog := "Pat unadmin Steve|Pat admin Steve|Eldridge unlink-mc Alex|Eldridge add Lennox|Eldridge set-mc Eldridge|Eldridge set-mc Alex|Eldridge delete Herobrine|Eldridge add Herobrine|Eldridge reset Alex|Eldridge unban Steve|Eldridge ban Steve"
	if strings.Join(got, "|") != wantLog {
		t.Errorf("log:\n%s\nwant\n%s", strings.Join(got, "|"), wantLog)
	}
}
