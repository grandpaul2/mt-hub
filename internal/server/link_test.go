package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// The server link: game servers post their players' lines into #server-link and read what
// the others said; people can't use those routes, and a server never gets its own lines back.
func TestServerLink(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Paul", "Paul-password")
	us.SetPassword("Lennox", "Lennox-password") // no Minecraft name linked
	us.SetMC("Paul", "grandpaul")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	cookie, _ := us.Login("Paul", "Paul-password")
	survival, _, _ := us.NewToken("survival", "")
	creative, _, _ := us.NewToken("creative", "")
	release, _, _ := us.NewReleaseToken("")

	call := func(token, method, path, body string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if token == "" {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		} else {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	type feed struct {
		You, Last string
		Messages  []linkLineOut
	}
	read := func(token, query string) feed {
		t.Helper()
		code, body := call(token, "GET", "/api/server-link"+query, "")
		if code != 200 {
			t.Fatalf("feed %s: %d %s", query, code, body)
		}
		var f feed
		json.Unmarshal([]byte(body), &f)
		return f
	}
	lines := func(f feed) string {
		var out []string
		for _, m := range f.Messages {
			out = append(out, "["+m.Tag+"] "+m.User+": "+m.Text)
		}
		return strings.Join(out, " | ")
	}

	// Only game servers.
	for _, c := range []struct {
		label, token, method string
	}{{"a person reading", "", "GET"}, {"a person posting", "", "POST"}, {"the release token", release, "GET"}} {
		if code, _ := call(c.token, c.method, "/api/server-link", `{"player":"Steve","text":"hi"}`); code != 403 {
			t.Errorf("%s: %d, want 403", c.label, code)
		}
	}
	if _, err := cs.MetaOf(LinkChat); err == nil {
		t.Error("the chat exists before any server connected")
	}

	// A server connects: the chat appears, and it's told where to start and its own tag.
	start := read(survival, "")
	if start.You != "SMP" || start.Last != "" || len(start.Messages) != 0 {
		t.Errorf("start: %+v", start)
	}
	if _, err := cs.MetaOf(LinkChat); err != nil {
		t.Error("the first server to connect should make the chat")
	}
	if c := read(creative, ""); c.You != "CMP" {
		t.Errorf("creative's tag: %q", c.You)
	}

	// Lines from the game: under the linked hub name, else the Minecraft name; bad ones refused.
	for _, c := range []struct {
		token, body string
		want        int
	}{
		{survival, `{"player":"grandpaul","text":"anyone on creative?"}`, 200},
		{creative, `{"player":"Eldridge","text":"yep"}`, 200},
		{creative, `{"player":"not a name","text":"hi"}`, 400},
		{creative, `{"player":"Eldridge","text":"   "}`, 400},
	} {
		if code, body := call(c.token, "POST", "/api/server-link", c.body); code != c.want {
			t.Errorf("posting %s: %d %s, want %d", c.body, code, body, c.want)
		}
	}
	// Stored under hub names where there is one. In game it's Minecraft names: Paul is
	// grandpaul there, from his server and from the hub alike.
	// And from the hub: a file, a forward-style link, several lines, a colour code.
	call("", "POST", "/api/channels/"+LinkChat+"/messages", `{"text":"**on** in ~~ten~~\nsee #[media/server-link/my base.png] and #media/server-link/farm.litematic §cin red"}`)

	msgs, _ := cs.Messages(LinkChat, "", 10)
	if len(msgs) != 3 || msgs[0].User != "Paul" || msgs[0].Via != "SMP" || msgs[1].User != "Eldridge" || msgs[1].Via != "CMP" || msgs[2].Via != "" {
		t.Errorf("stored: %+v", msgs)
	}

	// Each server gets the others' lines, never its own.
	if got, want := lines(read(survival, "?after=")), "[CMP] Eldridge: yep | [HUB] grandpaul: on in ten see [my base.png] and [farm.litematic] in red"; got != want {
		t.Errorf("survival reads:\n %s\nwant\n %s", got, want)
	}
	c := read(creative, "?after=")
	if got, want := lines(c), "[SMP] grandpaul: anyone on creative? | [HUB] grandpaul: on in ten see [my base.png] and [farm.litematic] in red"; got != want {
		t.Errorf("creative reads:\n %s\nwant\n %s", got, want)
	}
	if c.Last != msgs[2].ID {
		t.Errorf("last: %q, want %q", c.Last, msgs[2].ID)
	}
	if again := read(creative, "?after="+c.Last); len(again.Messages) != 0 {
		t.Errorf("nothing new, got %+v", again)
	}

	// Waiting: the answer comes when a message does, not before.
	got := make(chan feed, 1)
	go func() { got <- read(creative, "?after="+c.Last+"&wait=20") }()
	select {
	case f := <-got:
		t.Fatalf("answered with nothing new: %+v", f)
	case <-time.After(300 * time.Millisecond):
	}
	// Creative's own line doesn't end the wait; Survival's does.
	call(creative, "POST", "/api/server-link", `{"player":"Eldridge","text":"mine"}`)
	select {
	case f := <-got:
		t.Fatalf("answered with its own line: %+v", f)
	case <-time.After(300 * time.Millisecond):
	}
	call(survival, "POST", "/api/server-link", `{"player":"Steve","text":"hello"}`)
	select {
	case f := <-got:
		if lines(f) != "[SMP] Steve: hello" {
			t.Errorf("woken with: %s", lines(f))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the waiting poll wasn't woken")
	}
	// With nothing new, a wait ends by itself.
	t0 := time.Now()
	last := read(survival, "?after=").Last
	if f := read(survival, "?after="+last+"&wait=1"); len(f.Messages) != 0 || time.Since(t0) < 900*time.Millisecond {
		t.Errorf("a 1 s wait: %+v after %v", f, time.Since(t0))
	}

	// A hub member with no Minecraft name linked shows by their hub name.
	lennox, _ := us.Login("Lennox", "Lennox-password")
	cookie, last = lennox, read(survival, "?after=").Last
	call("", "POST", "/api/channels/"+LinkChat+"/messages", `{"text":"hi all"}`)
	if got := lines(read(survival, "?after="+last)); got != "[HUB] Lennox: hi all" {
		t.Errorf("unlinked hub member: %s", got)
	}
	last = read(survival, "?after=").Last

	// A long message is cut to one chat line.
	call("", "POST", "/api/channels/"+LinkChat+"/messages", `{"text":"`+strings.Repeat("ab ", 200)+`"}`)
	f := read(survival, "?after="+last)
	if n := len([]rune(f.Messages[0].Text)); n != linkLine || !strings.HasSuffix(f.Messages[0].Text, "…") {
		t.Errorf("long line: %d runes", n)
	}
}

// From the hub, one person can't flood the link chat (every line is printed in both games);
// a game server's own lines aren't counted.
func TestLinkChatRate(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Steve", "Steve-password")
	us.SetPassword("Alex", "Alex-password")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	// The chat exists once a game server has connected.
	survival, _, _ := us.NewToken("survival", "")
	r, _ := http.NewRequest("GET", srv.URL+"/api/server-link", nil)
	r.Header.Set("Authorization", "Bearer "+survival)
	if res, err := http.DefaultClient.Do(r); err != nil || res.StatusCode != 200 {
		t.Fatalf("server connects: %v", err)
	}
	defer func(l *limiter) { linkLines = l }(linkLines)
	linkLines = newLimiter(3, time.Minute)
	say := func(who, chat string) int {
		t.Helper()
		c, _ := us.Login(who, who+"-password")
		r, _ := http.NewRequest("POST", srv.URL+"/api/channels/"+chat+"/messages", strings.NewReader(`{"text":"hi"}`))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: c})
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	codes := []int{say("Steve", LinkChat), say("Steve", LinkChat), say("Steve", LinkChat), say("Steve", LinkChat)}
	if !slices.Equal(codes, []int{200, 200, 200, 429}) {
		t.Errorf("Steve's lines in the link chat: %v, want three sent and the fourth refused", codes)
	}
	if code := say("Alex", LinkChat); code != 200 {
		t.Errorf("Alex, who hasn't said anything: %d", code)
	}
	if code := say("Steve", "general"); code != 200 {
		t.Errorf("Steve in another chat: %d", code)
	}
}
