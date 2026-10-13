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

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// The Trash over HTTP: a delete answers with the entry it made; anyone lists and restores;
// only an admin erases; tokens reach none of it.
func TestTrashRoutes(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	cookies := map[string]string{}
	for name, admin := range map[string]bool{"Paul": true, "Steve": false} {
		us.SetPassword(name, name+"-password")
		us.Change(name, func(u *auth.User) { u.Admin = admin })
		cookies[name], _ = us.Login(name, name+"-password")
	}
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	survival, _, _ := us.NewToken("survival", "")
	release, _, _ := us.NewReleaseToken("")
	call := func(who, method, path, body string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if c, ok := cookies[who]; ok {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: c})
		} else {
			r.Header.Set("Authorization", "Bearer "+who)
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	type item struct {
		ID, Path, Who string
		Dir           bool
	}
	list := func(who string) (string, map[string]string) {
		t.Helper()
		code, body := call(who, "GET", "/api/trash", "")
		var got struct {
			Items []item
			Days  int
		}
		if code != 200 || json.Unmarshal([]byte(body), &got) != nil || got.Days != 30 {
			t.Fatalf("list: %d %s", code, body)
		}
		var names []string
		ids := map[string]string{}
		for _, it := range got.Items {
			names = append(names, it.Path+" by "+it.Who)
			ids[it.Path] = it.ID
		}
		return strings.Join(names, ", "), ids
	}
	trashed := func(body string) []string {
		t.Helper()
		var got struct{ Trash []string }
		if json.Unmarshal([]byte(body), &got) != nil || len(got.Trash) == 0 {
			t.Fatalf("no trash ids in %s", body)
		}
		return got.Trash
	}

	for _, p := range []string{"a.md", "b.md", "docs/c.md", "docs/d.md"} {
		if code, body := call("Steve", "PUT", "/api/file/"+p+"?base=", p); code != 200 {
			t.Fatalf("seeding %s: %d %s", p, code, body)
		}
	}
	_, body := call("Steve", "GET", "/api/stat/a.md", "")
	rev := body[strings.Index(body, `"rev":"`)+7:]
	rev = rev[:strings.Index(rev, `"`)]
	code, body := call("Steve", "DELETE", "/api/file/a.md?base="+rev, "")
	if code != 200 {
		t.Fatalf("delete: %d %s", code, body)
	}
	idA := trashed(body)[0]
	_, body = call("Paul", "DELETE", "/api/file/docs?dir=1", "")
	idDocs := trashed(body)[0]
	_, body = call("Steve", "POST", "/api/batch/delete", `{"paths":["b.md"]}`)
	idB := trashed(body)[0]

	names, ids := list("Steve")
	if names != "b.md by Steve, docs by Paul, a.md by Steve" || ids["a.md"] != idA || ids["docs"] != idDocs || ids["b.md"] != idB {
		t.Fatalf("listed: %s %v", names, ids)
	}

	for _, token := range []string{survival, release} {
		for _, c := range [][2]string{{"GET", "/api/trash"}, {"POST", "/api/trash/restore"}, {"POST", "/api/trash/delete"}, {"POST", "/api/trash/empty"}} {
			if code, _ := call(token, c[0], c[1], `{"ids":["`+idA+`"]}`); code != http.StatusForbidden {
				t.Errorf("a token on %s %s: %d, want 403", c[0], c[1], code)
			}
		}
	}
	for _, path := range []string{"/api/trash/delete", "/api/trash/empty"} {
		if code, _ := call("Steve", "POST", path, `{"ids":["`+idA+`"]}`); code != http.StatusForbidden {
			t.Errorf("a member on %s: %d, want 403", path, code)
		}
	}
	if names, _ := list("Steve"); !strings.Contains(names, "a.md") {
		t.Fatalf("a refused call erased something: %s", names)
	}

	// Anyone restores: where it was, or into a folder that is named.
	if code, body := call("Steve", "POST", "/api/trash/restore", `{"ids":["`+idA+`"]}`); code != 200 || strings.TrimSpace(body) != `{"paths":["a.md"]}` {
		t.Fatalf("restore: %d %s", code, body)
	}
	if code, body := call("Steve", "POST", "/api/trash/restore", `{"ids":["`+idB+`"],"to":"kept"}`); code != 200 || strings.TrimSpace(body) != `{"paths":["kept/b.md"]}` {
		t.Fatalf("restore into a folder: %d %s", code, body)
	}
	if code, _ := call("Steve", "POST", "/api/trash/restore", `{"ids":["`+idA+`"]}`); code != 404 {
		t.Errorf("restore of what isn't there: %d", code)
	}
	if code, got := call("Steve", "GET", "/api/file/kept/b.md", ""); code != 200 || got != "b.md" {
		t.Errorf("the restored file: %d %q", code, got)
	}

	// An admin erases.
	if code, body := call("Paul", "POST", "/api/trash/delete", `{"ids":["`+idDocs+`"]}`); code != 200 || strings.TrimSpace(body) != `{"deleted":1}` {
		t.Fatalf("delete forever: %d %s", code, body)
	}
	call("Steve", "POST", "/api/batch/delete", `{"paths":["a.md","kept"]}`)
	if code, body := call("Paul", "POST", "/api/trash/empty", ""); code != 200 || strings.TrimSpace(body) != `{"deleted":2}` {
		t.Fatalf("empty: %d %s", code, body)
	}
	if names, _ := list("Paul"); names != "" {
		t.Fatalf("listed after Empty Trash: %s", names)
	}
}
