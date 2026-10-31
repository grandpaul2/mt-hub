package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// A change must come from the page's script. A form (planted in a member's Markdown file, or
// on another site) submits by navigating, with a body shaped to parse as JSON; the hub
// refuses it, and the page's policy forbids submitting forms at all.
func TestFormPostsRefused(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Pat", "Pat-password")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	cookie, _ := us.Login("Pat", "Pat-password")
	// What <form method=post enctype=text/plain><input name='{"text":"hi","x":"' value='"}'> sends.
	const formBody = `{"text":"hi","x":"="}`
	post := func(headers map[string]string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest("POST", srv.URL+"/api/channels/general/messages", strings.NewReader(formBody))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		return res.StatusCode, res.Header.Get("Content-Security-Policy")
	}
	for label, h := range map[string]map[string]string{
		"a form in the page":      {"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Content-Type": "text/plain"},
		"a form on another site":  {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},
		"a fetch from elsewhere":  {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "empty"},
		"a fetch from a sibling":  {"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"},
		"a navigation, unlabeled": {"Sec-Fetch-Dest": "document"},
	} {
		if code, _ := post(h); code != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", label, code)
		}
	}
	if ms, _ := cs.Messages("general", "", 10); len(ms) != 0 {
		t.Errorf("%d messages got posted by refused requests", len(ms))
	}
	for label, h := range map[string]map[string]string{
		"the page's fetch":         {"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"},
		"a client with no headers": {},
	} {
		if code, _ := post(h); code != http.StatusOK {
			t.Errorf("%s: %d, want 200", label, code)
		}
	}
	// Reading by navigating (opening a file in a tab) still works.
	r, _ := http.NewRequest("GET", srv.URL+"/api/me", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
	r.Header.Set("Sec-Fetch-Mode", "navigate")
	r.Header.Set("Sec-Fetch-Dest", "document")
	if res, _ := http.DefaultClient.Do(r); res.StatusCode != http.StatusOK {
		t.Errorf("GET by navigation: %d, want 200", res.StatusCode)
	}
	// The page's policy: no form may submit anywhere.
	res, _ := http.Get(srv.URL + "/")
	if csp := res.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "form-action 'none'") {
		t.Errorf("page CSP = %q, want form-action 'none'", csp)
	}
}
