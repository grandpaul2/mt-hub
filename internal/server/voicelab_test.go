package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/workspace"
)

// The voice lab's log stops growing at its cap: a member can't fill the disk through it.
func TestVoiceLabLogIsBounded(t *testing.T) {
	dir := t.TempDir()
	us, _ := auth.Open(filepath.Join(dir, "users"))
	ws, _ := workspace.Open(filepath.Join(dir, "workspace"))
	cs, _ := chat.Open(filepath.Join(dir, "chat"))
	ls, _ := preview.Open(filepath.Join(dir, "previews"))
	us.SetPassword("Steve", "Steve-password")
	srv := httptest.NewServer(New(us, ws, cs, ls, filepath.Join(dir, "thumbs"), fstest.MapFS{}, nil))
	defer srv.Close()
	cookie, _ := us.Login("Steve", "Steve-password")
	defer func(old int64) { maxVoiceLabLog = old }(maxVoiceLabLog)
	maxVoiceLabLog = 600
	post := func() int {
		r, _ := http.NewRequest("POST", srv.URL+"/api/voice-lab/log", strings.NewReader(`{"note":"`+strings.Repeat("x", 200)+`"}`))
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	codes := []int{post(), post(), post(), post()}
	if codes[0] != http.StatusNoContent || codes[3] != http.StatusInsufficientStorage {
		t.Errorf("codes = %v, want the first kept (204) and the last refused (507)", codes)
	}
	if st, err := os.Stat(filepath.Join(dir, "voice-lab.jsonl")); err != nil || st.Size() > maxVoiceLabLog {
		t.Errorf("log is %v bytes (%v), cap %d", st.Size(), err, maxVoiceLabLog)
	}
}
