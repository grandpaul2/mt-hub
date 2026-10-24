package voicelink

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// story writes the relay's journal: one line per roster change and one per talk spurt. The
// relay is the one place every roster and every voice frame of voice-link passes (both game
// servers and the hub's bridge), so its journal alone says who was where and who talked when,
// without lining up four logs (that took most of an evening once; see
// macrotech-ops tech-notes/voice-link-silent-after-leave.md). It never looks at audio bytes,
// and it never writes a line per frame.
//
// A spurt is a run of frames from one speaker on one source. It ends with the speaker's empty
// "stopped talking" frame, or, when none comes, after idle without a frame. The line says
// which: a spurt with no stop packet is the one case a listener's Simple Voice Chat client is
// left holding the speaker's last sequence number.
//
// The relay calls it only for a connection that is still the current one for its server, and
// never while holding the relay's own lock.
type story struct {
	logf func(format string, a ...any)
	idle time.Duration
	now  func() time.Time

	mu     sync.Mutex
	names  map[string]map[uuid]string // source → speaker → name, from its last roster
	spurts map[spurtKey]*spurt
}

type uuid [16]byte

type spurtKey struct {
	source  string
	speaker uuid
}

type spurt struct {
	start, last time.Time
	frames      int
}

const spurtIdle = time.Second

func newStory(logf func(format string, a ...any)) *story {
	return &story{logf: logf, idle: spurtIdle, now: time.Now, names: map[string]map[uuid]string{}, spurts: map[spurtKey]*spurt{}}
}

// roster records a source's new roster and logs who came (+), went (-) or was renamed (~)
// since its last one. An unchanged roster logs nothing.
func (s *story) roster(source string, body []byte) {
	var r struct {
		Members []struct {
			UUID string `json:"uuid"`
			Name string `json:"name"`
			MC   string `json:"mc"`
		} `json:"members"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		s.logf("%s roster: unreadable (%d bytes): %v", source, len(body), err)
		return
	}
	now := map[uuid]string{}
	skipped := 0
	for _, m := range r.Members {
		id, ok := parseUUID(m.UUID)
		if !ok {
			skipped++
			continue
		}
		name := clean(m.Name)
		if m.MC != "" {
			name += " (mc " + clean(m.MC) + ")"
		}
		now[id] = name
	}

	var changes []string
	s.mu.Lock()
	old := s.names[source]
	s.names[source] = now
	for id, name := range now {
		if was, ok := old[id]; !ok {
			changes = append(changes, "+"+who(name, id))
		} else if was != name {
			changes = append(changes, "~"+who(was, id)+" is now "+name)
		}
	}
	for id, name := range old {
		if _, ok := now[id]; !ok {
			changes = append(changes, "-"+who(name, id))
		}
	}
	all := list(now)
	s.mu.Unlock()
	if skipped > 0 {
		s.logf("%s roster: %s skipped (no uuid)", source, plural(skipped, "entry"))
	}
	if len(changes) == 0 {
		return
	}
	sort.Strings(changes)
	s.logf("%s roster: %s; now %s", source, strings.Join(changes, " "), all)
}

// gone forgets a source that disconnected: its roster, and any spurt still open.
func (s *story) gone(source string) {
	s.mu.Lock()
	lines := s.endAll(source, "cut off with the connection")
	if old := s.names[source]; len(old) > 0 {
		lines = append(lines, fmt.Sprintf("%s roster dropped with it: had %s", source, list(old)))
	}
	delete(s.names, source)
	s.mu.Unlock()
	s.say(lines)
}

// replaced ends the open spurts of a source that connected again; its roster stays, so the
// next one it sends is reported against it.
func (s *story) replaced(source string) {
	s.mu.Lock()
	lines := s.endAll(source, "cut off: the server connected again")
	s.mu.Unlock()
	s.say(lines)
}

// audio notes one voice frame from a speaker on a source; empty is the "stopped" frame.
func (s *story) audio(source string, speaker uuid, empty bool) {
	k := spurtKey{source, speaker}
	now := s.now()
	var line string
	s.mu.Lock()
	sp := s.spurts[k]
	switch {
	case empty && sp != nil:
		line = s.end(k, sp, "stop packet")
	case !empty && sp == nil:
		s.spurts[k] = &spurt{start: now, last: now, frames: 1}
	case !empty:
		sp.frames++
		sp.last = now
	}
	s.mu.Unlock()
	if line != "" {
		s.logf("%s", line)
	}
}

// sweep ends every spurt that has had no frame for idle.
func (s *story) sweep() {
	now := s.now()
	var lines []string
	s.mu.Lock()
	for k, sp := range s.spurts {
		if now.Sub(sp.last) >= s.idle {
			lines = append(lines, s.end(k, sp, "no stop packet, quiet since "+sp.last.Format("15:04:05.000")))
		}
	}
	s.mu.Unlock()
	s.say(lines)
}

// sweeper runs sweep every quarter of idle until done is closed. The relay runs one per
// connection, for as long as the connection lives.
func (s *story) sweeper(done <-chan struct{}) {
	every := s.idle / 4
	if every <= 0 {
		every = time.Millisecond
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			s.sweep()
		}
	}
}

// endAll ends every open spurt of a source. Callers hold s.mu.
func (s *story) endAll(source, how string) []string {
	var lines []string
	for k, sp := range s.spurts {
		if k.source == source {
			lines = append(lines, s.end(k, sp, how))
		}
	}
	return lines
}

// end forgets a spurt and returns its line. Callers hold s.mu and log after unlocking.
func (s *story) end(k spurtKey, sp *spurt, how string) string {
	delete(s.spurts, k)
	name := s.names[k.source][k.speaker]
	if name == "" {
		name = "(not in its roster)"
	}
	return fmt.Sprintf("%s: %s talked %.1f s from %s, %s, %s", k.source, who(name, k.speaker),
		sp.last.Sub(sp.start).Seconds(), sp.start.Format("15:04:05.000"), plural(sp.frames, "frame"), how)
}

func (s *story) say(lines []string) {
	sort.Strings(lines)
	for _, l := range lines {
		s.logf("%s", l)
	}
}

// who is "Name (05cd3a62)": the name and the first group of the uuid.
func who(name string, id uuid) string {
	return fmt.Sprintf("%s (%x)", name, id[:4])
}

// list is a roster's members, sorted by name.
func list(m map[uuid]string) string {
	if len(m) == 0 {
		return "nobody"
	}
	out := make([]string, 0, len(m))
	for id, name := range m {
		out = append(out, who(name, id))
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}

func plural(n int, what string) string {
	if n == 1 {
		return "1 " + what
	}
	if strings.HasSuffix(what, "y") {
		return fmt.Sprintf("%d %sies", n, strings.TrimSuffix(what, "y"))
	}
	return fmt.Sprintf("%d %ss", n, what)
}

// maxName is the longest name the journal prints; the wire allows any length.
const maxName = 48

// clean keeps a name from the wire to printable characters and a sane length, so no name can
// forge a line or flood one.
func clean(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '?'
		}
		return r
	}, name)
	if len(name) > maxName {
		name = name[:maxName] + "…"
	}
	return name
}

// parseUUID reads the text form the rosters use, "05cd3a62-a9bc-4909-b941-cbc9ba1430d7".
func parseUUID(s string) (uuid, bool) {
	var id uuid
	s = strings.ReplaceAll(s, "-", "")
	if len(s) != 32 {
		return id, false
	}
	for i := 0; i < 16; i++ {
		hi, ok1 := hexVal(s[2*i])
		lo, ok2 := hexVal(s[2*i+1])
		if !ok1 || !ok2 {
			return id, false
		}
		id[i] = hi<<4 | lo
	}
	return id, true
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}
