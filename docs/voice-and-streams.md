# Voice chats and screen sharing

## Voice chats

Started from VOICE's "+" (New Voice Chat, New Private Voice Chat…); no
permanent rooms. VOICE is always in the sidebar, empty while there's no voice chat. A
voice chat is shown as its people in join order and ends when the last one leaves. A private
one is seen only by the people invited, not even admins. At most 3 at once. The design is
[`voice/rooms-design.md`](voice/rooms-design.md); the microphone chain is
[`voice/svc-mic.md`](voice/svc-mic.md).

**#voice-link** is the one exception ([`voice/svc/hub-link-spec.md`](voice/svc/hub-link-spec.md)):
a voice chat with a name, always listed first, that never ends and is not one of the 3. It is
the same room as the Simple Voice Chat group on the game servers. It is there when
`voice.json` has `"link_voice": true`, which is for a hub that runs `cmd/voicebridge` beside
LiveKit and the voicelink relay. The bridge is in the LiveKit room as `link:listener` and as
`link:<server>:<Minecraft name>` for each player in the group; the hub lists those as players
with their server's tag, shows "Not connected to the game servers" while the listener is not
there, and never treats them as accounts.

- **Audio:** a LiveKit server (the hub is tested against 1.13.7), reached through the same
  reverse proxy:
  `/rtc` for browsers and `/twirp` for the hub's API calls.
- **The hub** (`internal/server/voice.go`) keeps the list (`<data>/voice-chats.json`, so a
  restart doesn't lose it), decides who sees and joins what, and signs LiveKit tokens. LiveKit's
  webhooks (`POST /api/voice/webhook`, signed with the shared secret, no login) say who joined
  and left; every 20 seconds the hub also asks LiveKit, in case one went missing.
- **`<data>/voice.json`** holds LiveKit's addresses, key and secret (the same as in LiveKit's
  own config). Without it voice chats are off; edits take effect without a restart.
- **In the page** (`voice.ts`): the game's microphone chain ([`voice/svc-mic.md`](voice/svc-mic.md)):
  the raw microphone → `svcmic.ts` in an audio worklet (Simple Voice Chat's RNNoise, gain and
  activation, then the keyboard noise gate, from `svc-mic.wasm`, built in `native/svc-mic/`)
  → LiveKit. Voice Settings are Simple Voice Chat's, per browser.
- **Tests:** `test/unit/svcmic/` (the chain against Simple Voice Chat's natives and the game's
  gate, in Node, by `make check`), `TestVoice` (rules, privacy, webhooks, restart) and the
  `voice` browser suite,
  which runs a local LiveKit (`fetched/livekit-server`, downloaded on first run; see
  [`testing.md`](testing.md)) with two
  people in two browser profiles. `FAKE_AUDIO=<speech.wav>` also checks the speaking light.

## Screen sharing

Video only, Discord style (design: [`stream/screen-share-spec.md`](stream/screen-share-spec.md)).
LIVE's "+" asks the browser for a window or screen; while someone
shares, LIVE (always in the sidebar) has a row for them and anyone clicks to watch in the
main panel (`#live=<name>`, silent, Full screen). It ends on Stop, when the shared window
closes, when the page closes or reloads, or when the connection drops. At most 3 at once;
1080p at 30 fps, 5 Mbit/s, VP8 (720p looked too soft). An admin can stop someone's
(right-click, admin log `stream-stop`). Phones watch from a strip at the top of the chat.

- **Same LiveKit as voice** (`voice.json`): each stream is its own room `s…`; the streamer's
  token may publish only a screen share, viewers' only watch (identity `name~<tab>`, so you
  can watch in two tabs, or your own stream). LiveKit needs no extra setup for it.
- **`internal/server/stream.go`** keeps the list (`<data>/streams.json`), listed once the
  picture arrives. LiveKit sends every room's webhooks to `/api/voice/webhook`; rooms starting
  with `s` go to the streams, so watching never takes anyone out of a voice chat. Every 20
  seconds the hub asks LiveKit too (ends one whose streamer left, or that never showed a
  picture within a minute; removes banned people). Closing a room needs LiveKit's
  `roomCreate` permission on the hub's API token (`twirp`).
- **In the page:** `stream.ts`; the capture is marked `contentHint = 'motion'` (without it
  browsers drop to a few frames a second to keep text sharp).
- **Tests:** `TestStreams`, `TestStreamCheck`, and the `stream` browser suite (Chromium's fake
  screen capture, two profiles, a phone).

## Relay streams

A stream someone sends with OBS to a MediaMTX relay, the kind a video screen in the game
plays, watched in the hub with sound (design and measurements:
[`stream/relay-streams-spec.md`](stream/relay-streams-spec.md)). While one is live it has a row
in LIVE with its own icon; clicking it plays it in the main panel (`#stream=<name>`) with a
mute button and a volume bar. Screen shares and relay streams sit side by side.

Either kind keeps playing when the viewer opens something else, until Stop watching (a bar in
the sidebar while it does), and a dropped connection reconnects by itself; the two specs say
how.

- **`<data>/relay.json`** turns it on: `{"url": "https://…/relay", "user": "hub", "pass": "…",
  "channels": {"<relay channel>": "<hub account>"}, "delay_ms": 700}`. `url` is where the
  relay's WHEP is (`<url>/<channel>-web/whep`); its API is taken to be `<url>/api` unless
  `"api"` says otherwise. Read again when the file changes; without it there are no relay
  streams and nothing in the page changes.
- **What the relay has to do** (MediaMTX): republish each channel as `<channel>-web` with Opus
  sound (browsers take no AAC over WebRTC; an ffmpeg started by `runOnAvailable` that copies
  the picture), serve WebRTC, answer its API, and let only the hub's account read the `-web`
  channels and the API.
- **`internal/server/relay.go`:** every 5 seconds the hub asks the relay which `-web`
  channels are ready and which WebRTC sessions read them. A viewer's offer goes to
  `POST /api/relay/<name>/watch`; the hub posts it to the relay with its account (so watching
  needs a hub login) and tags the session, which is how viewers get their names. The picture
  and sound go from the relay to the browser directly.
- **In step with the game:** the page sets `jitterBufferTarget = relayDelay` on both
  receivers. The game's player shows a frame about 0.7 s after WebRTC would; held back by
  that, the hub and a screen in the game are within a few hundredths of a second.
- **B-frames:** MediaMTX will not send H.264 with B-frames over WebRTC. The streamer sets
  `bframes=0` in OBS's x264 options; without it the row shows but the viewer is told the
  stream can't be shown and why.
- **Sound** plays on the speaker chosen in Voice Settings where the browser can choose one. A
  browser that refuses sound without a click (the address opened directly) plays muted with a
  **Turn sound on** button.
- **Tests:** `TestRelay` (a stub relay) and the `relay` browser suite (a local MediaMTX, ffmpeg
  as the streamer, a stream with B-frames, a phone).
