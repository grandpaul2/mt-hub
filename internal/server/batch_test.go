package server

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// A selection is moved, copied, deleted and zipped in one call each; a taken name is named
// and nothing moves; tokens can't use any of it; a copy checks the disk first.
func TestBatchRoutes(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Steve", "Steve-password")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	cookie, _ := us.Login("Steve", "Steve-password")
	survival, _, _ := us.NewToken("survival", "")
	release, _, _ := us.NewReleaseToken("")
	call := func(token, method, path, body string) (int, string, http.Header) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if token == "" {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		} else {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b), res.Header
	}
	tree := func() string {
		t.Helper()
		entries, _ := ws.Tree()
		var out []string
		for _, e := range entries {
			if !e.Dir {
				out = append(out, e.Path)
			}
		}
		return strings.Join(out, " ")
	}
	for _, p := range []string{"a.md", "b.md", "docs/c.md", "notes/keep.md", "notes/a.md"} {
		if code, body, _ := call("", "PUT", "/api/file/"+p+"?base=", p); code != 200 {
			t.Fatalf("seeding %s: %d %s", p, code, body)
		}
	}
	start := tree()

	for _, token := range []string{survival, release} {
		for _, c := range [][2]string{{"POST", "/api/batch/move"}, {"POST", "/api/batch/delete"}, {"POST", "/api/batch/copy"}, {"GET", "/api/zip?p=a.md"}} {
			if code, _, _ := call(token, c[0], c[1], `{"from":["b.md"],"paths":["b.md"],"to":"docs"}`); code != http.StatusForbidden {
				t.Errorf("a token on %s %s: %d, want 403", c[0], c[1], code)
			}
		}
	}

	// A taken name: 409 naming it, and b.md stays too.
	code, body, _ := call("", "POST", "/api/batch/move", `{"from":["b.md","a.md"],"to":"notes"}`)
	if code != http.StatusConflict || !strings.Contains(body, `"error":"a.md already exists in notes/"`) || !strings.Contains(body, `"name":"a.md"`) {
		t.Fatalf("clash: %d %s", code, body)
	}
	for body, want := range map[string]int{
		`{"from":[],"to":"notes"}`:                400,
		`{"from":["large","b.md"],"to":""}`:       400,
		`{"from":["gone.md","b.md"],"to":"docs"}`: 404,
		`{"from":["docs/.git/x"],"to":""}`:        400,
	} {
		if code, got, _ := call("", "POST", "/api/batch/move", body); code != want {
			t.Errorf("move %s: %d %s, want %d", body, code, got, want)
		}
	}
	if code, _, _ := call("", "POST", "/api/batch/delete", `{"paths":["b.md","large"]}`); code != 400 {
		t.Errorf("deleting large/: %d", code)
	}
	if tree() != start {
		t.Fatalf("a refused call changed the files: %s", tree())
	}

	if code, body, _ := call("", "POST", "/api/batch/move", `{"from":["b.md","docs"],"to":"notes"}`); code != 200 {
		t.Fatalf("move: %d %s", code, body)
	}
	if got := tree(); got != "a.md notes/a.md notes/b.md notes/docs/c.md notes/keep.md" {
		t.Fatalf("after the move: %s", got)
	}
	if _, body, _ := call("", "GET", "/api/moves", ""); !strings.Contains(body, `{"from":"b.md","to":"notes/b.md","author":"Steve"}`) || !strings.Contains(body, `{"from":"docs","to":"notes/docs","author":"Steve"}`) {
		t.Fatalf("moves: %s", body)
	}

	code, body, _ = call("", "POST", "/api/batch/copy", `{"from":["a.md","notes/docs"],"to":""}`)
	if code != 200 || strings.TrimSpace(body) != `{"paths":["a copy.md","docs"]}` {
		t.Fatalf("copy: %d %s", code, body)
	}
	func() {
		defer func(m int64) { MinFree = m }(MinFree)
		MinFree = 1 << 60
		if code, body, _ := call("", "POST", "/api/batch/copy", `{"from":["a.md"],"to":""}`); code != http.StatusInsufficientStorage {
			t.Errorf("copy with a full disk: %d %s", code, body)
		}
	}()

	q := url.Values{"p": {"notes/b.md", "notes/docs"}}
	code, body, h := call("", "GET", "/api/zip?"+q.Encode(), "")
	if code != 200 || h.Get("Content-Disposition") != `attachment; filename=notes.zip` {
		t.Fatalf("zip: %d %q", code, h.Get("Content-Disposition"))
	}
	zr, err := zip.NewReader(bytes.NewReader([]byte(body)), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if got := strings.Join(names, " "); got != "b.md docs/ docs/c.md" {
		t.Fatalf("zip entries: %s", got)
	}
	if code, _, h := call("", "GET", "/api/zip?p=a.md&p=notes/b.md", ""); code != 200 || h.Get("Content-Disposition") != `attachment; filename=files.zip` {
		t.Errorf("zip across folders: %d %q", code, h.Get("Content-Disposition"))
	}
	if code, _, h := call("", "GET", "/api/zip?p=a.md&p=gone.md", ""); code != 404 || h.Get("Content-Disposition") != "" {
		t.Errorf("zip with one missing: %d %q", code, h.Get("Content-Disposition"))
	}
	if code, _, _ := call("", "GET", "/api/zip", ""); code != 400 {
		t.Errorf("zip of nothing: %d", code)
	}

	if code, body, _ := call("", "POST", "/api/batch/delete", `{"paths":["notes","a copy.md","docs/c.md"]}`); code != 200 {
		t.Fatalf("delete: %d %s", code, body)
	}
	if got := tree(); got != "a.md" {
		t.Fatalf("after the delete: %s", got)
	}
}
