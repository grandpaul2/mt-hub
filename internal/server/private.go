package server

// Private chats and direct messages: who may see a chat, the checks on every chat request,
// events only to those who may see them, and making and changing private chats and DMs.

import (
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/grandpaul2/mt-hub/internal/chat"
)

// sees: user may see a chat with this meta (admins see private chats, never DMs).
func (s *Server) sees(m chat.Meta, user string) bool {
	if m.Kind == chat.Public {
		return true
	}
	u, ok := s.users.Get(user)
	return ok && m.CanSee(user, u.Admin)
}

// canSee: the caller may see chat name, and it exists.
func (s *Server) canSee(r *http.Request, name string) bool {
	m, err := s.chat.MetaOf(name)
	return err == nil && m.CanSee(who(r).Name, who(r).Admin)
}

// inChat guards every /api/channels/{name}/... route: a chat the caller may not see is
// answered as if it didn't exist.
func (s *Server) inChat(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.canSee(r, r.PathValue("name")) {
			chatFail(w, chat.ErrNoChannel)
			return
		}
		h(w, r)
	}
}

// publishChat sends a chat's event only to the pages of people who may see it, as the chat
// is now (or as given, for one that's just been deleted or changed).
func (s *Server) publishChat(typ, name string, v any, metas ...chat.Meta) {
	if typ == "message" && name == LinkChat {
		defer s.linkNew.wake() // the game servers' waiting polls (link.go)
	}
	if len(metas) == 0 {
		m, err := s.chat.MetaOf(name)
		if err != nil {
			return
		}
		metas = []chat.Meta{m}
	}
	s.bus.publishIf(typ, v, func(user string) bool {
		return slices.ContainsFunc(metas, func(m chat.Meta) bool { return s.sees(m, user) })
	})
}

// members checks a list of account names: each must be an account. Returned sorted, once
// each.
func (s *Server) members(names []string) ([]string, error) {
	var out []string
	for _, n := range names {
		if _, ok := s.users.Get(n); !ok {
			return nil, fmt.Errorf("no account called %q", n)
		}
		if !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	slices.Sort(out)
	return out, nil
}

// setKind: {"kind": "private"|"", "members": [...]}. Admins make a chat private (with its
// members) or public again; a private chat's members are changed the same way. The people
// who could see it before or can now are told, so it appears or goes from their lists.
func (s *Server) setKind(w http.ResponseWriter, r *http.Request) {
	if !s.isAdmin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can change who's in a chat"})
		return
	}
	var req struct {
		Kind    string
		Members []string
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Kind != chat.Public && req.Kind != chat.Private {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a chat is public or private"})
		return
	}
	members, err := s.members(req.Members)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	name := r.PathValue("name")
	before, _ := s.chat.MetaOf(name)
	after, err := s.chat.SetKind(name, req.Kind, members)
	if err != nil {
		chatFail(w, err)
		return
	}
	s.publishChat("channel", name, map[string]string{"name": name}, before, after)
	writeJSON(w, http.StatusOK, after)
}

// openDM: {"members": [...]}, the others. The DM between the caller and them: the existing
// one, or a new one.
func (s *Server) openDM(w http.ResponseWriter, r *http.Request) {
	var req struct{ Members []string }
	if !readJSON(w, r, &req) {
		return
	}
	me := who(r).Name
	members, err := s.members(append(req.Members, me))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	name, err := s.chat.OpenDM(members, me)
	if errors.Is(err, chat.ErrMembers) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	s.publishChat("channel", name, map[string]string{"name": name})
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}

// hide takes a DM out of the caller's list until its next message.
func (s *Server) hide(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.chat.Hide(name, who(r).Name); err != nil {
		chatFail(w, err)
		return
	}
	me := who(r).Name
	s.bus.publishIf("channel", map[string]string{"name": name}, func(u string) bool { return u == me })
	writeJSON(w, http.StatusOK, map[string]string{})
}

// visibleRenames is the chat renames the caller may know about: those of chats they can
// see now.
func (s *Server) visibleRenames(r *http.Request) []chat.Rename {
	all := s.chat.Renames()
	out := []chat.Rename{}
	for i, rn := range all {
		to := rn.To
		for _, later := range all[i+1:] {
			if later.From == to {
				to = later.To
			}
		}
		if s.canSee(r, to) {
			out = append(out, rn)
		}
	}
	return out
}
