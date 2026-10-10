package server

import (
	"slices"
	"testing"

	"github.com/grandpaul2/mt-hub/internal/workspace"
)

func TestLinkedPaths(t *testing.T) {
	moves := []workspace.Moved{{From: "media/old", To: "media/new"}}
	text := "look #media/old/a.png and #[media/new/b c.mp4], not https://x.com/#media/z.png"
	got := linkedPaths(text, moves)
	want := []string{"media/new/a.png", "media/new/b c.mp4"}
	if !slices.Equal(got, want) {
		t.Fatalf("linkedPaths = %q, want %q", got, want)
	}
	// A link that climbs out of media/ is the file it opens, so deleting the message with its
	// files can't reach it (the bug sweep's "#media/../README.md").
	got = linkedPaths("#media/../README.md #[media/../../etc/passwd] #media/./c.png #.GIT/x", nil)
	want = []string{"README.md", "etc/passwd", "media/c.png"}
	if !slices.Equal(got, want) {
		t.Fatalf("linkedPaths = %q, want %q", got, want)
	}
}
