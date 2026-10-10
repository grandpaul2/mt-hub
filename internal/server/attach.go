package server

// Files posted in chats. Every chat keeps its own (chat/<chat>/media/, outside Files), of any
// kind, up to 50 MB each, and a message links one as #media/<chat>/<file>. Only people who
// can see the chat can fetch them. Save to Files copies one into Files; forwarding a message
// copies its files into the chat it goes to, so they show there and outlive the original.

import (
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// attachRE is a link to a file posted in a chat: media/<chat>/<file>.
var attachRE = regexp.MustCompile(`^` + workspace.MediaDir + `/([^/]+)/([^/]+)$`)

var bracketRE = regexp.MustCompile(`[^\w./-]`)

// attachment reads a (cleaned) link path as a file posted in a chat: the chat as it's named
// now (following renames) and the file's name. ok is false for anything else, and for a
// chat that's gone.
func (s *Server) attachment(p string) (name, file string, ok bool) {
	m := attachRE.FindStringSubmatch(p)
	if m == nil {
		return "", "", false
	}
	name = m[1]
	for _, rn := range s.chat.Renames() {
		if rn.From == name {
			name = rn.To
		}
	}
	if _, err := s.chat.MetaOf(name); err != nil {
		return "", "", false
	}
	return name, m[2], true
}

// attachPath is the link path of a file posted in a chat.
func attachPath(name, file string) string { return workspace.MediaDir + "/" + name + "/" + file }

// attached is where a file posted in a chat is on disk, if it's there.
func (s *Server) attached(name, file string) (string, bool) {
	p, err := s.chat.MediaFile(name, file)
	if err != nil {
		return "", false
	}
	info, err := os.Stat(p)
	return p, err == nil && info.Mode().IsRegular()
}

// linkPaths is the paths text links (linkedPaths), with files posted in chats named as they are
// now (media/<chat as named now>/<file>), so links written before a chat rename match.
func (s *Server) linkPaths(text string, moves []workspace.Moved) []string {
	out := linkedPaths(text, moves)
	for i, p := range out {
		if name, file, ok := s.attachment(p); ok {
			out[i] = attachPath(name, file)
		}
	}
	return out
}

// store writes r into chat name as file, without replacing anything: a name already there
// gets " (2)". It returns the name it got.
func (s *Server) store(name, file string, r io.Reader) (string, error) {
	dst, err := s.chat.MediaFile(name, file)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return "", err
	}
	ext := path.Ext(file)
	stem := strings.TrimSuffix(file, ext)
	var f *os.File
	for n := 2; ; n++ {
		f, err = os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if !errors.Is(err, os.ErrExist) {
			break
		}
		file = fmt.Sprintf("%s (%d)%s", stem, n, ext)
		dst = filepath.Join(filepath.Dir(dst), file)
	}
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dst)
		return "", err
	}
	return file, nil
}

// postMedia: ?name=<file>, the body is the file (any kind, at most 50 MB). The answer is the
// path to link: media/<chat>/<file>.
func (s *Server) postMedia(w http.ResponseWriter, r *http.Request) {
	const tooBig = "files posted in chat are at most 50 MB"
	if r.ContentLength > maxVersioned {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": tooBig})
		return
	}
	if !s.roomFor(w, r.ContentLength) {
		return
	}
	name := r.PathValue("name")
	file, err := s.store(name, path.Base(strings.ReplaceAll(r.URL.Query().Get("name"), "\\", "/")), http.MaxBytesReader(w, r.Body, maxVersioned))
	var big *http.MaxBytesError
	switch {
	case errors.As(err, &big):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": tooBig})
	case err != nil:
		chatFail(w, err)
	default:
		writeJSON(w, http.StatusOK, map[string]string{"path": attachPath(name, file)})
	}
}

// openAttached opens the file {file} posted in chat {name}, answering 404 if it isn't there.
func (s *Server) openAttached(w http.ResponseWriter, r *http.Request) (*os.File, os.FileInfo, bool) {
	p, ok := s.attached(r.PathValue("name"), r.PathValue("file"))
	if !ok {
		http.NotFound(w, r)
		return nil, nil, false
	}
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return nil, nil, false
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		fail(w, err)
		return nil, nil, false
	}
	return f, info, true
}

// mediaFile serves a file posted in a chat; ?download=1 saves it instead of showing it.
func (s *Server) mediaFile(w http.ResponseWriter, r *http.Request) {
	f, info, ok := s.openAttached(w, r)
	if !ok {
		return
	}
	defer f.Close()
	file := r.PathValue("file")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	if ctype := mime.TypeByExtension(path.Ext(file)); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": file}))
	}
	http.ServeContent(w, r, file, info.ModTime(), f)
}

// mediaThumb serves a small picture of a picture posted in a chat (see thumb).
func (s *Server) mediaThumb(w http.ResponseWriter, r *http.Request) {
	if !thumbable[strings.ToLower(path.Ext(r.PathValue("file")))] {
		http.NotFound(w, r)
		return
	}
	f, info, ok := s.openAttached(w, r)
	if !ok {
		return
	}
	defer f.Close()
	s.serveThumb(w, r, "chat\x00"+r.PathValue("name")+"\x00"+r.PathValue("file"), f, info)
}

// saveMedia copies a file posted in a chat into Files: {"dir": "<folder>"}. A name already
// there gets " (2)"; a file over 50 MB goes in large/. The answer is its path in Files.
func (s *Server) saveMedia(w http.ResponseWriter, r *http.Request) {
	var req struct{ Dir string }
	if !readJSON(w, r, &req) {
		return
	}
	dir := ""
	if strings.Trim(req.Dir, "/") != "" {
		d, err := workspace.Clean(req.Dir)
		if err != nil {
			fail(w, err)
			return
		}
		dir = d
	}
	f, info, ok := s.openAttached(w, r)
	if !ok {
		return
	}
	defer f.Close()
	if info.Size() > maxVersioned && !workspace.IsLarge(dir) {
		dir = workspace.LargeDir
	}
	if !s.roomFor(w, info.Size()) {
		return
	}
	file := r.PathValue("file")
	ext := path.Ext(file)
	stem := strings.TrimSuffix(file, ext)
	p := path.Join(dir, file)
	for n := 2; ; n++ {
		if _, _, err := s.ws.Stat(p); errors.Is(err, workspace.ErrNotFound) {
			break
		}
		p = path.Join(dir, fmt.Sprintf("%s (%d)%s", stem, n, ext))
	}
	if _, err := s.ws.WriteFrom(p, f, "", s.author(r)); err != nil {
		fail(w, err)
		return
	}
	s.bus.publish("files", struct{}{})
	writeJSON(w, http.StatusOK, map[string]string{"path": p})
}

// chatFile is one entry of a chat's file list.
type chatFile struct {
	Path string `json:"path"` // media/<chat>/<file>, the link
	Size int64  `json:"size"`
	ID   string `json:"id"` // the first message that links it
	User string `json:"user"`
	Time string `json:"t"`
}

// chatFiles lists the files posted in a chat that its messages link, newest first, each with
// the first message that links it.
func (s *Server) chatFiles(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	moves, _ := s.ws.Moves()
	seen := map[string]bool{}
	out := []chatFile{}
	s.chat.Each(func(m chat.Message) {
		if m.Channel != name {
			return
		}
		for _, p := range s.linkPaths(messageText(m), moves) {
			c, file, ok := s.attachment(p)
			if !ok || c != name || seen[p] {
				continue
			}
			disk, ok := s.attached(c, file)
			if !ok {
				continue
			}
			seen[p] = true
			info, err := os.Stat(disk)
			if err != nil {
				continue
			}
			out = append(out, chatFile{p, info.Size(), m.ID, m.User, m.Time.Format("2006-01-02T15:04:05.000Z07:00")})
		}
	})
	slices.Reverse(out) // Each goes oldest first within a chat
	writeJSON(w, http.StatusOK, out)
}

// copyLinked copies the files that text links from other chats into chat to, and points
// those links at the copies, so they show for the people there and outlive the original:
// a pasted link and a forward alike. Only files from chats the caller can see are copied;
// other links stay as written (and show nothing). A copy shares the file on disk (a hard
// link) where it can.
func (s *Server) copyLinked(r *http.Request, text, to string) string {
	return linkRE.ReplaceAllStringFunc(text, func(whole string) string {
		g := linkRE.FindStringSubmatch(whole)
		p, err := workspace.Clean(g[2] + g[3])
		if err != nil {
			return whole
		}
		from, file, ok := s.attachment(p)
		if !ok || from == to || !s.canSee(r, from) {
			return whole
		}
		src, ok := s.attached(from, file)
		if !ok {
			return whole
		}
		got, err := s.storeCopy(src, to, file)
		if err != nil {
			log.Printf("copying %s into %s: %v", p, to, err)
			return whole
		}
		return pathRef(attachPath(to, got))
	})
}

// storeCopy puts the file at src into chat name (see store), as a hard link if it can.
func (s *Server) storeCopy(src, name, file string) (string, error) {
	dst, err := s.chat.MediaFile(name, file)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return "", err
	}
	ext := path.Ext(file)
	stem := strings.TrimSuffix(file, ext)
	for n := 2; ; n++ {
		err = os.Link(src, dst)
		if !errors.Is(err, os.ErrExist) {
			break
		}
		file = fmt.Sprintf("%s (%d)%s", stem, n, ext)
		dst = filepath.Join(filepath.Dir(dst), file)
	}
	if err == nil {
		return file, nil
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	return s.store(name, file, in)
}

// pathRef is how chat text links a path (chat.ts pathRef).
func pathRef(p string) string {
	if bracketRE.MatchString(p) {
		return "#[" + p + "]"
	}
	return "#" + p
}

// deleteAttached moves files posted in chats (link paths) to the trash.
func (s *Server) deleteAttached(paths []string, a workspace.Author) {
	for _, p := range paths {
		name, file, ok := s.attachment(p)
		if !ok {
			continue
		}
		disk, ok := s.attached(name, file)
		if !ok {
			continue
		}
		if err := s.ws.Trash(disk, "chat/"+name+"/media/"+file, a); err != nil {
			log.Printf("delete %s: %v", p, err)
		}
	}
}
