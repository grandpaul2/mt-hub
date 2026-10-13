package server

// Stream tags: a short line someone sharing their screen or streaming puts under their name in
// LIVE, saying what the stream is ("ghast farm, phase 2"). One per person, for whatever they
// have live; kept in memory only. It goes when their stream ends: a minute after, since a
// stream that drops for a moment comes back as the same stream.

import (
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	tagMax  = 40          // characters
	tagKeep = time.Minute // after the person is no longer live
)

type liveTag struct {
	text string
	gone time.Time // when they were first seen not live; zero while they are
}

type liveTags struct {
	mu  sync.Mutex
	all map[string]*liveTag
}

// cleanTag is a tag as kept: one line, single spaces. ok is false for one that is too long.
func cleanTag(text string) (string, bool) {
	text = strings.Join(strings.Fields(text), " ")
	return text, utf8.RuneCountInString(text) <= tagMax
}

func (lt *liveTags) set(name, text string) {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	if text == "" {
		delete(lt.all, name)
		return
	}
	if lt.all == nil {
		lt.all = map[string]*liveTag{}
	}
	lt.all[name] = &liveTag{text: text}
}

// sweep drops the tags of people whose stream ended more than tagKeep ago, and returns the
// tags of the people who are live.
func (lt *liveTags) sweep(live map[string]bool, now time.Time) map[string]string {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	out := map[string]string{}
	for name, t := range lt.all {
		switch {
		case live[name]:
			t.gone = time.Time{}
			out[name] = t.text
		case t.gone.IsZero():
			t.gone = now
		case now.Sub(t.gone) > tagKeep:
			delete(lt.all, name)
		}
	}
	return out
}

// liveNow is everyone with something in LIVE: a shared screen that shows, or a relay stream.
func (s *Server) liveNow() map[string]bool {
	live := map[string]bool{}
	s.streams.mu.Lock()
	for _, x := range s.streams.all {
		if x.Live {
			live[x.Name] = true
		}
	}
	s.streams.mu.Unlock()
	s.relay.mu.Lock()
	for _, x := range s.relay.live {
		live[x.Name] = true
	}
	s.relay.mu.Unlock()
	return live
}

// tagSweep keeps tags from outliving their streams while no page is asking for the list.
func (s *Server) tagSweep() {
	for {
		time.Sleep(15 * time.Second)
		s.tags.sweep(s.liveNow(), time.Now())
	}
}

// streamTag: {"tag"} sets the tag under your name in LIVE while you share or stream ("" takes
// it away). An admin may take away someone else's, not set it.
func (s *Server) streamTag(w http.ResponseWriter, r *http.Request) {
	var req struct{ Tag string }
	if !readJSON(w, r, &req) {
		return
	}
	me, name := who(r), r.PathValue("name")
	tag, ok := cleanTag(req.Tag)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "A tag is 40 characters at most."})
		return
	}
	if name != me.Name && (me.rank() == 0 || tag != "") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "That is someone else’s tag."})
		return
	}
	if tag != "" && !s.liveNow()[name] {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "You aren’t sharing or streaming."})
		return
	}
	s.tags.set(name, tag)
	s.streamChanged()
	writeJSON(w, http.StatusOK, map[string]string{"tag": tag})
}
