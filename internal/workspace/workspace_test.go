package workspace

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A rev is put on git's command line, so one shaped like an option must not reach it.
func TestReadRevIsNotAnOption(t *testing.T) {
	dir := t.TempDir()
	w, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write("a.md", []byte("a"), "", Author{"paul"}); err != nil {
		t.Fatal(err)
	}
	for _, rev := range []string{"--output=pwn", "HEAD", "-p"} {
		if _, err := w.Read("a.md", rev); !errors.Is(err, ErrNotFound) {
			t.Errorf("rev %q: %v", rev, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "pwn:a.md")); err == nil {
		t.Fatal("git wrote a file named by the rev")
	}
}

// Paths reach git as pathspecs, which would read ? * [ ] as wildcards: deleting "*.md" took
// every .md file with it, and "what?.md" took "whatx.md".
func TestWildcardNamesAreLiteral(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	paul := Author{"paul"}
	revs := map[string]string{}
	for _, p := range []string{"what?.md", "whatx.md", "*.md", "keep.md", "notes/a.md", "[ab].md", "a.md", "b.md"} {
		if revs[p], err = w.Write(p, []byte(p), "", paul); err != nil {
			t.Fatal(err)
		}
	}
	if h, err := w.History("what?.md"); err != nil || len(h) != 1 {
		t.Errorf("history of what?.md: %d commits, %v (want just its own)", len(h), err)
	}
	for _, p := range []string{"what?.md", "*.md", "[ab].md"} {
		if _, rev, _ := w.Stat(p); rev != revs[p] {
			t.Errorf("rev of %s = %s, want its own %s", p, rev, revs[p])
		}
		if _, err := w.Delete(p, revs[p], paul); err != nil {
			t.Fatalf("delete %s: %v", p, err)
		}
	}
	for _, p := range []string{"whatx.md", "keep.md", "notes/a.md", "a.md", "b.md"} {
		if _, _, err := w.Stat(p); err != nil {
			t.Errorf("%s went too: %v", p, err)
		}
	}
}

// A .gitignore someone saves in Files is just a file: what's saved or moved under it still
// gets history, and can still be deleted. (It used to be written, refused by git, and stuck.)
func TestGitignoreHasNoSay(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	paul := Author{"paul"}
	for _, p := range []string{".gitignore", "proj/.gitignore"} {
		if _, err := w.Write(p, []byte("*\n"), "", paul); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{"proj/a.jar", "b.md", ":x.md"} {
		rev, err := w.Write(p, []byte(p), "", paul)
		if err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
		if h, _ := w.History(p); len(h) != 1 {
			t.Errorf("%s: %d commits, want 1", p, len(h))
		}
		if _, err := w.Delete(p, rev, paul); err != nil {
			t.Errorf("delete %s: %v", p, err)
		}
	}
	if _, err := w.Write("c.md", []byte("c"), "", paul); err != nil {
		t.Fatal(err)
	}
	if err := w.Move("c.md", "proj/c.md", paul); err != nil {
		t.Fatal(err)
	}
	if h, _ := w.History("proj/c.md"); len(h) != 2 {
		t.Errorf("moved under a .gitignore: %d commits, want 2 (add and move)", len(h))
	}
	if err := w.Move("proj/c.md", LargeDir+"/c.md", paul); err != nil {
		t.Fatal(err)
	}
	if out, _ := w.git(nil, "ls-files", LargeDir); len(out) != 0 {
		t.Errorf("moving into %s/ put it in git: %s", LargeDir, out)
	}
}

func TestWriteReadHistoryConflict(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	paul, emp := Author{"paul"}, Author{"eldridge"}

	r1, err := w.Write("configs/a.json", []byte("{}"), "", paul)
	if err != nil {
		t.Fatal(err)
	}
	// Creating a file that already exists is a conflict.
	if _, err := w.Write("configs/a.json", []byte("x"), "", emp); !isConflict(err, r1) {
		t.Fatalf("want conflict at %s, got %v", r1, err)
	}
	r2, err := w.Write("configs/a.json", []byte(`{"a":1}`), r1, emp)
	if err != nil {
		t.Fatal(err)
	}
	// A stale base is refused and reports the current revision.
	if _, err := w.Write("configs/a.json", []byte("stale"), r1, paul); !isConflict(err, r2) {
		t.Fatalf("want conflict at %s, got %v", r2, err)
	}
	// Saving identical content keeps the revision.
	if r, err := w.Write("configs/a.json", []byte(`{"a":1}`), r2, paul); err != nil || r != r2 {
		t.Fatalf("no-op save: rev %s err %v", r, err)
	}

	if b, _ := w.Read("configs/a.json", r1); string(b) != "{}" {
		t.Fatalf("read at r1: %q", b)
	}
	h, _ := w.History("configs/a.json")
	if len(h) != 2 || h[0].Author != "eldridge" || h[1].Author != "paul" {
		t.Fatalf("history: %+v", h)
	}

	if _, err := w.Delete("configs/a.json", r1, paul); !isConflict(err, r2) {
		t.Fatalf("stale delete: %v", err)
	}
	if _, err := w.Delete("configs/a.json", r2, paul); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Read("configs/a.json", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}

func TestClean(t *testing.T) {
	for in, want := range map[string]string{
		"a/b.txt": "a/b.txt", "/a//b.txt": "a/b.txt", "../../etc/passwd": "etc/passwd",
	} {
		if got, err := Clean(in); err != nil || got != want {
			t.Errorf("Clean(%q) = %q, %v", in, got, err)
		}
	}
	for _, ok := range []string{".gitx", "x.git", ".gitignore", ".gitmodules", "git~2", ".git~1", " .git", "a:b"} {
		if _, err := Clean(ok); err != nil {
			t.Errorf("Clean(%q) = %v, want ok", ok, err)
		}
	}
	// Everything git refuses as its own folder (checked against git 2.47 and 2.55).
	for _, bad := range []string{"", "/", ".git/config", "a/.git/x", ".GIT/config", ".Git", ".git ", ".git.", ".git. .",
		"GIT~1", "git~1/x", "GIT~1.", ".git:x", ".git::$INDEX_ALLOCATION", "a/.GIT"} {
		if _, err := Clean(bad); err == nil {
			t.Errorf("Clean(%q) should fail", bad)
		}
	}
}

func isConflict(err error, cur string) bool {
	var c *ConflictError
	return errors.As(err, &c) && c.Current == cur
}

func TestDirectEditsAreCommitted(t *testing.T) {
	dir := t.TempDir()
	w, _ := Open(dir)
	r1, _ := w.Write("a.txt", []byte("v1"), "", Author{"paul"})

	// Someone edits a.txt and creates b/c.txt over ssh, without committing.
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("edited on the box"), 0o644)
	os.MkdirAll(filepath.Join(dir, "b"), 0o755)
	os.WriteFile(filepath.Join(dir, "b", "c.txt"), []byte("new"), 0o644)

	// A save from a page that opened a.txt before the edit must not clobber it.
	if _, err := w.Write("a.txt", []byte("stale page save"), r1, Author{"eldridge"}); !isConflict(err, mustRev(t, w, "a.txt")) {
		t.Fatalf("want conflict, got %v", err)
	}
	h, _ := w.History("b/c.txt")
	if len(h) != 1 || !strings.HasPrefix(h[0].Message, "Edit on the box") {
		t.Fatalf("direct edit not committed: %+v", h)
	}
	// Credited to the files' owner: whoever runs the test.
	if me, _ := user.Current(); h[0].Author != me.Username {
		t.Fatalf("author %q", h[0].Author)
	}
	if b, _ := w.Read("a.txt", ""); string(b) != "edited on the box" {
		t.Fatalf("a.txt = %q", b)
	}
}

func mustRev(t *testing.T, w *Workspace, p string) string {
	r, err := w.Rev(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestLargeFilesStayOutOfGit(t *testing.T) {
	w, _ := Open(t.TempDir())
	r1, err := w.Write("large/world.zip", []byte("v1"), "", Author{"paul"})
	if err != nil || !strings.HasPrefix(r1, "L") {
		t.Fatalf("write: %q %v", r1, err)
	}
	if h, _ := w.History("large/world.zip"); len(h) != 0 {
		t.Fatalf("large file has history: %+v", h)
	}
	if out, _ := w.git(nil, "log", "--oneline"); len(out) != 0 {
		t.Fatalf("large write made a commit: %s", out)
	}
	// Same conflict rules as everything else.
	if _, err := w.Write("large/world.zip", []byte("x"), "", Author{"eldridge"}); !isConflict(err, r1) {
		t.Fatalf("create over existing: %v", err)
	}
	time.Sleep(10 * time.Millisecond) // the revision includes the modification time
	r2, err := w.Write("large/world.zip", []byte("v2!"), r1, Author{"eldridge"})
	if err != nil || r2 == r1 {
		t.Fatalf("replace: %q %v", r2, err)
	}
	// A normal file next to it still commits, and large/ never shows up in git.
	w.Write("notes.txt", []byte("hi"), "", Author{"paul"})
	if out, _ := w.git(nil, "ls-files"); string(out) != "notes.txt\n" {
		t.Fatalf("tracked: %q", out)
	}
	if _, err := w.Delete("large/world.zip", r1, Author{"paul"}); !isConflict(err, r2) {
		t.Fatalf("stale delete: %v", err)
	}
	if _, err := w.Delete("large/world.zip", r2, Author{"paul"}); err != nil {
		t.Fatal(err)
	}
	tree, _ := w.Tree()
	for _, e := range tree {
		if e.Path == "large" && !(e.Dir && e.Large) {
			t.Fatalf("large dir entry: %+v", e)
		}
	}
}

func TestMoveAndDeleteDir(t *testing.T) {
	w, _ := Open(t.TempDir())
	paul := Author{"paul"}
	w.Write("docs/a.md", []byte("a"), "", paul)
	w.Write("docs/sub/b.md", []byte("b"), "", Author{"eldridge"})

	// A file rename keeps its history (git follows it).
	if err := w.Move("docs/a.md", "docs/renamed.md", paul); err != nil {
		t.Fatal(err)
	}
	h, _ := w.History("docs/renamed.md")
	if len(h) != 2 || h[1].Message != "Add docs/a.md" {
		t.Fatalf("history lost: %+v", h)
	}
	// Versions from before the rename still open under the new name.
	if b, err := w.Read("docs/renamed.md", h[1].Rev); err != nil || string(b) != "a" {
		t.Fatalf("old version: %q %v", b, err)
	}
	// Folder move; the emptied parent goes away, like git rm.
	if err := w.Move("docs/sub", "notes/sub", paul); err != nil {
		t.Fatal(err)
	}
	if b, err := w.Read("notes/sub/b.md", ""); err != nil || string(b) != "b" {
		t.Fatalf("moved folder: %q %v", b, err)
	}
	if out, _ := w.git(nil, "ls-files"); string(out) != "docs/renamed.md\nnotes/sub/b.md\n" {
		t.Fatalf("tracked: %q", out)
	}
	if err := w.Move("notes/sub/b.md", "docs/renamed.md", paul); !errors.Is(err, ErrExists) {
		t.Fatalf("move onto existing: %v", err)
	}
	if err := w.Move("notes", "notes/sub/x", paul); !errors.Is(err, ErrBadPath) {
		t.Fatalf("move into itself: %v", err)
	}
	if err := w.Move("large", "big", paul); !errors.Is(err, ErrBadPath) {
		t.Fatalf("move large/: %v", err)
	}

	// Into large/ leaves git; back out returns to it, unless a file is over the limit.
	if err := w.Move("docs/renamed.md", "large/renamed.md", paul); err != nil {
		t.Fatal(err)
	}
	if out, _ := w.git(nil, "ls-files"); string(out) != "notes/sub/b.md\n" {
		t.Fatalf("tracked after move into large/: %q", out)
	}
	if _, err := os.Stat(filepath.Join(w.dir, "docs")); !os.IsNotExist(err) {
		t.Fatalf("empty docs/ left behind: %v", err)
	}
	os.WriteFile(w.abs("large/huge.bin"), make([]byte, MaxVersioned+1), 0o644)
	var refused *RefusedError
	if err := w.Move("large/huge.bin", "huge.bin", paul); !errors.As(err, &refused) {
		t.Fatalf("huge file out of large/: %v", err)
	}
	if err := w.Move("large/renamed.md", "back.md", paul); err != nil {
		t.Fatal(err)
	}

	if _, err := w.DeleteDir("notes", paul); err != nil {
		t.Fatal(err)
	}
	if out, _ := w.git(nil, "ls-files"); string(out) != "back.md\n" {
		t.Fatalf("tracked after folder delete: %q", out)
	}
	if _, err := w.DeleteDir("large", paul); !errors.Is(err, ErrBadPath) {
		t.Fatalf("delete large/: %v", err)
	}
}

func TestMovesMkdirZip(t *testing.T) {
	w, _ := Open(t.TempDir())
	paul := Author{"paul"}
	w.Write("notes/empty.md", nil, "", paul) // git can't see renames of empty files; we still can
	w.Write("large/world.zip", []byte("w"), "", paul)
	steps := [][2]string{{"notes/empty.md", "notes/todo.md"}, {"notes", "docs/notes"}, {"large/world.zip", "large/old/world.zip"}}
	for _, s := range steps {
		if err := w.Move(s[0], s[1], paul); err != nil {
			t.Fatal(err)
		}
	}
	moves, err := w.Moves()
	if err != nil || len(moves) != 3 {
		t.Fatalf("moves: %+v %v", moves, err)
	}
	for i, s := range steps {
		if moves[i].From != s[0] || moves[i].To != s[1] || moves[i].Author != "paul" {
			t.Fatalf("move %d: %+v", i, moves[i])
		}
	}

	if err := w.Mkdir("docs/empty"); err != nil {
		t.Fatal(err)
	}
	if err := w.Mkdir("docs/empty"); !errors.Is(err, ErrExists) {
		t.Fatalf("mkdir twice: %v", err)
	}
	tree, _ := w.Tree()
	found := false
	for _, e := range tree {
		found = found || e.Path == "docs/empty" && e.Dir
	}
	if !found {
		t.Fatal("empty folder missing from tree")
	}

	var buf bytes.Buffer
	if err := w.Zip("docs", &buf); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if got := strings.Join(names, " "); got != "docs/ docs/empty/ docs/notes/ docs/notes/todo.md" {
		t.Fatalf("zip entries: %s", got)
	}
	if err := w.Zip("docs/notes/todo.md", &buf); !errors.Is(err, ErrNotFound) {
		t.Fatalf("zip of a file: %v", err)
	}
}

// media/ isn't a Files folder: chat links to files posted in a chat read media/<chat>/<file>,
// so nothing in Files may take the name.
func TestMediaReserved(t *testing.T) {
	w, _ := Open(t.TempDir())
	if _, err := os.Stat(w.abs("media")); err == nil {
		t.Fatal("Open made media/")
	}
	a := Author{"paul"}
	var refused *RefusedError
	if _, err := w.Write("media/general/farm.png", []byte("png"), "", a); !errors.As(err, &refused) {
		t.Fatalf("write: %v", err)
	}
	if err := w.Mkdir("media"); !errors.As(err, &refused) {
		t.Fatalf("mkdir: %v", err)
	}
	w.Write("notes.txt", []byte("hi"), "", a)
	if err := w.Move("notes.txt", "media/notes.txt", a); !errors.As(err, &refused) {
		t.Fatalf("move: %v", err)
	}
	if _, err := w.Write("docs/media/x.txt", []byte("x"), "", a); err != nil {
		t.Fatalf("a media/ deeper down is fine: %v", err)
	}
}

// A move is recorded so that no name can confuse it: " → " in a name used to split the record
// in the wrong place. Line breaks (and other control characters) aren't allowed in names.
func TestMoveRecordAnyName(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	paul := Author{"paul"}
	if _, err := w.Write("x → y.md", []byte("x"), "", paul); err != nil {
		t.Fatal(err)
	}
	if err := w.Move("x → y.md", "p → q.md", paul); err != nil {
		t.Fatal(err)
	}
	moves, _ := w.Moves()
	if len(moves) != 1 || moves[0] != (Moved{"x → y.md", "p → q.md", "paul"}) {
		t.Errorf("moves: %+v", moves)
	}
	for _, bad := range []string{"a\nb.md", "tab\there.md", "nul\x00.md"} {
		if _, err := Clean(bad); err == nil {
			t.Errorf("Clean(%q) should fail", bad)
		}
	}
}

// Moves made before the record line still read from their subject.
func TestOldMoveRecords(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.git(authorEnv(Author{"eldridge"}), "commit", "-q", "--allow-empty", "-m", "Move old/a.md → new/a.md"); err != nil {
		t.Fatal(err)
	}
	if moves, _ := w.Moves(); len(moves) != 1 || moves[0] != (Moved{"old/a.md", "new/a.md", "eldridge"}) {
		t.Errorf("moves: %+v", moves)
	}
}

// A name with a line break can't be written or moved to: the history keeps one record per
// line, and Moves reads them back, so such a name could forge a move.
func TestNoControlCharsInNames(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := Author{Name: "Steve"}
	forged := "x\n\nMove docs -> evil\n\nMoved: {\"from\":\"docs\",\"to\":\"evil\"}"
	if _, err := w.WriteFrom(forged, strings.NewReader("data"), "", a); !errors.Is(err, ErrBadPath) {
		t.Errorf("WriteFrom with line breaks: %v, want ErrBadPath", err)
	}
	if _, err := w.Write("notes/a.txt", []byte("a"), "", a); err != nil {
		t.Fatal(err)
	}
	if err := w.Move("notes/a.txt", "notes/b\nMove x -> y", a); !errors.Is(err, ErrBadPath) {
		t.Errorf("Move to a name with a line break: %v, want ErrBadPath", err)
	}
	if moves, _ := w.Moves(); len(moves) != 0 {
		t.Errorf("forged moves: %v", moves)
	}
}
