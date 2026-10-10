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

// Plain mistakes with files say what's wrong rather than "internal error", and a version
// from history answers range requests (so a video from it can be seeked).
func TestFileMistakesAndRanges(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Paul", "Paul-password")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	cookie, _ := us.Login("Paul", "Paul-password")
	call := func(method, path, body string, hdr ...string) (int, string, http.Header) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		for i := 0; i+1 < len(hdr); i += 2 {
			r.Header.Set(hdr[i], hdr[i+1])
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b), res.Header
	}

	call("PUT", "/api/file/notes/keep.md?base=", "keep")
	for path, want := range map[string]string{
		"/api/file/notes?base=":                               "there’s a folder with that name",
		"/api/file/notes/keep.md/sub.md?base=":                "a file can’t have files inside it",
		"/api/file/" + strings.Repeat("n", 300) + ".md?base=": "that name is too long",
	} {
		code, body, _ := call("PUT", path, "x")
		if code >= 500 || !strings.Contains(body, want) {
			t.Errorf("PUT %.40s: %d %s, want %q", path, code, body, want)
		}
	}

	_, body, _ := call("PUT", "/api/file/clip.mp4?base=", "0123456789")
	rev := body[strings.Index(body, `"rev":"`)+7 : strings.LastIndex(body, `"`)]
	code, got, h := call("GET", "/api/file/clip.mp4?rev="+rev, "", "Range", "bytes=2-4")
	if code != 206 || got != "234" || h.Get("Content-Type") != "video/mp4" {
		t.Errorf("range on a version: %d %q %s", code, got, h.Get("Content-Type"))
	}
}
