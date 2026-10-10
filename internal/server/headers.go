package server

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// securityHeaders are the browser's safety settings, on every response:
//   - HSTS (over HTTPS only): the browser never tries plain http for this site again.
//   - nosniff, a referrer policy, and no framing by other sites.
//   - On the page and its workers (not /api/), a Content Security Policy: scripts, styles,
//     fonts and pictures only from the hub itself, connections only to the hub and its
//     voice server, frames only from YouTube. A bug that slipped some HTML in still
//     couldn't load or send anything elsewhere.
//
// wasm-unsafe-eval is for the voice filters and Silero (WebAssembly); blob: scripts and
// workers are the voice worklets; inline styles are Monaco's.
func (s *Server) securityHeaders(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	if r.TLS != nil || (viaProxy(r) && r.Header.Get("X-Forwarded-Proto") == "https") {
		h.Set("Strict-Transport-Security", "max-age=31536000")
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	h.Set("X-Frame-Options", "DENY")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		return
	}
	connect := "'self'"
	if c := s.voiceConfig(); c != nil {
		if u, err := url.Parse(c.URL); err == nil && u.Host != "" {
			connect += " " + u.Scheme + "://" + u.Host
		}
	}
	h.Set("Content-Security-Policy", "default-src 'self'; "+
		"script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; "+
		"style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; "+
		"connect-src "+connect+"; frame-src https://www.youtube-nocookie.com; "+
		"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
}

// voiceConfig is nil when voice chats are off (or in tests that build a bare Server).
func (s *Server) voiceConfig() *voiceConf {
	if s.voice == nil {
		return nil
	}
	return s.voice.config()
}

// tailnet is Tailscale's address ranges (IPv4 and IPv6).
var tailnet = []*net.IPNet{mustCIDR("100.64.0.0/10"), mustCIDR("fd7a:115c:a1e0::/48")}

func mustCIDR(s string) *net.IPNet { _, n, _ := net.ParseCIDR(s); return n }

// TunnelOrTailnet answers only connections from this machine (the tunnel from Caddy) and
// the tailnet. On the home network the hub is plain http, so a password typed there would
// cross it readable; everyone else is pointed at the public address.
func TunnelOrTailnet(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if ip != nil && (ip.IsLoopback() || tailnet[0].Contains(ip) || tailnet[1].Contains(ip)) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte("Use https://macrotechmc.com\n"))
	})
}
