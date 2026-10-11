// Package chat stores text channels as plain files:
//
//	<dir>/<channel>/<YYYY-MM>.jsonl
//
// plus <dir>/<channel>/meta.json for a private chat or a direct message (its kind and
// members; a chat without one is public) and <dir>/<channel>/media/ for the pictures,
// videos and sounds posted in those (public chats keep theirs in Files, media/<chat>/).
//
// One JSON line per event: a message (maybe a reply or a forward), an edit, a delete, a
// reaction added or taken back, or a pin or unpin. Files are only ever appended,
// so `tail -f` and `grep` work over ssh. Everything is also held in memory (a few people's
// chat is small) and rebuilt from the files at startup. The server owns these files:
// read them freely, but don't edit them while it runs.
package chat

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	ErrNoChannel   = errors.New("no such channel")
	ErrBadChannel  = errors.New("chat names are 1–32 lowercase letters, digits or -")
	ErrExists      = errors.New("a chat with that name already exists")
	ErrNotFound    = errors.New("message not found")
	ErrNotYours    = errors.New("you can only change your own messages")
	ErrEmpty       = errors.New("message is empty")
	ErrTooLong     = errors.New("message is too long")
	ErrLastChannel = errors.New("the last channel can't be deleted")
	ErrBadEmoji    = errors.New("not an emoji")
	ErrBadReply    = errors.New("the message you're replying to isn't in this chat any more")
	ErrReserved    = errors.New("names starting with dm- are kept for direct messages")
	ErrDMFixed     = errors.New("direct messages can't be renamed or deleted, only hidden")
	ErrNotDM       = errors.New("that isn't a direct message")
	ErrMembers     = errors.New("a direct message is 2 to 10 people, you included")
	ErrBadFile     = errors.New("bad file name")
)

// The kinds of chat. A public chat is everyone's; a private one is its members' and the
// admins'; a direct message (DM) is only its members', admins included.
const (
	Public  = ""
	Private = "private"
	DM      = "dm"
)

// MaxDM is the most people in one direct message.
const MaxDM = 10

// Meta is what's in a chat's meta.json: its kind and members. Hidden is the DM's members
// who took it out of their list; a new message brings it back.
type Meta struct {
	Kind    string   `json:"kind,omitempty"`
	Members []string `json:"members,omitempty"`
	Hidden  []string `json:"hidden,omitempty"`
}

// CanSee: user (an admin or not) may see this chat.
func (m Meta) CanSee(user string, admin bool) bool {
	switch m.Kind {
	case Private:
		return admin || slices.Contains(m.Members, user)
	case DM:
		return slices.Contains(m.Members, user)
	}
	return true
}

const maxText = 4000

var nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

type Message struct {
	ID        string     `json:"id"`
	Channel   string     `json:"channel"`
	Time      time.Time  `json:"t"`
	User      string     `json:"user"`
	Text      string     `json:"text"`
	Edited    *time.Time `json:"edited,omitempty"`
	ReplyTo   string     `json:"reply_to,omitempty"` // ID of the message this answers, same chat
	Reply     *Quote     `json:"reply,omitempty"`    // that message as it is now (filled in on the way out)
	Forward   *Forward   `json:"fwd,omitempty"`
	Reactions []Reaction `json:"reactions,omitempty"` // in the order they were first added
	Pinned    *Pin       `json:"pinned,omitempty"`
	Via       string     `json:"via,omitempty"` // said in game on this server (its tag, "SMP"): the server link
	// Nonce is the sender's own tag for a message it is waiting to see confirmed. It goes
	// out once, with the answer and the live event, and is never stored.
	Nonce string `json:"nonce,omitempty"`
}

// Quote is the start of a replied-to message, or Deleted if it's gone.
type Quote struct {
	User    string `json:"user,omitempty"`
	Text    string `json:"text,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
}

// Forward is a copy of the forwarded message, taken when it was forwarded, so it survives
// the original being edited or deleted. Channel is the name it had then.
type Forward struct {
	Channel string    `json:"channel"`
	ID      string    `json:"id"`
	User    string    `json:"user"`
	Time    time.Time `json:"t"`
	Text    string    `json:"text"`
}

type Reaction struct {
	Emoji string   `json:"emoji"`
	Users []string `json:"users"`
}

type Pin struct {
	By   string    `json:"by"`
	Time time.Time `json:"t"`
}

// Draft is a new message: text, and optionally the message it replies to or forwards.
// A forward may have no text of its own.
type Draft struct {
	Text    string
	ReplyTo string
	Forward *Forward
	Via     string // see Message.Via
}

// event is one line in a channel file. For react, unreact, pin and unpin, ID is the
// message's and User is who did it.
type event struct {
	Type  string    `json:"type"` // msg | edit | delete | react | unreact | pin | unpin
	ID    string    `json:"id"`
	Time  time.Time `json:"t"`
	User  string    `json:"user,omitempty"`
	Text  string    `json:"text,omitempty"`
	Reply string    `json:"reply,omitempty"`
	Fwd   *Forward  `json:"fwd,omitempty"`
	Emoji string    `json:"emoji,omitempty"`
	Via   string    `json:"via,omitempty"`
}

type ChannelInfo struct {
	Name   string `json:"name"`
	LastID string `json:"last_id"` // "" if empty; IDs sort by time
	Meta
}

type channel struct {
	msgs []*Message
	byID map[string]*Message
	meta Meta
}

type Store struct {
	dir     string
	mu      sync.Mutex
	chans   map[string]*channel
	lastID  string
	renames []Rename
	order   []string // the chat list's order (<dir>/order.json), set by admins; DMs aren't in it
}

// Rename is one channel rename, kept in <dir>/renames.jsonl so old links can follow it.
type Rename struct {
	From string    `json:"from"`
	To   string    `json:"to"`
	Time time.Time `json:"t"`
	User string    `json:"user"`
}

// Open loads every channel under dir, creating dir and #general if needed.
func Open(dir string) (*Store, error) {
	s := &Store{dir: dir, chans: map[string]*channel{}}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() && nameRE.MatchString(e.Name()) {
			if err := s.load(e.Name()); err != nil {
				return nil, fmt.Errorf("channel %s: %w", e.Name(), err)
			}
		}
	}
	if len(s.chans) == 0 {
		if err := s.CreateChannel("general"); err != nil {
			return nil, err
		}
	}
	if data, err := os.ReadFile(filepath.Join(dir, "order.json")); err == nil {
		json.Unmarshal(data, &s.order)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "renames.jsonl")); err == nil {
		for _, line := range bytes.Split(data, []byte("\n")) {
			var rn Rename
			if json.Unmarshal(line, &rn) == nil && rn.From != "" {
				s.renames = append(s.renames, rn)
			}
		}
	}
	return s, nil
}

// Renames lists every channel rename, oldest first.
func (s *Store) Renames() []Rename {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Rename{}, s.renames...)
}

func (s *Store) load(name string) error {
	ch := &channel{byID: map[string]*Message{}}
	s.chans[name] = ch
	if data, err := os.ReadFile(filepath.Join(s.dir, name, "meta.json")); err == nil {
		if err := json.Unmarshal(data, &ch.meta); err != nil {
			return fmt.Errorf("meta.json: %w", err)
		}
	}
	files, _ := filepath.Glob(filepath.Join(s.dir, name, "*.jsonl"))
	sort.Strings(files) // YYYY-MM sorts by time
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		// A crash mid-append leaves a torn last line. Cut it off, or the next append
		// would be glued onto it and lost too.
		if i := bytes.LastIndexByte(data, '\n'); i < len(data)-1 {
			data = data[:i+1]
			if err := os.Truncate(f, int64(len(data))); err != nil {
				return err
			}
		}
		for _, line := range bytes.Split(data, []byte("\n")) {
			var ev event
			if len(line) == 0 || json.Unmarshal(line, &ev) != nil {
				continue
			}
			ch.apply(name, ev)
			if ev.ID > s.lastID {
				s.lastID = ev.ID
			}
		}
	}
	return nil
}

func (ch *channel) apply(name string, ev event) *Message {
	switch ev.Type {
	case "msg":
		m := &Message{ID: ev.ID, Channel: name, Time: ev.Time, User: ev.User, Text: ev.Text, ReplyTo: ev.Reply, Forward: ev.Fwd, Via: ev.Via}
		ch.msgs = append(ch.msgs, m)
		ch.byID[m.ID] = m
		return m
	case "edit":
		if m := ch.byID[ev.ID]; m != nil {
			t := ev.Time
			m.Text, m.Edited = ev.Text, &t
			return m
		}
	case "delete":
		if m := ch.byID[ev.ID]; m != nil {
			delete(ch.byID, ev.ID)
			for i, x := range ch.msgs {
				if x == m {
					ch.msgs = append(ch.msgs[:i], ch.msgs[i+1:]...)
					break
				}
			}
			return m
		}
	case "react", "unreact":
		if m := ch.byID[ev.ID]; m != nil {
			m.react(ev.Emoji, ev.User, ev.Type == "react")
			return m
		}
	case "pin", "unpin":
		if m := ch.byID[ev.ID]; m != nil {
			m.Pinned = nil
			if ev.Type == "pin" {
				m.Pinned = &Pin{By: ev.User, Time: ev.Time}
			}
			return m
		}
	}
	return nil
}

// react adds or takes back user's emoji. A reaction nobody has any more goes away.
func (m *Message) react(emoji, user string, on bool) {
	for i := range m.Reactions {
		r := &m.Reactions[i]
		if r.Emoji != emoji {
			continue
		}
		at := slices.Index(r.Users, user)
		switch {
		case on && at < 0:
			r.Users = append(r.Users, user)
		case !on && at >= 0:
			r.Users = slices.Delete(r.Users, at, at+1)
			if len(r.Users) == 0 {
				m.Reactions = slices.Delete(m.Reactions, i, i+1)
			}
		}
		return
	}
	if on {
		m.Reactions = append(m.Reactions, Reaction{Emoji: emoji, Users: []string{user}})
	}
}

func (m *Message) reacted(emoji, user string) bool {
	for _, r := range m.Reactions {
		if r.Emoji == emoji {
			return slices.Contains(r.Users, user)
		}
	}
	return false
}

// view is a copy of m safe to hand out (no shared slices), with its reply quote filled in.
func (ch *channel) view(m *Message) Message {
	out := *m
	out.Reactions = nil
	for _, r := range m.Reactions {
		out.Reactions = append(out.Reactions, Reaction{Emoji: r.Emoji, Users: slices.Clone(r.Users)})
	}
	if m.ReplyTo != "" {
		if o := ch.byID[m.ReplyTo]; o != nil {
			out.Reply = &Quote{User: o.User, Text: snippet(o.Text)}
		} else {
			out.Reply = &Quote{Deleted: true}
		}
	}
	return out
}

// snippet is the start of a message for a reply quote.
func snippet(t string) string {
	t = strings.Join(strings.Fields(t), " ")
	if r := []rune(t); len(r) > 200 {
		t = string(r[:200]) + "…"
	}
	return t
}

// Channels lists chats in the list's order: as set (SetOrder), then any not placed yet by
// name. DMs come after them all (the page orders those by their last message).
func (s *Store) Channels() []ChannelInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []ChannelInfo{}
	for name, ch := range s.chans {
		info := ChannelInfo{Name: name, Meta: ch.meta.clone()}
		if n := len(ch.msgs); n > 0 {
			info.LastID = ch.msgs[n-1].ID
		}
		out = append(out, info)
	}
	rank := func(c ChannelInfo) int {
		if c.Kind == DM {
			return len(s.order) + 1
		}
		if i := slices.Index(s.order, c.Name); i >= 0 {
			return i
		}
		return len(s.order)
	}
	sort.Slice(out, func(i, j int) bool {
		if ri, rj := rank(out[i]), rank(out[j]); ri != rj {
			return ri < rj
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// SetOrder sets the chat list's order. Names that aren't chats (or are DMs) are dropped;
// chats left out go after, by name.
func (s *Store) SetOrder(names []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var order []string
	for _, n := range names {
		if ch := s.chans[n]; ch != nil && ch.meta.Kind != DM && !slices.Contains(order, n) {
			order = append(order, n)
		}
	}
	return s.saveOrder(order)
}

// saveOrder writes order.json. Callers hold s.mu.
func (s *Store) saveOrder(order []string) error {
	data, _ := json.Marshal(order)
	f := filepath.Join(s.dir, "order.json")
	if err := os.WriteFile(f+".tmp", data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(f+".tmp", f); err != nil {
		return err
	}
	s.order = order
	return nil
}

func (m Meta) clone() Meta {
	return Meta{Kind: m.Kind, Members: slices.Clone(m.Members), Hidden: slices.Clone(m.Hidden)}
}

// MetaOf is a chat's kind and members.
func (s *Store) MetaOf(name string) (Meta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	if ch == nil {
		return Meta{}, ErrNoChannel
	}
	return ch.meta.clone(), nil
}

// CreateChannel makes a public chat.
func (s *Store) CreateChannel(name string) error {
	return s.Create(name, Meta{})
}

// Create makes a chat of any kind but DM (OpenDM makes those).
func (s *Store) Create(name string, m Meta) error {
	if !nameRE.MatchString(name) {
		return ErrBadChannel
	}
	if strings.HasPrefix(name, "dm-") || m.Kind == DM {
		return ErrReserved
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.create(name, m)
}

// create makes the chat's folder and meta. Callers hold s.mu.
func (s *Store) create(name string, m Meta) error {
	if s.chans[name] != nil {
		return ErrExists
	}
	if err := os.MkdirAll(filepath.Join(s.dir, name), 0o755); err != nil {
		return err
	}
	ch := &channel{byID: map[string]*Message{}}
	s.chans[name] = ch
	return s.saveMeta(name, ch, m)
}

// saveMeta writes a chat's meta.json (a public chat has none). Callers hold s.mu.
func (s *Store) saveMeta(name string, ch *channel, m Meta) error {
	m.Members = sortedSet(m.Members)
	m.Hidden = sortedSet(m.Hidden)
	f := filepath.Join(s.dir, name, "meta.json")
	if m.Kind == Public {
		m = Meta{}
		if err := os.Remove(f); err != nil && !os.IsNotExist(err) {
			return err
		}
	} else {
		data, _ := json.MarshalIndent(m, "", "  ")
		if err := os.WriteFile(f+".tmp", append(data, '\n'), 0o644); err != nil {
			return err
		}
		if err := os.Rename(f+".tmp", f); err != nil {
			return err
		}
	}
	ch.meta = m
	return nil
}

func sortedSet(xs []string) []string {
	out := slices.Clone(xs)
	slices.Sort(out)
	return slices.Compact(out)
}

// SetKind makes a chat public or private, with its members (a private chat's). DMs stay
// as they are.
func (s *Store) SetKind(name, kind string, members []string) (Meta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	switch {
	case ch == nil:
		return Meta{}, ErrNoChannel
	case ch.meta.Kind == DM || kind == DM:
		return Meta{}, ErrDMFixed
	}
	m := Meta{Kind: kind}
	if kind == Private {
		m.Members = members
	}
	err := s.saveMeta(name, ch, m)
	return ch.meta.clone(), err
}

// OpenDM is the direct message between these people (2 to MaxDM, by their account names):
// the one they already have, or a new one. by is who opened it: if they'd hidden it, it's
// back in their list.
func (s *Store) OpenDM(members []string, by string) (string, error) {
	members = sortedSet(members)
	if len(members) < 2 || len(members) > MaxDM || !slices.Contains(members, by) {
		return "", ErrMembers
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for name, ch := range s.chans {
		if ch.meta.Kind == DM && slices.Equal(ch.meta.Members, members) {
			if slices.Contains(ch.meta.Hidden, by) {
				m := ch.meta.clone()
				m.Hidden = slices.DeleteFunc(m.Hidden, func(x string) bool { return x == by })
				if err := s.saveMeta(name, ch, m); err != nil {
					return "", err
				}
			}
			return name, nil
		}
	}
	// A DM's name is a fixed random ID: it isn't anyone's to rename, and its display name
	// is its members.
	for {
		var b [4]byte
		rand.Read(b[:])
		name := fmt.Sprintf("dm-%x", b)
		if s.chans[name] == nil {
			return name, s.create(name, Meta{Kind: DM, Members: members})
		}
	}
}

// Hide takes a DM out of user's list until its next message.
func (s *Store) Hide(name, user string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	if ch == nil {
		return ErrNoChannel
	}
	if ch.meta.Kind != DM {
		return ErrNotDM
	}
	m := ch.meta.clone()
	m.Hidden = append(m.Hidden, user)
	return s.saveMeta(name, ch, m)
}

// MediaFile is where a picture, video or sound posted in a private chat or DM is kept:
// <dir>/<chat>/media/<file>. file is a bare name.
func (s *Store) MediaFile(name, file string) (string, error) {
	// No control characters: the name can end up in Files ("Save to Files"), whose history
	// keeps one record per line.
	if file == "" || file == "." || file == ".." || strings.ContainsAny(file, "/\\\x00") || strings.ContainsFunc(file, unicode.IsControl) {
		return "", ErrBadFile
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.chans[name] == nil {
		return "", ErrNoChannel
	}
	return filepath.Join(s.dir, name, "media", file), nil
}

// RenameChannel renames a channel, its folder and its messages' channel field, and
// records the rename (by user) for old links.
func (s *Store) RenameChannel(from, to, user string) error {
	if !nameRE.MatchString(to) {
		return ErrBadChannel
	}
	if strings.HasPrefix(to, "dm-") {
		return ErrReserved
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[from]
	if ch == nil {
		return ErrNoChannel
	}
	if ch.meta.Kind == DM {
		return ErrDMFixed
	}
	if s.chans[to] != nil {
		return ErrExists
	}
	if err := os.Rename(filepath.Join(s.dir, from), filepath.Join(s.dir, to)); err != nil {
		return err
	}
	for _, m := range ch.msgs {
		m.Channel = to
	}
	delete(s.chans, from)
	s.chans[to] = ch
	if i := slices.Index(s.order, from); i >= 0 { // it keeps its place in the list
		order := slices.Clone(s.order)
		order[i] = to
		if err := s.saveOrder(order); err != nil {
			return err
		}
	}
	rn := Rename{From: from, To: to, Time: time.Now().UTC(), User: user}
	line, _ := json.Marshal(rn)
	f, err := os.OpenFile(filepath.Join(s.dir, "renames.jsonl"), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(append(line, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	s.renames = append(s.renames, rn)
	return err
}

// DeleteChannel moves a channel's folder to <dir>/.deleted/<name>-<unix time>, out of
// sight but recoverable by moving it back (and restarting). The last channel stays.
func (s *Store) DeleteChannel(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.chans[name] == nil {
		return ErrNoChannel
	}
	if s.chans[name].meta.Kind == DM {
		return ErrDMFixed
	}
	if len(s.chans) == 1 {
		return ErrLastChannel
	}
	trash := filepath.Join(s.dir, ".deleted")
	if err := os.MkdirAll(trash, 0o755); err != nil {
		return err
	}
	// Named by time; a chat deleted, made again and deleted within the second gets "-2".
	dst := filepath.Join(trash, fmt.Sprintf("%s-%d", name, time.Now().Unix()))
	for n := 2; ; n++ {
		if _, err := os.Lstat(dst); errors.Is(err, os.ErrNotExist) {
			break
		}
		dst = filepath.Join(trash, fmt.Sprintf("%s-%d-%d", name, time.Now().Unix(), n))
	}
	if err := os.Rename(filepath.Join(s.dir, name), dst); err != nil {
		return err
	}
	delete(s.chans, name)
	return nil
}

// Messages returns up to limit messages before the one with ID before ("" = the newest),
// oldest first.
func (s *Store) Messages(name, before string, limit int) ([]Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	if ch == nil {
		return nil, ErrNoChannel
	}
	end := len(ch.msgs)
	if before != "" {
		end = sort.Search(len(ch.msgs), func(i int) bool { return ch.msgs[i].ID >= before })
	}
	out := []Message{}
	for _, m := range ch.msgs[max(0, end-limit):end] {
		out = append(out, ch.view(m))
	}
	return out, nil
}

// Each calls fn with every message in every chat (copies, after the lock is released).
func (s *Store) Each(fn func(m Message)) {
	s.mu.Lock()
	var all []Message
	for name, ch := range s.chans {
		for _, m := range ch.msgs {
			c := *m
			c.Channel = name
			all = append(all, c)
		}
	}
	s.mu.Unlock()
	for _, m := range all {
		fn(m)
	}
}

// Get returns one message.
func (s *Store) Get(name, id string) (Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	if ch == nil {
		return Message{}, ErrNoChannel
	}
	m := ch.byID[id]
	if m == nil {
		return Message{}, ErrNotFound
	}
	return ch.view(m), nil
}

// Pins returns a channel's pinned messages, most recently pinned first.
func (s *Store) Pins(name string) ([]Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	if ch == nil {
		return nil, ErrNoChannel
	}
	out := []Message{}
	for _, m := range ch.msgs {
		if m.Pinned != nil {
			out = append(out, ch.view(m))
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Pinned.Time.After(out[j].Pinned.Time) })
	return out, nil
}

func (s *Store) Post(name, user, text string) (Message, error) {
	return s.Send(name, user, Draft{Text: text})
}

// Send posts a message, which may reply to one in the same chat or carry a forwarded copy
// (see Forwarded, which makes one).
func (s *Store) Send(name, user string, d Draft) (Message, error) {
	text, err := cleanText(d.Text)
	if errors.Is(err, ErrEmpty) && d.Forward != nil {
		err = nil
	}
	if err != nil {
		return Message{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if d.ReplyTo != "" {
		if ch := s.chans[name]; ch != nil && ch.byID[d.ReplyTo] == nil {
			return Message{}, ErrBadReply
		}
	}
	ev := event{Type: "msg", ID: s.newID(), Time: time.Now().UTC(), User: user, Text: text, Reply: d.ReplyTo, Fwd: d.Forward, Via: d.Via}
	m, err := s.write(name, ev)
	// A new message brings a hidden DM back into everyone's list.
	if ch := s.chans[name]; err == nil && len(ch.meta.Hidden) > 0 {
		meta := ch.meta.clone()
		meta.Hidden = nil
		err = s.saveMeta(name, ch, meta)
	}
	return m, err
}

// After is a chat's messages newer than the one with this ID, oldest first (at most limit,
// the newest ones), and the ID of its last message ("" if it has none).
func (s *Store) After(name, id string, limit int) ([]Message, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	if ch == nil {
		return nil, "", ErrNoChannel
	}
	last := ""
	if n := len(ch.msgs); n > 0 {
		last = ch.msgs[n-1].ID
	}
	start := sort.Search(len(ch.msgs), func(i int) bool { return ch.msgs[i].ID > id })
	out := []Message{}
	for _, m := range ch.msgs[max(start, len(ch.msgs)-limit):] {
		out = append(out, ch.view(m))
	}
	return out, last, nil
}

// Forwarded is a copy of a message for forwarding it.
func (s *Store) Forwarded(name, id string) (*Forward, error) {
	m, err := s.Get(name, id)
	if err != nil {
		return nil, err
	}
	f := &Forward{Channel: name, ID: m.ID, User: m.User, Time: m.Time, Text: m.Text}
	if m.Forward != nil && m.Text == "" {
		f = m.Forward // forwarding a bare forward passes on the original
	}
	return f, nil
}

// React adds (on) or takes back user's emoji reaction. Doing what's already done is fine.
func (s *Store) React(name, id, user, emoji string, on bool) (Message, error) {
	if !validEmoji(emoji) {
		return Message{}, ErrBadEmoji
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	if ch == nil {
		return Message{}, ErrNoChannel
	}
	m := ch.byID[id]
	if m == nil {
		return Message{}, ErrNotFound
	}
	if m.reacted(emoji, user) == on {
		return ch.view(m), nil
	}
	typ := map[bool]string{true: "react", false: "unreact"}[on]
	return s.write(name, event{Type: typ, ID: id, Time: time.Now().UTC(), User: user, Emoji: emoji})
}

// SetPinned pins or unpins a message. Who may is the caller's business (admins).
func (s *Store) SetPinned(name, id, user string, on bool) (Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.chans[name]
	if ch == nil {
		return Message{}, ErrNoChannel
	}
	m := ch.byID[id]
	if m == nil {
		return Message{}, ErrNotFound
	}
	if (m.Pinned != nil) == on {
		return ch.view(m), nil
	}
	typ := map[bool]string{true: "pin", false: "unpin"}[on]
	return s.write(name, event{Type: typ, ID: id, Time: time.Now().UTC(), User: user})
}

// validEmoji: one short run of non-ASCII symbols (an emoji, maybe with skin tone or ZWJ
// parts), nothing that could be text.
func validEmoji(e string) bool {
	if e == "" || len(e) > 32 || !utf8.ValidString(e) {
		return false
	}
	shows := false // something you'd see: a keycap's # * 0-9 alone are plain text
	for _, r := range e {
		if r < 0x80 && r != '#' && r != '*' && (r < '0' || r > '9') {
			return false
		}
		if unicode.IsSpace(r) || unicode.IsLetter(r) {
			return false
		}
		if r == 0x20E3 || r >= 0x80 && !unicode.In(r, unicode.Cf, unicode.Mn) && !blank(r) {
			shows = true
		}
	}
	return shows
}

// blank: characters that print as nothing yet count as letters or symbols (Braille blank,
// Hangul fillers), the favourites for "empty" messages.
func blank(r rune) bool {
	switch r {
	case 0x2800, 0x3164, 0x115F, 0x1160, 0xFFA0:
		return true
	}
	return false
}

func (s *Store) Edit(name, id, user, text string) (Message, error) {
	text, err := cleanText(text)
	if err != nil {
		return Message{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.owns(name, id, user); err != nil {
		return Message{}, err
	}
	return s.write(name, event{Type: "edit", ID: id, Time: time.Now().UTC(), User: user, Text: text})
}

// Delete removes a message. Only its author may, unless admin is set.
func (s *Store) Delete(name, id, user string, admin bool) (Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.owns(name, id, user); err != nil && !(admin && errors.Is(err, ErrNotYours)) {
		return Message{}, err
	}
	return s.write(name, event{Type: "delete", ID: id, Time: time.Now().UTC(), User: user})
}

func (s *Store) owns(name, id, user string) error {
	ch := s.chans[name]
	if ch == nil {
		return ErrNoChannel
	}
	m := ch.byID[id]
	if m == nil {
		return ErrNotFound
	}
	if m.User != user {
		return ErrNotYours
	}
	return nil
}

// write appends ev to the channel's file for this month, then applies it in memory.
// Callers hold s.mu.
func (s *Store) write(name string, ev event) (Message, error) {
	ch := s.chans[name]
	if ch == nil {
		return Message{}, ErrNoChannel
	}
	line, _ := json.Marshal(ev)
	f, err := os.OpenFile(filepath.Join(s.dir, name, ev.Time.Format("2006-01")+".jsonl"),
		os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return Message{}, err
	}
	_, err = f.Write(append(line, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Message{}, err
	}
	m := ch.apply(name, ev)
	out := ch.view(m)
	if ev.Type == "delete" {
		out.Text = ""
	}
	return out, nil
}

// newID returns a time-ordered ID: nanoseconds in hex, bumped if the clock repeats.
func (s *Store) newID() string {
	id := fmt.Sprintf("%016x", time.Now().UnixNano())
	if id <= s.lastID {
		var n uint64
		fmt.Sscanf(s.lastID, "%x", &n)
		id = fmt.Sprintf("%016x", n+1)
	}
	s.lastID = id
	return id
}

func cleanText(t string) (string, error) {
	t = strings.TrimSpace(strings.ReplaceAll(t, "\r\n", "\n"))
	switch {
	case !strings.ContainsFunc(t, func(r rune) bool {
		return unicode.IsGraphic(r) && !unicode.IsSpace(r) && !blank(r)
	}): // nothing that shows: zero-width spaces and the like
		return "", ErrEmpty
	case utf8.RuneCountInString(t) > maxText: // characters, as the message box counts them
		return "", ErrTooLong
	}
	return t, nil
}
