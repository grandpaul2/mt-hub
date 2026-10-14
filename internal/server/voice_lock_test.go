package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

// The lock (voice_lock.go): who may lock; GET /api/voice tells only the person asking; the
// token and LiveKit's attribute carry it to the bridge; Leave, another voice chat, the game
// server's report, an unlinked name, a ban and 30 seconds in neither place each take it off,
// and a page simply going away does not; it is kept across a restart.
func TestVoiceLock(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	for _, n := range []string{"Alex", "Steve", "Nomc"} {
		us.SetPassword(n, n+"-password")
	}
	us.SetMC("Alex", "AlexMC")
	us.SetMC("Steve", "SteveMC")
	var mu sync.Mutex
	updates := []string{} // "identity lock=value" for each UpdateParticipant
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Room, Identity string
			Attributes     map[string]string
		}
		json.NewDecoder(r.Body).Decode(&req)
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/UpdateParticipant":
			mu.Lock()
			updates = append(updates, req.Identity+" lock="+req.Attributes["lock"])
			mu.Unlock()
			w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer lk.Close()
	os.WriteFile(filepath.Join(dir, "voice.json"), []byte(`{"url":"wss://lk.example","api":"`+lk.URL+`","key":"k","secret":"s3cret","link_voice":true}`), 0o600)
	s := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	s.voiceCheckOnce() // (makes #voice-link; LiveKit's list is not found: nobody)

	call := func(a account, h http.HandlerFunc, id, body string) int {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.SetPathValue("id", id)
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, a))
		w := httptest.NewRecorder()
		h(w, r)
		return w.Code
	}
	lock := func(name string, on bool) int {
		return call(account{Name: name}, s.voiceLock, LinkVoiceID, map[bool]string{true: `{"on":true}`, false: `{"on":false}`}[on])
	}
	locked := func(name string) bool {
		s.voice.mu.Lock()
		defer s.voice.mu.Unlock()
		return s.voice.locked(name)
	}
	took := func() string {
		mu.Lock()
		defer mu.Unlock()
		out := strings.Join(updates, ",")
		updates = updates[:0]
		return out
	}
	listLock := func(name string) bool {
		r := httptest.NewRequest("GET", "/api/voice", nil)
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, account{Name: name}))
		w := httptest.NewRecorder()
		s.voiceList(w, r)
		var out struct{ Chats []voiceChat }
		json.NewDecoder(w.Body).Decode(&out)
		for _, c := range out.Chats {
			if c.Link {
				return c.Lock
			}
		}
		t.Fatal("no #voice-link in the list")
		return false
	}

	// Not in voice-link: refused. No Minecraft name: refused. Another voice chat: no lock.
	if c := lock("Alex", true); c != http.StatusConflict || locked("Alex") {
		t.Errorf("Alex locked while in neither place: %d", c)
	}
	s.voicePart(LinkVoiceID, "Nomc", true, time.Now())
	if c := lock("Nomc", true); c != http.StatusConflict || locked("Nomc") {
		t.Errorf("an account with no Minecraft name locked: %d", c)
	}
	if c := call(account{Name: "Alex"}, s.voiceLock, "v123", `{"on":true}`); c != http.StatusNotFound {
		t.Errorf("a lock on another voice chat: %d", c)
	}

	// In the hub's voice chat: locked, and LiveKit is told (so the bridge's roster says so).
	s.voicePart(LinkVoiceID, "Alex", true, time.Now())
	if c := lock("Alex", true); c != http.StatusNoContent || !locked("Alex") {
		t.Fatalf("Alex in #voice-link could not lock: %d", c)
	}
	if got := took(); got != "Alex lock=1" {
		t.Errorf("LiveKit told %q, want Alex lock=1", got)
	}
	// Only Alex is told Alex is locked; the saved voice chats don't carry it.
	s.voicePart(LinkVoiceID, "Steve", true, time.Now())
	if !listLock("Alex") || listLock("Steve") {
		t.Errorf("GET /api/voice: Alex sees lock %v (want true), Steve sees %v (want false)", listLock("Alex"), listLock("Steve"))
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "voice-chats.json")); strings.Contains(string(b), "lock") {
		t.Errorf("voice-chats.json carries a lock: %s", b)
	}
	// Alex's token carries the lock beside the Minecraft name.
	{
		w := httptest.NewRecorder()
		s.voiceToken(w, LinkVoiceID, "Alex")
		var out struct{ Token string }
		json.NewDecoder(w.Body).Decode(&out)
		body, _ := base64.RawURLEncoding.DecodeString(strings.Split(out.Token, ".")[1])
		var claims struct{ Attributes map[string]string }
		json.Unmarshal(body, &claims)
		if claims.Attributes["mc"] != "AlexMC" || claims.Attributes["lock"] != "1" {
			t.Errorf("Alex's token attributes: %v", claims.Attributes)
		}
	}
	// Kept across a restart.
	if s2 := (&Server{users: us, voice: loadVoice(dir), bus: newBroker()}); !s2.voice.locked("Alex") {
		t.Error("the lock was not kept across a restart")
	}

	// Steve's player in game (his Minecraft name in another case): he may lock from there;
	// he isn't in the hub's room, so LiveKit isn't told.
	s.voicePart(LinkVoiceID, "Steve", false, time.Time{})
	s.voicePart(LinkVoiceID, "link:survival:stevemc", true, time.Now())
	if c := lock("Steve", true); c != http.StatusNoContent || !locked("Steve") {
		t.Fatalf("Steve in game could not lock: %d", c)
	}
	if got := took(); got != "" {
		t.Errorf("LiveKit told %q for a player in game", got)
	}
	// The server's report: only with a game server's token; then his lock is off. An unknown
	// name is answered the same way.
	report := func(a account, player string) int {
		return call(a, s.voiceLinkLeft, "", `{"player":"`+player+`"}`)
	}
	if c := report(account{Name: "Alex"}, "SteveMC"); c != http.StatusForbidden || !locked("Steve") {
		t.Errorf("a member reported Steve's leave: %d, locked %v", c, locked("Steve"))
	}
	if c := report(account{Name: "release", Token: auth.KindRelease}, "SteveMC"); c != http.StatusForbidden || !locked("Steve") {
		t.Errorf("the release token reported Steve's leave: %d", c)
	}
	if c := report(account{Name: "Survival", Token: auth.KindServer}, "Nobody_here"); c != http.StatusNoContent {
		t.Errorf("an unknown name: %d", c)
	}
	if c := report(account{Name: "Survival", Token: auth.KindServer}, "STEVEMC"); c != http.StatusNoContent || locked("Steve") {
		t.Errorf("the server's report: %d, Steve still locked %v", c, locked("Steve"))
	}
	if !tokenAllowed(httptest.NewRequest("POST", "/api/voice-link/left", nil), auth.KindServer) || tokenAllowed(httptest.NewRequest("POST", "/api/voice-link/left", nil), auth.KindRelease) {
		t.Error("tokens.go: the report is for game servers' tokens only")
	}

	// Unlocking is always allowed.
	if c := lock("Nomc", false); c != http.StatusNoContent {
		t.Errorf("unlocking with no lock: %d", c)
	}

	// Leave in the hub takes it off (LiveKit told); so does joining another voice chat.
	call(account{Name: "Alex"}, s.voiceLeave, LinkVoiceID, "")
	if locked("Alex") {
		t.Error("Leave did not take Alex's lock off")
	}
	if got := took(); got != "Alex lock=" {
		t.Errorf("after Leave, LiveKit told %q, want Alex lock= (cleared)", got)
	}
	s.voicePart(LinkVoiceID, "Alex", true, time.Now())
	lock("Alex", true)
	took()
	s.voice.mu.Lock()
	s.voice.chats["v1"] = &voiceChat{ID: "v1", Starter: "Steve", People: []voicePerson{{Name: "Steve"}}, Started: time.Now()}
	s.voice.mu.Unlock()
	call(account{Name: "Alex"}, s.voiceJoin, "v1", "")
	if locked("Alex") {
		t.Error("joining another voice chat did not take Alex's lock off")
	}

	// A page going away (LiveKit says Alex left; no Leave) does not: 30 s in neither place does.
	s.voicePart(LinkVoiceID, "Alex", true, time.Now())
	lock("Alex", true)
	s.voicePart(LinkVoiceID, "Alex", false, time.Time{})
	t0 := time.Now()
	s.voiceLockSweep(t0)
	s.voiceLockSweep(t0.Add(29 * time.Second))
	if !locked("Alex") {
		t.Fatal("the lock went before 30 s in neither place")
	}
	// Back in a place (his player in game) stops the count; gone again, it starts again.
	s.voicePart(LinkVoiceID, "link:creative:AlexMC", true, time.Now())
	s.voiceLockSweep(t0.Add(40 * time.Second))
	if !locked("Alex") {
		t.Fatal("the lock went while Alex's player was in game")
	}
	s.voicePart(LinkVoiceID, "link:creative:AlexMC", false, time.Time{})
	s.voiceLockSweep(t0.Add(45 * time.Second))
	s.voiceLockSweep(t0.Add(74 * time.Second))
	if !locked("Alex") {
		t.Fatal("the count did not start again from when Alex was next nowhere")
	}
	s.voiceLockSweep(t0.Add(75 * time.Second))
	if locked("Alex") {
		t.Error("30 s in neither place did not take the lock off")
	}

	// An unlinked Minecraft name, and a ban, take it off at the next sweep.
	s.voicePart(LinkVoiceID, "Alex", true, time.Now())
	lock("Alex", true)
	s.voicePart(LinkVoiceID, "link:survival:SteveMC", true, time.Now())
	lock("Steve", true)
	us.SetMC("Alex", "")
	us.Change("Steve", func(u *auth.User) { u.Banned = true })
	s.voiceLockSweep(time.Now())
	if locked("Alex") || locked("Steve") {
		t.Errorf("after unlinking Alex's name and banning Steve: Alex %v, Steve %v", locked("Alex"), locked("Steve"))
	}
}
