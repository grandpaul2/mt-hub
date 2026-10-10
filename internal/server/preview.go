package server

import (
	"errors"
	"net/http"
	"os"

	"github.com/grandpaul2/mt-hub/internal/preview"
)

// linkPreview: GET /api/preview?url=<link>. The first ask for a link fetches it (a few
// seconds at most); after that it's cached.
func (s *Server) linkPreview(w http.ResponseWriter, r *http.Request) {
	link := r.URL.Query().Get("url")
	if !s.links.Cached(link) && !s.previews.take(who(r).Name) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many new links: wait a few minutes"})
		return
	}
	p, err := s.links.Get(r.Context(), link)
	if errors.Is(err, preview.ErrBadURL) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		return // the page went away
	}
	writeJSON(w, http.StatusOK, p)
}

// previewImage serves a cached preview image. Ids are content hashes, so they never change.
func (s *Server) previewImage(w http.ResponseWriter, r *http.Request) {
	path := s.links.ImagePath(r.PathValue("id"))
	f, err := os.Open(path)
	if path == "" || err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, _ := f.Stat()
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	http.ServeContent(w, r, path, info.ModTime(), f)
}
