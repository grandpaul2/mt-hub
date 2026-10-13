package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Whatever is deleted in Files is moved to the trash for TrashDays, and can be brought back
// from the page: <trash>/<time> <who>/<its path>, one entry per thing moved, and
// <trash>/log.jsonl records who did what. That holds for files in git too (their removal is
// also a commit), for the old copy when a file outside git is replaced, and for files posted
// in chats that left their last message. Entries older than TrashDays are purged; the log
// stays.
const TrashDays = 30

const trashStamp = "2006-01-02 15-04-05.000"

type trashRecord struct {
	Time   string `json:"time"`
	Who    string `json:"who"`
	Action string `json:"action"` // "delete" or "replace"; "restore" and "purge" for the record
	Path   string `json:"path"`
	Trash  string `json:"trash"` // where it went, relative to the trash folder
	Dir    bool   `json:"dir,omitempty"`
	Size   int64  `json:"size,omitempty"`
	// Public: a chat file from a public chat, which the page may show. One from a private chat
	// or a DM is kept but never listed, and neither is one recorded before this field.
	Public bool `json:"public,omitempty"`
}

// chatPrefix starts the path a chat file is filed under: chat/<name>/media/<file>.
const chatPrefix = "chat/"

// TrashItem is one thing in the trash, as the page lists it.
type TrashItem struct {
	ID       string `json:"id"`
	Path     string `json:"path"` // where it was (a chat file: its name)
	Chat     string `json:"chat,omitempty"`
	Dir      bool   `json:"dir"`
	Size     int64  `json:"size"`
	Who      string `json:"who"`
	Time     string `json:"time"`
	Replaced bool   `json:"replaced,omitempty"` // the old copy from a replace
}

// toTrash moves p (a file or folder in the workspace) to the trash and returns the entry's
// id. If it can't be moved there, nothing is deleted. Callers hold w.mu.
func (w *Workspace) toTrash(p, action string, a Author, now time.Time) (string, error) {
	return w.trashFrom(w.abs(p), p, action, false, a, now)
}

// TrashChat moves src, a file posted in a chat (kept outside the workspace), to the same
// trash, filed as chat/<chat>/media/<file>. public says the chat is one everyone can read.
func (w *Workspace) TrashChat(src, chat, file string, public bool, a Author) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, err := w.trashFrom(src, chatPrefix+chat+"/media/"+file, "delete", public, a, time.Now())
	return err
}

func (w *Workspace) trashFrom(src, p, action string, public bool, a Author, now time.Time) (string, error) {
	who := strings.NewReplacer("/", "_", "\\", "_").Replace(a.Name)
	if who == "" {
		who = "unknown"
	}
	rec := trashRecord{Time: now.Format(time.RFC3339), Who: a.Name, Action: action, Path: p, Public: public}
	if info, err := os.Lstat(src); err == nil {
		rec.Dir = info.IsDir()
		rec.Size = treeSize(src)
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
		return "", err
	}
	if err := os.Rename(src, dst); err != nil {
		os.RemoveAll(filepath.Join(w.trash, entry))
		return "", err
	}
	rec.Trash = entry + "/" + p
	return entry, w.logTrash(rec)
}

func (w *Workspace) logTrash(rec trashRecord) error {
	line, _ := json.Marshal(rec)
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

// treeSize is the bytes in a file, or in every file under a folder.
func treeSize(root string) int64 {
	var n int64
	filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil {
			if info, err := d.Info(); err == nil && info.Mode().IsRegular() {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

// trashRecords reads the log's record for every entry still in the trash, by id, newest
// first. An entry is still there until it is restored, deleted for good or purged.
func (w *Workspace) trashRecords() ([]trashRecord, error) {
	dirs, err := os.ReadDir(w.trash)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	there := map[string]bool{}
	for _, d := range dirs {
		if d.IsDir() {
			there[d.Name()] = true
		}
	}
	log, err := os.ReadFile(filepath.Join(w.trash, "log.jsonl"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	var out []trashRecord
	for _, line := range strings.Split(string(log), "\n") {
		var r trashRecord
		if json.Unmarshal([]byte(line), &r) != nil || (r.Action != "delete" && r.Action != "replace") {
			continue
		}
		if id := trashID(r); there[id] {
			there[id] = false // (one record an entry)
			out = append(out, r)
		}
	}
	slices.Reverse(out)
	return out, nil
}

func trashID(r trashRecord) string { id, _, _ := strings.Cut(r.Trash, "/"); return id }

// listed: the page may show it. A chat file from a private chat or a DM never is.
func (r trashRecord) listed() bool { return !strings.HasPrefix(r.Path, chatPrefix) || r.Public }

// TrashList is what the page shows of the trash, newest first.
func (w *Workspace) TrashList() ([]TrashItem, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	recs, err := w.trashRecords()
	items := []TrashItem{}
	for _, r := range recs {
		if !r.listed() {
			continue
		}
		it := TrashItem{ID: trashID(r), Path: r.Path, Dir: r.Dir, Size: r.Size, Who: r.Who, Time: r.Time, Replaced: r.Action == "replace"}
		if rest, ok := strings.CutPrefix(r.Path, chatPrefix); ok {
			it.Chat, it.Path, _ = strings.Cut(rest, "/media/")
		}
		items = append(items, it)
	}
	return items, err
}

// restoredName is the name something comes back under where its own is taken:
// "name (restored).md", then "name (restored 2).md".
func (w *Workspace) restoredName(dir, name string, isDir bool, taken map[string]bool) string {
	free := func(n string) bool {
		if taken[join(dir, n)] {
			return false
		}
		_, err := os.Lstat(w.abs(join(dir, n)))
		return errors.Is(err, fs.ErrNotExist)
	}
	if free(name) {
		return name
	}
	stem, ext := name, ""
	if e := path.Ext(name); !isDir && e != name {
		stem, ext = strings.TrimSuffix(name, e), e
	}
	for n := 1; ; n++ {
		c := stem + " (restored)" + ext
		if n > 1 {
			c = fmt.Sprintf("%s (restored %d)%s", stem, n, ext)
		}
		if free(c) {
			return c
		}
	}
}

// Restore brings entries back from the trash, as one commit, and returns where each landed.
// With toDir nil each goes back where it was (its folder made again if it is gone); with a
// folder named, into that folder. A chat file has no place in Files to go back to, so it
// needs a folder. A taken name gets " (restored)". All or nothing.
func (w *Workspace) Restore(ids []string, toDir *string, a Author) ([]string, error) {
	if len(ids) == 0 {
		return nil, ErrBadPath
	}
	if toDir != nil {
		d, err := cleanDir(*toDir)
		if err != nil {
			return nil, err
		}
		toDir = &d
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.syncDisk(); err != nil {
		return nil, err
	}
	recs, err := w.trashRecords()
	if err != nil {
		return nil, err
	}
	byID := map[string]trashRecord{}
	for _, r := range recs {
		if r.listed() {
			byID[trashID(r)] = r
		}
	}
	type move struct {
		rec      trashRecord
		src, dst string
	}
	var moves []move
	taken := map[string]bool{}
	for _, id := range ids {
		r, ok := byID[id]
		if !ok {
			return nil, ErrNotFound
		}
		delete(byID, id) // (listed twice: once)
		dir, name := path.Dir(r.Path), path.Base(r.Path)
		if dir == "." {
			dir = ""
		}
		switch {
		case toDir != nil:
			dir = *toDir
		case strings.HasPrefix(r.Path, chatPrefix):
			return nil, &RefusedError{name + " was posted in a chat: pick a folder to restore it to"}
		}
		src := filepath.Join(w.trash, filepath.FromSlash(r.Trash))
		if isArea(join(dir, name)) || reserved(join(dir, name)) {
			return nil, ErrBadPath
		}
		if !IsLarge(join(dir, name)) {
			var big string
			filepath.WalkDir(src, func(_ string, d fs.DirEntry, err error) error {
				if info, ierr := d.Info(); err == nil && ierr == nil && !d.IsDir() && info.Size() > MaxVersioned {
					big = d.Name()
				}
				return nil
			})
			if big != "" {
				return nil, &RefusedError{big + " is over 50 MB, so it can only go back into large/"}
			}
		}
		dst := join(dir, w.restoredName(dir, name, r.Dir, taken))
		taken[dst] = true
		moves = append(moves, move{r, src, dst})
	}
	var out, staged []string
	undo := func() {
		for i, d := range out {
			os.Rename(w.abs(d), moves[i].src)
		}
	}
	for _, m := range moves {
		if err := os.MkdirAll(filepath.Dir(w.abs(m.dst)), 0o755); err != nil {
			undo()
			return nil, err
		}
		if err := os.Rename(m.src, w.abs(m.dst)); err != nil {
			undo()
			return nil, err
		}
		out = append(out, m.dst)
		if !IsLarge(m.dst) {
			staged = append(staged, m.dst)
		}
	}
	subject := "Restore " + out[0] + " from Trash"
	if len(out) > 1 {
		subject = fmt.Sprintf("Restore %d items from Trash", len(out))
	}
	err = w.gitEach(staged, "add", "-A", "-f", "--")
	if err == nil {
		err = w.commitMessage(a, subject+"\n\n"+strings.Join(out, "\n")+"\n", false)
	}
	if err != nil {
		w.gitEach(staged, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--")
		undo()
		return nil, err
	}
	now := time.Now().Format(time.RFC3339)
	for i, m := range moves {
		os.RemoveAll(filepath.Join(w.trash, trashID(m.rec)))
		w.logTrash(trashRecord{Time: now, Who: a.Name, Action: "restore", Path: out[i], Trash: m.rec.Trash})
	}
	return out, nil
}

// DeleteForever erases entries the page lists (all of them when ids is nil: Empty Trash) and
// returns how many. What isn't listed (files from private chats) is left to the purge.
func (w *Workspace) DeleteForever(ids []string, a Author) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	recs, err := w.trashRecords()
	if err != nil {
		return 0, err
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	n := 0
	now := time.Now().Format(time.RFC3339)
	for _, r := range recs {
		id := trashID(r)
		if !r.listed() || (ids != nil && !want[id]) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(w.trash, id)); err != nil {
			return n, err
		}
		n++
		w.logTrash(trashRecord{Time: now, Who: a.Name, Action: "purge", Path: r.Path, Trash: r.Trash})
	}
	if ids != nil && n < len(want) {
		return n, ErrNotFound
	}
	return n, nil
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
