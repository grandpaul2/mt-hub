package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// channels lists the chats the caller may see, without the DMs they've hidden. Who else hid
// a DM is nobody else's business.
func (s *Server) channels(w http.ResponseWriter, r *http.Request) {
	me := who(r)
	out := []chat.ChannelInfo{}
	for _, c := range s.chat.Channels() {
		if !c.CanSee(me.Name, me.Admin) || slices.Contains(c.Hidden, me.Name) {
			continue
		}
		c.Hidden = nil
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, out)
}

// setOrder: {"names": [...]}, the chat list's order (DMs aren't in it). Admins only, like
// Discord's channel order. Every page reloads its list; the event names no chats.
func (s *Server) setOrder(w http.ResponseWriter, r *http.Request) {
	if !s.isAdmin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can reorder chats"})
		return
	}
	var req struct{ Names []string }
	if !readJSON(w, r, &req) {
		return
	}
	if err := s.chat.SetOrder(req.Names); err != nil {
		fail(w, err)
		return
	}
	s.bus.publish("channel", map[string]bool{"order": true})
	writeJSON(w, http.StatusOK, map[string]string{})
}

func (s *Server) channelRenames(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.visibleRenames(r))
}

// createChannel: {"name": "...", "kind": "private", "members": [...]}; kind and members
// optional. Only admins make private chats; the maker is a member.
func (s *Server) createChannel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    string
		Kind    string
		Members []string
	}
	if !readJSON(w, r, &req) {
		return
	}
	meta := chat.Meta{Kind: req.Kind}
	switch req.Kind {
	case chat.Public:
	case chat.Private:
		if !s.isAdmin(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can make a private chat"})
			return
		}
		members, err := s.members(append(req.Members, who(r).Name))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		meta.Members = members
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a chat is public or private (direct messages start from /api/dms)"})
		return
	}
	if err := s.chat.Create(req.Name, meta); err != nil {
		chatFail(w, err)
		return
	}
	s.publishChat("channel", req.Name, map[string]string{"name": req.Name})
	writeJSON(w, http.StatusOK, map[string]string{"name": req.Name})
}

// renameChannel: {"name": "new-name"}. Admins only, for now.
func (s *Server) renameChannel(w http.ResponseWriter, r *http.Request) {
	if !s.isAdmin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can rename a chat"})
		return
	}
	var req struct{ Name string }
	if !readJSON(w, r, &req) {
		return
	}
	from := r.PathValue("name")
	if err := s.chat.RenameChannel(from, req.Name, s.author(r).Name); err != nil {
		chatFail(w, err)
		return
	}
	// Its files move with it (they're kept in its folder); old links follow the rename.
	s.publishChat("channel", req.Name, map[string]string{"renamed": from, "name": req.Name})
	writeJSON(w, http.StatusOK, map[string]string{"name": req.Name})
}

// deleteChannel hides a channel (its folder, files posted in it included, moves to
// .deleted). Admins only.
func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) {
	if !s.isAdmin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can delete a chat"})
		return
	}
	name := r.PathValue("name")
	meta, _ := s.chat.MetaOf(name)
	if err := s.chat.DeleteChannel(name); err != nil {
		chatFail(w, err)
		return
	}
	s.publishChat("channel", name, map[string]string{"deleted": name}, meta)
	writeJSON(w, http.StatusOK, map[string]string{})
}

func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	msgs, err := s.chat.Messages(r.PathValue("name"), r.URL.Query().Get("before"), limit)
	if err != nil {
		chatFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

// post: {"text": "...", "reply_to": "<id>", "forward": {"channel": "...", "id": "..."}};
// all but text optional, and a forward needs no text.
func (s *Server) post(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text    string
		ReplyTo string `json:"reply_to"`
		Forward *struct{ Channel, ID string }
	}
	if !readJSON(w, r, &req) {
		return
	}
	name := r.PathValue("name")
	// What's said in the link chat is printed in both games' chat, so a person can't flood it.
	if name == LinkChat && who(r).Token == "" && !linkLines.take(who(r).Name) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "that's a lot at once for the game chat: wait a few seconds"})
		return
	}
	d := chat.Draft{Text: s.copyLinked(r, req.Text, name), ReplyTo: req.ReplyTo}
	if req.Forward != nil {
		// Forwarding out of a private chat is the forwarder's choice, but only from one
		// they can see.
		if !s.canSee(r, req.Forward.Channel) {
			chatFail(w, chat.ErrNoChannel)
			return
		}
		f, err := s.chat.Forwarded(req.Forward.Channel, req.Forward.ID)
		if err != nil {
			chatFail(w, err)
			return
		}
		c := *f // f may be the stored message's own forward
		c.Text = s.copyLinked(r, c.Text, name)
		d.Forward = &c
	}
	s.sendMu.Lock()
	m, err := s.chat.Send(r.PathValue("name"), s.author(r).Name, d)
	if err == nil {
		s.publishChat("message", m.Channel, m)
	}
	s.sendMu.Unlock()
	if err != nil {
		chatFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) edit(w http.ResponseWriter, r *http.Request) {
	var req struct{ Text string }
	if !readJSON(w, r, &req) {
		return
	}
	name, id := r.PathValue("name"), r.PathValue("id")
	text := req.Text
	had := map[string]bool{} // this chat's files the message linked before the edit
	if old, err := s.chat.Get(name, id); err == nil && old.User == s.author(r).Name {
		text = s.copyLinked(r, text, name) // only for an edit that will go through
		had = s.ownMedia(old)
	}
	m, err := s.chat.Edit(name, id, s.author(r).Name, text)
	if err != nil {
		chatFail(w, err)
		return
	}
	s.publishChat("edit", m.Channel, m)
	// A file the edit took out of the message, and that nothing else links, goes to the trash.
	s.deleteAttached(s.unlinked(had, func(chat.Message) bool { return false }), s.author(r))
	writeJSON(w, http.StatusOK, m)
}

// deleteMessage deletes a message. With ?files=1 it also deletes the files posted in chat
// that only it linked (see orphans), to the trash.
func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request) {
	name, id := r.PathValue("name"), r.PathValue("id")
	var files []string
	if r.URL.Query().Get("files") == "1" {
		files = s.orphanMedia(name, id)
	}
	// Admins may delete anyone's message, but not in a DM: there they're just a member.
	meta, _ := s.chat.MetaOf(name)
	m, err := s.chat.Delete(name, id, s.author(r).Name, s.isAdmin(r) && meta.Kind != chat.DM)
	if err != nil {
		chatFail(w, err)
		return
	}
	s.publishChat("delete", m.Channel, map[string]string{"channel": m.Channel, "id": m.ID})
	s.deleteAttached(files, s.author(r))
	writeJSON(w, http.StatusOK, map[string]string{})
}

// orphans lists the files posted in chat that a message links and no other message (in any
// chat, forwards included) does: the ones deleting it would leave unused.
func (s *Server) orphans(w http.ResponseWriter, r *http.Request) {
	if _, err := s.chat.Get(r.PathValue("name"), r.PathValue("id")); err != nil {
		chatFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"paths": s.orphanMedia(r.PathValue("name"), r.PathValue("id"))})
}

func (s *Server) orphanMedia(name, id string) []string {
	m, err := s.chat.Get(name, id)
	if err != nil {
		return nil
	}
	return s.unlinked(s.ownMedia(m), func(o chat.Message) bool { return o.Channel == name && o.ID == id })
}

// ownMedia is the files posted in a message's own chat that it links (link paths).
func (s *Server) ownMedia(m chat.Message) map[string]bool {
	moves, _ := s.ws.Moves()
	mine := map[string]bool{}
	for _, p := range s.linkPaths(messageText(m), moves) {
		// Only this chat's own files: a message can name a file posted in another chat (one
		// its writer may not even see), and deleting the message must never reach that.
		if in, file, ok := s.attachment(p); ok && in == m.Channel {
			if _, ok := s.attached(in, file); ok {
				mine[p] = true
			}
		}
	}
	return mine
}

// unlinked is the paths in cands that no message links, skipping the messages skip picks;
// sorted.
func (s *Server) unlinked(cands map[string]bool, skip func(chat.Message) bool) []string {
	out := []string{}
	if len(cands) == 0 {
		return out
	}
	moves, _ := s.ws.Moves()
	s.chat.Each(func(o chat.Message) {
		if skip(o) {
			return
		}
		for _, p := range s.linkPaths(messageText(o), moves) {
			delete(cands, p)
		}
	})
	for p := range cands {
		out = append(out, p)
	}
	slices.Sort(out)
	return out
}

func messageText(m chat.Message) string {
	if m.Forward != nil {
		return m.Text + "\n" + m.Forward.Text
	}
	return m.Text
}

// linkRE matches what chat text links, as the page reads it (chat.ts TOKEN): web links,
// #[path with spaces] and #path.
var linkRE = regexp.MustCompile(`(https?://[^\s<>]+[^\s<>.,;:!?)\]'"])|#\[([^\]\n]+)\]|#([\w./-]*[\w/-])`)

// linkedPaths is the file paths text links, where they are now (following moves). They're
// cleaned like any path from the page, so "media/../x" counts as the x it opens, not as media.
func linkedPaths(text string, moves []workspace.Moved) []string {
	var out []string
	for _, g := range linkRE.FindAllStringSubmatch(text, -1) {
		p, err := workspace.Clean(g[2] + g[3])
		if err != nil {
			continue
		}
		for _, mv := range moves {
			if p == mv.From || strings.HasPrefix(p, mv.From+"/") {
				p = mv.To + p[len(mv.From):]
			}
		}
		out = append(out, p)
	}
	return out
}

// react adds (PUT) or takes back (DELETE) the caller's emoji. The changed message goes out
// as an edit.
func (s *Server) react(w http.ResponseWriter, r *http.Request) {
	m, err := s.chat.React(r.PathValue("name"), r.PathValue("id"), s.author(r).Name, r.PathValue("emoji"), r.Method == http.MethodPut)
	if err != nil {
		chatFail(w, err)
		return
	}
	s.publishChat("edit", m.Channel, m)
	writeJSON(w, http.StatusOK, m)
}

// pin pins (PUT) or unpins (DELETE) a message. Admins only, except in a DM, where its
// people may (admins can't see DMs).
func (s *Server) pin(w http.ResponseWriter, r *http.Request) {
	if meta, _ := s.chat.MetaOf(r.PathValue("name")); !s.isAdmin(r) && meta.Kind != chat.DM {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can pin messages"})
		return
	}
	m, err := s.chat.SetPinned(r.PathValue("name"), r.PathValue("id"), s.author(r).Name, r.Method == http.MethodPut)
	if err != nil {
		chatFail(w, err)
		return
	}
	s.publishChat("edit", m.Channel, m)
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) pins(w http.ResponseWriter, r *http.Request) {
	msgs, err := s.chat.Pins(r.PathValue("name"))
	if err != nil {
		chatFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return false
	}
	return true
}

func chatFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, chat.ErrNoChannel), errors.Is(err, chat.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, chat.ErrNotYours):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	case errors.Is(err, chat.ErrExists):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, chat.ErrBadChannel), errors.Is(err, chat.ErrEmpty), errors.Is(err, chat.ErrTooLong),
		errors.Is(err, chat.ErrLastChannel), errors.Is(err, chat.ErrBadEmoji), errors.Is(err, chat.ErrBadReply),
		errors.Is(err, chat.ErrReserved), errors.Is(err, chat.ErrDMFixed), errors.Is(err, chat.ErrNotDM),
		errors.Is(err, chat.ErrMembers), errors.Is(err, chat.ErrBadFile):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		fail(w, err)
	}
}
