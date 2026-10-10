package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// A member can't use up the hub's disk or memory: a big upload is stopped when the disk
// reaches the floor while it arrives (not only checked before it starts), a new link preview
// needs room like an upload, and search keeps a bounded amount of text.
func TestMemberCantExhaust(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Steve", "Steve-password")
	s := New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil)
	srv := httptest.NewServer(s)
	defer srv.Close()
	cookie, _ := us.Login("Steve", "Steve-password")
	call := func(method, path string, body io.Reader) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, body)
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	defer func(m, step int64, free func(string) (int64, bool)) { MinFree, floorStep, diskFree = m, step, free }(MinFree, floorStep, diskFree)

	// The disk has room when the upload starts and reaches the floor while it arrives. The
	// body gives no length (chunked), which is how a member would dodge the first check.
	MinFree, floorStep = 1000, 1<<10
	looks := 0
	diskFree = func(string) (int64, bool) {
		if looks++; looks == 1 {
			return 1 << 40, true
		}
		return 0, true
	}
	code, _ := call("PUT", "/api/file/large/big.bin", io.MultiReader(strings.NewReader(strings.Repeat("x", 64<<10))))
	if code != http.StatusInsufficientStorage {
		t.Errorf("upload that reaches the floor: %d, want 507", code)
	}
	diskFree = func(string) (int64, bool) { return 1 << 40, true }
	if code, _ = call("GET", "/api/stat/large/big.bin", nil); code != http.StatusNotFound {
		t.Errorf("the stopped upload was kept: stat %d", code)
	}
	if code, _ = call("PUT", "/api/file/large/ok.bin", strings.NewReader(strings.Repeat("x", 64<<10))); code != http.StatusOK {
		t.Errorf("upload with room: %d", code)
	}

	// A link the hub hasn't fetched isn't fetched below the floor.
	diskFree = func(string) (int64, bool) { return 500, true }
	if code, _ = call("GET", "/api/preview?url=https%3A%2F%2Fexample.com%2Fnew", nil); code != http.StatusInsufficientStorage {
		t.Errorf("new preview below the floor: %d, want 507", code)
	}
	diskFree = func(string) (int64, bool) { return 1 << 40, true }

	// Search's text cache starts over at its limit and never holds more.
	defer func(m int64) { maxTextCache = m }(maxTextCache)
	maxTextCache = 2500
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		ws.Write("notes/"+n+".txt", []byte(strings.Repeat(n+" word ", 150)), "", workspace.Author{Name: "Steve"})
	}
	for range 2 {
		if code, b := call("GET", "/api/search?q=word", nil); code != 200 || !strings.Contains(b, "notes/e.txt") {
			t.Fatalf("search: %d %s", code, b)
		}
		if s.texts.bytes > maxTextCache {
			t.Errorf("text cache holds %d bytes, limit %d", s.texts.bytes, maxTextCache)
		}
	}
	held := int64(0)
	for _, f := range s.texts.files {
		held += int64(len(f.text))
	}
	if held != s.texts.bytes {
		t.Errorf("text cache says %d bytes, holds %d", s.texts.bytes, held)
	}
}

// A member's HTML or SVG never opens as a page under the hub's address: in Files or posted in
// a chat, it is sent as a download. Pictures and text still open.
func TestPagesOnlyDownload(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Steve", "Steve-password")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	cookie, _ := us.Login("Steve", "Steve-password")
	do := func(method, path, body string) *http.Response {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}
	for name, download := range map[string]bool{"login.html": true, "Page.HTM": true, "drawing.svg": true, "feed.xml": true, "notes.txt": false, "pic.png": false} {
		do("PUT", "/api/file/notes/"+name, "<html>session expired</html>")
		do("POST", "/api/channels/general/media?name="+name, "<html>session expired</html>")
		for _, url := range []string{"/api/file/notes/" + name, "/api/channels/general/media/" + name} {
			res := do("GET", url, "")
			if got := strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment"); res.StatusCode != 200 || got != download {
				t.Errorf("%s: %d, sent as a download: %v, want %v", url, res.StatusCode, got, download)
			}
		}
	}
}

// A game server's token has a byte budget for the day as well as a count.
func TestShotBudget(t *testing.T) {
	var b budget
	if !b.spend("survival", 60, 100) || !b.spend("survival", 40, 100) {
		t.Fatal("refused within the budget")
	}
	if b.spend("survival", 1, 100) {
		t.Fatal("went over the budget")
	}
	if !b.spend("creative", 100, 100) {
		t.Fatal("budget isn't per server")
	}
}
