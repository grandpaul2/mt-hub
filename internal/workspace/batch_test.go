package workspace

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"
)

func commits(t *testing.T, w *Workspace) int {
	t.Helper()
	out, err := w.git(nil, "rev-list", "--count", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, c := range strings.TrimSpace(string(out)) {
		n = n*10 + int(c-'0')
	}
	return n
}

func tracked(w *Workspace) string {
	out, _ := w.git(nil, "ls-files")
	return strings.Join(strings.Fields(strings.ReplaceAll(string(out), " ", "_")), " ")
}

func exists(w *Workspace, p string) bool {
	_, err := os.Lstat(w.abs(p))
	return err == nil
}

// Several things move as one commit with a record each; a folder listed with its own file
// counts once; and when one of them can't move, none does.
func TestMoveAll(t *testing.T) {
	w, _ := Open(t.TempDir())
	pat := Author{"pat"}
	for _, p := range []string{"a.md", "docs/b.md", "notes/n.md", "notes/deep/d.md", "dest/keep.md", "# odd.md", "large/w.zip"} {
		w.Write(p, []byte(p), "", pat)
	}
	before := commits(t, w)
	if err := w.MoveAll([]string{"a.md", "docs/b.md", "notes", "notes/deep/d.md", "# odd.md", "large/w.zip"}, "dest", pat); err != nil {
		t.Fatal(err)
	}
	if got := commits(t, w) - before; got != 1 {
		t.Fatalf("%d commits, want 1", got)
	}
	if got := tracked(w); got != "dest/#_odd.md dest/a.md dest/b.md dest/keep.md dest/notes/deep/d.md dest/notes/n.md dest/w.zip" {
		t.Fatalf("tracked: %s", got)
	}
	if exists(w, "docs") || exists(w, "notes") || exists(w, "large/w.zip") || !exists(w, "large") {
		t.Fatal("the old places weren't cleared (or large/ went)")
	}
	moves, _ := w.Moves()
	var got []string
	for _, m := range moves {
		got = append(got, m.From+">"+m.To+" "+m.Author)
	}
	want := "a.md>dest/a.md pat, docs/b.md>dest/b.md pat, notes>dest/notes pat, # odd.md>dest/# odd.md pat, large/w.zip>dest/w.zip pat"
	if strings.Join(got, ", ") != want {
		t.Fatalf("moves: %s", strings.Join(got, ", "))
	}
	if h, _ := w.History("dest/a.md"); len(h) != 2 || h[0].Message != "Move 5 items → dest/" {
		t.Fatalf("history: %+v", h)
	}

	// All or nothing: b.md is free at the top, keep.md is not.
	w.Write("keep.md", []byte("top"), "", pat)
	before = commits(t, w)
	err := w.MoveAll([]string{"dest/b.md", "dest/keep.md"}, "", pat)
	var clash *ClashError
	if !errors.Is(err, ErrExists) || !errors.As(err, &clash) || clash.Name != "keep.md" || err.Error() != "keep.md already exists at the top" {
		t.Fatalf("clash: %v", err)
	}
	var refused *RefusedError
	for name, c := range map[string]struct {
		from []string
		to   string
	}{
		"an area":         {[]string{"dest/b.md", "large"}, "dest/notes"},
		"into itself":     {[]string{"dest/b.md", "dest/notes"}, "dest/notes/deep"},
		"already there":   {[]string{"dest/b.md"}, "dest"},
		"same name twice": {[]string{"dest/keep.md", "keep.md"}, "dest/notes"},
		"into media":      {[]string{"dest/b.md"}, "media/x"},
	} {
		if err := w.MoveAll(c.from, c.to, pat); !errors.As(err, &refused) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := w.MoveAll([]string{"dest/b.md", "gone.md"}, "dest/notes", pat); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := w.MoveAll(nil, "", pat); !errors.Is(err, ErrBadPath) {
		t.Fatalf("nothing listed: %v", err)
	}
	if !exists(w, "dest/b.md") || exists(w, "b.md") || commits(t, w) != before {
		t.Fatal("a refused move moved something")
	}
}

// Several things are deleted as one commit; what is outside git goes to the trash; and when
// one can't be deleted, none is.
func TestDeleteAll(t *testing.T) {
	w, _ := Open(t.TempDir())
	pat := Author{"pat"}
	for _, p := range []string{"a.md", "docs/b.md", "docs/c.md", "notes/n.md", "keep.md", "large/w.zip", "large/x.zip"} {
		w.Write(p, []byte(p), "", pat)
	}
	before := commits(t, w)
	if _, err := w.DeleteAll([]string{"a.md", "large"}, pat); err == nil {
		t.Fatal("deleted large/ itself")
	}
	if _, err := w.DeleteAll([]string{"a.md", "gone.md"}, pat); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if !exists(w, "a.md") || commits(t, w) != before {
		t.Fatal("a refused delete deleted something")
	}
	if _, err := w.DeleteAll([]string{"a.md", "docs/b.md", "notes", "notes/n.md", "large/w.zip"}, pat); err != nil {
		t.Fatal(err)
	}
	if got := commits(t, w) - before; got != 1 {
		t.Fatalf("%d commits, want 1", got)
	}
	if got := tracked(w); got != "docs/c.md keep.md" {
		t.Fatalf("tracked: %s", got)
	}
	if exists(w, "notes") || exists(w, "large/w.zip") || !exists(w, "large/x.zip") {
		t.Fatal("wrong things on disk")
	}
	log, _ := os.ReadFile(w.trash + "/log.jsonl")
	if !strings.Contains(string(log), `"path":"large/w.zip"`) {
		t.Fatalf("not in the trash log: %s", log)
	}
	out, _ := w.git(nil, "log", "-1", "--format=%an|%s|%b")
	if got := strings.TrimSpace(string(out)); got != "pat|Delete 4 items|a.md\ndocs/b.md\nnotes/\nlarge/w.zip" {
		t.Fatalf("commit: %q", got)
	}
}

// Copies land under their own name where it is free and as "name copy" where it isn't, as
// one commit; a folder can't be copied into itself.
func TestCopyAll(t *testing.T) {
	w, _ := Open(t.TempDir())
	pat := Author{"pat"}
	for _, p := range []string{"a.md", "notes/n.md", "notes/deep/d.md", ".env", "large/w.zip"} {
		w.Write(p, []byte(p), "", pat)
	}
	w.Write("a.md", []byte("second"), mustRev(t, w, "a.md"), pat)
	before := commits(t, w)
	to, err := w.CopyAll([]string{"a.md", "notes", "notes/n.md", ".env"}, "", pat)
	if err != nil || strings.Join(to, "|") != "a copy.md|notes copy|.env copy" {
		t.Fatalf("duplicate: %v %v", to, err)
	}
	if got := commits(t, w) - before; got != 1 {
		t.Fatalf("%d commits, want 1", got)
	}
	if to, _ = w.CopyAll([]string{"a.md", "notes"}, "", pat); strings.Join(to, "|") != "a copy 2.md|notes copy 2" {
		t.Fatalf("second duplicate: %v", to)
	}
	if b, _ := w.Read("notes copy/deep/d.md", ""); string(b) != "notes/deep/d.md" {
		t.Fatalf("copied folder: %q", b)
	}
	if b, _ := w.Read("a copy.md", ""); string(b) != "second" {
		t.Fatalf("copied file: %q", b)
	}
	// History follows a copy back to the original (git finds the exact copy), so the
	// original's earlier versions can be opened from the copy too.
	h, _ := w.History("a copy.md")
	if len(h) != 3 || h[0].Message != "Copy 3 items → /" || h[0].Author != "pat" || h[2].Message != "Add a.md" {
		t.Fatalf("a copy's history: %+v", h)
	}
	if b, err := w.Read("a copy.md", h[2].Rev); err != nil || string(b) != "a.md" {
		t.Fatalf("the original's first version, from the copy: %q %v", b, err)
	}
	// Somewhere else, the name is kept; two with one name there get told apart.
	if to, err = w.CopyAll([]string{"a.md", "notes/n.md", "large/w.zip"}, "new/place", pat); err != nil || strings.Join(to, "|") != "new/place/a.md|new/place/n.md|new/place/w.zip" {
		t.Fatalf("copy elsewhere: %v %v", to, err)
	}
	if to, _ = w.CopyAll([]string{"notes/n.md", "new/place/n.md"}, "x", pat); strings.Join(to, "|") != "x/n.md|x/n copy.md" {
		t.Fatalf("same name twice: %v", to)
	}
	// Into an area outside git: on disk, not in git, no commit.
	before = commits(t, w)
	if to, err = w.CopyAll([]string{"a.md", "large/w.zip"}, "large", pat); err != nil || strings.Join(to, "|") != "large/a.md|large/w copy.zip" {
		t.Fatalf("copy into large/: %v %v", to, err)
	}
	if commits(t, w) != before || strings.Contains(tracked(w), "large/") {
		t.Fatal("a copy in large/ reached git")
	}

	var refused *RefusedError
	if _, err := w.CopyAll([]string{"notes"}, "notes/deep", pat); !errors.As(err, &refused) {
		t.Fatalf("into itself: %v", err)
	}
	if _, err := w.CopyAll([]string{"a.md"}, "media", pat); !errors.As(err, &refused) {
		t.Fatalf("into media: %v", err)
	}
	if _, err := w.CopyAll([]string{"a.md", "gone.md"}, "y", pat); !errors.Is(err, ErrNotFound) || exists(w, "y") {
		t.Fatalf("missing: %v", err)
	}
	os.WriteFile(w.abs("large/huge.bin"), make([]byte, MaxVersioned+1), 0o644)
	if _, err := w.CopyAll([]string{"large/huge.bin"}, "", pat); !errors.As(err, &refused) || exists(w, "huge.bin") {
		t.Fatalf("huge file out of large/: %v", err)
	}
	if left, _ := os.ReadDir(w.abs(".git")); strings.Contains(joinNames(left), "mthub-copy") {
		t.Fatal("a copy left its staging folder behind")
	}
	if n, err := w.Size([]string{"notes", "notes/n.md", "a.md"}); err != nil || n != int64(len("notes/n.md")+len("notes/deep/d.md")+len("second")) {
		t.Fatalf("size: %d %v", n, err)
	}
}

func joinNames(d []os.DirEntry) string {
	var s []string
	for _, e := range d {
		s = append(s, e.Name())
	}
	return strings.Join(s, " ")
}

// One zip of several: names start at their folder when they share one, and keep their whole
// path when they don't.
func TestZipAll(t *testing.T) {
	w, _ := Open(t.TempDir())
	pat := Author{"pat"}
	for _, p := range []string{"docs/a.md", "docs/b.md", "docs/sub/c.md", "notes/n.md"} {
		w.Write(p, []byte(p), "", pat)
	}
	names := func(paths ...string) string {
		t.Helper()
		var buf bytes.Buffer
		if err := w.ZipAll(paths, &buf); err != nil {
			t.Fatal(err)
		}
		zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, f := range zr.File {
			out = append(out, f.Name)
		}
		return strings.Join(out, " ")
	}
	if got := names("docs/a.md", "docs/sub"); got != "a.md sub/ sub/c.md" {
		t.Fatalf("one folder: %s", got)
	}
	if got := names("docs/a.md", "notes/n.md"); got != "docs/a.md notes/n.md" {
		t.Fatalf("two folders: %s", got)
	}
	var buf bytes.Buffer
	if err := w.ZipAll([]string{"docs/a.md", "gone.md"}, &buf); !errors.Is(err, ErrNotFound) || buf.Len() != 0 {
		t.Fatalf("missing: %v, %d bytes written", err, buf.Len())
	}
}

// A folder goes only when someone deletes it: deleting the last thing in it, one at a time
// or several at once, in git or outside it, leaves the folder (empty) in the tree.
func TestDeleteLeavesTheFolder(t *testing.T) {
	w, _ := Open(t.TempDir())
	pat := Author{"pat"}
	for _, p := range []string{"one/a.md", "many/a.md", "many/b.md", "outer/inner/a.md", "large/pack/w.zip", "large/packs/a.zip", "large/packs/b.zip"} {
		w.Write(p, []byte(p), "", pat)
	}
	if _, err := w.Delete("one/a.md", mustRev(t, w, "one/a.md"), pat); err != nil {
		t.Fatal(err)
	}
	if _, err := w.DeleteAll([]string{"many/a.md", "many/b.md", "large/packs/a.zip", "large/packs/b.zip"}, pat); err != nil {
		t.Fatal(err)
	}
	if _, err := w.DeleteDir("outer/inner", pat); err != nil {
		t.Fatal(err)
	}
	_, rev, _ := w.Stat("large/pack/w.zip")
	if _, err := w.Delete("large/pack/w.zip", rev, pat); err != nil {
		t.Fatal(err)
	}
	tree, _ := w.Tree()
	var dirs []string
	for _, e := range tree {
		if !e.Dir {
			t.Errorf("%s is still there", e.Path)
		} else if !isArea(e.Path) {
			dirs = append(dirs, e.Path)
		}
	}
	if got := strings.Join(dirs, " "); got != "large/pack large/packs many one outer" {
		t.Fatalf("folders left: %s", got)
	}
	if tracked(w) != "" {
		t.Fatalf("still tracked: %s", tracked(w))
	}
}
