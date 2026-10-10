package server

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

// Server status (the page's /serverstatus): each game server (MT Hub Server) reports its
// players, mspt and memory every few seconds with its token. Nothing is stored: the hub keeps
// the last ten minutes in memory, and a server that stops reporting counts as offline.

const (
	statusKeep    = 10 * time.Minute // how far back the graph goes
	statusUp      = 30 * time.Second // no report for this long: offline
	statusRecent  = time.Minute      // the mspt and memory numbers are averaged over this
	statusPlayers = 200              // names kept from one report
	statusBody    = 16 << 10
)

type statusSample struct {
	at   time.Time
	mspt float64
	max  float64 // the longest single tick in the report's ten seconds
	used int64
}

type gameServer struct {
	seen    time.Time
	players []string
	bots    int
	max     int64
	hist    []statusSample
}

type gameStatus struct {
	mu      sync.Mutex
	servers map[string]*gameServer
	now     func() time.Time // the tests' clock
}

func newGameStatus() *gameStatus {
	return &gameStatus{servers: map[string]*gameServer{}, now: time.Now}
}

// statusReport is what a game server sends.
type statusReport struct {
	Players []string `json:"players"`
	Bots    int      `json:"bots"`     // carpet's fake players, not in Players
	MSPT    float64  `json:"mspt"`     // the average tick since its last report
	MSPTMax float64  `json:"mspt_max"` // and the longest one
	MemUsed int64    `json:"mem_used"` // bytes of Java's heap in use
	MemMax  int64    `json:"mem_max"`  // and the most it may grow to
}

// statusView is one server as the page draws it.
type statusView struct {
	Name    string       `json:"name"`
	Up      bool         `json:"up"`
	Seen    *time.Time   `json:"seen,omitempty"` // its last report; none since the hub started: absent
	Players []string     `json:"players"`
	Bots    int          `json:"bots"`
	MSPT    float64      `json:"mspt"` // the last minute's average
	Peak    float64      `json:"peak"` // the longest single tick in the ten minutes
	MemUsed int64        `json:"mem_used"`
	MemMax  int64        `json:"mem_max"`
	Hist    [][2]float64 `json:"hist"` // seconds ago, mspt; oldest first
}

func (s *Server) statusRoutes() {
	s.mux.HandleFunc("POST /api/server-status", s.reportStatus)
	s.mux.HandleFunc("GET /api/server-status", s.serverStatus)
}

func (s *Server) reportStatus(w http.ResponseWriter, r *http.Request) {
	if who(r).Token != auth.KindServer {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only a game server reports its status"})
		return
	}
	var rep statusReport
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, statusBody)).Decode(&rep); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad report"})
		return
	}
	if math.IsNaN(rep.MSPT) || rep.MSPT < 0 || rep.MSPT > 1e6 || math.IsNaN(rep.MSPTMax) || rep.MSPTMax < 0 || rep.MSPTMax > 1e7 || rep.MemUsed < 0 || rep.MemMax < 0 || rep.Bots < 0 || rep.Bots > 10000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad report"})
		return
	}
	players := []string{}
	for _, p := range rep.Players {
		if auth.MCNameRE.MatchString(p) && len(players) < statusPlayers {
			players = append(players, p)
		}
	}
	sort.Slice(players, func(i, j int) bool { return strings.ToLower(players[i]) < strings.ToLower(players[j]) })

	st := s.status
	st.mu.Lock()
	defer st.mu.Unlock()
	now := st.now()
	g := st.servers[who(r).Name]
	if g == nil {
		g = &gameServer{}
		st.servers[who(r).Name] = g
	}
	g.seen, g.players, g.bots, g.max = now, players, rep.Bots, rep.MemMax
	g.hist = append(trimStatus(g.hist, now), statusSample{now, rep.MSPT, math.Max(rep.MSPT, rep.MSPTMax), rep.MemUsed})
	w.WriteHeader(http.StatusNoContent)
}

// trimStatus drops samples older than the graph.
func trimStatus(h []statusSample, now time.Time) []statusSample {
	i := 0
	for i < len(h) && now.Sub(h[i].at) > statusKeep {
		i++
	}
	return h[i:]
}

// serverStatus lists every game server with a token, reporting or not, by name.
func (s *Server) serverStatus(w http.ResponseWriter, r *http.Request) {
	names := map[string]bool{}
	toks, _ := s.users.Tokens()
	for _, t := range toks {
		if t.Kind == auth.KindServer {
			names[t.Server] = true
		}
	}
	st := s.status
	st.mu.Lock()
	defer st.mu.Unlock()
	now := st.now()
	out := []statusView{}
	for name := range names {
		v := statusView{Name: name, Players: []string{}, Hist: [][2]float64{}}
		if g := st.servers[name]; g != nil {
			seen := g.seen
			v.Seen = &seen
			v.Up = now.Sub(g.seen) <= statusUp
			g.hist = trimStatus(g.hist, now)
			var mspt, used float64
			n := 0
			for _, h := range g.hist {
				v.Hist = append(v.Hist, [2]float64{math.Round(now.Sub(h.at).Seconds()), round1(h.mspt)})
				v.Peak = math.Max(v.Peak, round1(h.max))
				if now.Sub(h.at) <= statusRecent {
					mspt += h.mspt
					used += float64(h.used)
					n++
				}
			}
			if v.Up && n > 0 {
				v.Players, v.Bots, v.MemMax = g.players, g.bots, g.max
				v.MSPT, v.MemUsed = round1(mspt/float64(n)), int64(used/float64(n))
			}
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	// Survival first: it's the main server.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name == "survival" && out[j].Name != "survival" })
	writeJSON(w, http.StatusOK, out)
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
