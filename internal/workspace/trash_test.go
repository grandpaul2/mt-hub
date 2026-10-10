package workspace

import (
	"encoding/json"
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
	if err := w.Delete("map art/MA-001.png", rev, emp); err != nil {
		t.Fatal(err)
	}
	if err := w.DeleteDir("large/old", emp); err != nil {
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
	if err := w.Trash(posted, "chat/general/media/d.png", emp); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(posted); err == nil {
		t.Error("the posted file is still there")
	}
	log, _ = os.ReadFile(filepath.Join(trash, "log.jsonl"))
	if !strings.Contains(string(log), `"path":"chat/general/media/d.png"`) {
		t.Errorf("log: %s", log)
	}

	// Files in git still just get a commit, not the trash.
	put("notes.md", "n")
	_, rev, _ = w.Stat("notes.md")
	if err := w.Delete("notes.md", rev, emp); err != nil {
		t.Fatal(err)
	}
	if log2, _ := os.ReadFile(filepath.Join(trash, "log.jsonl")); len(log2) != len(log) {
		t.Error("a file in git went through the trash")
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
		if _, err := w.Write(p, []byte("x"), "", Author{"paul"}); err != nil {
			t.Fatal(err)
		}
		if err := w.toTrash(p, "delete", Author{"paul"}, now.AddDate(0, 0, -age)); err != nil {
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
	if len(names) != 2 || names[0] != now.AddDate(0, 0, -(TrashDays-1)).Format(trashStamp)+" paul" || names[1] != "log.jsonl" {
		t.Errorf("after purge: %q", names)
	}
}
