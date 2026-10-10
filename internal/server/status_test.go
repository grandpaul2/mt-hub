package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// Server status: game servers report with their token, people read it, and a server that
// stops reporting goes offline.
func TestServerStatus(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Steve", "Steve-password")
	s := New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil)
	now := time.Date(2026, 10, 9, 20, 0, 0, 0, time.UTC)
	s.status.now = func() time.Time { return now }
	srv := httptest.NewServer(s)
	defer srv.Close()

	cookie, _ := us.Login("Steve", "Steve-password")
	survival, _, _ := us.NewToken("survival", "")
	creative, _, _ := us.NewToken("creative", "")
	release, _, _ := us.NewReleaseToken("")
	call := func(token, method, body string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+"/api/server-status", strings.NewReader(body))
		if token == "" {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		} else {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	read := func() []statusView {
		t.Helper()
		code, body := call("", "GET", "")
		if code != 200 {
			t.Fatalf("reading: %d %s", code, body)
		}
		var v []statusView
		if err := json.Unmarshal([]byte(body), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}

	// Before any report: both servers are listed, offline, never seen.
	v := read()
	if len(v) != 2 || v[0].Name != "survival" || v[1].Name != "creative" || v[0].Up || v[0].Seen != nil {
		t.Fatalf("before reports: %+v", v)
	}

	// Who may do what.
	for _, c := range []struct {
		label, token, method, body string
		want                       int
	}{
		{"a person reporting", "", "POST", `{"mspt":1}`, 403},
		{"the release token reporting", release, "POST", `{"mspt":1}`, 403},
		{"a server reading", survival, "GET", "", 403},
		{"not JSON", survival, "POST", "hello", 400},
		{"a negative mspt", survival, "POST", `{"mspt":-1}`, 400},
		{"a report", survival, "POST", `{"players":["Steve","alex","not a name"],"bots":2,"mspt":10,"mem_used":4000,"mem_max":16000}`, 204},
	} {
		if code, body := call(c.token, c.method, c.body); code != c.want {
			t.Errorf("%s: %d %s, want %d", c.label, code, body, c.want)
		}
	}
	now = now.Add(10 * time.Second)
	call(survival, "POST", `{"players":["Steve"],"mspt":30,"mspt_max":412.34,"mem_used":6000,"mem_max":16000}`)
	call(creative, "POST", `{"players":[],"mspt":2.04,"mem_used":1000,"mem_max":16000}`)

	v = read()
	sv := v[0]
	if !sv.Up || sv.MSPT != 20 || sv.Peak != 412.3 || sv.MemUsed != 5000 || sv.MemMax != 16000 || len(sv.Players) != 1 || sv.Bots != 0 {
		t.Errorf("survival: %+v", sv)
	}
	if len(sv.Hist) != 2 || sv.Hist[0] != [2]float64{10, 10} || sv.Hist[1] != [2]float64{0, 30} {
		t.Errorf("survival's graph: %v", sv.Hist)
	}
	if !v[1].Up || v[1].MSPT != 2 || len(v[1].Players) != 0 {
		t.Errorf("creative: %+v", v[1])
	}

	// Invalid names are dropped, the rest sorted.
	now = now.Add(10 * time.Second)
	call(survival, "POST", `{"players":["Steve","alex","not a name"],"bots":2,"mspt":10,"mem_used":4000,"mem_max":16000}`)
	if sv = read()[0]; strings.Join(sv.Players, ",") != "alex,Steve" || sv.Bots != 2 {
		t.Errorf("players: %+v", sv)
	}

	// Creative stops reporting: offline after 30 s, its numbers gone, last seen kept.
	now = now.Add(25 * time.Second)
	call(survival, "POST", `{"mspt":10,"mem_used":4000,"mem_max":16000}`)
	v = read()
	if !v[0].Up || v[1].Up || v[1].Seen == nil || v[1].MSPT != 0 || v[1].MemMax != 0 {
		t.Errorf("creative should be offline: %+v", v)
	}

	// The graph forgets what's over ten minutes old.
	now = now.Add(11 * time.Minute)
	call(survival, "POST", `{"mspt":5,"mem_used":4000,"mem_max":16000}`)
	if sv = read()[0]; len(sv.Hist) != 1 || sv.Peak != 5 {
		t.Errorf("after ten minutes: %+v", sv)
	}
}
