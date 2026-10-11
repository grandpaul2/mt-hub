# Relay streams in the hub: design

**Status:** spec agreed, not built. Step 1 (the lab measurement) gates the rest.

A stream that someone sends to the stream relay with OBS, the kind that plays on a video
screen in the game, can also be watched in the hub: with sound, and less than a second behind.
Nothing changes in the game or the mod. The streamer changes one OBS setting, once.

This is separate from screen sharing ([`screen-share-spec.md`](screen-share-spec.md)), which
goes browser to browser through LiveKit and has no sound. The two sit side by side in LIVE.

## Decisions (Paul, 2026-10-11)

- Relay streams are rows in the existing **LIVE** section and play in the same main panel.
- Watching needs a hub login, like everything else.
- The rows carry the streamer's hub name; the hub keeps the list of which relay channel
  belongs to whom.
- A delay of 3 to 6 seconds (HLS) is not acceptable, so delivery is WebRTC.
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
  "channels": {"live": "grandpaul", "emptropy": "emptropy"}}`. Without the file the feature is
  off and nothing in the page changes. Adding a streamer is a line here and a channel on the
  relay.
- **Every 5 seconds** the hub asks the relay which `-web` channels are ready and which WebRTC
  sessions are reading them, and publishes `stream` on the bus when the list changes. A relay
  it cannot reach means no relay streams listed, and one line in the log per outage.
- **Routes** (all need a login):
  - `GET /api/streams` gains `relay: [{name, started, viewers}]` beside `streams`.
  - `POST /api/relay/{name}/watch` with an SDP offer as the body: the hub posts it to the
    relay's WHEP address for that person's `-web` channel with the `hub` account, remembers
    session → viewer, and returns the answer and a session id. `404` when that person is not
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

- **LIVE** appears while anyone shares a screen or streams. A relay stream's row has its own
  icon (a broadcast icon, not the screen) and the streamer's name; yours reads "You're
  streaming". Someone doing both has two rows. Right-click: Watch; Message.
- **Address:** `#stream=<name>` (screen shares stay `#live=<name>`).
- **Watching** uses the same panel as a screen share: head with the name and viewer count,
  the picture letterboxed, **Full screen** (double-click too), **Stop watching**. Added for
  these streams: a **volume slider and mute button** in the head, remembered per browser.
- **Sound** plays on the speaker chosen in Voice settings → Output, if one is chosen. It
  starts with sound on; if the browser refuses sound without a click (the address opened
  directly), it starts muted with a **Turn sound on** button over the picture.
- **Connecting:** an `RTCPeerConnection` that only receives (one video, one audio), offer to
  `POST /api/relay/{name}/watch`, answer applied. No LiveKit client is loaded.
- **States:** "Connecting…", "Waiting for the picture…", "<name> stopped streaming." (with
  Back), "Couldn't connect: …", "<name> isn't streaming right now."
- Leaving the panel closes the connection and deletes the session. Phones watch from the
  strip at the top of the chat, as with screen shares.

Words: "Streaming", "You're streaming", "Watch", "Stop watching", "Turn sound on". No
"relay", "channel", "WHEP" or "OBS" in the page.

## The streamer's side

In OBS → Settings → Output → Streaming, x264 options: `bframes=0`. Browsers play B-frames over
WebRTC jerkily; x264 uses them by default. The game's screens are unaffected. If step 1 shows
Firefox needs it, the same line also sets the H.264 profile.

A stream sent without the line still shows in the hub, just not smoothly; the hub does not
check or warn.

## Build order

1. **Lab, on the relay, before any hub code.** Switch WebRTC and the `-web` copy on for one
   channel and measure, with MediaMTX's own test page: the delay glass to glass (a running
   clock in the stream, photographed next to its playback), with and without `bframes=0`;
   lip sync; Chrome and Firefox, Linux and Windows if a member can try it. **Pass: under one
   second and smooth with the OBS line set.** If it fails, stop and report; the rest is not
   built on a guess.
2. The relay's accounts and the `/relay/` path; the hub's `relay.go` with its tests.
3. The page; browser tests; the real-screen check (the head gains controls).
4. Deploy, then one real stream watched in the hub and on a screen in game at the same time.

## Tests

- **Go (`TestRelay`):** against a stub relay: the list follows ready channels and maps them to
  names; unknown channels are ignored; watch needs a login, passes the offer on with the
  account, returns the answer, `404` when not live; viewers come from the session table;
  delete only ends your own session; the relay unreachable; no `relay.json`.
- **Browser (`test/browser/relay.mjs`):** a local MediaMTX fed a generated picture and tone by
  ffmpeg (both fetched like the local LiveKit): the row appears with its icon, `#stream=`
  plays frames and sound, volume and mute persist, the row goes when the feed stops, a phone
  watches, and a signed-out browser gets nothing.

## Limits and costs

- **Bandwidth:** the stream's bitrate per viewer from the relay (2.5 Mbit/s today, about
  1.1 GB per viewer-hour).
- **No adaptation:** one quality, the one OBS sends. A viewer on a weak link sees freezes.
- **The hub cannot stop a relay stream**; the streamer stops OBS.

## Later

- A notice to the streamer when their stream arrives with B-frames.
- A thumbnail on the row on hover.
