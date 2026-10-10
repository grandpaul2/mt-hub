// voicelink joins the Simple Voice Chat "Link" groups of our game servers. Each server's MT Hub
// Server connects with its own token and sends its Link players' voice packets; voicelink passes
// them, untouched, to the other servers. It never decodes or changes audio.
//
//	voicelink [-addr A] [-config C]
//
// Config (JSON): {"tokens": {"<token>": "survival", "<token>": "creative"}}
//
// Messages are binary WebSocket frames; the first byte is the type.
//
//	server → relay   1 audio    speaker uuid (16 bytes) + Opus bytes (empty = stopped talking)
//	                 2 roster   JSON {"members":[{"uuid","name"}]}, the full list on every change
//	relay → server   1 audio    name length (1 byte) + source server name + the audio body above
//	                 2 roster   name length (1 byte) + source server name + the roster JSON above
//	                 3 status   JSON {"servers":["creative","survival"],"you":"survival"}: who is connected now
//
// The spec is docs/voice/svc/link-spec.md.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	msgAudio  = 1
	msgRoster = 2
	msgStatus = 3

	// Opus packets from SVC are at most 1275 bytes; rosters are small.
	maxMessage = 64 << 10
	// Frames waiting for a slow server; past this its audio is dropped, not queued.
	queueLen     = 256
	pingEvery    = 20 * time.Second
	writeTimeout = 10 * time.Second
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7890", "listen address")
	config := flag.String("config", "/etc/voicelink.json", "config file")
	flag.Parse()

	tokens, err := loadTokens(*config)
	if err != nil {
		log.Fatal(err)
	}
	r := newRelay(tokens)
	mux := http.NewServeMux()
	mux.Handle("/voicelink", r)
	log.Printf("voicelink on %s, %d servers", *addr, len(tokens))
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func loadTokens(path string) (map[string]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c struct {
		Tokens map[string]string `json:"tokens"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if len(c.Tokens) == 0 {
		return nil, errors.New(path + ": no tokens")
	}
	for tok, name := range c.Tokens {
		if len(tok) < 32 || name == "" || len(name) > 32 {
			return nil, errors.New(path + ": tokens need 32+ characters and a server name of 1-32")
		}
	}
	return c.Tokens, nil
}

type relay struct {
	tokens map[string]string

	mu      sync.Mutex
	conns   map[string]*conn  // by server name; a reconnect replaces the old one
	rosters map[string][]byte // last roster message sent on to others, by server name
}

type conn struct {
	name string
	out  chan []byte
	done chan struct{}
	once sync.Once
}

func (c *conn) close() {
	c.once.Do(func() { close(c.done) })
}

func newRelay(tokens map[string]string) *relay {
	return &relay{tokens: tokens, conns: map[string]*conn{}, rosters: map[string][]byte{}}
}

// server returns the server name for the request's token, or "".
func (r *relay) server(req *http.Request) string {
	tok, ok := strings.CutPrefix(req.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	name := ""
	for t, n := range r.tokens {
		if subtle.ConstantTimeCompare([]byte(t), []byte(tok)) == 1 {
			name = n
		}
	}
	return name
}

func (r *relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	name := r.server(req)
	if name == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ws, err := websocket.Accept(w, req, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(maxMessage)
	c := &conn{name: name, out: make(chan []byte, queueLen), done: make(chan struct{})}
	r.join(c)
	log.Printf("%s connected from %s", name, req.Header.Get("X-Forwarded-For"))

	ctx, cancel := context.WithCancel(req.Context())
	go func() {
		r.write(ctx, ws, c)
		cancel()
	}()
	err = r.read(ctx, ws, c)
	cancel()
	c.close()
	r.leave(c)
	ws.CloseNow()
	log.Printf("%s disconnected: %v", name, err)
}

func (r *relay) read(ctx context.Context, ws *websocket.Conn, c *conn) error {
	for {
		typ, b, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageBinary || len(b) == 0 {
			continue
		}
		switch b[0] {
		case msgAudio:
			if len(b) >= 17 {
				r.forward(c, msgAudio, b[1:], false)
			}
		case msgRoster:
			r.forward(c, msgRoster, b[1:], true)
		}
	}
}

func (r *relay) write(ctx context.Context, ws *websocket.Conn, c *conn) {
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.done:
			ws.Close(websocket.StatusGoingAway, "replaced")
			return
		case b := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := ws.Write(wctx, websocket.MessageBinary, b)
			cancel()
			if err != nil {
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := ws.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// tagged is typ + source name + body, as the other servers receive it.
func tagged(typ byte, name string, body []byte) []byte {
	b := make([]byte, 0, 2+len(name)+len(body))
	b = append(b, typ, byte(len(name)))
	b = append(b, name...)
	return append(b, body...)
}

// forward sends a message from c to every other server. Control messages (keep) are also
// remembered for servers that connect later; a server too slow to take one is disconnected.
// Audio for a slow server is dropped instead.
func (r *relay) forward(from *conn, typ byte, body []byte, keep bool) {
	msg := tagged(typ, from.name, body)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conns[from.name] != from {
		return // replaced by a newer connection
	}
	if keep {
		r.rosters[from.name] = msg
	}
	for name, c := range r.conns {
		if name != from.name {
			r.send(c, msg, keep)
		}
	}
}

// send queues msg for c. Callers hold r.mu.
func (r *relay) send(c *conn, msg []byte, control bool) {
	select {
	case c.out <- msg:
	default:
		if control {
			c.close()
		}
	}
}

func (r *relay) join(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old := r.conns[c.name]; old != nil {
		old.close()
	}
	r.conns[c.name] = c
	delete(r.rosters, c.name)
	for name, roster := range r.rosters {
		if name != c.name {
			r.send(c, roster, true)
		}
	}
	r.status()
}

func (r *relay) leave(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conns[c.name] != c {
		return
	}
	delete(r.conns, c.name)
	delete(r.rosters, c.name)
	r.status()
}

// status tells every server who is connected. Callers hold r.mu.
func (r *relay) status() {
	names := make([]string, 0, len(r.conns))
	for name := range r.conns {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, c := range r.conns {
		body, _ := json.Marshal(map[string]any{"servers": names, "you": c.name})
		r.send(c, append([]byte{msgStatus}, body...), true)
	}
}
