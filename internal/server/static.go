package server

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
)

// Files whose names carry esbuild's content hash (the fonts) never change under that name.
var hashedName = regexp.MustCompile(`-[A-Z0-9]{8}\.[a-z0-9]+$`)

// staticFiles serves the frontend with caching headers. Embedded files have no modification
// time, so without an ETag the browser could never ask "changed?" and re-downloaded app.js
// (megabytes) and the fonts on every load. Each file's ETag is a hash of its content, taken
// once at startup; a browser that already has the file gets 304 Not Modified.
//   - hashed names (fonts): kept for a year without asking.
//   - icons/ and emoji/: kept for a day; they change only when their npm packages do.
//   - everything else (index.html, app.js, app.css, workers): asked about on every load.
//
// In -dev mode (etags nil) the on-disk files have real times, so Last-Modified does the job.
func staticFiles(static fs.FS, etags map[string]string) http.Handler {
	files := http.FileServerFS(static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" || strings.HasSuffix(name, "/") {
			name += "index.html"
		}
		if tag, ok := etags[name]; ok {
			w.Header().Set("ETag", tag)
		}
		switch {
		case hashedName.MatchString(name):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case strings.HasPrefix(name, "icons/"), strings.HasPrefix(name, "emoji/"):
			w.Header().Set("Cache-Control", "public, max-age=86400")
		default:
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

// HashFiles returns a strong ETag for every file in static, keyed by its path.
func HashFiles(static fs.FS) (map[string]string, error) {
	etags := map[string]string{}
	err := fs.WalkDir(static, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(static, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		etags[p] = `"` + hex.EncodeToString(sum[:12]) + `"`
		return nil
	})
	return etags, err
}
