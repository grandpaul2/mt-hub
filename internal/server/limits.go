package server

import (
	"net/http"
	"path/filepath"
	"syscall"
	"time"
)

// MinFree is the disk space uploads never eat into: the hub's data shares its disk with
// the rest of the machine, so a member's uploads (or a broken script) can't fill it. The
// tests' hubs live on a small /tmp and set it lower (mthub -min-free).
var MinFree int64 = 20 << 30

// roomFor refuses an upload of size bytes (-1: not said, so just the floor) that would
// leave less than MinFree on the hub's disk.
func (s *Server) roomFor(w http.ResponseWriter, size int64) bool {
	var st syscall.Statfs_t
	if syscall.Statfs(filepath.Dir(s.thumbs), &st) != nil {
		return true // can't tell: don't block uploads over it
	}
	free := int64(st.Bavail) * int64(st.Bsize)
	if free-max(size, 0) < MinFree {
		writeJSON(w, http.StatusInsufficientStorage, map[string]string{"error": "the hub's disk is nearly full: tell Paul"})
		return false
	}
	return true
}

// Link previews the hub hasn't fetched yet: each person may ask for previewTries in
// previewWindow (pasting a list of links is fine; a script asking for thousands isn't).
var (
	shotsPerDay = 300 // screenshots a game server's token may post in a day
	// A game server's screenshot is held in memory while it's stored, so a token's are capped
	// well under a member's upload (the mod sends at most 20 MB) and taken two at a time.
	maxTokenShot   = int64(20 << 20)
	tokenShotSlots = make(chan struct{}, 2)
	previewTries   = 60
	previewWindow  = 10 * time.Minute
)
