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

// Screen sharing: a stream is listed once its picture arrives; one per person (starting
// again replaces it); at most 3; the streamer may publish only a screen, viewers only watch;
// LiveKit's webhooks for a stream never touch voice chats; the streamer leaving ends it; an
// admin may stop someone below them; it all survives a restart.
func TestStreams(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	names := []string{"Pat", "Steve", "Alex", "Eve", "Ann"}
	for _, n := range names {
		us.SetPassword(n, n+"-password")
	}
	us.Change("Pat", func(u *auth.User) { u.Admin = true })
	us.Change("Ann", func(u *auth.User) { u.Admin = true })
	start := func() (*httptest.Server, map[string]string) {
		srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
		cookie := map[string]string{}
		for _, n := range names {
			cookie[n], _ = us.Login(n, n+"-password")
		}
		return srv, cookie
	}
	srv, cookie := start()
	call := func(who, method, path, body string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie[who]})
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
		Full    bool `json:"full"`
		Streams []struct {
			ID      string   `json:"id"`
			Name    string   `json:"name"`
			Viewers []string `json:"viewers"`
		} `json:"streams"`
	}
	list := func(who string) listed {
		_, b := call(who, "GET", "/api/streams", "")
		var l listed
		json.Unmarshal([]byte(b), &l)
		return l
	}
	live := func() (out []string) {
		for _, x := range list("Eve").Streams {
			out = append(out, x.Name+":"+strings.Join(x.Viewers, "+"))
		}
		return
	}
	// claims reads a token's grants (signature not checked: the hub made it).
	claims := func(tok string) (c struct {
		Sub   string         `json:"sub"`
		Name  string         `json:"name"`
		Video map[string]any `json:"video"`
	}) {
		raw, _ := base64.RawURLEncoding.DecodeString(strings.Split(tok, ".")[1])
		json.Unmarshal(raw, &c)
		return
	}
	startStream := func(who string) (int, string, string) {
		t.Helper()
		code, b := call(who, "POST", "/api/streams", "")
		var r struct{ ID, Token string }
		json.Unmarshal([]byte(b), &r)
		return code, r.ID, r.Token
	}
	hook := func(event, room, identity, source string) {
		t.Helper()
		body := `{"event":"` + event + `","room":{"name":"` + room + `"},"participant":{"identity":"` + identity + `","joinedAt":"100"}`
		if source != "" {
			body += `,"track":{"source":"` + source + `"}`
		}
		body += "}"
		sum := sha256.Sum256([]byte(body))
		tok := (&voiceConf{Key: "k", Secret: "s3cret"}).sign(map[string]any{"iss": "k", "exp": time.Now().Add(time.Minute).Unix(), "sha256": base64.StdEncoding.EncodeToString(sum[:])})
		r, _ := http.NewRequest("POST", srv.URL+"/api/voice/webhook", strings.NewReader(body))
		r.Header.Set("Authorization", tok)
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 204 {
			t.Errorf("webhook %s: %d", event, res.StatusCode)
		}
	}

	if list("Eve").Enabled {
		t.Fatal("screen sharing on without voice.json")
	}
	c, _, _ := startStream("Alex")
	want("no LiveKit, no sharing", c, 503)
	os.WriteFile(filepath.Join(dir, "voice.json"), []byte(`{"url":"wss://lk.example","api":"http://127.0.0.1:1","key":"k","secret":"s3cret"}`), 0o600)

	// Alex starts: a screen-only token, but nothing listed until the picture comes.
	c, alex, tok := startStream("Alex")
	want("Alex shares", c, 200)
	g := claims(tok)
	if g.Sub != "Alex" || g.Video["room"] != alex || g.Video["canPublish"] != true || g.Video["canSubscribe"] != false ||
		strings.Join(func() (o []string) {
			for _, v := range g.Video["canPublishSources"].([]any) {
				o = append(o, v.(string))
			}
			return
		}(), ",") != "screen_share" {
		t.Errorf("streamer token: %+v", g)
	}
	if got := live(); len(got) != 0 {
		t.Errorf("listed before the picture: %v", got)
	}
	hook("track_published", alex, "Alex", "MICROPHONE")
	if got := live(); len(got) != 0 {
		t.Errorf("listed for a non-screen track: %v", got)
	}
	hook("track_published", alex, "Alex", "SCREEN_SHARE")
	if got := live(); strings.Join(got, ",") != "Alex:" {
		t.Errorf("after the picture: %v, want Alex", got)
	}

	// Eve is in a voice chat; watching Alex doesn't take her out of it (one webhook address).
	_, b := call("Eve", "POST", "/api/voice", `{}`)
	var vc struct{ ID string }
	json.Unmarshal([]byte(b), &vc)
	hook("participant_joined", vc.ID, "Eve", "")
	hook("participant_joined", vc.ID, "Alex", "")
	hook("participant_joined", alex, "Alex", "") // Alex, sharing, joins his stream's room under his own name
	c, b = call("Eve", "POST", "/api/streams/"+alex+"/watch", "")
	want("Eve watches", c, 200)
	var wr struct{ Token string }
	json.Unmarshal([]byte(b), &wr)
	g = claims(wr.Token)
	if !strings.HasPrefix(g.Sub, "Eve~") || g.Name != "Eve" || g.Video["canPublish"] != false || g.Video["canSubscribe"] != true {
		t.Errorf("viewer token: %+v", g)
	}
	hook("participant_joined", alex, g.Sub, "")
	if got := live(); strings.Join(got, ",") != "Alex:Eve" {
		t.Errorf("viewers: %v, want Alex:Eve", got)
	}
	_, vb := call("Eve", "GET", "/api/voice", "")
	if !strings.Contains(vb, `"name":"Eve"`) || !strings.Contains(vb, `"name":"Alex"`) {
		t.Errorf("sharing or watching a stream took someone out of their voice chat: %s", vb)
	}
	hook("participant_left", alex, g.Sub, "")
	if got := live(); strings.Join(got, ",") != "Alex:" {
		t.Errorf("after Eve left: %v", got)
	}
	c, _ = call("Eve", "POST", "/api/streams/nope/watch", "")
	want("watching a stream that isn't there", c, 404)

	// Starting again replaces your stream; three people at most.
	c, alex2, _ := startStream("Alex")
	want("Alex shares again", c, 200)
	if got := live(); len(got) != 0 {
		t.Errorf("the old stream should be gone: %v", got)
	}
	hook("track_published", alex2, "Alex", "SCREEN_SHARE")
	hook("track_published", alex, "Alex", "SCREEN_SHARE") // the old room: ignored
	_, steve, _ := startStream("Steve")
	_, eve, _ := startStream("Eve")
	hook("track_published", steve, "Steve", "SCREEN_SHARE")
	hook("track_published", eve, "Eve", "SCREEN_SHARE")
	if got := live(); strings.Join(got, ",") != "Alex:,Steve:,Eve:" {
		t.Errorf("three streams: %v", got)
	}
	if !list("Pat").Full || list("Alex").Full {
		t.Errorf("full: Pat %v (want true), Alex %v (want false: his own doesn't count)", list("Pat").Full, list("Alex").Full)
	}
	c, _, _ = startStream("Pat")
	want("a fourth is refused", c, 409)

	// Stopping: a member can't stop someone else's; an admin can, below them, logged.
	c, _ = call("Eve", "POST", "/api/streams/"+steve+"/stop", "")
	want("Eve can't stop Steve's", c, 403)
	c, _ = call("Pat", "POST", "/api/streams/"+steve+"/stop", "")
	want("Pat (admin) stops Steve's", c, 204)
	c, _ = call("Ann", "POST", "/api/streams/"+eve+"/stop", "")
	want("Ann (admin) stops Eve's", c, 204)
	if log, _ := us.ReadLog(10); len(log) == 0 || log[0].Action != "stream-stop" || log[0].User != "Eve" {
		t.Errorf("admin log: %+v", log)
	}
	if got := live(); strings.Join(got, ",") != "Alex:" {
		t.Errorf("after stops: %v", got)
	}
	c, _ = call("Alex", "POST", "/api/streams/"+steve+"/stop", "")
	want("stopping one that's over", c, 204)

	// It survives a restart.
	srv.Close()
	srv, cookie = start()
	defer srv.Close()
	if got := live(); strings.Join(got, ",") != "Alex:" {
		t.Errorf("after a restart: %v", got)
	}
	// The streamer closing the share, or leaving, ends it.
	hook("track_unpublished", alex2, "Alex", "SCREEN_SHARE")
	if got := live(); len(got) != 0 {
		t.Errorf("after the share closed: %v", got)
	}
	_, p1, _ := startStream("Pat")
	hook("track_published", p1, "Pat", "SCREEN_SHARE")
	hook("participant_left", p1, "Pat", "")
	if got := live(); len(got) != 0 {
		t.Errorf("after Pat left: %v", got)
	}
	c, _ = call("Pat", "POST", "/api/streams/"+alex2+"/stop", "")
	want("Pat stops his own, own", c, 204)
}

// Every 20 seconds the hub asks LiveKit: a stream whose picture never came ends after a
// minute, one whose streamer is gone ends, a banned streamer's ends, banned viewers are
// removed, and the viewer list catches up.
func TestStreamCheck(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	for _, n := range []string{"Alex", "Steve", "Eve", "Bob"} {
		us.SetPassword(n, n+"-password")
	}
	removed, deleted := []string{}, []string{}
	rooms := map[string]string{
		"sLive":   `{"participants":[{"identity":"Alex","tracks":[{"source":"SCREEN_SHARE"}]},{"identity":"Eve~a1","tracks":[]},{"identity":"Eve~b2"},{"identity":"Bob~c3"}]}`,
		"sYoung":  `{"participants":[{"identity":"Steve"}]}`,
		"sOld":    `{"participants":[{"identity":"Steve"}]}`,
		"sGone":   `{"participants":[{"identity":"Eve~x"}]}`,
		"sBanned": `{"participants":[{"identity":"Bob","tracks":[{"source":3}]}]}`,
	}
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Room, Identity string }
		json.NewDecoder(r.Body).Decode(&req)
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/ListParticipants":
			w.Write([]byte(rooms[req.Room]))
		case "/twirp/livekit.RoomService/RemoveParticipant":
			removed = append(removed, req.Identity)
			w.Write([]byte(`{}`))
		case "/twirp/livekit.RoomService/DeleteRoom":
			deleted = append(deleted, req.Room)
			w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer lk.Close()
	os.WriteFile(filepath.Join(dir, "voice.json"), []byte(`{"url":"wss://lk.example","api":"`+lk.URL+`","key":"k","secret":"s3cret"}`), 0o600)
	s := &Server{users: us, voice: loadVoice(dir), streams: loadStreams(dir), bus: newBroker()}
	old := time.Now().Add(-2 * time.Minute)
	s.streams.all = map[string]*stream{
		"sLive":   {ID: "sLive", Name: "Alex", Started: old, Viewers: []string{"Bob"}},
		"sYoung":  {ID: "sYoung", Name: "Steve", Started: time.Now()},
		"sOld":    {ID: "sOld", Name: "Steve", Started: old},
		"sGone":   {ID: "sGone", Name: "Eve", Started: old, Live: true},
		"sBanned": {ID: "sBanned", Name: "Bob", Started: old, Live: true},
	}
	us.Change("Bob", func(u *auth.User) { u.Banned = true })

	s.streamCheckOnce()
	time.Sleep(200 * time.Millisecond) // rooms are closed in the background
	var left []string
	for id := range s.streams.all {
		left = append(left, id)
	}
	slices.Sort(left)
	if strings.Join(left, ",") != "sLive,sYoung" {
		t.Errorf("streams left %v, want sLive,sYoung", left)
	}
	if x := s.streams.all["sLive"]; x == nil || !x.Live || strings.Join(x.Viewers, ",") != "Eve" {
		t.Errorf("sLive: %+v, want live with viewer Eve (twice is once; Bob banned)", x)
	}
	if strings.Join(removed, ",") != "Bob~c3" {
		t.Errorf("removed %v, want Bob~c3", removed)
	}
	slices.Sort(deleted)
	if strings.Join(deleted, ",") != "sBanned,sGone,sOld" {
		t.Errorf("closed rooms %v", deleted)
	}
}

func TestViewerName(t *testing.T) {
	if viewerName("Eve~a1") != "Eve" || viewerName("Eve") != "" || !isStreamRoom("s12") || isStreamRoom("v12") || isStreamRoom("room1") {
		t.Fatal("names wrong")
	}
	if !isScreen(json.RawMessage(`"SCREEN_SHARE"`)) || !isScreen(json.RawMessage(`3`)) || isScreen(json.RawMessage(`"CAMERA"`)) || isScreen(nil) {
		t.Fatal("isScreen wrong")
	}
}
