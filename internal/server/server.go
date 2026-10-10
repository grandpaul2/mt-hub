// Package server is the HTTP API and the static frontend.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// Versioned files are capped to keep the git history healthy; anything bigger goes in
// large/, which isn't versioned. The page knows the same numbers.
const (
	maxVersioned = workspace.MaxVersioned
	maxLarge     = 64 << 30
)

// Files above this size are never opened in the editor.
const maxEditable = 5 << 20

type Server struct {
	users     *auth.Store
	logins    *limiter // password tries per client address
	accounts  *limiter // and per account
	previews  *limiter // link previews not fetched yet, per person
	shots     *limiter // screenshots posted per game server token
	ws        *workspace.Workspace
	chat      *chat.Store
	links     *preview.Store
	thumbs    string    // where chat media thumbnails are kept
	texts     textCache // text files' contents, for search
	bus       *broker
	sendMu    sync.Mutex // a message is stored and sent out in one step, so all see the same order
	voice     *voice
	streams   *streams
	status    *gameStatus // what the game servers last reported (status.go)
	linkNew   linkWake    // a new message in #server-link (link.go)
	linkPosts *limiter    // lines posted to it per game server token
	mux       *http.ServeMux
}

// New builds the server. static is the frontend: web.Dist in production, or the
// on-disk web/dist in -dev mode so frontend rebuilds show up without a restart.
// etags are static's content hashes (HashFiles), nil in -dev mode; see staticFiles.
// thumbs is a folder for the thumbnails of chat media.
func New(us *auth.Store, ws *workspace.Workspace, cs *chat.Store, ls *preview.Store, thumbs string, static fs.FS, etags map[string]string) *Server {
	s := &Server{users: us, logins: newLimiter(loginTries, loginWindow), accounts: newLimiter(accountTries, accountWindow), previews: newLimiter(previewTries, previewWindow), shots: newLimiter(shotsPerDay, 24*time.Hour), ws: ws, chat: cs, links: ls, thumbs: thumbs, bus: newBroker(), mux: http.NewServeMux()}
	s.voice = loadVoice(filepath.Dir(thumbs)) // the data directory
	s.streams = loadStreams(filepath.Dir(thumbs))
	s.accountRoutes()
	s.voiceRoutes()
	s.streamRoutes()
	s.tokenRoutes()
	s.status = newGameStatus()
	s.statusRoutes()
	s.linkPosts = newLimiter(linkPerMin, time.Minute)
	s.linkRoutes()

	s.mux.HandleFunc("GET /api/tree", s.tree)
	s.mux.HandleFunc("GET /api/stat/{path...}", s.stat)
	s.mux.HandleFunc("GET /api/file/{path...}", s.getFile)
	s.mux.HandleFunc("PUT /api/file/{path...}", s.putFile)
	s.mux.HandleFunc("DELETE /api/file/{path...}", s.deleteFile)
	s.mux.HandleFunc("POST /api/move", s.move)
	s.mux.HandleFunc("GET /api/moves", s.moves)
	s.mux.HandleFunc("POST /api/mkdir", s.mkdir)
	s.mux.HandleFunc("GET /api/zip/{path...}", s.zip)
	s.mux.HandleFunc("GET /api/history/{path...}", s.history)
	s.mux.HandleFunc("GET /api/thumb/{path...}", s.thumb)

	s.mux.HandleFunc("GET /api/channels", s.channels)
	s.mux.HandleFunc("POST /api/channels", s.createChannel)
	s.mux.HandleFunc("GET /api/channel-renames", s.channelRenames)
	s.mux.HandleFunc("PUT /api/channel-order", s.setOrder)
	s.mux.HandleFunc("POST /api/dms", s.openDM)
	// Every route on one chat checks the caller may see it (inChat).
	for pattern, h := range map[string]http.HandlerFunc{
		"PATCH /api/channels/{name}":                                  s.renameChannel,
		"DELETE /api/channels/{name}":                                 s.deleteChannel,
		"PUT /api/channels/{name}/kind":                               s.setKind,
		"POST /api/channels/{name}/hide":                              s.hide,
		"POST /api/channels/{name}/media":                             s.postMedia,
		"GET /api/channels/{name}/media/{file}":                       s.mediaFile,
		"GET /api/channels/{name}/thumb/{file}":                       s.mediaThumb,
		"POST /api/channels/{name}/media/{file}/save":                 s.saveMedia,
		"GET /api/channels/{name}/files":                              s.chatFiles,
		"GET /api/channels/{name}/messages":                           s.messages,
		"POST /api/channels/{name}/messages":                          s.post,
		"PATCH /api/channels/{name}/messages/{id}":                    s.edit,
		"DELETE /api/channels/{name}/messages/{id}":                   s.deleteMessage,
		"GET /api/channels/{name}/messages/{id}/orphans":              s.orphans,
		"PUT /api/channels/{name}/messages/{id}/reactions/{emoji}":    s.react,
		"DELETE /api/channels/{name}/messages/{id}/reactions/{emoji}": s.react,
		"PUT /api/channels/{name}/messages/{id}/pin":                  s.pin,
		"DELETE /api/channels/{name}/messages/{id}/pin":               s.pin,
		"GET /api/channels/{name}/pins":                               s.pins,
	} {
		s.mux.HandleFunc(pattern, s.inChat(h))
	}

	s.mux.HandleFunc("GET /api/schematics", s.listSchematics)
	s.mux.HandleFunc("GET /api/search", s.search)
	s.mux.HandleFunc("POST /api/voice-lab/log", s.voiceLabLog)

	s.mux.HandleFunc("GET /api/preview", s.linkPreview)
	s.mux.HandleFunc("GET /api/preview/img/{id}", s.previewImage)

	go s.watchFiles()

	s.mux.Handle("GET /", staticFiles(static, etags))
	return s
}

// formPost says a request that changes something didn't come from the page's own script.
// Every change the page makes is a fetch; a form submits by navigating, and a form is what
// member-written HTML (a Markdown file) or another site could plant to act as whoever clicks
// it. Browsers label both in headers a page can't set (only on https and localhost; a client
// that sends none, like our game servers, passes).
func formPost(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return false
	}
	h := r.Header
	if h.Get("Sec-Fetch-Mode") == "navigate" || h.Get("Sec-Fetch-Dest") == "document" {
		return true
	}
	site := h.Get("Sec-Fetch-Site")
	return site != "" && site != "same-origin"
}

// Everything under /api/ needs a login except logging in. The page itself (HTML, scripts)
// is public: it asks /api/me and shows the login form when that says 401.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.securityHeaders(w, r)
	if formPost(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not from the page"})
		return
	}
	// LiveKit's webhook signs its own requests (voiceWebhook checks).
	if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/login" && r.URL.Path != "/api/voice/webhook" {
		// Our game servers send a token instead of the cookie (tokens.go).
		if bearer, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
			a, ok := s.tokenAccount(w, r, bearer)
			if !ok {
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), userKey{}, a))
			s.mux.ServeHTTP(w, r)
			return
		}
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "log in first"})
			return
		}
		name, u, ok := s.users.Check(c.Value)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "log in first"})
			return
		}
		if u.Banned {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": auth.ErrBanned.Error()})
			return
		}
		// A login lasts SessionTTL from when the hub was last used, not from logging in.
		if fresh := s.users.Renew(c.Value); fresh != "" {
			s.setSession(w, r, fresh, int(auth.SessionTTL.Seconds()))
		}
		// With a temporary password, only picking your own (or logging out) works.
		if u.Temp && r.URL.Path != "/api/me" && r.URL.Path != "/api/password" && r.URL.Path != "/api/logout" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "choose your own password first"})
			return
		}
		s.users.Touch(name)
		r = r.WithContext(context.WithValue(r.Context(), userKey{}, account{Name: name, Admin: u.Admin, Owner: u.Owner, MC: u.MC, Temp: u.Temp}))
	}
	s.mux.ServeHTTP(w, r)
}

const sessionCookie = "mt_session"

type userKey struct{}

type account struct {
	Name  string `json:"name"`
	Admin bool   `json:"admin"`
	Owner bool   `json:"owner,omitempty"`
	MC    string `json:"mc,omitempty"`    // their linked Minecraft name
	Temp  bool   `json:"temp,omitempty"`  // must pick their own password first (auth.User.Temp)
	Tag   string `json:"tag,omitempty"`   // an op's tag colour (in /api/users)
	Token string `json:"token,omitempty"` // "server" when a game server's token made the request
}

// who is the logged-in user (ServeHTTP has checked the session).
func who(r *http.Request) account { a, _ := r.Context().Value(userKey{}).(account); return a }

// admins may do things others can't: rename and delete chats, delete or edit anyone's
// message, pin messages. Who is an admin is set in users.json.
func (s *Server) isAdmin(r *http.Request) bool { return who(r).Admin }

func (s *Server) author(r *http.Request) workspace.Author {
	return workspace.Author{Name: who(r).Name}
}

// From the internet the hub is reached through Caddy on the relay VPS and an ssh tunnel,
// so those requests arrive from loopback with Caddy's X-Forwarded-* headers. Requests over
// the LAN or tailnet come straight in, and their headers aren't trusted.
func viaProxy(r *http.Request) bool {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// clientIP is who's asking: Caddy's view of the client for proxied requests (it puts the
// client last in X-Forwarded-For), else the connection's address.
func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" && viaProxy(r) {
		parts := strings.Split(f, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

// setSession sets the session cookie. Over HTTPS it's marked Secure, so the browser never
// sends it over plain http; over the LAN and tailnet (plain http) it can't be.
func (s *Server) setSession(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	secure := r.TLS != nil || (viaProxy(r) && r.Header.Get("X-Forwarded-Proto") == "https")
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}

// Password guesses are limited twice: per client address (5 in 15 minutes) and per account
// (10 an hour, from anywhere, so many addresses can't share the work). A try is counted
// before the password is checked, so a burst of requests at once gets no more. A right
// password clears both counts. Logging in and the current-password check in Change
// Password both count.
var (
	loginTries     = 5
	loginWindow    = 15 * time.Minute
	accountTries   = 10
	accountWindow  = time.Hour
	tooManyTries   = map[string]string{"error": "too many tries: wait 15 minutes"}
	tooManyAccount = map[string]string{"error": "too many tries for this account: wait an hour"}
)

// failDelay slows each wrong password a little more (a var so tests can skip it).
var failDelay = time.Second

type failures struct {
	n     int
	first time.Time
	of    map[string]int // n by account tried
}

type limiter struct {
	tries  int
	window time.Duration
	mu     sync.Mutex
	by     map[string]*failures
}

func newLimiter(tries int, window time.Duration) *limiter {
	return &limiter{tries: tries, window: window, by: map[string]*failures{}}
}

// take counts a try for key, or says false if key has used up its tries.
func (l *limiter) take(key string) bool { return l.takeAt(key, "") }

// takeAt is take for a password try at account, which forgive can take back.
func (l *limiter) takeAt(key, account string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	// Made-up names would grow the map without end: drop expired counts now and then.
	if len(l.by) > 1000 {
		for k, f := range l.by {
			if time.Since(f.first) > l.window {
				delete(l.by, k)
			}
		}
	}
	f := l.by[key]
	if f == nil || time.Since(f.first) > l.window {
		f = &failures{first: time.Now(), of: map[string]int{}}
		l.by[key] = f
	}
	if f.n >= l.tries {
		return false
	}
	f.n++
	f.of[account]++
	return true
}

// forgive takes back key's tries at account (its password was right): someone's own typos
// don't count against them, but tries at other accounts still do.
func (l *limiter) forgive(key, account string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if f := l.by[key]; f != nil {
		f.n -= f.of[account]
		delete(f.of, account)
	}
}

// guess counts one password try for this client and account, writing the refusal when
// either is used up.
func (s *Server) guess(w http.ResponseWriter, r *http.Request, name string) bool {
	account := strings.ToLower(name)
	if !s.logins.takeAt(clientIP(r), account) {
		writeJSON(w, http.StatusTooManyRequests, tooManyTries)
		return false
	}
	if !s.accounts.takeAt(account, account) {
		writeJSON(w, http.StatusTooManyRequests, tooManyAccount)
		return false
	}
	return true
}

// guessed forgives the tries at this account after a right password. The client's tries at
// other accounts stand, so logging in to your own between guesses at others doesn't reset them.
func (s *Server) guessed(r *http.Request, name string) {
	account := strings.ToLower(name)
	s.logins.forgive(clientIP(r), account)
	s.accounts.forgive(account, account)
}

// login: {"name", "password"}. Sets the session cookie.
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct{ Name, Password string }
	if !readJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if !s.guess(w, r, name) {
		return
	}
	cookie, err := s.users.Login(name, req.Password)
	if errors.Is(err, auth.ErrBanned) {
		s.guessed(r, name)
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		time.Sleep(failDelay)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	s.guessed(r, name)
	s.setSession(w, r, cookie, int(auth.SessionTTL.Seconds()))
	name, u, _ := s.users.Check(cookie)
	writeJSON(w, http.StatusOK, account{Name: name, Admin: u.Admin, Owner: u.Owner})
}

// logout ends this browser's session. A copy of the cookie elsewhere still works until
// logoutAll.
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	s.setSession(w, r, "", -1)
	writeJSON(w, http.StatusOK, map[string]string{})
}

// logoutAll ends every session of yours (another device, a stolen cookie); this browser
// gets a new one and stays logged in.
func (s *Server) logoutAll(w http.ResponseWriter, r *http.Request) {
	name := who(r).Name
	if err := s.users.LogOutEverywhere(name); err != nil {
		fail(w, err)
		return
	}
	if cookie, ok := s.users.Session(name); ok {
		s.setSession(w, r, cookie, int(auth.SessionTTL.Seconds()))
	}
	s.bus.kick(name)
	writeJSON(w, http.StatusOK, map[string]string{})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, who(r)) }

// password: {"old", "new"} changes your own password. Your other sessions end; this one
// gets a new cookie.
func (s *Server) password(w http.ResponseWriter, r *http.Request) {
	var req struct{ Old, New string }
	if !readJSON(w, r, &req) {
		return
	}
	name := who(r).Name
	if !s.guess(w, r, name) {
		return
	}
	if _, err := s.users.Login(name, req.Old); err != nil {
		time.Sleep(failDelay)
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "wrong password"})
		return
	}
	s.guessed(r, name)
	if len(req.New) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "use at least 8 characters"})
		return
	}
	if req.New == req.Old { // a temporary one stays one someone else has seen
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pick a password different from the current one"})
		return
	}
	if len(req.New) > 72 { // as much as bcrypt takes
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "use at most 72 characters (accented letters and emoji count as 2 to 4)"})
		return
	}
	if err := s.users.SetPassword(name, req.New); err != nil {
		fail(w, err)
		return
	}
	cookie, err := s.users.Login(name, req.New)
	if err != nil {
		fail(w, err)
		return
	}
	s.setSession(w, r, cookie, int(auth.SessionTTL.Seconds()))
	// Their other pages' live updates stop now, not at the next check in 25 s. This page's
	// stream ends too and comes back with the new cookie (the page expects that, as for
	// Log Out Everywhere).
	s.bus.kick(name)
	writeJSON(w, http.StatusOK, map[string]string{})
}

// listUsers: every account's name and role, and an op's tag colour (for @-mentions and op tags).
func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.users.Users()
	if err != nil {
		fail(w, err)
		return
	}
	out := []account{}
	for name, u := range users {
		out = append(out, account{Name: name, Admin: u.Admin, Tag: tagColour(u)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) tree(w http.ResponseWriter, r *http.Request) {
	entries, err := s.ws.Tree()
	if err != nil {
		fail(w, err)
		return
	}
	if entries == nil {
		entries = []workspace.Entry{}
	}
	writeJSON(w, http.StatusOK, entries)
}

type statResp struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Rev   string `json:"rev"`
	Kind  string `json:"kind"` // text | markdown | image | video | binary
	Large bool   `json:"large,omitempty"`
}

func (s *Server) stat(w http.ResponseWriter, r *http.Request) {
	p, ok := cleanPath(w, r)
	if !ok {
		return
	}
	size, rev, err := s.ws.Stat(p)
	if err != nil {
		fail(w, err)
		return
	}
	kind := "binary"
	switch strings.ToLower(path.Ext(p)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg":
		kind = "image"
	case ".mp4", ".webm", ".mov", ".m4v":
		kind = "video"
	case ".md", ".markdown":
		kind = "markdown"
	default:
		if size <= maxEditable {
			if data, err := s.ws.Read(p, ""); err == nil && isText(data) {
				kind = "text"
			}
		}
	}
	// In large/ and media/, small text and Markdown (a README) open like anywhere else, and
	// pictures and videos stream; everything else there is download only.
	if workspace.IsLarge(p) && kind == "markdown" && size > maxEditable {
		kind = "binary"
	}
	writeJSON(w, http.StatusOK, statResp{Path: p, Size: size, Rev: rev, Kind: kind, Large: workspace.IsLarge(p)})
}

func (s *Server) getFile(w http.ResponseWriter, r *http.Request) {
	p, ok := cleanPath(w, r)
	if !ok {
		return
	}
	// Uploaded HTML or SVG can carry script; opened directly, it must not run as our origin.
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Query().Get("download") != "" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(p)}))
	}

	// Files in large/ and media/ have no history: their "revision" is just size and time, so
	// they always stream the current file.
	if rev := r.URL.Query().Get("rev"); rev != "" && !workspace.IsLarge(p) {
		data, err := s.ws.Read(p, rev)
		if err != nil {
			fail(w, err)
			return
		}
		ctype := mime.TypeByExtension(path.Ext(p))
		if ctype == "" {
			ctype = http.DetectContentType(data)
		}
		w.Header().Set("Content-Type", ctype)
		// With range requests too, so a video from history can be seeked (versioned files
		// are at most 50 MB, so holding one in memory is fine).
		http.ServeContent(w, r, path.Base(p), time.Time{}, bytes.NewReader(data))
		return
	}
	// The current version streams from disk, with range requests, so multi-GB
	// downloads don't sit in memory and can resume.
	f, info, err := s.ws.OpenFile(p)
	if err != nil {
		fail(w, err)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, path.Base(p), info.ModTime(), f)
}

func (s *Server) putFile(w http.ResponseWriter, r *http.Request) {
	p, ok := cleanPath(w, r)
	if !ok {
		return
	}
	limit, msg := int64(maxVersioned), "files over 50 MB go in the large/ folder"
	if workspace.IsLarge(p) {
		limit, msg = maxLarge, "file too large"
	}
	if r.ContentLength > limit {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": msg})
		return
	}
	if !s.roomFor(w, r.ContentLength) {
		return
	}
	rev, err := s.ws.WriteFrom(p, http.MaxBytesReader(w, r.Body, limit), r.URL.Query().Get("base"), s.author(r))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": msg})
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	s.bus.publish("files", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{"rev": rev})
}

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request) {
	p, ok := cleanPath(w, r)
	if !ok {
		return
	}
	var err error
	if r.URL.Query().Get("dir") == "1" {
		err = s.ws.DeleteDir(p, s.author(r))
	} else {
		err = s.ws.Delete(p, r.URL.Query().Get("base"), s.author(r))
	}
	if err != nil {
		fail(w, err)
		return
	}
	s.bus.publish("files", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{})
}

func (s *Server) moves(w http.ResponseWriter, r *http.Request) {
	moves, err := s.ws.Moves()
	if err != nil {
		fail(w, err)
		return
	}
	if moves == nil {
		moves = []workspace.Moved{}
	}
	writeJSON(w, http.StatusOK, moves)
}

// mkdir creates an empty folder: {"path": "a/b"}.
func (s *Server) mkdir(w http.ResponseWriter, r *http.Request) {
	var body struct{ Path string }
	if !readJSON(w, r, &body) {
		return
	}
	p, err := workspace.Clean(body.Path)
	if err == nil {
		err = s.ws.Mkdir(p)
	}
	if err != nil {
		fail(w, err)
		return
	}
	s.bus.publish("files", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{})
}

// zip downloads a folder as <name>.zip, streamed as it's built.
func (s *Server) zip(w http.ResponseWriter, r *http.Request) {
	p, ok := cleanPath(w, r)
	if !ok {
		return
	}
	if _, _, err := s.ws.Stat(p); err == nil {
		fail(w, workspace.ErrNotFound) // a file, not a folder
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(p) + ".zip"}))
	if err := s.ws.Zip(p, w); errors.Is(err, workspace.ErrNotFound) {
		w.Header().Del("Content-Disposition")
		fail(w, err)
	} else if err != nil {
		log.Printf("zip %s: %v", p, err) // mid-stream: the download just ends short
	}
}

// move renames or moves a file or folder: {"from": "a/b.md", "to": "c/b.md"}.
func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	var body struct{ From, To string }
	if !readJSON(w, r, &body) {
		return
	}
	from, err := workspace.Clean(body.From)
	if err == nil {
		body.To, err = workspace.Clean(body.To)
	}
	if err == nil {
		err = s.ws.Move(from, body.To, s.author(r))
	}
	if err != nil {
		fail(w, err)
		return
	}
	s.bus.publish("files", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{})
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	p, ok := cleanPath(w, r)
	if !ok {
		return
	}
	hist, err := s.ws.History(p)
	if err != nil {
		fail(w, err)
		return
	}
	if hist == nil {
		hist = []workspace.Commit{}
	}
	writeJSON(w, http.StatusOK, hist)
}

func cleanPath(w http.ResponseWriter, r *http.Request) (string, bool) {
	p, err := workspace.Clean(r.PathValue("path"))
	if err != nil {
		fail(w, err)
		return "", false
	}
	return p, true
}

func isText(data []byte) bool {
	head := data
	if len(head) > 8000 {
		head = head[:8000]
	}
	return !bytes.ContainsRune(head, 0) && utf8.Valid(data)
}

func fail(w http.ResponseWriter, err error) {
	var conflict *workspace.ConflictError
	var refused *workspace.RefusedError
	switch {
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "conflict", "current": conflict.Current})
	case errors.Is(err, workspace.ErrExists):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "already exists"})
	case errors.As(err, &refused):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": refused.Reason})
	case errors.Is(err, workspace.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.Is(err, workspace.ErrBadPath):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
	// Plain mistakes the file system catches: say what's wrong, not "internal error".
	case errors.Is(err, syscall.ENOTDIR):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "a file can’t have files inside it"})
	case errors.Is(err, syscall.ENAMETOOLONG):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "that name is too long"})
	default:
		log.Print(err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
