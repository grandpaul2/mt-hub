package server

import (
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// SchematicsDir holds the schematic posts, a folder each: the schematic file(s), the
// renders (the first by name is the card picture), and a README.md the Schematic Manager
// reads its card from:
//
//	# 260x260 8gt Floor Placer
//
//	Design by Glowsquid · posted 2025-07-09
//
//	For placing a floor of a single block type…
const SchematicsDir = "schematics"

var (
	schemFile  = regexp.MustCompile(`(?i)\.(litematic|schem|schematic|nbt)$`)
	schemImage = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp)$`)
	// The line under the title: "Design by X · posted 2025-07-09", either half alone.
	schemMeta = regexp.MustCompile(`(?i)^(?:design by (.+?))?\s*(?:·\s*)?(?:posted (\d{4}-\d{2}-\d{2}))?$`)
)

type schemPost struct {
	Dir    string      `json:"dir"` // folder name under schematics/
	Title  string      `json:"title"`
	Credit string      `json:"credit,omitempty"`
	Date   string      `json:"date"` // YYYY-MM-DD: the README's, else the newest file's
	Desc   string      `json:"desc,omitempty"`
	Files  []schemItem `json:"files"`  // schematic files, by name
	Images []schemItem `json:"images"` // renders, by name
}

type schemItem struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Mod  int64  `json:"mod"`
}

// listSchematics is every post in schematics/, newest first.
func (s *Server) listSchematics(w http.ResponseWriter, r *http.Request) {
	entries, err := s.ws.Tree()
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.schemPosts(entries))
}

// schemPosts reads the posts out of a tree listing, newest first.
func (s *Server) schemPosts(entries []workspace.Entry) []*schemPost {
	posts := map[string]*schemPost{}
	newest := map[string]int64{}
	readme := map[string]string{}
	for _, e := range entries {
		rel, ok := strings.CutPrefix(e.Path, SchematicsDir+"/")
		if !ok {
			continue
		}
		dir, name, nested := strings.Cut(rel, "/")
		if posts[dir] == nil && (e.Dir || nested) {
			posts[dir] = &schemPost{Dir: dir, Title: dir, Files: []schemItem{}, Images: []schemItem{}}
		}
		if !nested || e.Dir || strings.Contains(name, "/") {
			continue // the folder itself, a loose file, or something in a subfolder
		}
		p := posts[dir]
		newest[dir] = max(newest[dir], e.Mod)
		it := schemItem{name, e.Size, e.Mod}
		switch {
		case strings.EqualFold(name, "readme.md"):
			readme[dir] = e.Path
		case schemFile.MatchString(name):
			p.Files = append(p.Files, it)
		case schemImage.MatchString(name):
			p.Images = append(p.Images, it)
		}
	}
	out := make([]*schemPost, 0, len(posts))
	for dir, p := range posts {
		if newest[dir] > 0 {
			p.Date = time.UnixMilli(newest[dir]).Format("2006-01-02")
		}
		if rp, ok := readme[dir]; ok {
			if data, err := s.ws.Read(rp, ""); err == nil {
				parseSchemReadme(p, string(data))
			}
		}
		byName := func(l []schemItem) {
			sort.Slice(l, func(i, j int) bool { return lessName(l[i].Name, l[j].Name) })
		}
		byName(p.Files)
		byName(p.Images)
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date > out[j].Date
		}
		return out[i].Dir < out[j].Dir
	})
	return out
}

// parseSchemReadme fills in what the README says: the "# title" line, the line under it
// (credit and date), and the rest as the description.
func parseSchemReadme(p *schemPost, text string) {
	text = strings.TrimPrefix(text, "\ufeff") // the byte-order mark some Windows editors start with
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	i := 0
	next := func() {
		for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
			i++
		}
	}
	next()
	if i < len(lines) && strings.HasPrefix(lines[i], "# ") {
		p.Title = strings.TrimSpace(lines[i][2:])
		i++
		next()
	}
	if i < len(lines) {
		line := strings.TrimSpace(lines[i])
		if m := schemMeta.FindStringSubmatch(line); line != "" && m != nil && (m[1] != "" || m[2] != "") {
			p.Credit = strings.TrimSpace(m[1])
			if m[2] != "" {
				p.Date = m[2]
			}
			i++
		}
	}
	p.Desc = strings.TrimSpace(strings.Join(lines[i:], "\n"))
}

// lessName orders file names as the page does: a name before its numbered copies
// ("1.png" before "2.png" before "10.png"; "x.png" before "x (2).png").
func lessName(a, b string) bool {
	sa, sb := strings.TrimSuffix(a, path.Ext(a)), strings.TrimSuffix(b, path.Ext(b))
	na, nb := leadingNumber(sa), leadingNumber(sb)
	if na >= 0 && nb >= 0 && na != nb {
		return na < nb
	}
	if !strings.EqualFold(sa, sb) {
		return strings.ToLower(sa) < strings.ToLower(sb)
	}
	return a < b
}

func leadingNumber(s string) int {
	n, i := 0, 0
	for ; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
		n = n*10 + int(s[i]-'0')
	}
	if i == 0 {
		return -1
	}
	return n
}
