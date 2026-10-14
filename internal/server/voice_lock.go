package server

// The lock (docs/voice/svc/lock-spec.md): a member in #voice-link, in the hub or in the group
// in game, can lock themselves in. The hub keeps the lock per account; the game servers learn
// it from the bridge's roster (the token's and LiveKit's participant attribute "lock") and
// put a locked player in the group when they arrive; the page takes over when the player
// leaves the game. Nobody else is told who is locked.
//
// A lock goes off when its account leaves on purpose (Leave in the hub, another voice chat,
// or leaving the group in game, which the server reports), loses its Minecraft name, is
// banned or deleted, or has been in neither place for lockNowhereFor.

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

// lockNowhereFor is how long a locked account may be in neither place (the hub's voice chat,
// the group in game) before its lock goes off: room for the hand-over itself and for reloading
// the page.
const lockNowhereFor = 30 * time.Second

func (s *Server) voiceLockRoutes() {
	s.mux.HandleFunc("POST /api/voice/{id}/lock", s.voiceLock)
	s.mux.HandleFunc("POST /api/voice-link/left", s.voiceLinkLeft)
	go func() {
		for {
			time.Sleep(5 * time.Second)
			s.voiceLockSweep(time.Now())
		}
	}()
}

func (v *voice) loadLocks() {
	v.locks = map[string]time.Time{}
	var names []string
	if b, err := os.ReadFile(v.locksFile); err == nil && json.Unmarshal(b, &names) == nil {
		for _, n := range names {
			v.locks[n] = time.Time{}
		}
	}
}

// saveLocks writes the locked accounts out; called with mu held.
func (v *voice) saveLocks() {
	names := make([]string, 0, len(v.locks))
	for n := range v.locks {
		names = append(names, n)
	}
	slices.Sort(names)
	b, _ := json.Marshal(names)
	tmp := v.locksFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err == nil {
		os.Rename(tmp, v.locksFile)
	}
}

func (v *voice) locked(name string) bool {
	_, ok := v.locks[name]
	return ok
}

// whereIs says whether an account is in #voice-link in the hub, and whether its player (its
// Minecraft name, whatever the case) is in the group in game. Called with mu held.
func (s *Server) whereIs(name string) (hub, game bool) {
	vc := s.voice.chats[LinkVoiceID]
	if vc == nil || !vc.Link {
		return false, false
	}
	hub = vc.has(name)
	if u, ok := s.users.Get(name); ok && u.MC != "" {
		game = slices.ContainsFunc(vc.People, func(p voicePerson) bool { return p.Show != "" && strings.EqualFold(p.Show, u.MC) })
	}
	return hub, game
}

// voiceLock: {"on": bool}, for yourself, in #voice-link only. Locking needs a Minecraft name
// and being in voice-link (in the hub or in game); unlocking is always allowed.
func (s *Server) voiceLock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		On bool `json:"on"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	me := who(r).Name
	conf := s.voice.config()
	if r.PathValue("id") != LinkVoiceID || conf == nil || !conf.LinkVoice {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "only voice-link has a lock"})
		return
	}
	if !req.On {
		s.unlock(me, "unlocked")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if u, ok := s.users.Get(me); !ok || u.MC == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "An admin has to set your Minecraft name first."})
		return
	}
	s.voice.mu.Lock()
	s.voice.linkVoice(conf)
	hub, game := s.whereIs(me)
	if !hub && !game {
		s.voice.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]string{"error": "Join voice-link first."})
		return
	}
	was := s.voice.locked(me)
	s.voice.locks[me] = time.Time{}
	s.voice.saveLocks()
	s.voice.mu.Unlock()
	if !was {
		log.Printf("voice-link: %s locked (in the hub %v, in game %v)", me, hub, game)
	}
	if hub {
		s.lockAttribute(conf, me, true)
	}
	s.voiceChanged()
	w.WriteHeader(http.StatusNoContent)
}

// unlock takes an account's lock off, if it has one, and tells LiveKit (so the bridge's roster
// says so) when the account is in the hub's voice chat.
func (s *Server) unlock(name, why string) {
	s.voice.mu.Lock()
	if !s.voice.locked(name) {
		s.voice.mu.Unlock()
		return
	}
	delete(s.voice.locks, name)
	s.voice.saveLocks()
	hub, _ := s.whereIs(name)
	s.voice.mu.Unlock()
	log.Printf("voice-link: %s's lock off (%s)", name, why)
	if conf := s.voice.config(); hub && conf != nil {
		s.lockAttribute(conf, name, false)
	}
	s.voiceChanged()
}

// lockAttribute sets (or clears) the "lock" attribute of an account's participant in
// #voice-link: the bridge sends its roster again when it changes.
func (s *Server) lockAttribute(conf *voiceConf, name string, on bool) {
	v := ""
	if on {
		v = "1" // (an empty value deletes the attribute)
	}
	if _, err := conf.twirp("UpdateParticipant", LinkVoiceID, map[string]any{"room": LinkVoiceID, "identity": name, "attributes": map[string]string{"lock": v}}); err != nil {
		log.Printf("voice-link: telling LiveKit %s's lock is %v: %v", name, on, err)
	}
}

// voiceLinkLeft: a game server says a player left the group in game on purpose (still
// connected to voice chat there): {"player": "<Minecraft name>"}. Their account's lock goes
// off. Answered at once, the same way for a name that has no account or no lock: the server
// holds its roster until this answer.
func (s *Server) voiceLinkLeft(w http.ResponseWriter, r *http.Request) {
	if who(r).Token != auth.KindServer {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "for game servers"})
		return
	}
	var req struct {
		Player string `json:"player"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if name, ok := s.users.ByMC(req.Player); ok {
		s.unlock(name, "left the group on "+who(r).Name)
	}
	w.WriteHeader(http.StatusNoContent)
}

// voiceLockSweep takes off the locks that should go: accounts gone, banned or without a
// Minecraft name, and accounts in neither place for lockNowhereFor (counted from the sweep
// that first saw them nowhere, every 5 seconds).
func (s *Server) voiceLockSweep(now time.Time) {
	var off []string
	s.voice.mu.Lock()
	for name, since := range s.voice.locks {
		u, ok := s.users.Get(name)
		if !ok || u.Banned || u.MC == "" {
			off = append(off, name)
			continue
		}
		hub, game := s.whereIs(name)
		switch {
		case hub || game:
			s.voice.locks[name] = time.Time{}
		case since.IsZero():
			s.voice.locks[name] = now
		case now.Sub(since) >= lockNowhereFor:
			off = append(off, name)
		}
	}
	s.voice.mu.Unlock()
	for _, name := range off {
		s.unlock(name, "no account, banned, no Minecraft name, or in neither place for 30 s")
	}
}
