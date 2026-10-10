package preview

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func pngBytes(w, h int) []byte {
	var b bytes.Buffer
	png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h)))
	return b.Bytes()
}

// site serves a page with Open Graph tags, its image, a bare image and an SVG.
func site(t *testing.T, hits *atomic.Int32) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/farm", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<!doctype html><html><head>
<title>ignored when og:title exists</title>
<meta property="og:site_name" content="Farm Wiki">
<meta property='og:title' content="Gold Farm &amp; Bartering">
<meta name="description" content="  A   fast
gold farm.  ">
<meta property="og:image" content="/img/card.png">
<meta name="theme-color" content="#3a7bd5">
</head><body>hi</body></html>`))
	})
	mux.HandleFunc("/plain", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><head><title>Just a title</title><meta name="theme-color" content="red;}body{x"></head></html>`))
	})
	mux.HandleFunc("/img/card.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(pngBytes(1200, 630))
	})
	mux.HandleFunc("/pic.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(pngBytes(64, 48))
	})
	mux.HandleFunc("/evil.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func openTest(t *testing.T, dir string) *Store {
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Public = func(net.IP) bool { return true } // the test site is on localhost
	return s
}

func TestPagePreview(t *testing.T) {
	var hits atomic.Int32
	srv := site(t, &hits)
	dir := t.TempDir()
	s := openTest(t, dir)
	ctx := context.Background()

	p, err := s.Get(ctx, srv.URL+"/farm")
	if err != nil {
		t.Fatal(err)
	}
	if p.Kind != "page" || p.Site != "Farm Wiki" || p.Title != "Gold Farm & Bartering" || p.Desc != "A fast gold farm." ||
		p.Color != "#3a7bd5" || p.W != 1200 || p.H != 630 || !p.Large {
		t.Fatalf("preview: %+v", p)
	}
	if _, err := os.Stat(s.ImagePath(p.Image)); err != nil {
		t.Fatalf("image not cached: %v", err)
	}

	// Title only; a theme colour that isn't a plain hex colour is dropped (it goes into CSS).
	p, _ = s.Get(ctx, srv.URL+"/plain")
	if p.Kind != "page" || p.Title != "Just a title" || p.Color != "" || p.Image != "" {
		t.Fatalf("plain: %+v", p)
	}

	// A link straight to an image.
	p, _ = s.Get(ctx, srv.URL+"/pic.png")
	if p.Kind != "image" || p.W != 64 || p.H != 48 {
		t.Fatalf("image: %+v", p)
	}
	// SVG can carry script: never kept.
	if p, _ = s.Get(ctx, srv.URL+"/evil.svg"); p.Kind != "none" {
		t.Fatalf("svg: %+v", p)
	}
	if _, err := s.Get(ctx, "javascript:alert(1)"); err != ErrBadURL {
		t.Fatalf("bad scheme: %v", err)
	}

	// Many viewers at once: one fetch. Then cached, also after a restart.
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); s.Get(ctx, srv.URL+"/farm?x=1") }()
	}
	wg.Wait()
	before := hits.Load()
	s2 := openTest(t, dir)
	if p, _ := s2.Get(ctx, srv.URL+"/farm?x=1"); p.Title != "Gold Farm & Bartering" || hits.Load() != before {
		t.Fatalf("cache after restart: %+v, hits %d -> %d", p, before, hits.Load())
	}
	if hits.Load() != 2 { // /farm once, /farm?x=1 once
		t.Fatalf("page fetched %d times", hits.Load())
	}

	// A link written differently from how it's stored (accents, an upper-case scheme) is
	// cached after a restart too, rather than fetched again on every restart.
	for _, raw := range []string{srv.URL + "/Café", "HTTP" + strings.TrimPrefix(srv.URL, "http") + "/plain"} {
		s.Get(ctx, raw)
		if !openTest(t, dir).Cached(raw) {
			t.Errorf("%s not cached after a restart", raw)
		}
	}
}

func TestOnlyPublicAddresses(t *testing.T) {
	var hits atomic.Int32
	srv := site(t, &hits)
	s, _ := Open(t.TempDir()) // the real check: localhost is refused
	if p, _ := s.Get(context.Background(), srv.URL+"/farm"); p.Kind != "none" || hits.Load() != 0 {
		t.Fatalf("fetched a local address: %+v (hits %d)", p, hits.Load())
	}
	for ip, want := range map[string]bool{
		"127.0.0.1": false, "192.168.1.50": false, "10.0.0.5": false, "172.16.3.4": false,
		"100.100.100.100": false, "169.254.169.254": false, "0.0.0.0": false, "::1": false,
		"192.0.0.8": false, "198.18.0.1": false, "240.0.0.1": false, "64:ff9b::a00:5": false, "2002:c0a8:101::1": false,
		"fd7a:115c:a1e0::1": false, "fe80::1": false,
		"8.8.8.8": true, "93.184.216.34": true, "2606:4700:4700::1111": true,
	} {
		if got := Public(net.ParseIP(ip)); got != want {
			t.Errorf("Public(%s) = %v, want %v", ip, got, want)
		}
	}
}

func TestYouTubeIDs(t *testing.T) {
	for in, want := range map[string]string{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10": "dQw4w9WgXcQ",
		"https://youtu.be/dQw4w9WgXcQ?si=abc":              "dQw4w9WgXcQ",
		"https://m.youtube.com/shorts/dQw4w9WgXcQ":         "dQw4w9WgXcQ",
		"https://youtube.com/live/dQw4w9WgXcQ":             "dQw4w9WgXcQ",
		"https://www.youtube.com/@somechannel":             "",
		"https://notyoutube.com/watch?v=dQw4w9WgXcQ":       "",
	} {
		u, _ := url.Parse(in)
		if got := youtubeID(u); got != want {
			t.Errorf("youtubeID(%s) = %q, want %q", in, got, want)
		}
	}
}
