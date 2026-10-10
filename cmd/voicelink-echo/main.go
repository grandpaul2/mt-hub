// voicelink-echo is a test server for Voice Link: it joins the relay with its own token and
// plays every voice it hears straight back, so one player in Link hears themself a moment later
// through the whole path. Its Link "members" are an "Echo" of each player it hears.
//
//	voicelink-echo -url wss://macrotechmc.com/voicelink -token <token>
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

func main() {
	url := flag.String("url", "wss://macrotechmc.com/voicelink", "relay address")
	token := flag.String("token", "", "the echo server's token from the relay config")
	flag.Parse()
	for {
		err := run(*url, *token)
		log.Printf("disconnected: %v; retrying in 3 s", err)
		time.Sleep(3 * time.Second)
	}
}

func run(url, token string) error {
	ctx := context.Background()
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	log.Printf("connected to %s", url)
	for {
		_, b, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		if len(b) < 2 || b[0] == 3 {
			continue
		}
		n := int(b[1])
		if len(b) < 2+n {
			continue
		}
		from, body := string(b[2:2+n]), b[2+n:]
		switch b[0] {
		case 1: // audio: send it back as an echo speaker (first uuid byte flipped)
			if len(body) < 16 {
				continue
			}
			out := append([]byte{1}, body...)
			out[1] ^= 0xff
			if err := ws.Write(ctx, websocket.MessageBinary, out); err != nil {
				return err
			}
		case 2: // roster: mirror it as "Echo of <name>"
			var r struct {
				Members []struct{ UUID, Name string } `json:"members"`
			}
			if json.Unmarshal(body, &r) != nil {
				continue
			}
			for i := range r.Members {
				r.Members[i].Name = "Echo of " + r.Members[i].Name
			}
			log.Printf("%s Link: %d players", from, len(r.Members))
			type member struct {
				UUID string `json:"uuid"`
				Name string `json:"name"`
			}
			out := struct {
				Members []member `json:"members"`
			}{Members: []member{}}
			for _, m := range r.Members {
				out.Members = append(out.Members, member{m.UUID, m.Name})
			}
			j, _ := json.Marshal(out)
			if err := ws.Write(ctx, websocket.MessageBinary, append([]byte{2}, j...)); err != nil {
				return err
			}
		}
	}
}
