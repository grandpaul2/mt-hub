package server

// The lock (docs/voice/svc/lock-spec.md): a member in #voice-link, in the hub or in the group
// in game, can lock themselves in. The hub keeps the lock per account, with the Minecraft
// name it was made for; the game servers ask the hub which of their players are locked
// (POST /api/voice-link/locked) and put a locked player in the group when they arrive; the
// page takes over when the player leaves the game. Nobody else is told who is locked: the
// lock is in no LiveKit attribute and in no roster.
//
// A lock goes off when its account leaves on purpose (Leave in the hub, another voice chat,
// leaving the group in game, which the server reports, or an admin's Disconnect), loses or
// changes its Minecraft name, is banned or deleted, or has been in neither place for
// lockNowhereFor. That clock stands still while the hub can't ask LiveKit who is where.

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

// One place at a time (macrotech-ops tech-notes/voice-link-handover-spec.md): #voice-link is
// one place with two ways in, the hub and the group in game, and a person is in it one way at
// a time. The hub shuts its own side before the game's opens: before it names a player as
// locked to a game server (which then puts them in the group), and before a server lets a
// player join the group by hand (POST /api/voice-link/joining), it removes their account from
// the room with LiveKit (cutForGame). Anyone found in the room while their player is in the
// group in game is cut at once (bothPlaces): a page that connected after the cut, a bridge
// that came back. While your player is in the group, the hub has nothing to join.

// handoverFor: after a cut, the account counts as in the game this long, or until its
// player's participant appears: so the answer keeps naming it, the 30 s count doesn't start,
// and the hub has nothing for it to join.
const handoverFor = 10 * time.Second

// cutDeadline bounds one round of cuts: a game server's question gives up after 3 s.
const cutDeadline = 2 * time.Second

// lockNowhereFor is how long a locked account may be in neither place (the hub's voice chat,
// the group in game) before its lock goes off: room for the hand-over itself and for reloading
// the page.
const lockNowhereFor = 30 * time.Second

// A lock: the Minecraft name it was made for, and when its account was first seen in
// neither place (zero while it is somewhere).
type voiceLockEntry struct {
	mc    string
	since time.Time
}

func (s *Server) voiceLockRoutes() {
	s.mux.HandleFunc("POST /api/voice/{id}/lock", s.voiceLock)
	s.mux.HandleFunc("POST /api/voice-link/left", s.voiceLinkLeft)
	s.mux.HandleFunc("POST /api/voice-link/locked", s.voiceLinkLocked)
	s.mux.HandleFunc("POST /api/voice-link/joining", s.voiceLinkJoining)
	go func() {
		for {
			time.Sleep(5 * time.Second)
			s.voiceLockSweep(time.Now())
		}
	}()
}

// loadLocks reads voice-locks.json: {"account": "Minecraft name"}. (The first version was a
// list of account names: each of those takes its account's Minecraft name at the next sweep.)
func (v *voice) loadLocks() {
	v.locks = map[string]voiceLockEntry{}
	b, err := os.ReadFile(v.locksFile)
	if err != nil {
		return
	}
	var names []string
	var mcs map[string]string
	if json.Unmarshal(b, &names) == nil {
		for _, n := range names {
			v.locks[n] = voiceLockEntry{}
		}
	} else if json.Unmarshal(b, &mcs) == nil {
		for n, mc := range mcs {
			v.locks[n] = voiceLockEntry{mc: mc}
		}
	}
}

// saveLocks writes the locked accounts out; called with mu held.
func (v *voice) saveLocks() {
	mcs := make(map[string]string, len(v.locks))
	for n, l := range v.locks {
		mcs[n] = l.mc
	}
	b, _ := json.Marshal(mcs)
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
// Minecraft name, whatever the case) is in the group in game, or is going in (cut for it a
// moment ago). Called with mu held.
func (s *Server) whereIs(name string) (hub, game bool) {
	vc := s.voice.chats[LinkVoiceID]
	if vc == nil || !vc.Link {
		return false, false
	}
	hub = vc.has(name)
	return hub, s.playerIn(vc, name) || s.voice.cutLately(name, time.Now())
}

// playerIn says whether an account's player is in the group in game (the bridge's participant
// for it is in the room). Called with mu held.
func (s *Server) playerIn(vc *voiceChat, name string) bool {
	u, ok := s.users.Get(name)
	return ok && u.MC != "" && slices.ContainsFunc(vc.People, func(p voicePerson) bool { return p.Show != "" && strings.EqualFold(p.Show, u.MC) })
}

// cutLately says whether an account was cut for the game less than handoverFor ago (and its
// player hasn't appeared since). Called with mu held.
func (v *voice) cutLately(name string, now time.Time) bool {
	t, ok := v.cut[name]
	return ok && now.Sub(t) < handoverFor
}

// bothPlaces lists the accounts in #voice-link's room whose player is in the group in game,
// or that were cut for the game a moment ago. Called with mu held.
func (s *Server) bothPlaces(now time.Time) []string {
	vc := s.voice.chats[LinkVoiceID]
	if vc == nil || !vc.Link {
		return nil
	}
	var out []string
	for _, p := range vc.People {
		if p.Show == "" && (s.playerIn(vc, p.Name) || s.voice.cutLately(p.Name, now)) {
			out = append(out, p.Name)
		}
	}
	return out
}

// cutForGame removes accounts from #voice-link's room, all at once and within cutDeadline, and
// says which are out: those LiveKit removed, or didn't have (its 404; also what a wrong
// address would answer, which the 20 s check reports). Each is marked as going into the game
// (its page reads that it was handed over, not disconnected by an admin; the mark goes when
// its player's participant comes or goes), taken off the list and every page told. Never
// called with mu held.
func (s *Server) cutForGame(accounts []string, why string) map[string]bool {
	out := map[string]bool{}
	conf := s.voice.config()
	if conf == nil || len(accounts) == 0 {
		return out
	}
	type result struct {
		name string
		err  error
	}
	done := make(chan result, len(accounts))
	for _, a := range accounts {
		go func() {
			_, err := conf.twirp("RemoveParticipant", LinkVoiceID, map[string]string{"room": LinkVoiceID, "identity": a})
			done <- result{a, err}
		}()
	}
	deadline := time.After(cutDeadline)
wait:
	for range accounts {
		select {
		case r := <-done:
			if r.err != nil {
				log.Printf("voice-link: cutting %s for the game: %v", r.name, r.err)
				continue
			}
			out[r.name] = true
		case <-deadline:
			log.Printf("voice-link: cutting for the game: LiveKit took over %s", cutDeadline)
			break wait
		}
	}
	now := time.Now()
	s.voice.mu.Lock()
	for a := range out {
		s.voice.cut[a] = now
	}
	s.voice.mu.Unlock()
	for a := range out {
		log.Printf("voice-link: cut %s from the hub (%s)", a, why)
		s.voicePart(LinkVoiceID, a, false, time.Time{}, "")
	}
	if len(out) > 0 {
		s.voiceChanged() // (the cut account's page reads why: GET /api/voice says handover)
	}
	return out
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
	u, ok := s.users.Get(me)
	if !ok || u.MC == "" {
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
	s.voice.locks[me] = voiceLockEntry{mc: u.MC}
	s.voice.saveLocks()
	s.voice.mu.Unlock()
	if !was {
		log.Printf("voice-link: %s locked (in the hub %v, in game %v)", me, hub, game)
	}
	s.voiceChanged()
	w.WriteHeader(http.StatusNoContent)
}

// unlock takes an account's lock off, if it has one.
func (s *Server) unlock(name, why string) {
	s.voice.mu.Lock()
	if !s.voice.locked(name) {
		s.voice.mu.Unlock()
		return
	}
	delete(s.voice.locks, name)
	s.voice.saveLocks()
	s.voice.mu.Unlock()
	log.Printf("voice-link: %s's lock off (%s)", name, why)
	s.voiceChanged()
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

// voiceLinkLocked: a game server asks which of its players are locked: {"players": [...]}
// (Minecraft names) → {"locked": [...]}, the names as asked. A player is locked while their
// account (not banned) holds a lock made for that Minecraft name and is in #voice-link now,
// in the hub or in the group in game; the 30 s a lock outlives being in neither place is for
// the page, not for this. The server asks about its players who are in voice chat and in no
// group, when one connects and every 2 seconds.
//
// The server puts each player it is told about in the group at once, so the hub first cuts
// their account from the room (cutForGame): a player is named only once their hub side is
// shut, and one whose cut failed is left out (the server asks again in 2 s).
func (s *Server) voiceLinkLocked(w http.ResponseWriter, r *http.Request) {
	if who(r).Token != auth.KindServer {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "for game servers"})
		return
	}
	var req struct {
		Players []string `json:"players"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Players) > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at most 100 players"})
		return
	}
	asked := map[string]string{} // lower case → as asked
	for _, p := range req.Players {
		if !auth.MCNameRE.MatchString(p) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a Minecraft name: " + p})
			return
		}
		asked[strings.ToLower(p)] = p
	}
	player := map[string]string{} // account → the name as asked
	s.voice.mu.Lock()
	for name, l := range s.voice.locks {
		u, ok := s.users.Get(name)
		if !ok || u.Banned || u.MC == "" || (l.mc != "" && !strings.EqualFold(l.mc, u.MC)) {
			continue
		}
		p, ok := asked[strings.ToLower(u.MC)]
		if !ok {
			continue
		}
		if hub, game := s.whereIs(name); hub || game {
			player[name] = p
		}
	}
	s.voice.mu.Unlock()
	accounts := make([]string, 0, len(player))
	for name := range player {
		accounts = append(accounts, name)
	}
	out := []string{}
	for name := range s.cutForGame(accounts, "locked, going into the group on "+who(r).Name) {
		out = append(out, player[name])
	}
	slices.Sort(out)
	writeJSON(w, http.StatusOK, map[string][]string{"locked": out})
}

// voiceLinkJoining: a game server is holding a player's join of the group by hand, and asks
// the hub to shut their hub side first: {"player": "<Minecraft name>"}. 204 once it is shut
// (or the name has no account: nothing to shut); 503 if LiveKit didn't do it, and the server
// refuses the join.
func (s *Server) voiceLinkJoining(w http.ResponseWriter, r *http.Request) {
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
	if !auth.MCNameRE.MatchString(req.Player) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a Minecraft name: " + req.Player})
		return
	}
	name, ok := s.users.ByMC(req.Player)
	if ok && !s.cutForGame([]string{name}, "joining the group by hand on "+who(r).Name)[name] {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "the voice server didn't answer"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// mcChanged: an admin set or took away an account's Minecraft name. LiveKit is told at once
// (the bridge shows them in game as that player), and a lock made for another name goes off.
func (s *Server) mcChanged(name string) {
	if s.voice == nil {
		return
	}
	u, _ := s.users.Get(name)
	s.voice.mu.Lock()
	l, locked := s.voice.locks[name]
	hub, _ := s.whereIs(name)
	s.voice.mu.Unlock()
	if conf := s.voice.config(); hub && conf != nil {
		if _, err := conf.twirp("UpdateParticipant", LinkVoiceID, map[string]any{"room": LinkVoiceID, "identity": name, "attributes": map[string]string{"mc": u.MC}}); err != nil {
			log.Printf("voice-link: telling LiveKit %s's Minecraft name: %v", name, err)
		}
	}
	if locked && (u.MC == "" || (l.mc != "" && !strings.EqualFold(l.mc, u.MC))) {
		s.unlock(name, "Minecraft name changed")
	}
}

// voiceLockSweep takes off the locks that should go: accounts gone, banned, without a
// Minecraft name or with another one than the lock's, and accounts in neither place for
// lockNowhereFor (counted from the sweep that first saw them nowhere, every 5 seconds). While
// the hub's last check with LiveKit failed, or none has been made since it started, who is
// where isn't known: the count starts again once it is.
func (s *Server) voiceLockSweep(now time.Time) {
	var off []string
	s.voice.mu.Lock()
	for name, t := range s.voice.cut {
		if now.Sub(t) >= handoverFor {
			delete(s.voice.cut, name)
		}
	}
	for name, t := range s.voice.lockOnJoin {
		if now.Sub(t) >= time.Minute {
			delete(s.voice.lockOnJoin, name)
		}
	}
	for name, l := range s.voice.locks {
		u, ok := s.users.Get(name)
		if l.mc == "" && ok {
			l.mc = u.MC // (a lock from before locks kept their name)
		}
		if !ok || u.Banned || u.MC == "" || !strings.EqualFold(l.mc, u.MC) {
			off = append(off, name)
			continue
		}
		hub, game := s.whereIs(name)
		switch {
		case hub || game || !s.voice.checked:
			l.since = time.Time{}
		case l.since.IsZero():
			l.since = now
		case now.Sub(l.since) >= lockNowhereFor:
			off = append(off, name)
		}
		s.voice.locks[name] = l
	}
	s.voice.mu.Unlock()
	for _, name := range off {
		s.unlock(name, "no account, banned, no or another Minecraft name, or in neither place for 30 s")
	}
}
