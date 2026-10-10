package server

import (
	"net/http"
	"slices"

	"github.com/grandpaul2/mt-hub/internal/auth"
)

// TagColours are the colours an admin's tag (it reads "op") can be (style guide 3.1, --tag-*).
var TagColours = []string{"purple", "gold", "blue", "teal", "green", "orange", "red", "pink", "grey"}

// tagColour is an admin's tag colour: their pick, or gold for the owner and purple for other
// admins. Empty for everyone else (no tag).
func tagColour(u auth.User) string {
	switch {
	case !u.Admin && !u.Owner:
		return ""
	case u.Tag != "":
		return u.Tag
	case u.Owner:
		return "gold"
	}
	return "purple"
}

// setTag: {"tag"} sets an admin's tag colour. You can set your own; the owner can set anyone's.
func (s *Server) setTag(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	var req struct{ Tag string }
	if !readJSON(w, r, &req) {
		return
	}
	name := r.PathValue("name")
	u, ok := s.users.Get(name)
	switch {
	case !ok:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such user"})
		return
	case !u.Admin && !u.Owner:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only admins have a tag"})
		return
	case name != who(r).Name && !who(r).Owner:
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner can change someone else’s tag"})
		return
	case !slices.Contains(TagColours, req.Tag):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "that isn’t one of the tag colours"})
		return
	}
	if err := s.users.Change(name, func(u *auth.User) { u.Tag = req.Tag }); err != nil {
		fail(w, err)
		return
	}
	s.bus.publish("users", struct{}{}) // everyone's chat shows the new colour
	writeJSON(w, http.StatusOK, map[string]string{"tag": req.Tag})
}
