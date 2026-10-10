// Package workspace stores the shared files as a git repository. Every write is a
// commit authored by the user who made it, so history, blame and revert come from git.
//
// People may also edit the files directly on the box (ssh, cd, any editor). Before
// listing or changing anything, the server commits such edits (see syncDisk), so they
// get history and the conflict check sees them.
//
// Files under large/ (worlds, client packs), media/ (pictures and videos posted in chat,
// a folder per chat), screenshots/ and map art/ are plain files outside git: no history,
// because git handles big binaries badly and pictures never change. Their revision is size + modification time.
// Deleting or replacing one of those moves the old file to the trash (trash.go).
package workspace

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

var (
	ErrBadPath  = errors.New("invalid path")
	ErrNotFound = errors.New("not found")
	ErrExists   = errors.New("already exists")
)

// commitHash is the only revision form Read accepts (the page sends full hashes).
var commitHash = regexp.MustCompile(`^[0-9a-f]{7,64}$`)

// RefusedError is a request the workspace won't carry out, with a reason for the person.
type RefusedError struct{ Reason string }

func (e *RefusedError) Error() string { return e.Reason }

// MaxVersioned is the largest file kept in git; bigger ones go in large/.
const MaxVersioned = 50 << 20

// ConflictError means the file changed since the client opened it.
// Current is the file's latest revision ("" if it no longer exists).
type ConflictError struct{ Current string }

func (e *ConflictError) Error() string { return "file changed since base revision" }

type Author struct{ Name string }

// The areas kept outside git: LargeDir for big files, and the screenshots and map art
// folders.
const LargeDir = "large"

var areas = []string{LargeDir, "screenshots", "map art"}

// MediaDir isn't a folder in Files: chat links to files posted in a chat read
// media/<chat>/<file> (the chat keeps them), so Files keeps the name free.
const MediaDir = "media"

// errReserved refuses a path under MediaDir.
var errReserved = &RefusedError{"media/ is kept for files posted in chats"}

func reserved(p string) bool { return p == MediaDir || strings.HasPrefix(p, MediaDir+"/") }

// IsLarge reports whether p is in an area kept outside git.
func IsLarge(p string) bool {
	for _, a := range areas {
		if p == a || strings.HasPrefix(p, a+"/") {
			return true
		}
	}
	return false
}

// isArea reports whether p is one of those areas' own folders, which stay put.
func isArea(p string) bool { return slices.Contains(areas, p) }

type Entry struct {
	Path  string `json:"path"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mod   int64  `json:"mod"` // modification time, unix ms
	Large bool   `json:"large,omitempty"`
}

type Commit struct {
	Rev     string `json:"rev"`
	Author  string `json:"author"`
	Time    string `json:"time"`
	Message string `json:"message"`
}

type Workspace struct {
	dir   string
	trash string     // <dir>/../trash: old files from the areas outside git (trash.go)
	mu    sync.Mutex // serializes writes; git's index is single-writer
}

// Open uses dir as the workspace, creating it and initializing git if needed.
func Open(dir string) (*Workspace, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	w := &Workspace{dir: dir, trash: filepath.Join(filepath.Dir(dir), "trash")}
	if _, err := os.Stat(filepath.Join(dir, ".git")); errors.Is(err, fs.ErrNotExist) {
		if _, err := w.git(nil, "init", "-q", "-b", "master"); err != nil {
			return nil, err
		}
	}
	// Keep the areas out of git, without a .gitignore cluttering the tree.
	exclude := filepath.Join(dir, ".git", "info", "exclude")
	for _, a := range areas {
		if b, _ := os.ReadFile(exclude); !bytes.Contains(b, []byte("/"+a+"/")) {
			os.MkdirAll(filepath.Dir(exclude), 0o755)
			b = append(b, []byte("\n/"+a+"/\n")...)
			if err := os.WriteFile(exclude, b, 0o644); err != nil {
				return nil, err
			}
		}
		if err := os.MkdirAll(filepath.Join(dir, a), 0o755); err != nil {
			return nil, err
		}
	}
	return w, nil
}

// Clean normalizes a client path to a slash-separated path relative to the workspace root.
func Clean(p string) (string, error) {
	c := strings.TrimPrefix(path.Clean("/"+p), "/")
	if c == "" {
		return "", ErrBadPath
	}
	for _, part := range strings.Split(c, "/") {
		if isDotGit(part) {
			return "", ErrBadPath
		}
	}
	// No line breaks or other control characters: they'd break the history's records.
	if strings.ContainsFunc(c, unicode.IsControl) {
		return "", ErrBadPath
	}
	return c, nil
}

// isDotGit reports whether git would take a path part as its own .git folder and refuse it
// (core.protectNTFS, on by default): ".git" or "git~1" in any case, then only dots and spaces,
// optionally followed by ":" and anything. Letting one through stalls every later commit.
func isDotGit(part string) bool {
	low := strings.ToLower(part)
	rest, ok := strings.CutPrefix(low, ".git")
	if !ok {
		if rest, ok = strings.CutPrefix(low, "git~1"); !ok {
			return false
		}
	}
	rest, _, _ = strings.Cut(rest, ":")
	return strings.Trim(rest, ". ") == ""
}

func (w *Workspace) abs(p string) string { return filepath.Join(w.dir, filepath.FromSlash(p)) }

// Tree lists every file and directory, sorted by path. The page polls it, which is
// also what picks up direct edits within a few seconds.
func (w *Workspace) Tree() ([]Entry, error) {
	w.mu.Lock()
	err := w.syncDisk()
	w.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var out []Entry
	err = filepath.WalkDir(w.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == w.dir {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(w.dir, p)
		e := Entry{Path: filepath.ToSlash(rel), Dir: d.IsDir()}
		e.Large = IsLarge(e.Path)
		if !e.Dir {
			if info, err := d.Info(); err == nil {
				e.Size, e.Mod = info.Size(), info.ModTime().UnixMilli()
			}
		}
		out = append(out, e)
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, err
}

// Stat returns the size and latest revision of a file.
func (w *Workspace) Stat(p string) (size int64, rev string, err error) {
	info, err := os.Stat(w.abs(p))
	if errors.Is(err, fs.ErrNotExist) || (err == nil && info.IsDir()) {
		return 0, "", ErrNotFound
	}
	if err != nil {
		return 0, "", err
	}
	if IsLarge(p) {
		return info.Size(), largeRev(info), nil
	}
	rev, err = w.Rev(p)
	return info.Size(), rev, err
}

func largeRev(info fs.FileInfo) string {
	return fmt.Sprintf("L%d-%d", info.Size(), info.ModTime().UnixNano())
}

// OpenFile opens the current version of p for streaming.
func (w *Workspace) OpenFile(p string) (*os.File, fs.FileInfo, error) {
	f, err := os.Open(w.abs(p))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err == nil && info.IsDir() {
		err = ErrNotFound
	}
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, info, nil
}

// Rev returns the last commit that touched p, or "" if none has.
func (w *Workspace) Rev(p string) (string, error) {
	out, err := w.git(nil, "log", "-1", "--format=%H", "--", p)
	if err != nil {
		return "", nil // no commits yet
	}
	return strings.TrimSpace(string(out)), nil
}

// Read returns the file at rev, or the current file when rev is "".
func (w *Workspace) Read(p, rev string) ([]byte, error) {
	if rev == "" {
		data, err := os.ReadFile(w.abs(p))
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return data, err
	}
	// rev reaches git's command line: only a commit hash, never an option like --output.
	if !commitHash.MatchString(rev) {
		return nil, ErrNotFound
	}
	data, err := w.git(nil, "show", rev+":"+p)
	if err != nil {
		// From before a rename: the file had another name at rev.
		if old := w.pathAt(p, rev); old != "" {
			data, err = w.git(nil, "show", rev+":"+old)
		}
	}
	if err != nil {
		return nil, ErrNotFound
	}
	return data, nil
}

// pathAt is the name p had at commit rev, following renames; "" if rev isn't in its history.
func (w *Workspace) pathAt(p, rev string) string {
	full, err := w.git(nil, "rev-parse", "--verify", "-q", rev+"^{commit}")
	if err != nil {
		return ""
	}
	out, err := w.git(nil, "log", "--follow", "--name-only", "--format=%x1e%H", "--", p)
	if err != nil {
		return ""
	}
	// Records are "<hash>\n\n<name>\n".
	for _, rec := range strings.Split(string(out), "\x1e") {
		lines := strings.Split(strings.TrimSpace(rec), "\n")
		if len(lines) >= 2 && lines[0] == strings.TrimSpace(string(full)) {
			return lines[len(lines)-1]
		}
	}
	return ""
}

// Write saves data to p. See WriteFrom.
func (w *Workspace) Write(p string, data []byte, baseRev string, a Author) (string, error) {
	return w.WriteFrom(p, bytes.NewReader(data), baseRev, a)
}

// WriteFrom saves the contents of r to p: a commit, or for large/ just the file.
// baseRev is the revision the client started from; "" means "create a new file". If the
// file has changed since baseRev, it returns a *ConflictError and writes nothing.
//
// r is copied to a temp file before taking the lock, so a slow multi-GB upload doesn't
// hold up everyone else's saves. The temp file is then renamed into place: atomic, and
// it lives in .git so a crash can't leave litter in the tree.
func (w *Workspace) WriteFrom(p string, r io.Reader, baseRev string, a Author) (string, error) {
	// Callers clean their paths; this is the last look, because a name with a line break would
	// write its own records into the history (see Moves).
	if c, err := Clean(p); err != nil || c != p {
		return "", ErrBadPath
	}
	if reserved(p) {
		return "", errReserved
	}
	tmp, err := w.spool(r)
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp) // no-op once renamed into place

	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.syncDisk(); err != nil {
		return "", err
	}

	_, cur, err := w.Stat(p)
	exists := err == nil
	if err != nil && !errors.Is(err, ErrNotFound) {
		return "", err
	}
	if exists && cur != baseRev || !exists && baseRev != "" {
		return "", &ConflictError{Current: cur}
	}
	if info, err := os.Stat(w.abs(p)); err == nil && info.IsDir() {
		return "", &RefusedError{"there’s a folder with that name"}
	}
	if err := os.MkdirAll(filepath.Dir(w.abs(p)), 0o755); err != nil {
		return "", err
	}
	if exists && IsLarge(p) {
		if err := w.toTrash(p, "replace", a, time.Now()); err != nil {
			return "", err
		}
	}
	if err := os.Rename(tmp, w.abs(p)); err != nil {
		return "", err
	}
	if IsLarge(p) {
		_, rev, err := w.Stat(p)
		return rev, err
	}
	verb := "Edit"
	if !exists {
		verb = "Add"
	}
	rev, err := w.commit(a, fmt.Sprintf("%s %s", verb, p), p)
	if err != nil {
		// Put things back as they were, so the file isn't left on disk outside history.
		w.git(nil, "reset", "-q", "--", p)
		if exists {
			w.git(nil, "checkout", "--", p)
		} else {
			os.Remove(w.abs(p))
			w.removeEmptyParents(p)
		}
	}
	return rev, err
}

// Move renames a file or folder, possibly into another folder, as one commit (git follows
// the history across it). Moving into or out of large/ or media/ takes files out of or into
// git, so nothing over MaxVersioned may leave them. Those folders themselves stay put.
func (w *Workspace) Move(from, to string, a Author) error {
	if isArea(from) || isArea(to) || to == from || strings.HasPrefix(to, from+"/") {
		return ErrBadPath
	}
	if c, err := Clean(to); err != nil || c != to {
		return ErrBadPath
	}
	if reserved(to) {
		return errReserved
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.syncDisk(); err != nil {
		return err
	}

	if _, err := os.Lstat(w.abs(from)); errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if _, err := os.Lstat(w.abs(to)); err == nil {
		return ErrExists
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if IsLarge(from) && !IsLarge(to) {
		err := filepath.WalkDir(w.abs(from), func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if info, err := d.Info(); err == nil && !d.IsDir() && info.Size() > MaxVersioned {
				return &RefusedError{fmt.Sprintf("%s is over 50 MB, so it has to stay in %s/", d.Name(), strings.SplitN(from, "/", 2)[0])}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(w.abs(to)), 0o755); err != nil {
		return err
	}
	if err := os.Rename(w.abs(from), w.abs(to)); err != nil {
		return err
	}
	w.removeEmptyParents(from)
	// syncDisk just ran, so the only changes on disk are this move. The commit message is
	// the move record (see Moves); within large/ the commit is empty, just the record.
	// Forced, like every add, unless it went into an area outside git.
	if _, err := w.git(nil, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", from); err != nil {
		return err
	}
	if !IsLarge(to) {
		if _, err := w.git(nil, "add", "-A", "-f", "--", to); err != nil {
			return err
		}
	}
	verb := "Rename"
	if path.Dir(from) != path.Dir(to) {
		verb = "Move"
	}
	// The subject is for people; the record line, for Moves, can't be misread whatever the
	// names hold (" → " in one used to split it in the wrong place).
	record, _ := json.Marshal(Moved{From: from, To: to})
	_, err := w.git(authorEnv(a), "commit", "-q", "--no-verify", "--allow-empty", "-m",
		fmt.Sprintf("%s %s%s%s", verb, from, moveArrow, to), "-m", movedPrefix+string(record))
	return err
}

const movedPrefix = "Moved: "

const moveArrow = " → "

// Moved is one rename or move, as recorded by Move.
type Moved struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Author string `json:"author,omitempty"`
}

// Moves lists every rename and move, oldest first, read back from Move's commit
// messages. They're how old links find a file that has moved (folders included); git's
// own rename detection would miss empty files and everything in large/.
func (w *Workspace) Moves() ([]Moved, error) {
	out, err := w.git(nil, "log", "--reverse", "-E", "--grep=^(Rename|Move) ", "--format=%an%x1f%s%x1f%b%x1e")
	if err != nil {
		return nil, nil // no commits yet
	}
	var moves []Moved
	for _, rec := range strings.Split(string(out), "\x1e") {
		f := strings.SplitN(strings.TrimLeft(rec, "\n"), "\x1f", 3)
		if len(f) != 3 {
			continue
		}
		var m Moved
		for _, line := range strings.Split(f[2], "\n") {
			if r, ok := strings.CutPrefix(line, movedPrefix); ok && json.Unmarshal([]byte(r), &m) == nil {
				break
			}
		}
		if m.From == "" { // recorded before the record line (2026-10-05): the subject
			_, rest, _ := strings.Cut(f[1], " ")
			m.From, m.To, _ = strings.Cut(rest, moveArrow)
		}
		if m.From != "" && m.To != "" {
			m.Author = f[0]
			moves = append(moves, m)
		}
	}
	return moves, nil
}

// Mkdir creates an empty folder. It shows in the tree but git doesn't store it until a
// file goes in.
func (w *Workspace) Mkdir(p string) error {
	if reserved(p) {
		return errReserved
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := os.Lstat(w.abs(p)); err == nil {
		return ErrExists
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.MkdirAll(w.abs(p), 0o755)
}

// Zip writes folder p and everything in it to out as a zip, paths starting with the
// folder's name. Files in large/ and already-compressed formats are stored, not
// recompressed, so big worlds stream at disk speed.
func (w *Workspace) Zip(p string, out io.Writer) error {
	root := w.abs(p)
	if info, err := os.Stat(root); errors.Is(err, fs.ErrNotExist) || err == nil && !info.IsDir() {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	zw := zip.NewWriter(out)
	base := filepath.Dir(root)
	err := filepath.WalkDir(root, func(f string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(base, f)
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if d.IsDir() {
			hdr.Name += "/"
			_, err = zw.CreateHeader(hdr)
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		hdr.Method = zip.Deflate
		if IsLarge(p) || compressed[strings.ToLower(path.Ext(d.Name()))] {
			hdr.Method = zip.Store
		}
		dst, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		src, err := os.Open(f)
		if err != nil {
			return err
		}
		defer src.Close()
		_, err = io.Copy(dst, src)
		return err
	})
	if cerr := zw.Close(); err == nil {
		err = cerr
	}
	return err
}

// compressed formats gain nothing from deflate (.litematic, .nbt and .mca are gzip/zlib inside).
var compressed = map[string]bool{
	".zip": true, ".jar": true, ".gz": true, ".tgz": true, ".xz": true, ".zst": true, ".7z": true,
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".mp4": true,
	".webm": true, ".mkv": true, ".mp3": true, ".ogg": true, ".litematic": true, ".nbt": true,
	".mca": true, ".schem": true,
}

// DeleteDir removes a folder and everything in it as one commit (or, in an area outside
// git, moves it to the trash). The areas' own folders stay.
func (w *Workspace) DeleteDir(p string, a Author) error {
	if isArea(p) {
		return ErrBadPath
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.syncDisk(); err != nil {
		return err
	}
	if info, err := os.Stat(w.abs(p)); errors.Is(err, fs.ErrNotExist) || err == nil && !info.IsDir() {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if IsLarge(p) {
		if err := w.toTrash(p, "delete", a, time.Now()); err != nil {
			return err
		}
		w.removeEmptyParents(p)
		return nil
	}
	if err := os.RemoveAll(w.abs(p)); err != nil {
		return err
	}
	w.removeEmptyParents(p)
	if _, err := w.git(nil, "add", "-A"); err != nil {
		return err
	}
	_, err := w.commit(a, "Delete "+p+"/")
	return err
}

// removeEmptyParents removes the folders above p that are now empty, as git rm does,
// stopping at the root and at large/ and media/.
func (w *Workspace) removeEmptyParents(p string) {
	for d := path.Dir(p); d != "." && !isArea(d); d = path.Dir(d) {
		if os.Remove(w.abs(d)) != nil { // fails unless empty
			return
		}
	}
}

// Delete removes p as a commit (or, outside git, moves it to the trash), with the same
// conflict rule as Write.
func (w *Workspace) Delete(p, baseRev string, a Author) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.syncDisk(); err != nil {
		return err
	}

	_, cur, err := w.Stat(p)
	if err != nil {
		return err
	}
	if cur != baseRev {
		return &ConflictError{Current: cur}
	}
	if IsLarge(p) {
		if err := w.toTrash(p, "delete", a, time.Now()); err != nil {
			return err
		}
		w.removeEmptyParents(p)
		return nil
	}
	if _, err := w.git(nil, "rm", "-q", "--", p); err != nil {
		return err
	}
	_, err = w.commit(a, "Delete "+p)
	return err
}

// History lists the commits that touched p, newest first. Large files have none.
func (w *Workspace) History(p string) ([]Commit, error) {
	if IsLarge(p) {
		return nil, nil
	}
	out, err := w.git(nil, "log", "--follow", "--format=%H%x1f%an%x1f%aI%x1f%s", "--", p)
	if err != nil {
		return nil, nil // no commits yet
	}
	var hist []Commit
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, "\x1f")
		if len(f) == 4 {
			hist = append(hist, Commit{Rev: f[0], Author: f[1], Time: f[2], Message: f[3]})
		}
	}
	return hist, nil
}

// spool copies r into a new temp file inside .git and returns its path.
func (w *Workspace) spool(r io.Reader) (string, error) {
	f, err := os.CreateTemp(filepath.Join(w.dir, ".git"), "mthub-upload-*")
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(f.Name(), 0o644)
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// syncDisk commits anything changed on disk outside the server: direct edits over ssh,
// credited to whoever owns the changed files. Callers hold w.mu.
func (w *Workspace) syncDisk() error {
	out, err := w.git(nil, "status", "--porcelain", "-z", "--untracked-files=all")
	if err != nil || len(out) == 0 {
		return err
	}
	var paths []string
	for _, rec := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00") {
		if len(rec) > 3 {
			paths = append(paths, rec[3:])
		}
	}
	if _, err := w.git(nil, "add", "-A"); err != nil {
		return err
	}
	msg := "Edit on the box: " + strings.Join(paths, ", ")
	if len(paths) > 3 {
		msg = fmt.Sprintf("Edit on the box: %s and %d more", strings.Join(paths[:3], ", "), len(paths)-3)
	}
	_, err = w.commit(Author{Name: w.ownerOf(paths)}, msg)
	return err
}

// ownerOf names the person who most likely made a direct edit: the most common owner
// of the changed files (root doesn't count). Deleted files have no owner.
func (w *Workspace) ownerOf(paths []string) string {
	counts := map[string]int{}
	best := "direct-edit"
	for _, p := range paths {
		info, err := os.Lstat(w.abs(p))
		if err != nil {
			continue
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			continue
		}
		u, err := user.LookupId(fmt.Sprint(st.Uid))
		if err != nil || u.Username == "root" {
			continue
		}
		counts[u.Username]++
		if counts[u.Username] > counts[best] {
			best = u.Username
		}
	}
	return best
}

// commit stages paths (if any) and commits. Saving identical content is not an error:
// it returns the file's existing revision. The add is forced: a .gitignore someone put in
// Files is just a file, and can't keep what's saved out of history.
func (w *Workspace) commit(a Author, msg string, paths ...string) (string, error) {
	if len(paths) > 0 {
		if _, err := w.git(nil, append([]string{"add", "-f", "--"}, paths...)...); err != nil {
			return "", err
		}
	}
	if _, err := w.git(nil, "diff", "--cached", "--quiet"); err == nil {
		if len(paths) > 0 {
			return w.Rev(paths[0])
		}
		return "", nil
	}
	if _, err := w.git(authorEnv(a), "commit", "-q", "--no-verify", "-m", msg); err != nil {
		return "", err
	}
	out, err := w.git(nil, "rev-parse", "HEAD")
	return strings.TrimSpace(string(out)), err
}

// authorEnv credits a commit to a; the server itself is always the committer.
func authorEnv(a Author) []string {
	name := a.Name
	if name == "" {
		name = "unknown"
	}
	return []string{
		"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + name + "@mt-hub.local",
		"GIT_COMMITTER_NAME=mthub", "GIT_COMMITTER_EMAIL=mthub@mt-hub.local",
	}
}

func (w *Workspace) git(env []string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-c", "core.quotepath=off", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = w.dir
	// Ignore the host user's git config so the server behaves the same everywhere.
	// Paths are names, never patterns: "what?.md" and "*.md" mean only those files.
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_LITERAL_PATHSPECS=1")
	cmd.Env = append(cmd.Env, env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}
