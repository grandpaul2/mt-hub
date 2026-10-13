package server

import (
	"net/http"

	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// The Trash: what was deleted in Files in the last workspace.TrashDays days, listed for
// everyone and restored by anyone; erased early only by an admin. Files from private chats
// and DMs are in the same trash on disk but are never listed here (workspace/trash.go).
// Closed to tokens.
func (s *Server) trashRoutes() {
	s.mux.HandleFunc("GET /api/trash", s.trashList)
	s.mux.HandleFunc("POST /api/trash/restore", s.trashRestore)
	s.mux.HandleFunc("POST /api/trash/delete", s.trashDelete)
	s.mux.HandleFunc("POST /api/trash/empty", s.trashEmpty)
}

func (s *Server) trashList(w http.ResponseWriter, r *http.Request) {
	items, err := s.ws.TrashList()
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "days": workspace.TrashDays})
}

// trashChanged tells every page: the tree (something came back) and an open Trash.
func (s *Server) trashChanged() {
	s.bus.publish("files", struct{}{})
	s.bus.publish("trash", struct{}{})
}

// trashRestore brings entries back: {"ids": [...]} to where each was, or with "to" (a folder,
// "" the top) into that folder. It answers {"paths": [...]} with where each landed.
func (s *Server) trashRestore(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"`
		To  *string  `json:"to"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	paths, err := s.ws.Restore(body.IDs, body.To, s.author(r))
	if err != nil {
		fail(w, err)
		return
	}
	s.trashChanged()
	writeJSON(w, http.StatusOK, map[string][]string{"paths": paths})
}

// trashDelete erases entries for good: {"ids": [...]}. Admins.
func (s *Server) trashDelete(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.IDs == nil {
		body.IDs = []string{}
	}
	n, err := s.ws.DeleteForever(body.IDs, s.author(r))
	s.trashChanged()
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"deleted": n})
}

// trashEmpty erases everything the Trash lists. Admins.
func (s *Server) trashEmpty(w http.ResponseWriter, r *http.Request) {
	if !s.admin(w, r) {
		return
	}
	n, err := s.ws.DeleteForever(nil, s.author(r))
	s.trashChanged()
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"deleted": n})
}
