// voicelink is the Voice Link relay (internal/voicelink): it joins the Simple Voice Chat "Link"
// groups of our game servers, passing their voice packets on untouched.
//
//	voicelink [-addr A] [-config C]
//
// Config (JSON): {"tokens": {"<token>": "survival", "<token>": "creative"}}
// The spec is docs/voice/svc/link-spec.md.
package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/grandpaul2/mt-hub/internal/voicelink"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7890", "listen address")
	config := flag.String("config", "/etc/voicelink.json", "config file")
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.Lmicroseconds) // the journal lines up with the servers' logs (they print milliseconds)

	tokens, err := voicelink.LoadTokens(*config)
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/voicelink", voicelink.New(tokens))
	log.Printf("voicelink on %s, %d servers", *addr, len(tokens))
	log.Fatal(http.ListenAndServe(*addr, mux))
}
