package voicebridge

// The bridge against a real relay (in this process) and a real LiveKit server (the binary the
// browser suites use, fetched/livekit-server). A stand-in game server speaks the relay's
// protocol; hub members are LiveKit's Go client. Frames are made-up bytes with an Opus first
// byte: nothing here decodes audio, and the point is that the bytes arrive unchanged.

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/grandpaul2/mt-hub/internal/voicelink"
)

const (
	lkKey      = "mthub"
	lkSecret   = "test-secret-that-is-long-enough-0123456789"
	tokGame    = "game-token-0123456789abcdef0123456789abcdef"
	tokHub     = "hub-token-0123456789abcdef0123456789abcdef0"
	steveUUID  = "8667ba71-b85a-4004-af54-457a9734eed7"
	steveIdent = "link:survival:Steve"
)

var lkURL string // "" when the LiveKit binary is not there: the tests say so and are skipped

func TestMain(m *testing.M) {
	bin, _ := filepath.Abs(filepath.Join("..", "..", "fetched", "livekit-server"))
	if _, err := os.Stat(bin); err != nil {
		fmt.Println("voicebridge: NOT TESTED: fetched/livekit-server is missing (make browser-test fetches it)")
		os.Exit(m.Run())
	}
	dir, _ := os.MkdirTemp("", "voicebridge-test-")
	port, tcp := freePort(), freePort()
	udp := 54000 + rand.Intn(400)
	conf := filepath.Join(dir, "livekit.yaml")
	os.WriteFile(conf, []byte(fmt.Sprintf("port: %d\nbind_addresses: [\"127.0.0.1\"]\nrtc:\n  tcp_port: %d\n  port_range_start: %d\n  port_range_end: %d\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  %s: %s\n", port, tcp, udp, udp+100, lkKey, lkSecret)), 0o600)
	cmd := exec.Command(bin, "--config", conf)
	if err := cmd.Start(); err != nil {
		fmt.Println("voicebridge: LiveKit did not start:", err)
		os.Exit(1)
	}
	for i := 0; i < 100; i++ {
		if r, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", port)); err == nil {
			r.Body.Close()
			lkURL = fmt.Sprintf("ws://127.0.0.1:%d", port)
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	code := 1
	if lkURL == "" {
		fmt.Println("voicebridge: LiveKit did not answer")
	} else {
		code = m.Run()
	}
	cmd.Process.Kill()
	cmd.Wait()
	os.RemoveAll(dir)
	os.Exit(code)
}

func freePort() int {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func eventually(t *testing.T, what string, within time.Duration, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(within); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out after %s waiting for %s", within, what)
}

// ---- a relay that can be stopped and started on one address ---------------------------------

type relay struct {
	addr  string
	srv   *http.Server
	mu    sync.Mutex
	conns []net.Conn
}

// kept remembers every connection, so stop can cut the open WebSockets too, as a relay
// that dies would. (http.Server.Close leaves those alone.)
type kept struct {
	net.Listener
	r *relay
}

func (k kept) Accept() (net.Conn, error) {
	c, err := k.Listener.Accept()
	if err == nil {
		k.r.mu.Lock()
		k.r.conns = append(k.r.conns, c)
		k.r.mu.Unlock()
	}
	return c, err
}

func (r *relay) start(t *testing.T) {
	t.Helper()
	l, err := net.Listen("tcp", r.addr)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/voicelink", voicelink.New(map[string]string{tokGame: "survival", tokHub: "hub"}))
	r.srv = &http.Server{Handler: mux}
	go r.srv.Serve(kept{l, r})
}

func (r *relay) stop() {
	r.srv.Close()
	r.mu.Lock()
	for _, c := range r.conns {
		c.Close()
	}
	r.conns = nil
	r.mu.Unlock()
}

func (r *relay) url() string { return "ws://" + r.addr + "/voicelink" }

// ---- the stand-in game server --------------------------------------------------------------

type game struct {
	t     *testing.T
	ws    *websocket.Conn
	mu    sync.Mutex
	audio map[string][][]byte // by speaker uuid (hex): frames as they came, nil for "stopped"
	at    map[string][]time.Time
	hub   []string          // the hub's roster as last told, names
	hubMC map[string]string // ...and their Minecraft names, by name
	told  int               // how many rosters the hub has sent
}

func joinGame(t *testing.T, url string) *game {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + tokGame}}})
	if err != nil {
		t.Fatal(err)
	}
	g := &game{t: t, ws: ws, audio: map[string][][]byte{}, at: map[string][]time.Time{}}
	t.Cleanup(func() { ws.CloseNow() })
	go func() {
		for {
			_, b, err := ws.Read(context.Background())
			if err != nil {
				return
			}
			if len(b) < 2 || b[0] == msgStatus {
				continue
			}
			n := int(b[1])
			from, body := string(b[2:2+n]), b[2+n:]
			g.mu.Lock()
			switch {
			case b[0] == msgAudio && from == "hub":
				id := hex.EncodeToString(body[:16])
				var f []byte
				if len(body) > 16 {
					f = append([]byte{}, body[16:]...)
				}
				g.audio[id] = append(g.audio[id], f)
				g.at[id] = append(g.at[id], time.Now())
			case b[0] == msgRoster && from == "hub":
				var r struct{ Members []struct{ Name, MC string } }
				json.Unmarshal(body, &r)
				g.hub = nil
				g.hubMC = map[string]string{}
				for _, m := range r.Members {
					g.hub = append(g.hub, m.Name)
					if m.MC != "" {
						g.hubMC[m.Name] = m.MC
					}
				}
				g.told++
			}
			g.mu.Unlock()
		}
	}()
	return g
}

func (g *game) send(b []byte) {
	if err := g.ws.Write(context.Background(), websocket.MessageBinary, b); err != nil {
		g.t.Fatal(err)
	}
}

// roster says who is in Link here: Steve, or nobody.
func (g *game) roster(steve bool) {
	members := "[]"
	if steve {
		members = `[{"uuid":"` + steveUUID + `","name":"Steve"}]`
	}
	g.send([]byte("\x02" + `{"members":` + members + `}`))
}

// say sends one of Steve's frames (nil: he stopped talking).
func (g *game) say(frame []byte) {
	raw, _ := hex.DecodeString(strings.ReplaceAll(steveUUID, "-", ""))
	g.send(append(append([]byte{msgAudio}, raw...), frame...))
}

// from is what the game has been sent from one hub member's microphone.
func (g *game) from(member string) (frames [][]byte, at []time.Time) {
	id := nameUUID("hub:" + member)
	g.mu.Lock()
	defer g.mu.Unlock()
	k := hex.EncodeToString(id[:])
	return slices.Clone(g.audio[k]), slices.Clone(g.at[k])
}

// hubMinecraftNames is the last hub roster's Minecraft names, by account.
func (g *game) hubMinecraftNames() map[string]string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return maps.Clone(g.hubMC)
}

func (g *game) hubRoster() (names []string, told int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.hub), g.told
}

// ---- a hub member ---------------------------------------------------------------------------

type heard struct {
	payload []byte
	ts      uint32
}

type member struct {
	room  *lksdk.Room
	track *lksdk.LocalTrack
	ts    uint32
	mu    sync.Mutex
	got   map[string][]heard // by participant identity, without the silence LiveKit's library sends
}

func joinMember(t *testing.T, room, name string, talks bool) *member {
	t.Helper()
	return joinMemberAs(t, room, name, "", talks)
}

// joinMemberAs joins with the Minecraft name the hub's token would carry ("" for none).
func joinMemberAs(t *testing.T, room, name, mc string, talks bool) *member {
	t.Helper()
	m := &member{got: map[string][]heard{}, ts: 1 << 31}
	cb := &lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{
		OnTrackSubscribed: func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
			who := rp.Identity()
			m.mu.Lock()
			if m.got[who] == nil {
				m.got[who] = []heard{}
			}
			m.mu.Unlock()
			go func() {
				for {
					pkt, _, err := track.ReadRTP()
					if err != nil {
						return
					}
					if silent(pkt.Payload) {
						continue
					}
					m.mu.Lock()
					m.got[who] = append(m.got[who], heard{append([]byte{}, pkt.Payload...), pkt.Timestamp})
					m.mu.Unlock()
				}
			}()
		},
	}}
	var err error
	info := lksdk.ConnectInfo{APIKey: lkKey, APISecret: lkSecret, RoomName: room, ParticipantIdentity: name, ParticipantName: name}
	if mc != "" {
		info.ParticipantAttributes = map[string]string{"mc": mc}
	}
	m.room, err = lksdk.ConnectToRoom(lkURL, info, cb)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.room.Disconnect)
	if talks {
		m.track, err = lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
		if err == nil {
			_, err = m.room.LocalParticipant.PublishTrack(m.track, &lksdk.TrackPublicationOptions{Name: "microphone", Source: livekit.TrackSource_MICROPHONE})
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	return m
}

// send writes one packet from this member's microphone; skip is how many frames of silence
// went by before it, as a browser's RTP timestamps would show.
func (m *member) send(payload []byte, skip int) {
	m.ts += uint32(1+skip) * frameTS
	m.track.WriteSample(media.Sample{Data: payload, Duration: frameDur, PacketTimestamp: m.ts}, nil)
}

func (m *member) heardFrom(identity string) ([]heard, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, ok := m.got[identity]
	return slices.Clone(h), ok
}

func (m *member) sees() []string {
	var ids []string
	for _, p := range m.room.GetRemoteParticipants() {
		ids = append(ids, p.Identity())
	}
	slices.Sort(ids)
	return ids
}

// ---- the tests ------------------------------------------------------------------------------

// speech is n made-up frames that look like Opus speech to anything that only reads the first
// byte: 40 to 120 bytes, different every frame.
func speech(seed int64, n int) [][]byte {
	r := rand.New(rand.NewSource(seed))
	out := make([][]byte, n)
	for i := range out {
		f := make([]byte, 40+r.Intn(80))
		r.Read(f)
		f[0] = 0x78
		out[i] = f
	}
	return out
}

func setup(t *testing.T) (*relay, *game, string) {
	t.Helper()
	if lkURL == "" {
		t.Skip("NOT TESTED: fetched/livekit-server is missing (make browser-test fetches it)")
	}
	r := &relay{addr: fmt.Sprintf("127.0.0.1:%d", freePort())}
	r.start(t)
	t.Cleanup(r.stop)
	room := "voice-link-" + strings.ReplaceAll(t.Name(), "/", "-")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	b := New(Config{Relay: r.url(), Token: tokHub, LiveKit: lkURL, Key: lkKey, Secret: lkSecret, Room: room}, t.Logf)
	go func() { b.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return r, joinGame(t, r.url()), room
}

func same(a, b [][]byte) string {
	if len(a) != len(b) {
		return fmt.Sprintf("%d frames arrived, %d were sent", len(a), len(b))
	}
	for i := range a {
		if !bytes.Equal(a[i], b[i]) {
			return fmt.Sprintf("frame %d differs", i)
		}
	}
	return ""
}

// A player's voice reaches a hub member, and a hub member's voice reaches the game, frame for
// frame and byte for byte; a pause keeps its length on the way to the hub; the game is told
// when a hub member stops.
func TestBothWaysUntouched(t *testing.T) {
	_, g, room := setup(t)
	alex := joinMember(t, room, "Alex", false)
	paul := joinMember(t, room, "Paul", true)
	g.roster(true)
	eventually(t, "Steve's track at Alex", 10*time.Second, func() bool { _, ok := alex.heardFrom(steveIdent); return ok })
	time.Sleep(300 * time.Millisecond)

	// Game to hub: 60 frames, 600 ms of nothing, 60 more.
	said := speech(1, 120)
	tick := time.NewTicker(frameDur)
	for i, f := range said {
		if i == 60 {
			g.say(nil)
			time.Sleep(600 * time.Millisecond)
		}
		<-tick.C
		g.say(f)
	}
	g.say(nil)
	eventually(t, "Steve's frames at Alex", 5*time.Second, func() bool { h, _ := alex.heardFrom(steveIdent); return len(h) >= len(said) })
	time.Sleep(200 * time.Millisecond)
	h, _ := alex.heardFrom(steveIdent)
	got := make([][]byte, len(h))
	for i := range h {
		got[i] = h[i].payload
	}
	if why := same(got, said); why != "" {
		t.Fatalf("game to hub: %s", why)
	}
	for i := 1; i < len(h); i++ {
		step := h[i].ts - h[i-1].ts
		if i == 60 {
			if step < 27*frameTS || step > 36*frameTS { // 600 ms and the tick it waited for: 30 to 32 frames
				t.Errorf("game to hub: the 600 ms pause came out as %d ms", step/48)
			}
		} else if step != frameTS {
			t.Errorf("game to hub: frame %d is %d samples after the one before, not %d", i, step, frameTS)
		}
	}

	// Hub to game: Paul says 100 frames.
	said = speech(2, 100)
	for _, f := range said {
		<-tick.C
		paul.send(f, 0)
	}
	ended := time.Now()
	eventually(t, "Paul's frames and his stop at the game", 5*time.Second, func() bool {
		f, _ := g.from("Paul")
		return len(f) > len(said)
	})
	f, at := g.from("Paul")
	if why := same(f[:len(said)], said); why != "" {
		t.Fatalf("hub to game: %s", why)
	}
	if len(f) != len(said)+1 || f[len(said)] != nil {
		t.Fatalf("hub to game: after the speech came %d messages, want one \"stopped talking\"", len(f)-len(said))
	}
	if late := at[len(said)].Sub(ended); late > 300*time.Millisecond {
		t.Errorf("hub to game: \"stopped talking\" came %s after the last frame", late)
	}
}

// What is not speech never reaches the game: a browser's one-byte "nothing to send", LiveKit's
// silence frame, and the lone frames a browser sends every 400 ms while its microphone is
// shut. The speech after them arrives whole, from its first frame.
func TestSilenceStaysOut(t *testing.T) {
	_, g, room := setup(t)
	paul := joinMember(t, room, "Paul", true)
	eventually(t, "the bridge hearing Paul", 10*time.Second, func() bool { names, _ := g.hubRoster(); return slices.Equal(names, []string{"Paul"}) })
	time.Sleep(500 * time.Millisecond)

	lone := speech(3, 5)
	for _, f := range lone {
		paul.send(f, 20) // 420 ms after the one before
		time.Sleep(420 * time.Millisecond)
	}
	for i := 0; i < 5; i++ {
		paul.send([]byte{0x78}, 0)
		time.Sleep(frameDur)
	}
	paul.send(append([]byte{0xf8, 0xff, 0xfe}, make([]byte, 40)...), 0)
	time.Sleep(200 * time.Millisecond)
	if f, _ := g.from("Paul"); len(f) != 0 {
		t.Fatalf("%d messages reached the game from silence alone", len(f))
	}

	said := speech(4, 40)
	tick := time.NewTicker(frameDur)
	for i, f := range said {
		<-tick.C
		skip := 0
		if i == 0 {
			skip = 10
		}
		paul.send(f, skip)
	}
	eventually(t, "the speech and its stop at the game", 5*time.Second, func() bool { f, _ := g.from("Paul"); return len(f) > len(said) })
	time.Sleep(300 * time.Millisecond)
	f, _ := g.from("Paul")
	if len(f) != len(said)+1 || f[len(said)] != nil {
		t.Fatalf("%d messages reached the game, want the %d frames of speech and one \"stopped talking\"", len(f), len(said))
	}
	if why := same(f[:len(said)], said); why != "" {
		t.Fatalf("the speech after silence: %s", why)
	}
}

// Who is where: a hub member joining or leaving is told to the game (and the bridge's own
// participants are not); a player in Link gets a participant in the room and loses it on
// leaving; the listener is not seen by members.
func TestRosters(t *testing.T) {
	_, g, room := setup(t)
	eventually(t, "the hub's first roster", 10*time.Second, func() bool { _, told := g.hubRoster(); return told >= 1 })
	if names, _ := g.hubRoster(); len(names) != 0 {
		t.Fatalf("nobody is in the room, the game was told %v", names)
	}
	paul := joinMember(t, room, "Paul", false)
	eventually(t, "Paul in the hub's roster", 10*time.Second, func() bool { names, _ := g.hubRoster(); return slices.Equal(names, []string{"Paul"}) })

	g.roster(true)
	eventually(t, "Steve in the room", 10*time.Second, func() bool { return slices.Equal(paul.sees(), []string{steveIdent}) })
	if names, _ := g.hubRoster(); !slices.Equal(names, []string{"Paul"}) {
		t.Errorf("a player's participant was told to the game as a hub member: %v", names)
	}
	g.roster(false)
	eventually(t, "Steve gone from the room", 10*time.Second, func() bool { return len(paul.sees()) == 0 })

	// A member whose account has a Minecraft name: it goes to the game with them; Paul has none.
	sam := joinMemberAs(t, room, "sam", "SamInGame", false)
	eventually(t, "sam in the hub's roster", 10*time.Second, func() bool { names, _ := g.hubRoster(); return slices.Equal(names, []string{"Paul", "sam"}) })
	if mc := g.hubMinecraftNames(); !maps.Equal(mc, map[string]string{"sam": "SamInGame"}) {
		t.Errorf("the roster's Minecraft names: %v", mc)
	}
	sam.room.Disconnect()

	paul.room.Disconnect()
	eventually(t, "Paul gone from the hub's roster", 10*time.Second, func() bool { names, _ := g.hubRoster(); return len(names) == 0 })
}

// The relay going away and coming back: the bridge joins it again by itself, tells the game
// who is in the room again, and the players come back when their server says so.
func TestRelayComesBack(t *testing.T) {
	r, g, room := setup(t)
	paul := joinMember(t, room, "Paul", false)
	g.roster(true)
	eventually(t, "Steve in the room", 10*time.Second, func() bool { return slices.Equal(paul.sees(), []string{steveIdent}) })

	r.stop()
	eventually(t, "Steve gone with the relay", 10*time.Second, func() bool { return len(paul.sees()) == 0 })
	r.start(t)
	g = joinGame(t, r.url())
	eventually(t, "the hub's roster after the relay came back", 15*time.Second, func() bool { names, _ := g.hubRoster(); return slices.Equal(names, []string{"Paul"}) })
	g.roster(true)
	eventually(t, "Steve back in the room", 10*time.Second, func() bool { return slices.Equal(paul.sees(), []string{steveIdent}) })
}
