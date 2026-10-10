package server

import (
	"fmt"
	"net/http"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// Search: GET /api/search?q=… looks through chat messages, file and folder names, the text
// inside text files, and schematic posts. The hub is small (a few hundred files, a few
// thousand messages), so every search simply reads everything: no index to keep up to date.
// Text files are cached by size and time, so each is read once until it changes.
//
// The query is words (all must appear, any case, any order; "quoted words" stay together)
// and filters, as in Discord:
//
//	in:#general  in:general   a chat
//	in:schematics/  in:"map art"   a folder (and everything under it)
//	from:name       messages by name
//	mentions:name   messages with @name
//	has:link|image|video|file|schematic|pin
//
// Several in: or from: mean any of them; several has: or mentions: mean all of them.
// from:, mentions: and has: are about messages, so with any of them only chat is searched.

const (
	searchChatMax  = 50
	searchFilesMax = 50
	searchTextMax  = 50
	searchSchemMax = 20
)

type searchResp struct {
	Error      string                `json:"error,omitempty"`
	Words      []string              `json:"words"` // what to highlight
	Chat       searchGroup[chatHit]  `json:"chat"`
	Files      searchGroup[fileHit]  `json:"files"`
	Text       searchGroup[textHit]  `json:"text"`
	Schematics searchGroup[schemHit] `json:"schematics"`
}

type searchGroup[T any] struct {
	Total int `json:"total"`
	Items []T `json:"items"` // the first of them
}

func (g *searchGroup[T]) add(max int, item T) {
	g.Total++
	if len(g.Items) < max {
		g.Items = append(g.Items, item)
	}
}

type chatHit struct {
	Channel string `json:"channel"`
	ID      string `json:"id"`
	User    string `json:"user"`
	Time    string `json:"t"`
	Text    string `json:"text"`
}

type fileHit struct {
	Path string `json:"path"`
	Dir  bool   `json:"dir,omitempty"`
	Mod  int64  `json:"mod,omitempty"`
}

type textHit struct {
	Path string `json:"path"`
	Line int    `json:"line"` // 1-based, the best matching line
	Text string `json:"text"` // that line (shortened around the match)
	Hits int    `json:"hits"` // lines with a match
}

type schemHit struct {
	Dir    string `json:"dir"`
	Title  string `json:"title"`
	Credit string `json:"credit,omitempty"`
	Date   string `json:"date"`
	Image  string `json:"image,omitempty"` // the card picture's name
	Mod    int64  `json:"mod,omitempty"`
}

type query struct {
	words    []string // lowercased
	chats    []string // in:, chats
	folders  []string // in:, folders
	from     []string // lowercased
	mentions []string // lowercased
	has      []string
	inGiven  bool
}

func (q *query) chatOnly() bool { return len(q.from)+len(q.mentions)+len(q.has) > 0 }
func (q *query) empty() bool    { return len(q.words) == 0 && !q.inGiven && !q.chatOnly() }

var hasKinds = []string{"link", "image", "video", "file", "schematic", "pin"}

// tokens splits a query on spaces, keeping "quoted parts" together (quotes removed).
func tokens(s string) []string {
	var out []string
	var b strings.Builder
	quoted, any := false, false
	for _, r := range s {
		switch {
		case r == '"':
			quoted, any = !quoted, true
		case !quoted && (r == ' ' || r == '\t' || r == '\n'):
			if any {
				out = append(out, b.String())
			}
			b.Reset()
			any = false
		default:
			b.WriteRune(r)
			any = true
		}
	}
	if any {
		out = append(out, b.String())
	}
	return out
}

// parseQuery reads the words and filters. chats and folders are what exist, for in:.
func parseQuery(s string, chats []string, folders map[string]bool) (*query, error) {
	q := &query{}
	for _, t := range tokens(s) {
		key, val, ok := strings.Cut(t, ":")
		key = strings.ToLower(key)
		if !ok || !slices.Contains([]string{"in", "from", "has", "mentions"}, key) {
			if t = strings.TrimSpace(strings.ToLower(t)); t != "" {
				q.words = append(q.words, t)
			}
			continue
		}
		val = strings.TrimSpace(val)
		if val == "" {
			continue // still being typed
		}
		switch key {
		case "from":
			q.from = append(q.from, strings.ToLower(strings.TrimPrefix(val, "@")))
		case "mentions":
			q.mentions = append(q.mentions, strings.ToLower(strings.TrimPrefix(val, "@")))
		case "has":
			v := strings.ToLower(val)
			v = strings.TrimSuffix(v, "s") // has:links, has:images…
			if v == "pinned" || v == "pinne" {
				v = "pin"
			}
			if !slices.Contains(hasKinds, v) {
				return nil, fmt.Errorf("has: can be %s", strings.Join(hasKinds, ", "))
			}
			q.has = append(q.has, v)
		case "in":
			q.inGiven = true
			name, isChat := strings.CutPrefix(val, "#")
			isDir, dir := strings.HasSuffix(val, "/"), strings.Trim(val, "/")
			found := false
			if !isDir && slices.Contains(chats, strings.ToLower(name)) {
				q.chats = append(q.chats, strings.ToLower(name))
				found = true
			}
			if !isChat {
				// Folder names match in any case, as typed.
				for f := range folders {
					if strings.EqualFold(f, dir) {
						q.folders = append(q.folders, f)
						found = true
					}
				}
			}
			if !found {
				return nil, fmt.Errorf("no chat or folder called %s", val)
			}
		}
	}
	return q, nil
}

func hasAll(s string, words []string) bool {
	for _, w := range words {
		if !strings.Contains(s, w) {
			return false
		}
	}
	return true
}

// under reports whether p is one of the folders or inside one.
func under(p string, folders []string) bool {
	for _, f := range folders {
		if p == f || strings.HasPrefix(p, f+"/") {
			return true
		}
	}
	return false
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	entries, err := s.ws.Tree()
	if err != nil {
		fail(w, err)
		return
	}
	// Only the chats the caller may see: in: knows no others, and their messages aren't searched.
	me := who(r)
	var chats []string
	for _, c := range s.chat.Channels() {
		if c.CanSee(me.Name, me.Admin) {
			chats = append(chats, c.Name)
		}
	}
	folders := map[string]bool{}
	for _, e := range entries {
		if e.Dir {
			folders[e.Path] = true
		}
	}
	resp := searchResp{Words: []string{}}
	q, err := parseQuery(r.URL.Query().Get("q"), chats, folders)
	if err != nil {
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if q.empty() {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if q.words != nil {
		resp.Words = q.words
	}

	// Chat: when in: names only folders, there's no chat to search.
	if !q.inGiven || len(q.chats) > 0 {
		var hits []chat.Message
		s.chat.Each(func(m chat.Message) {
			if slices.Contains(chats, m.Channel) && matchMessage(m, q) {
				hits = append(hits, m)
			}
		})
		sort.Slice(hits, func(i, j int) bool { return hits[i].ID > hits[j].ID }) // IDs sort by time
		for _, m := range hits {
			text := m.Text
			if m.Forward != nil {
				text = strings.TrimSpace(text + "\n" + m.Forward.Text)
			}
			resp.Chat.add(searchChatMax, chatHit{m.Channel, m.ID, m.User, m.Time.Format("2006-01-02T15:04:05Z07:00"), around(text, q.words, 300)})
		}
	}
	if q.chatOnly() || (q.inGiven && len(q.folders) == 0) {
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// A schematic post's card stands for its folder, README, schematic files and renders;
	// anything else in schematics/ (loose files, subfolders, other files in a post) is found
	// like any file.
	posts := s.schemPosts(entries)
	covered := map[string]bool{}
	for _, p := range posts {
		dir := SchematicsDir + "/" + p.Dir
		covered[dir], covered[dir+"/README.md"] = true, true
		for _, f := range slices.Concat(p.Files, p.Images) {
			covered[dir+"/"+f.Name] = true
		}
	}
	inPost := func(p string) bool { return covered[p] }
	for _, p := range posts {
		dir := SchematicsDir + "/" + p.Dir
		if len(q.folders) > 0 && !under(dir, q.folders) {
			continue
		}
		all := []string{p.Dir, p.Title, p.Credit, p.Desc}
		for _, f := range p.Files {
			all = append(all, f.Name)
		}
		if !hasAll(strings.ToLower(strings.Join(all, "\n")), q.words) {
			continue
		}
		h := schemHit{Dir: p.Dir, Title: p.Title, Credit: p.Credit, Date: p.Date}
		if len(p.Images) > 0 {
			h.Image, h.Mod = p.Images[0].Name, p.Images[0].Mod
		}
		resp.Schematics.add(searchSchemMax, h)
	}

	for _, e := range entries {
		if inPost(e.Path) || (len(q.folders) > 0 && !under(e.Path, q.folders)) {
			continue
		}
		if hasAll(strings.ToLower(e.Path), q.words) {
			resp.Files.add(searchFilesMax, fileHit{e.Path, e.Dir, e.Mod})
			continue
		}
		if e.Dir || len(q.words) == 0 {
			continue
		}
		if text, ok := s.texts.get(s, e); ok {
			if h, ok := matchText(text, q.words); ok {
				h.Path = e.Path
				resp.Text.add(searchTextMax, h)
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// The tokens a message's text can hold (as in the page's chat.ts): web links, and #path or
// #[path with spaces] links to files.
var (
	msgToken   = regexp.MustCompile(`(https?://[^\s<>]+[^\s<>.,;:!?)\]'"])|#\[([^\]\n]+)\]|#([\w./-]*[\w/-])`)
	imageExt   = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|svg)$`)
	videoExt   = regexp.MustCompile(`(?i)\.(mp4|webm|mov|m4v)$`)
	mentionsRE = regexp.MustCompile(`(?:^|[^\w@])@([A-Za-z0-9_-]{1,32})\b`)
)

func matchMessage(m chat.Message, q *query) bool {
	if len(q.chats) > 0 && !slices.Contains(q.chats, m.Channel) {
		return false
	}
	if q.inGiven && len(q.chats) == 0 {
		return false
	}
	if len(q.from) > 0 && !slices.Contains(q.from, strings.ToLower(m.User)) {
		return false
	}
	text := m.Text
	if m.Forward != nil {
		text += "\n" + m.Forward.Text
	}
	if !hasAll(strings.ToLower(text), q.words) {
		return false
	}
	if len(q.mentions) > 0 {
		said := map[string]bool{}
		for _, mm := range mentionsRE.FindAllStringSubmatch(text, -1) {
			said[strings.ToLower(mm[1])] = true
		}
		for _, n := range q.mentions {
			if !said[n] {
				return false
			}
		}
	}
	if len(q.has) == 0 {
		return true
	}
	got := map[string]bool{"pin": m.Pinned != nil}
	for _, t := range msgToken.FindAllStringSubmatch(text, -1) {
		if t[1] != "" {
			got["link"] = true
			continue
		}
		p := t[2] + t[3]
		if !strings.ContainsAny(p, "./") {
			continue // #1, #general: just text
		}
		got["file"] = true
		got["image"] = got["image"] || imageExt.MatchString(p)
		got["video"] = got["video"] || videoExt.MatchString(p)
		got["schematic"] = got["schematic"] || strings.HasPrefix(p, SchematicsDir+"/") || schemFile.MatchString(p)
	}
	for _, k := range q.has {
		if !got[k] {
			return false
		}
	}
	return true
}

// matchText finds the words in a file: all must be in it somewhere. The line shown is the
// first with the most of them.
func matchText(text string, words []string) (textHit, bool) {
	lower := strings.ToLower(text)
	if !hasAll(lower, words) {
		return textHit{}, false
	}
	var best textHit
	bestN := 0
	for i, line := range strings.Split(lower, "\n") {
		n := 0
		for _, w := range words {
			if strings.Contains(line, w) {
				n++
			}
		}
		if n > 0 {
			best.Hits++
		}
		if n > bestN {
			bestN, best.Line = n, i+1
		}
	}
	if best.Line == 0 { // the words only meet across lines
		best.Line = 1
	}
	best.Text = around(strings.Split(text, "\n")[best.Line-1], words, 160)
	return best, true
}

// around shortens s to about n characters, keeping the first match in view.
func around(s string, words []string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	at := -1
	lower := strings.ToLower(s)
	for _, w := range words {
		if i := strings.Index(lower, w); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	r := []rune(s)
	start := 0
	if at > 0 {
		start = max(utf8.RuneCountInString(lower[:at])-n/4, 0)
	}
	end := min(start+n, len(r))
	out := string(r[start:end])
	if start > 0 {
		out = "…" + out
	}
	if end < len(r) {
		out += "…"
	}
	return out
}

// textCache holds the text files' contents for search, by path, until size or time change.
// Files that aren't text are remembered too (as not text), so they aren't read again.
type textCache struct {
	mu    sync.Mutex
	files map[string]cachedText
	bytes int64 // of text held
}

// maxTextCache is how much text the cache holds. Past it the cache starts over: a hub's
// notes and READMEs fit many times, and a pile of big text files can't use up the memory.
var maxTextCache int64 = 64 << 20

type cachedText struct {
	size, mod int64
	text      string
	isText    bool
}

// Never text: pictures, video, archives, Minecraft data.
var binaryExt = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|ico|mp4|webm|mov|m4v|mp3|ogg|wav|zip|jar|gz|tgz|xz|7z|rar|litematic|schem|schematic|nbt|mca|dat|pdf|woff2?|ttf)$`)

func (c *textCache) get(s *Server, e workspace.Entry) (string, bool) {
	if e.Size > maxEditable || binaryExt.MatchString(path.Base(e.Path)) {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.files == nil {
		c.files = map[string]cachedText{}
	}
	if f, ok := c.files[e.Path]; ok && f.size == e.Size && f.mod == e.Mod {
		return f.text, f.isText
	}
	data, err := s.ws.Read(e.Path, "")
	if err != nil {
		return "", false
	}
	f := cachedText{size: e.Size, mod: e.Mod, isText: isText(data)}
	if f.isText {
		f.text = string(data)
	}
	c.bytes -= int64(len(c.files[e.Path].text))
	delete(c.files, e.Path)
	if c.bytes+int64(len(f.text)) > maxTextCache {
		c.files, c.bytes = map[string]cachedText{}, 0
	}
	if int64(len(f.text)) <= maxTextCache {
		c.files[e.Path] = f
		c.bytes += int64(len(f.text))
	}
	return f.text, f.isText
}
