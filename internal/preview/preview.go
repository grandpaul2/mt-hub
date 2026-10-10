// Package preview makes chat link previews, Discord style. The server fetches a posted
// link once, reads its Open Graph tags (site, title, description, image, colour) and keeps
// its own copy of the preview image, so viewers' browsers never contact the site and old
// previews survive the site changing. YouTube links use YouTube's oEmbed endpoint.
//
//	<dir>/index.jsonl  one line per fetch; the last line for a URL wins
//	<dir>/img/<id>     preview images, named by content hash
//
// Anyone can post a link, so fetches only go to the public internet: never the LAN, the
// tailnet or this machine (see Public), with size and time limits.
package preview

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "golang.org/x/image/webp"
)

type Preview struct {
	URL   string    `json:"url"`
	Kind  string    `json:"kind"` // page | image | youtube | none (nothing to show)
	Site  string    `json:"site,omitempty"`
	Title string    `json:"title,omitempty"`
	Desc  string    `json:"desc,omitempty"`
	Color string    `json:"color,omitempty"` // the site's theme colour, for the card's edge
	Image string    `json:"image,omitempty"` // id of the cached image
	W     int       `json:"w,omitempty"`
	H     int       `json:"h,omitempty"`
	Large bool      `json:"large,omitempty"` // big image under the text, not a thumbnail beside it
	Video string    `json:"video,omitempty"` // YouTube video id
	Time  time.Time `json:"t"`
}

const (
	maxPage    = 1 << 20  // the tags are in the <head>; this is plenty
	maxImage   = 10 << 20 // preview images and directly linked images
	retryAfter = 24 * time.Hour
)

var ErrBadURL = errors.New("only http and https links get previews")

type Store struct {
	dir      string
	mu       sync.Mutex
	cache    map[string]Preview
	inflight map[string]chan struct{}
	client   *http.Client
	// Public says whether a fetch may connect to ip. Tests swap it to reach a local server.
	Public func(ip net.IP) bool
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "img"), 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, cache: map[string]Preview{}, inflight: map[string]chan struct{}{}, Public: Public}
	if data, err := os.ReadFile(filepath.Join(dir, "index.jsonl")); err == nil {
		for _, line := range bytes.Split(data, []byte("\n")) {
			var p Preview
			if json.Unmarshal(line, &p) == nil && p.URL != "" {
				s.cache[p.URL] = p
			}
		}
	}
	// Every connection, redirects included, is checked against the address actually
	// dialled, so DNS tricks can't point a public name at a private address.
	dialer := &net.Dialer{Timeout: 5 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, _ := net.SplitHostPort(address)
		if ip := net.ParseIP(host); ip == nil || !s.Public(ip) {
			return fmt.Errorf("preview: %s is not on the public internet", host)
		}
		return nil
	}}
	s.client = &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			Proxy:       nil,
			DialContext: dialer.DialContext,
			// A custom dialer turns HTTP/2 off unless asked; some sites behind Cloudflare
			// (minecraft.wiki) refuse Go over HTTP/1.1 but not over HTTP/2.
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 8 * time.Second,
			MaxIdleConns:          10,
			IdleConnTimeout:       30 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return ErrBadURL
			}
			return nil
		},
	}
	return s, nil
}

// cgnat is 100.64.0.0/10: carrier NAT, and the tailnet's addresses.
var cgnat = &net.IPNet{IP: net.IP{100, 64, 0, 0}, Mask: net.CIDRMask(10, 32)}

// Public reports whether ip is an ordinary internet address: not this machine, the LAN,
// the tailnet, link-local or multicast.
func Public(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() || cgnat.Contains(ip) ||
		ip.To4() != nil && ip.To4()[0] == 0 {
		return false
	}
	for _, n := range special {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

// special is the ranges that aren't ordinary internet addresses and that net.IP has no test
// for: protocol assignments, benchmarking, reserved, and the two that wrap an IPv4 address
// in IPv6 (NAT64 and 6to4), through which a private address could be reached on a network
// with such a gateway.
var special = func() (out []*net.IPNet) {
	for _, c := range []string{"192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4", "64:ff9b::/96", "64:ff9b:1::/48", "2002::/16"} {
		_, n, _ := net.ParseCIDR(c)
		out = append(out, n)
	}
	return
}()

// key is what a link is cached under: the URL as fetch writes it into Preview.URL, which is
// also what index.jsonl is reloaded by, so "HTTP://x/Café" is still cached after a restart.
func key(rawURL string) string {
	if u, err := url.Parse(rawURL); err == nil {
		return u.String()
	}
	return rawURL
}

// Cached says whether Get would answer rawURL without fetching anything new.
func (s *Store) Cached(rawURL string) bool {
	k := key(rawURL)
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.cache[k]
	_, busy := s.inflight[k]
	return busy || ok && (p.Kind != "none" || time.Since(p.Time) < retryAfter)
}

// Get returns the preview for rawURL, fetching it the first time (and again a day after
// a fetch that found nothing). Concurrent asks for one URL share a single fetch.
func (s *Store) Get(ctx context.Context, rawURL string) (Preview, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(rawURL) > 2048 {
		return Preview{}, ErrBadURL
	}
	k := u.String()
	for {
		s.mu.Lock()
		p, ok := s.cache[k]
		if ok && (p.Kind != "none" || time.Since(p.Time) < retryAfter) {
			s.mu.Unlock()
			return p, nil
		}
		wait, busy := s.inflight[k]
		if !busy {
			done := make(chan struct{})
			s.inflight[k] = done
			s.mu.Unlock()
			p = s.fetch(u)
			s.mu.Lock()
			s.cache[k] = p
			delete(s.inflight, k)
			s.mu.Unlock()
			close(done)
			s.append(p)
			return p, nil
		}
		s.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return Preview{}, ctx.Err()
		}
	}
}

func (s *Store) append(p Preview) {
	line, _ := json.Marshal(p)
	f, err := os.OpenFile(filepath.Join(s.dir, "index.jsonl"), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return
	}
	f.Write(append(line, '\n'))
	f.Close()
}

// ImagePath is where a cached image lives, or "" for an id that can't be one.
func (s *Store) ImagePath(id string) string {
	if !imageID.MatchString(id) {
		return ""
	}
	return filepath.Join(s.dir, "img", id)
}

var imageID = regexp.MustCompile(`^[0-9a-f]{32}\.(png|jpg|gif|webp)$`)

// fetch builds a preview. Failures give Kind "none": nothing is shown, and the link stays
// a plain link.
func (s *Store) fetch(u *url.URL) Preview {
	p := Preview{URL: u.String(), Kind: "none", Time: time.Now().UTC()}
	if id := youtubeID(u); id != "" {
		return s.youtube(p, id)
	}
	resp, err := s.get(u.String(), "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5")
	if err != nil {
		return p
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "image/") {
		// A link straight to an image (or GIF): the preview is the image itself.
		if id, w, h := s.saveFrom(resp.Body); id != "" {
			p.Kind, p.Image, p.W, p.H, p.Large = "image", id, w, h, true
		}
		return p
	}
	if !strings.Contains(ct, "html") {
		return p
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxPage))
	m := metas(body)
	base := resp.Request.URL // after redirects
	p.Site = first(m["og:site_name"], m["application-name"], strings.TrimPrefix(base.Hostname(), "www."))
	p.Title = clip(first(m["og:title"], m["twitter:title"], m["<title>"]), 256)
	p.Desc = clip(first(m["og:description"], m["twitter:description"], m["description"]), 350)
	p.Color = colour(m["theme-color"])
	if img := first(m["og:image:secure_url"], m["og:image"], m["og:image:url"], m["twitter:image"], m["twitter:image:src"]); img != "" {
		if ref, err := base.Parse(img); err == nil {
			p.Image, p.W, p.H = s.saveURL(ref.String())
		}
	}
	if p.Title == "" && p.Desc == "" && p.Image == "" {
		return p
	}
	p.Kind = "page"
	// Big image under the text, unless the site asks for a small card or the image is small.
	p.Large = p.Image != "" && m["twitter:card"] != "summary" && p.W >= 300
	return p
}

func (s *Store) youtube(p Preview, id string) Preview {
	resp, err := s.get("https://www.youtube.com/oembed?format=json&url="+
		url.QueryEscape("https://www.youtube.com/watch?v="+id), "application/json")
	if err != nil {
		return p
	}
	defer resp.Body.Close()
	var o struct {
		Title        string `json:"title"`
		AuthorName   string `json:"author_name"`
		ThumbnailURL string `json:"thumbnail_url"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, maxPage)).Decode(&o) != nil {
		return p
	}
	p.Kind, p.Site, p.Color, p.Video, p.Large = "youtube", "YouTube", "#ff0000", id, true
	p.Title, p.Desc = clip(o.Title, 256), clip(o.AuthorName, 100)
	// The full-size thumbnail where there is one; oEmbed's is small.
	p.Image, p.W, p.H = s.saveURL("https://i.ytimg.com/vi/" + id + "/maxresdefault.jpg")
	if p.Image == "" && o.ThumbnailURL != "" {
		p.Image, p.W, p.H = s.saveURL(o.ThumbnailURL)
	}
	return p
}

var ytID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

func youtubeID(u *url.URL) string {
	host := strings.TrimPrefix(strings.TrimPrefix(u.Hostname(), "www."), "m.")
	var id string
	switch host {
	case "youtu.be":
		id = strings.Trim(u.Path, "/")
	case "youtube.com", "music.youtube.com":
		if u.Path == "/watch" {
			id = u.Query().Get("v")
		} else if rest, ok := strings.CutPrefix(u.Path, "/shorts/"); ok {
			id = rest
		} else if rest, ok := strings.CutPrefix(u.Path, "/live/"); ok {
			id = rest
		}
	}
	if ytID.MatchString(id) {
		return id
	}
	return ""
}

func (s *Store) get(rawURL, accept string) (*http.Response, error) {
	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; mt-hub link preview)")
	req.Header.Set("Accept", accept)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s: %s", rawURL, resp.Status)
	}
	return resp, nil
}

func (s *Store) saveURL(rawURL string) (id string, w, h int) {
	resp, err := s.get(rawURL, "image/*")
	if err != nil {
		return "", 0, 0
	}
	defer resp.Body.Close()
	return s.saveFrom(resp.Body)
}

// saveFrom keeps an image if it really is one (by its bytes, not the server's word) in a
// format browsers show safely: PNG, JPEG, GIF or WebP. No SVG, which can carry script.
func (s *Store) saveFrom(r io.Reader) (id string, w, h int) {
	data, err := io.ReadAll(io.LimitReader(r, maxImage+1))
	if err != nil || len(data) > maxImage {
		return "", 0, 0
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", 0, 0
	}
	ext := map[string]string{"png": "png", "jpeg": "jpg", "gif": "gif", "webp": "webp"}[format]
	if ext == "" {
		return "", 0, 0
	}
	sum := sha256.Sum256(data)
	id = hex.EncodeToString(sum[:16]) + "." + ext
	path := filepath.Join(s.dir, "img", id)
	if _, err := os.Stat(path); err != nil {
		tmp := path + ".tmp"
		if os.WriteFile(tmp, data, 0o644) != nil || os.Rename(tmp, path) != nil {
			os.Remove(tmp)
			return "", 0, 0
		}
	}
	return id, cfg.Width, cfg.Height
}

// metas reads <meta> tags and the <title> from a page: name or property -> content, the
// first one winning. A small scanner rather than a full HTML parser: the tags are simple
// and only the head matters.
var (
	metaTag  = regexp.MustCompile(`(?is)<meta\s[^>]*>`)
	attr     = regexp.MustCompile(`(?is)([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))`)
	titleTag = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
)

func metas(page []byte) map[string]string {
	m := map[string]string{}
	for _, tag := range metaTag.FindAll(page, -1) {
		a := map[string]string{}
		for _, kv := range attr.FindAllSubmatch(tag, -1) {
			a[strings.ToLower(string(kv[1]))] = string(kv[3]) + string(kv[4]) + string(kv[5])
		}
		key := strings.ToLower(first(a["property"], a["name"]))
		if key != "" && m[key] == "" {
			m[key] = strings.TrimSpace(html.UnescapeString(a["content"]))
		}
	}
	if t := titleTag.FindSubmatch(page); t != nil {
		m["<title>"] = strings.TrimSpace(html.UnescapeString(string(t[1])))
	}
	return m
}

var hexColour = regexp.MustCompile(`^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$`)

// colour passes on a theme colour only if it's a plain #rgb/#rrggbb (it goes into CSS).
func colour(c string) string {
	if hexColour.MatchString(c) {
		return c
	}
	return ""
}

func first(vals ...string) string {
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

// clip shortens s to n characters, whitespace collapsed, ending in … if cut.
func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return strings.TrimSpace(string(r[:n-1])) + "…"
	}
	return s
}
