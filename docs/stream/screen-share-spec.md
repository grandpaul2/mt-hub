# Hub screen sharing: spec

Status: **built and live** (S55, 2026-10-05, mt-hub `e6bdc00` + follow-up). Paul's first real test: sharing
from Firefox, watching from Chrome worked. After it: 1080p instead of 720p, LIVE under CHATS. Chosen over the in-game mod
(a spec for it exists, parked) because it's hub-only work on parts we already run, works on
every OS, and can't break with a Minecraft update. **Video only** (Paul: "you either watch or
you don't", no sound levels to balance).

## What it does

- Anyone signed in can **share a window or screen** from the hub. The browser asks which one
  (a browser rule, every time).
- While they share, the stream shows in the left bar for everyone. Clicking it plays it in the
  main panel. Watching is silent and needs nothing: no settings, no volume.
- It ends when the streamer clicks Stop, closes the shared window (the browser ends the
  capture by itself), closes or reloads the hub, or loses their connection.
- Watching and voice are independent: you can be in a voice chat and watch a stream, or
  just watch.

## How it works

```
Streamer's browser                 Relay VPS                          Viewers' browsers
getDisplayMedia (window/screen) ─► LiveKit 1.13.7 (SFU, forwards, ─► <video> in the main panel
 → LiveKit screen-share track       no transcoding), room "s…"       (subscribe only)
                                    │ webhooks
Hub (home-server, voice.go's twin) ◄┘  list of streams, tokens, live updates to every page
```

Same pieces as voice chats: the hub keeps the list and signs LiveKit tokens; LiveKit carries
the media; LiveKit's webhooks plus a 20-second check keep the list honest. Nothing changes on
the relay, Caddy, the firewall or the CSP: the page already talks to LiveKit for voice
(`connect-src` has the LiveKit host), and a `MediaStream` in `video.srcObject` isn't covered by
`media-src`.

## The hub server (`internal/server/stream.go`, new)

Modelled line for line on `voice.go`; reuses `voiceConf` (the same `voice.json`: same LiveKit,
key and secret), `sign`, `twirp`, `participants` and `replayed`.

- **A stream:** `{id: "s"+12 hex, name (the streamer), started, viewers: [names]}`, kept in
  `~/hub/streams.json` (written atomically like `voice-chats.json`), so a hub deploy or restart
  doesn't lose streams in progress.
- **Rules:** one stream per person; **at most 3 at once** (bandwidth, same as voice chats; a
  constant, Paul can change it). Banned or deleted accounts are removed by the 20-second check,
  as in voice.
- **Routes:**
  - `GET /api/streams`: `{enabled, max, full, streams: [{id, name, started, viewers}]}`.
  - `POST /api/streams`: start your stream. If you already have one, it is replaced (a second
    tab or a reload just takes over). Returns `{id, url, token}`.
  - `POST /api/streams/{id}/watch`: returns `{id, url, token}` for watching.
  - `POST /api/streams/{id}/stop`: the streamer ends it now (the webhook also comes later and
    finds it gone). An admin who outranks the streamer can stop it too (admin log: `stream-stop`),
    with Discord's server-mute as the model.
- **Tokens** (HS256 with the LiveKit secret, as `voiceToken`):
  - Streamer: identity = account name; grants `roomJoin`, `canPublish`,
    `canPublishSources: ["screen_share"]`, `canSubscribe: false`, `canPublishData: false`.
    It can only publish a screen, never a microphone.
  - Viewer: identity = `name~` + 6 random hex (one person can watch in two tabs), `name` = the
    account name; `roomJoin`, `canPublish: false`, `canSubscribe: true`, `canPublishData: false`.
  - 1-hour expiry for joining; LiveKit renews while connected (as voice).
- **Webhook dispatch (must fix, or voice breaks):** LiveKit has **one** webhook address for
  every room, and it's `/api/voice/webhook`. The handler today treats every
  `participant_joined` as joining a *voice chat*, and `voicePart` takes you out of every other
  voice chat. So **someone starting or watching a stream would vanish from the voice chat they
  are in.** The handler becomes a dispatcher: rooms starting with `v` → voice as today; rooms
  starting with `s` → streams. A Go test pins this.
- **Stream events from LiveKit:** `participant_joined`/`participant_left` keep the viewer list
  (identity cut at `~`). `track_published` with source `SCREEN_SHARE` from the streamer marks
  the stream **live** (it's only listed once there's a picture). `track_unpublished`,
  `participant_left` (streamer) or `room_finished` ends it.
- **The 20-second check** (`streamCheck`, beside `voiceCheck`): asks LiveKit who's in each
  stream room; ends a stream whose streamer is gone, and one started but never published within
  a minute; fixes the viewer list.
- **Live updates:** `s.bus.publish("stream", struct{}{})`. Pages re-fetch `GET /api/streams`.
  It's the same pattern as `"voice"`.

## The page (`web/src/stream.ts`, new)

LiveKit's client stays lazy-loaded (`loadBundle('livekit')`, as voice does), so the page
doesn't get heavier for people who never share or watch.

### Starting

- CHATS' "+" menu gets **Share Your Screen…** under the voice chat items. It's greyed out with a
  tooltip when 3 streams are running, and hidden in browsers without `getDisplayMedia` (phones).
- Clicking calls `navigator.mediaDevices.getDisplayMedia` **first**, before waiting on the
  lazy LiveKit bundle or the server. It must run straight from the click, or browsers refuse.
  Then `POST /api/streams`, then wrap the track in LiveKit's `LocalVideoTrack`, connect and
  publish. All the publish options below exist in the hub's livekit-client 2.22.3 (checked in
  its `options.d.ts`). If the person cancels the
  picker, nothing happens and nothing is said.
- Capture request: `{ video: { frameRate: 30, width: { max: 1920 }, height: { max: 1080 } },
  audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' }`, so the hub tab
  itself isn't offered and Chrome's "share this instead" button works.
- **`track.contentHint = 'motion'`** before publishing. Without it, browsers treat screen shares
  as documents and keep sharpness by dropping to a few frames per second, which is wrong for a game.
- **Publish:** `source: ScreenShare`, `videoCodec: 'vp8'` (all browsers encode it; AV1 has
  Firefox problems per `docs/voice/transport.md`), `simulcast: false`,
  `screenShareEncoding: { maxBitrate: 5_000_000, maxFramerate: 30 }` (1080p30; Paul found 720p too soft),
  `degradationPreference: 'maintain-framerate'`. H.264 can be tried later for hardware encoding
  in Chrome; VP8 is the safe start.
- The browser ending the capture (window closed, the browser's own Stop sharing bar) fires the
  track's `ended`: the page stops the stream.
- `Room({ disconnectOnPageLeave: true, adaptiveStream: false, dynacast: false })` for the
  streamer.

### The streamer's bar

The sidebar foot gets a bar like the voice bar (stacked above it if both are on):
**Sharing your screen**, then "Nobody watching yet" or "2 watching". Hovering shows the names.
A **Stop** button (danger style) ends it. Losing the connection toasts "Screen sharing stopped:
the connection dropped." LiveKit retries briefly first; if it gives up, the stream ends and
the person can share again.

### The left bar: CHATS, VOICE, LIVE (Paul, S55)

Voice and video each get **their own section, shown only while there's something in it**.
Normally the sidebar is FILES and CHATS, as today.

- **VOICE** appears when any voice chat you can see exists, and goes when the last one ends.
  The voice chat rows **move out of CHATS** into it, unchanged (people in join order, the
  speaker icon, private lock, right-click menu). This changes existing voice UI: `voiceRows()`
  stops being inserted into `#channels` by `renderChannels()` (chat.ts ~l.1098) and renders into
  its own `#voice` list.
- **LIVE** appears when anyone is sharing, and goes when the last stream ends. One row per
  stream: a screen icon and the streamer's name. The title is "Watch grandpaul's screen". Your own row
  says "You're sharing your screen", and clicking it **watches it** (handy for checking what
  others see).
- **Order:** FILES, CHATS, VOICE, LIVE (both under CHATS, Paul after the first test), then
  the bars and the Schematic Manager button pinned at the bottom.
  Their heads use the existing `side-head` style; each has a "+" (New Voice Chat… / Share Your
  Screen…). CHATS' "+" keeps New Voice Chat and gets Share Your Screen too, since VOICE and
  LIVE aren't there to click when nobody's using them.
- Right-click on a LIVE row: Watch; Message; Stop Stream for an admin who outranks the streamer.
- The sections appear and go with the existing live updates (`voice` and `stream` events). There's
  no animation (style guide: quiet look).

### Watching (`#main-live`, address `#live=<name>`)

- A new main panel beside `main-chat`/`main-schems`/`main-folder` (`setMode('live')`).
  Head: "grandpaul's screen" and the viewer count. Body: a `<video autoplay playsinline muted>`
  filling the panel, letterboxed (`object-fit: contain`, black). It's muted because there's no
  sound anyway, and muted video may autoplay everywhere.
- Buttons: **Full screen** (`requestFullscreen` on the video; double-click does the same) and
  **Stop watching** (back to where you were).
- Viewer `Room({ adaptiveStream: true, dynacast: false })`, so a viewer watching in a small
  panel or a phone gets fewer pixels pushed to it. With one layer it can only pause/resume
  rather than pick a smaller size, so phones on weak links may freeze. See "Later".
- States in the panel's body, plain words: "Connecting…", "Waiting for the picture…" (connected,
  no frame yet), "grandpaul stopped sharing." (stream ended while watching; a Back button),
  "Couldn't connect: …".
- Opening `#live=<name>` when they aren't live shows "grandpaul isn't sharing their screen
  right now." Like `#chan=`, a top-level file literally named `live=…` would win (S54 rule),
  which is harmless.
- Leaving the panel (another file, chat, the back button) disconnects the viewer.

### Words (style guide §11)

"Share Your Screen…", "Sharing your screen", "Stop", "Watch", "Stop watching", "Full screen",
"2 watching". No "stream key", "track", "publish". Toasts say what happened, then what remains.

## Limits and costs

- **Bandwidth through the relay:** up to 5 Mbit/s per viewer ≈ 2.25 GB per viewer-hour (about
  450 viewer-hours in 1 TB; real use is lower, VP8 rarely sits at the cap). The $5 plan's monthly
  transfer (reportedly 1 TB) is worth a look on the Vultr dashboard. 3 streams × 5 viewers is
  up to 75 Mbit/s out.
- **LiveKit's ports:** the relay's LiveKit uses UDP 50000–50100 (101 ports) + TCP 7881. Before
  launch, check in `/etc/livekit.yaml` whether it multiplexes on one port or uses a port per
  connection; 101 ports could cap how many people can be connected at once (voice + watching).
- **CPU:** the SFU only forwards; video costs it little more than voice. The streamer's
  browser does the encoding: Chrome usually in hardware, Firefox's VP8 in software. At 1080p30
  that may take one or two CPU cores; it's the main unknown and is test 3 below.
- **Sound:** none, by design. If wanted later, Chrome/Edge on Windows and Mac can add it with a
  small change (`audio: true` + `systemAudio`/`windowAudio`), but Firefox and Linux can't.

## Tests

- **Go (`TestStreams`, beside `TestVoice`):** start/replace/stop, the 3-stream limit, one per
  person, token grants (streamer screen-only, viewer subscribe-only), webhook dispatch:
  **a stream join does not touch voice chats** (the bug above), viewer lists, streamer leaving
  ends it, never-published stream ends after a minute, banned streamer removed, restart keeps
  streams, admin stop and its rank rule.
- **Browser suite (`test/browser/stream.mjs`):** reuses the voice suite's local LiveKit and two
  browser profiles. Chromium's fake screen capture
  (`--auto-select-desktop-capture-source=…` / `--use-fake-ui-for-media-stream`) for the
  streamer; the viewer sees the row appear, opens `#live=`, and the video gets frames
  (`requestVideoFrameCallback`); the streamer stops → the viewer sees "stopped sharing" and the
  row goes; reload as streamer ends it; phone width shows the panel properly and no Share item.
  `make firefox-check` gets the live panel added to its views.
- **Firefox's own sharing box** is the browser's privacy indicator; no page can hide it. It
  showed over the game once in Paul's first test and couldn't be made to happen again (likely
  a one-off of where Firefox placed it under i3). If it ever gets in the way:
  `about:config` → `privacy.webrtc.hideGlobalIndicator` = true (per browser).
- **Real tests (before calling it done).** Paul can do 1–3 and 5 alone: a viewer is its own
  LiveKit connection (`name~…`), so his own account can watch his own stream. The picture still
  goes out to the relay and back, so it's the real network path.
  1. Paul shares the **Minecraft window** (not the whole screen, or the viewer ends up in its
     own picture) from **Firefox on Linux** (i3, X11), and watches in a second browser window
     (e.g. Chrome) and on his **phone on mobile data**. Check the picture, the delay (a
     stopwatch shown in game, compared in both), and that the game's FPS barely moves.
  2. The same with the game **fullscreen (F11)** and with the viewer behind the game. Window
     capture on X11 without a compositor can show stale or black frames when covered, which this
     test settles. Sharing the whole screen is the fallback.
  3. **Streamer CPU**: Firefox at 1080p30 (`top` during the share). If Firefox's software VP8 is
     too heavy, try H.264.
  4. A **Windows Chrome** streamer, when someone's around. Exclusive-fullscreen games can
     capture black on Windows, while borderless works; Minecraft's F11 is the test. Not needed
     to ship.
  5. Close the game window while sharing a window: the stream ends by itself within seconds.

## Build order

1. Server: `stream.go`, the webhook dispatcher, `TestStreams`.
2. Page: VOICE section (voice rows move out of CHATS; the voice browser suite updated to
   match), LIVE section, Share items, streamer bar, live panel, states.
3. Browser suite + Firefox check, then deploy, then the real tests above with Paul.

That's about one session. Real tests 1–3 and 5 need only Paul; 4 waits for a Windows player.

## Later (not in this build)

- A second, small simulcast layer (e.g. 360p) so weak phone connections get a smaller picture
  instead of freezes. It costs the streamer more encoding. Add it if real viewers need it.
- Sound for Chrome/Edge streamers on Windows/Mac.
- A thumbnail on the row on hover.
- The in-game route (the parked mod spec) if game sound from Linux/Firefox ever matters.

## Decided (Paul, S55)

1. **Sections:** voice and video are split. Normally only CHATS; a VOICE section appears while
   there's a voice chat, a LIVE section while someone's sharing (see "The left bar").
2. **Quality:** 720p at 30 fps at first; raised to 1080p after Paul's first test.
3. **Who may share:** everyone with an account.
4. **Admins can stop a stream** (someone below them), as with voice disconnect.
