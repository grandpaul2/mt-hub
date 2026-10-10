package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// Voice chats: at most 3; a private one is seen and joined only by the people invited (not
// even an admin); only its starter invites; LiveKit's webhooks (signed) set who's in, in
// join order, and an emptied voice chat ends; it all survives a restart.
func TestVoice(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	for _, n := range []string{"Paul", "Steve", "Alex", "Eve"} {
		us.SetPassword(n, n+"-password")
	}
	us.Change("Paul", func(u *auth.User) { u.Admin = true })
	start := func() (*httptest.Server, map[string]string) {
		srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
		cookie := map[string]string{}
		for _, n := range []string{"Paul", "Steve", "Alex", "Eve"} {
			cookie[n], _ = us.Login(n, n+"-password")
		}
		return srv, cookie
	}
	srv, cookie := start()
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
	want := func(label string, got, code int) {
		t.Helper()
		if got != code {
			t.Errorf("%s: %d, want %d", label, got, code)
		}
	}
	type listed struct {
		Enabled bool `json:"enabled"`
		Chats   []struct {
			ID     string `json:"id"`
			People []struct {
				Name string `json:"name"`
			} `json:"people"`
		} `json:"chats"`
	}
	list := func(who string) listed {
		_, b := call(who, "GET", "/api/voice", "")
		var l listed
		json.Unmarshal([]byte(b), &l)
		return l
	}
	ids := func(who string) (out []string) {
		for _, c := range list(who).Chats {
			out = append(out, c.ID)
		}
		return
	}
	startChat := func(who, body string) (int, string) {
		code, b := call(who, "POST", "/api/voice", body)
		var r struct{ ID, Token string }
		json.Unmarshal([]byte(b), &r)
		if code == 200 && r.Token == "" {
			t.Errorf("%s started a voice chat but got no token", who)
		}
		return code, r.ID
	}
	// A webhook as LiveKit signs it; tampered says whether to break the signature.
	hook := func(event, room, identity string, at int64, tampered bool) int {
		t.Helper()
		body := `{"event":"` + event + `","room":{"name":"` + room + `"},"participant":{"identity":"` + identity + `","joinedAt":"` + strings.TrimSpace(func() string { b, _ := json.Marshal(at); return string(b) }()) + `"}}`
		sum := sha256.Sum256([]byte(body))
		tok := (&voiceConf{Key: "k", Secret: "s3cret"}).sign(map[string]any{"iss": "k", "exp": time.Now().Add(time.Minute).Unix(), "sha256": base64.StdEncoding.EncodeToString(sum[:])})
		if tampered {
			tok = tok[:len(tok)-2] + "xx"
		}
		r, _ := http.NewRequest("POST", srv.URL+"/api/voice/webhook", strings.NewReader(body))
		r.Header.Set("Authorization", tok)
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}

	// Without voice.json, voice chats are off; writing it turns them on, no restart.
	if list("Eve").Enabled {
		t.Fatal("voice chats on without voice.json")
	}
	// api points nowhere: the 20-second check against LiveKit isn't part of this test.
	os.WriteFile(filepath.Join(dir, "voice.json"), []byte(`{"url":"wss://lk.example","api":"http://127.0.0.1:1","key":"k","secret":"s3cret"}`), 0o600)
	if !list("Eve").Enabled {
		t.Fatal("voice.json written but voice chats still off")
	}
	code, pub := startChat("Alex", `{}`)
	want("Alex starts a voice chat", code, 200)
	code, priv := startChat("Steve", `{"private":true,"invite":["Alex"]}`)
	want("Steve starts a private one with Alex", code, 200)
	if got := ids("Eve"); len(got) != 1 || got[0] != pub {
		t.Errorf("Eve sees %v, want only the public one", got)
	}
	if got := ids("Paul"); len(got) != 1 {
		t.Errorf("Paul (an admin) sees %v: a private voice chat must be hidden from him", got)
	}
	if got := ids("Alex"); len(got) != 2 {
		t.Errorf("Alex (invited) sees %v, want both", got)
	}
	c, _ := call("Paul", "POST", "/api/voice/"+priv+"/join", "")
	want("Paul (admin, not invited) can't join the private one", c, 404)
	c, _ = call("Alex", "POST", "/api/voice/"+priv+"/join", "")
	want("Alex (invited) can join it", c, 200)
	c, _ = call("Alex", "POST", "/api/voice/"+priv+"/invite", `{"invite":["Eve"]}`)
	want("only the starter invites", c, 403)
	c, _ = call("Steve", "POST", "/api/voice/"+priv+"/invite", `{"invite":["Eve"]}`)
	want("Steve invites Eve", c, 204)
	if got := ids("Eve"); len(got) != 2 {
		t.Errorf("Eve, once invited, sees %v", got)
	}
	code, third := startChat("Paul", `{}`)
	want("a third voice chat", code, 200)
	code, _ = startChat("Eve", `{}`)
	want("a fourth is refused", code, 409)

	// LiveKit's webhooks: unsigned ones are refused; people are listed in join order.
	want("unsigned webhook", hook("participant_joined", pub, "Eve", 100, true), 401)
	want("Alex joins", hook("participant_joined", pub, "Alex", 100, false), 204)
	want("Eve joins", hook("participant_joined", pub, "Eve", 200, false), 204)
	people := func(who, id string) (out []string) {
		for _, c := range list(who).Chats {
			if c.ID == id {
				for _, p := range c.People {
					out = append(out, p.Name)
				}
			}
		}
		return
	}
	if got := people("Paul", pub); strings.Join(got, ",") != "Alex,Eve" {
		t.Errorf("people %v, want Alex,Eve", got)
	}
	// Eve joining another voice chat takes her out of this one.
	hook("participant_joined", third, "Eve", 300, false)
	if got := people("Paul", pub); strings.Join(got, ",") != "Alex" {
		t.Errorf("after Eve moved: %v, want Alex", got)
	}
	// It survives a restart.
	srv.Close()
	srv, cookie = start()
	defer srv.Close()
	if got := people("Paul", pub); strings.Join(got, ",") != "Alex" {
		t.Errorf("after a restart: %v, want Alex", got)
	}
	if got := ids("Paul"); len(got) != 2 {
		t.Errorf("after a restart Paul sees %v, want the two public ones", got)
	}
	// The last one out ends it, and a new one may start.
	c, _ = call("Alex", "POST", "/api/voice/"+pub+"/leave", "")
	want("Alex leaves", c, 204)
	if got := ids("Paul"); len(got) != 1 {
		t.Errorf("after the last left, Paul sees %v, want just the third", got)
	}
	code, _ = startChat("Eve", `{}`)
	want("a new one fits again", code, 200)
}

// Every 20 seconds the hub asks LiveKit who's connected; anyone banned or deleted since
// joining is removed from the call, whoever else stays.
func TestVoiceBannedRemoved(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	for _, n := range []string{"Alex", "Steve"} {
		us.SetPassword(n, n+"-password")
	}
	removed := []string{}
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Room, Identity string }
		json.NewDecoder(r.Body).Decode(&req)
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/ListParticipants":
			w.Write([]byte(`{"participants":[{"identity":"Alex","joinedAt":"100"},{"identity":"Steve","joinedAt":"200"},{"identity":"Gone","joinedAt":"300"}]}`))
		case "/twirp/livekit.RoomService/RemoveParticipant":
			removed = append(removed, req.Identity)
			w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer lk.Close()
	os.WriteFile(filepath.Join(dir, "voice.json"), []byte(`{"url":"wss://lk.example","api":"`+lk.URL+`","key":"k","secret":"s3cret"}`), 0o600)
	s := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	s.voice.chats["room1"] = &voiceChat{ID: "room1", Starter: "Alex", Started: time.Now()}
	us.Change("Steve", func(u *auth.User) { u.Banned = true })

	s.voiceCheckOnce()
	if strings.Join(removed, ",") != "Steve,Gone" {
		t.Fatalf("removed %v, want Steve,Gone", removed)
	}
	if p := s.voice.chats["room1"].People; len(p) != 1 || p[0].Name != "Alex" {
		t.Fatalf("left in the voice chat: %v", p)
	}
}

// A signed webhook sent again (copied off the wire) is ignored.
func TestWebhookReplay(t *testing.T) {
	v := &voice{}
	if v.replayed("ev1") || !v.replayed("ev1") || v.replayed("ev2") || v.replayed("") || v.replayed("") {
		t.Fatal("replay guard wrong")
	}
}
