// voicebridge joins one hub voice chat to Voice Link: people in the hub's #voice-link and
// players in the Simple Voice Chat group on our game servers hear each other. It passes Opus
// packets on untouched (internal/voicebridge; the spec is docs/voice/svc/hub-link-spec.md).
//
//	voicebridge [-config C]
//
// Config (JSON): {"relay": "wss://…/voicelink", "token": "<this bridge's token on the relay>",
// "livekit": "ws://127.0.0.1:7880", "key": "…", "secret": "…", "room": "voice-link"}
// (key and secret as in the hub's voice.json). It runs beside the relay and LiveKit, and
// keeps trying when either is down.
package main

import (
	"context"
	"flag"
	"log"
	"os/signal"
	"syscall"

	"github.com/grandpaul2/mt-hub/internal/voicebridge"
)

func main() {
	config := flag.String("config", "/etc/voicebridge.json", "config file")
	flag.Parse()
	conf, err := voicebridge.Load(*config)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Printf("voicebridge: room %q, relay %s", conf.Room, conf.Relay)
	voicebridge.New(conf, log.Printf).Run(ctx)
}
