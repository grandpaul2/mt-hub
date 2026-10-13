# Relay streams in the hub: design

**Status:** current spec, built. How the hub runs it: [`../voice-and-streams.md`](../voice-and-streams.md).

A stream that someone sends to the stream relay with OBS, the kind that plays on a video
screen in the game, can also be watched in the hub: with sound, and in step with the game's
screens to well within a second.
Nothing changes in the game or the mod. The streamer changes one OBS setting, once.

This is separate from screen sharing ([`screen-share-spec.md`](screen-share-spec.md)), which
goes browser to browser through LiveKit and has no sound. The two sit side by side in LIVE.

## Decisions (Paul, 2026-10-11)

- Relay streams are rows in the existing **LIVE** section and play in the same main panel.
- Watching needs a hub login, like everything else.
- The rows carry the streamer's hub name; the hub keeps the list of which relay channel
  belongs to whom.
- **What matters is that the hub and the game's screens show the same moment, within a
  second.** How far both are behind the streamer does not matter. HLS (3 to 6 seconds, and
  drifting) cannot do that, so delivery is WebRTC, held back to match the game.
- Streams have sound. The relay converts the audio; the picture is passed on untouched.
- Each streamer adds one line to their OBS encoder settings.

## How it works

```
OBS ──RTMP (H.264 + AAC)──► relay: channel "live" ──► the game's video screens (as today)
                                   │ while live, ffmpeg copies the picture and
                                   ▼ converts the sound to Opus
                            channel "live-web" ──WebRTC──► <video> in the hub's main panel
                                   ▲                              │
                 who is live, who is watching (every 5 s)         │ offer / answer
                                   │                              ▼
                                  Hub: the list, the login check, passes the offer on
```

- **The relay** is MediaMTX. A browser cannot take AAC sound over WebRTC, so for every
  channel that goes live MediaMTX starts an ffmpeg that republishes it as `<channel>-web`:
  video copied bit for bit, audio re-encoded to Opus (128 kbit/s stereo). It stops when the
  channel stops. Audio-only conversion costs a few percent of one core.
- **WebRTC out of MediaMTX** uses WHEP: the viewer's browser sends an offer, gets an answer,
  and the media then flows from the relay to the browser directly, over one UDP port (and the
  same TCP port for networks that block UDP).
- **In step with the game.** WebRTC arrives sooner than the game's player shows the same
  frame (measured: about 0.7 s sooner). The page asks the browser to hold the stream back by
  `delay_ms` (`RTCRtpReceiver.jitterBufferTarget`, picture and sound alike). Measured with
  700: Chrome and Firefox within 0.06 s of the game.
- **The hub never carries the media.** It passes the offer and answer on, which is how it
  enforces the login and knows who is watching.

## The relay

- MediaMTX: WebRTC on, listening on localhost for WHEP, one public UDP + TCP port for media,
  its public address announced; the API on, on localhost; RTSP on, on localhost only (ffmpeg
  reads and writes there, since RTMP cannot carry Opus).
- Each streamer's channel gets `runOnReady` (the ffmpeg above, restarted if it dies).
- **Accounts:** the open "anyone may read" rule is narrowed to the original channels, so the
  game's screens work as before. The `-web` channels and the API are readable only by a new
  `hub` account. A local-only account publishes the `-web` channels.
- The web server in front of the hub sends `/relay/*` to MediaMTX (WHEP and API). MediaMTX
  checks the `hub` account on every request; nothing under `/relay/` answers without it.
- The exact config and commands are in our private relay runbook, not here.

## The hub (`internal/server/relay.go`)

- **`<data>/relay.json`**: `{"url": "https://…/relay", "user": "hub", "pass": "…",
  "channels": {"live": "grandpaul", "emptropy": "emptropy"}, "delay_ms": 700}`. Without the file the feature is
  off and nothing in the page changes. Adding a streamer is a line here and a channel on the
  relay.
- **Every 5 seconds** the hub asks the relay which `-web` channels are ready and which WebRTC
  sessions are reading them, and publishes `stream` on the bus when the list changes. A relay
  it cannot reach means no relay streams listed, and one line in the log per outage.
- **Routes** (all need a login):
  - `GET /api/streams` gains `relay: [{name, started, viewers}]` and `relayDelay` (ms) beside
    `streams`.
  - `POST /api/relay/{name}/watch` with `{"sdp": <offer>}`: the hub posts the offer to the
    relay's WHEP address for that person's `-web` channel with the `hub` account, remembers
    session → viewer, and returns `{"id", "sdp"}` (the answer). `404` when that person is not
    live.
  - `DELETE /api/relay/sessions/{id}`: ends your own session on the relay.
- **Viewers:** the names of the sessions the relay reports for a channel, through the hub's
  session → viewer table. A session the relay no longer lists is forgotten. The table is in
  memory: after a hub restart, people already watching keep their picture but are not counted
  until they reopen it.
- Relay streams do not count toward the 3-stream limit on screen shares, and the hub cannot
  stop one (it has no publish rights on the relay). Banned or deleted accounts are not
  listed.
- The Content Security Policy needs nothing new: the page only talks to the hub.

## The page (`web/src/stream.ts`)

- **LIVE** has a row for each person sharing a screen or streaming. A relay stream's row has its own
  icon (a broadcast icon, not the screen) and the streamer's name; yours reads "You're
  streaming". Someone doing both has two rows. Right-click: Watch, or Stop Watching on the one
  you are watching; Message.
- **Address:** `#stream=<name>` (screen shares stay `#live=<name>`).
- **Watching** uses the same panel as a screen share: head with the name and viewer count,
  the picture letterboxed, **Full screen** (double-click too), **Stop watching**. Added for
  these streams: a **volume slider and mute button** in the head, remembered per browser.
- **Sound** plays on the speaker chosen in Voice settings → Output, if one is chosen. It
  starts with sound on; if the browser refuses sound without a click (the address opened
  directly), it starts muted with a **Turn sound on** button over the picture.
- **Connecting:** an `RTCPeerConnection` that only receives (one video, one audio), offer to
  `POST /api/relay/{name}/watch`, answer applied, then `jitterBufferTarget = relayDelay` on
  both receivers. No LiveKit client is loaded.
- **States:** "Connecting…", "Waiting for the picture…", "Reconnecting…", "<name>'s stream
  stopped. Waiting for it to come back…", "<name> stopped streaming." (with Back), "Couldn't
  connect: …", "<name> isn't streaming right now.", and when the relay ends the connection
  before any picture, or none comes within 10 seconds (what a stream with B-frames does):
  "<name>'s stream can't be shown in the hub: it needs the OBS setting bframes=0."
- **It plays behind everything** (Paul, 2026-10-13). Opening a folder, a file or a chat
  leaves the stream playing: the sound goes on, and so does the browser's own pop-out player
  (Firefox's Picture-in-Picture). The panel is moved out of sight, not hidden, because a
  browser may stop a video it does not draw. For as long as you watch, in the
  panel too, a bar at the bottom of the sidebar says "Watching" and whose stream, with mute
  and **Stop**; its words lead back to the picture. The row is grey (the open one) while its
  panel is open and outlined while it plays behind something else, so one row is grey. One
  stream or screen at a time: opening another replaces it. It ends on Stop watching (the
  panel's head, the bar, the row's menu), when the stream ends, or when the page closes; that
  closes the connection and deletes the session. From the panel, Stop watching also goes back
  to where you were; from anywhere else you stay there.
- **A dropped connection reconnects by itself.** Once a picture has come, a connection that
  fails, closes, or stays "disconnected" for 6 seconds is replaced: the last frame stays under
  "Reconnecting…", and the page tries again after 1, 2 and 4 seconds, then every 5, for as
  long as the stream is listed. A connection that shows nothing for 10 seconds is retried the
  same way. Before any picture has come, a failure is final (the B-frames case above). A first
  picture counts once more frames have followed it (six, within four seconds): the relay
  can let a frame or two of a stream with B-frames out before it ends the connection, and a
  picture that then stays frozen is the same as none. (Found 2026-10-13: the page took that
  one frame for a working stream and reconnected for ever.)
- **A stream that leaves the list gets a minute to come back** (the streamer's own
  connection blinking): the page waits, and plays it again by itself when it is listed again.
  After 60 seconds it counts as stopped. Behind another panel, an ending is a toast.
- **Full screen** is the picture's box, with the controls over its bottom edge: mute and
  the volume slider on the left, **Exit full screen** on the right, each on its own dark
  patch with no bar across the picture. They show when the mouse moves and go, with the
  pointer, after three still seconds. Esc and a double-click leave too.
- Clicking the row of a stream whose panel says it ended or failed tries again.
- Phones watch from the strip at the top of the chat, as with screen shares.

Words: "Streaming", "You're streaming", "Watch", "Stop watching" ("Stop Watching" in the
menu), "Watching", "Reconnecting…", "Exit full screen", "Turn sound on". No
"relay", "channel" or "WHEP" in the page; "OBS" only in the message about B-frames.

## The streamer's side

In OBS → Settings → Output → Streaming, x264 options: `bframes=0`. x264 uses B-frames by
default, and the relay refuses to send a stream that has them over WebRTC. The game's screens
are unaffected either way. Nothing else changes: Firefox and Chrome both play x264's usual
profile.

A stream sent without the line is listed in LIVE but does not play; the viewer gets the
message above. The hub cannot tell beforehand (the relay does not report it).

## Build order

1. **Lab, on the relay, before any hub code. Done 2026-10-11, passed.** A test stream with
   the wall clock coded into the picture, played by headless Chrome and Firefox over WebRTC
   and by a real game client on a video screen, each read back and compared with the clock:
   - the relay, the sound conversion and WebRTC add about 0.15 s (Chrome 155 ms, Firefox
     131 ms);
   - the game's screen is 0.86 s behind the same clock, steady over 90 s;
   - with a 700 ms hold-back, Chrome is at 0.80 s and Firefox at 0.81 s: within 0.06 s of the
     game;
   - no dropped frames or freezes; picture and sound within 40 ms of each other;
   - a stream with B-frames does not play at all;
   - x264's own delay at default settings is about 1.1 s. It is in front of the relay, so
     the game and the hub get it alike, and it is left alone.

   Not measured: real OBS (ffmpeg's x264 stood in), a Windows game client, sound in the game,
   a visible Firefox window.
2. The relay's accounts and the `/relay/` path; the hub's `relay.go` with its tests.
3. The page; browser tests; the real-screen check (the head gains controls).
4. Deploy, then one real stream watched in the hub and on a screen in game at the same time.

## Tests

- **Go (`TestRelay`):** against a stub relay: the list follows ready channels and maps them to
  names; unknown channels are ignored; watch needs a login, passes the offer on with the
  account, returns the answer, `404` when not live; viewers come from the session table;
  delete only ends your own session; the relay unreachable; no `relay.json`.
- **Browser (`test/browser/relay.mjs`):** a local MediaMTX (fetched like the local LiveKit)
  fed a generated picture and tone by ffmpeg: the row appears with its icon, `#stream=` plays
  picture and sound, the viewer count, volume and mute kept, playing on behind a chat with
  the bar, Stop Watching on the row, the full-screen bar, a session the relay ends
  reconnecting by itself, a browser refusing sound, a stream with B-frames, the feed stopping
  and coming back, the feed stopping for good (the page's minute is cut to 12 seconds), the
  row retrying an ended stream, your own stream, and a phone. Not covered by a test: the
  browser's pop-out player, which a page cannot see or open.

## Limits and costs

- **Bandwidth:** the stream's bitrate per viewer from the relay (2.5 Mbit/s today, about
  1.1 GB per viewer-hour).
- **No adaptation:** one quality, the one OBS sends. A viewer on a weak link sees freezes.
- **The hub cannot stop a relay stream**; the streamer stops OBS.

## Later

- Telling the streamer, not only the viewer, when their stream arrives with B-frames.
- A thumbnail on the row on hover.
