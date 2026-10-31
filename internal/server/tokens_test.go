package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// Server tokens (the MT Hub mod on our game servers): they reach only their few routes,
// post screenshots under the player's Minecraft name, and can't be made from the page.
func TestTokens(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	// Pat owns the hub; Steve and Alex are members.
	for _, n := range []string{"Pat", "Steve", "Alex"} {
		us.SetPassword(n, n+"-password")
	}
	us.Change("Pat", func(u *auth.User) { u.Owner, u.Admin = true, true })
	a := workspace.Author{Name: "Pat"}
	ws.Write("schematics/Gold Farm/gold.litematic", []byte("schem"), "", a)
	ws.Write("commands/botspawner.md", []byte("# Gold Farm"), "", a)
	ws.Write("notes.md", []byte("secret plans"), "", a)
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()

	cookie := map[string]string{}
	for _, n := range []string{"Pat", "Steve", "Alex"} {
		cookie[n], _ = us.Login(n, n+"-password")
	}
	// with is "cookie:<name>" or "token:<token>".
	call := func(with, method, path string, body io.Reader) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, body)
		if name, ok := strings.CutPrefix(with, "cookie:"); ok {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie[name]})
		} else {
			r.Header.Set("Authorization", "Bearer "+strings.TrimPrefix(with, "token:"))
		}
		c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := c.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	want := func(label string, got, code int) {
		t.Helper()
		if got != code {
			t.Errorf("%s: %d, want %d", label, got, code)
		}
	}
	tok, _, err := us.NewToken("survival", "")
	if err != nil {
		t.Fatal(err)
	}
	survival := "token:" + tok

	// Who it is, /b's shortcuts, the schematics.
	code, body := call(survival, "GET", "/api/me", nil)
	if code != 200 || !strings.Contains(body, `"name":"survival"`) || !strings.Contains(body, `"token":"server"`) || !strings.Contains(body, `"admin":false`) {
		t.Errorf("me = %d %s", code, body)
	}
	code, body = call(survival, "GET", "/api/file/commands/botspawner.md", nil)
	want("commands", code, 200)
	if body != "# Gold Farm" {
		t.Errorf("commands = %q", body)
	}
	code, _ = call(survival, "GET", "/api/stat/commands/botspawner.md", nil)
	want("stat", code, 200)
	code, body = call(survival, "GET", "/api/schematics", nil)
	want("schematics list", code, 200)
	if !strings.Contains(body, `"gold.litematic"`) {
		t.Errorf("schematics list = %s", body)
	}
	code, body = call(survival, "GET", "/api/file/schematics/Gold%20Farm/gold.litematic", nil)
	want("a schematic", code, 200)
	if body != "schem" {
		t.Errorf("schematic = %q", body)
	}

	// Nothing else.
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/file/notes.md"},
		{"GET", "/api/file/schematics/../notes.md"},
		{"PUT", "/api/file/commands/botspawner.md"},
		{"PUT", "/api/file/schematics/x.litematic"},
		{"GET", "/api/stat/notes.md"},
		{"GET", "/api/tree"},
		{"GET", "/api/channels"},
		{"GET", "/api/admin/users"},
		{"POST", "/api/password"},
		{"GET", "/api/events"},
		{"POST", "/api/tokens"},
	} {
		code, _ = call(survival, c.method, c.path, nil)
		want(c.method+" "+c.path, code, 403)
	}

	// Screenshots: named by the game's file name (the player's clock) and the Minecraft name
	// the server gives, numbered when taken; the poster must look like a Minecraft name;
	// anything but a PNG is refused.
	png := "\x89PNG\r\n\x1a\nfake picture"
	code, body = call(survival, "POST", "/api/screenshots?name=2026-10-03_21.04.11.png&poster=patmc", strings.NewReader(png))
	want("screenshot", code, 200)
	if !strings.Contains(body, `"screenshots/2026-10-03 21.04.11 patmc.png"`) {
		t.Errorf("screenshot path = %s", body)
	}
	code, body = call(survival, "POST", "/api/screenshots?name=2026-10-03_21.04.11_2.png&poster=patmc", strings.NewReader(png))
	want("screenshot, same second", code, 200)
	if !strings.Contains(body, `"screenshots/2026-10-03 21.04.11 patmc (2).png"`) {
		t.Errorf("second screenshot path = %s", body)
	}
	if data, err := ws.Read("screenshots/2026-10-03 21.04.11 patmc.png", ""); err != nil || string(data) != png {
		t.Errorf("screenshot saved: %q %v", data, err)
	}
	code, _ = call(survival, "POST", "/api/screenshots?name=../../notes.png&poster=Alex", strings.NewReader(png))
	want("screenshot with an odd name (saved under now)", code, 200)
	for _, poster := range []string{"", "../Pat", "Steve Smith", "a_name_far_too_long"} {
		code, _ = call(survival, "POST", "/api/screenshots?poster="+url.QueryEscape(poster), strings.NewReader(png))
		want("poster "+strconv.Quote(poster), code, 400)
	}
	code, _ = call(survival, "POST", "/api/screenshots?poster=Alex", strings.NewReader("<html>"))
	want("not a PNG", code, 400)
	// A game server's screenshot has a smaller cap than a member's upload.
	oldCap := maxTokenShot
	maxTokenShot = 64
	code, _ = call(survival, "POST", "/api/screenshots?poster=Alex", strings.NewReader(png+strings.Repeat("x", 100)))
	want("a game server's screenshot over its cap", code, 413)
	maxTokenShot = oldCap
	// ...and a day's bytes run out too.
	oldDay := tokenShotBytes
	tokenShotBytes = 0
	code, _ = call(survival, "POST", "/api/screenshots?poster=Alex", strings.NewReader(png))
	want("a game server past its bytes for the day", code, 429)
	tokenShotBytes = oldDay

	// From the page, the poster is you, whatever ?poster= says.
	code, body = call("cookie:Steve", "POST", "/api/screenshots?name=2026-10-03_22.00.00.png&poster=Pat", strings.NewReader(png))
	if code != 200 || !strings.Contains(body, `"screenshots/2026-10-03 22.00.00 Steve.png"`) {
		t.Errorf("page screenshot = %d %s", code, body)
	}

	// A Minecraft name an admin gave an account (any case) posts under the hub name; a name
	// goes to one account only; "" takes it away; anything else isn't a Minecraft name. A member
	// can't set their own.
	code, _ = call("cookie:Steve", "POST", "/api/mc", strings.NewReader(`{"mc":"Steve_MC"}`))
	want("a member sets their own Minecraft name", code, 403)
	if err := us.SetMC("Steve", "Steve_MC"); err != nil {
		t.Fatal(err)
	}
	code, body = call("cookie:Steve", "GET", "/api/me", nil)
	if !strings.Contains(body, `"mc":"Steve_MC"`) {
		t.Errorf("me after linking = %s", body)
	}
	code, body = call(survival, "POST", "/api/screenshots?name=2026-10-03_23.00.00.png&poster=steve_mc", strings.NewReader(png))
	if code != 200 || !strings.Contains(body, `"screenshots/2026-10-03 23.00.00 Steve.png"`) {
		t.Errorf("linked poster = %d %s", code, body)
	}
	if err := us.SetMC("Alex", "STEVE_mc"); err != auth.ErrMCTaken {
		t.Errorf("taken name: %v", err)
	}
	if err := us.SetMC("Alex", "not a name!"); err == nil {
		t.Error("a bad Minecraft name was taken")
	}
	if err := us.SetMC("Steve", ""); err != nil {
		t.Errorf("unlink: %v", err)
	}
	code, body = call(survival, "POST", "/api/screenshots?name=2026-10-03_23.00.01.png&poster=Steve_MC", strings.NewReader(png))
	if code != 200 || !strings.Contains(body, `"screenshots/2026-10-03 23.00.01 Steve_MC.png"`) {
		t.Errorf("unlinked poster = %d %s", code, body)
	}
	code, _ = call(survival, "POST", "/api/mc", strings.NewReader(`{"mc":"x"}`))
	want("server token can't link names", code, 403)

	// Revoked, a wrong secret, the old per-player routes gone, bad server names.
	code, _ = call("token:mt_"+strings.Split(tok, "_")[1]+"_guess", "GET", "/api/me", nil)
	want("wrong secret", code, 401)
	toks, _ := us.Tokens()
	if err := us.Revoke(toks[0].ID); err != nil {
		t.Fatal(err)
	}
	code, _ = call(survival, "GET", "/api/me", nil)
	want("revoked", code, 401)
	code, _ = call("cookie:Pat", "POST", "/api/tokens", strings.NewReader(`{"label":"desktop"}`))
	if code == 200 {
		t.Error("the page can still make a token")
	}
	if _, _, err := us.NewToken("Survival Server", ""); err == nil {
		t.Error("a server name with spaces and capitals was taken")
	}
}

// The release token: posts, edits and deletes its own messages in #mod-discussion as
// MacroTech, and nothing else; nobody can take the name for an account.
func TestReleaseToken(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Pat", "Pat-password")
	cs.CreateChannel(ReleaseChat)
	cs.CreateChannel("general")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	tok, rt, err := us.NewReleaseToken("")
	if err != nil || rt.Kind != auth.KindRelease || rt.Server != auth.ReleaseName {
		t.Fatalf("NewReleaseToken = %+v, %v", rt, err)
	}
	call := func(method, path, body string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+tok)
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}

	code, body := call("GET", "/api/me", "")
	if code != 200 || !strings.Contains(body, `"name":"MacroTech"`) || !strings.Contains(body, `"token":"release"`) {
		t.Errorf("me = %d %s", code, body)
	}
	code, body = call("POST", "/api/channels/mod-discussion/messages", `{"text":"## MT Hub 1.3.1\n-# Client · Optional"}`)
	if code != 200 || !strings.Contains(body, `"user":"MacroTech"`) {
		t.Fatalf("post = %d %s", code, body)
	}
	id := body[strings.Index(body, `"id":"`)+6:]
	id = id[:strings.Index(id, `"`)]
	code, body = call("PATCH", "/api/channels/mod-discussion/messages/"+id, `{"text":"## MT Hub 1.3.2\n-# Client · Optional"}`)
	if code != 200 || !strings.Contains(body, "1.3.2") {
		t.Errorf("edit = %d %s", code, body)
	}
	// Pat's message: the token can't touch it.
	pm, _ := cs.Send(ReleaseChat, "Pat", chat.Draft{Text: "nice"})
	code, _ = call("PATCH", "/api/channels/mod-discussion/messages/"+pm.ID, `{"text":"hacked"}`)
	if code == 200 {
		t.Errorf("edited Pat's message")
	}
	code, _ = call("DELETE", "/api/channels/mod-discussion/messages/"+pm.ID, "")
	if code == 200 {
		t.Errorf("deleted Pat's message")
	}
	code, _ = call("DELETE", "/api/channels/mod-discussion/messages/"+id, "")
	if code != 200 {
		t.Errorf("delete own = %d", code)
	}
	// Nothing else: other chats, reactions, pins, files, screenshots.
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/channels/general/messages"},
		{"GET", "/api/channels/mod-discussion/messages"},
		{"PUT", "/api/channels/mod-discussion/messages/" + pm.ID + "/pin"},
		{"PUT", "/api/channels/mod-discussion/messages/" + pm.ID + "/reactions/x"},
		{"GET", "/api/file/notes.md"},
		{"POST", "/api/screenshots"},
		{"GET", "/api/channels"},
		{"GET", "/api/events"},
	} {
		if code, _ := call(c.method, c.path, `{"text":"x"}`); code != 403 {
			t.Errorf("%s %s = %d, want 403", c.method, c.path, code)
		}
	}
	// A game server's token can't post release cards.
	stok, _, _ := us.NewToken("survival", "")
	r, _ := http.NewRequest("POST", srv.URL+"/api/channels/mod-discussion/messages", strings.NewReader(`{"text":"x"}`))
	r.Header.Set("Authorization", "Bearer "+stok)
	if res, _ := http.DefaultClient.Do(r); res.StatusCode != 403 {
		t.Errorf("server token posting = %d, want 403", res.StatusCode)
	}
	// The name is reserved.
	for _, n := range []string{"MacroTech", "macrotech"} {
		if _, err := us.Add(n, false); err != auth.ErrReserved {
			t.Errorf("Add(%s) = %v, want ErrReserved", n, err)
		}
	}
}
