package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

// The lock (voice_lock.go): who may lock; GET /api/voice tells only the person asking; no
// token and no LiveKit attribute carry it (the game servers ask the hub); Leave, another voice chat, the game
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
	updates := []string{} // "identity key=value,..." for each UpdateParticipant
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Room, Identity string
			Attributes     map[string]string
		}
		json.NewDecoder(r.Body).Decode(&req)
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/UpdateParticipant":
			mu.Lock()
			kv := []string{}
			for k, v := range req.Attributes {
				kv = append(kv, k+"="+v)
			}
			slices.Sort(kv)
			updates = append(updates, req.Identity+" "+strings.Join(kv, ","))
			mu.Unlock()
			w.Write([]byte(`{}`))
		case "/twirp/livekit.RoomService/ListParticipants":
			w.Write([]byte(`{"participants":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer lk.Close()
	os.WriteFile(filepath.Join(dir, "voice.json"), []byte(`{"url":"wss://lk.example","api":"`+lk.URL+`","key":"k","secret":"s3cret","link_voice":true}`), 0o600)
	s := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	s.voiceCheckOnce() // (makes #voice-link; LiveKit's list is empty: nobody)

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
	s.voicePart(LinkVoiceID, "Nomc", true, time.Now(), "")
	if c := lock("Nomc", true); c != http.StatusConflict || locked("Nomc") {
		t.Errorf("an account with no Minecraft name locked: %d", c)
	}
	if c := call(account{Name: "Alex"}, s.voiceLock, "v123", `{"on":true}`); c != http.StatusNotFound {
		t.Errorf("a lock on another voice chat: %d", c)
	}

	// In the hub's voice chat: locked; LiveKit is not told (nobody in the room learns it).
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "")
	if c := lock("Alex", true); c != http.StatusNoContent || !locked("Alex") {
		t.Fatalf("Alex in #voice-link could not lock: %d", c)
	}
	if got := took(); got != "" {
		t.Errorf("LiveKit told %q about a lock", got)
	}
	// Only Alex is told Alex is locked; the saved voice chats don't carry it.
	s.voicePart(LinkVoiceID, "Steve", true, time.Now(), "")
	if !listLock("Alex") || listLock("Steve") {
		t.Errorf("GET /api/voice: Alex sees lock %v (want true), Steve sees %v (want false)", listLock("Alex"), listLock("Steve"))
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "voice-chats.json")); strings.Contains(string(b), "lock") {
		t.Errorf("voice-chats.json carries a lock: %s", b)
	}
	// Alex's token carries his Minecraft name and not his lock.
	{
		w := httptest.NewRecorder()
		s.voiceToken(w, LinkVoiceID, "Alex")
		var out struct{ Token string }
		json.NewDecoder(w.Body).Decode(&out)
		body, _ := base64.RawURLEncoding.DecodeString(strings.Split(out.Token, ".")[1])
		var claims struct{ Attributes map[string]string }
		json.Unmarshal(body, &claims)
		if _, lock := claims.Attributes["lock"]; claims.Attributes["mc"] != "AlexMC" || lock {
			t.Errorf("Alex's token attributes: %v", claims.Attributes)
		}
	}
	// Kept across a restart.
	if s2 := (&Server{users: us, voice: loadVoice(dir), bus: newBroker()}); !s2.voice.locked("Alex") {
		t.Error("the lock was not kept across a restart")
	}

	// On the hub, hub names: Steve's player (linked, in another case) is listed as Steve with
	// the game name beside it; a player linked to nobody keeps the Minecraft name.
	s.voicePart(LinkVoiceID, "link:creative:Nobody_linked", true, time.Now(), "")
	{
		s.voicePart(LinkVoiceID, "link:survival:stevemc", true, time.Now(), "")
		r := httptest.NewRequest("GET", "/api/voice", nil)
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, account{Name: "Alex"}))
		w := httptest.NewRecorder()
		s.voiceList(w, r)
		var out struct{ Chats []voiceChat }
		json.NewDecoder(w.Body).Decode(&out)
		var got []string
		for _, c := range out.Chats {
			for _, p := range c.People {
				if p.Via != "" {
					got = append(got, p.Show+"/"+p.Game)
				}
			}
		}
		if strings.Join(got, ",") != "Nobody_linked/,Steve/stevemc" {
			t.Errorf("players in #voice-link's list: %v", got)
		}
		s.voicePart(LinkVoiceID, "link:survival:stevemc", false, time.Time{}, "")
		s.voice.mu.Lock()
		show := s.voice.chats[LinkVoiceID].People[len(s.voice.chats[LinkVoiceID].People)-1].Show
		s.voice.mu.Unlock()
		if show != "Nobody_linked" {
			t.Errorf("the hub's own list was changed: %q", show)
		}
	}
	s.voicePart(LinkVoiceID, "link:creative:Nobody_linked", false, time.Time{}, "")

	// Steve's player in game (his Minecraft name in another case): he may lock from there;
	// he isn't in the hub's room, so LiveKit isn't told.
	s.voicePart(LinkVoiceID, "Steve", false, time.Time{}, "")
	s.voicePart(LinkVoiceID, "link:survival:stevemc", true, time.Now(), "")
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

	// Leave in the hub takes it off (LiveKit not told); so does joining another voice chat.
	call(account{Name: "Alex"}, s.voiceLeave, LinkVoiceID, "")
	if locked("Alex") {
		t.Error("Leave did not take Alex's lock off")
	}
	if got := took(); got != "" {
		t.Errorf("after Leave, LiveKit told %q", got)
	}
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "")
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
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "")
	lock("Alex", true)
	s.voicePart(LinkVoiceID, "Alex", false, time.Time{}, "")
	t0 := time.Now()
	s.voiceLockSweep(t0)
	s.voiceLockSweep(t0.Add(29 * time.Second))
	if !locked("Alex") {
		t.Fatal("the lock went before 30 s in neither place")
	}
	// Back in a place (his player in game) stops the count; gone again, it starts again.
	s.voicePart(LinkVoiceID, "link:creative:AlexMC", true, time.Now(), "")
	s.voiceLockSweep(t0.Add(40 * time.Second))
	if !locked("Alex") {
		t.Fatal("the lock went while Alex's player was in game")
	}
	s.voicePart(LinkVoiceID, "link:creative:AlexMC", false, time.Time{}, "")
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
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "")
	lock("Alex", true)
	s.voicePart(LinkVoiceID, "link:survival:SteveMC", true, time.Now(), "")
	lock("Steve", true)
	us.SetMC("Alex", "")
	us.Change("Steve", func(u *auth.User) { u.Banned = true })
	s.voiceLockSweep(time.Now())
	if locked("Alex") || locked("Steve") {
		t.Errorf("after unlinking Alex's name and banning Steve: Alex %v, Steve %v", locked("Alex"), locked("Steve"))
	}
}

// The 2026-10-14 fixes (macrotech-ops tech-notes/voice-link-fixes-plan.md): the route game
// servers ask (H1), a replaced session (H2), a slow or failing check (H3), an admin's
// Disconnect (H4), look-alike names (H5), a changed Minecraft name and the old lock file (H6).
func TestVoiceLockFixes(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	for _, n := range []string{"Alex", "Steve", "Banned", "Admin"} {
		us.SetPassword(n, n+"-password")
	}
	us.SetMC("Alex", "AlexMC")
	us.SetMC("Steve", "SteveMC")
	us.SetMC("Banned", "BannedMC")
	us.Change("Admin", func(u *auth.User) { u.Admin = true })
	var mu sync.Mutex
	failing := false
	updates := []string{}
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Room, Identity string
			Attributes     map[string]string
		}
		json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/ListParticipants":
			if failing {
				http.NotFound(w, r) // (a wrong address: LiveKit itself answers an empty list)
				return
			}
			w.Write([]byte(`{"participants":[]}`))
		case "/twirp/livekit.RoomService/UpdateParticipant":
			keys := []string{}
			for k, v := range req.Attributes {
				keys = append(keys, k+"="+v)
			}
			slices.Sort(keys)
			updates = append(updates, req.Identity+" "+strings.Join(keys, ","))
			w.Write([]byte(`{}`))
		case "/twirp/livekit.RoomService/RemoveParticipant":
			w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer lk.Close()
	os.WriteFile(filepath.Join(dir, "voice.json"), []byte(`{"url":"wss://lk.example","api":"`+lk.URL+`","key":"k","secret":"s3cret","link_voice":true}`), 0o600)
	s := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	s.voiceCheckOnce()
	call := func(a account, h http.HandlerFunc, id, body string) (int, string) {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.SetPathValue("id", id)
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, a))
		w := httptest.NewRecorder()
		h(w, r)
		return w.Code, strings.TrimSpace(w.Body.String())
	}
	locked := func(name string) bool {
		s.voice.mu.Lock()
		defer s.voice.mu.Unlock()
		return s.voice.locked(name)
	}
	lock := func(name string) {
		if c, b := call(account{Name: name}, s.voiceLock, LinkVoiceID, `{"on":true}`); c != http.StatusNoContent {
			t.Fatalf("%s could not lock: %d %s", name, c, b)
		}
	}
	server := account{Name: "Survival", Token: auth.KindServer}
	ask := func(a account, players string) (int, string) {
		return call(a, s.voiceLinkLocked, "", `{"players":`+players+`}`)
	}
	took := func() string {
		mu.Lock()
		defer mu.Unlock()
		out := strings.Join(updates, ";")
		updates = updates[:0]
		return out
	}

	// H1. Alex locked in the hub, Steve in game; Banned locked, then banned. The answer: the
	// names as asked, only those asked, only while in a place.
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "PA_1")
	lock("Alex")
	s.voicePart(LinkVoiceID, "link:survival:SteveMC", true, time.Now(), "")
	lock("Steve")
	s.voicePart(LinkVoiceID, "link:creative:BannedMC", true, time.Now(), "")
	lock("Banned")
	us.Change("Banned", func(u *auth.User) { u.Banned = true })
	if c, b := ask(server, `["alexmc","SteveMC","BannedMC","Nobody"]`); c != 200 || b != `{"locked":["SteveMC","alexmc"]}` {
		t.Errorf("the route: %d %s", c, b)
	}
	// Named, Alex was cut from the hub first (handover spec): off the list, going into the game.
	if hub, game := s.whereIs("Alex"); hub || !game {
		t.Errorf("Alex after the answer: in the hub %v (want false), going into the game %v (want true)", hub, game)
	}
	if _, b := ask(server, `["SteveMC"]`); b != `{"locked":["SteveMC"]}` {
		t.Errorf("asked only for Steve: %s", b)
	}
	s.voicePart(LinkVoiceID, "link:survival:SteveMC", false, time.Time{}, "")
	if _, b := ask(server, `["SteveMC"]`); b != `{"locked":[]}` || !locked("Steve") {
		t.Errorf("Steve in neither place (still locked %v): %s", locked("Steve"), b)
	}
	for _, a := range []account{{Name: "Alex"}, {Name: "release", Token: auth.KindRelease}} {
		if c, _ := ask(a, `["AlexMC"]`); c != http.StatusForbidden {
			t.Errorf("%s asked: %d", a.Name, c)
		}
	}
	if c, _ := ask(server, `["not a name"]`); c != http.StatusBadRequest {
		t.Errorf("a bad name: %d", c)
	}
	many := make([]string, 101)
	for i := range many {
		many[i] = `"P` + strconv.Itoa(i) + `"`
	}
	if c, _ := ask(server, "["+strings.Join(many, ",")+"]"); c != http.StatusBadRequest {
		t.Errorf("101 names: %d", c)
	}
	if !tokenAllowed(httptest.NewRequest("POST", "/api/voice-link/locked", nil), auth.KindServer) {
		t.Error("tokens.go: game servers may not ask")
	}

	// H2. Alex opens a second tab: LiveKit replaces the session; the first one's leave comes
	// after, and Alex stays listed. A leave for the session listed takes him off. (The hand-over
	// from H1 is long over.)
	s.voice.mu.Lock()
	clear(s.voice.cut)
	s.voice.mu.Unlock()
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "PA_2")
	s.voicePart(LinkVoiceID, "Alex", false, time.Time{}, "PA_1")
	if hub, _ := s.whereIs("Alex"); !hub {
		t.Fatal("the old session's leave took Alex off the list")
	}
	s.voicePart(LinkVoiceID, "Alex", false, time.Time{}, "PA_2")
	if hub, _ := s.whereIs("Alex"); hub {
		t.Fatal("the current session's leave left Alex listed")
	}
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "PA_3")

	// H3. A hub restarted with Steve's lock and nobody listed; LiveKit can't be asked for 40 s:
	// nobody is unlocked. Once it answers, the 30 s count starts.
	s2 := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	mu.Lock()
	failing = true
	mu.Unlock()
	t0 := time.Now()
	for i := 0; i <= 8; i++ {
		if i%4 == 0 {
			s2.voiceCheckOnce()
		}
		s2.voiceLockSweep(t0.Add(time.Duration(i*5) * time.Second))
	}
	if !s2.voice.locked("Steve") {
		t.Fatal("a lock went while the checks failed")
	}
	mu.Lock()
	failing = false
	mu.Unlock()
	s2.voiceCheckOnce()
	s2.voiceLockSweep(t0.Add(45 * time.Second))
	s2.voiceLockSweep(t0.Add(74 * time.Second))
	if !s2.voice.locked("Steve") {
		t.Fatal("the count did not start from the first good check")
	}
	s2.voiceLockSweep(t0.Add(75 * time.Second))
	if s2.voice.locked("Steve") {
		t.Fatal("30 s in neither place after a good check kept the lock")
	}

	// H4. An admin's Disconnect in #voice-link takes the lock off.
	if !locked("Alex") {
		t.Fatal("Alex should still be locked here")
	}
	if c, b := call(account{Name: "Admin", Admin: true}, s.voiceModerate("disconnect"), LinkVoiceID, `{"name":"Alex"}`); c != http.StatusNoContent || locked("Alex") {
		t.Errorf("Disconnect: %d %s, Alex still locked %v", c, b, locked("Alex"))
	}

	// H6. Alex back in and locked; an admin changes his Minecraft name: LiveKit gets the new
	// one at once, and the lock (made for AlexMC) goes. A case change keeps it.
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "PA_4")
	lock("Alex")
	took()
	us.SetMC("Alex", "ALEXmc")
	s.mcChanged("Alex")
	if !locked("Alex") || took() != "Alex mc=ALEXmc" {
		t.Errorf("a case change: locked %v", locked("Alex"))
	}
	us.SetMC("Alex", "AlexNew")
	s.mcChanged("Alex")
	if got := took(); locked("Alex") || !strings.Contains(got, "Alex mc=AlexNew") {
		t.Errorf("a new name: locked %v, LiveKit told %q", locked("Alex"), got)
	}
	// The first lock file (a list of names): each lock takes its account's name, and keeps
	// working.
	os.WriteFile(filepath.Join(dir, "voice-locks.json"), []byte(`["Alex"]`), 0o600)
	s3 := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	s3.voiceCheckOnce()
	s3.voicePart(LinkVoiceID, "Alex", true, time.Now(), "")
	s3.voiceLockSweep(time.Now())
	if !s3.voice.locked("Alex") || s3.voice.locks["Alex"].mc != "AlexNew" {
		t.Errorf("the old lock file: %v", s3.voice.locks)
	}
}

// H5: a Minecraft name may not be another account's name, nor a new account's name another
// account's Minecraft name; your own name is fine.
func TestLookAlikeNames(t *testing.T) {
	us, _ := auth.Open(t.TempDir())
	us.SetPassword("Alex", "Alex-password")
	us.SetPassword("Steve", "Steve-password")
	if err := us.SetMC("Steve", "alex"); err != auth.ErrMCIsName {
		t.Errorf("Steve's Minecraft name as Alex's account name: %v", err)
	}
	if err := us.SetMC("Alex", "ALEX"); err != nil {
		t.Errorf("Alex's own name: %v", err)
	}
	if _, err := us.Add("alex", false); err != auth.ErrExists {
		t.Errorf("a second alex: %v", err)
	}
	us.SetMC("Steve", "Herobrine")
	if _, err := us.Add("HEROBRINE", false); err != auth.ErrMCIsName {
		t.Errorf("an account named as Steve's player: %v", err)
	}
}

// One place at a time (macrotech-ops tech-notes/voice-link-handover-spec.md): the hub cuts an
// account from #voice-link's room before it names its player as locked, and before a server
// lets a player join the group by hand; while the player is in the group (or going in), the
// hub has nothing to join; anyone found in both is cut; joining by hand turns the lock on.
func TestVoiceLinkHandover(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	for _, n := range []string{"Alex", "Carl", "Dana", "Erin", "Fay"} {
		us.SetPassword(n, n+"-password")
		us.SetMC(n, n+"MC")
	}
	var mu sync.Mutex
	removed := []string{}
	failFor := ""
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Room, Identity string }
		json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/ListParticipants":
			w.Write([]byte(`{"participants":[]}`))
		case "/twirp/livekit.RoomService/RemoveParticipant":
			if req.Identity == failFor {
				http.Error(w, "boom", http.StatusInternalServerError)
				return
			}
			removed = append(removed, req.Identity)
			w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer lk.Close()
	os.WriteFile(filepath.Join(dir, "voice.json"), []byte(`{"url":"wss://lk.example","api":"`+lk.URL+`","key":"k","secret":"s3cret","link_voice":true}`), 0o600)
	s := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	s.voiceCheckOnce()
	call := func(a account, h http.HandlerFunc, id, body string) (int, string) {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.SetPathValue("id", id)
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, a))
		w := httptest.NewRecorder()
		h(w, r)
		return w.Code, strings.TrimSpace(w.Body.String())
	}
	took := func() string {
		mu.Lock()
		defer mu.Unlock()
		out := strings.Join(removed, ",")
		removed = removed[:0]
		return out
	}
	where := func(name string) (bool, bool) {
		s.voice.mu.Lock()
		defer s.voice.mu.Unlock()
		return s.whereIs(name)
	}
	locked := func(name string) bool {
		s.voice.mu.Lock()
		defer s.voice.mu.Unlock()
		return s.voice.locked(name)
	}
	forget := func() { // the hand-overs so far are long over
		s.voice.mu.Lock()
		clear(s.voice.cut)
		s.voice.mu.Unlock()
	}
	server := account{Name: "Survival", Token: auth.KindServer}
	ask := func(players string) string {
		_, b := call(server, s.voiceLinkLocked, "", `{"players":`+players+`}`)
		return b
	}
	join := func(name, body string) int {
		c, _ := call(account{Name: name}, s.voiceJoin, LinkVoiceID, body)
		return c
	}
	handover := func(name string) bool {
		r := httptest.NewRequest("GET", "/api/voice", nil)
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, account{Name: name}))
		w := httptest.NewRecorder()
		s.voiceList(w, r)
		var out struct{ Chats []voiceChat }
		json.NewDecoder(w.Body).Decode(&out)
		for _, c := range out.Chats {
			if c.Link {
				return c.Handover
			}
		}
		return false
	}

	// Joining by hand turns the lock on once LiveKit says you're in; a take-over ({"lock":
	// false}) doesn't, nor does a token never used.
	if c := join("Alex", ""); c != http.StatusOK || locked("Alex") {
		t.Fatalf("Alex's join: %d, locked before he was in %v", c, locked("Alex"))
	}
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "")
	if !locked("Alex") {
		t.Fatal("joining #voice-link by hand did not turn the lock on")
	}
	join("Fay", `{"lock":false}`)
	s.voicePart(LinkVoiceID, "Fay", true, time.Now(), "")
	if locked("Fay") {
		t.Error(`a join with {"lock":false} turned the lock on`)
	}

	// A server asks about Alex: he is cut from the room before he is named; his page reads
	// why; he counts as going into the game, so the hub has nothing for him to join.
	if b := ask(`["alexmc"]`); b != `{"locked":["alexmc"]}` || took() != "Alex" {
		t.Fatalf("the question about Alex: %s", b)
	}
	if hub, game := where("Alex"); hub || !game || !handover("Alex") || handover("Fay") {
		t.Errorf("Alex after the cut: hub %v game %v handover %v (Fay sees %v)", hub, game, handover("Alex"), handover("Fay"))
	}
	if c := join("Alex", ""); c != http.StatusConflict {
		t.Errorf("Alex could join the hub while going into the game: %d", c)
	}
	// A page that connects after the cut anyway (a token from before) is cut at once.
	s.voicePart(LinkVoiceID, "Alex", true, time.Now(), "")
	if hub, _ := where("Alex"); hub || took() != "Alex" {
		t.Error("Alex connecting after the cut was not cut again")
	}
	// His player appears in game: the hand-over is done; he is in the game by his player; the
	// hub still has nothing to join (any case of the name).
	s.voicePart(LinkVoiceID, "link:survival:alexMC", true, time.Now(), "")
	s.voice.mu.Lock()
	_, marked := s.voice.cut["Alex"]
	s.voice.mu.Unlock()
	if marked || handover("Alex") {
		t.Error("the hand-over mark outlived Alex's player appearing")
	}
	if c := join("Alex", ""); c != http.StatusConflict {
		t.Errorf("Alex could join the hub while his player is in the group: %d", c)
	}
	// He leaves the game: the page's take-over may join.
	s.voicePart(LinkVoiceID, "link:survival:alexMC", false, time.Time{}, "")
	if c := join("Alex", `{"lock":false}`); c != http.StatusOK {
		t.Errorf("the take-over after Alex left the game: %d", c)
	}

	// A failed cut leaves the player out of the answer. A cut is made even when the hub's list
	// doesn't show the account (it lags LiveKit).
	s.voicePart(LinkVoiceID, "Carl", true, time.Now(), "")
	call(account{Name: "Carl"}, s.voiceLock, LinkVoiceID, `{"on":true}`)
	mu.Lock()
	failFor = "Carl"
	mu.Unlock()
	if b := ask(`["CarlMC"]`); b != `{"locked":[]}` {
		t.Errorf("Carl named after a failed cut: %s", b)
	}
	if hub, _ := where("Carl"); !hub {
		t.Error("Carl was taken off the list though LiveKit didn't cut him")
	}
	mu.Lock()
	failFor = ""
	mu.Unlock()
	if b := ask(`["CarlMC"]`); b != `{"locked":["CarlMC"]}` {
		t.Errorf("Carl's second question: %s", b)
	}
	took()
	if b := ask(`["CarlMC"]`); b != `{"locked":["CarlMC"]}` || took() != "Carl" {
		t.Errorf("Carl, going into the game and off the list, was not cut again: %s", b)
	}
	forget()

	// A join of the group by hand: only for game servers; the hub cuts first; a name with no
	// account has nothing to cut; a failed cut is a 503.
	s.voicePart(LinkVoiceID, "Dana", true, time.Now(), "")
	joining := func(a account, player string) int {
		c, _ := call(a, s.voiceLinkJoining, "", `{"player":"`+player+`"}`)
		return c
	}
	if c := joining(account{Name: "Dana"}, "DanaMC"); c != http.StatusForbidden {
		t.Errorf("a member asked /joining: %d", c)
	}
	if c := joining(server, "Nobody"); c != http.StatusNoContent || took() != "" {
		t.Errorf("a name with no account: %d", c)
	}
	mu.Lock()
	failFor = "Dana"
	mu.Unlock()
	if c := joining(server, "danamc"); c != http.StatusServiceUnavailable {
		t.Errorf("a failed cut: %d", c)
	}
	mu.Lock()
	failFor = ""
	mu.Unlock()
	if c := joining(server, "danamc"); c != http.StatusNoContent || took() != "Dana" {
		t.Errorf("Dana's join by hand: %d", c)
	}
	if hub, game := where("Dana"); hub || !game {
		t.Errorf("Dana after the cut: hub %v game %v", hub, game)
	}
	if !tokenAllowed(httptest.NewRequest("POST", "/api/voice-link/joining", nil), auth.KindServer) || tokenAllowed(httptest.NewRequest("POST", "/api/voice-link/joining", nil), auth.KindRelease) {
		t.Error("tokens.go: /joining is for game servers' tokens only")
	}
	forget()

	// Found in both, either way round (a bridge that came back; a page that got in): cut.
	s.voicePart(LinkVoiceID, "Erin", true, time.Now(), "")
	took()
	s.voicePart(LinkVoiceID, "link:creative:ERINMC", true, time.Now(), "")
	if hub, _ := where("Erin"); hub || took() != "Erin" {
		t.Error("Erin's player arrived while Erin was in the hub: not cut")
	}
	s.voicePart(LinkVoiceID, "Erin", true, time.Now(), "")
	if hub, _ := where("Erin"); hub || took() != "Erin" {
		t.Error("Erin came into the hub while her player was in the group: not cut")
	}
	// Someone else's player doesn't cut Fay.
	if hub, _ := where("Fay"); !hub {
		t.Error("Fay was cut for someone else's player")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "voice-chats.json")); strings.Contains(string(b), "handover") {
		t.Errorf("voice-chats.json carries a hand-over: %s", b)
	}
}
