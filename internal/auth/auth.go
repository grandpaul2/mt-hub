// Package auth is the hub's accounts: a users.json of names, roles and password hashes,
// and signed session cookies.
//
// users.json is the whole user list; edit it by hand or set passwords with `mthub passwd`.
// It's reread when it changes, so neither needs a restart. A session cookie is
// name|expiry|MAC, signed with a secret kept beside it, so sessions survive restarts with
// nothing stored. The MAC covers the user's password hash too: a new password logs that
// user out everywhere, and a deleted user is out at once. A banned user's sessions still
// check out here; the server turns them away (and says why).
//
// Beside users.json: seen.json (when each user last had the hub open), admin-log.jsonl
// (who banned, reset or deleted whom), retired.json (deleted accounts' names, never given out
// again: chats remember people by name, so a new account would inherit their DMs) and tokens.json (the game's and servers' logins,
// tokens.go).
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// User is one account in users.json.
// The owner is an admin nobody else can ban, demote, delete or reset, and the only one who
// can make or remove admins.
type User struct {
	Owner  bool   `json:"owner,omitempty"`
	Admin  bool   `json:"admin,omitempty"`
	Banned bool   `json:"banned,omitempty"`
	MC     string `json:"mc,omitempty"`  // their Minecraft name, linked from the menu on their name
	Tag    string `json:"tag,omitempty"` // their op tag's colour (server.TagColours); empty: the default
	Hash   string `json:"hash"`
	// Since (unix seconds) is set by Log Out Everywhere. It's signed into every session, so
	// changing it ends them all.
	Since int64 `json:"since,omitempty"`
	// Temp: the password was made by Add or an admin's reset, so others have seen it. Until
	// the user picks their own, the hub lets them do nothing else.
	Temp bool `json:"temp,omitempty"`
}

// Rank orders who may act on whom: owner 2, admin 1, everyone else 0.
func (u User) Rank() int {
	switch {
	case u.Owner:
		return 2
	case u.Admin:
		return 1
	}
	return 0
}

// SessionTTL is how long a login lasts unused; Renew extends it while the hub is in use.
const SessionTTL = 60 * 24 * time.Hour

var NameRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

var (
	ErrBadLogin = errors.New("wrong name or password")
	ErrBanned   = errors.New("this account is banned")
	ErrNoUser   = errors.New("no such user")
	ErrExists   = errors.New("that name is taken")
	ErrRetired  = errors.New("that name belonged to a deleted account, so it can't be used again")
	ErrReserved = errors.New("that name is the hub's release account")
)

type Store struct {
	dir    string
	path   string
	secret []byte

	seenMu    sync.Mutex
	seen      map[string]time.Time
	seenSaved time.Time

	writeMu sync.Mutex // held by update from read to write
	mu      sync.Mutex
	mtime   time.Time // of users.json when last read, with its size: reread when either changes
	size    int64
	users   map[string]User

	tokMu    sync.Mutex // tokens.json (tokens.go), reread like users.json
	tokMtime time.Time
	tokSize  int64
	tokens   []Token
}

// Open reads dir/users.json (a missing file is no users) and dir/secret, creating the
// secret on first use.
func Open(dir string) (*Store, error) {
	s := &Store{dir: dir, path: filepath.Join(dir, "users.json"), seen: map[string]time.Time{}}
	secretPath := filepath.Join(dir, "secret")
	b, err := os.ReadFile(secretPath)
	if errors.Is(err, os.ErrNotExist) {
		b = make([]byte, 32)
		rand.Read(b)
		b = []byte(hex.EncodeToString(b))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		err = os.WriteFile(secretPath, b, 0o600)
	}
	if err != nil {
		return nil, err
	}
	s.secret = []byte(strings.TrimSpace(string(b)))
	if _, err := s.load(); err != nil {
		return nil, err
	}
	if b, err := os.ReadFile(filepath.Join(dir, "seen.json")); err == nil {
		json.Unmarshal(b, &s.seen)
	}
	return s, nil
}

// load returns the users, rereading the file if it changed since last time.
func (s *Store) load() (map[string]User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Stat(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.users, s.mtime = map[string]User{}, time.Time{}
		return s.users, nil
	}
	if err != nil {
		return nil, err
	}
	if s.users != nil && info.ModTime().Equal(s.mtime) && info.Size() == s.size {
		return s.users, nil
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return nil, err
	}
	users := map[string]User{}
	if err := json.Unmarshal(b, &users); err != nil {
		return nil, fmt.Errorf("%s: %w", s.path, err)
	}
	s.users, s.mtime, s.size = users, info.ModTime(), info.Size()
	return users, nil
}

// Users returns every account.
func (s *Store) Users() (map[string]User, error) { return s.load() }

// Get returns one account.
func (s *Store) Get(name string) (User, bool) {
	users, err := s.load()
	if err != nil {
		return User{}, false
	}
	u, ok := users[name]
	return u, ok
}

// SetPassword sets a user's password, creating the user if new.
func (s *Store) SetPassword(name, password string) error {
	if !NameRE.MatchString(name) {
		return fmt.Errorf("bad name %q: letters, digits, _ and - only", name)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	return s.update(func(users map[string]User) error {
		u := users[name]
		u.Hash = string(hash)
		u.Temp = false
		users[name] = u
		return nil
	})
}

// SetTempPassword gives a user a new TempPassword, returned to pass on to them; they must
// change it when they next log in.
func (s *Store) SetTempPassword(name string) (string, error) {
	pw := TempPassword()
	hash, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return pw, s.update(func(users map[string]User) error {
		u, ok := users[name]
		if !ok {
			return ErrNoUser
		}
		u.Hash, u.Temp = string(hash), true
		users[name] = u
		return nil
	})
}

// MCNameRE is a Minecraft name.
var MCNameRE = regexp.MustCompile(`^[A-Za-z0-9_]{1,16}$`)

var ErrMCTaken = errors.New("another account has that Minecraft name")

// SetMC links a Minecraft name to an account, or unlinks with "". A name links to one
// account at most, whatever its case.
func (s *Store) SetMC(name, mc string) error {
	mc = strings.TrimSpace(mc)
	if mc != "" && (!MCNameRE.MatchString(mc) || len(mc) < 3) {
		return errors.New("that isn’t a Minecraft name: 3 to 16 letters, digits and _")
	}
	return s.update(func(users map[string]User) error {
		u, ok := users[name]
		if !ok {
			return ErrNoUser
		}
		for n, o := range users {
			if n != name && mc != "" && strings.EqualFold(o.MC, mc) {
				return ErrMCTaken
			}
		}
		u.MC = mc
		users[name] = u
		return nil
	})
}

// ByMC is the account a Minecraft name is linked to, whatever its case.
func (s *Store) ByMC(mc string) (string, bool) {
	users, err := s.load()
	if err != nil {
		return "", false
	}
	for n, u := range users {
		if u.MC != "" && strings.EqualFold(u.MC, mc) {
			return n, true
		}
	}
	return "", false
}

// Change edits an existing user (roles, ban).
func (s *Store) Change(name string, change func(*User)) error {
	return s.update(func(users map[string]User) error {
		u, ok := users[name]
		if !ok {
			return ErrNoUser
		}
		change(&u)
		users[name] = u
		return nil
	})
}

// Add creates a user with a temporary password, returned to pass on to them.
func (s *Store) Add(name string, admin bool) (string, error) {
	if !NameRE.MatchString(name) {
		return "", fmt.Errorf("bad name %q: letters, digits, _ and - only", name)
	}
	pw := TempPassword()
	hash, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	if strings.EqualFold(name, ReleaseName) {
		return "", ErrReserved
	}
	return pw, s.update(func(users map[string]User) error {
		for n := range users {
			if strings.EqualFold(n, name) {
				return ErrExists
			}
		}
		for _, n := range s.retired() {
			if strings.EqualFold(n, name) {
				return ErrRetired
			}
		}
		users[name] = User{Admin: admin, Hash: string(hash), Temp: true}
		return nil
	})
}

// Delete removes a user; their sessions end at once, and their name is retired.
func (s *Store) Delete(name string) error {
	return s.update(func(users map[string]User) error {
		if _, ok := users[name]; !ok {
			return ErrNoUser
		}
		b, err := json.MarshalIndent(append(s.retired(), name), "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(s.dir, "retired.json"), append(b, '\n'), 0o600); err != nil {
			return err
		}
		delete(users, name)
		return nil
	})
}

// retired is the names of deleted accounts (retired.json). Callers hold writeMu.
func (s *Store) retired() []string {
	var names []string
	if b, err := os.ReadFile(filepath.Join(s.dir, "retired.json")); err == nil {
		json.Unmarshal(b, &names)
	}
	return names
}

// TempPassword is a new random password that's easy to read out: 12 letters and digits
// without look-alikes (0/o, 1/l/i), in groups of four.
func TempPassword() string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	b := make([]byte, 12)
	rand.Read(b)
	var out strings.Builder
	for i, c := range b {
		if i > 0 && i%4 == 0 {
			out.WriteByte('-')
		}
		out.WriteByte(alphabet[int(c)%len(alphabet)])
	}
	return out.String()
}

// update applies change to a copy of the users and writes it out, unless change returns an
// error. One update at a time, start to finish, so two at once can't lose either's change.
func (s *Store) update(change func(map[string]User) error) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cur, err := s.load()
	if err != nil {
		return err
	}
	users := make(map[string]User, len(cur)+1)
	for k, v := range cur {
		users[k] = v
	}
	if err := change(users); err != nil {
		return err
	}
	b, err := json.MarshalIndent(users, "", "  ")
	if err != nil {
		return err
	}
	// A temp file of its own, so `mthub passwd` run beside the hub can't take it away.
	f, err := os.CreateTemp(s.dir, "users.json.*.tmp")
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(f.Name(), s.path)
	}
	if err != nil {
		os.Remove(f.Name())
		return err
	}
	// Keep what we just wrote, rather than trusting the next stat to show a change.
	info, err := os.Stat(s.path)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.users, s.mtime, s.size = users, info.ModTime(), info.Size()
	s.mu.Unlock()
	return nil
}

// Login checks a name and password and returns a session cookie value. Only someone with
// the right password learns that the account is banned.
func (s *Store) Login(name, password string) (string, error) {
	u, ok := s.Get(name)
	if !ok {
		// Take as long as a real check, so the time taken doesn't say which names exist.
		bcrypt.CompareHashAndPassword(dummyHash(), []byte(password))
		return "", ErrBadLogin
	}
	if bcrypt.CompareHashAndPassword([]byte(u.Hash), []byte(password)) != nil {
		return "", ErrBadLogin
	}
	if u.Banned {
		return "", ErrBanned
	}
	return s.session(name, u, time.Now().Add(SessionTTL)), nil
}

var dummyHash = sync.OnceValue(func() []byte {
	h, _ := bcrypt.GenerateFromPassword([]byte("no such user"), bcrypt.DefaultCost)
	return h
})

func (s *Store) session(name string, u User, exp time.Time) string {
	e := strconv.FormatInt(exp.Unix(), 10)
	return base64.RawURLEncoding.EncodeToString([]byte(name)) + "." + e + "." + s.mac(name, e, u)
}

func (s *Store) mac(name, exp string, u User) string {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(name + "\x00" + exp + "\x00" + u.Hash))
	if u.Since != 0 { // absent before anyone used Log Out Everywhere, so older cookies still check out
		m.Write([]byte("\x00" + strconv.FormatInt(u.Since, 10)))
	}
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// Renew returns a fresh cookie value for a valid session at most once a day, or at once for
// one whose expiry is further off than SessionTTL (from when logins lasted a year); "" otherwise.
func (s *Store) Renew(cookie string) string {
	name, u, ok := s.Check(cookie)
	if !ok {
		return ""
	}
	exp, _ := strconv.ParseInt(strings.Split(cookie, ".")[1], 10, 64)
	left := time.Until(time.Unix(exp, 0))
	if left > SessionTTL-24*time.Hour && left <= SessionTTL+time.Hour {
		return ""
	}
	return s.session(name, u, time.Now().Add(SessionTTL))
}

// LogOutEverywhere ends every session of name.
func (s *Store) LogOutEverywhere(name string) error {
	return s.Change(name, func(u *User) {
		now := time.Now().Unix()
		if now <= u.Since {
			now = u.Since + 1
		}
		u.Since = now
	})
}

// Session is a new session cookie value for name (after Log Out Everywhere, for the
// browser that asked).
func (s *Store) Session(name string) (string, bool) {
	u, ok := s.Get(name)
	if !ok {
		return "", false
	}
	return s.session(name, u, time.Now().Add(SessionTTL)), true
}

// Check returns the user a session cookie value belongs to.
func (s *Store) Check(cookie string) (string, User, bool) {
	parts := strings.Split(cookie, ".")
	if len(parts) != 3 {
		return "", User{}, false
	}
	nb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", User{}, false
	}
	name := string(nb)
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", User{}, false
	}
	u, ok := s.Get(name)
	if !ok || !hmac.Equal([]byte(parts[2]), []byte(s.mac(name, parts[1], u))) {
		return "", User{}, false
	}
	return name, u, true
}

// Touch notes that a user has the hub open. It's saved to seen.json at most once a
// minute, so a restart loses at most that much.
func (s *Store) Touch(name string) {
	s.seenMu.Lock()
	defer s.seenMu.Unlock()
	now := time.Now()
	s.seen[name] = now
	if now.Sub(s.seenSaved) < time.Minute {
		return
	}
	s.seenSaved = now
	b, _ := json.Marshal(s.seen)
	tmp := filepath.Join(s.dir, "seen.json.tmp")
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, filepath.Join(s.dir, "seen.json"))
	}
}

// Seen is when a user last had the hub open (zero if never).
func (s *Store) Seen(name string) time.Time {
	s.seenMu.Lock()
	defer s.seenMu.Unlock()
	return s.seen[name]
}

// LogEntry is one line of admin-log.jsonl.
type LogEntry struct {
	Time   time.Time `json:"t"`
	By     string    `json:"by"`
	Action string    `json:"action"` // ban, unban, reset, delete, add, admin, unadmin
	User   string    `json:"user"`
}

// Log records an admin action.
func (s *Store) Log(by, action, user string) error {
	b, _ := json.Marshal(LogEntry{time.Now().UTC().Truncate(time.Second), by, action, user})
	f, err := os.OpenFile(filepath.Join(s.dir, "admin-log.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

// ReadLog returns the last n admin actions, newest first.
func (s *Store) ReadLog(n int) ([]LogEntry, error) {
	b, err := os.ReadFile(filepath.Join(s.dir, "admin-log.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return []LogEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	out := []LogEntry{}
	for i := len(lines) - 1; i >= 0 && len(out) < n; i-- {
		var e LogEntry
		if json.Unmarshal([]byte(lines[i]), &e) == nil {
			out = append(out, e)
		}
	}
	return out, nil
}
