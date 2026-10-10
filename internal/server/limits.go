package server

import (
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"sync"
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
	free, ok := diskFree(filepath.Dir(s.thumbs))
	if !ok {
		return true // can't tell: don't block uploads over it
	}
	if free-max(size, 0) < MinFree {
		writeJSON(w, http.StatusInsufficientStorage, map[string]string{"error": diskFull})
		return false
	}
	return true
}

const diskFull = "the hub's disk is nearly full: tell an admin"

// diskFree is the space left on the disk holding dir (the tests replace it).
var diskFree = func(dir string) (int64, bool) {
	var st syscall.Statfs_t
	if syscall.Statfs(dir, &st) != nil {
		return 0, false
	}
	return int64(st.Bavail) * int64(st.Bsize), true
}

// roomFor asks once, before an upload starts. A big upload is also watched while it arrives:
// one that didn't say its size, or several at once that each fit alone, would otherwise go
// straight through the floor. floored stops reading when the disk gets there.
var (
	errDiskFull       = errors.New("disk nearly full")
	floorStep   int64 = 32 << 20 // how much may arrive between looks
)

type flooredReader struct {
	r     io.Reader
	dir   string
	since int64
}

func (s *Server) floored(r io.Reader) io.Reader {
	return &flooredReader{r: r, dir: filepath.Dir(s.thumbs)}
}

func (f *flooredReader) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if f.since += int64(n); f.since >= floorStep {
		f.since = 0
		if free, ok := diskFree(f.dir); ok && free < MinFree {
			return n, errDiskFull
		}
	}
	return n, err
}

// budget is how many bytes each key may send in a day (a game server's screenshots).
type budget struct {
	mu   sync.Mutex
	day  string
	used map[string]int64
}

// spend counts n bytes for key today, or says false if that would pass limit.
func (b *budget) spend(key string, n, limit int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if day := time.Now().UTC().Format(time.DateOnly); day != b.day {
		b.day, b.used = day, map[string]int64{}
	}
	if b.used[key]+n > limit {
		return false
	}
	b.used[key] += n
	return true
}

// Link previews the hub hasn't fetched yet: each person may ask for previewTries in
// previewWindow (pasting a list of links is fine; a script asking for thousands isn't).
var (
	shotsPerDay = 300 // screenshots a game server's token may post in a day
	// A game server's screenshot is held in memory while it's stored, so a token's are capped
	// well under a member's upload (the mod sends at most 20 MB) and taken two at a time.
	maxTokenShot = int64(20 << 20)
	// ...and at most this much in a day, whatever the count: 300 real screenshots are under 2 GB.
	tokenShotBytes = int64(2 << 30)
	shotBytes      budget
	tokenShotSlots = make(chan struct{}, 2)
	previewTries   = 60
	previewWindow  = 10 * time.Minute
)
