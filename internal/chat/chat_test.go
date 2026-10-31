package chat

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestChatSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Channels(); len(got) != 1 || got[0].Name != "general" {
		t.Fatalf("default channels: %+v", got)
	}
	a, _ := s.Post("general", "pat", "  hello  ")
	b, _ := s.Post("general", "eldridge", "hi #schematics/farm.litematic")
	c, _ := s.Post("general", "pat", "typo")
	if !(a.ID < b.ID && b.ID < c.ID) || a.Text != "hello" {
		t.Fatalf("ids/text: %+v %+v %+v", a, b, c)
	}
	if _, err := s.Edit("general", c.ID, "eldridge", "not mine"); !errors.Is(err, ErrNotYours) {
		t.Fatalf("edit someone else's: %v", err)
	}
	s.Edit("general", c.ID, "pat", "fixed")
	s.Delete("general", a.ID, "pat", false)
	spam, _ := s.Post("general", "eldridge", "spam")
	if _, err := s.Delete("general", spam.ID, "pat", false); !errors.Is(err, ErrNotYours) {
		t.Fatalf("delete someone else's: %v", err)
	}
	if _, err := s.Delete("general", spam.ID, "pat", true); err != nil {
		t.Fatalf("admin delete: %v", err)
	}
	if _, err := s.Post("general", "pat", "   "); !errors.Is(err, ErrEmpty) {
		t.Fatalf("empty: %v", err)
	}
	if err := s.CreateChannel("Bad Name"); !errors.Is(err, ErrBadChannel) {
		t.Fatalf("bad name: %v", err)
	}
	s.CreateChannel("builds")

	// A torn final line (crash mid-write) must not break loading.
	files, _ := filepath.Glob(filepath.Join(dir, "general", "*.jsonl"))
	f, _ := os.OpenFile(files[0], os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"msg","id":"ff`)
	f.Close()

	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	msgs, _ := s2.Messages("general", "", 50)
	if len(msgs) != 2 || msgs[0].ID != b.ID || msgs[1].Text != "fixed" || msgs[1].Edited == nil {
		t.Fatalf("after restart: %+v", msgs)
	}
	if got := s2.Channels(); len(got) != 2 || got[0].Name != "builds" || got[1].LastID != c.ID {
		t.Fatalf("channels after restart: %+v", got)
	}
	// New IDs keep increasing after a restart.
	d, _ := s2.Post("general", "pat", "later")
	if d.ID <= c.ID {
		t.Fatalf("id went backwards: %s <= %s", d.ID, c.ID)
	}
	// Paging: one message before d.
	page, _ := s2.Messages("general", d.ID, 1)
	if len(page) != 1 || page[0].ID != c.ID {
		t.Fatalf("page: %+v", page)
	}
	// The message posted after the crash survives another restart.
	s3, _ := Open(dir)
	if msgs, _ := s3.Messages("general", "", 50); len(msgs) != 3 || msgs[2].Text != "later" {
		t.Fatalf("after second restart: %+v", msgs)
	}
	// The file is readable as plain lines.
	raw, _ := os.ReadFile(files[0])
	if !strings.Contains(string(raw), `"text":"hi #schematics/farm.litematic"`) {
		t.Fatalf("file:\n%s", raw)
	}
}

func TestRenameAndDeleteChannel(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir) // creates #general
	s.CreateChannel("builds")
	m, _ := s.Post("builds", "pat", "hi")

	if err := s.RenameChannel("builds", "general", "pat"); !errors.Is(err, ErrExists) {
		t.Fatalf("rename onto existing: %v", err)
	}
	if err := s.RenameChannel("builds", "Bad Name", "pat"); !errors.Is(err, ErrBadChannel) {
		t.Fatalf("bad name: %v", err)
	}
	if err := s.RenameChannel("builds", "projects", "pat"); err != nil {
		t.Fatal(err)
	}
	// The rename survives a restart, messages and all, and is on record for old links.
	s, _ = Open(dir)
	if rn := s.Renames(); len(rn) != 1 || rn[0].From != "builds" || rn[0].To != "projects" || rn[0].User != "pat" {
		t.Fatalf("renames: %+v", rn)
	}
	msgs, err := s.Messages("projects", "", 10)
	if err != nil || len(msgs) != 1 || msgs[0].ID != m.ID || msgs[0].Channel != "projects" {
		t.Fatalf("after rename: %+v %v", msgs, err)
	}
	if _, err := s.Messages("builds", "", 10); !errors.Is(err, ErrNoChannel) {
		t.Fatalf("old name still there: %v", err)
	}

	if err := s.DeleteChannel("projects"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteChannel("general"); !errors.Is(err, ErrLastChannel) {
		t.Fatalf("delete last: %v", err)
	}
	// Gone after a restart too, but its files are kept in .deleted.
	s, _ = Open(dir)
	if len(s.Channels()) != 1 {
		t.Fatalf("channels: %+v", s.Channels())
	}
	kept, _ := filepath.Glob(filepath.Join(dir, ".deleted", "projects-*", "*.jsonl"))
	if len(kept) != 1 {
		t.Fatalf("deleted channel's files: %v", kept)
	}
}

func TestReactionsPinsRepliesForwards(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	s.CreateChannel("builds")
	a, _ := s.Post("general", "pat", "farm is up")
	b, err := s.Send("general", "alex", Draft{Text: "nice", ReplyTo: a.ID})
	if err != nil || b.Reply == nil || b.Reply.User != "pat" || b.Reply.Text != "farm is up" {
		t.Fatalf("reply: %+v %v", b, err)
	}
	if _, err := s.Send("builds", "alex", Draft{Text: "x", ReplyTo: a.ID}); !errors.Is(err, ErrBadReply) {
		t.Fatalf("reply across chats: %v", err)
	}

	s.React("general", a.ID, "alex", "👍", true)
	s.React("general", a.ID, "alex", "👍", true) // again: no change
	s.React("general", a.ID, "pat", "👍", true)
	s.React("general", a.ID, "pat", "🔥", true)
	m, _ := s.React("general", a.ID, "pat", "🔥", false)
	if len(m.Reactions) != 1 || m.Reactions[0].Emoji != "👍" || strings.Join(m.Reactions[0].Users, ",") != "alex,pat" {
		t.Fatalf("reactions: %+v", m.Reactions)
	}
	for _, bad := range []string{"", "a", "👍 ", ":+1:", strings.Repeat("👍", 9)} {
		if _, err := s.React("general", a.ID, "pat", bad, true); !errors.Is(err, ErrBadEmoji) {
			t.Fatalf("emoji %q: %v", bad, err)
		}
	}
	if _, err := s.React("general", a.ID, "pat", "👍🏽", true); err != nil {
		t.Fatalf("skin tone: %v", err)
	}

	s.SetPinned("general", a.ID, "pat", true)
	s.SetPinned("general", b.ID, "pat", true)
	if pins, _ := s.Pins("general"); len(pins) != 2 || pins[0].ID != b.ID {
		t.Fatalf("pins, newest first: %+v", pins)
	}
	s.SetPinned("general", b.ID, "pat", false)

	f, _ := s.Forwarded("general", a.ID)
	fw, err := s.Send("builds", "alex", Draft{Forward: f})
	if err != nil || fw.Forward == nil || fw.Forward.Text != "farm is up" || fw.Text != "" {
		t.Fatalf("forward: %+v %v", fw, err)
	}
	f2, _ := s.Forwarded("builds", fw.ID)
	if f2.ID != a.ID {
		t.Fatalf("forwarding a forward passes on the original: %+v", f2)
	}
	s.Edit("general", a.ID, "pat", "farm is down")
	s.Delete("general", a.ID, "pat", false)

	// All of it survives a restart: the forward keeps its copy, the reply sees the delete.
	s2, _ := Open(dir)
	got, _ := s2.Messages("general", "", 10)
	if len(got) != 1 || got[0].Reply == nil || !got[0].Reply.Deleted || got[0].Pinned != nil {
		t.Fatalf("after restart, general: %+v", got)
	}
	bs, _ := s2.Messages("builds", "", 10)
	if len(bs) != 1 || bs[0].Forward.Text != "farm is up" {
		t.Fatalf("after restart, builds: %+v", bs)
	}
	if pins, _ := s2.Pins("general"); len(pins) != 0 {
		t.Fatalf("deleted message still pinned: %+v", pins)
	}
}

func TestReactionsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	a, _ := s.Post("general", "pat", "hi")
	s.React("general", a.ID, "alex", "👍", true)
	s.SetPinned("general", a.ID, "pat", true)
	s2, _ := Open(dir)
	m, _ := s2.Get("general", a.ID)
	if len(m.Reactions) != 1 || m.Pinned == nil || m.Pinned.By != "pat" {
		t.Fatalf("%+v", m)
	}
}

// Private chats and DMs: kind and members survive a restart; the same people get the same
// DM; hiding lasts until the next message; DMs can't be renamed or deleted; dm- is reserved.
func TestPrivateAndDM(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	if err := s.Create("staff", Meta{Kind: Private, Members: []string{"pat", "alex", "pat"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateChannel("dm-mine"); !errors.Is(err, ErrReserved) {
		t.Fatalf("dm- name: %v", err)
	}
	dm, err := s.OpenDM([]string{"steve", "pat"}, "pat")
	if err != nil || !strings.HasPrefix(dm, "dm-") {
		t.Fatalf("open dm: %q %v", dm, err)
	}
	if again, _ := s.OpenDM([]string{"pat", "steve"}, "steve"); again != dm {
		t.Fatalf("same people, new DM: %q vs %q", again, dm)
	}
	if _, err := s.OpenDM([]string{"pat"}, "pat"); !errors.Is(err, ErrMembers) {
		t.Fatalf("DM alone: %v", err)
	}
	if _, err := s.OpenDM([]string{"alex", "steve"}, "pat"); !errors.Is(err, ErrMembers) {
		t.Fatalf("DM without the opener: %v", err)
	}
	if err := s.RenameChannel(dm, "chat", "pat"); !errors.Is(err, ErrDMFixed) {
		t.Fatalf("rename DM: %v", err)
	}
	if err := s.DeleteChannel(dm); !errors.Is(err, ErrDMFixed) {
		t.Fatalf("delete DM: %v", err)
	}
	if err := s.Hide(dm, "pat"); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.MetaOf(dm); len(m.Hidden) != 1 {
		t.Fatalf("hidden: %+v", m)
	}
	s.Post(dm, "steve", "you there?")
	if m, _ := s.MetaOf(dm); len(m.Hidden) != 0 {
		t.Fatalf("a message should unhide: %+v", m)
	}
	if err := s.Hide("staff", "pat"); !errors.Is(err, ErrNotDM) {
		t.Fatalf("hide a private chat: %v", err)
	}

	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	staff, _ := s2.MetaOf("staff")
	d, _ := s2.MetaOf(dm)
	if staff.Kind != Private || strings.Join(staff.Members, ",") != "alex,pat" || d.Kind != DM || strings.Join(d.Members, ",") != "pat,steve" {
		t.Fatalf("after restart: %+v %+v", staff, d)
	}
	if !staff.CanSee("steve", true) || staff.CanSee("steve", false) || d.CanSee("alex", true) || !d.CanSee("steve", false) {
		t.Fatal("CanSee: private is members and admins; a DM is members only")
	}
	if m, _ := s2.SetKind("staff", Public, nil); m.Kind != Public {
		t.Fatalf("made public: %+v", m)
	}
	if _, err := os.Stat(filepath.Join(dir, "staff", "meta.json")); !os.IsNotExist(err) {
		t.Fatalf("a public chat has no meta.json: %v", err)
	}
	if _, err := s2.MediaFile(dm, "../x"); !errors.Is(err, ErrBadFile) {
		t.Fatalf("media name with a slash: %v", err)
	}
}

// The list's order: as set, unplaced chats after by name, DMs last; a rename keeps its place;
// it survives a restart.
func TestOrder(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	for _, n := range []string{"builds", "music", "zeta"} {
		s.CreateChannel(n)
	}
	dm, _ := s.OpenDM([]string{"a", "b"}, "a")
	names := func(s *Store) (out []string) {
		for _, c := range s.Channels() {
			out = append(out, c.Name)
		}
		return
	}
	if got := strings.Join(names(s), ","); got != "builds,general,music,zeta,"+dm {
		t.Fatalf("by name, DM last: %s", got)
	}
	if err := s.SetOrder([]string{"music", dm, "general", "nope"}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(s), ","); got != "music,general,builds,zeta,"+dm {
		t.Fatalf("set order: %s", got)
	}
	s.RenameChannel("general", "lobby", "pat")
	s2, _ := Open(dir)
	if got := strings.Join(names(s2), ","); got != "music,lobby,builds,zeta,"+dm {
		t.Fatalf("after rename and restart: %s", got)
	}
}

// The limit is 4000 characters, whatever the script: not bytes, which refused ~1300 CJK.
func TestTextLimitCountsCharacters(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for text, want := range map[string]error{strings.Repeat("字", 4000): nil, strings.Repeat("😀", 4000): nil,
		strings.Repeat("a", 4001): ErrTooLong, strings.Repeat("字", 4001): ErrTooLong} {
		if _, err := s.Post("general", "pat", text); !errors.Is(err, want) {
			t.Errorf("%d characters: %v, want %v", utf8.RuneCountInString(text), err, want)
		}
	}
}

// Messages that show nothing are empty, reactions must be something you'd see, and a chat
// deleted, made again and deleted within one second still deletes (bug sweep).
func TestInvisibleTextReactionsAndQuickDeletes(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"\u200b", "\ufeff\u200b", "\u2800\u2800", "\u3164", " \u200b "} {
		if _, err := s.Post("general", "pat", text); !errors.Is(err, ErrEmpty) {
			t.Errorf("%q: %v, want empty", text, err)
		}
	}
	if _, err := s.Post("general", "pat", "\u200bhi"); err != nil {
		t.Errorf("text with a zero-width space in it: %v", err)
	}
	for e, want := range map[string]bool{"👍": true, "#️⃣": true, "1️⃣": true, "🇬🇧": true, "‼️": true,
		"#": false, "*": false, "7": false, "\u200b": false, "\u2800": false, "a": false} {
		if got := validEmoji(e); got != want {
			t.Errorf("validEmoji(%q) = %v, want %v", e, got, want)
		}
	}
	for i := range 2 {
		if err := s.CreateChannel("builds"); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
		if err := s.DeleteChannel("builds"); err != nil {
			t.Fatalf("delete %d: %v", i, err)
		}
	}
}

// A file posted in chat can't have control characters in its name.
func TestMediaFileName(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"a\nb.txt", "tab\there.png", "bell\a.zip", "", "..", "a/b"} {
		if _, err := s.MediaFile("general", bad); !errors.Is(err, ErrBadFile) {
			t.Errorf("%q: %v, want ErrBadFile", bad, err)
		}
	}
	if _, err := s.MediaFile("general", "farm v2 (final).litematic"); err != nil {
		t.Errorf("ordinary name: %v", err)
	}
}
