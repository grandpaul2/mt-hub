// Package voicebridge joins one hub voice chat to Voice Link (docs/voice/svc/hub-link-spec.md).
//
// It is one more server on the voicelink relay, named by its token ("hub"), and several
// participants in one LiveKit room: a hidden listener that hears the hub members, and one
// participant for each player in the Link group on a game server. Voice goes both ways as the
// Opus packets it already is: nothing is decoded, mixed, re-encoded or changed in level.
//
//	game → hub   a frame from the relay is one RTP packet on that player's track
//	hub → game   a hub member's RTP payload is one frame to the relay
//
// The program is cmd/voicebridge.
package voicebridge

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	frameDur = 20 * time.Millisecond
	frameTS  = 960 // 20 ms at Opus's 48 kHz RTP clock

	// The relay's messages (internal/voicelink).
	msgAudio  = 1
	msgRoster = 2
	msgStatus = 3

	// ListenerIdentity is the bridge's own participant; PlayerPrefix starts a player's
	// ("link:<server>:<Minecraft name>"). Hub account names cannot contain ":", so neither
	// can be a member. The hub knows both (internal/server/voice.go).
	ListenerIdentity = "link:listener"
	PlayerPrefix     = "link:"

	// A talk spurt ends after this long without a speech frame.
	spurtEnd = 100 * time.Millisecond
	// The first frame after a pause waits this long for a second one (see toGame).
	holdFirst = 60 * time.Millisecond
	// The relay pings every 20 s; this long without anything from it and it is gone.
	relayDead = 60 * time.Second
)

// talkingLevel is what every frame from the game says about its loudness: -30 dBov (see toHub).
var talkingLevel uint8 = 30

// A Minecraft name: what a player's participant is called. Anything else in a roster is
// dropped (a game server's token sits on a rented host).
var mcName = regexp.MustCompile(`^[A-Za-z0-9_]{1,16}$`)

// Config is the bridge's JSON config file.
type Config struct {
	Relay   string `json:"relay"`   // the relay's address, wss://…/voicelink
	Token   string `json:"token"`   // this bridge's token there (its server name is the relay's to give)
	LiveKit string `json:"livekit"` // LiveKit's address, ws://…
	Key     string `json:"key"`     // LiveKit's key and secret, as in the hub's voice.json
	Secret  string `json:"secret"`
	Room    string `json:"room"` // the voice chat's room
}

// Load reads a config file.
func Load(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	if c.Relay == "" || c.Token == "" || c.LiveKit == "" || c.Key == "" || c.Secret == "" || c.Room == "" {
		return c, errors.New(path + ": relay, token, livekit, key, secret and room are all needed")
	}
	return c, nil
}

// Ours says whether a participant identity is one of the bridge's own.
func Ours(identity string) bool {
	return strings.HasPrefix(identity, PlayerPrefix)
}

// Bridge is one running bridge.
type Bridge struct {
	conf Config
	logf func(format string, a ...any)

	mu       sync.Mutex
	relay    *websocket.Conn // nil while not connected
	listener *lksdk.Room     // nil while not in the room
	wanted   map[string]want // by player uuid (hex): who the game servers say is in Link
	players  map[string]*player
	lastSent string // the hub roster last sent to the relay
}

type want struct {
	server, name string
}

// A player's participant in the room.
type player struct {
	want
	room  *lksdk.Room
	track *lksdk.LocalTrack
	ready bool
	ts    uint32    // the last frame's RTP timestamp
	last  time.Time // when it was written
	gap   bool      // "stopped talking" came since
}

// New makes a bridge; Run starts it. logf gets connects, joins and failures, never audio.
func New(conf Config, logf func(format string, a ...any)) *Bridge {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Bridge{conf: conf, logf: logf, wanted: map[string]want{}, players: map[string]*player{}}
}

// Run keeps the bridge connected to the relay and the room until ctx ends. Either side being
// down leaves the other working by itself; both are retried.
func (b *Bridge) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, f := range []func(context.Context){b.runRelay, b.runListener, b.runPlayers} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f(ctx)
		}()
	}
	wg.Wait()
	b.mu.Lock()
	for id, p := range b.players {
		if p.room != nil {
			p.room.Disconnect()
		}
		delete(b.players, id)
	}
	b.mu.Unlock()
}

// retry calls once until ctx ends, waiting 1 s after a failure and doubling to 30 s; a call
// that lasted a while starts the waits again.
func retry(ctx context.Context, once func(context.Context) error, failed func(error, time.Duration)) {
	wait := time.Second
	for ctx.Err() == nil {
		began := time.Now()
		err := once(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(began) > 30*time.Second {
			wait = time.Second
		}
		failed(err, wait)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, 30*time.Second)
	}
}

// ---- the relay ---------------------------------------------------------------------------

func (b *Bridge) runRelay(ctx context.Context) {
	retry(ctx, b.relayOnce, func(err error, wait time.Duration) {
		b.logf("relay: %v; again in %s", err, wait)
	})
}

func (b *Bridge) relayOnce(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var seen sync.Mutex
	last := time.Now()
	touch := func() {
		seen.Lock()
		last = time.Now()
		seen.Unlock()
	}
	dctx, dcancel := context.WithTimeout(ctx, 10*time.Second)
	ws, _, err := websocket.Dial(dctx, b.conf.Relay, &websocket.DialOptions{
		HTTPHeader:     http.Header{"Authorization": {"Bearer " + b.conf.Token}},
		OnPingReceived: func(context.Context, []byte) bool { touch(); return true },
	})
	dcancel()
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	ws.SetReadLimit(64 << 10)
	b.logf("relay: connected to %s", b.conf.Relay)
	b.mu.Lock()
	b.relay, b.lastSent = ws, ""
	b.mu.Unlock()
	defer func() {
		// Without the relay nobody in game is in the room.
		b.mu.Lock()
		b.relay = nil
		b.wanted = map[string]want{}
		b.mu.Unlock()
	}()
	b.sendRoster()
	// A relay that went away without closing (a host cut off hard) sends nothing, not even
	// its pings: that is noticed here, not by a failed read.
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				seen.Lock()
				quiet := time.Since(last)
				seen.Unlock()
				if quiet > relayDead {
					b.logf("relay: nothing for %s", quiet.Round(time.Second))
					ws.CloseNow()
					return
				}
			}
		}
	}()
	for {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		touch()
		if len(msg) < 2 {
			continue
		}
		if msg[0] == msgStatus {
			var st struct{ Servers []string }
			if json.Unmarshal(msg[1:], &st) == nil {
				b.serversNow(st.Servers)
			}
			continue
		}
		n := int(msg[1])
		if len(msg) < 2+n {
			continue
		}
		from, body := string(msg[2:2+n]), msg[2+n:]
		switch {
		case msg[0] == msgAudio && len(body) >= 16:
			b.toHub(hex.EncodeToString(body[:16]), body[16:])
		case msg[0] == msgRoster:
			var r struct {
				Members []struct{ UUID, Name string }
			}
			if json.Unmarshal(body, &r) != nil {
				continue
			}
			b.mu.Lock()
			for id, w := range b.wanted {
				if w.server == from {
					delete(b.wanted, id)
				}
			}
			for _, m := range r.Members {
				id := strings.ReplaceAll(strings.ToLower(m.UUID), "-", "")
				if raw, err := hex.DecodeString(id); err == nil && len(raw) == 16 && mcName.MatchString(m.Name) {
					b.wanted[id] = want{from, m.Name}
				}
			}
			b.mu.Unlock()
		}
	}
}

// serversNow drops the players of a server that is no longer connected to the relay.
func (b *Bridge) serversNow(servers []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, w := range b.wanted {
		there := false
		for _, s := range servers {
			there = there || s == w.server
		}
		if !there {
			delete(b.wanted, id)
		}
	}
}

func (b *Bridge) relaySend(msg []byte) {
	b.mu.Lock()
	ws := b.relay
	b.mu.Unlock()
	if ws == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ws.Write(ctx, websocket.MessageBinary, msg); err != nil {
		ws.CloseNow() // the read loop ends and the relay is dialled again
	}
}

// nameUUID is a stable uuid for a name: a hub member as a speaker on the game side.
func nameUUID(s string) (id [16]byte) {
	id = md5.Sum([]byte(s))
	id[6] = id[6]&0x0f | 0x30
	id[8] = id[8]&0x3f | 0x80
	return
}

func uuidText(id [16]byte) string {
	h := hex.EncodeToString(id[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// sendRoster tells the game side who is in the voice chat from the hub, when that changed
// (or the relay is newly connected): it is what makes the game's join and leave lines.
func (b *Bridge) sendRoster() {
	type member struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
		MC   string `json:"mc,omitempty"` // the account's Minecraft name, from the hub's token: the game shows them as that player
	}
	members := []member{}
	b.mu.Lock()
	if b.listener != nil {
		for _, p := range b.listener.GetRemoteParticipants() {
			if !Ours(p.Identity()) {
				members = append(members, member{uuidText(nameUUID("hub:" + p.Identity())), p.Identity(), p.Attributes()["mc"]})
			}
		}
	}
	sort.Slice(members, func(i, j int) bool { return members[i].Name < members[j].Name })
	j, _ := json.Marshal(map[string]any{"members": members})
	if string(j) == b.lastSent || b.relay == nil {
		b.mu.Unlock()
		return
	}
	b.lastSent = string(j)
	b.mu.Unlock()
	b.relaySend(append([]byte{msgRoster}, j...))
}

// ---- the room: the listener --------------------------------------------------------------

func (b *Bridge) token(identity, name string, hidden, publish bool) (string, error) {
	yes, no := true, false
	g := &auth.VideoGrant{RoomJoin: true, Room: b.conf.Room, Hidden: hidden, CanPublish: &no, CanSubscribe: &yes, CanPublishData: &no}
	if publish {
		g.CanPublish, g.CanSubscribe = &yes, &no
	}
	return auth.NewAccessToken(b.conf.Key, b.conf.Secret).SetIdentity(identity).SetName(name).SetVideoGrant(g).SetValidFor(time.Hour).ToJWT()
}

func (b *Bridge) runListener(ctx context.Context) {
	retry(ctx, b.listenOnce, func(err error, wait time.Duration) {
		b.logf("room: %v; again in %s", err, wait)
	})
}

func (b *Bridge) listenOnce(ctx context.Context) error {
	gone := make(chan struct{})
	var once sync.Once
	cb := &lksdk.RoomCallback{
		OnDisconnected: func() { once.Do(func() { close(gone) }) },
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed: func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
				if !Ours(rp.Identity()) && track.Kind() == webrtc.RTPCodecTypeAudio {
					go b.toGame(track, rp.Identity())
				}
			},
		},
		OnParticipantConnected:    func(*lksdk.RemoteParticipant) { b.sendRoster() },
		OnParticipantDisconnected: func(*lksdk.RemoteParticipant) { b.sendRoster() },
	}
	tok, err := b.token(ListenerIdentity, ListenerIdentity, true, false)
	if err != nil {
		return err
	}
	room, err := lksdk.ConnectToRoomWithToken(b.conf.LiveKit, tok, cb)
	if err != nil {
		return err
	}
	b.logf("room: listening in %q", b.conf.Room)
	b.mu.Lock()
	b.listener = room
	b.mu.Unlock()
	b.sendRoster()
	select {
	case <-ctx.Done():
	case <-gone:
	}
	b.mu.Lock()
	b.listener = nil
	b.mu.Unlock()
	room.Disconnect()
	b.sendRoster()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return errors.New("disconnected")
}

// toGame passes one hub member's microphone packets to the relay as a speaker.
//
// Not passed: packets that carry no speech. Those are a browser's "nothing to send" (DTX, one
// or two bytes); the Opus silence frame LiveKit's libraries put on an idle track (f8 ff fe,
// sometimes padded with zeros); and the lone frame of encoded silence a browser with DTX on
// sends about every 400 ms while its microphone is shut, which cannot be told from speech by
// its bytes. For that last kind the first frame after a pause is held until the next one
// follows it; speech does within a frame or two, and both go out. Nothing after the first
// frame of a talk spurt is delayed.
//
// After spurtEnd without speech the game is told the speaker stopped (an empty frame), which
// it needs to end the sound cleanly.
func (b *Bridge) toGame(track *webrtc.TrackRemote, identity string) {
	red := strings.EqualFold(track.Codec().MimeType, "audio/red")
	id := nameUUID("hub:" + identity)
	type frame struct {
		p  []byte
		ts uint32
	}
	frames := make(chan frame, 256)
	go func() {
		defer close(frames)
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			p := pkt.Payload
			if red {
				p = redPrimary(p)
			}
			if !silent(p) {
				frames <- frame{append([]byte(nil), p...), pkt.Timestamp}
			}
		}
	}()
	audio := func(p []byte) {
		msg := make([]byte, 0, 17+len(p))
		msg = append(append(append(msg, msgAudio), id[:]...), p...)
		b.relaySend(msg)
	}
	talking, last, lastTS := false, time.Time{}, uint32(0)
	var held *frame
	var heldAt time.Time
	send := func(f frame) {
		audio(f.p)
		talking, last, lastTS = true, time.Now(), f.ts
	}
	stop := func() {
		if talking {
			audio(nil)
			talking = false
		}
	}
	tick := time.NewTicker(frameDur)
	defer tick.Stop()
	for {
		select {
		case f, ok := <-frames:
			if !ok {
				stop()
				return
			}
			switch {
			case talking && f.ts-lastTS <= 5*frameTS:
				send(f)
			case held != nil && f.ts-held.ts <= 3*frameTS:
				h := *held
				held = nil
				send(h)
				send(f)
			default:
				stop()
				g := f
				held, heldAt = &g, time.Now()
			}
		case <-tick.C:
			if held != nil && time.Since(heldAt) > holdFirst {
				held = nil
			}
			if talking && time.Since(last) > spurtEnd {
				stop()
			}
		}
	}
}

// silent says a packet carries no speech by its bytes alone (see toGame).
func silent(p []byte) bool {
	if len(p) <= 2 {
		return true
	}
	if p[0] != 0xf8 || p[1] != 0xff || p[2] != 0xfe {
		return false
	}
	for _, x := range p[3:] {
		if x != 0 {
			return false
		}
	}
	return true
}

// redPrimary takes the newest Opus frame out of an RFC 2198 packet (audio/red), unchanged.
// LiveKit gives a subscriber that does not offer RED plain Opus, so this is for the day it
// does not.
func redPrimary(p []byte) []byte {
	skip, i := 0, 0
	for i < len(p) && p[i]&0x80 != 0 {
		if i+4 > len(p) {
			return nil
		}
		skip += int(p[i+2]&0x03)<<8 | int(p[i+3])
		i += 4
	}
	i++ // the last header is one byte
	if i+skip > len(p) {
		return nil
	}
	return p[i+skip:]
}

// ---- the room: the players ---------------------------------------------------------------

// runPlayers makes the room match the game servers' rosters: a participant for each player
// in Link, none for anyone else. It tries again by itself when LiveKit refuses.
func (b *Bridge) runPlayers(ctx context.Context) {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	retryAt := map[string]time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		b.mu.Lock()
		var leave []*player
		for id, p := range b.players {
			if w, ok := b.wanted[id]; !ok || w != p.want {
				leave = append(leave, p)
				delete(b.players, id)
			}
		}
		var join []string
		for id := range b.wanted {
			if b.players[id] == nil && time.Now().After(retryAt[id]) {
				join = append(join, id)
				b.players[id] = &player{want: b.wanted[id]}
			}
		}
		b.mu.Unlock()
		for _, p := range leave {
			if p.room != nil {
				p.room.Disconnect()
				b.logf("room: %s (%s) left", p.name, p.server)
			}
		}
		for _, id := range join {
			go func() {
				if err := b.joinPlayer(id); err != nil {
					b.mu.Lock()
					p := b.players[id]
					delete(b.players, id)
					retryAt[id] = time.Now().Add(5 * time.Second)
					b.mu.Unlock()
					if p != nil {
						b.logf("room: %s (%s) could not join: %v", p.name, p.server, err)
					}
				}
			}()
		}
	}
}

func (b *Bridge) joinPlayer(id string) error {
	b.mu.Lock()
	p := b.players[id]
	b.mu.Unlock()
	if p == nil {
		return nil
	}
	tok, err := b.token(PlayerPrefix+p.server+":"+p.name, p.name, false, true)
	if err != nil {
		return err
	}
	gone := func() {
		// LiveKit dropped this participant: forget it, and the next pass joins it again.
		b.mu.Lock()
		if b.players[id] == p {
			delete(b.players, id)
		}
		b.mu.Unlock()
	}
	room, err := lksdk.ConnectToRoomWithToken(b.conf.LiveKit, tok, &lksdk.RoomCallback{OnDisconnected: gone}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return err
	}
	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
	if err == nil {
		_, err = room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "microphone", Source: livekit.TrackSource_MICROPHONE})
	}
	if err != nil {
		room.Disconnect()
		return err
	}
	b.mu.Lock()
	if b.players[id] != p { // left, or changed server, while joining
		b.mu.Unlock()
		room.Disconnect()
		return nil
	}
	p.room, p.track, p.ready = room, track, true
	b.mu.Unlock()
	b.logf("room: %s (%s) joined", p.name, p.server)
	return nil
}

// toHub writes one frame from the game, as it is, to its speaker's track. RTP timestamps
// count frames; after a pause they jump by the time that passed, in whole frames, so a
// listener's player takes the pause for a pause and not for a slow network.
func (b *Bridge) toHub(id string, opus []byte) {
	b.mu.Lock()
	p := b.players[id]
	if p == nil || !p.ready {
		b.mu.Unlock() // still joining: the first fraction of a second after they join Link
		return
	}
	if len(opus) == 0 {
		p.gap = true
		b.mu.Unlock()
		return
	}
	now := time.Now()
	switch {
	case p.last.IsZero():
		p.ts = uint32(rand.Intn(1<<30)) + 1<<31
	case p.gap || now.Sub(p.last) > spurtEnd:
		p.ts += frameTS * max(1, uint32(now.Sub(p.last)/frameDur))
	default:
		p.ts += frameTS
	}
	p.gap, p.last = false, now
	ts, track := p.ts, p.track
	b.mu.Unlock()
	// The level is the RTP header's "how loud" note, which is how LiveKit knows who is talking
	// (it never decodes either). The bridge cannot know the real level without decoding, so
	// every frame of speech says the same moderate one: a player's name lights up while they
	// talk. It is not part of the sound.
	_ = track.WriteSample(media.Sample{Data: opus, Duration: frameDur, PacketTimestamp: ts}, &lksdk.SampleWriteOptions{AudioLevel: &talkingLevel})
}
