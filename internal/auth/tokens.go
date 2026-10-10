package auth

// Tokens are how our game servers log in (the MT Hub mod), where there's no browser to hold
// a cookie. They're kept in tokens.json beside users.json and never expire; they're revoked.
// A token belongs to a server, not to an account, and is made over ssh with
// `mthub token add -server`. The server does the hub's work for its players, so players
// never need one.
//
// A token reads mt_<id>_<secret>. Only a SHA-256 of the secret is stored: the token itself
// is shown once, when it's made.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

// KindServer is a game server's token. (Per-player "game" tokens existed in S46 and were
// removed in S47: the server talks to the hub for its players.)
const KindServer = "server"

// KindRelease is the release account's token (S60): Claude posts mod release cards to
// #mod-discussion as ReleaseName with it, from Paul's PC. It's the only token of its kind
// that matters; it isn't an account and can't log in to the page.
const KindRelease = "release"

// ReleaseName is who release cards are posted as. No account may take this name.
const ReleaseName = "MacroTech"

// Token is one entry in tokens.json.
type Token struct {
	ID      string    `json:"id"`
	Kind    string    `json:"kind"`
	Server  string    `json:"server"` // which server
	Label   string    `json:"label"`
	Created time.Time `json:"created"`
	Used    time.Time `json:"used,omitzero"`
	Hash    string    `json:"hash"`
}

var ErrNoToken = errors.New("no such token")

// usedEvery: how stale a token's "last used" may get before it's saved again.
const usedEvery = time.Minute

func (s *Store) tokensPath() string { return filepath.Join(s.dir, "tokens.json") }

// loadTokens returns every token, rereading tokens.json if it changed (`mthub token` writes
// it while the hub runs).
func (s *Store) loadTokens() ([]Token, error) {
	s.tokMu.Lock()
	defer s.tokMu.Unlock()
	return s.loadTokensLocked()
}

func (s *Store) loadTokensLocked() ([]Token, error) {
	info, err := os.Stat(s.tokensPath())
	if errors.Is(err, os.ErrNotExist) {
		s.tokens, s.tokMtime = []Token{}, time.Time{}
		return s.tokens, nil
	}
	if err != nil {
		return nil, err
	}
	if s.tokens != nil && info.ModTime().Equal(s.tokMtime) && info.Size() == s.tokSize {
		return s.tokens, nil
	}
	b, err := os.ReadFile(s.tokensPath())
	if err != nil {
		return nil, err
	}
	var toks []Token
	if err := json.Unmarshal(b, &toks); err != nil {
		return nil, fmt.Errorf("%s: %w", s.tokensPath(), err)
	}
	s.tokens, s.tokMtime, s.tokSize = toks, info.ModTime(), info.Size()
	return toks, nil
}

// updateTokens rewrites tokens.json with change applied to a copy of the list.
//
// The hub (recording when a token was last used) and `mthub token` (adding or revoking one)
// are two programs changing the same file. A lock file keeps one's read-change-write whole,
// so the hub can't write back a list that still has a token revoked a moment ago.
func (s *Store) updateTokens(change func([]Token) ([]Token, error)) error {
	s.tokMu.Lock()
	defer s.tokMu.Unlock()
	lock, err := os.OpenFile(s.tokensPath()+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	s.tokens = nil // read what's on disk now, whatever this program read before
	cur, err := s.loadTokensLocked()
	if err != nil {
		return err
	}
	toks, err := change(append([]Token{}, cur...))
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(toks, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.tokensPath() + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.tokensPath()); err != nil {
		return err
	}
	info, err := os.Stat(s.tokensPath())
	if err != nil {
		return err
	}
	s.tokens, s.tokMtime, s.tokSize = toks, info.ModTime(), info.Size()
	return nil
}

var serverNameRE = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

// NewToken makes a server's token and returns it (shown once) with its entry.
func (s *Store) NewToken(server, label string) (string, Token, error) {
	t := Token{Kind: KindServer, Label: strings.TrimSpace(label), Created: time.Now().UTC().Truncate(time.Second)}
	if !serverNameRE.MatchString(server) {
		return "", t, fmt.Errorf("bad server name %q: lowercase letters, digits and - only", server)
	}
	t.Server = server
	if t.Label == "" {
		t.Label = server
	}
	if len([]rune(t.Label)) > 40 {
		return "", t, errors.New("keep the label under 40 characters")
	}
	id := make([]byte, 6)
	secret := make([]byte, 32)
	rand.Read(id)
	rand.Read(secret)
	t.ID = hex.EncodeToString(id)
	sec := base64.RawURLEncoding.EncodeToString(secret)
	t.Hash = hashSecret(sec)
	err := s.updateTokens(func(toks []Token) ([]Token, error) { return append(toks, t), nil })
	return "mt_" + t.ID + "_" + sec, t, err
}

func hashSecret(sec string) string {
	h := sha256.Sum256([]byte(sec))
	return hex.EncodeToString(h[:])
}

// NewReleaseToken makes a release token (posts as ReleaseName) and returns it, shown once.
func (s *Store) NewReleaseToken(label string) (string, Token, error) {
	tok, t, err := s.NewToken("release", label)
	if err != nil {
		return "", t, err
	}
	// NewToken made it as a server token; make it the release one.
	err = s.updateTokens(func(toks []Token) ([]Token, error) {
		for i := range toks {
			if toks[i].ID == t.ID {
				toks[i].Kind, toks[i].Server = KindRelease, ReleaseName
				t = toks[i]
			}
		}
		return toks, nil
	})
	return tok, t, err
}

// CheckToken returns the token (a server's or the release one) a bearer value belongs to.
func (s *Store) CheckToken(value string) (Token, bool) {
	rest, ok := strings.CutPrefix(value, "mt_")
	if !ok {
		return Token{}, false
	}
	id, sec, ok := strings.Cut(rest, "_")
	if !ok {
		return Token{}, false
	}
	toks, err := s.loadTokens()
	if err != nil {
		return Token{}, false
	}
	for _, t := range toks {
		if t.ID == id && (t.Kind == KindServer || t.Kind == KindRelease) && subtle.ConstantTimeCompare([]byte(t.Hash), []byte(hashSecret(sec))) == 1 {
			s.used(t)
			return t, true
		}
	}
	return Token{}, false
}

// used notes when a token was last used, saving at most once a minute per token.
func (s *Store) used(t Token) {
	now := time.Now().UTC().Truncate(time.Second)
	if now.Sub(t.Used) < usedEvery {
		return
	}
	s.updateTokens(func(toks []Token) ([]Token, error) {
		for i := range toks {
			if toks[i].ID == t.ID {
				toks[i].Used = now
			}
		}
		return toks, nil
	})
}

// Tokens lists every token, oldest first.
func (s *Store) Tokens() ([]Token, error) {
	toks, err := s.loadTokens()
	if err != nil {
		return nil, err
	}
	out := append([]Token{}, toks...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Created.Before(out[j].Created) })
	return out, nil
}

// Revoke deletes a token.
func (s *Store) Revoke(id string) error {
	return s.updateTokens(func(toks []Token) ([]Token, error) {
		for i, t := range toks {
			if t.ID == id {
				return append(toks[:i], toks[i+1:]...), nil
			}
		}
		return nil, ErrNoToken
	})
}
