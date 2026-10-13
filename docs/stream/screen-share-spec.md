# Hub screen sharing: design

**Status:** current spec, built. How the hub runs it: [`../voice-and-streams.md`](../voice-and-streams.md).

Anyone signed in can share a window or screen from the hub, and anyone signed in can watch.
**Video only**: there is no sound to balance, and nothing to set up for a viewer. It is
hub-only work on the parts voice chats already use, works on every operating system, and
cannot break with a Minecraft update.

## What it does

- A person shares a window or screen. The browser asks which one, every time (a browser rule).
- While they share, a LIVE section appears in the sidebar for everyone, with one row per
  person sharing. Clicking a row plays the stream in the main panel (address `#live=<name>`).
  Watching is silent.
- It ends when the streamer clicks Stop, closes the shared window (the browser ends the capture
  itself), closes or reloads the hub, or loses their connection.
- Watching and voice are independent: you can be in a voice chat and watch a stream.

## How it works

```
Streamer's browser                  LiveKit (SFU, forwards,           Viewers' browsers
getDisplayMedia (window/screen) ──► no transcoding), room "s…"  ──►   <video> in the main panel
 → LiveKit screen-share track              │ webhooks                  (subscribe only)
                                           ▼
                        Hub: the list of streams, tokens, live updates to every page
```

The same pieces as voice chats: the hub keeps the list and signs LiveKit tokens; LiveKit
carries the media; LiveKit's webhooks plus a 20-second check keep the list honest. It uses the
same `<data>/voice.json` (LiveKit's address, API address, key and secret). Without that file
screen sharing is off, like voice. The page already talks to LiveKit for voice, so the Content
Security Policy needs nothing new.

## The hub (`internal/server/stream.go`)

- **A stream** is `{id: "s"+12 hex, name (the streamer), started, viewers: [names]}`, kept in
  `<data>/streams.json` so a restart does not lose streams in progress. A stream is listed
  once its picture has arrived.
- **Rules:** one stream per person (starting another, in a second tab or after a reload,
  replaces it); at most **3 at once** (`maxStreams`). Banned or deleted accounts are removed by
  the 20-second check.
- **Routes** (all need a login):
  - `GET /api/streams`: `{enabled, max, full, streams: [{id, name, started, viewers}]}`.
  - `POST /api/streams`: start your stream. Returns `{id, url, token}`.
  - `POST /api/streams/{id}/watch`: returns `{id, url, token}` for watching.
  - `POST /api/streams/{id}/stop`: the streamer ends it now. An admin who outranks the streamer
    can stop it too (admin log: `stream-stop`).
- **Tokens** (HS256 with the LiveKit secret, valid one hour; LiveKit renews while connected):
  - Streamer: identity = account name; may publish only a screen share
    (`canPublishSources: ["screen_share"]`), cannot subscribe, no data.
  - Viewer: identity = `name~` + 6 random hex (one person can watch in two tabs, or watch their
    own stream); subscribe only.
- **Webhook dispatch:** LiveKit has one webhook address for every room, `/api/voice/webhook`.
  The handler dispatches by room name: rooms starting `v` are voice chats, rooms starting `s`
  are streams. Without this, starting or watching a stream would take the person out of their
  voice chat. A Go test pins it.
- **From LiveKit's events:** `participant_joined` and `participant_left` keep the viewer list
  (identity cut at `~`). `track_published` with source `SCREEN_SHARE` from the streamer marks the
  stream live. `track_unpublished`, the streamer leaving, or `room_finished` ends it.
- **The 20-second check** (`streamCheck`) asks LiveKit who is in each stream room. It ends a
  stream whose streamer is gone, and one started but never published within a minute, and fixes
  the viewer list. Closing a room needs the `roomCreate` permission on the hub's API token.
- **Live updates:** `bus.publish("stream", ...)`; pages re-fetch `GET /api/streams`.

## The page (`web/src/stream.ts`)

LiveKit's client is lazy-loaded (`loadBundle('livekit')`), so the page is no heavier for
people who never share or watch.

### Starting

- CHATS' "+" menu and LIVE's own "+" have **Share Your Screen…**. It is greyed out with a
  tooltip when 3 streams are running, and hidden in browsers without `getDisplayMedia`
  (phones).
- The click calls `navigator.mediaDevices.getDisplayMedia` first, straight from the click
  (browsers refuse otherwise), then `POST /api/streams`, then wraps the track in LiveKit's
  `LocalVideoTrack`, connects and publishes. Cancelling the picker does nothing and says
  nothing.
- Capture request: `{ video: { frameRate: 30, width: { max: 1920 }, height: { max: 1080 } },
  audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' }`, so the hub tab
  is not offered and Chrome's "share this instead" works.
- **`track.contentHint = 'motion'`** before publishing. Without it browsers treat screen shares
  as documents and keep text sharp by dropping to a few frames a second.
- **Publish:** `source: ScreenShare`, `videoCodec: 'vp8'` (every browser encodes it),
  `simulcast: false`, `screenShareEncoding: { maxBitrate: 5_000_000, maxFramerate: 30 }`
  (1080p at 30 fps; 720p looked too soft), `degradationPreference: 'maintain-framerate'`.
- The streamer's room: `Room({ disconnectOnPageLeave: true, adaptiveStream: false,
  dynacast: false })`. The browser ending the capture fires the track's `ended`: the page stops
  the stream.

### The streamer's bar

The sidebar foot has a bar like the voice bar (stacked above it if both are on): **Sharing
your screen**, then "Nobody watching yet" or "2 watching" (hover for names), and a **Stop**
button. Losing the connection toasts "Screen sharing stopped: the connection dropped."

### The sidebar

FILES and CHATS are always there. **VOICE** appears only while a voice chat you can see
exists, and **LIVE** only while anyone is sharing; both sit under CHATS. A LIVE row is a
screen icon and the streamer's name; your own row reads "You're sharing your screen", and
clicking it watches it. Right-click a row: Watch; Stop Watching (on the one you are
watching); Message; Stop Stream for an admin who
outranks the streamer. Sections appear and go with the `voice` and `stream` events, without
animation.

### Watching

- The main panel (`setMode('live')`, address `#live=<name>`) has a head with the name and the
  viewer count, and a `<video autoplay playsinline muted>` filling it, letterboxed. Buttons:
  **Full screen** (double-click does the same) and **Stop watching**.
- The viewer's room is `Room({ adaptiveStream: false, dynacast: false })`. adaptiveStream
  would stop the picture whenever the page cannot see the video, and the page cannot see
  Firefox's pop-out player. With one layer a viewer on a weak link may freeze.
- States in plain words: "Connecting…", "Waiting for the picture…", "<name> stopped sharing."
  (with a Back button), "Couldn't connect: …", and for an address whose person is not live,
  "<name> isn't sharing their screen right now."
- **Watching goes on behind everything** (2026-10-13), as for relay streams
  ([`relay-streams-spec.md`](relay-streams-spec.md) → The page): opening something else
  leaves the picture coming, for the browser's pop-out player, with the "Watching" bar in the
  sidebar; Stop watching, the screen share ending or another stream ends it. A viewer behind
  a chat still counts and still takes the full picture.
- "Reconnecting…" while LiveKit reconnects by itself; if it gives up and the screen is still
  shared, the page joins again (after 1, 2 and 4 seconds, then every 5).
- **Full screen** has the bar relay streams have, without the sound: **Exit full screen**.
- Phones watch from a strip at the top of the chat.

Words (style guide, Words): "Share Your Screen…", "Sharing your screen", "Stop", "Watch", "Stop
watching", "Full screen", "2 watching". No "stream key", "track" or "publish".

## Limits and costs

- **Bandwidth through the LiveKit server:** up to 5 Mbit/s per viewer, about 2.25 GB per
  viewer-hour. Three streams with five viewers each is up to 75 Mbit/s out.
- **LiveKit's ports:** it needs its UDP media range and TCP port open; the range bounds how many
  people can be connected at once (voice and watching together).
- **CPU:** the server only forwards. The streamer's browser does the encoding: Chrome usually
  in hardware, Firefox's VP8 in software; 1080p30 may take one or two cores.
- **Sound:** none, by design. Chrome and Edge on Windows and Mac could add it with a small
  change (`audio: true` with `systemAudio` / `windowAudio`); Firefox and Linux cannot.
- Firefox shows its own sharing indicator; no page can hide it
  (`privacy.webrtc.hideGlobalIndicator` in `about:config`, per browser).

## Tests

- **Go:** `TestStreams` (start, replace, stop, the limit, one per person, token grants,
  webhook dispatch so a stream join does not touch voice chats, viewer lists, the streamer
  leaving, a stream that never published, a banned streamer, restart, admin stop and its rank
  rule) and `TestStreamCheck`.
- **Browser (`test/browser/stream.mjs`):** a local LiveKit and two browser profiles, Chromium's
  fake screen capture for the streamer; the viewer sees the row, opens `#live=`, gets frames;
  Stop, an admin stopping someone, a reload, and a phone watching.

## Later

- A second, small simulcast layer (about 360p) so weak phone connections get a smaller picture
  instead of freezes. It costs the streamer more encoding.
- Sound for Chrome and Edge streamers on Windows and Mac.
- A thumbnail on the row on hover.
