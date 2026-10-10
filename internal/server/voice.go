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

// maxVoiceChats is how many voice chats may exist at once (Paul).
const maxVoiceChats = 3

// An unused voice chat (started, but nobody connected) goes after this long.
const voiceUnusedFor = time.Minute

type voiceConf struct {
	URL    string `json:"url"` // what browsers connect to (wss://)
	API    string `json:"api"` // where the hub calls LiveKit's API (https://)
	Key    string `json:"key"`
	Secret string `json:"secret"`
}

type voicePerson struct {
	Name  string    `json:"name"`
	Since time.Time `json:"since"`
}

type voiceChat struct {
	ID      string        `json:"id"`
	Private bool          `json:"private,omitempty"`
	Starter string        `json:"starter"`
	Invited []string      `json:"invited,omitempty"` // private only; the starter is included
	People  []voicePerson `json:"people"`            // in the order they joined
	Started time.Time     `json:"started"`
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
}

func loadVoice(dir string) *voice {
	v := &voice{confFile: filepath.Join(dir, "voice.json"), file: filepath.Join(dir, "voice-chats.json"), chats: map[string]*voiceChat{}}
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
	go s.voiceCheck()
}

// voiceChanged tells every open page to reload its voice chats. The event carries nothing,
// so it can go to everyone; what each page then sees is filtered by GET /api/voice.
func (s *Server) voiceChanged() { s.bus.publish("voice", struct{}{}) }

func (s *Server) voiceList(w http.ResponseWriter, r *http.Request) {
	me := who(r).Name
	s.voice.mu.Lock()
	defer s.voice.mu.Unlock()
	out := []*voiceChat{}
	for _, vc := range s.voice.chats {
		if vc.sees(me) {
			out = append(out, vc)
		}
	}
	slices.SortFunc(out, func(a, b *voiceChat) int { return a.Started.Compare(b.Started) })
	conf := s.voice.config()
	// full counts every voice chat, including private ones this person can't see.
	resp := map[string]any{"enabled": conf != nil, "chats": out, "max": maxVoiceChats, "full": len(s.voice.chats) >= maxVoiceChats}
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
	if len(s.voice.chats) >= maxVoiceChats {
		s.voice.save()
		s.voice.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]string{"error": fmt.Sprintf("There are already %d voice chats. Join one of them.", maxVoiceChats)})
		return
	}
	s.voice.chats[vc.ID] = vc
	s.voice.save()
	s.voice.mu.Unlock()
	s.voiceToken(w, vc.ID, me)
}

func (s *Server) voiceJoin(w http.ResponseWriter, r *http.Request) {
	id, me := r.PathValue("id"), who(r).Name
	s.voice.mu.Lock()
	vc, ok := s.voice.chats[id]
	ok = ok && vc.sees(me)
	s.voice.mu.Unlock()
	if !ok || s.voice.config() == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "That voice chat has ended."})
		return
	}
	s.voiceToken(w, id, me)
}

// voiceLeave takes someone off the list at once, rather than waiting for LiveKit's webhook
// (which also comes, and finds them gone already).
func (s *Server) voiceLeave(w http.ResponseWriter, r *http.Request) {
	s.voicePart(r.PathValue("id"), who(r).Name, false, time.Time{})
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
				s.voicePart(id, req.Name, false, time.Time{})
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
// takes you out of any other. A voice chat nobody is left in ends.
func (s *Server) voicePart(id, name string, in bool, since time.Time) {
	s.voice.mu.Lock()
	changed := false
	for cid, vc := range s.voice.chats {
		if cid == id && in {
			if !vc.has(name) {
				vc.People = append(vc.People, voicePerson{name, since})
				changed = true
			}
			continue
		}
		if (cid == id || in) && vc.has(name) {
			vc.People = slices.DeleteFunc(vc.People, func(p voicePerson) bool { return p.Name == name })
			changed = true
			if len(vc.People) == 0 {
				delete(s.voice.chats, cid)
			}
		}
	}
	if changed {
		s.voice.save()
	}
	s.voice.mu.Unlock()
	if changed {
		s.voiceChanged()
	}
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
	token := conf.sign(map[string]any{
		"iss": conf.Key, "sub": name, "name": name,
		"nbf": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(), // for joining; LiveKit renews it while connected
		"video": map[string]any{"room": id, "roomJoin": true, "canPublish": true, "canPublishSources": []string{"microphone"},
			"canSubscribe": true, "canPublishData": false},
	})
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
		s.voicePart(ev.Room.Name, ev.Participant.Identity, true, unixTime(ev.Participant.JoinedAt))
	case "participant_left":
		s.voicePart(ev.Room.Name, ev.Participant.Identity, false, time.Time{})
	case "room_finished":
		// LiveKit closed the room (everyone gone): the voice chat is over.
		s.voice.mu.Lock()
		_, ok := s.voice.chats[ev.Room.Name]
		if ok {
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

// voiceCheck compares the voice chats with who LiveKit says is connected, every 20 seconds:
// a webhook can go missing (the tunnel down, the hub restarting), and a voice chat someone
// started but never connected to goes after a minute.
func (s *Server) voiceCheck() {
	for {
		time.Sleep(20 * time.Second)
		s.voiceCheckOnce()
	}
}

func (s *Server) voiceCheckOnce() {
	conf := s.voice.config()
	if conf == nil {
		return
	}
	s.voice.mu.Lock()
	ids := make([]string, 0, len(s.voice.chats))
	for id := range s.voice.chats {
		ids = append(ids, id)
	}
	s.voice.mu.Unlock()
	for _, id := range ids {
		people, err := conf.participants(id)
		if err != nil {
			log.Printf("voice: asking LiveKit about %s: %v", id, err)
			continue
		}
		// Banned or deleted (however it was done: the Admin page, ssh, users.json): out.
		people = slices.DeleteFunc(people, func(p voicePerson) bool {
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
	before, _ := json.Marshal(vc.People)
	kept := slices.DeleteFunc(slices.Clone(vc.People), func(p voicePerson) bool {
		return !slices.ContainsFunc(live, func(l voicePerson) bool { return l.Name == p.Name })
	})
	for _, l := range live {
		if !slices.ContainsFunc(kept, func(p voicePerson) bool { return p.Name == l.Name }) {
			kept = append(kept, l)
		}
	}
	vc.People = kept
	after, _ := json.Marshal(vc.People)
	ended := len(vc.People) == 0 && time.Since(vc.Started) > voiceUnusedFor
	if ended {
		delete(s.voice.chats, id)
	}
	changed := ended || !bytes.Equal(before, after)
	if changed {
		s.voice.save()
	}
	s.voice.mu.Unlock()
	if changed {
		s.voiceChanged()
	}
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

// participants asks LiveKit who is in a room (an empty list if the room doesn't exist).
func (c *voiceConf) participants(id string) ([]voicePerson, error) {
	b, err := c.twirp("ListParticipants", id, map[string]string{"room": id})
	if err != nil || b == nil {
		return nil, err
	}
	var out struct {
		Participants []struct {
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
		people = append(people, voicePerson{p.Identity, unixTime(at)})
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
