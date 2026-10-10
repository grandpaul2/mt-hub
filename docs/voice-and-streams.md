# Voice chats and screen sharing

## Voice chats

Started from CHATS' "+" (New Voice Chat, New Private Voice Chat…; also VOICE's own "+"); no
permanent rooms. VOICE appears in the sidebar only while there's a voice chat. A
voice chat is shown as its people in join order and ends when the last one leaves. A private
one is seen only by the people invited, not even admins. At most 3 at once. The design is
[`voice/rooms-design.md`](voice/rooms-design.md), with the research and the voice lab's
results beside it.

- **Audio:** a LiveKit server (the hub is tested against 1.13.7), reached through the same
  reverse proxy:
  `/rtc` for browsers and `/twirp` for the hub's API calls.
- **The hub** (`internal/server/voice.go`) keeps the list (`<data>/voice-chats.json`, so a
  restart doesn't lose it), decides who sees and joins what, and signs LiveKit tokens. LiveKit's
  webhooks (`POST /api/voice/webhook`, signed with the shared secret, no login) say who joined
  and left; every 20 seconds the hub also asks LiveKit, in case one went missing.
- **`<data>/voice.json`** holds LiveKit's addresses, key and secret (the same as in LiveKit's
  own config). Without it voice chats are off; edits take effect without a restart.
- **In the page** (`voice.ts`): mic with no browser processing (Firefox's echo cancelling chops
  up voices on headphones) → level → DeepFilterNet3 (or RNNoise, or off) → 150 ms hold-back →
  the Silero speech gate (`vad.worker.ts`) → LiveKit. Settings are per browser.
- **Tests:** `TestVoice` (rules, privacy, webhooks, restart) and the `voice` browser suite,
  which runs a local LiveKit (`fetched/livekit-server`, downloaded on first run; see
  [`testing.md`](testing.md)) with two
  people in two browser profiles. `FAKE_AUDIO=<speech.wav>` also checks the speaking light.

## Screen sharing

Video only, Discord style (design: [`stream/screen-share-spec.md`](stream/screen-share-spec.md)).
Share Your Screen… (CHATS' or LIVE's "+") asks the browser for a window or screen; while someone
shares, LIVE appears in the sidebar and anyone clicks to watch in the
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

## The voice lab

`voicelab.ts` + `voicelab.html` are the voice lab at `/voice-lab/`, a test page that records
the microphone through several noise filters at once to choose one for voice rooms by ear. Its
filter files are served by the hub. DeepFilterNet3's two files (a wasm build and the model)
are not on npm, so `build.mjs` downloads them once, on the first build, from
`cdn.mezon.ai` (the model is identical to the one in the upstream
[DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) repository) into `fetched/dfn3/`
(not in git), and checks them against pinned SHA-256 hashes. The download gives up after two
minutes and says which file and host it was waiting for.
