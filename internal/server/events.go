package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// broker fans live events out to every open page over Server-Sent Events: a long-lived
// GET that the browser's EventSource keeps open and reconnects by itself.
type broker struct {
	mu   sync.Mutex
	subs map[chan []byte]*sub
}

// sub is one open page: whose it is, and a channel closed to cut it off.
type sub struct {
	user string
	kick chan struct{}
}

func newBroker() *broker { return &broker{subs: map[chan []byte]*sub{}} }

// kick ends every open stream of a user (banned, deleted, or given a new password). Their
// page sees the stream drop, finds the session gone, and goes back to the login form.
func (b *broker) kick(user string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch, sb := range b.subs {
		if sb.user == user {
			close(sb.kick)
			delete(b.subs, ch)
		}
	}
}

// publish sends an event to every subscriber. A page too slow to keep up misses it;
// on reconnect the page reloads what it shows.
func (b *broker) publish(typ string, v any) { b.publishIf(typ, v, nil) }

// publishIf sends an event to the subscribers whose user to approves (nil: everyone), so a
// private chat's messages only reach its members.
func (b *broker) publishIf(typ string, v any, to func(user string) bool) {
	data, _ := json.Marshal(v)
	msg := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", typ, data))
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch, sb := range b.subs {
		if to != nil && !to(sb.user) {
			continue
		}
		select {
		case ch <- msg:
		default:
		}
	}
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // in case a proxy sits in front later

	ch := make(chan []byte, 64)
	me := &sub{user: who(r).Name, kick: make(chan struct{})}
	s.bus.mu.Lock()
	s.bus.subs[ch] = me
	s.bus.mu.Unlock()
	defer func() {
		s.bus.mu.Lock()
		delete(s.bus.subs, ch)
		s.bus.mu.Unlock()
	}()

	fmt.Fprint(w, ": hello\n\n")
	flusher.Flush()
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-me.kick:
			end(w, flusher)
			return
		case msg := <-ch:
			w.Write(msg)
			flusher.Flush()
		case <-keepalive.C:
			// The session can also end outside the page (users.json edited, mthub user
			// -banned): check it again now and then.
			if !s.stillIn(r) {
				end(w, flusher)
				return
			}
			s.users.Touch(me.user)
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// end tells the page its session ended before the stream closes, so it reloads at once
// rather than after the browser's reconnect delay (a few seconds).
func end(w http.ResponseWriter, f http.Flusher) {
	fmt.Fprint(w, "event: ended\ndata: {}\n\n")
	f.Flush()
}

// stillIn: the request's session is still good and its user not banned.
func (s *Server) stillIn(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	_, u, ok := s.users.Check(c.Value)
	return ok && !u.Banned
}

// watchFiles announces any change to the file tree: saves through the page, and also
// edits and rsyncs over ssh, which nothing else would tell the pages about. Listing the
// tree is also what commits direct edits (see workspace.syncDisk).
func (s *Server) watchFiles() {
	var last [32]byte
	for range time.Tick(3 * time.Second) {
		entries, err := s.ws.Tree()
		if err != nil {
			continue
		}
		data, _ := json.Marshal(entries)
		if sum := sha256.Sum256(data); sum != last {
			last = sum
			s.bus.publish("files", struct{}{})
		}
	}
}
