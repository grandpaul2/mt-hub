package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const (
	tokA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	tokB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func startRelay(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(newRelay(map[string]string{tokA: "survival", tokB: "creative"}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func dial(t *testing.T, url, tok string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + tok}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	return ws
}

func send(t *testing.T, ws *websocket.Conn, b []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ws.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatal(err)
	}
}

// next returns the next message that isn't a status, or fails after a timeout.
func next(t *testing.T, ws *websocket.Conn) []byte {
	t.Helper()
	for {
		b := read(t, ws)
		if b[0] != msgStatus {
			return b
		}
	}
}

func read(t *testing.T, ws *websocket.Conn) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func status(t *testing.T, ws *websocket.Conn, want string) {
	t.Helper()
	for {
		b := read(t, ws)
		if b[0] != msgStatus {
			continue
		}
		var s struct {
			Servers []string
			You     string
		}
		json.Unmarshal(b[1:], &s)
		if s.You == "" {
			t.Fatalf("status without you: %s", b[1:])
		}
		if strings.Join(s.Servers, ",") == want {
			return
		}
	}
}

func TestRejectsBadToken(t *testing.T) {
	url := startRelay(t)
	_, resp, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer nope"}}})
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %v %v", resp, err)
	}
}

func TestAudioGoesToTheOtherServerUntouched(t *testing.T) {
	url := startRelay(t)
	a := dial(t, url, tokA)
	b := dial(t, url, tokB)
	status(t, a, "creative,survival")
	status(t, b, "creative,survival")

	speaker := bytes.Repeat([]byte{7}, 16)
	opus := []byte{1, 2, 3, 250}
	send(t, a, append(append([]byte{msgAudio}, speaker...), opus...))
	want := tagged(msgAudio, "survival", append(append([]byte{}, speaker...), opus...))
	if got := next(t, b); !bytes.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}

	// "Stopped talking" is a speaker with no Opus bytes; it goes through too.
	send(t, a, append([]byte{msgAudio}, speaker...))
	if got := next(t, b); !bytes.Equal(got, tagged(msgAudio, "survival", speaker)) {
		t.Fatalf("stop: got %v", got)
	}

	// Nothing comes back to the sender: its next message is B's roster.
	send(t, b, append([]byte{msgRoster}, `{"members":[]}`...))
	if got := next(t, a); got[0] != msgRoster || !bytes.HasSuffix(got, []byte(`{"members":[]}`)) {
		t.Fatalf("sender got %v", got)
	}
}

func TestLateServerGetsRosters(t *testing.T) {
	url := startRelay(t)
	a := dial(t, url, tokA)
	status(t, a, "survival")
	roster := []byte(`{"members":[{"uuid":"x","name":"Eldridge"}]}`)
	send(t, a, append([]byte{msgRoster}, roster...))
	time.Sleep(100 * time.Millisecond)

	b := dial(t, url, tokB)
	if got := next(t, b); !bytes.Equal(got, tagged(msgRoster, "survival", roster)) {
		t.Fatalf("got %q", got)
	}
}

func TestDisconnectUpdatesStatus(t *testing.T) {
	url := startRelay(t)
	a := dial(t, url, tokA)
	b := dial(t, url, tokB)
	status(t, a, "creative,survival")
	b.Close(websocket.StatusNormalClosure, "")
	status(t, a, "survival")
}

func TestReconnectReplacesOldConnection(t *testing.T) {
	url := startRelay(t)
	old := dial(t, url, tokA)
	status(t, old, "survival")
	b := dial(t, url, tokB)
	_ = dial(t, url, tokA)
	status(t, b, "creative,survival")

	// The old connection is closed by the relay.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := old.Read(ctx); err != nil {
			if ctx.Err() != nil {
				t.Fatal("old connection still open")
			}
			return
		}
	}
}

func TestLoadTokens(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.json")
	os.WriteFile(p, []byte(`{"tokens":{"short":"survival"}}`), 0o600)
	if _, err := loadTokens(p); err == nil {
		t.Fatal("short token accepted")
	}
	os.WriteFile(p, []byte(`{"tokens":{"`+tokA+`":"survival"}}`), 0o600)
	if m, err := loadTokens(p); err != nil || m[tokA] != "survival" {
		t.Fatal(m, err)
	}
}
