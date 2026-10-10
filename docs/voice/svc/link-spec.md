# Voice Link — spec

**Status (2026-10-09, S59): live on Survival and Creative.**
- The relay (`voicelink`) runs on the VPS; runbook in `server/relay/README.md`.
- Both servers run MT Hub Server 1.3.1 and Simple Voice Chat 2.6.24, on DatHost's Voice ports:
  Creative 17135, Survival 17798.
- Checked end to end with the echo tool, locally and live through Creative.
- Not yet checked: two real players on different servers.

A shared Simple Voice Chat (SVC) room across Survival and Creative. Written 2026-10-09 (S59).
Background research is in the same folder: `plugins-and-bridge.md`.
SVC source facts below were checked in the `1.21.11` branch (`f0a7f17`, mod 2.6.24).

## Rule this design follows

**We never touch audio.** SVC does capture, noise handling, the codec and playback, end to end.
The link only carries SVC's own Opus packets from one server to the other, untouched. There is no
decoding, mixing, re-encoding, gain or bitrate setting anywhere in our code. (Paul, S59: audio
has to be a complete drop-in system.)

## What players see

1. Each server has a permanent SVC group called **Link** (not deleted when it's empty). Players
   join it from SVC's normal group screen, the same as any other group.
2. Everyone in Link on Survival hears everyone in Link on Creative, and the other way round.
   Players in Link on the same server hear each other the normal SVC way.
3. Voices from the other server play non-positionally, like group voice. In SVC's **Adjust
   volumes** screen they're under one entry per server, e.g. "Survival (Link)", with its own
   volume slider.
4. When you join Link you get a chat line listing who is in Link on the other server, e.g.
   `Link: Eldridge, Lennox on Survival`. You also get a chat line whenever someone on the other
   server joins or leaves Link.
5. If the relay is down, Link keeps working on each server by itself. The chat line says
   `Link: Survival not connected`.

**SVC limit:** remote speakers can't show up in SVC's group list or speaking icons. That list
only holds players on the same server, and the API can't add others to it. Point 4 is the
replacement. No action-bar "who's talking" line (Paul, S59).

## Pieces

```
Survival: SVC + MT Hub Server ──wss──┐            ┌──wss── Creative: SVC + MT Hub Server
                                  └─ VPS: voicelink ─┘
                     (Caddy: macrotechmc.com/voicelink → 127.0.0.1:7890)
```

1. **SVC 2.6.24** on both servers and on every client that wants voice. Server config:
   `port=` the **Voice** port DatHost shows when you hover over the server address in the
   panel. Leave `bind_address` blank and `force_voice_chat=false`. Everything else stays at
   SVC's defaults. Never use `port=-1`; the SVC wiki warns it can crash the server.
2. **Link plugin**, a feature of **MT Hub Server**, the server-only jar from the MT Hub split
   (step 0 below). It turns on only when SVC is installed and `voice_link` is set in
   `config/mthub.json`. This is the same pattern as the WaterFrames aliases. Players need
   nothing from us beyond SVC.
3. **`voicelink` relay**, a small Go program on the VPS (`cmd/voicelink` in `~/mt-hub`, since
   the hub backend is Go). It runs as a sandboxed systemd service behind the existing Caddy.
   It doesn't run on home-server: that would send every packet through the home tunnel.

## Link plugin (MT Hub Server)

Registered through SVC's Fabric entrypoint `"voicechat"`, compiled against `voicechat-api`
only (the mod itself is All Rights Reserved; the API is published for plugins).

1. **Group:** on `VoicechatServerStartedEvent`, create the Link group with `groupBuilder()`:
   name `Link`, persistent, type `NORMAL` (SVC's default type), no password. Keep the same group
   id across restarts (a fixed UUID in config).
2. **Members:** track local Link members with `JoinGroupEvent`, `LeaveGroupEvent` and
   `PlayerDisconnectedEvent`. Send each change to the relay. Show the remote roster as chat
   lines (What players see, point 4).
3. **Outbound audio:** in `MicrophonePacketEvent`, if the sender's group is Link, put
   `(sender uuid, opus bytes)` on a queue. Don't cancel the event, so local delivery is
   unchanged. A sender thread writes the queue to the relay. Nothing blocks SVC's network thread.
   Empty data means "stopped talking"; SVC's client sends exactly that (`MicThread` line 281),
   and it is forwarded as is.
4. **Inbound audio:** keep one `StaticAudioChannel` for each remote speaker.
   - Channel id `UUID.nameUUIDFromBytes("mtlink:" + speakerUuid)`. This is deliberately not the
     speaker's own UUID, so it can't collide with that player's normal voice if they later join
     this server.
   - `setCategory("link_<server>")`, registered with `volumeCategoryBuilder()` (ids are a–z
     and `_`, at most 16 characters).
   - `setBypassGroupIsolation(true)` (otherwise SVC skips anyone in an isolated group).
   - Targets are the current local Link members.
   - A frame is sent with `channel.send(opus)`. An empty frame is sent with `channel.flush()`,
     which ends the stream cleanly on every client.
   - Safety net: if a remote speaker sends nothing for 500 ms, `flush()` anyway, in case the
     end packet was lost. Drop the channel after 60 s of silence.
5. **Ordering:** SVC numbers packets per channel by itself, and each client buffers and
   reorders them (`AudioChannel`, `AudioPacketBuffer`). The relay connection is TCP, so packets
   arrive in order and none are lost. The client's normal buffer smooths delay.

## Relay protocol

One WebSocket per game server: `wss://macrotechmc.com/voicelink`, header
`Authorization: Bearer <link token>`. The relay knows each token's server name, so a server
can't pretend to be the other one. Messages are binary, with the type in the first byte:

| Type | Direction | Body |
|---|---|---|
| `1` audio | server → relay → other servers | speaker uuid (16 bytes) + Opus bytes (empty = stopped) |
| `2` roster | both ways | JSON `{"members":[{"uuid","name"}]}`, the full list on every change |
| `3` status | relay → server | JSON `{"servers":["survival","creative"]}`, sent on any connect or disconnect |

The relay adds the source server name to everything it forwards. Each speaker's audio is about
2–4 KB/s.

## Relay (VPS)

1. Listens on `127.0.0.1:7890` only. Caddy adds `handle /voicelink*` to the `macrotechmc.com`
   block, so no new firewall port and no new certificate are needed.
2. Config is `/etc/voicelink.json` (root:voicelink 640): `{"tokens": {"<token>": "survival", ...}}`.
   Tokens are generated with `openssl rand -hex 32` and kept in KeePassXC with the other relay
   credentials.
3. The relay holds no state beyond the open connections and the last roster from each server.
   A restart only drops speech for the second it takes to reconnect.
4. The plugin reconnects with backoff (1 s, doubling to 30 s) and resends its roster.
5. It logs connects and disconnects only, never audio.
6. Install follows the LiveKit pattern: build on the PC, `scp` the binary to
   `/usr/local/bin/voicelink`, systemd unit with `DynamicUser`/sandboxing. Runbook goes in
   `server/relay/README.md`.

## Config (`config/mthub.json`, new keys)

```json
"voice_link": {
  "url": "wss://macrotechmc.com/voicelink",
  "token": "",
  "group_id": "<fixed uuid>"
}
```

If the key is missing or the token is empty, the feature is off and Link isn't created.

### Server rooms (MT Hub Server 1.3.1, S61)

```json
"voice_room": "Survival"
```

Each server also has its own permanent room, named after the server (**Survival**,
**Creative**), for talking without the other server. It is a plain SVC group (persistent, type
`NORMAL`, no password) that never touches the relay, and it works with Link off. Its id is
derived from the name, so nothing is stored. Empty or missing means no room. A player is in one
SVC group at a time, so being in a server room means not being in Link.

## Security

- Only the two game servers hold link tokens; players never see one.
- The relay accepts nothing without a token, and forwards only between authenticated servers.
- Anyone on a server can join Link and so be heard on the other server. That's the same trust
  as joining the server itself. A password on the group is a config option if that ever changes.

## Failure cases

| What breaks | Result |
|---|---|
| Relay or VPS down | Link works on each server separately; chat line says the other server isn't connected |
| One game server down | The other server's Link players see the roster empty |
| SVC missing on a server | MT Hub mod runs as today; no Link group |
| Player without SVC on their client | No voice for them (SVC's normal behaviour) |

## Build and test

0. **Split MT Hub into two jars. Done S59 (`~/mthub-mod` `fa843c1`, both 1.3.0).**
   - **MT Hub** (`mthub-1.3.0.jar`) is for players: the Litematica schematics folder and
     screenshot upload.
   - **MT Hub Server** (`mthub-server-1.3.0.jar`, mod id `mthub_server`) is for servers:
     `/b`, the aliases and hub calls, and Link.
   - Messages between the two are unchanged, so players' 1.2.0 jars keep working with the new
     server jar.
   - Not deployed yet. To deploy: swap `mthub-1.2.0.jar` for `mthub-server-1.3.0.jar` on both
     servers, put the client jar on the hub, and update `/hubupdate`, `/health` and the
     modlists.
1. **Relay:** Go unit tests for auth and forwarding, then a run on the PC.
2. **Plugin:** `./gradlew runServer` twice (two ports) plus the relay locally. Test with
   two clients on two servers.
3. **Throwaway server first** (load-test rule), on DatHost or local:
   - two people talking at the same time across the link;
   - start and stop talking, and checking that no voice is left hanging;
   - join and leave Link while someone is talking;
   - restart the relay mid-talk;
   - restart a game server and check that Link and its id survive.
4. Then deploy:
   1. Install SVC on Creative and set the Voice port.
   2. Install MT Hub Server with Link, the relay and Caddy.
   3. Test it on Creative alone.
   4. Do Survival the same way.
5. **Housekeeping:**
   - the server mod set goes from 29 to 30 jars (`server/mod-sources.md`, modlists, `/health`
     expected values);
   - add SVC to the hub's client mods as optional ("needed for voice");
   - `/hubupdate` should check for it;
   - add `voicelink` to `/health` (service active, both servers connected).

## Decisions (Paul, S59)

1. **Players need only SVC for voice.** Link ships in MT Hub Server. MT Hub is split into a
   client jar and a server jar, so server changes never make players update.
2. No action-bar "who's talking" line.
3. One Link room.
4. No message to henkelmax first.
5. Joining Link stays manual (press V each session); no auto-rejoin for now.
6. Relay tokens are kept in KeePassXC (done by Paul).

## Not in scope

- Hub and web users in the room. That would need decoding and re-encoding, which breaks the rule
  above. It comes back only if a finished component does it.
- Recording, radios and other SVC addons.
