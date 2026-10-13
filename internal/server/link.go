package server

import (
	"errors"
	"log"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
)

// The server link: one chat, #text-link, shared with game chat on our servers. A line a
// player starts with "$ " in game is posted here by their server (MT Hub Server), and every
// message here is printed in game on each server. A server can also report something by
// itself, a notice (a bot died): that is a message from MacroTech with the server's tag.
// Nothing else crosses, and nothing here runs a command. A server reads the chat by long poll: it asks for what's newer than the
// last message it has, and the hub answers when there is something, or after the wait.

// LinkChat is the chat's name. It was "server-link" until October 2026: a hub that still has
// that one gets it renamed at start (linkSetup), and old links follow the rename. The routes
// keep their address, which the game servers' mod knows.
const (
	LinkChat    = "text-link"
	oldLinkChat = "server-link"
)

// errLinkFixed is the answer to renaming or deleting the link chat on a hub with game servers.
var errLinkFixed = errors.New("#" + LinkChat + " is linked to game chat: it can't be renamed or deleted")

// linkSetup gives a hub from before the rename its chat under the new name.
func (s *Server) linkSetup() {
	if _, err := s.chat.MetaOf(oldLinkChat); err != nil {
		return
	}
	if _, err := s.chat.MetaOf(LinkChat); err == nil {
		return // both exist: someone made the new one by hand; leave them
	}
	if err := s.chat.RenameChannel(oldLinkChat, LinkChat, "the hub"); err != nil {
		log.Printf("link chat: renaming #%s to #%s: %v", oldLinkChat, LinkChat, err)
	}
}

// linkFixed says whether name is the link chat of a hub that has a game server: that chat is
// always there. (Without a game server it is a chat like any other.)
func (s *Server) linkFixed(name string) bool {
	if name != LinkChat {
		return false
	}
	tokens, _ := s.users.Tokens()
	for _, t := range tokens {
		if t.Kind == auth.KindServer {
			return true
		}
	}
	return false
}

// linkLines is how fast one person may post there from the hub.
var linkLines = newLimiter(8, 10*time.Second)

const (
	linkWaitMax = 30 * time.Second
	linkBatch   = 50  // messages in one answer; a server away longer misses the older ones
	linkLine    = 256 // a game chat line
	linkPerMin  = 60  // lines a server's token may post in a minute
	linkHubTag  = "HUB"
)

// linkTags are our servers' tags in game chat and beside a name here, by token name. A server
// not listed gets its name in capitals.
var linkTags = map[string]string{"survival": "SMP", "creative": "CMP"}

func linkTag(server string) string {
	if t := linkTags[server]; t != "" {
		return t
	}
	return strings.ToUpper(server)
}

// linkWake lets the servers' waiting polls know there's a new message.
type linkWake struct {
	mu sync.Mutex
	ch chan struct{}
}

func (l *linkWake) wait() <-chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ch == nil {
		l.ch = make(chan struct{})
	}
	return l.ch
}

func (l *linkWake) wake() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ch != nil {
		close(l.ch)
		l.ch = nil
	}
}

func (s *Server) linkRoutes() {
	s.mux.HandleFunc("POST /api/server-link", s.linkSay)
	s.mux.HandleFunc("GET /api/server-link", s.linkFeed)
}

// linkServer answers 403 unless a game server is asking, and makes sure the chat exists (the
// first server to connect makes it).
func (s *Server) linkServer(w http.ResponseWriter, r *http.Request) bool {
	if who(r).Token != auth.KindServer {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only a game server uses the server link"})
		return false
	}
	switch err := s.chat.CreateChannel(LinkChat); {
	case err == nil:
		s.publishChat("channel", LinkChat, map[string]string{"name": LinkChat})
	case !errors.Is(err, chat.ErrExists):
		chatFail(w, err)
		return false
	}
	return true
}

// linkSay: {"player": "<Minecraft name>", "text": "…"}, a line said in game. It's posted
// under the hub account that Minecraft name is linked to, else the Minecraft name, marked
// with the server's tag. In game it's the other way round: everyone shows by their Minecraft
// name (gameName).
//
// Or {"notice": "…"}: one line the server reports by itself. Every row has an author, so the
// hub posts it as auth.ReleaseName (MacroTech); the server never names one.
func (s *Server) linkSay(w http.ResponseWriter, r *http.Request) {
	if !s.linkServer(w, r) {
		return
	}
	var req struct{ Player, Text, Notice string }
	if !readJSON(w, r, &req) {
		return
	}
	notice := req.Notice != ""
	if notice && (req.Player != "" || req.Text != "") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a notice has no player and no text"})
		return
	}
	if !notice && !auth.MCNameRE.MatchString(req.Player) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "player must be a Minecraft name"})
		return
	}
	// The token sits on a rented host: if it leaked, it could post at most this fast.
	if !s.linkPosts.take(who(r).Name) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many lines; wait a minute"})
		return
	}
	user, text := req.Player, req.Text
	if notice {
		user, text = auth.ReleaseName, linkOneLine(req.Notice)
	} else if name, ok := s.users.ByMC(user); ok {
		user = name
	}
	s.sendMu.Lock()
	m, err := s.chat.Send(LinkChat, user, chat.Draft{Text: text, Via: linkTag(who(r).Name), Notice: notice})
	if err == nil {
		s.publishChat("message", m.Channel, m)
	}
	s.sendMu.Unlock()
	if err != nil {
		chatFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": m.ID})
}

// linkLineOut is a message as a server prints it.
type linkLineOut struct {
	ID   string `json:"id"`
	Tag  string `json:"tag"`  // SMP, CMP or HUB: where it was said
	User string `json:"user"` // their Minecraft name, if the hub knows it
	Text string `json:"text"` // one plain line
	// Notice: a server reported it by itself; it's printed without a name.
	Notice bool `json:"notice,omitempty"`
}

// linkFeed: ?after=<message id>&wait=<seconds>. The messages newer than after that this
// server didn't send itself, oldest first; none yet: the answer waits up to wait seconds for
// one. Without after it answers at once with only `last`, where to start from. `you` is the
// asking server's own tag.
func (s *Server) linkFeed(w http.ResponseWriter, r *http.Request) {
	if !s.linkServer(w, r) {
		return
	}
	me := linkTag(who(r).Name)
	after := r.URL.Query().Get("after")
	secs, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	deadline := time.After(min(max(time.Duration(secs)*time.Second, 0), linkWaitMax))
	for {
		woken := s.linkNew.wait() // before reading, so a message arriving meanwhile isn't missed
		msgs, last, err := s.chat.After(LinkChat, after, linkBatch)
		if err != nil {
			chatFail(w, err)
			return
		}
		out := []linkLineOut{}
		if r.URL.Query().Has("after") {
			for _, m := range msgs {
				if m.Via == me {
					continue
				}
				tag := m.Via
				if tag == "" {
					tag = linkHubTag
				}
				out = append(out, linkLineOut{ID: m.ID, Tag: tag, User: s.gameName(m.User), Text: linkText(m), Notice: m.Notice})
			}
		}
		if len(out) > 0 || !r.URL.Query().Has("after") || secs <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"you": me, "last": last, "messages": out})
			return
		}
		after = max(after, last) // only this server's own lines were new
		select {
		case <-woken:
		case <-deadline:
			writeJSON(w, http.StatusOK, map[string]any{"you": me, "last": after, "messages": out})
			return
		case <-r.Context().Done():
			return
		}
	}
}

// gameName is who a message is from as game chat names them: the Minecraft name linked to
// that hub account. Someone with none linked keeps their hub name. (A line said in game by
// someone with no hub account is stored under their Minecraft name already.)
func (s *Server) gameName(user string) string {
	if u, ok := s.users.Get(user); ok && u.MC != "" {
		return u.MC
	}
	return user
}

var (
	linkBracketRef = regexp.MustCompile(`#\[([^\]\n]+)\]`)
	linkMediaRef   = regexp.MustCompile(`#media/[\w.-]+/(\S+)`)
	linkSpaces     = regexp.MustCompile(`\s+`)
	linkCodes      = regexp.MustCompile(`§.?`)
	linkMarks      = strings.NewReplacer("**", "", "~~", "", "||", "", "`", "")
)

// linkText is a message as one line of game chat: a posted file is its name, a forward with
// nothing added is what it forwards, bold and the like lose their marks, line breaks are
// spaces, and it's cut to a chat line.
func linkText(m chat.Message) string {
	t := m.Text
	if strings.TrimSpace(t) == "" && m.Forward != nil {
		t = m.Forward.Text
	}
	t = linkBracketRef.ReplaceAllStringFunc(t, func(ref string) string { return "[" + path.Base(ref[2:len(ref)-1]) + "]" })
	t = linkMediaRef.ReplaceAllString(t, "[$1]")
	t = linkCodes.ReplaceAllString(t, "") // no game colour codes
	t = linkMarks.Replace(t)              // the commonest Markdown marks; game chat has none
	return linkOneLine(t)
}

// linkOneLine is text as one game chat line: no colour codes, line breaks are spaces, cut to
// a chat line.
func linkOneLine(t string) string {
	t = linkCodes.ReplaceAllString(t, "")
	t = strings.TrimSpace(linkSpaces.ReplaceAllString(t, " "))
	if r := []rune(t); len(r) > linkLine {
		t = string(r[:linkLine-1]) + "…"
	}
	return t
}
