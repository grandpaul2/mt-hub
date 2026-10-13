package server

import (
	"errors"
	"log"
	"mime"
	"net/http"
	"path"

	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// A selection of files and folders moved, deleted, copied or downloaded in one call
// (workspace/batch.go): one commit and one "files" event, where a call per file would be one
// each. Closed to tokens, like the single-file routes they stand beside.
func (s *Server) batchRoutes() {
	s.mux.HandleFunc("POST /api/batch/move", s.batchMove)
	s.mux.HandleFunc("POST /api/batch/delete", s.batchDelete)
	s.mux.HandleFunc("POST /api/batch/copy", s.batchCopy)
	s.mux.HandleFunc("GET /api/zip", s.zipSeveral)
}

// batchMove moves several into a folder, keeping their names: {"from": ["a.md", "docs"],
// "to": "notes"} ("" is the top). All or nothing; 409 names the one whose name is taken.
func (s *Server) batchMove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From []string
		To   string
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.ws.MoveAll(body.From, body.To, s.author(r)); err != nil {
		failBatch(w, err)
		return
	}
	s.bus.publish("files", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{})
}

// batchDelete moves several to the Trash: {"paths": ["a.md", "docs"]}, answering {"trash":
// [ids]} with the entries they are now. All or nothing.
func (s *Server) batchDelete(w http.ResponseWriter, r *http.Request) {
	var body struct{ Paths []string }
	if !readJSON(w, r, &body) {
		return
	}
	ids, err := s.ws.DeleteAll(body.Paths, s.author(r))
	s.bus.publish("files", struct{}{}) // also when it stopped part way
	if err != nil {
		failBatch(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"trash": ids})
}

// batchCopy copies several into a folder: {"from": [...], "to": "notes"}, answering
// {"paths": [...]} with where each landed (a taken name gets " copy").
func (s *Server) batchCopy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From []string
		To   string
	}
	if !readJSON(w, r, &body) {
		return
	}
	size, err := s.ws.Size(body.From)
	if err != nil {
		failBatch(w, err)
		return
	}
	if !s.roomFor(w, size) {
		return
	}
	to, err := s.ws.CopyAll(body.From, body.To, s.author(r))
	if err != nil {
		failBatch(w, err)
		return
	}
	s.bus.publish("files", struct{}{})
	writeJSON(w, http.StatusOK, map[string][]string{"paths": to})
}

// zipSeveral streams several files and folders as one zip: /api/zip?p=a.md&p=docs. It is
// named for the folder they share, or files.zip.
func (s *Server) zipSeveral(w http.ResponseWriter, r *http.Request) {
	paths := r.URL.Query()["p"]
	if len(paths) == 0 {
		fail(w, workspace.ErrBadPath)
		return
	}
	name := "files"
	for i, p := range paths {
		c, err := workspace.Clean(p)
		if err != nil {
			fail(w, err)
			return
		}
		paths[i] = c
		if d := path.Dir(c); i == 0 && d != "." {
			name = path.Base(d)
		} else if d != path.Dir(paths[0]) {
			name = "files"
		}
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name + ".zip"}))
	if err := s.ws.ZipAll(paths, w); errors.Is(err, workspace.ErrNotFound) || errors.Is(err, workspace.ErrBadPath) {
		w.Header().Del("Content-Disposition")
		fail(w, err)
	} else if err != nil {
		var refused *workspace.RefusedError
		if errors.As(err, &refused) {
			w.Header().Del("Content-Disposition")
			fail(w, err)
			return
		}
		log.Printf("zip of %d: %v", len(paths), err) // mid-stream: the download just ends short
	}
}

// failBatch is fail, but a taken name is named: "keep.md already exists in notes/".
func failBatch(w http.ResponseWriter, err error) {
	var clash *workspace.ClashError
	if errors.As(err, &clash) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": clash.Error(), "name": clash.Name})
		return
	}
	fail(w, err)
}
