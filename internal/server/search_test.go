package server

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"testing"

	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

func TestSearch(t *testing.T) {
	dir := t.TempDir()
	ws, err := workspace.Open(filepath.Join(dir, "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	cs, err := chat.Open(filepath.Join(dir, "chat"))
	if err != nil {
		t.Fatal(err)
	}
	a := workspace.Author{Name: "test"}
	for p, text := range map[string]string{
		"notes/farms.md":                    "# Farms\n\nThe iron farm is at spawn.\nA Flying Machine for the tunnel bore.",
		"notes/todo.txt":                    "nothing here",
		"commands/iron.txt":                 "/b iron",
		"schematics/Floor Placer/README.md": "# Floor Placer\n\nDesign by Glowsquid · posted 2025-07-09\n\nPlaces a floor.",
		"schematics/Floor Placer/1.png":     "png",
		"schematics/loose.litematic":        "\x00x",
		"schematics/Sub/deep/a.litematic":   "\x00x",
		"schematics/Floor Placer/notes.txt": "wiring notes",
		"pics/logo.png":                     "\x00png",
	} {
		if _, err := ws.Write(p, []byte(text), "", a); err != nil {
			t.Fatal(err)
		}
	}
	cs.CreateChannel("builds")
	post := func(ch, user, text string) chat.Message {
		m, err := cs.Post(ch, user, text)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	post("general", "patmc", "the iron farm works")
	post("general", "eldridge", "@patmc look at #[screenshots/2026-09-30 20.40.19 eldridge.png]")
	post("builds", "eldridge", "flying machine plan https://example.com/plan")
	pinned := post("builds", "patmc", "iron farm design #schematics/x.litematic")
	cs.SetPinned("builds", pinned.ID, "patmc", true)
	post("general", "steve", "Iron golems spawn #1")

	s := &Server{ws: ws, chat: cs}
	search := func(q string) searchResp {
		t.Helper()
		w := httptest.NewRecorder()
		s.search(w, httptest.NewRequest("GET", "/api/search?q="+url.QueryEscape(q), nil))
		var out searchResp
		if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	texts := func(r searchResp) (out []string) {
		for _, m := range r.Chat.Items {
			out = append(out, m.Channel+": "+m.Text)
		}
		return
	}
	paths := func(r searchResp) (out []string) {
		for _, f := range r.Files.Items {
			out = append(out, f.Path)
		}
		return
	}
	check := func(label string, got, want []string) {
		t.Helper()
		if !slices.Equal(got, want) {
			t.Errorf("%s:\n got  %q\n want %q", label, got, want)
		}
	}

	r := search("IRON farm")
	check("words, any case, newest first", texts(r), []string{"builds: iron farm design #schematics/x.litematic", "general: the iron farm works"})
	if len(r.Text.Items) != 1 || r.Text.Items[0].Path != "notes/farms.md" || r.Text.Items[0].Line != 3 || r.Text.Items[0].Text != "The iron farm is at spawn." {
		t.Errorf("text hit: %+v", r.Text.Items)
	}
	check("names", paths(search("iron")), []string{"commands/iron.txt"})
	check("words across lines", paths(search("farms flying")), nil)
	if r := search("farms flying"); len(r.Text.Items) != 1 {
		t.Errorf("both words in one file, different lines: %+v", r.Text.Items)
	}
	check("quoted phrase", texts(search(`"farm works"`)), []string{"general: the iron farm works"})

	check("from", texts(search("from:eldridge")), []string{"builds: flying machine plan https://example.com/plan", "general: @patmc look at #[screenshots/2026-09-30 20.40.19 eldridge.png]"})
	check("from + in", texts(search("from:eldridge in:#general")), []string{"general: @patmc look at #[screenshots/2026-09-30 20.40.19 eldridge.png]"})
	check("in without #", texts(search("iron in:builds")), []string{"builds: iron farm design #schematics/x.litematic"})
	check("mentions", texts(search("mentions:patmc")), []string{"general: @patmc look at #[screenshots/2026-09-30 20.40.19 eldridge.png]"})
	check("has:link", texts(search("has:link")), []string{"builds: flying machine plan https://example.com/plan"})
	check("has:image", texts(search("has:image")), []string{"general: @patmc look at #[screenshots/2026-09-30 20.40.19 eldridge.png]"})
	check("has:schematic", texts(search("has:schematic")), []string{"builds: iron farm design #schematics/x.litematic"})
	check("has:pin", texts(search("has:pin")), []string{"builds: iron farm design #schematics/x.litematic"})
	check("#1 is not a file", texts(search("golems has:file")), nil)
	if r := search("from:eldridge"); r.Words == nil {
		t.Error("filters alone: words must be [], not null (the page highlights with them)")
	}
	if r := search("from:eldridge"); r.Files.Total+r.Text.Total+r.Schematics.Total != 0 {
		t.Errorf("chat filters search only chat: %+v", r)
	}

	r = search("iron in:notes/")
	check("in a folder: no chat", texts(r), nil)
	if len(r.Text.Items) != 1 || r.Text.Items[0].Path != "notes/farms.md" {
		t.Errorf("in a folder: %+v", r.Text.Items)
	}
	r = search("glowsquid")
	if len(r.Schematics.Items) != 1 || r.Schematics.Items[0].Title != "Floor Placer" || r.Schematics.Items[0].Image != "1.png" || r.Text.Total+r.Files.Total != 0 {
		t.Errorf("a schematic post stands for its files: %+v", r)
	}
	if r := search("png"); slices.Contains(paths(r), "schematics/Floor Placer/1.png") || !slices.Contains(paths(r), "pics/logo.png") {
		t.Errorf("post files stay in the post: %q", paths(r))
	}
	// What a card doesn't show is found like any file (bug sweep: loose files and subfolders
	// in schematics/ were unfindable).
	for q, want := range map[string]string{"loose": "schematics/loose.litematic", "deep": "schematics/Sub/deep/a.litematic", "notes": "schematics/Floor Placer/notes.txt"} {
		if r := search(q); !slices.Contains(paths(r), want) {
			t.Errorf("search %s: %q, want %s", q, paths(r), want)
		}
	}
	if r := search("wiring"); r.Text.Total != 1 || r.Text.Items[0].Path != "schematics/Floor Placer/notes.txt" {
		t.Errorf("text in a post's other file: %+v", r.Text)
	}

	if e := search("in:nowhere").Error; e != "no chat or folder called nowhere" {
		t.Errorf("unknown in: %q", e)
	}
	if e := search("has:banana").Error; e == "" {
		t.Error("unknown has: accepted")
	}
	if r := search("from:"); r.Chat.Total != 0 || r.Error != "" {
		t.Errorf("a filter still being typed: %+v", r)
	}
}
