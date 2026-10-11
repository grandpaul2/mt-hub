package server

// Screen sharing (agreed design: docs/stream/screen-share-spec.md).
// Anyone can share a window or their screen, video only; while they do, LIVE in the sidebar
// lists them and anyone can watch. It ends when they stop, close the shared window, close
// the page or drop off.
//
// It runs on the same LiveKit as voice chats (voice.json, voiceConf): each stream is its own
// room ("s…"), the streamer may publish only a screen share, viewers may only watch. LiveKit's
// webhooks come in at /api/voice/webhook and are handed over here by room name; every 20
// seconds the hub also asks LiveKit, in case one went missing. Streams are kept in
// streams.json so a hub restart doesn't end them.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// maxStreams is how many people may share at once (the relay's bandwidth).
const maxStreams = 3

// A stream that never shows a picture (the person never got past connecting) goes after this.
const streamUnusedFor = time.Minute

type stream struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"` // who's sharing
	Started time.Time `json:"started"`
	Live    bool      `json:"live"`    // a picture is coming (until then it isn't listed)
	Viewers []string  `json:"viewers"` // who's watching, in the order they came
}

type streams struct {
	file string
	mu   sync.Mutex
	all  map[string]*stream
}

func loadStreams(dir string) *streams {
	st := &streams{file: filepath.Join(dir, "streams.json"), all: map[string]*stream{}}
	if b, err := os.ReadFile(st.file); err == nil {
		var list []*stream
		if json.Unmarshal(b, &list) == nil {
			for _, x := range list {
				st.all[x.ID] = x
			}
		}
	}
	return st
}

// save writes the streams out; called with mu held.
func (st *streams) save() {
	list := make([]*stream, 0, len(st.all))
	for _, x := range st.all {
		list = append(list, x)
	}
	b, _ := json.Marshal(list)
	tmp := st.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err == nil {
		os.Rename(tmp, st.file)
	}
}

// isStreamRoom says whether a LiveKit room is a stream's (voice chats' rooms start with "v").
func isStreamRoom(room string) bool { return strings.HasPrefix(room, "s") }

// viewerName is the account behind a viewer's LiveKit identity ("name~tab"); "" for anyone
// else (the streamer).
func viewerName(identity string) string {
	name, _, ok := strings.Cut(identity, "~")
	if !ok {
		return ""
	}
	return name
}

func (s *Server) streamRoutes() {
	s.mux.HandleFunc("GET /api/streams", s.streamList)
	s.mux.HandleFunc("POST /api/streams", s.streamStart)
	s.mux.HandleFunc("POST /api/streams/{id}/watch", s.streamWatch)
	s.mux.HandleFunc("POST /api/streams/{id}/stop", s.streamStop)
	go s.streamCheck()
}

// streamChanged tells every open page to reload the streams.
func (s *Server) streamChanged() { s.bus.publish("stream", struct{}{}) }

func (s *Server) streamList(w http.ResponseWriter, r *http.Request) {
	relayed, delay := s.relayList() // streams sent to the stream relay with OBS (relay.go)
	s.streams.mu.Lock()
	defer s.streams.mu.Unlock()
	out := []*stream{}
	for _, x := range s.streams.all {
		if x.Live {
			out = append(out, x)
		}
	}
	slices.SortFunc(out, func(a, b *stream) int { return a.Started.Compare(b.Started) })
	resp := map[string]any{"enabled": s.voice.config() != nil, "streams": out, "max": maxStreams, "full": s.streamsFull(who(r).Name)}
	resp["relay"], resp["relayDelay"] = relayed, delay
	writeJSON(w, http.StatusOK, resp)
}

// streamsFull says whether there's no room for this person to start sharing (their own
// stream doesn't count: starting again replaces it). Called with mu held.
func (s *Server) streamsFull(name string) bool {
	n := 0
	for _, x := range s.streams.all {
		if x.Name != name {
			n++
		}
	}
	return n >= maxStreams
}

// streamStart starts your stream; one you already have (another tab, a reload) is ended.
func (s *Server) streamStart(w http.ResponseWriter, r *http.Request) {
	conf := s.voice.config()
	if conf == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "screen sharing isn't set up"})
		return
	}
	me := who(r).Name
	b := make([]byte, 6)
	rand.Read(b)
	x := &stream{ID: "s" + hex.EncodeToString(b), Name: me, Started: time.Now().UTC(), Viewers: []string{}}
	s.streams.mu.Lock()
	if s.streamsFull(me) {
		s.streams.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]string{"error": fmt.Sprintf("%d people are already sharing their screens. Try again when one stops.", maxStreams)})
		return
	}
	var old []string
	for id, o := range s.streams.all {
		if o.Name == me {
			old = append(old, id)
			delete(s.streams.all, id)
		}
	}
	s.streams.all[x.ID] = x
	s.streams.save()
	s.streams.mu.Unlock()
	for _, id := range old {
		go closeRoom(conf, id)
	}
	if len(old) > 0 {
		s.streamChanged()
	}
	now := time.Now()
	token := conf.sign(map[string]any{
		"iss": conf.Key, "sub": me, "name": me,
		"nbf": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(),
		"video": map[string]any{"room": x.ID, "roomJoin": true, "canPublish": true, "canPublishSources": []string{"screen_share"},
			"canSubscribe": false, "canPublishData": false},
	})
	writeJSON(w, http.StatusOK, map[string]string{"id": x.ID, "url": conf.URL, "token": token})
}

// streamWatch hands out a token for watching. Each viewer is their own connection
// ("name~tab"), so someone can watch in two tabs, or watch their own stream.
func (s *Server) streamWatch(w http.ResponseWriter, r *http.Request) {
	id, me := r.PathValue("id"), who(r).Name
	s.streams.mu.Lock()
	_, ok := s.streams.all[id]
	s.streams.mu.Unlock()
	conf := s.voice.config()
	if !ok || conf == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "That stream has ended."})
		return
	}
	b := make([]byte, 3)
	rand.Read(b)
	now := time.Now()
	token := conf.sign(map[string]any{
		"iss": conf.Key, "sub": me + "~" + hex.EncodeToString(b), "name": me,
		"nbf": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(),
		"video": map[string]any{"room": id, "roomJoin": true, "canPublish": false, "canSubscribe": true, "canPublishData": false},
	})
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "url": conf.URL, "token": token})
}

// streamStop ends a stream: the streamer's own, or anyone's by an admin who outranks them
// (recorded in the admin log).
func (s *Server) streamStop(w http.ResponseWriter, r *http.Request) {
	id, me := r.PathValue("id"), who(r)
	s.streams.mu.Lock()
	x, ok := s.streams.all[id]
	s.streams.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNoContent) // already over
		return
	}
	if x.Name != me.Name {
		u, found := s.users.Get(x.Name)
		if me.rank() == 0 || (found && me.rank() <= u.Rank()) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can do that, and only to someone below them"})
			return
		}
		s.users.Log(me.Name, "stream-stop", x.Name)
	}
	s.streamEnd(id, true)
	w.WriteHeader(http.StatusNoContent)
}

// streamEnd takes a stream off the list; closing also closes its LiveKit room, which
// disconnects the streamer and everyone watching.
func (s *Server) streamEnd(id string, closing bool) {
	s.streams.mu.Lock()
	_, ok := s.streams.all[id]
	if ok {
		delete(s.streams.all, id)
		s.streams.save()
	}
	s.streams.mu.Unlock()
	if closing {
		if conf := s.voice.config(); conf != nil {
			go closeRoom(conf, id)
		}
	}
	if ok {
		s.streamChanged()
	}
}

func closeRoom(conf *voiceConf, id string) {
	if _, err := conf.twirp("DeleteRoom", id, map[string]string{"room": id}); err != nil {
		log.Printf("stream: closing %s: %v", id, err)
	}
}

// isScreen says whether a LiveKit track source (a name or its number) is a screen share.
func isScreen(source json.RawMessage) bool {
	v := strings.Trim(string(source), `"`)
	return v == "SCREEN_SHARE" || v == "3"
}

// streamEvent takes one of LiveKit's webhooks for a stream's room (voiceWebhook checked the
// signature).
func (s *Server) streamEvent(event, room, identity string, source json.RawMessage) {
	s.streams.mu.Lock()
	x, ok := s.streams.all[room]
	if !ok {
		s.streams.mu.Unlock()
		return
	}
	streamer := identity == x.Name
	viewer := viewerName(identity)
	changed, end := false, false
	switch event {
	case "track_published":
		if streamer && isScreen(source) && !x.Live {
			x.Live, changed = true, true
		}
	case "track_unpublished":
		end = streamer && isScreen(source)
	case "participant_joined":
		if viewer != "" && !slices.Contains(x.Viewers, viewer) {
			x.Viewers = append(x.Viewers, viewer)
			changed = true
		}
	case "participant_left":
		end = streamer
		if viewer != "" && slices.Contains(x.Viewers, viewer) {
			// Someone watching in two tabs is still watching until the 20-second check says not.
			x.Viewers = slices.DeleteFunc(x.Viewers, func(n string) bool { return n == viewer })
			changed = true
		}
	case "room_finished":
		end = true
	}
	if changed {
		s.streams.save()
	}
	s.streams.mu.Unlock()
	if end {
		s.streamEnd(room, true)
	} else if changed {
		s.streamChanged()
	}
}

// streamCheck compares the streams with LiveKit every 20 seconds: a webhook can go missing
// (the tunnel down, the hub restarting). It also ends a stream nobody ever got a picture
// from, and removes anyone banned or deleted since.
func (s *Server) streamCheck() {
	for {
		time.Sleep(20 * time.Second)
		s.streamCheckOnce()
	}
}

func (s *Server) streamCheckOnce() {
	conf := s.voice.config()
	if conf == nil {
		return
	}
	s.streams.mu.Lock()
	ids := make([]string, 0, len(s.streams.all))
	for id := range s.streams.all {
		ids = append(ids, id)
	}
	s.streams.mu.Unlock()
	for _, id := range ids {
		b, err := conf.twirp("ListParticipants", id, map[string]string{"room": id})
		if err != nil {
			log.Printf("stream: asking LiveKit about %s: %v", id, err)
			continue
		}
		var out struct {
			Participants []struct {
				Identity string `json:"identity"`
				Tracks   []struct {
					Source json.RawMessage `json:"source"`
				} `json:"tracks"`
			} `json:"participants"`
		}
		if b != nil && json.Unmarshal(b, &out) != nil {
			continue
		}
		s.streams.mu.Lock()
		x, ok := s.streams.all[id]
		if !ok {
			s.streams.mu.Unlock()
			continue
		}
		name, started, wasLive := x.Name, x.Started, x.Live
		s.streams.mu.Unlock()
		allowed := func(n string) bool { u, ok := s.users.Get(n); return ok && !u.Banned }
		present, sharing := false, false
		viewers := []string{}
		for _, p := range out.Participants {
			if p.Identity == name {
				present = true
				sharing = slices.ContainsFunc(p.Tracks, func(t struct {
					Source json.RawMessage `json:"source"`
				}) bool {
					return isScreen(t.Source)
				})
				continue
			}
			v := viewerName(p.Identity)
			if v == "" {
				continue
			}
			if !allowed(v) {
				if _, err := conf.twirp("RemoveParticipant", id, map[string]string{"room": id, "identity": p.Identity}); err == nil {
					log.Printf("stream: removed %s from %s (banned or deleted)", v, id)
				}
				continue
			}
			if !slices.Contains(viewers, v) {
				viewers = append(viewers, v)
			}
		}
		young := time.Since(started) < streamUnusedFor
		switch {
		case !allowed(name):
			log.Printf("stream: ended %s's stream (banned or deleted)", name)
			s.streamEnd(id, true)
			continue
		case (!present || !sharing) && (wasLive || !young):
			s.streamEnd(id, true)
			continue
		}
		s.streams.mu.Lock()
		x, ok = s.streams.all[id]
		changed := false
		if ok {
			if sharing && !x.Live {
				x.Live, changed = true, true
			}
			// Keep the order people came in; add anyone the webhooks missed.
			kept := slices.DeleteFunc(slices.Clone(x.Viewers), func(n string) bool { return !slices.Contains(viewers, n) })
			for _, v := range viewers {
				if !slices.Contains(kept, v) {
					kept = append(kept, v)
				}
			}
			if !slices.Equal(kept, x.Viewers) {
				x.Viewers, changed = kept, true
			}
			if changed {
				s.streams.save()
			}
		}
		s.streams.mu.Unlock()
		if changed {
			s.streamChanged()
		}
	}
}
