package server

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// Tokens: our game servers (the MT Hub mod) log in with a token rather than the cookie
// (auth/tokens.go). The server does the hub's work for its players: /b's shortcuts, the
// schematics list and files, and posting screenshots. A token reaches only the routes listed
// here: it sits in a config file on a rented server.

// tokenAllow: method and path (a trailing / means anything under it) each kind of token may
// use. The release token posts, fixes and takes back mod release cards in
// #mod-discussion, and nothing else.
var tokenAllow = map[string][]string{auth.KindServer: serverAllow, auth.KindRelease: releaseAllow}

// ReleaseChat is where release cards go.
const ReleaseChat = "mod-discussion"

var releaseAllow = []string{
	"GET /api/me",
	"POST /api/channels/" + ReleaseChat + "/messages",
	"PATCH /api/channels/" + ReleaseChat + "/messages/",
	"DELETE /api/channels/" + ReleaseChat + "/messages/",
}

var serverAllow = []string{
	"GET /api/me",
	"GET /api/stat/commands/",
	"GET /api/file/commands/",
	"GET /api/schematics",
	"GET /api/file/" + SchematicsDir + "/",
	"POST /api/screenshots",
	"POST /api/server-status",
	"GET /api/server-link",
	"POST /api/server-link",
}

// tokenAllowed says whether a token of this kind may make this request. Only clean paths
// count: "schematics/../users.json" isn't under schematics/.
func tokenAllowed(r *http.Request, kind string) bool {
	p := r.URL.Path
	if path.Clean(p) != p {
		return false
	}
	for _, route := range tokenAllow[kind] {
		method, prefix, _ := strings.Cut(route, " ")
		if r.Method != method {
			continue
		}
		if p == prefix || (strings.HasSuffix(prefix, "/") && strings.HasPrefix(p, prefix) && len(p) > len(prefix)) {
			return true
		}
	}
	return false
}

// tokenAccount checks a bearer token and the route it's used on, answering if it fails.
func (s *Server) tokenAccount(w http.ResponseWriter, r *http.Request, bearer string) (account, bool) {
	t, ok := s.users.CheckToken(strings.TrimSpace(bearer))
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unknown or revoked token"})
		return account{}, false
	}
	if !tokenAllowed(r, t.Kind) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "a " + t.Kind + " token can't do that"})
		return account{}, false
	}
	return account{Name: t.Server, Token: t.Kind}, true
}

func (s *Server) tokenRoutes() {
	s.mux.HandleFunc("POST /api/screenshots", s.postScreenshot)
}

// ---- screenshots from the game, posted by the server ----

// Minecraft names a screenshot by the player's local time: 2026-10-03_21.04.11.png, with
// _2 and so on for several in one second.
var mcShotName = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})_(\d{2}\.\d{2}\.\d{2})(?:_\d+)?\.png$`)

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// postScreenshot: the body is a PNG, ?name= its file name in the game. It's saved to
// screenshots/ as "<date> <time> <poster>.png" like an upload from the page, with the
// time the game's file name gives (the player's own clock), else now. A server names the
// player with ?poster= (their Minecraft name, which needn't be a hub account); from the
// page, the poster is you. A Minecraft name someone linked to their account (the menu on
// their name) posts under their hub name. Returns its path.
func (s *Server) postScreenshot(w http.ResponseWriter, r *http.Request) {
	poster := who(r).Name
	if who(r).Token != "" {
		poster = r.URL.Query().Get("poster")
		if !auth.MCNameRE.MatchString(poster) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "poster must be a Minecraft name"})
			return
		}
		if name, ok := s.users.ByMC(poster); ok {
			poster = name
		}
	}
	// A game server's token sits on a rented host: if it leaked, it could post at most this many.
	if who(r).Token != "" && !s.shots.take(who(r).Name) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many screenshots today"})
		return
	}
	limit := int64(maxVersioned)
	if who(r).Token != "" {
		limit = maxTokenShot
		select {
		case tokenShotSlots <- struct{}{}:
			defer func() { <-tokenShotSlots }()
		case <-r.Context().Done():
			return
		}
	}
	if r.ContentLength > limit {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file too large"})
		return
	}
	if !s.roomFor(w, r.ContentLength) {
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file too large"})
		return
	}
	if !bytes.HasPrefix(data, pngMagic) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a PNG"})
		return
	}
	if who(r).Token != "" && !shotBytes.spend(who(r).Name, int64(len(data)), tokenShotBytes) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many screenshots today"})
		return
	}
	stamp := time.Now().Format("2006-01-02 15.04.05")
	if m := mcShotName.FindStringSubmatch(r.URL.Query().Get("name")); m != nil {
		stamp = m[1] + " " + m[2]
	}
	base := "screenshots/" + stamp + " " + poster
	for n := 1; ; n++ {
		p := base + ".png"
		if n > 1 {
			p = base + " (" + strconv.Itoa(n) + ").png"
		}
		_, err := s.ws.WriteFrom(p, bytes.NewReader(data), "", s.author(r))
		var conflict *workspace.ConflictError
		if errors.As(err, &conflict) {
			continue // that name is taken
		}
		if err != nil {
			fail(w, err)
			return
		}
		s.bus.publish("files", struct{}{})
		writeJSON(w, http.StatusOK, map[string]string{"path": p})
		return
	}
}
