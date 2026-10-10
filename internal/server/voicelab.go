package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The voice lab (web/src/voicelab.ts) sends a report of every take: the settings each capture
// got, every track's levels, and any errors. They're appended to voice-lab.jsonl in the data
// directory (beside thumbs/), one line per report, to be read over ssh.
var voiceLabMu sync.Mutex

// maxVoiceLabLog is where the log stops growing: it's a test page's notes, and nothing else
// the hub writes is without a limit. Move the file away to start a new one.
var maxVoiceLabLog = int64(16 << 20)

func (s *Server) voiceLabLog(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil || !json.Valid(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not JSON"})
		return
	}
	line, _ := json.Marshal(struct {
		Time   time.Time       `json:"t"`
		User   string          `json:"user"`
		Report json.RawMessage `json:"report"`
	}{time.Now().UTC().Truncate(time.Second), who(r).Name, body})
	voiceLabMu.Lock()
	defer voiceLabMu.Unlock()
	f, err := os.OpenFile(filepath.Join(filepath.Dir(s.thumbs), "voice-lab.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		fail(w, err)
		return
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || st.Size()+int64(len(line)) > maxVoiceLabLog {
		writeJSON(w, http.StatusInsufficientStorage, map[string]string{"error": "the voice lab's log is full"})
		return
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
