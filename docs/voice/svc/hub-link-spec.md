# #voice-link: the hub in Voice Link

**Status:** draft spec, not built. Decisions still open are listed first.

Voice Link ([`link-spec.md`](link-spec.md)) joins the Simple Voice Chat (SVC) groups of our game
servers. This adds the hub: one hub voice chat, **#voice-link**, is the same room as the
in-game group. People in the hub's #voice-link and players in the group on any server hear
each other. It is the voice twin of `#text-link`, the chat shared with game chat.

Every other hub voice chat stays in the hub, and every other SVC group (each server's own
room included) stays in game. There is one cross-server room.

## The rule this keeps

**We never touch audio** (link-spec.md). Both sides already speak Opus at 48 kHz in 20 ms
frames, so the bridge passes each packet on as it is: no decoding, mixing, re-encoding or gain.
The lab below checked that byte for byte.

## Open decisions

1. **How a hub member's microphone gets to the right level** (see Lab → Hub to game). The
   hub's page asks the browser for its automatic gain **off** and has a manual level slider
   that starts at 0, so hub voices reach the game 20 to 30 dB under a player's, and at that
   level the page's own chain misbehaves (a quiet microphone is shut for the first 30 seconds
   with the default filter). The filter itself is not the problem and no setting is
   overridden. Proposed: the page asks the browser for its automatic gain **on**, in every
   voice chat, with a switch in Voice Settings. Measured in Chromium and in Firefox.

Decided: the in-game group is renamed `voice-link`, in one MT Utils release that also
carries the settings-tab cleanup already queued for that mod.

## What people see

**In the hub**

- VOICE always has **voice-link**, first in the list, with a link icon. It cannot be ended
  and does not count toward the limit of 3 voice chats. Everyone can see and join it.
- Under it: the hub members in it, then the players in the group in game, each with their
  server's tag (SMP, CMP) as in `#text-link`. Names light up while they talk, hub members and
  players alike. The row shows players even while no hub member is in it, so the hub shows
  who is in the group.
- A player's row has User Volume and nothing else (no Message, no Disconnect: they are not a
  hub account here, even when their Minecraft name is linked to one).
- Joining, the bar, mute and deafen work as in any voice chat.
- If the bridge is not running, #voice-link is an ordinary hub voice chat with a muted line
  under its name: "Not connected to the game servers".

**In game** (no change to the mod for this part)

- The hub is one more server in Voice Link, named **Hub**. Players in the group get the chat
  lines they get for the other server: the list when they join ("Paul, Alex on Hub; nobody on
  Creative"), and "Paul joined on Hub" / "Paul left on Hub".
- Hub voices play like the other server's, under "Hub (Link)" in SVC's Adjust volumes.
- The group is named **voice-link** (was Link). The group id is unchanged, so nothing else
  moves.

**Someone in both** (in the group in game and in #voice-link on the hub) is heard twice by
others and hears themself. Nothing prevents it, as with joining a call from two devices.

## Pieces

```
Survival: SVC + MT Utils ──wss──┐                 ┌──wss── Creative: SVC + MT Utils
                                └─ voicelink relay ─┘
                                        │ wss (a third server: "hub")
                                   voicebridge
                                        │ WebRTC (LiveKit, room "voice-link")
                              browsers in the hub's #voice-link
```

- **voicelink** (the relay) is unchanged. The bridge is one more token in its config, with
  the server name `hub`.
- **voicebridge** is a new small program, `cmd/voicebridge`, run beside the relay and LiveKit.
  It is not part of the hub's binary: LiveKit's Go library is about 20 MB, and the hub does
  not need it for anything else.
- **The hub** gains the permanent voice chat and learns to show the bridge's participants.
  The hub and the bridge do not talk to each other: both read LiveKit.
- **MT Utils** (server side): the group's name.

## The bridge (`cmd/voicebridge`)

Config, a JSON file: the relay's address and the `hub` token; LiveKit's address, key and
secret (as in the hub's `voice.json`); the room (`voice-link`).

**In LiveKit**

- One **listener** participant, identity `link`, hidden, always connected. It subscribes to
  the microphone track of every participant that is not the bridge's own, and publishes
  nothing.
- One participant **per player** in the group on a game server, identity
  `link:<server>:<Minecraft name>`, display name the Minecraft name. It joins when the relay's
  roster lists the player and leaves when it no longer does (or the server disconnects). It
  publishes one Opus microphone track and subscribes to nothing.
- The bridge signs its own tokens with LiveKit's key. Hub account names cannot contain `:`,
  so a bridge identity can never collide with a member's.

**Game to hub**

- A frame from the relay (speaker uuid + Opus bytes) is written to that player's track as one
  RTP packet, payload untouched. RTP timestamps advance 960 per frame.
- "Stopped talking" (an empty frame), or 100 ms without a frame, ends a talk spurt. The next
  frame's timestamp jumps by the time that passed, rounded to whole frames, so a listener's
  player treats the pause as a pause and not as a slow network.
- A frame for a player whose participant is still joining is dropped (the first fraction of
  a second after they join the group).

**Hub to game**

- For each hub member's microphone track the bridge reads RTP and sends each payload to the
  relay as a speaker: uuid = name-based UUID of `hub:<account name>`, stable across restarts.
- Not sent: packets of one or two bytes (a browser's DTX, "nothing to send"), and the Opus
  silence frame `f8 ff fe` followed by zeros (LiveKit's libraries send it on an idle track).
- Not sent either: **lone silence frames.** With DTX on, a browser whose microphone is shut
  still sends one ordinary-looking frame of encoded silence about every 400 ms (35 bytes,
  420 ms apart in the lab). Each would open the speaker in game for one silent frame. They
  cannot be told from speech by their bytes, so the first frame after a pause is held until
  the next one follows within 60 ms: speech does and both go out; a lone frame does not and
  is dropped. Nothing after the first frame of a talk spurt is delayed.
- After 100 ms without a speech packet the bridge sends "stopped talking", which the game
  servers need to end the sound cleanly.
- If a track arrives as `audio/red`, the newest block is taken out (RFC 2198) and sent; the
  Opus bytes are not changed. (LiveKit gives a subscriber that does not offer RED plain Opus,
  which is what the lab saw.)
- A pause shorter than 100 ms inside speech reaches the game closed up, since the relay's
  protocol has no timestamps. It shortens a pause by 40 to 160 ms and cuts no speech.

**Rosters**

- To the relay: the hub members in the room, `{uuid, name}`, on every join and leave and on
  each reconnect. That is what makes the game's chat lines.
- From the relay: each server's players, which become the participants above.

**Reconnecting:** to the relay with backoff as the game servers do (and treating 60 s without
a ping as dead); to LiveKit with its library's own reconnect, then by rejoining. While either
is down the other side keeps working by itself.

It logs connects, disconnects and joins, never audio.

## The hub

- **The permanent voice chat.** `voice.go` keeps one voice chat with the fixed id
  `voice-link`: public, never ended (not when empty, not by the unused timer), not counted in
  `maxVoiceChats`, listed first. It exists when voice chats are set up and `link_voice` is on
  in `voice.json` (so a hub without game servers has no such room).
- **People.** LiveKit's webhooks and the 20-second check already report who is in a room.
  An identity starting `link:` is a player: kept in the list as `{name, server}` (not looked
  up as an account, never removed as "banned or deleted"), and the identity `link` (the
  listener) is left out. `GET /api/voice` gives each voice chat `link: true` where it is this
  one, and each person `via: "SMP"` where they are a player (tags as in `link.go`).
- **Bridge up or down:** the listener's presence in the room, from the same reports;
  `linked: true|false` on the voice chat.
- **Tokens** are as for any voice chat. A member's token cannot publish as a `link:` identity
  because the hub signs tokens for account names only.
- **The page** (`voice.ts`): the named row with its icon, players listed after members with
  their tag, the "Not connected to the game servers" line, and the shorter menu on a player's
  row. A player's audio plays like any member's. The microphone chain is the same as in any
  voice chat (open decision 1 is about the chain everywhere, not this room).
- Banning or deleting an account takes them out of #voice-link as out of any voice chat.

## MT Utils (server side)

- `Link.java`: the group is built with the name `voice-link`. SVC rebuilds persistent groups
  at each start, so the new name appears at the restart; the id in `mthub.json` stays.
- Nothing else: a third server on the relay is already handled (names, volume category, chat
  lines are made from the relay's server name; `hub` shows as "Hub").
- To check on a throwaway server before release: the group's name, and a third server's
  roster and voices (the lab's stand-in can play the hub).

## Security

- The bridge's relay token and LiveKit's secret live on the machine that already holds both.
- Any hub member can join #voice-link and be heard by the players in the group on both
  servers, and the other way round. That is the same trust as the hub and the servers
  themselves.
- The relay still accepts nothing without a token and forwards only between servers it
  knows; `hub` is one of them and cannot pose as another.
- A player cannot act in the hub through the bridge: its participants publish audio and
  nothing else (no data, no chat).

## Failure cases

| What breaks | Result |
|---|---|
| The bridge | #voice-link is an ordinary hub voice chat ("Not connected to the game servers"); in game, "Hub not connected" |
| The relay | The same, and the game servers lose each other as today |
| LiveKit | No hub voice chats at all; in game the group works, "Hub" has nobody |
| The hub (restart) | People already in #voice-link keep talking; the list is rebuilt from LiveKit |

## Lab (2026-10-13)

A prototype bridge, a stand-in game server speaking the relay's protocol with frames from
SVC's own encoder, and a real hub page in headless Chromium with recorded speech as its
microphone. Two people's recordings: one with a clear voice, one with a quiet voice in a loud
room; for each, room noise, typing, mouse clicks, talking, talking while typing, quiet
talking, and their typing laid over their talking. Every browser run checked its own
measurements, the page's audio thread included (no stalls in any run).

- **Byte for byte:** 986 frames each way arrived in order and identical. The relay and bridge
  add 0.1 ms on one machine.
- **A browser's packets:** Opus, mono, 20 ms. SVC's native decoder and its Java fallback both
  decoded every frame to 960 samples.
- **Game to hub** (what a member's browser plays, against what the player said): level
  −0.2 to −0.9 dB, no speech cut, 50 to 57 ms from the game server to the browser's speaker.
- **Hub to game** (what the game server is sent, decoded by SVC's decoder), against the same
  recordings sent the way a player's microphone sends them (SVC's own chain: RNNoise,
  automatic gain, its gate). Scores are DNSMOS overall (1 to 5; 0.05 is the test's own
  noise) for talking / quiet talking / typing laid over talking / talking while typing, and
  the level talking arrives at. Default filter (DeepFilterNet3) throughout:

  | | Clear voice | Quiet voice |
  |---|---|---|
  | as a player (SVC) | 2.88 / 2.66 / 2.87 / 2.82 at −26 dBFS | 2.99 / 2.18 / 2.56 / 2.37 at −25 |
  | hub, as it is (level 0, no automatic gain) | 2.93 / 1.91 / 2.44 / 2.06 at −46 | nothing for 30 s, then 2.57 / nothing / 2.53 / 2.17 at −52 |
  | hub, level slider +12 dB | 3.16 / 2.09 / 2.93 / 2.60 at −34 | 2.94 / 2.97 / 3.02 / 2.91 at −41 |
  | hub, level slider +24 dB | 3.17 / 2.68 / 2.94 / 2.83 at −21 | 3.28 / 3.08 / 2.86 / 2.95 at −28 |
  | hub, the browser's automatic gain on (Chromium) | 3.16 / 2.72 / 2.97 / 2.83 at −24 | 3.08 / 3.10 / 2.96 / 2.97 at −34 |
  | hub, the browser's automatic gain on (Firefox) | 3.14 / 2.92 / 2.95 / 2.60 at −24 | 3.11 / 3.30 / 3.10 / 2.92 at −32 |

- **The level is the root.** With it right, the default filter matches or beats the
  speaker's own in-game microphone on every recording. With it low: the quiet voice sends
  nothing for the first 30 seconds after joining (whichever recording came first was lost),
  and its quiet talking is never sent.
- **Other filters, level 0:** filter off keeps the voice (0.1% cut) but passes typing between
  words at nearly full level (−3 dB, where a player's microphone sends it 29 dB down) and the
  gate alone cuts 40% of the quiet voice's quiet talking; RNNoise lowers both voices another
  6 to 8 dB.
- **Typing alone and clicks alone are never sent**, for either voice at any setting tried.
- **Lost packets:** up to 10% of frames lost and closed up leaves the scores unchanged.
- **Firefox** was measured the same way, its microphone a virtual one on a private sound
  server (it has no file-as-microphone switch). Its packets have the same shape, the known
  case reproduces, and its automatic gain works with the chain (table above). One thing
  apart from this spec: with DeepFilterNet3, Firefox's audio thread stalls once at the start
  (about 280 ms) and the voice stays about a quarter second later for the session.
- Not measured: a real game client (it receives the same packets Voice Link already delivers
  between servers), a phone, a real microphone, and anything by ear.

## Tests

- **Go (`cmd/voicebridge`):** against a local relay and a local LiveKit, as the lab's
  byte-for-byte run: both directions identical and in order; a pause keeps its length game
  to hub; silence packets, DTX and lone silence frames never reach the relay, and speech after
  one is whole; "stopped talking" within 150 ms;
  rosters both ways; a player joining and leaving; the relay or LiveKit restarting.
- **Go (`TestVoiceLink`):** the permanent voice chat (always listed, not ended, outside the
  limit, absent without `link_voice`), `link:` identities kept and tagged, the listener left
  out, `linked`.
- **Browser (`voice-link.mjs`):** the row and its icon, joining, a player listed with a tag
  and lighting up, the player's menu, the not-connected line.
- **Before release:** two people, one in game and one in the hub, for a minute each way.

## Build order

1. The bridge, with its Go tests.
2. The hub: the permanent voice chat, people, the page; browser suite.
3. MT Utils: the group's name; checked on a throwaway server with the bridge.
4. Deploy: the bridge and its token beside the relay, then the hub; then the mod on both
   servers at a restart. #voice-link appears in the hub with step 4, not before.
