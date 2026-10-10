package server

import (
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

// The Admin page: every account, with ban, password reset, admin and delete, plus a log of
// who did what. Admins may act on regular members; only the owner may act on admins or
// make someone one, and nobody may act on the owner (or on themselves: use Change Password).

// accountRoutes: logging in, your account, the Admin page, and the live event stream (which
// a ban cuts off). Split out of New so the tests can have them without the rest.
func (s *Server) accountRoutes() {
	s.mux.HandleFunc("POST /api/login", s.login)
	s.mux.HandleFunc("POST /api/logout", s.logout)
	s.mux.HandleFunc("POST /api/logout-all", s.logoutAll)
	s.mux.HandleFunc("GET /api/me", s.me)
	s.mux.HandleFunc("POST /api/password", s.password)
	s.mux.HandleFunc("POST /api/mc", s.setMC)
	s.mux.HandleFunc("GET /api/users", s.listUsers)
	s.mux.HandleFunc("GET /api/admin/users", s.adminUsers)
	s.mux.HandleFunc("POST /api/admin/users", s.addUser)
	s.mux.HandleFunc("PATCH /api/admin/users/{name}", s.changeUser)
	s.mux.HandleFunc("PUT /api/admin/users/{name}/tag", s.setTag)
	s.mux.HandleFunc("POST /api/admin/users/{name}/password", s.resetPassword)
	s.mux.HandleFunc("DELETE /api/admin/users/{name}", s.deleteUser)
	s.mux.HandleFunc("GET /api/admin/log", s.adminLog)
	s.mux.HandleFunc("GET /api/events", s.events)
}

func (a account) rank() int { return auth.User{Owner: a.Owner, Admin: a.Admin}.Rank() }

// online: had the hub open in the last minute (an open page checks in every 25 seconds).
const onlineWithin = time.Minute

type adminUser struct {
	Name   string `json:"name"`
	Admin  bool   `json:"admin"`
	Owner  bool   `json:"owner"`
	Banned bool   `json:"banned"`
	Seen   string `json:"seen,omitempty"` // RFC 3339; empty if never
	Online bool   `json:"online"`
	Tag    string `json:"tag,omitempty"` // an op's tag colour
	MC     string `json:"mc,omitempty"`  // their linked Minecraft name
}

// admin refuses anyone who isn't an admin, answering for them.
func (s *Server) admin(w http.ResponseWriter, r *http.Request) bool {
	if !s.isAdmin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admins only"})
		return false
	}
	return true
}

// target is the account named in the path, if the caller outranks it.
func (s *Server) target(w http.ResponseWriter, r *http.Request) (string, auth.User, bool) {
	name := r.PathValue("name")
	u, ok := s.users.Get(name)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such user"})
		return "", u, false
	}
	if who(r).rank() <= u.Rank() {
		msg := "only the owner can change an admin"
		if u.Owner {
			msg = "nobody can change the owner"
		} else if name == who(r).Name {
			msg = "you can't do that to yourself"
		}
		writeJSON(w, http.StatusForbidden, map[string]string{"error": msg})
		return "", u, false
	}
	return name, u, true
}

// logAction adds to the admin log. The action itself is done, so a failure is only logged.
func (s *Server) logAction(r *http.Request, action, user string) {
	if err := s.users.Log(who(r).Name, action, user); err != nil {
		log.Printf("admin log: %v", err)
	}
}

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	users, err := s.users.Users()
	if err != nil {
		fail(w, err)
		return
	}
	out := []adminUser{}
	for name, u := range users {
		a := adminUser{Name: name, Admin: u.Admin, Owner: u.Owner, Banned: u.Banned, Tag: tagColour(u), MC: u.MC}
		if t := s.users.Seen(name); !t.IsZero() {
			a.Seen = t.UTC().Format(time.RFC3339)
			a.Online = time.Since(t) < onlineWithin && !u.Banned
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	writeJSON(w, http.StatusOK, out)
}

// addUser: {"name", "admin"} makes an account and returns its temporary password, shown
// once for the admin to pass on.
func (s *Server) addUser(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	var req struct {
		Name  string
		Admin bool
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Admin && !who(r).Owner {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner can make admins"})
		return
	}
	name := strings.TrimSpace(req.Name)
	pw, err := s.users.Add(name, req.Admin)
	if errors.Is(err, auth.ErrExists) || errors.Is(err, auth.ErrRetired) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.logAction(r, "add", name)
	s.bus.publish("users", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{"password": pw})
}

// changeUser: {"banned": bool} and/or {"admin": bool}, or {"mc": ""} to unlink their Minecraft
// name (anyone can claim one, so a wrong claim needs an admin). A ban ends their open pages at once.
func (s *Server) changeUser(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	var req struct {
		Banned, Admin *bool
		MC            *string
	}
	if !readJSON(w, r, &req) {
		return
	}
	name, u, ok := s.target(w, r)
	if !ok {
		return
	}
	if req.Admin != nil && !who(r).Owner {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner can make or remove admins"})
		return
	}
	if req.MC != nil && *req.MC != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "an admin can only unlink a Minecraft name"})
		return
	}
	err := s.users.Change(name, func(u *auth.User) {
		if req.MC != nil {
			u.MC = ""
		}
		if req.Banned != nil {
			u.Banned = *req.Banned
		}
		if req.Admin != nil {
			u.Admin = *req.Admin
		}
	})
	if err != nil {
		fail(w, err)
		return
	}
	if req.Banned != nil && *req.Banned != u.Banned {
		if *req.Banned {
			s.bus.kick(name)
			s.logAction(r, "ban", name)
		} else {
			s.logAction(r, "unban", name)
		}
	}
	if req.Admin != nil && *req.Admin != u.Admin {
		// Their page shows admin buttons from when it loaded: start them afresh.
		s.bus.kick(name)
		s.logAction(r, map[bool]string{true: "admin", false: "unadmin"}[*req.Admin], name)
	}
	if req.MC != nil && u.MC != "" {
		s.logAction(r, "unlink-mc", name)
	}
	s.bus.publish("users", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{})
}

// resetPassword gives someone a new temporary password (returned once), logs them out
// everywhere: for a forgotten password, or an account someone else got into.
func (s *Server) resetPassword(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	name, _, ok := s.target(w, r)
	if !ok {
		return
	}
	pw, err := s.users.SetTempPassword(name)
	if err != nil {
		fail(w, err)
		return
	}
	s.bus.kick(name)
	s.logAction(r, "reset", name)
	writeJSON(w, http.StatusOK, map[string]string{"password": pw})
}

// deleteUser removes an account. Their messages and files keep their name, and the name is
// retired: a new account can't take it, and with it their DMs and private chats.
func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	name, _, ok := s.target(w, r)
	if !ok {
		return
	}
	if err := s.users.Delete(name); err != nil {
		fail(w, err)
		return
	}
	s.bus.kick(name)
	s.logAction(r, "delete", name)
	s.bus.publish("users", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{})
}

func (s *Server) adminLog(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	entries, err := s.users.ReadLog(100)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// setMC: {"mc"} links your Minecraft name ("" unlinks), so screenshots a server posts for
// that name go under your hub name.
func (s *Server) setMC(w http.ResponseWriter, r *http.Request) {
	var req struct{ MC string }
	if !readJSON(w, r, &req) {
		return
	}
	if err := s.users.SetMC(who(r).Name, req.MC); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"mc": strings.TrimSpace(req.MC)})
}
