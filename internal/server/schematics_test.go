package server

import "testing"

func TestParseSchemReadme(t *testing.T) {
	for _, c := range []struct{ text, title, credit, date, desc string }{
		{"# Floor Placer\n\nDesign by Glowsquid · posted 2025-07-09\n\nDO NOT ROTATE!\nTwo lines.", "Floor Placer", "Glowsquid", "2025-07-09", "DO NOT ROTATE!\nTwo lines."},
		{"# Filter\n\nPosted 2025-07-10\n", "Filter", "", "2025-07-10", ""},
		{"# Door\n\nDesign by Flutter\n\nA door.", "Door", "Flutter", "", "A door."},
		{"# Bare\n\nJust a description.", "Bare", "", "", "Just a description."},
		{"No title here.", "dir", "", "", "No title here."},
		{"\ufeff# BOM Title\n\nDesign by Bob · posted 2024-01-02\n\ndesc", "BOM Title", "Bob", "2024-01-02", "desc"}, // a Windows editor's byte-order mark
	} {
		p := &schemPost{Title: "dir"}
		parseSchemReadme(p, c.text)
		if p.Title != c.title || p.Credit != c.credit || p.Date != c.date || p.Desc != c.desc {
			t.Errorf("%q: got %q %q %q %q", c.text, p.Title, p.Credit, p.Date, p.Desc)
		}
	}
}

func TestLessName(t *testing.T) {
	if !lessName("2.png", "10.png") || !lessName("x.png", "x (2).png") || lessName("b.png", "a.png") {
		t.Fatal("lessName order")
	}
}
