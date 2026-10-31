package server

// Voice chats (agreed design: docs/voice/rooms-design.md). There are no
// permanent rooms: someone starts a voice chat, others join, and it ends when the last person
// leaves. A voice chat has no name; it is shown as the list of people in it, in the order
// they joined. A private one is seen only by the people invited, not even admins.
//
// The audio itself goes through LiveKit on the relay VPS. The hub decides who may see and
// join each voice chat and hands out LiveKit tokens for it; LiveKit's webhooks tell it who
// joined and left. The voice chats are kept in voice-chats.json so a hub restart doesn't
// lose them while people are still talking, and checked against LiveKit every 20 seconds
// in case a webhook went missing.
//
// voice.json in the data directory holds LiveKit's address and key; without it, voice chats
// are off.
//
// One voice chat is different (docs/voice/svc/hub-link-spec.md): #voice-link, there when
// voice.json has "link_voice": true. It is always listed, never ends, and is the same room as
// the Simple Voice Chat group on our game servers. A separate program (cmd/voicebridge) is in
// its LiveKit room as a listener and as one participant for each player in that group; the
// hub learns of them as of anyone, from LiveKit, and tells them apart by their identities.

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// maxVoiceChats is how many voice chats may exist at once.
const maxVoiceChats = 3

// An unused voice chat (started, but nobody connected) goes after this long.
const voiceUnusedFor = time.Minute

type voiceConf struct {
	URL       string `json:"url"` // what browsers connect to (wss://)
	API       string `json:"api"` // where the hub calls LiveKit's API (https://)
	Key       string `json:"key"`
	Secret    string `json:"secret"`
	LinkVoice bool   `json:"link_voice"` // #voice-link exists (a bridge to the game servers runs beside LiveKit)
}

// LinkVoiceID is #voice-link's id, and its LiveKit room. The bridge's participants there:
// its listener, and "link:<server>:<Minecraft name>" for each player. An account name cannot
// contain ":", so no member's token can pose as one.
const (
	LinkVoiceID      = "voice-link"
	linkVoiceListen  = "link:listener"
	linkVoicePlayers = "link:"
)

type voicePerson struct {
	Name  string    `json:"name"` // their account; for a player in game, the bridge's identity for them
	Since time.Time `json:"since"`
	Show  string    `json:"show,omitempty"` // a player in game: their Minecraft name (in GET /api/voice, the hub name it's linked to, if any)
	Via   string    `json:"via,omitempty"`  // and their server's tag (SMP, CMP), as in #text-link
	Game  string    `json:"game,omitempty"` // in GET /api/voice: their Minecraft name, when show is a hub name
	// LiveKit's id for this session: a second tab replaces the first under the same identity,
	// and the first one's leave must not take the second off. Never sent or saved (after a
	// restart a leave goes by name, as when LiveKit gives no id).
	sid string
}

type voiceChat struct {
	ID      string        `json:"id"`
	Private bool          `json:"private,omitempty"`
	Starter string        `json:"starter"`
	Invited []string      `json:"invited,omitempty"` // private only; the starter is included
	People  []voicePerson `json:"people"`            // in the order they joined
	Started time.Time     `json:"started"`
	Link    bool          `json:"link,omitempty"`   // #voice-link
	Linked  bool          `json:"linked,omitempty"` // and the bridge is in it: the game servers hear it
	Lock    bool          `json:"lock,omitempty"`   // #voice-link, in GET /api/voice only: the person asking is locked (voice_lock.go)
	// #voice-link, in GET /api/voice only: the person asking was just cut from the room because
	// their player is going into the group in game (voice_lock.go, cutForGame).
	Handover bool `json:"handover,omitempty"`
}

// linkView is #voice-link as one person sees it: your own lock, and nobody else's; and on the
// hub, hub names (docs/style-guide.md, Names): a player whose Minecraft name is linked to an
// account is shown under the account's name, with the Minecraft name beside it in game.
// Called with mu held.
func (s *Server) linkView(vc *voiceChat, me string) *voiceChat {
	c := *vc
	c.Lock = s.voice.locked(me)
	c.Handover = s.voice.cutLately(me, time.Now())
	c.People = make([]voicePerson, len(vc.People))
	for i, p := range vc.People {
		if p.Via != "" {
			if name := s.hubName(p.Show); name != p.Show {
				p.Game, p.Show = p.Show, name
			}
		}
		c.People[i] = p
	}
	return &c
}

// hubName is the hub account a Minecraft name is linked to (whatever its case), or the
// Minecraft name itself when none is.
func (s *Server) hubName(mc string) string {
	if name, ok := s.users.ByMC(mc); ok {
		return name
	}
	return mc
}

// voicePersonFor is the list entry for a LiveKit identity: an account, or a player in game.
func voicePersonFor(identity string, since time.Time) voicePerson {
	p := voicePerson{Name: identity, Since: since}
	if rest, ok := strings.CutPrefix(identity, linkVoicePlayers); ok {
		if server, name, ok := strings.Cut(rest, ":"); ok {
			p.Show, p.Via = name, linkTag(server)
		}
	}
	return p
}

// linkVoice keeps #voice-link there while voice.json asks for it, and takes it away when it
// stops. Called with mu held; says whether anything changed.
func (v *voice) linkVoice(conf *voiceConf) bool {
	vc, there := v.chats[LinkVoiceID]
	want := conf != nil && conf.LinkVoice
	switch {
	case want && !there:
		v.chats[LinkVoiceID] = &voiceChat{ID: LinkVoiceID, Link: true, People: []voicePerson{}}
	case !want && there && vc.Link:
		delete(v.chats, LinkVoiceID)
	default:
		return false
	}
	v.save()
	return true
}

// started is how many voice chats people have started: the limit does not count #voice-link.
func (v *voice) started() int {
	n := len(v.chats)
	if vc := v.chats[LinkVoiceID]; vc != nil && vc.Link {
		n--
	}
	return n
}

type voice struct {
	confFile string
	confMu   sync.Mutex
	conf     *voiceConf
	confMod  time.Time
	file     string
	mu       sync.Mutex
	chats    map[string]*voiceChat
	seenMu   sync.Mutex
	seen     map[string]time.Time // webhook ids lately (replayed)
	// The locked accounts (voice_lock.go), kept in voice-locks.json. Under mu.
	locksFile string
	locks     map[string]voiceLockEntry
	// The hand-over to the game (voice_lock.go, cutForGame): when each account was last cut
	// from #voice-link because its player is going into the group in game. Under mu.
	cut map[string]time.Time
	// Per account, the cut calls to LiveKit still out, and the mark (cut's time) one of them
	// cut it under: a refused call drops the mark only when no other call cut it. Under mu.
	cutting   map[string]int
	cutWorked map[string]time.Time
	// Accounts handed a #voice-link token to join by hand (not a take-over): the lock comes on
	// when LiveKit says they are in. Under mu.
	lockOnJoin map[string]time.Time
	// checked: the last check with LiveKit (voiceCheckOnce) answered for every voice chat, so
	// the lists say who is where. Under mu.
	checked bool
}

func loadVoice(dir string) *voice {
	v := &voice{confFile: filepath.Join(dir, "voice.json"), file: filepath.Join(dir, "voice-chats.json"), chats: map[string]*voiceChat{},
		locksFile: filepath.Join(dir, "voice-locks.json"), cut: map[string]time.Time{}, cutting: map[string]int{}, cutWorked: map[string]time.Time{}, lockOnJoin: map[string]time.Time{}}
	v.loadLocks()
	if b, err := os.ReadFile(v.file); err == nil {
		var list []*voiceChat
		if json.Unmarshal(b, &list) == nil {
			for _, vc := range list {
				v.chats[vc.ID] = vc
			}
		}
	}
	return v
}

// config is LiveKit's address and key from voice.json, read again whenever the file changes
// (so voice chats can be set up without a restart); nil while there's none.
func (v *voice) config() *voiceConf {
	v.confMu.Lock()
	defer v.confMu.Unlock()
	info, err := os.Stat(v.confFile)
	if err != nil {
		v.conf, v.confMod = nil, time.Time{}
		return nil
	}
	if info.ModTime().Equal(v.confMod) {
		return v.conf
	}
	v.confMod = info.ModTime()
	v.conf = nil
	var c voiceConf
	b, err := os.ReadFile(v.confFile)
	if err == nil && json.Unmarshal(b, &c) == nil && c.URL != "" && c.Key != "" && c.Secret != "" {
		v.conf = &c
	} else {
		log.Printf("voice.json: unusable, voice chats off")
	}
	return v.conf
}

// save writes the voice chats out; called with mu held.
func (v *voice) save() {
	list := make([]*voiceChat, 0, len(v.chats))
	for _, vc := range v.chats {
		list = append(list, vc)
	}
	b, _ := json.Marshal(list)
	tmp := v.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err == nil {
		os.Rename(tmp, v.file)
	}
}

func (vc *voiceChat) sees(user string) bool { return !vc.Private || slices.Contains(vc.Invited, user) }

func (vc *voiceChat) has(user string) bool {
	return slices.ContainsFunc(vc.People, func(p voicePerson) bool { return p.Name == user })
}

func (s *Server) voiceRoutes() {
	s.mux.HandleFunc("GET /api/voice", s.voiceList)
	s.mux.HandleFunc("POST /api/voice", s.voiceStart)
	s.mux.HandleFunc("POST /api/voice/{id}/join", s.voiceJoin)
	s.mux.HandleFunc("POST /api/voice/{id}/leave", s.voiceLeave)
	s.mux.HandleFunc("POST /api/voice/{id}/invite", s.voiceInvite)
	s.mux.HandleFunc("POST /api/voice/{id}/disconnect", s.voiceModerate("disconnect"))
	s.mux.HandleFunc("POST /api/voice/{id}/mute", s.voiceModerate("mute"))
	s.mux.HandleFunc("POST /api/voice/webhook", s.voiceWebhook) // no login: LiveKit signs it
	s.voiceLockRoutes()
	go s.voiceCheck()
}

// voiceChanged tells every open page to reload its voice chats. The event carries nothing,
// so it can go to everyone; what each page then sees is filtered by GET /api/voice.
func (s *Server) voiceChanged() { s.bus.publish("voice", struct{}{}) }

func (s *Server) voiceList(w http.ResponseWriter, r *http.Request) {
	me := who(r).Name
	conf := s.voice.config()
	s.voice.mu.Lock()
	defer s.voice.mu.Unlock()
	s.voice.linkVoice(conf)
	out := []*voiceChat{}
	for _, vc := range s.voice.chats {
		if vc.sees(me) {
			if vc.Link {
				vc = s.linkView(vc, me)
			}
			out = append(out, vc)
		}
	}
	// (#voice-link's start is the zero time: first.)
	slices.SortFunc(out, func(a, b *voiceChat) int { return a.Started.Compare(b.Started) })
	// full counts every voice chat people started, including private ones this person can't see.
	resp := map[string]any{"enabled": conf != nil, "chats": out, "max": maxVoiceChats, "full": s.voice.started() >= maxVoiceChats}
	if conf != nil {
		resp["url"] = conf.URL
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) voiceStart(w http.ResponseWriter, r *http.Request) {
	if s.voice.config() == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "voice chats aren't set up"})
		return
	}
	var req struct {
		Private bool     `json:"private"`
		Invite  []string `json:"invite"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	me := who(r).Name
	vc := &voiceChat{Private: req.Private, Starter: me, People: []voicePerson{}, Started: time.Now().UTC()}
	if req.Private {
		invited, err := s.members(append(req.Invite, me))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		vc.Invited = invited
	}
	b := make([]byte, 6)
	rand.Read(b)
	vc.ID = "v" + hex.EncodeToString(b)
	s.voice.mu.Lock()
	// One empty voice chat per person: starting again takes over the one you started that
	// nobody has joined yet, so one person (or a script) can't hold every place.
	for id, old := range s.voice.chats {
		if old.Starter == me && len(old.People) == 0 {
			delete(s.voice.chats, id)
		}
	}
	if s.voice.started() >= maxVoiceChats {
		s.voice.save()
		s.voice.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]string{"error": fmt.Sprintf("There are already %d voice chats. Join one of them.", maxVoiceChats)})
		return
	}
	s.voice.chats[vc.ID] = vc
	s.voice.save()
	s.voice.mu.Unlock()
	s.unlock(me, "started another voice chat")
	s.voiceToken(w, vc.ID, me)
}

func (s *Server) voiceJoin(w http.ResponseWriter, r *http.Request) {
	id, me := r.PathValue("id"), who(r).Name
	conf := s.voice.config()
	s.voice.mu.Lock()
	s.voice.linkVoice(conf)
	vc, ok := s.voice.chats[id]
	ok = ok && vc.sees(me)
	s.voice.mu.Unlock()
	if !ok || s.voice.config() == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "That voice chat has ended."})
		return
	}
	if id != LinkVoiceID {
		s.unlock(me, "joined another voice chat")
		s.voiceToken(w, id, me)
		return
	}
	// #voice-link is one place with two ways in (voice_lock.go): while your player is in it in
	// game, there is nothing to join here. A join by hand turns the lock on once LiveKit says
	// you're in; the page's take-over and its fallback say {"lock": false}.
	var req struct {
		Lock *bool `json:"lock"`
	}
	if r.ContentLength != 0 {
		json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req)
	}
	s.voice.mu.Lock()
	_, game := s.whereIs(me)
	// (A join that doesn't lock, or is refused, drops an earlier one's that never got in.)
	if !game && (req.Lock == nil || *req.Lock) {
		s.voice.lockOnJoin[me] = time.Now()
	} else {
		delete(s.voice.lockOnJoin, me)
	}
	s.voice.mu.Unlock()
	if game {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "Your player is in voice-link in Minecraft."})
		return
	}
	s.voiceToken(w, id, me)
}

// voiceLeave takes someone off the list at once, rather than waiting for LiveKit's webhook
// (which also comes, and finds them gone already).
// Leaving #voice-link takes your lock off (leaving on purpose; a page stepping back for the
// game doesn't call this).
func (s *Server) voiceLeave(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("id") == LinkVoiceID {
		s.unlock(who(r).Name, "left in the hub")
	}
	s.voicePart(r.PathValue("id"), who(r).Name, false, time.Time{}, "")
	w.WriteHeader(http.StatusNoContent)
}

// voiceModerate is an admin acting on someone in a voice chat ({"name"}): "disconnect" drops
// them (they may rejoin); "mute" mutes their microphone for everyone, until they unmute
// themselves (Discord's server mute). Only on someone the admin outranks (the Admin page's
// rule), in a voice chat the admin can see. Recorded in the admin log.
func (s *Server) voiceModerate(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string `json:"name"`
		}
		if !readJSON(w, r, &req) {
			return
		}
		me := who(r)
		u, ok := s.users.Get(req.Name)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such user"})
			return
		}
		if me.rank() == 0 || me.rank() <= u.Rank() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can do that, and only to someone below them"})
			return
		}
		id := r.PathValue("id")
		s.voice.mu.Lock()
		vc, ok := s.voice.chats[id]
		in := ok && vc.sees(me.Name) && vc.has(req.Name)
		s.voice.mu.Unlock()
		if !in {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "they're not in that voice chat"})
			return
		}
		conf := s.voice.config()
		if conf == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "voice chats aren't set up"})
			return
		}
		var err error
		if action == "disconnect" {
			if _, err = conf.twirp("RemoveParticipant", id, map[string]string{"room": id, "identity": req.Name}); err == nil {
				if id == LinkVoiceID {
					s.unlock(req.Name, "disconnected by "+me.Name)
				}
				s.voicePart(id, req.Name, false, time.Time{}, "")
			}
		} else {
			err = conf.muteMic(id, req.Name)
		}
		if err != nil {
			log.Printf("voice: %s %s in %s: %v", action, req.Name, id, err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the voice server didn't do it"})
			return
		}
		s.users.Log(me.Name, "voice-"+action, req.Name)
		w.WriteHeader(http.StatusNoContent)
	}
}

// muteMic mutes someone's microphone track in a room, for everyone.
func (c *voiceConf) muteMic(room, identity string) error {
	b, err := c.twirp("GetParticipant", room, map[string]string{"room": room, "identity": identity})
	if err != nil {
		return err
	}
	if b == nil {
		return errors.New("not in the room")
	}
	var p struct {
		Tracks []struct {
			Sid  string `json:"sid"`
			Type string `json:"type"`
		} `json:"tracks"`
	}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	for _, t := range p.Tracks {
		if t.Type == "AUDIO" {
			_, err := c.twirp("MutePublishedTrack", room, map[string]any{"room": room, "identity": identity, "track_sid": t.Sid, "muted": true})
			return err
		}
	}
	return errors.New("no microphone track")
}

// voiceInvite adds people to a private voice chat; only its starter may.
func (s *Server) voiceInvite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Invite []string `json:"invite"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	names, err := s.members(req.Invite)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	me := who(r).Name
	s.voice.mu.Lock()
	vc, ok := s.voice.chats[r.PathValue("id")]
	switch {
	case !ok || !vc.sees(me):
		s.voice.mu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "That voice chat has ended."})
		return
	case !vc.Private || vc.Starter != me:
		s.voice.mu.Unlock()
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only the person who started a private voice chat can invite people."})
		return
	}
	for _, n := range names {
		if !slices.Contains(vc.Invited, n) {
			vc.Invited = append(vc.Invited, n)
		}
	}
	slices.Sort(vc.Invited)
	s.voice.save()
	s.voice.mu.Unlock()
	s.voiceChanged()
	w.WriteHeader(http.StatusNoContent)
}

// voicePart puts someone in a voice chat (in) or takes them out. Being in one voice chat
// takes you out of any other. A voice chat nobody is left in ends. sid is LiveKit's id for
// the session, when known: joining again (another tab) replaces it, and a leave for another
// session than the one listed changes nothing.
func (s *Server) voicePart(id, name string, in bool, since time.Time, sid string) {
	conf := s.voice.config()
	s.voice.mu.Lock()
	changed := s.voice.linkVoice(conf)
	// The bridge's own participants are #voice-link's alone. Its listener is not a person:
	// it being there is what "linked" means.
	if strings.HasPrefix(name, linkVoicePlayers) {
		vc := s.voice.chats[LinkVoiceID]
		switch {
		case vc == nil || !vc.Link || id != LinkVoiceID:
		case name == linkVoiceListen:
			changed = changed || vc.Linked != in
			vc.Linked = in
		case in && !vc.has(name):
			p := voicePersonFor(name, since)
			vc.People = append(vc.People, p)
			changed = true
			// The player arrived in game: the hand-over's cut has done its work.
			if acct, ok := s.users.ByMC(p.Show); ok {
				delete(s.voice.cut, acct)
			}
		case !in && vc.has(name):
			vc.People = slices.DeleteFunc(vc.People, func(p voicePerson) bool { return p.Name == name })
			changed = true
			// The player left the game: a take-over may join at once.
			if acct, ok := s.users.ByMC(voicePersonFor(name, time.Time{}).Show); ok {
				delete(s.voice.cut, acct)
			}
		}
		if changed {
			s.voice.save()
		}
		both := s.bothPlaces(time.Now())
		s.voice.mu.Unlock()
		if changed {
			s.voiceChanged()
		}
		s.cutForGame(both, "found in the hub and in game")
		return
	}
	lockedNow := false
	if id == LinkVoiceID && in {
		if t, ok := s.voice.lockOnJoin[name]; ok {
			delete(s.voice.lockOnJoin, name)
			if u, ok := s.users.Get(name); ok && u.MC != "" && time.Since(t) < time.Minute && !s.voice.locked(name) {
				s.voice.locks[name] = voiceLockEntry{mc: u.MC}
				s.voice.saveLocks()
				lockedNow = true
			}
		}
	}
	for cid, vc := range s.voice.chats {
		if cid == id && in {
			if i := slices.IndexFunc(vc.People, func(p voicePerson) bool { return p.Name == name }); i >= 0 {
				if sid != "" {
					vc.People[i].sid = sid
				}
			} else {
				vc.People = append(vc.People, voicePerson{Name: name, Since: since, sid: sid})
				changed = true
			}
			continue
		}
		if cid == id && !in && sid != "" && slices.ContainsFunc(vc.People, func(p voicePerson) bool { return p.Name == name && p.sid != "" && p.sid != sid }) {
			continue // (the leave of a session another one replaced)
		}
		if (cid == id || in) && vc.has(name) {
			vc.People = slices.DeleteFunc(vc.People, func(p voicePerson) bool { return p.Name == name })
			changed = true
			if len(vc.People) == 0 && !vc.Link {
				delete(s.voice.chats, cid)
			}
		}
	}
	if changed {
		s.voice.save()
	}
	var both []string
	if id == LinkVoiceID && in {
		both = s.bothPlaces(time.Now())
	}
	s.voice.mu.Unlock()
	if lockedNow {
		log.Printf("voice-link: %s locked (joined in the hub)", name)
	}
	if changed || lockedNow {
		s.voiceChanged()
	}
	s.cutForGame(both, "found in the hub and in game")
}

// ---- LiveKit ----------------------------------------------------------------------------

// sign makes a JWT the way LiveKit expects (HS256 with the API secret).
func (c *voiceConf) sign(claims map[string]any) string {
	enc := base64.RawURLEncoding
	head := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, _ := json.Marshal(claims)
	msg := head + "." + enc.EncodeToString(body)
	m := hmac.New(sha256.New, []byte(c.Secret))
	m.Write([]byte(msg))
	return msg + "." + enc.EncodeToString(m.Sum(nil))
}

// voiceToken answers with what the page needs to connect: LiveKit's address and a token
// for one voice chat as one person (their account name, so a second tab replaces the first).
func (s *Server) voiceToken(w http.ResponseWriter, id, name string) {
	conf := s.voice.config()
	if conf == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "voice chats aren't set up"})
		return
	}
	now := time.Now()
	claims := map[string]any{
		"iss": conf.Key, "sub": name, "name": name,
		"nbf": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(), // for joining; LiveKit renews it while connected
		"video": map[string]any{"room": id, "roomJoin": true, "canPublish": true, "canPublishSources": []string{"microphone"},
			"canSubscribe": true, "canPublishData": false},
	}
	// In #voice-link, the account's Minecraft name (an admin sets it) goes with them: the bridge
	// passes it to the game servers, which show them in game as that player, with that head.
	// (Not their lock: the game servers ask the hub for that, and nobody in the room sees it.)
	if id == LinkVoiceID {
		if u, ok := s.users.Get(name); ok && u.MC != "" {
			claims["attributes"] = map[string]string{"mc": u.MC}
		}
	}
	token := conf.sign(claims)
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "url": conf.URL, "token": token})
}

// voiceWebhook takes LiveKit's reports of people joining and leaving. Each is signed: a JWT
// in Authorization, made with the shared secret, carrying the body's SHA-256.
func (s *Server) voiceWebhook(w http.ResponseWriter, r *http.Request) {
	conf := s.voice.config()
	if conf == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil || !conf.signed(r.Header.Get("Authorization"), body) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "bad signature"})
		return
	}
	var ev struct {
		ID    string `json:"id"`
		Event string `json:"event"`
		Room  struct {
			Name string `json:"name"`
		} `json:"room"`
		Participant struct {
			Sid      string          `json:"sid"`
			Identity string          `json:"identity"`
			JoinedAt json.RawMessage `json:"joinedAt"`
		} `json:"participant"`
		Track struct {
			Source json.RawMessage `json:"source"`
		} `json:"track"`
	}
	if json.Unmarshal(body, &ev) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if s.voice.replayed(ev.ID) { // a signed webhook copied and sent again
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// LiveKit sends every room's webhooks here: a stream's go to stream.go. (Treated as a voice
	// chat, someone watching a stream would be taken out of the voice chat they're in.)
	if isStreamRoom(ev.Room.Name) {
		s.streamEvent(ev.Event, ev.Room.Name, ev.Participant.Identity, ev.Track.Source)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch ev.Event {
	case "participant_joined":
		s.voicePart(ev.Room.Name, ev.Participant.Identity, true, unixTime(ev.Participant.JoinedAt), ev.Participant.Sid)
	case "participant_left":
		s.voicePart(ev.Room.Name, ev.Participant.Identity, false, time.Time{}, ev.Participant.Sid)
	case "room_finished":
		// LiveKit closed the room (everyone gone): the voice chat is over. (#voice-link is
		// only empty.)
		s.voice.mu.Lock()
		vc, ok := s.voice.chats[ev.Room.Name]
		if ok && vc.Link {
			ok = len(vc.People) > 0 || vc.Linked
			vc.People, vc.Linked = []voicePerson{}, false
			if ok {
				s.voice.save()
			}
		} else if ok {
			delete(s.voice.chats, ev.Room.Name)
			s.voice.save()
		}
		s.voice.mu.Unlock()
		if ok {
			s.voiceChanged()
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (c *voiceConf) signed(auth string, body []byte) bool {
	parts := strings.Split(strings.TrimPrefix(auth, "Bearer "), ".")
	if len(parts) != 3 {
		return false
	}
	enc := base64.RawURLEncoding
	m := hmac.New(sha256.New, []byte(c.Secret))
	m.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := enc.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, m.Sum(nil)) {
		return false
	}
	var claims struct {
		Iss    string `json:"iss"`
		Exp    int64  `json:"exp"`
		Sha256 string `json:"sha256"`
	}
	raw, err := enc.DecodeString(parts[1])
	if err != nil || json.Unmarshal(raw, &claims) != nil {
		return false
	}
	sum := sha256.Sum256(body)
	return claims.Iss == c.Key && (claims.Exp == 0 || time.Now().Unix() < claims.Exp+60) &&
		claims.Sha256 == base64.StdEncoding.EncodeToString(sum[:])
}

// unixTime reads LiveKit's joinedAt (seconds, as a number or a string); now if missing.
func unixTime(raw json.RawMessage) time.Time {
	n, err := strconv.ParseInt(strings.Trim(string(raw), `"`), 10, 64)
	if err != nil || n == 0 {
		return time.Now().UTC()
	}
	return time.Unix(n, 0).UTC()
}

// voiceCheck compares the voice chats with who LiveKit says is connected, at start and every
// 20 seconds: a webhook can go missing (the tunnel down, the hub restarting), and a voice chat
// someone started but never connected to goes after a minute.
func (s *Server) voiceCheck() {
	for {
		s.voiceCheckOnce()
		time.Sleep(20 * time.Second)
	}
}

func (s *Server) voiceCheckOnce() {
	conf := s.voice.config()
	if conf == nil {
		return
	}
	s.voice.mu.Lock()
	if s.voice.linkVoice(conf) {
		defer s.voiceChanged()
	}
	ids := make([]string, 0, len(s.voice.chats))
	for id := range s.voice.chats {
		ids = append(ids, id)
	}
	s.voice.mu.Unlock()
	ok := true
	defer func() {
		s.voice.mu.Lock()
		s.voice.checked = ok
		s.voice.mu.Unlock()
	}()
	for _, id := range ids {
		people, err := conf.participants(id)
		if err != nil {
			log.Printf("voice: asking LiveKit about %s: %v", id, err)
			ok = false
			continue
		}
		// Banned or deleted (however it was done: the Admin page, ssh, users.json): out.
		// (The bridge's participants in #voice-link are not accounts, and stay.)
		people = slices.DeleteFunc(people, func(p voicePerson) bool {
			if id == LinkVoiceID && strings.HasPrefix(p.Name, linkVoicePlayers) {
				return false
			}
			if u, ok := s.users.Get(p.Name); ok && !u.Banned {
				return false
			}
			if _, err := conf.twirp("RemoveParticipant", id, map[string]string{"room": id, "identity": p.Name}); err != nil {
				log.Printf("voice: removing %s from %s: %v", p.Name, id, err)
				return false
			}
			log.Printf("voice: removed %s from %s (banned or deleted)", p.Name, id)
			return true
		})
		s.voiceSync(id, people)
	}
}

// voiceSync makes a voice chat's list match LiveKit's, keeping the order people joined in.
func (s *Server) voiceSync(id string, live []voicePerson) {
	s.voice.mu.Lock()
	vc, ok := s.voice.chats[id]
	if !ok {
		s.voice.mu.Unlock()
		return
	}
	before, _ := json.Marshal(vc)
	if vc.Link {
		// The bridge's listener is not a person: it being there is what "linked" means.
		vc.Linked = slices.ContainsFunc(live, func(l voicePerson) bool { return l.Name == linkVoiceListen })
		live = slices.DeleteFunc(slices.Clone(live), func(l voicePerson) bool { return l.Name == linkVoiceListen })
	}
	kept := slices.DeleteFunc(slices.Clone(vc.People), func(p voicePerson) bool {
		return !slices.ContainsFunc(live, func(l voicePerson) bool { return l.Name == p.Name })
	})
	for i, p := range kept {
		if j := slices.IndexFunc(live, func(l voicePerson) bool { return l.Name == p.Name }); live[j].sid != "" {
			kept[i].sid = live[j].sid
		}
	}
	for _, l := range live {
		if !slices.ContainsFunc(kept, func(p voicePerson) bool { return p.Name == l.Name }) {
			kept = append(kept, l)
		}
	}
	vc.People = kept
	after, _ := json.Marshal(vc)
	ended := len(vc.People) == 0 && time.Since(vc.Started) > voiceUnusedFor && !vc.Link
	if ended {
		delete(s.voice.chats, id)
	}
	changed := ended || !bytes.Equal(before, after)
	if changed {
		s.voice.save()
	}
	var both []string
	if vc.Link {
		both = s.bothPlaces(time.Now())
	}
	s.voice.mu.Unlock()
	if changed {
		s.voiceChanged()
	}
	s.cutForGame(both, "found in the hub and in game")
}

// twirp calls LiveKit's room API as an admin of room; a missing room is (nil, nil).
// Closing a room (DeleteRoom) also needs LiveKit's roomCreate permission.
func (c *voiceConf) twirp(method, room string, req any) ([]byte, error) {
	now := time.Now()
	grant := map[string]any{"room": room, "roomAdmin": true}
	if method == "DeleteRoom" {
		grant["roomCreate"] = true
	}
	token := c.sign(map[string]any{"iss": c.Key, "sub": "mthub", "nbf": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Minute).Unix(),
		"video": grant})
	body, _ := json.Marshal(req)
	r, _ := http.NewRequest("POST", strings.TrimRight(c.API, "/")+"/twirp/livekit.RoomService/"+method, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	client := http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(r)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New(resp.Status + ": " + strings.TrimSpace(string(b)))
	}
	return b, nil
}

// participants asks LiveKit who is in a room. (LiveKit answers a room that doesn't exist with
// an empty list, so a 404 here is a wrong address or a proxy: an error, not an empty room.)
func (c *voiceConf) participants(id string) ([]voicePerson, error) {
	b, err := c.twirp("ListParticipants", id, map[string]string{"room": id})
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, errors.New("404 for ListParticipants")
	}
	var out struct {
		Participants []struct {
			Sid      string          `json:"sid"`
			Identity string          `json:"identity"`
			JoinedAt json.RawMessage `json:"joinedAt"`
			JoinedA2 json.RawMessage `json:"joined_at"`
		} `json:"participants"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	people := []voicePerson{}
	for _, p := range out.Participants {
		at := p.JoinedAt
		if at == nil {
			at = p.JoinedA2
		}
		person := voicePersonFor(p.Identity, unixTime(at))
		person.sid = p.Sid
		people = append(people, person)
	}
	slices.SortStableFunc(people, func(a, b voicePerson) int { return a.Since.Compare(b.Since) })
	return people, nil
}

// replayed says whether a webhook with this id came in the last 10 minutes (signatures last
// a minute or so, so that's long enough), and notes it.
func (v *voice) replayed(id string) bool {
	if id == "" {
		return false
	}
	v.seenMu.Lock()
	defer v.seenMu.Unlock()
	if v.seen == nil {
		v.seen = map[string]time.Time{}
	}
	for k, t := range v.seen {
		if time.Since(t) > 10*time.Minute {
			delete(v.seen, k)
		}
	}
	if _, ok := v.seen[id]; ok {
		return true
	}
	v.seen[id] = time.Now()
	return false
}
