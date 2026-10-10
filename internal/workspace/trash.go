package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The areas outside git have no history to fall back on, so deleting or replacing a file
// there moves the old one to <trash>/<time> <who>/<its path> instead of erasing it, and
// <trash>/log.jsonl records who did what. Entries older than TrashDays are purged; the log
// stays. Restoring is by hand over ssh (server/hub/README.md in the macrotech-ops repo, "Trash").
const TrashDays = 30

const trashStamp = "2006-01-02 15-04-05.000"

type trashRecord struct {
	Time   string `json:"time"`
	Who    string `json:"who"`
	Action string `json:"action"` // "delete" or "replace"
	Path   string `json:"path"`
	Trash  string `json:"trash"` // where it went, relative to the trash folder
}

// toTrash moves p (a file or folder in an area outside git) to the trash. If it can't be
// moved there, nothing is deleted. Callers hold w.mu.
func (w *Workspace) toTrash(p, action string, a Author, now time.Time) error {
	return w.trashFrom(w.abs(p), p, action, a, now)
}

// Trash moves src, a file kept outside the workspace (a file posted in a chat), to the same
// trash, logged and filed there as p (say chat/general/media/x.png).
func (w *Workspace) Trash(src, p string, a Author) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.trashFrom(src, p, "delete", a, time.Now())
}

func (w *Workspace) trashFrom(src, p, action string, a Author, now time.Time) error {
	who := strings.NewReplacer("/", "_", "\\", "_").Replace(a.Name)
	if who == "" {
		who = "unknown"
	}
	entry := now.Format(trashStamp) + " " + who
	for n := 2; ; n++ {
		if _, err := os.Lstat(filepath.Join(w.trash, entry)); errors.Is(err, fs.ErrNotExist) {
			break
		}
		entry = fmt.Sprintf("%s %s (%d)", now.Format(trashStamp), who, n)
	}
	dst := filepath.Join(w.trash, entry, filepath.FromSlash(p))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		os.RemoveAll(filepath.Join(w.trash, entry))
		return err
	}
	line, _ := json.Marshal(trashRecord{now.Format(time.RFC3339), a.Name, action, p, entry + "/" + p})
	f, err := os.OpenFile(filepath.Join(w.trash, "log.jsonl"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(append(line, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// PurgeTrash removes trash entries older than TrashDays.
func (w *Workspace) PurgeTrash(now time.Time) error {
	entries, err := os.ReadDir(w.trash)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	cutoff := now.AddDate(0, 0, -TrashDays)
	for _, e := range entries {
		if !e.IsDir() || len(e.Name()) < len(trashStamp) {
			continue
		}
		t, err := time.ParseInLocation(trashStamp, e.Name()[:len(trashStamp)], now.Location())
		if err == nil && t.Before(cutoff) {
			if err := os.RemoveAll(filepath.Join(w.trash, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
