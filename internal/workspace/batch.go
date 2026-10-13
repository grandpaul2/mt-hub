package workspace

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Several files and folders at once: a selection moved, deleted, copied or downloaded. Each
// is all or nothing where that can be had, and one commit, so the history and everyone's
// page see one change and not one per file.

// MaxBatch is the most paths one call takes.
const MaxBatch = 5000

// ClashError is a name already taken where something was to land. It counts as ErrExists.
type ClashError struct{ Name, Dir string }

func (e *ClashError) Error() string {
	if e.Dir == "" {
		return e.Name + " already exists at the top"
	}
	return fmt.Sprintf("%s already exists in %s/", e.Name, e.Dir)
}

func (e *ClashError) Is(target error) bool { return target == ErrExists }

// roots cleans paths and drops repeats and anything inside a folder that is also listed, so
// a folder picked together with its own files counts once.
func roots(paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, ErrBadPath
	}
	if len(paths) > MaxBatch {
		return nil, &RefusedError{fmt.Sprintf("that’s more than %d at once", MaxBatch)}
	}
	listed := map[string]bool{}
	clean := make([]string, 0, len(paths))
	for _, p := range paths {
		c, err := Clean(p)
		if err != nil {
			return nil, err
		}
		if !listed[c] {
			listed[c] = true
			clean = append(clean, c)
		}
	}
	out := clean[:0]
	for _, p := range clean {
		covered := false
		for d := path.Dir(p); d != "."; d = path.Dir(d) {
			covered = covered || listed[d]
		}
		if !covered {
			out = append(out, p)
		}
	}
	return out, nil
}

// cleanDir is a folder to land in: "" is the top.
func cleanDir(dir string) (string, error) {
	if dir == "" {
		return "", nil
	}
	c, err := Clean(dir)
	if err != nil {
		return "", err
	}
	if reserved(c) {
		return "", errReserved
	}
	return c, nil
}

func join(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

// within reports whether p is dir or inside it.
func within(p, dir string) bool { return p == dir || strings.HasPrefix(p, dir+"/") }

// fitsGit refuses anything under from (in an area outside git) that is too big to go into git.
func (w *Workspace) fitsGit(from string) error {
	return filepath.WalkDir(w.abs(from), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if info, err := d.Info(); err == nil && !d.IsDir() && info.Size() > MaxVersioned {
			return &RefusedError{fmt.Sprintf("%s is over 50 MB, so it has to stay in %s/", d.Name(), strings.SplitN(from, "/", 2)[0])}
		}
		return nil
	})
}

// gitEach runs a git command over paths a few hundred at a time, so a big selection can't
// outgrow the command line.
func (w *Workspace) gitEach(paths []string, args ...string) error {
	for len(paths) > 0 {
		n := min(len(paths), 200)
		if _, err := w.git(nil, append(append([]string{}, args...), paths[:n]...)...); err != nil {
			return err
		}
		paths = paths[n:]
	}
	return nil
}

// commitMessage commits what is staged with a message of any length (it goes in a file).
// Nothing staged is fine unless empty is set, which commits the message alone.
func (w *Workspace) commitMessage(a Author, msg string, empty bool) error {
	if !empty {
		if _, err := w.git(nil, "diff", "--cached", "--quiet"); err == nil {
			return nil
		}
	}
	f, err := os.CreateTemp(filepath.Join(w.dir, ".git"), "mthub-message-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.WriteString(msg)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	// --cleanup=verbatim: a name starting with "#" must stay in the message.
	_, err = w.git(authorEnv(a), "commit", "-q", "--no-verify", "--allow-empty", "--cleanup=verbatim", "-F", f.Name())
	return err
}

// MoveAll moves several files and folders into the folder toDir ("" is the top), keeping
// their names, as one commit with a move record for each (see Moves). If any of them can't
// move (a name taken there, a folder into itself, an area's own folder), none does.
func (w *Workspace) MoveAll(from []string, toDir string, a Author) error {
	from, err := roots(from)
	if err != nil {
		return err
	}
	if toDir, err = cleanDir(toDir); err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.syncDisk(); err != nil {
		return err
	}

	to := make([]string, len(from))
	landing := map[string]bool{}
	for i, f := range from {
		name := path.Base(f)
		to[i] = join(toDir, name)
		switch {
		case isArea(f):
			return &RefusedError{f + "/ stays where it is"}
		case path.Dir(f) == toDir || path.Dir(f) == "." && toDir == "":
			return &RefusedError{name + " is already there"}
		case toDir != "" && within(toDir, f):
			return &RefusedError{name + " can’t move into itself"}
		case reserved(to[i]):
			return errReserved
		case landing[to[i]]:
			return &RefusedError{fmt.Sprintf("two of them are named %s", name)}
		}
		landing[to[i]] = true
		if _, err := os.Lstat(w.abs(f)); errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if _, err := os.Lstat(w.abs(to[i])); err == nil {
			return &ClashError{name, toDir}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if IsLarge(f) && !IsLarge(to[i]) {
			if err := w.fitsGit(f); err != nil {
				return err
			}
		}
	}

	if toDir != "" {
		if err := os.MkdirAll(w.abs(toDir), 0o755); err != nil {
			return err
		}
	}
	for i, f := range from {
		if err := os.Rename(w.abs(f), w.abs(to[i])); err != nil {
			for j := range i { // put back what already moved
				os.Rename(w.abs(to[j]), w.abs(from[j]))
			}
			return err
		}
	}
	var staged []string
	records := make([]string, len(from))
	for i, f := range from {
		w.removeEmptyParents(f)
		if !IsLarge(to[i]) {
			staged = append(staged, to[i])
		}
		rec, _ := json.Marshal(Moved{From: f, To: to[i]})
		records[i] = movedPrefix + string(rec)
	}
	if err := w.gitEach(from, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--"); err != nil {
		return err
	}
	if err := w.gitEach(staged, "add", "-A", "-f", "--"); err != nil {
		return err
	}
	subject := fmt.Sprintf("Move %s%s%s", from[0], moveArrow, to[0])
	if len(from) > 1 {
		subject = fmt.Sprintf("Move %d items%s%s/", len(from), moveArrow, toDir)
	}
	return w.commitMessage(a, subject+"\n\n"+strings.Join(records, "\n")+"\n", true)
}

// DeleteAll deletes several files and folders as one commit; those in an area outside git go
// to the trash. If one is missing or is an area's own folder, nothing is deleted.
func (w *Workspace) DeleteAll(paths []string, a Author) error {
	paths, err := roots(paths)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.syncDisk(); err != nil {
		return err
	}
	names := make([]string, len(paths))
	for i, p := range paths {
		if isArea(p) {
			return &RefusedError{p + "/ itself can’t be deleted"}
		}
		info, err := os.Lstat(w.abs(p))
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		names[i] = p
		if info.IsDir() {
			names[i] += "/"
		}
	}
	now := time.Now()
	for _, p := range paths {
		if IsLarge(p) {
			err = w.toTrash(p, "delete", a, now)
		} else {
			err = os.RemoveAll(w.abs(p))
		}
		if err != nil {
			break
		}
		w.removeEmptyParents(p)
	}
	// Whatever went is committed, also when one of them failed part way.
	if _, gerr := w.git(nil, "add", "-A"); gerr != nil {
		return gerr
	}
	subject := "Delete " + names[0]
	if len(names) > 1 {
		subject = fmt.Sprintf("Delete %d items", len(names))
	}
	if cerr := w.commitMessage(a, subject+"\n\n"+strings.Join(names, "\n")+"\n", false); err == nil {
		err = cerr
	}
	return err
}

// Size is the bytes in the files and folders listed: what a copy of them would add.
func (w *Workspace) Size(paths []string) (int64, error) {
	paths, err := roots(paths)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, p := range paths {
		err := filepath.WalkDir(w.abs(p), func(_ string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if info, err := d.Info(); err == nil && info.Mode().IsRegular() {
				total += info.Size()
			}
			return nil
		})
		if errors.Is(err, fs.ErrNotExist) {
			return 0, ErrNotFound
		} else if err != nil {
			return 0, err
		}
	}
	return total, nil
}

// copyName is the name a copy of name gets in dir: its own if that is free, else
// "name copy.md", then "name copy 2.md" and so on. taken holds names already given out.
func (w *Workspace) copyName(dir, name string, isDir bool, taken map[string]bool) string {
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
		c := stem + " copy" + ext
		if n > 1 {
			c = fmt.Sprintf("%s copy %d%s", stem, n, ext)
		}
		if free(c) {
			return c
		}
	}
}

// copyTree copies the file or folder src to dst, which must not exist. Only folders and
// ordinary files are copied.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		to := filepath.Join(dst, rel)
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return os.Mkdir(to, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		return err
	})
}

// CopyAll copies several files and folders into the folder toDir ("" is the top) as one
// commit, and returns where each landed. A name taken there gets " copy" (see copyName), so
// a copy into its own folder is a duplicate. History follows a copy back to its original.
//
// The bytes are copied aside before taking the lock, as an upload is, so a big copy doesn't
// hold up everyone's saves; under the lock they are only renamed into place.
func (w *Workspace) CopyAll(from []string, toDir string, a Author) ([]string, error) {
	from, err := roots(from)
	if err != nil {
		return nil, err
	}
	if toDir, err = cleanDir(toDir); err != nil {
		return nil, err
	}
	isDir := make([]bool, len(from))
	for i, f := range from {
		info, err := os.Lstat(w.abs(f))
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		} else if err != nil {
			return nil, err
		}
		isDir[i] = info.IsDir()
		if toDir != "" && isDir[i] && within(toDir, f) {
			return nil, &RefusedError{path.Base(f) + " can’t be copied into itself"}
		}
		if IsLarge(f) && !IsLarge(join(toDir, "x")) {
			if err := w.fitsGit(f); err != nil {
				return nil, err
			}
		}
	}
	aside, err := os.MkdirTemp(filepath.Join(w.dir, ".git"), "mthub-copy-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(aside)
	for i, f := range from {
		if err := copyTree(w.abs(f), filepath.Join(aside, fmt.Sprint(i))); errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		} else if err != nil {
			return nil, err
		}
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.syncDisk(); err != nil {
		return nil, err
	}
	if toDir != "" {
		if info, err := os.Stat(w.abs(toDir)); err == nil && !info.IsDir() {
			return nil, &RefusedError{"a file can’t have files inside it"}
		}
		if err := os.MkdirAll(w.abs(toDir), 0o755); err != nil {
			return nil, err
		}
	}
	to := make([]string, 0, len(from))
	taken := map[string]bool{}
	undo := func() {
		for _, t := range to {
			os.RemoveAll(w.abs(t))
		}
	}
	for i, f := range from {
		t := join(toDir, w.copyName(toDir, path.Base(f), isDir[i], taken))
		if reserved(t) {
			undo()
			return nil, errReserved
		}
		taken[t] = true
		if err := os.Rename(filepath.Join(aside, fmt.Sprint(i)), w.abs(t)); err != nil {
			undo()
			return nil, err
		}
		to = append(to, t)
	}
	if IsLarge(join(toDir, "x")) {
		return to, nil
	}
	subject := fmt.Sprintf("Copy %s%s%s", from[0], moveArrow, to[0])
	if len(from) > 1 {
		subject = fmt.Sprintf("Copy %d items%s%s/", len(from), moveArrow, toDir)
	}
	err = w.gitEach(to, "add", "-A", "-f", "--")
	if err == nil {
		err = w.commitMessage(a, subject+"\n\n"+strings.Join(to, "\n")+"\n", false)
	}
	if err != nil {
		w.gitEach(to, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--")
		undo()
		return nil, err
	}
	return to, nil
}

// ZipAll writes several files and folders to out as one zip. In one folder, their names
// start there; from several folders, each keeps its whole path. Nothing is written if one
// is missing.
func (w *Workspace) ZipAll(paths []string, out io.Writer) error {
	paths, err := roots(paths)
	if err != nil {
		return err
	}
	base := path.Dir(paths[0])
	for _, p := range paths {
		if _, err := os.Lstat(w.abs(p)); errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if path.Dir(p) != base {
			base = "."
		}
	}
	zw := zip.NewWriter(out)
	for _, p := range paths {
		if err = zipTree(zw, w.abs(base), w.abs(p), IsLarge(p)); err != nil {
			break
		}
	}
	if cerr := zw.Close(); err == nil {
		err = cerr
	}
	return err
}

// zipTree adds root (a file, or a folder and everything in it) to zw, named from base down.
// Files in an area outside git (stored) and already-compressed formats are not recompressed,
// so big worlds stream at disk speed.
func zipTree(zw *zip.Writer, base, root string, stored bool) error {
	return filepath.WalkDir(root, func(f string, d fs.DirEntry, err error) error {
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
		if stored || compressed[strings.ToLower(path.Ext(d.Name()))] {
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
}
