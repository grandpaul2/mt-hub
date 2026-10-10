package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestStaticCaching(t *testing.T) {
	static := fstest.MapFS{ // no modification times, like the embedded copy
		"index.html":                     {Data: []byte("<html>")},
		"app.js":                         {Data: []byte("app")},
		"noto-sans-latin-ABCD1234.woff2": {Data: []byte("font")},
		"icons/folder.svg":               {Data: []byte("<svg>")},
	}
	etags, err := HashFiles(static)
	if err != nil {
		t.Fatal(err)
	}
	h := staticFiles(static, etags)
	get := func(path, inm string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		if inm != "" {
			r.Header.Set("If-None-Match", inm)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, c := range []struct{ path, cache string }{
		{"/", "no-cache"},
		{"/app.js", "no-cache"},
		{"/noto-sans-latin-ABCD1234.woff2", "public, max-age=31536000, immutable"},
		{"/icons/folder.svg", "public, max-age=86400"},
	} {
		w := get(c.path, "")
		tag := w.Header().Get("ETag")
		if w.Code != http.StatusOK || tag == "" || w.Header().Get("Cache-Control") != c.cache {
			t.Errorf("%s: %d etag %q cache %q", c.path, w.Code, tag, w.Header().Get("Cache-Control"))
			continue
		}
		if w := get(c.path, tag); w.Code != http.StatusNotModified || w.Body.Len() != 0 {
			t.Errorf("%s again: %d with %d bytes, want 304", c.path, w.Code, w.Body.Len())
		}
		if w := get(c.path, `"stale"`); w.Code != http.StatusOK {
			t.Errorf("%s with a stale tag: %d, want 200", c.path, w.Code)
		}
	}
}
