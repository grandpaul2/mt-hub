package server

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
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

// Private chats and DMs leak nowhere: not in the list, messages, search, renames, the event
// stream, forwards or media. Admins see private chats but not DMs.
func TestPrivateChats(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	// Paul is an admin; Steve, Alex and Eve are members.
	for _, n := range []string{"Paul", "Steve", "Alex", "Eve"} {
		us.SetPassword(n, n+"-password")
	}
	us.Change("Paul", func(u *auth.User) { u.Admin = true })
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	cookie := map[string]string{}
	for _, n := range []string{"Paul", "Steve", "Alex", "Eve"} {
		cookie[n], _ = us.Login(n, n+"-password")
	}
	call := func(who, method, path, body string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie[who]})
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
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
	chats := func(who string) (out []string) {
		_, b := call(who, "GET", "/api/channels", "")
		var list []chat.ChannelInfo
		json.Unmarshal([]byte(b), &list)
		for _, c := range list {
			out = append(out, c.Name)
		}
		return
	}
	// Eve's event stream: everything she's sent, as text.
	r, _ := http.NewRequest("GET", srv.URL+"/api/events", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie["Eve"]})
	stream, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	var mu sync.Mutex
	var saw strings.Builder
	eveSaw := func() string {
		mu.Lock()
		defer mu.Unlock()
		return saw.String()
	}
	go func() {
		sc := bufio.NewScanner(stream.Body)
		for sc.Scan() {
			mu.Lock()
			saw.WriteString(sc.Text() + "\n")
			mu.Unlock()
		}
	}()

	// Only admins make private chats.
	code, _ := call("Steve", "POST", "/api/channels", `{"name":"staff","kind":"private","members":["Steve"]}`)
	want("member makes a private chat", code, 403)
	code, _ = call("Paul", "POST", "/api/channels", `{"name":"staff","kind":"private","members":["Steve"]}`)
	want("admin makes a private chat", code, 200)
	code, b := call("Steve", "POST", "/api/dms", `{"members":["Alex"]}`)
	want("open a DM", code, 200)
	var dm struct{ Name string }
	json.Unmarshal([]byte(b), &dm)
	code, b2 := call("Alex", "POST", "/api/dms", `{"members":["Steve"]}`)
	if code != 200 || !strings.Contains(b2, dm.Name) {
		t.Errorf("the same two get the same DM: %d %s vs %s", code, b2, dm.Name)
	}
	code, _ = call("Steve", "POST", "/api/dms", `{"members":["Nobody"]}`)
	want("DM with no such account", code, 400)

	call("Steve", "POST", "/api/channels/staff/messages", `{"text":"staff secret"}`)
	call("Alex", "POST", "/api/channels/"+dm.Name+"/messages", `{"text":"dm secret"}`)
	time.Sleep(200 * time.Millisecond)

	if got := chats("Eve"); !slices.Equal(got, []string{"general"}) {
		t.Errorf("Eve's chats: %v", got)
	}
	if got := chats("Paul"); !slices.Equal(got, []string{"general", "staff"}) {
		t.Errorf("an admin sees private chats, not others' DMs: %v", got)
	}
	if got := chats("Steve"); !slices.Equal(got, []string{"general", "staff", dm.Name}) {
		t.Errorf("Steve's chats: %v", got)
	}
	for _, path := range []string{"/api/channels/staff/messages", "/api/channels/" + dm.Name + "/messages", "/api/channels/staff/pins"} {
		code, _ = call("Eve", "GET", path, "")
		want("Eve reads "+path, code, 404)
	}
	code, _ = call("Eve", "POST", "/api/channels/staff/messages", `{"text":"let me in"}`)
	want("Eve posts in staff", code, 404)
	code, _ = call("Paul", "GET", "/api/channels/"+dm.Name+"/messages", "")
	want("an admin reads someone's DM", code, 404)
	code, _ = call("Paul", "GET", "/api/channels/staff/messages", "")
	want("an admin reads a private chat", code, 200)

	for _, who := range []string{"Eve", "Paul"} {
		_, b = call(who, "GET", "/api/search?q="+url.QueryEscape("secret"), "")
		if strings.Contains(b, "dm secret") || (who == "Eve" && strings.Contains(b, "staff secret")) {
			t.Errorf("%s's search finds what they can't see: %s", who, b)
		}
	}
	_, b = call("Steve", "GET", "/api/search?q=secret", "")
	if !strings.Contains(b, "dm secret") || !strings.Contains(b, "staff secret") {
		t.Errorf("Steve's search: %s", b)
	}

	// Forwarding: out of a chat you see, yes; out of one you don't, no.
	_, b = call("Steve", "GET", "/api/channels/staff/messages", "")
	var msgs []chat.Message
	json.Unmarshal([]byte(b), &msgs)
	code, _ = call("Eve", "POST", "/api/channels/general/messages", `{"forward":{"channel":"staff","id":"`+msgs[0].ID+`"}}`)
	want("Eve forwards from staff", code, 404)

	// Media in a private chat stays with it.
	code, b = call("Steve", "POST", "/api/channels/staff/media?name=plan.png", "png bytes")
	if code != 200 || !strings.Contains(b, `"media/staff/plan.png"`) {
		t.Errorf("post media: %d %s", code, b)
	}
	code, b = call("Steve", "POST", "/api/channels/staff/media?name=plan.png", "png 2")
	if !strings.Contains(b, `plan (2).png`) {
		t.Errorf("same name: %d %s", code, b)
	}
	code, b = call("Steve", "GET", "/api/channels/staff/media/plan.png", "")
	if code != 200 || b != "png bytes" {
		t.Errorf("member gets media: %d %q", code, b)
	}
	code, _ = call("Eve", "GET", "/api/channels/staff/media/plan.png", "")
	want("Eve gets staff media", code, 404)
	// Nor can Eve learn of, or delete, a staff file by naming it in a message of her own:
	// "delete with its files" reaches only the files of the chat the message is in.
	var naming struct{ ID string }
	_, b = call("Eve", "POST", "/api/channels/general/messages", `{"text":"#media/staff/plan.png"}`)
	json.Unmarshal([]byte(b), &naming)
	if _, b = call("Eve", "GET", "/api/channels/general/messages/"+naming.ID+"/orphans", ""); !strings.Contains(b, `"paths":[]`) {
		t.Errorf("Eve's message naming a staff file offers it: %s", b)
	}
	code, _ = call("Eve", "DELETE", "/api/channels/general/messages/"+naming.ID+"?files=1", "")
	want("Eve deletes her message with files", code, 200)
	if code, b = call("Steve", "GET", "/api/channels/staff/media/plan.png", ""); code != 200 || b != "png bytes" {
		t.Errorf("staff file after Eve's delete: %d %q", code, b)
	}
	code, _ = call("Steve", "GET", "/api/file/media/staff/plan.png", "")
	want("not in Files", code, 404)

	// Renames of a private chat aren't told to outsiders.
	call("Paul", "PATCH", "/api/channels/staff", `{"name":"staff-room"}`)
	_, b = call("Eve", "GET", "/api/channel-renames", "")
	if strings.Contains(b, "staff") {
		t.Errorf("Eve sees a private rename: %s", b)
	}

	// Admins can't pin or delete in DMs they're not in (404), and in their own a member's
	// powers apply: either person may pin.
	code, _ = call("Steve", "PUT", "/api/channels/"+dm.Name+"/messages/x/pin", "")
	want("pin in a DM: not found message, not forbidden", code, 404)

	// Hiding: out of Steve's list until the next message.
	code, _ = call("Steve", "POST", "/api/channels/"+dm.Name+"/hide", "")
	want("hide", code, 200)
	if slices.Contains(chats("Steve"), dm.Name) || !slices.Contains(chats("Alex"), dm.Name) {
		t.Error("hide is only for Steve")
	}
	call("Alex", "POST", "/api/channels/"+dm.Name+"/messages", `{"text":"back?"}`)
	if !slices.Contains(chats("Steve"), dm.Name) {
		t.Error("a new message brings the DM back")
	}
	code, _ = call("Paul", "DELETE", "/api/channels/"+dm.Name, "")
	want("an admin deletes a DM they can't see", code, 404)
	code, _ = call("Steve", "PUT", "/api/channels/"+dm.Name+"/kind", `{"kind":""}`)
	want("a member makes a DM public", code, 403)

	// Making staff-room public: Eve sees it and its messages now.
	code, _ = call("Paul", "PUT", "/api/channels/staff-room/kind", `{"kind":""}`)
	want("make public", code, 200)
	if !slices.Contains(chats("Eve"), "staff-room") {
		t.Error("public again: Eve should see it")
	}

	// The chat order: admins only, and a private chat's name in it reaches nobody else.
	code, _ = call("Steve", "PUT", "/api/channel-order", `{"names":["general"]}`)
	want("a member reorders", code, 403)
	call("Paul", "POST", "/api/channels", `{"name":"secret-room","kind":"private"}`)
	code, _ = call("Paul", "PUT", "/api/channel-order", `{"names":["secret-room","staff-room","general"]}`)
	want("an admin reorders", code, 200)
	if got := chats("Eve"); !slices.Equal(got, []string{"staff-room", "general"}) {
		t.Errorf("Eve's list in the set order, without the private chat: %v", got)
	}

	time.Sleep(200 * time.Millisecond)
	if s := eveSaw(); strings.Contains(s, "secret-room") || strings.Contains(s, "secret") || strings.Contains(s, dm.Name) || strings.Contains(s, "back?") {
		t.Errorf("Eve's event stream carried private things:\n%s", s)
	}
	if !strings.Contains(eveSaw(), "staff-room") {
		t.Errorf("Eve should hear that staff-room became visible:\n%s", eveSaw())
	}
}
