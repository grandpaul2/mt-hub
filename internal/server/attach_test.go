package server

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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

// Files posted in chat: any kind, kept with the chat whatever its kind, served (and
// thumbnailed) only to its people, listed per chat, saved to Files on request, copied along
// with a forward, following renames, and trashed with the last message that links them.
func TestAttachments(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	for _, n := range []string{"Pat", "Steve", "Eve"} {
		us.SetPassword(n, n+"-password")
	}
	us.Change("Pat", func(u *auth.User) { u.Admin = true })
	hub := New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil)
	srv := httptest.NewServer(hub)
	defer srv.Close()
	cookie := map[string]string{}
	for _, n := range []string{"Pat", "Steve", "Eve"} {
		cookie[n], _ = us.Login(n, n+"-password")
	}
	do := func(who, method, path, body string) *http.Response {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie[who]})
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	call := func(who, method, path, body string) (int, string) {
		t.Helper()
		res := do(who, method, path, body)
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	want := func(label string, got, code int) {
		t.Helper()
		if got != code {
			t.Errorf("%s: %d, want %d", label, got, code)
		}
	}
	post := func(who, c, text string) chat.Message {
		t.Helper()
		_, b := call(who, "POST", "/api/channels/"+c+"/messages", `{"text":`+jsonString(text)+`}`)
		var m chat.Message
		json.Unmarshal([]byte(b), &m)
		return m
	}

	call("Pat", "POST", "/api/channels", `{"name":"builds"}`)
	call("Pat", "POST", "/api/channels", `{"name":"staff","kind":"private","members":["Steve"]}`)

	// Any kind of file, in a public chat too; kept with the chat, not in Files.
	code, b := call("Steve", "POST", "/api/channels/builds/media?name=farm.litematic", "schem bytes")
	if code != 200 || !strings.Contains(b, `"media/builds/farm.litematic"`) {
		t.Fatalf("post a schematic: %d %s", code, b)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "chat", "builds", "media", "farm.litematic")); string(data) != "schem bytes" {
		t.Errorf("kept with the chat: %q", data)
	}
	code, _ = call("Steve", "GET", "/api/file/media/builds/farm.litematic", "")
	want("not in Files", code, 404)
	code, _ = call("Steve", "PUT", "/api/file/media/builds/x.txt?base=", "x")
	want("Files can't use media/", code, 400)
	code, _ = call("Steve", "POST", "/api/channels/builds/media?name=big.zip", strings.Repeat("x", maxVersioned+1))
	want("over 50 MB", code, 413)

	res := do("Eve", "GET", "/api/channels/builds/media/farm.litematic?download=1", "")
	res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment") {
		t.Errorf("download: %d %q", res.StatusCode, res.Header.Get("Content-Disposition"))
	}

	// Pictures get thumbnails, for the chat's people only.
	var pic bytes.Buffer
	png.Encode(&pic, image.NewGray(image.Rect(0, 0, 400, 300)))
	call("Steve", "POST", "/api/channels/staff/media?name=plan.png", pic.String())
	res = do("Steve", "GET", "/api/channels/staff/thumb/plan.png", "")
	res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "image/") {
		t.Errorf("thumbnail: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	code, _ = call("Eve", "GET", "/api/channels/staff/thumb/plan.png", "")
	want("Eve's thumbnail of staff's picture", code, 404)

	// The chat's file list: what its messages link, newest first.
	first := post("Steve", "builds", "here #media/builds/farm.litematic")
	call("Steve", "POST", "/api/channels/builds/media?name=notes.txt", "notes")
	post("Steve", "builds", "and #media/builds/notes.txt")
	_, b = call("Eve", "GET", "/api/channels/builds/files", "")
	var files []chatFile
	json.Unmarshal([]byte(b), &files)
	if len(files) != 2 || files[0].Path != "media/builds/notes.txt" || files[1].ID != first.ID || files[1].Size != 11 {
		t.Errorf("files: %s", b)
	}

	// Save to Files: a copy, never replacing anything.
	for _, wantPath := range []string{"inbox/farm.litematic", "inbox/farm (2).litematic"} {
		code, b = call("Eve", "POST", "/api/channels/builds/media/farm.litematic/save", `{"dir":"inbox"}`)
		if code != 200 || !strings.Contains(b, `"`+wantPath+`"`) {
			t.Errorf("save to Files: %d %s, want %s", code, b, wantPath)
		}
	}
	if code, b = call("Eve", "GET", "/api/file/inbox/farm.litematic", ""); !strings.Contains(b, "schem bytes") {
		t.Errorf("saved file: %d %s", code, b)
	}

	// Forwarding into another chat copies the files there, so its people can see them.
	code, b = call("Steve", "POST", "/api/channels/staff/messages", `{"forward":{"channel":"builds","id":"`+first.ID+`"}}`)
	var fwd chat.Message
	json.Unmarshal([]byte(b), &fwd)
	if code != 200 || fwd.Forward == nil || !strings.Contains(fwd.Forward.Text, "#media/staff/farm.litematic") {
		t.Fatalf("forward: %d %s", code, b)
	}
	if code, b = call("Steve", "GET", "/api/channels/staff/media/farm.litematic", ""); b != "schem bytes" {
		t.Errorf("the copy: %d %q", code, b)
	}
	if orig, _ := cs.Get("builds", first.ID); !strings.Contains(orig.Text, "#media/builds/") {
		t.Errorf("the original changed: %q", orig.Text)
	}

	// A pasted link to another chat's file gets a copy too (posting and editing): from a chat
	// the poster can see. Eve can't pull staff's file out by pasting its link.
	pasted := post("Steve", "general", "from staff: #media/staff/plan.png")
	if !strings.Contains(pasted.Text, "#media/general/plan.png") {
		t.Errorf("pasted link: %q", pasted.Text)
	}
	if code, _ = call("Eve", "GET", "/api/channels/general/thumb/plan.png", ""); code != 200 {
		t.Errorf("Eve sees the copy: %d", code)
	}
	sneaky := post("Eve", "general", "#media/staff/plan.png")
	if sneaky.Text != "#media/staff/plan.png" {
		t.Errorf("Eve copied staff's file: %q", sneaky.Text)
	}
	code, b = call("Steve", "PATCH", "/api/channels/general/messages/"+pasted.ID, `{"text":"also #media/builds/notes.txt"}`)
	if code != 200 || !strings.Contains(b, "#media/general/notes.txt") {
		t.Errorf("edited link: %d %s", code, b)
	}
	code, b = call("Pat", "PATCH", "/api/channels/general/messages/"+pasted.ID, `{"text":"#media/builds/farm.litematic"}`)
	if _, err := os.Stat(filepath.Join(dir, "chat", "general", "media", "farm.litematic")); code != 403 || err == nil {
		t.Errorf("someone else's edit: %d, copied anyway: %v", code, err == nil)
	}
	call("Pat", "POST", "/api/channels", `{"name":"gone"}`)
	call("Steve", "POST", "/api/channels/gone/media?name=old.zip", "old")
	keep := post("Steve", "general", "#media/gone/old.zip")
	call("Pat", "DELETE", "/api/channels/gone", "")
	if code, b = call("Eve", "GET", "/api/channels/general/media/old.zip", ""); b != "old" || !strings.Contains(keep.Text, "media/general/old.zip") {
		t.Errorf("outlives its chat: %d %q (%q)", code, b, keep.Text)
	}

	// A rename takes the files along, and old links still count.
	call("Pat", "PATCH", "/api/channels/builds", `{"name":"farms"}`)
	if code, b = call("Eve", "GET", "/api/channels/farms/media/farm.litematic", ""); b != "schem bytes" {
		t.Errorf("after the rename: %d %q", code, b)
	}
	_, b = call("Eve", "GET", "/api/channels/farms/files", "")
	if !strings.Contains(b, `"media/farms/farm.litematic"`) {
		t.Errorf("files after the rename: %s", b)
	}

	// Deleting the last message that links a file offers it; deleting with it trashes it.
	post("Eve", "farms", "same file #media/builds/farm.litematic")
	_, b = call("Steve", "GET", "/api/channels/farms/messages/"+first.ID+"/orphans", "")
	if !strings.Contains(b, `"paths":[]`) {
		t.Errorf("still linked by Eve's message, yet offered: %s", b)
	}
	solo := post("Steve", "farms", "solo #media/farms/notes.txt")
	_, b = call("Steve", "GET", "/api/channels/farms/messages/"+solo.ID+"/orphans", "")
	if strings.Contains(b, "notes.txt") {
		t.Errorf("notes.txt is linked by an earlier message too: %s", b)
	}
	call("Steve", "POST", "/api/channels/farms/media?name=once.txt", "once")
	once := post("Steve", "farms", "#media/farms/once.txt")
	_, b = call("Steve", "GET", "/api/channels/farms/messages/"+once.ID+"/orphans", "")
	if !strings.Contains(b, `"media/farms/once.txt"`) {
		t.Errorf("orphans: %s", b)
	}
	code, _ = call("Steve", "DELETE", "/api/channels/farms/messages/"+once.ID+"?files=1", "")
	want("delete with its file", code, 200)
	code, _ = call("Steve", "GET", "/api/channels/farms/media/once.txt", "")
	want("deleted file", code, 404)
	if log, _ := os.ReadFile(filepath.Join(dir, "trash", "log.jsonl")); !strings.Contains(string(log), "chat/farms/media/once.txt") {
		t.Errorf("trash log: %s", log)
	}
	// farms is a chat everyone can read, so the Trash lists its file.
	if _, b = call("Steve", "GET", "/api/trash", ""); !strings.Contains(b, `"path":"once.txt","chat":"farms"`) {
		t.Errorf("the Trash doesn't list a public chat's file: %s", b)
	}

	// An edit that takes a file out of the message trashes it, unless something else links it.
	for _, n := range []string{"a.txt", "b.txt", "c.txt"} {
		call("Steve", "POST", "/api/channels/farms/media?name="+n, n)
	}
	both := post("Steve", "farms", "words #media/farms/a.txt #media/farms/b.txt #media/farms/c.txt")
	post("Eve", "farms", "again #media/farms/c.txt")
	code, _ = call("Steve", "PATCH", "/api/channels/farms/messages/"+both.ID, `{"text":"words #media/farms/a.txt"}`)
	want("edit a file out", code, 200)
	code, _ = call("Steve", "GET", "/api/channels/farms/media/a.txt", "")
	want("the file the edit kept", code, 200)
	code, _ = call("Steve", "GET", "/api/channels/farms/media/b.txt", "")
	want("the file the edit took out", code, 404)
	code, _ = call("Steve", "GET", "/api/channels/farms/media/c.txt", "")
	want("taken out, but Eve's message links it", code, 200)
	if log, _ := os.ReadFile(filepath.Join(dir, "trash", "log.jsonl")); !strings.Contains(string(log), "chat/farms/media/b.txt") {
		t.Errorf("trash log after the edit: %s", log)
	}

	// The sweep: a file no message links goes to the trash once it's a day old.
	old := time.Now().Add(-2 * sweepAge)
	for _, n := range []string{"left.txt", "fresh.txt"} {
		call("Steve", "POST", "/api/channels/farms/media?name="+n, n)
	}
	for _, n := range []string{"left.txt", "a.txt", "c.txt"} {
		os.Chtimes(filepath.Join(dir, "chat", "farms", "media", n), old, old)
	}
	if got := hub.sweepMedia(time.Now().Add(-sweepAge)); len(got) != 1 || got[0] != "media/farms/left.txt" {
		t.Errorf("swept: %v, want only media/farms/left.txt", got)
	}
	code, _ = call("Steve", "GET", "/api/channels/farms/media/left.txt", "")
	want("old and linked by nothing", code, 404)
	code, _ = call("Steve", "GET", "/api/channels/farms/media/fresh.txt", "")
	want("linked by nothing, but new", code, 200)
	code, _ = call("Steve", "GET", "/api/channels/farms/media/a.txt", "")
	want("old, but linked", code, 200)
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
