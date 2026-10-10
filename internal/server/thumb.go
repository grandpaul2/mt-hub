package server

import (
	"crypto/sha1"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/grandpaul2/mt-hub/internal/imgs"
)

// thumbable are the workspace images chat shows a thumbnail of (GIFs show as themselves,
// so they keep moving).
var thumbable = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".webp": true}

// maxThumbPixels is the biggest picture made into a thumbnail (64 Mpx, 256 MB decoded); a
// Minecraft screenshot is 2-8 Mpx, a big map art render maybe 30.
const maxThumbPixels = 64 << 20

// thumbing lets one picture be decoded at a time.
var thumbing = make(chan struct{}, 1)

// thumb serves a small JPEG of a workspace image (chat media previews), made on first
// request and kept in <data>/thumbs by path, size and modification time, so a replaced
// file gets a new one. The page adds ?v=<mod> so browsers may cache it for good.
func (s *Server) thumb(w http.ResponseWriter, r *http.Request) {
	p, ok := cleanPath(w, r)
	if !ok {
		return
	}
	if !thumbable[strings.ToLower(path.Ext(p))] {
		http.NotFound(w, r)
		return
	}
	f, info, err := s.ws.OpenFile(p)
	if err != nil {
		fail(w, err)
		return
	}
	defer f.Close()
	s.serveThumb(w, r, p, f, info)
}

// serveThumb serves the thumbnail of the picture f, whose cache key is id (plus its size and
// modification time).
func (s *Server) serveThumb(w http.ResponseWriter, r *http.Request, id string, f *os.File, info os.FileInfo) {
	// A picture with transparency (schematic renders) keeps it in a PNG; the rest are JPEGs.
	key := fmt.Sprintf("%x", sha1.Sum([]byte(fmt.Sprintf("%s\x00%d\x00%d", id, info.Size(), info.ModTime().UnixNano()))))
	dst := filepath.Join(s.thumbs, key+".jpg")
	if _, err := os.Stat(filepath.Join(s.thumbs, key+".png")); err == nil {
		dst = filepath.Join(s.thumbs, key+".png")
	} else if _, err := os.Stat(dst); err != nil {
		// A small file can claim a huge picture (a decompression bomb): measure it before
		// decoding, and decode one at a time, so thumbnails can't run the hub out of memory.
		cfg, _, err := image.DecodeConfig(f)
		if err != nil {
			http.Error(w, "not an image", http.StatusUnsupportedMediaType)
			return
		}
		if cfg.Width*cfg.Height > maxThumbPixels {
			http.Error(w, "too big to preview", http.StatusUnprocessableEntity)
			return
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			fail(w, err)
			return
		}
		thumbing <- struct{}{}
		img, _, err := image.Decode(f)
		<-thumbing
		if err != nil {
			http.Error(w, "not an image", http.StatusUnsupportedMediaType)
			return
		}
		if o, ok := img.(interface{ Opaque() bool }); ok && !o.Opaque() {
			dst = filepath.Join(s.thumbs, key+".png")
		}
		if err := os.MkdirAll(s.thumbs, 0o755); err != nil {
			fail(w, err)
			return
		}
		tmp := strings.TrimSuffix(dst, filepath.Ext(dst)) + ".tmp" + filepath.Ext(dst) // WriteThumb picks the format by extension
		if err := imgs.WriteThumb(tmp, img); err != nil {
			fail(w, err)
			return
		}
		if err := os.Rename(tmp, dst); err != nil {
			fail(w, err)
			return
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, dst)
}
