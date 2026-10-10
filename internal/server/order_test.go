package server

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// Messages sent at the same moment go out to everyone in the order they're stored (the bug
// sweep saw a third of them arrive out of order, and pages showed them so until a reload).
func TestMessagesGoOutInOrder(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Paul", "Paul-password")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	cookie, _ := us.Login("Paul", "Paul-password")
	do := func(method, path, body string) *http.Response {
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	stream := do("GET", "/api/events", "")
	defer stream.Body.Close()
	const n = 200
	ids := make(chan string, n)
	go func() {
		sc := bufio.NewScanner(stream.Body)
		msg := false
		for sc.Scan() {
			line := sc.Text()
			if line == "event: message" {
				msg = true
			} else if data, ok := strings.CutPrefix(line, "data: "); ok && msg {
				var m struct{ ID string }
				json.Unmarshal([]byte(data), &m)
				ids <- m.ID
				msg = false
			}
		}
	}()
	time.Sleep(100 * time.Millisecond) // the stream is subscribed
	var wg sync.WaitGroup
	for range n {
		wg.Add(1)
		go func() { defer wg.Done(); do("POST", "/api/channels/general/messages", `{"text":"hi"}`).Body.Close() }()
	}
	wg.Wait()
	prev, back := "", 0
	for range n {
		select {
		case id := <-ids:
			if id < prev {
				back++
			}
			prev = id
		case <-time.After(5 * time.Second):
			t.Fatal("not all messages arrived")
		}
	}
	if back > 0 {
		t.Errorf("%d of %d messages arrived out of order", back, n)
	}
}
