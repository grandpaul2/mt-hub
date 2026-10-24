package voicelink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
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

// journal starts a relay whose log lines the test can read.
func journal(t *testing.T, idle time.Duration) (url string, lines func() string) {
	t.Helper()
	var mu sync.Mutex
	var buf strings.Builder
	r := newRelayLog(map[string]string{tokA: "survival", tokB: "creative"}, func(format string, a ...any) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(&buf, format+"\n", a...)
	})
	r.story.idle = idle
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http"), func() string {
		mu.Lock()
		defer mu.Unlock()
		return buf.String()
	}
}

// logged waits for a line containing all of want, in order, and returns it, or fails.
func logged(t *testing.T, lines func() string, want ...string) string {
	t.Helper()
	if len(want) == 0 {
		t.Fatal("logged needs something to look for")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		for _, l := range strings.Split(lines(), "\n") {
			rest, ok := l, true
			for _, w := range want {
				i := strings.Index(rest, w)
				if i < 0 {
					ok = false
					break
				}
				rest = rest[i+len(w):]
			}
			if ok {
				return l
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no line with %q in:\n%s", want, lines())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// storyLines keeps the journal's roster and spurt lines, leaving out the relay's own
// connect and disconnect lines, which land whenever the socket does.
func storyLines(all string) string {
	var out []string
	for _, l := range strings.Split(all, "\n") {
		if strings.Contains(l, " roster") || strings.Contains(l, " talked ") {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

func rosterMsg(members string) []byte {
	return append([]byte{msgRoster}, `{"members":[`+members+`]}`...)
}

const (
	emptropy  = `{"uuid":"05cd3a62-a9bc-4909-b941-cbc9ba1430d7","name":"Emptropy"}`
	grandpaul = `{"uuid":"3b1c0000-0000-0000-0000-000000000000","name":"grandpaul","mc":"Grandpaul2"}`
)

func TestJournalRosterChanges(t *testing.T) {
	url, lines := journal(t, time.Second)
	a := dial(t, url, tokA)
	status(t, a, "survival")

	send(t, a, rosterMsg(emptropy))
	logged(t, lines, "survival roster: +Emptropy (05cd3a62); now Emptropy (05cd3a62)")

	// A hub member carries the Minecraft name it plays as.
	send(t, a, rosterMsg(emptropy+","+grandpaul))
	logged(t, lines, "survival roster: +grandpaul (mc Grandpaul2) (3b1c0000); now Emptropy (05cd3a62), grandpaul (mc Grandpaul2) (3b1c0000)")

	// The same roster again says nothing; one leaving says who.
	before := lines()
	send(t, a, rosterMsg(emptropy+","+grandpaul))
	send(t, a, rosterMsg(grandpaul))
	logged(t, lines, "survival roster: -Emptropy (05cd3a62); now grandpaul (mc Grandpaul2) (3b1c0000)")
	if n := strings.Count(lines(), "roster:") - strings.Count(before, "roster:"); n != 1 {
		t.Fatalf("an unchanged roster logged a line:\n%s", lines())
	}

	// A member whose name changed is reported too; a name off the wire can't break a line.
	send(t, a, rosterMsg(`{"uuid":"3b1c0000-0000-0000-0000-000000000000","name":"grand\npaul","mc":"Grandpaul2"}`))
	logged(t, lines, "survival roster: ~grandpaul (mc Grandpaul2) (3b1c0000) is now grand?paul (mc Grandpaul2); now grand?paul (mc Grandpaul2) (3b1c0000)")

	send(t, a, append([]byte{msgRoster}, `not json`...))
	logged(t, lines, "survival roster: unreadable (8 bytes)")

	// An entry without a usable uuid is counted, not silently dropped; a long name is cut.
	send(t, a, rosterMsg(grandpaul+`,{"uuid":"x","name":"Eldridge"},{"uuid":"7e000000-0000-0000-0000-000000000000","name":"`+strings.Repeat("a", 60)+`"}`))
	logged(t, lines, "survival roster: 1 entry skipped (no uuid)")
	logged(t, lines, "survival roster: +"+strings.Repeat("a", 48)+"… (7e000000) ~grand?paul (mc Grandpaul2) (3b1c0000) is now grandpaul (mc Grandpaul2); now")
	send(t, a, rosterMsg(grandpaul))
	logged(t, lines, "survival roster: -"+strings.Repeat("a", 48)+"… (7e000000); now grandpaul (mc Grandpaul2) (3b1c0000)")

	// Another source's roster is its own story.
	b := dial(t, url, tokB)
	status(t, b, "creative,survival")
	send(t, b, rosterMsg(emptropy))
	logged(t, lines, "creative roster: +Emptropy (05cd3a62); now Emptropy (05cd3a62)")

	// The source disconnecting drops its roster; the other's stays.
	a.Close(websocket.StatusNormalClosure, "")
	logged(t, lines, "survival roster dropped with it: had grandpaul (mc Grandpaul2) (3b1c0000)")
	if strings.Contains(lines(), "creative roster dropped") {
		t.Fatalf("creative's roster went with survival:\n%s", lines())
	}
	t.Log("\n" + lines())
}

func TestJournalTalkSpurts(t *testing.T) {
	url, lines := journal(t, 400*time.Millisecond)
	a := dial(t, url, tokA)
	status(t, a, "survival")
	send(t, a, rosterMsg(emptropy))
	logged(t, lines, "survival roster: +Emptropy")

	speaker := []byte{0x05, 0xcd, 0x3a, 0x62, 0xa9, 0xbc, 0x49, 0x09, 0xb9, 0x41, 0xcb, 0xc9, 0xba, 0x14, 0x30, 0xd7}
	frame := append(append([]byte{msgAudio}, speaker...), 1, 2, 3)
	stop := append([]byte{msgAudio}, speaker...)

	// Three frames and a stop packet: one line, ended by the stop packet, with the start time.
	for i := 0; i < 3; i++ {
		send(t, a, frame)
	}
	send(t, a, stop)
	line := logged(t, lines, "survival: Emptropy (05cd3a62) talked", "3 frames, stop packet")
	if ok, _ := regexp.MatchString(`talked 0\.[0-9] s from [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}, 3 frames`, line); !ok {
		t.Fatalf("time and duration: %q", line)
	}

	// Two frames and silence: the line says no stop packet came.
	send(t, a, frame)
	send(t, a, frame)
	logged(t, lines, "survival: Emptropy (05cd3a62) talked", "2 frames, no stop packet, quiet since")

	// A stop packet with no spurt before it says nothing.
	before := lines()
	send(t, a, stop)
	time.Sleep(500 * time.Millisecond)
	if lines() != before {
		t.Fatalf("a lone stop packet logged:\n%s", strings.TrimPrefix(lines(), before))
	}

	// A speaker the roster does not know is still reported, and one frame is "1 frame".
	other := bytes.Repeat([]byte{9}, 16)
	send(t, a, append(append([]byte{msgAudio}, other...), 4))
	send(t, a, append([]byte{msgAudio}, other...))
	logged(t, lines, "survival: (not in its roster) (09090909) talked", "1 frame, stop packet")

	// A spurt open when the source disconnects is ended by that.
	send(t, a, frame)
	a.Close(websocket.StatusNormalClosure, "")
	logged(t, lines, "survival: Emptropy (05cd3a62) talked", "1 frame, cut off with the connection")
	t.Log("\n" + lines())
}

func TestJournalReconnect(t *testing.T) {
	url, lines := journal(t, time.Second)
	old := dial(t, url, tokA)
	status(t, old, "survival")
	send(t, old, rosterMsg(emptropy))
	logged(t, lines, "survival roster: +Emptropy")
	speaker := []byte{0x05, 0xcd, 0x3a, 0x62, 0xa9, 0xbc, 0x49, 0x09, 0xb9, 0x41, 0xcb, 0xc9, 0xba, 0x14, 0x30, 0xd7}
	send(t, old, append(append([]byte{msgAudio}, speaker...), 1))
	time.Sleep(50 * time.Millisecond)

	// The server connects again: its open spurt is ended, and its roster is kept, so the roster
	// the new connection sends is reported against it.
	nu := dial(t, url, tokA)
	logged(t, lines, "survival: Emptropy (05cd3a62) talked", "1 frame, cut off: the server connected again")
	before := storyLines(lines())
	send(t, nu, rosterMsg(emptropy))
	time.Sleep(200 * time.Millisecond)
	if got := storyLines(lines()); got != before {
		t.Fatalf("an unchanged roster logged after the reconnect:\n%s", strings.TrimPrefix(got, before))
	}
	send(t, nu, rosterMsg(""))
	logged(t, lines, "survival roster: -Emptropy (05cd3a62); now nobody")
	t.Log("\n" + lines())
}

// The relay closes a replaced connection, so through a socket the old one can't send anything
// more; the guard in read() covers the moment before its read loop notices. This tests the
// guard's mechanism directly.
func TestForwardFromReplacedConnection(t *testing.T) {
	r := newRelayLog(map[string]string{tokA: "survival"}, func(string, ...any) {})
	old := &conn{name: "survival", out: make(chan []byte, queueLen), done: make(chan struct{})}
	if r.join(old) {
		t.Fatal("the first connection replaced nothing")
	}
	nu := &conn{name: "survival", out: make(chan []byte, queueLen), done: make(chan struct{})}
	if !r.join(nu) {
		t.Fatal("the second connection did not report replacing the first")
	}
	if r.forward(old, msgRoster, []byte(`{"members":[]}`), true) {
		t.Fatal("a replaced connection's message was forwarded")
	}
	if !r.forward(nu, msgRoster, []byte(`{"members":[]}`), true) {
		t.Fatal("the current connection's message was not forwarded")
	}
	if r.leave(old) {
		t.Fatal("leaving a replaced connection counted as the server leaving")
	}
	if !r.leave(nu) {
		t.Fatal("leaving the current connection did not count")
	}
}
