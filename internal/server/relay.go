package server

// Relay streams (agreed design: docs/stream/relay-streams-spec.md).
// A stream someone sends to the stream relay with OBS, the kind a video screen in the game
// plays, can be watched in the hub too, with sound. The relay (MediaMTX) republishes each
// channel as "<channel>-web" for browsers and serves it over WebRTC (WHEP).
//
// The hub never carries the picture. Every 5 seconds it asks the relay which channels are
// live and who is reading them; and it passes each viewer's WebRTC offer on to the relay
// with the hub's own relay account, which is how watching needs a hub login and how the hub
// knows who is watching. relay.json in the data directory holds the relay's address, the
// account and whose channel is whose; without it there are no relay streams.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	relayEvery = 5 * time.Second
	// A viewer's session the relay doesn't list yet (still connecting) is kept this long.
	relayPending = 30 * time.Second
	// relayDelayDefault is how long the page holds a relay stream back so it shows the same
	// moment as the game's screens (measured: the game's player is about 0.7 s behind).
	relayDelayDefault = 700
	maxSDP            = 64 << 10
)

// relayConf is relay.json.
type relayConf struct {
	URL      string            `json:"url"`  // where the relay's WHEP is: <url>/<channel>-web/whep
	API      string            `json:"api"`  // the relay's API; <url>/api when empty
	User     string            `json:"user"` // the hub's account on the relay
	Pass     string            `json:"pass"`
	Channels map[string]string `json:"channels"` // relay channel -> the hub account streaming on it
	DelayMS  *int              `json:"delay_ms"`
}

func (c *relayConf) api() string {
	if c.API != "" {
		return strings.TrimRight(c.API, "/")
	}
	return strings.TrimRight(c.URL, "/") + "/api"
}

func (c *relayConf) delay() int {
	if c.DelayMS != nil && *c.DelayMS >= 0 && *c.DelayMS <= 4000 {
		return *c.DelayMS
	}
	return relayDelayDefault
}

// channel is the relay channel a hub account streams on, "" if they have none.
func (c *relayConf) channel(name string) string {
	for ch, n := range c.Channels {
		if n == name {
			return ch
		}
	}
	return ""
}

// relayStream is one live relay stream, as the page gets it.
type relayStream struct {
	Name    string    `json:"name"`
	Started time.Time `json:"started"`
	Viewers []string  `json:"viewers"`
	Tag     string    `json:"tag,omitempty"` // their stream tag (livetag.go), filled in for the list
}

// relaySession is one viewer's connection to the relay, made through the hub.
type relaySession struct {
	viewer  string
	channel string
	end     string // the relay's address for ending it
	made    time.Time
	seen    bool // the relay has listed it
}

type relay struct {
	confFile string
	confMu   sync.Mutex
	conf     *relayConf
	confMod  time.Time
	client   *http.Client

	mu       sync.Mutex
	live     []relayStream
	sessions map[string]*relaySession // by the id the hub gave it
	down     bool                     // the last check couldn't reach the relay
}

func loadRelay(dir string) *relay {
	return &relay{confFile: filepath.Join(dir, "relay.json"), sessions: map[string]*relaySession{},
		client: &http.Client{Timeout: 8 * time.Second}}
}

// config is relay.json, read again whenever the file changes; nil while there's none.
func (rl *relay) config() *relayConf {
	rl.confMu.Lock()
	defer rl.confMu.Unlock()
	info, err := os.Stat(rl.confFile)
	if err != nil {
		rl.conf, rl.confMod = nil, time.Time{}
		return nil
	}
	if info.ModTime().Equal(rl.confMod) {
		return rl.conf
	}
	rl.confMod = info.ModTime()
	rl.conf = nil
	var c relayConf
	b, err := os.ReadFile(rl.confFile)
	if err == nil && json.Unmarshal(b, &c) == nil && c.URL != "" && len(c.Channels) > 0 {
		rl.conf = &c
	} else {
		log.Printf("relay.json: unusable, relay streams off")
	}
	return rl.conf
}

// do sends a request to the relay with the hub's account.
func (rl *relay) do(c *relayConf, method, addr, ctype string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequest(method, addr, body)
	if err != nil {
		return nil, err
	}
	if c.User != "" {
		req.SetBasicAuth(c.User, c.Pass)
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	return rl.client.Do(req)
}

func (rl *relay) get(c *relayConf, addr string, into any) error {
	res, err := rl.do(c, "GET", addr, "", nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s", res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(into)
}

func (s *Server) relayRoutes() {
	s.mux.HandleFunc("POST /api/relay/{name}/watch", s.relayWatch)
	s.mux.HandleFunc("DELETE /api/relay/sessions/{id}", s.relayLeave)
	go func() {
		for {
			s.relayCheckOnce()
			time.Sleep(relayEvery)
		}
	}()
}

// relayList is what GET /api/streams adds: the live relay streams and the hold-back.
func (s *Server) relayList() ([]relayStream, int) {
	c := s.relay.config()
	if c == nil {
		return []relayStream{}, relayDelayDefault
	}
	s.relay.mu.Lock()
	defer s.relay.mu.Unlock()
	out := make([]relayStream, len(s.relay.live))
	for i, x := range s.relay.live {
		out[i] = relayStream{Name: x.Name, Started: x.Started, Viewers: slices.Clone(x.Viewers)}
	}
	return out, c.delay()
}

// relayCheckOnce asks the relay which channels are live and who is reading them.
func (s *Server) relayCheckOnce() {
	c := s.relay.config()
	rl := s.relay
	if c == nil {
		rl.mu.Lock()
		had := len(rl.live) > 0
		rl.live = nil
		rl.mu.Unlock()
		if had {
			s.streamChanged()
		}
		return
	}
	var paths struct {
		Items []struct {
			Name      string     `json:"name"`
			Ready     bool       `json:"ready"`
			ReadyTime *time.Time `json:"readyTime"`
		} `json:"items"`
	}
	var sess struct {
		Items []struct {
			Created time.Time `json:"created"`
			State   string    `json:"state"`
			Path    string    `json:"path"`
			Query   string    `json:"query"`
		} `json:"items"`
	}
	err := rl.get(c, c.api()+"/v3/paths/list?itemsPerPage=1000", &paths)
	if err == nil {
		err = rl.get(c, c.api()+"/v3/webrtcsessions/list?itemsPerPage=1000", &sess)
	}
	rl.mu.Lock()
	if err != nil {
		if !rl.down {
			log.Printf("relay: can't ask it what is live: %v", err)
		}
		had := len(rl.live) > 0
		rl.down, rl.live = true, nil
		rl.mu.Unlock()
		if had {
			s.streamChanged()
		}
		return
	}
	if rl.down {
		log.Printf("relay: reachable again")
		rl.down = false
	}
	allowed := func(n string) bool { u, ok := s.users.Get(n); return ok && !u.Banned }
	// Who is reading each channel, in the order they connected.
	slices.SortFunc(sess.Items, func(a, b struct {
		Created time.Time `json:"created"`
		State   string    `json:"state"`
		Path    string    `json:"path"`
		Query   string    `json:"query"`
	}) int {
		return a.Created.Compare(b.Created)
	})
	for _, x := range rl.sessions {
		x.seen = false
	}
	viewers := map[string][]string{}
	var kick []*relaySession
	for _, it := range sess.Items {
		q, _ := url.ParseQuery(it.Query)
		x, ok := rl.sessions[q.Get("v")]
		if !ok || it.State != "read" || it.Path != x.channel+"-web" {
			continue
		}
		x.seen = true
		if !allowed(x.viewer) {
			kick = append(kick, x)
			delete(rl.sessions, q.Get("v"))
			continue
		}
		if !slices.Contains(viewers[x.channel], x.viewer) {
			viewers[x.channel] = append(viewers[x.channel], x.viewer)
		}
	}
	for id, x := range rl.sessions {
		if !x.seen && time.Since(x.made) > relayPending {
			delete(rl.sessions, id)
		}
	}
	live := []relayStream{}
	for _, p := range paths.Items {
		ch, web := strings.CutSuffix(p.Name, "-web")
		name := c.Channels[ch]
		if !web || !p.Ready || name == "" || !allowed(name) {
			continue
		}
		x := relayStream{Name: name, Viewers: viewers[ch]}
		if p.ReadyTime != nil {
			x.Started = p.ReadyTime.UTC()
		}
		if x.Viewers == nil {
			x.Viewers = []string{}
		}
		live = append(live, x)
	}
	slices.SortFunc(live, func(a, b relayStream) int { return a.Started.Compare(b.Started) })
	changed := !slices.EqualFunc(live, rl.live, func(a, b relayStream) bool {
		return a.Name == b.Name && a.Started.Equal(b.Started) && slices.Equal(a.Viewers, b.Viewers)
	})
	rl.live = live
	rl.mu.Unlock()
	for _, x := range kick {
		log.Printf("relay: ended %s's viewing (banned or deleted)", x.viewer)
		if res, err := rl.do(c, "DELETE", x.end, "", nil); err == nil {
			res.Body.Close()
		}
	}
	if changed {
		s.streamChanged()
	}
}

// relayWatch passes a viewer's WebRTC offer on to the relay and returns its answer. The
// picture and sound then go from the relay to the viewer directly.
func (s *Server) relayWatch(w http.ResponseWriter, r *http.Request) {
	name, me := r.PathValue("name"), who(r).Name
	c := s.relay.config()
	ch := ""
	if c != nil {
		ch = c.channel(name)
	}
	notLive := func() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": name + " isn't streaming right now."})
	}
	if ch == "" {
		notLive()
		return
	}
	var in struct {
		SDP string `json:"sdp"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSDP)).Decode(&in) != nil || !strings.HasPrefix(in.SDP, "v=0") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "that isn't a WebRTC offer"})
		return
	}
	b := make([]byte, 9)
	rand.Read(b)
	id := hex.EncodeToString(b)
	whep := strings.TrimRight(c.URL, "/") + "/" + url.PathEscape(ch+"-web") + "/whep"
	res, err := s.relay.do(c, "POST", whep+"?v="+id, "application/sdp", strings.NewReader(in.SDP))
	if err != nil {
		log.Printf("relay: watch %s: %v", ch, err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the stream relay isn't answering"})
		return
	}
	defer res.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(res.Body, maxSDP))
	switch {
	case res.StatusCode == http.StatusNotFound:
		notLive()
		return
	case res.StatusCode != http.StatusCreated:
		log.Printf("relay: watch %s: %s", ch, res.Status)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the stream relay said no"})
		return
	}
	// The relay names the session by a secret at the end of Location; ending it is a DELETE there.
	secret := path.Base(res.Header.Get("Location"))
	s.relay.mu.Lock()
	s.relay.sessions[id] = &relaySession{viewer: me, channel: ch, end: whep + "/" + url.PathEscape(secret), made: time.Now()}
	s.relay.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "sdp": string(answer)})
}

// relayLeave ends your own session on the relay (the page calls it when you stop watching).
func (s *Server) relayLeave(w http.ResponseWriter, r *http.Request) {
	id, me := r.PathValue("id"), who(r).Name
	s.relay.mu.Lock()
	x, ok := s.relay.sessions[id]
	if ok && x.viewer == me {
		delete(s.relay.sessions, id)
	}
	s.relay.mu.Unlock()
	if !ok || x.viewer != me {
		w.WriteHeader(http.StatusNoContent) // already gone, or not yours to end
		return
	}
	if c := s.relay.config(); c != nil {
		if res, err := s.relay.do(c, "DELETE", x.end, "", nil); err == nil {
			res.Body.Close()
		}
	}
	w.WriteHeader(http.StatusNoContent)
	go s.relayCheckOnce() // the count drops now, not at the next check
}
