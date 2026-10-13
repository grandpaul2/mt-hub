package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

// #voice-link: there while voice.json asks for it, never ended, outside the limit of three;
// the bridge's participants are players (name and server tag) or its listener ("linked"),
// never accounts to remove; a member cannot be taken for one.
func TestVoiceLink(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(dir)
	for _, n := range []string{"Alex", "Steve"} {
		us.SetPassword(n, n+"-password")
	}
	live := `[]`
	removed := []string{}
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Room, Identity string }
		json.NewDecoder(r.Body).Decode(&req)
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/ListParticipants":
			if req.Room != LinkVoiceID { // the two ordinary voice chats below: Steve in each
				w.Write([]byte(`{"participants":[{"identity":"Steve","joinedAt":"1"}]}`))
				return
			}
			w.Write([]byte(`{"participants":` + live + `}`))
		case "/twirp/livekit.RoomService/RemoveParticipant":
			removed = append(removed, req.Identity)
			w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer lk.Close()
	confN := 0
	conf := func(link bool) {
		// (A new file time each write, so the hub reads it again.)
		f := filepath.Join(dir, "voice.json")
		os.WriteFile(f, []byte(`{"url":"wss://lk.example","api":"`+lk.URL+`","key":"k","secret":"s3cret","link_voice":`+map[bool]string{true: "true", false: "false"}[link]+`}`), 0o600)
		confN++
		at := time.Now().Add(time.Duration(confN) * time.Minute)
		os.Chtimes(f, at, at)
	}
	s := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	link := func() *voiceChat {
		s.voice.mu.Lock()
		defer s.voice.mu.Unlock()
		return s.voice.chats[LinkVoiceID]
	}
	people := func() string {
		vc := link()
		if vc == nil {
			return "(no #voice-link)"
		}
		var out []string
		for _, p := range vc.People {
			who := p.Name
			if p.Show != "" {
				who = p.Show + "/" + p.Via + "/" + p.Name
			}
			out = append(out, who)
		}
		return strings.Join(out, ",")
	}

	// Without link_voice there is no such voice chat, and the bridge's identities are nobody.
	conf(false)
	s.voiceCheckOnce()
	if link() != nil {
		t.Fatal("#voice-link exists without link_voice")
	}
	s.voicePart(LinkVoiceID, "link:survival:Steve", true, time.Now())
	if link() != nil {
		t.Fatal("a bridge identity made #voice-link exist")
	}

	// With it: there, empty, not linked, and not one of the three.
	conf(true)
	s.voiceCheckOnce()
	vc := link()
	if vc == nil || !vc.Link || vc.Linked || len(vc.People) != 0 {
		t.Fatalf("#voice-link after link_voice: %+v", vc)
	}
	s.voice.mu.Lock()
	for _, id := range []string{"a", "b"} {
		s.voice.chats[id] = &voiceChat{ID: id, Starter: "Steve", People: []voicePerson{{Name: "Steve"}}, Started: time.Now()}
	}
	n := s.voice.started()
	s.voice.mu.Unlock()
	if n != 2 {
		t.Errorf("started() counts %d, want 2 (not #voice-link)", n)
	}

	// The listener joins: linked, and not a person. A player joins: a person with their
	// Minecraft name and server tag. A member joins: a person.
	s.voicePart(LinkVoiceID, "link:listener", true, time.Now())
	s.voicePart(LinkVoiceID, "link:survival:Steve", true, time.Now())
	s.voicePart(LinkVoiceID, "link:creative:gypsy_jay", true, time.Now())
	s.voicePart(LinkVoiceID, "Alex", true, time.Now())
	if got, want := people(), "Steve/SMP/link:survival:Steve,gypsy_jay/CMP/link:creative:gypsy_jay,Alex"; got != want || !link().Linked {
		t.Errorf("people %q linked %v, want %q linked", got, link().Linked, want)
	}
	// A player's identity in another voice chat is nobody's.
	s.voicePart("a", "link:survival:Steve", true, time.Now())
	s.voice.mu.Lock()
	inA := s.voice.chats["a"].People
	s.voice.mu.Unlock()
	if len(inA) != 1 || inA[0].Name != "Steve" {
		t.Errorf("a bridge identity was put in another voice chat: %+v", inA)
	}

	// The 20-second check: LiveKit's list is taken as it is. The bridge's participants are not
	// looked up as accounts (so not removed); someone who is no account is.
	live = `[{"identity":"link:listener","joinedAt":"1"},{"identity":"link:survival:Steve","joinedAt":"2"},{"identity":"Alex","joinedAt":"3"},{"identity":"Gone","joinedAt":"4"}]`
	s.voiceCheckOnce()
	if strings.Join(removed, ",") != "Gone" {
		t.Errorf("removed %v, want only Gone", removed)
	}
	if got, want := people(), "Steve/SMP/link:survival:Steve,Alex"; got != want || !link().Linked {
		t.Errorf("after the check: people %q linked %v, want %q linked", got, link().Linked, want)
	}

	// Everyone leaves, the bridge too: still there, empty, not linked.
	live = `[]`
	s.voicePart(LinkVoiceID, "Alex", false, time.Time{})
	s.voicePart(LinkVoiceID, "link:survival:Steve", false, time.Time{})
	s.voicePart(LinkVoiceID, "link:listener", false, time.Time{})
	s.voiceCheckOnce()
	if vc := link(); vc == nil || vc.Linked || len(vc.People) != 0 {
		t.Fatalf("#voice-link after everyone left: %+v", vc)
	}

	// Kept across a restart; gone when voice.json stops asking.
	s2 := &Server{users: us, voice: loadVoice(dir), bus: newBroker()}
	if s2.voice.chats[LinkVoiceID] == nil {
		t.Error("#voice-link was not kept across a restart")
	}
	conf(false)
	s.voiceCheckOnce()
	if link() != nil {
		t.Error("#voice-link still there after link_voice went")
	}
}
