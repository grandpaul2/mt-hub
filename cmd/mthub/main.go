// mthub serves the shared workspace: a file tree (git-backed) and text channels.
//
//	mthub [-addr A] [-data D] [-dev]
//	mthub passwd [-data D] [-admin=true|false] <name>   set a password (adds the user if new)
//	mthub user [-data D] [-owner=..] [-admin=..] [-banned=..] <name>   change roles, ban or unban
//	mthub token [-data D] list | add -server <name> [-label L] | add -release | revoke <id>   tokens: game servers (MT Hub mod), the release account
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/grandpaul2/mt-hub/internal/auth"
	"github.com/grandpaul2/mt-hub/internal/chat"
	"github.com/grandpaul2/mt-hub/internal/preview"
	"github.com/grandpaul2/mt-hub/internal/server"
	"github.com/grandpaul2/mt-hub/internal/workspace"
	"github.com/grandpaul2/mt-hub/web"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "passwd" {
		passwd(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "user" {
		userCmd(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "token" {
		tokenCmd(os.Args[2:])
		return
	}
	fl := flag.NewFlagSet("mthub", flag.ExitOnError)
	addr := fl.String("addr", "127.0.0.1:8484", "listen address")
	data := fl.String("data", "./data", "data directory")
	dev := fl.Bool("dev", false, "serve the frontend from web/dist on disk instead of the embedded copy")
	lan := fl.Bool("lan", false, "answer anyone who can reach -addr; without it, only this machine (the tunnel) and the tailnet")
	minFree := fl.Int64("min-free", server.MinFree>>30, "GB of disk that uploads must leave free")
	fl.Parse(os.Args[1:])
	server.MinFree = *minFree << 30

	static, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		log.Fatal(err)
	}
	var etags map[string]string
	if *dev {
		static = os.DirFS("web/dist")
	} else if etags, err = server.HashFiles(static); err != nil {
		log.Fatal(err)
	}
	us, err := auth.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	ws, err := workspace.Open(filepath.Join(*data, "workspace"))
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		for ; ; time.Sleep(time.Hour) {
			if err := ws.PurgeTrash(time.Now()); err != nil {
				log.Printf("purge trash: %v", err)
			}
		}
	}()
	cs, err := chat.Open(filepath.Join(*data, "chat"))
	if err != nil {
		log.Fatal(err)
	}
	ls, err := preview.Open(filepath.Join(*data, "previews"))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("mthub on http://%s (data %s)", *addr, *data)
	// Timeouts for slow or idle connections only: uploads, downloads and the event stream
	// can rightly take as long as they take.
	var handler http.Handler = server.New(us, ws, cs, ls, filepath.Join(*data, "thumbs"), static, etags)
	if !*lan {
		handler = server.TunnelOrTailnet(handler)
	}
	srv := &http.Server{Addr: *addr, Handler: handler,
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	log.Fatal(srv.ListenAndServe())
}

// passwd sets a user's password in <data>/users.json, asking for it twice on a terminal
// (or reading one line from stdin otherwise). The running hub picks it up at once.
func passwd(args []string) {
	fl := flag.NewFlagSet("mthub passwd", flag.ExitOnError)
	data := fl.String("data", "./data", "data directory")
	admin := fl.String("admin", "", "true or false: make the user an admin or not")
	fl.Parse(args)
	if fl.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: mthub passwd [-data D] [-admin=true|false] <name>")
		os.Exit(2)
	}
	name := fl.Arg(0)
	us, err := auth.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	var pw string
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprintf(os.Stderr, "Password for %s: ", name)
		a, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Fprint(os.Stderr, "Again: ")
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			log.Fatal(err)
		}
		if string(a) != string(b) {
			log.Fatal("the passwords don't match")
		}
		pw = string(a)
	} else {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			log.Fatal("no password on stdin")
		}
		pw = strings.TrimRight(line, "\r\n")
	}
	if len(pw) < 8 {
		log.Fatal("use at least 8 characters")
	}
	if err := us.SetPassword(name, pw); err != nil {
		log.Fatal(err)
	}
	if *admin != "" {
		if err := us.Change(name, func(u *auth.User) { u.Admin = *admin == "true" }); err != nil {
			log.Fatal(err)
		}
	}
	u, _ := us.Get(name)
	fmt.Printf("%s: password set (admin: %v)\n", name, u.Admin)
}

// userCmd changes a user's roles or bans them, the same as the Admin page but from ssh
// (and the only way to set the owner). A ban takes effect at once, open pages included.
func userCmd(args []string) {
	fl := flag.NewFlagSet("mthub user", flag.ExitOnError)
	data := fl.String("data", "./data", "data directory")
	owner := fl.String("owner", "", "true or false")
	admin := fl.String("admin", "", "true or false")
	banned := fl.String("banned", "", "true or false")
	fl.Parse(args)
	if fl.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: mthub user [-data D] [-owner=true|false] [-admin=true|false] [-banned=true|false] <name>")
		os.Exit(2)
	}
	name := fl.Arg(0)
	us, err := auth.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	set := func(flag string, field *bool) {
		if flag != "" {
			*field = flag == "true"
		}
	}
	err = us.Change(name, func(u *auth.User) {
		set(*owner, &u.Owner)
		set(*admin, &u.Admin)
		set(*banned, &u.Banned)
		if u.Owner {
			u.Admin = true
		}
	})
	if err != nil {
		log.Fatal(err)
	}
	u, _ := us.Get(name)
	fmt.Printf("%s: owner %v, admin %v, banned %v\n", name, u.Owner, u.Admin, u.Banned)
}

// tokenCmd lists every token, makes a server's (players make theirs on the page) or
// revokes one. A new token is printed once; the running hub picks changes up at once.
func tokenCmd(args []string) {
	usage := func() {
		fmt.Fprintln(os.Stderr, "usage: mthub token [-data D] list\n       mthub token [-data D] add -server <name> [-label L]\n       mthub token [-data D] add -release [-label L]\n       mthub token [-data D] revoke <id>")
		os.Exit(2)
	}
	fl := flag.NewFlagSet("mthub token", flag.ExitOnError)
	data := fl.String("data", "./data", "data directory")
	fl.Parse(args)
	if fl.NArg() < 1 {
		usage()
	}
	us, err := auth.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	switch fl.Arg(0) {
	case "list":
		toks, err := us.Tokens()
		if err != nil {
			log.Fatal(err)
		}
		for _, t := range toks {
			used := "never used"
			if !t.Used.IsZero() {
				used = "used " + t.Used.Local().Format("2006-01-02 15:04")
			}
			fmt.Printf("%s  %-12s  %-20s  made %s, %s\n", t.ID, t.Server, t.Label, t.Created.Local().Format("2006-01-02"), used)
		}
	case "add":
		af := flag.NewFlagSet("mthub token add", flag.ExitOnError)
		server := af.String("server", "", "the server's name, e.g. survival")
		release := af.Bool("release", false, "the release account's token (posts mod release cards as "+auth.ReleaseName+")")
		label := af.String("label", "", "what it's for (default: MT Hub)")
		af.Parse(fl.Args()[1:])
		if *release {
			if *label == "" {
				*label = "Mod releases"
			}
			tok, _, err := us.NewReleaseToken(*label)
			if err != nil {
				log.Fatal(err)
			}
			fmt.Println(tok)
			return
		}
		if *server == "" {
			usage()
		}
		if *label == "" {
			*label = "MT Hub"
		}
		tok, _, err := us.NewToken(*server, *label)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(tok)
	case "revoke":
		if fl.NArg() != 2 {
			usage()
		}
		if err := us.Revoke(fl.Arg(1)); err != nil {
			log.Fatal(err)
		}
		fmt.Println("revoked", fl.Arg(1))
	default:
		usage()
	}
}
