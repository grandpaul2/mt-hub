package server

import (
	"strings"
	"testing"
	"time"
)

// A stream tag is one line of 40 characters at most; it shows while its person is live, comes
// back with a stream that dropped for under a minute, and is gone after that.
func TestLiveTags(t *testing.T) {
	if got, ok := cleanTag("  ghast farm,\n phase   2 "); got != "ghast farm, phase 2" || !ok {
		t.Errorf("cleanTag: %q %v", got, ok)
	}
	if _, ok := cleanTag(strings.Repeat("é", 40)); !ok {
		t.Error("40 characters refused")
	}
	if _, ok := cleanTag(strings.Repeat("é", 41)); ok {
		t.Error("41 characters taken")
	}

	var lt liveTags
	t0 := time.Now()
	lt.set("Alex", "ghast farm")
	lt.set("Steve", "idle")
	lt.set("Steve", "")
	live := map[string]bool{"Alex": true}
	if got := lt.sweep(live, t0); len(got) != 1 || got["Alex"] != "ghast farm" {
		t.Errorf("live: %v", got)
	}
	// The stream drops: not shown, but kept for a minute.
	if got := lt.sweep(nil, t0.Add(time.Second)); len(got) != 0 {
		t.Errorf("dropped: %v", got)
	}
	if got := lt.sweep(live, t0.Add(50*time.Second)); got["Alex"] != "ghast farm" {
		t.Errorf("back within the minute: %v", got)
	}
	// It ends: gone a minute after it was first missed, and a new stream starts without it.
	lt.sweep(nil, t0.Add(60*time.Second))
	lt.sweep(nil, t0.Add(121*time.Second))
	if got := lt.sweep(live, t0.Add(122*time.Second)); len(got) != 0 {
		t.Errorf("after the stream ended: %v", got)
	}
}
