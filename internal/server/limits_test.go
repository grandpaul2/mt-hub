package server

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// The tests' data lives on a small /tmp; TestDiskFloor puts the floor back.
func init() { MinFree = 0 }

// Uploads that would leave less than MinFree free are refused.
func TestDiskFloor(t *testing.T) {
	defer func(m int64) { MinFree = m }(MinFree)
	s := &Server{thumbs: filepath.Join(t.TempDir(), "thumbs")}
	MinFree = 1 << 60
	if w := httptest.NewRecorder(); s.roomFor(w, 10) || w.Code != http.StatusInsufficientStorage {
		t.Fatalf("over the floor: %d", w.Code)
	}
	MinFree = 0
	if w := httptest.NewRecorder(); !s.roomFor(w, 10) {
		t.Fatal("refused with room")
	}
}

// A tiny PNG that claims to be 40000x40000 is refused before it's decoded (decoded, it
// would take 6 GB); an ordinary picture still gets its thumbnail.
func TestThumbBomb(t *testing.T) {
	dir := t.TempDir()
	ws, err := workspace.Open(filepath.Join(dir, "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	small := bytes.Clone(buf.Bytes())
	bomb := buf.Bytes()
	// IHDR starts at byte 8: length, "IHDR", width, height, ..., then a CRC over type+data.
	binary.BigEndian.PutUint32(bomb[16:], 40000)
	binary.BigEndian.PutUint32(bomb[20:], 40000)
	binary.BigEndian.PutUint32(bomb[29:], crc32.ChecksumIEEE(bomb[12:29]))
	for name, b := range map[string][]byte{"bomb.png": bomb, "small.png": small} {
		if _, err := ws.Write(name, b, "", workspace.Author{Name: "t"}); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{ws: ws, thumbs: filepath.Join(dir, "thumbs"), mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /api/thumb/{path...}", s.thumb)
	for name, want := range map[string]int{"bomb.png": http.StatusUnprocessableEntity, "small.png": http.StatusOK} {
		w := httptest.NewRecorder()
		s.mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/thumb/"+name, nil))
		if w.Code != want {
			t.Errorf("%s: %d, want %d", name, w.Code, want)
		}
	}
}

// Previews of links not fetched yet are limited per person.
func TestPreviewLimit(t *testing.T) {
	l := newLimiter(previewTries, previewWindow)
	for i := range previewTries {
		if !l.take("Steve") {
			t.Fatalf("try %d refused", i)
		}
	}
	if l.take("Steve") || !l.take("Alex") {
		t.Fatal("limit not per person")
	}
}

// Straight to the hub's port: only this machine and the tailnet are answered.
func TestTunnelOrTailnet(t *testing.T) {
	h := TunnelOrTailnet(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	for addr, want := range map[string]int{"127.0.0.1:5000": 200, "[::1]:5000": 200, "100.100.100.100:5000": 200,
		"[fd7a:115c:a1e0::1]:5000": 200, "192.168.1.5:5000": 403, "203.0.113.9:5000": 403} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = addr
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Errorf("%s: %d, want %d", addr, w.Code, want)
		}
	}
}
