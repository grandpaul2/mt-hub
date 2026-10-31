package workspace

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Outside git, deleting or replacing a file must leave the old one in the trash, with a
// log line naming who did it; nothing there is ever erased straight away.
func TestTrashKeepsWhatAreasLose(t *testing.T) {
	root := t.TempDir()
	w, err := Open(filepath.Join(root, "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	trash := filepath.Join(root, "trash")
	emp := Author{"eldridge"}
	put := func(p, data string) {
		t.Helper()
		_, rev, _ := w.Stat(p)
		if _, err := w.Write(p, []byte(data), rev, emp); err != nil {
			t.Fatal(err)
		}
	}
	put("screenshots/a.png", "first")
	put("screenshots/a.png", "second")
	put("large/old/b.zip", "b")
	put("large/old/c.zip", "c")
	put("map art/MA-001.png", "map")

	_, rev, _ := w.Stat("map art/MA-001.png")
	if _, err := w.Delete("map art/MA-001.png", rev, emp); err != nil {
		t.Fatal(err)
	}
	if _, err := w.DeleteDir("large/old", emp); err != nil {
		t.Fatal(err)
	}

	// Each old file is somewhere in the trash, under the path it had.
	found := map[string]string{}
	filepath.WalkDir(trash, func(f string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() != "log.jsonl" {
			rel, _ := filepath.Rel(trash, f)
			entry, p, _ := strings.Cut(filepath.ToSlash(rel), "/")
			if !strings.HasSuffix(entry, " eldridge") && !strings.Contains(entry, " eldridge (") {
				t.Errorf("entry %q doesn't name who did it", entry)
			}
			data, _ := os.ReadFile(f)
			found[p] = string(data)
		}
		return nil
	})
	want := map[string]string{"screenshots/a.png": "first", "map art/MA-001.png": "map",
		"large/old/b.zip": "b", "large/old/c.zip": "c"}
	for p, data := range want {
		if found[p] != data {
			t.Errorf("trash has %s = %q, want %q", p, found[p], data)
		}
	}
	if data, _ := w.Read("screenshots/a.png", ""); string(data) != "second" {
		t.Errorf("live file is %q", data)
	}

	log, _ := os.ReadFile(filepath.Join(trash, "log.jsonl"))
	lines := strings.Split(strings.TrimSpace(string(log)), "\n")
	if len(lines) != 3 {
		t.Fatalf("log has %d lines: %s", len(lines), log)
	}
	var r trashRecord
	json.Unmarshal([]byte(lines[0]), &r)
	if r.Who != "eldridge" || r.Action != "replace" || r.Path != "screenshots/a.png" {
		t.Errorf("first log line %+v", r)
	}
	if _, err := os.Stat(filepath.Join(trash, filepath.FromSlash(r.Trash))); err != nil {
		t.Errorf("log points at %q: %v", r.Trash, err)
	}

	// A file posted in chat (kept outside the workspace) goes to the same trash.
	posted := filepath.Join(root, "chat", "general", "media", "d.png")
	os.MkdirAll(filepath.Dir(posted), 0o755)
	os.WriteFile(posted, []byte("d"), 0o644)
	if err := w.TrashChat(posted, "general", "d.png", true, emp); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(posted); err == nil {
		t.Error("the posted file is still there")
	}
	log, _ = os.ReadFile(filepath.Join(trash, "log.jsonl"))
	if !strings.Contains(string(log), `"path":"chat/general/media/d.png"`) {
		t.Errorf("log: %s", log)
	}

	// A file in git goes to the trash too, and its removal is a commit.
	put("notes.md", "n")
	_, rev, _ = w.Stat("notes.md")
	id, err := w.Delete("notes.md", rev, emp)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(trash, id, "notes.md")); string(b) != "n" {
		t.Errorf("a file in git isn't in the trash: %q", b)
	}
	if out, _ := w.git(nil, "ls-files"); strings.Contains(string(out), "notes.md") {
		t.Error("it is still tracked")
	}
	if out, _ := w.git(nil, "log", "-1", "--format=%s"); strings.TrimSpace(string(out)) != "Delete notes.md" {
		t.Errorf("last commit: %s", out)
	}
}

func TestPurgeTrash(t *testing.T) {
	root := t.TempDir()
	w, err := Open(filepath.Join(root, "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, age := range []int{TrashDays + 1, TrashDays - 1} {
		p := "large/f.zip"
		if _, err := w.Write(p, []byte("x"), "", Author{"pat"}); err != nil {
			t.Fatal(err)
		}
		if _, err := w.toTrash(p, "delete", Author{"pat"}, now.AddDate(0, 0, -age)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.PurgeTrash(now); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "trash"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 2 || names[0] != now.AddDate(0, 0, -(TrashDays-1)).Format(trashStamp)+" pat" || names[1] != "log.jsonl" {
		t.Errorf("after purge: %q", names)
	}
}

// The Trash as the page sees it: everything deleted in Files is listed, newest first, a
// public chat's files too, a private chat's never; things come back where they were, under
// another name where theirs is taken, or into a folder that is named; and Delete Forever
// erases only what is listed.
func TestTrashListAndRestore(t *testing.T) {
	root := t.TempDir()
	w, _ := Open(filepath.Join(root, "workspace"))
	trash := filepath.Join(root, "trash")
	pat := Author{"pat"}
	put := func(p, data string) {
		t.Helper()
		_, rev, _ := w.Stat(p)
		if _, err := w.Write(p, []byte(data), rev, pat); err != nil {
			t.Fatal(err)
		}
	}
	posted := func(chat, file string, public bool) {
		t.Helper()
		src := filepath.Join(root, "chat", chat, "media", file)
		os.MkdirAll(filepath.Dir(src), 0o755)
		os.WriteFile(src, []byte(file), 0o644)
		if err := w.TrashChat(src, chat, file, public, pat); err != nil {
			t.Fatal(err)
		}
	}
	list := func() (string, map[string]TrashItem) {
		t.Helper()
		items, err := w.TrashList()
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		by := map[string]TrashItem{}
		for _, it := range items {
			name := it.Path
			if it.Chat != "" {
				name = "#" + it.Chat + ":" + name
			}
			if it.Dir {
				name += "/"
			}
			if it.Replaced {
				name += "(replaced)"
			}
			names = append(names, name)
			by[name] = it
		}
		return strings.Join(names, " "), by
	}

	put("docs/a.md", "first")
	put("docs/a.md", "second")
	put("docs/sub/b.md", "b")
	put("large/w.zip", "world")
	put("large/w.zip", "world two")
	put("keep.md", "k")
	// A chat file trashed before the hub recorded which kind of chat it was in: never listed.
	os.MkdirAll(filepath.Join(trash, "2026-10-01 10-00-00.000 pat", "chat", "general", "media"), 0o755)
	os.WriteFile(filepath.Join(trash, "2026-10-01 10-00-00.000 pat", "chat", "general", "media", "old.png"), []byte("o"), 0o644)
	os.WriteFile(filepath.Join(trash, "log.jsonl"), append(mustRead(t, filepath.Join(trash, "log.jsonl")),
		[]byte(`{"time":"2026-10-01T10:00:00Z","who":"pat","action":"delete","path":"chat/general/media/old.png","trash":"2026-10-01 10-00-00.000 pat/chat/general/media/old.png"}`+"\n")...), 0o644)

	idA, err := w.Delete("docs/a.md", mustRev(t, w, "docs/a.md"), pat)
	if err != nil {
		t.Fatal(err)
	}
	idSub, err := w.DeleteDir("docs/sub", pat)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := w.DeleteAll([]string{"large/w.zip", "keep.md"}, pat)
	if err != nil || len(ids) != 2 {
		t.Fatalf("DeleteAll: %v %v", ids, err)
	}
	posted("general", "d.png", true)
	posted("staff", "secret.png", false)

	names, by := list()
	if names != "#general:d.png keep.md large/w.zip docs/sub/ docs/a.md large/w.zip(replaced)" {
		t.Fatalf("listed: %s", names)
	}
	if it := by["docs/sub/"]; it.ID != idSub || it.Size != 1 || it.Who != "pat" || it.Time == "" {
		t.Fatalf("a folder's row: %+v", it)
	}
	idChat := by["#general:d.png"].ID

	// Back where it was, with its history.
	before := commits(t, w)
	if got, err := w.Restore([]string{idA}, nil, pat); err != nil || strings.Join(got, " ") != "docs/a.md" {
		t.Fatalf("restore: %v %v", got, err)
	}
	h, _ := w.History("docs/a.md")
	if commits(t, w)-before != 1 || len(h) != 4 || h[0].Message != "Restore docs/a.md from Trash" || h[3].Message != "Add docs/a.md" {
		t.Fatalf("history after a restore: %+v", h)
	}
	if b, _ := w.Read("docs/a.md", h[3].Rev); string(b) != "first" {
		t.Fatalf("its first version: %q", b)
	}
	if _, err := w.Restore([]string{idA}, nil, pat); !errors.Is(err, ErrNotFound) {
		t.Fatalf("restored twice: %v", err)
	}
	// Its name taken meanwhile: "(restored)", then "(restored 2)".
	for _, want := range []string{"docs/a (restored).md", "docs/a (restored 2).md"} {
		id, _ := w.Delete("docs/a.md", mustRev(t, w, "docs/a.md"), pat)
		put("docs/a.md", "someone else's")
		if got, err := w.Restore([]string{id}, nil, pat); err != nil || got[0] != want {
			t.Fatalf("restore onto a taken name: %v %v, want %s", got, err, want)
		}
	}
	// Its folder gone meanwhile: made again. Two at once: one commit.
	if _, err := w.DeleteDir("docs", pat); err != nil {
		t.Fatal(err)
	}
	os.Remove(w.abs("docs"))
	before = commits(t, w)
	got, err := w.Restore([]string{idSub, ids[1]}, nil, pat)
	if err != nil || strings.Join(got, " ") != "docs/sub keep.md" || commits(t, w)-before != 1 {
		t.Fatalf("restore a folder and a file: %v %v", got, err)
	}
	if b, _ := w.Read("docs/sub/b.md", ""); string(b) != "b" || !strings.Contains(tracked(w), "docs/sub/b.md") {
		t.Fatalf("the folder's file: %q, tracked %s", b, tracked(w))
	}
	// Into a folder that is named (dragged out of the Trash): from outside git into git.
	to := "notes"
	if got, err := w.Restore([]string{ids[0]}, &to, pat); err != nil || got[0] != "notes/w.zip" || !strings.Contains(tracked(w), "notes/w.zip") {
		t.Fatalf("restore into a folder: %v %v", got, err)
	}
	// A chat file has no place in Files: it needs a folder. A private chat's is never found.
	var refused *RefusedError
	if _, err := w.Restore([]string{idChat}, nil, pat); !errors.As(err, &refused) {
		t.Fatalf("a chat file with no folder: %v", err)
	}
	to = ""
	if got, err := w.Restore([]string{idChat}, &to, pat); err != nil || got[0] != "d.png" {
		t.Fatalf("a chat file to the top: %v %v", got, err)
	}
	var hidden []string
	dirs, _ := os.ReadDir(trash)
	for _, d := range dirs {
		if _, err := os.Stat(filepath.Join(trash, d.Name(), "chat")); err == nil {
			hidden = append(hidden, d.Name())
		}
	}
	if len(hidden) != 2 {
		t.Fatalf("the two unlisted chat files should still be on disk: %v", hidden)
	}
	for _, id := range hidden {
		if _, err := w.Restore([]string{id}, &to, pat); !errors.Is(err, ErrNotFound) {
			t.Fatalf("an unlisted chat file was restored: %v", err)
		}
		if n, err := w.DeleteForever([]string{id}, pat); n != 0 || !errors.Is(err, ErrNotFound) {
			t.Fatalf("an unlisted chat file was erased: %d %v", n, err)
		}
	}
	to = "media/x"
	if _, err := w.Restore([]string{by["large/w.zip(replaced)"].ID}, &to, pat); err == nil {
		t.Fatal("restored into media/")
	}

	// Delete Forever, then Empty Trash: only what is listed.
	names, by = list()
	if names != "docs/ large/w.zip(replaced)" {
		t.Fatalf("listed before erasing: %s", names)
	}
	if n, err := w.DeleteForever([]string{by["docs/"].ID, "../workspace"}, pat); n != 1 || !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete forever with a bad id: %d %v", n, err)
	}
	if _, err := os.Stat(w.abs("keep.md")); err != nil {
		t.Fatal("a bad id reached outside the trash")
	}
	if n, err := w.DeleteForever(nil, pat); n != 1 || err != nil {
		t.Fatalf("empty trash: %d %v", n, err)
	}
	if names, _ = list(); names != "" {
		t.Fatalf("listed after Empty Trash: %s", names)
	}
	for _, id := range hidden {
		if _, err := os.Stat(filepath.Join(trash, id)); err != nil {
			t.Fatalf("Empty Trash erased an unlisted chat file: %v", err)
		}
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, _ := os.ReadFile(p)
	return b
}
