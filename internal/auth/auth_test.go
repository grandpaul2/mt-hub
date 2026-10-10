package auth

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSessions(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetPassword("Paul", "correct horse"); err != nil {
		t.Fatal(err)
	}
	if err := s.Change("Paul", func(u *User) { u.Admin = true }); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Login("Paul", "wrong"); err != ErrBadLogin {
		t.Fatalf("wrong password: %v", err)
	}
	if _, err := s.Login("Nobody", "correct horse"); err != ErrBadLogin {
		t.Fatalf("no such user: %v", err)
	}
	c, err := s.Login("Paul", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if name, u, ok := s.Check(c); !ok || name != "Paul" || !u.Admin {
		t.Fatalf("check: %q %v %v", name, u, ok)
	}

	// A tampered cookie (someone else's name on it) fails.
	parts := strings.Split(c, ".")
	s.SetPassword("Alex", "alex alex")
	if _, _, ok := s.Check("QWxleA." + parts[1] + "." + parts[2]); ok {
		t.Fatal("tampered name accepted")
	}
	// An expired one fails.
	if _, _, ok := s.Check(s.session("Paul", mustGet(t, s, "Paul"), time.Now().Add(-time.Minute))); ok {
		t.Fatal("expired session accepted")
	}

	// Sessions survive a restart (the secret is kept).
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s2.Check(c); !ok {
		t.Fatal("session lost on reopen")
	}

	// A new password ends old sessions.
	time.Sleep(10 * time.Millisecond) // a new mtime for the reload
	s2.SetPassword("Paul", "battery staple")
	if _, _, ok := s.Check(c); ok {
		t.Fatal("old session survived a password change")
	}

	// Removing the user from users.json (by hand) ends their sessions too.
	c, _ = s.Login("Alex", "alex alex")
	time.Sleep(10 * time.Millisecond)
	os.WriteFile(filepath.Join(dir, "users.json"), []byte(`{"Paul": {"admin": true, "hash": "x"}}`), 0o600)
	if _, _, ok := s.Check(c); ok {
		t.Fatal("deleted user's session accepted")
	}
}

func TestAccounts(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}

	// A new account gets a readable temporary password that logs in.
	pw, err := s.Add("Steve", false)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$`).MatchString(pw) {
		t.Fatalf("temp password %q", pw)
	}
	c, err := s.Login("Steve", pw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add("steve", false); err != ErrExists {
		t.Fatalf("same name, other case: %v", err)
	}
	if _, err := s.Add("bad name", false); err == nil {
		t.Fatal("bad name accepted")
	}

	// Banned: the session still checks (the server turns it away and says why), and a
	// login with the right password says banned; a wrong one says nothing more.
	s.Change("Steve", func(u *User) { u.Banned = true })
	if _, u, ok := s.Check(c); !ok || !u.Banned {
		t.Fatalf("banned check: %v %v", u, ok)
	}
	if _, err := s.Login("Steve", pw); err != ErrBanned {
		t.Fatalf("banned login: %v", err)
	}
	if _, err := s.Login("Steve", "wrong"); err != ErrBadLogin {
		t.Fatalf("banned, wrong password: %v", err)
	}

	// Deleted: gone, sessions and all.
	if err := s.Delete("Steve"); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.Check(c); ok {
		t.Fatal("deleted user's session accepted")
	}
	if err := s.Delete("Steve"); err != ErrNoUser {
		t.Fatalf("delete twice: %v", err)
	}

	// The admin log reads back newest first.
	s.Log("Paul", "ban", "Steve")
	s.Log("Paul", "unban", "Steve")
	log, err := s.ReadLog(10)
	if err != nil || len(log) != 2 || log[0].Action != "unban" || log[1].By != "Paul" {
		t.Fatalf("log: %+v %v", log, err)
	}

	// Last seen is saved and survives a reopen.
	s.Touch("Paul")
	s2, _ := Open(dir)
	if time.Since(s2.Seen("Paul")) > time.Minute {
		t.Fatalf("seen after reopen: %v", s2.Seen("Paul"))
	}
}

func mustGet(t *testing.T, s *Store, name string) User {
	u, ok := s.Get(name)
	if !ok {
		t.Fatalf("no %s", name)
	}
	return u
}

// A session is renewed at most daily while in use, and at once if it's from when logins
// lasted a year; Log Out Everywhere ends every earlier session.
func TestRenewAndLogOutEverywhere(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.SetPassword("Paul", "correct horse")
	u := mustGet(t, s, "Paul")
	fresh := s.session("Paul", u, time.Now().Add(SessionTTL))
	if s.Renew(fresh) != "" {
		t.Fatal("renewed a new session")
	}
	for _, exp := range []time.Time{time.Now().Add(SessionTTL - 25*time.Hour), time.Now().Add(365 * 24 * time.Hour)} {
		c := s.Renew(s.session("Paul", u, exp))
		if _, _, ok := s.Check(c); !ok {
			t.Fatalf("no renewal for expiry %v", exp)
		}
	}
	if s.Renew("junk") != "" {
		t.Fatal("renewed junk")
	}

	if err := s.LogOutEverywhere("Paul"); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.Check(fresh); ok {
		t.Fatal("session survived Log Out Everywhere")
	}
	c, _ := s.Session("Paul")
	if _, _, ok := s.Check(c); !ok {
		t.Fatal("new session after Log Out Everywhere")
	}
	s.LogOutEverywhere("Paul") // twice in one second still ends the one before
	if _, _, ok := s.Check(c); ok {
		t.Fatal("second Log Out Everywhere in the same second")
	}
}

// Add and an admin's reset give a temporary password; choosing your own clears it.
func TestTempPassword(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add("Steve", false); err != nil || !mustGet(t, s, "Steve").Temp {
		t.Fatalf("added: temp=%v err=%v", mustGet(t, s, "Steve").Temp, err)
	}
	s.SetPassword("Steve", "steve's own")
	if mustGet(t, s, "Steve").Temp {
		t.Fatal("still temp after choosing one")
	}
	if _, err := s.SetTempPassword("Steve"); err != nil || !mustGet(t, s, "Steve").Temp {
		t.Fatalf("reset: temp=%v err=%v", mustGet(t, s, "Steve").Temp, err)
	}
}

// Account edits at the same moment all land: each update rereads, changes and writes as one
// step (the bug sweep lost accounts added side by side, and same-name adds all "succeeded").
func TestConcurrentEdits(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var dupOK atomic.Int32
	for i := range 20 {
		wg.Add(2)
		go func() { defer wg.Done(); s.Add("U"+strconv.Itoa(i), false) }()
		go func() {
			defer wg.Done()
			if _, err := s.Add("Same", false); err == nil {
				dupOK.Add(1)
			}
		}()
	}
	wg.Wait()
	users, err := s.Users()
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 21 {
		t.Errorf("%d accounts, want 21", len(users))
	}
	if n := dupOK.Load(); n != 1 {
		t.Errorf("%d adds of the same name succeeded, want 1", n)
	}
}
