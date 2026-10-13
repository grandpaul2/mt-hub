# Voice Link: spec

**Status:** current spec, built. It runs between MacroTech's two game servers, and since
2026-10-13 the hub is in it too ([`hub-link-spec.md`](hub-link-spec.md)).

**The group is named `voice-link`** since MT Utils 2.2.0 (it was Link), the same name as the
hub's voice chat it is joined to. The word "Link" alone is not used for it any more.

A shared Simple Voice Chat (SVC) room across two Minecraft servers (MacroTech Survival and
MacroTech Creative). Background research is in the same folder: `plugins-and-bridge.md`. The
SVC source facts below were checked against the `1.21.11` branch of SVC (mod 2.6.24).

## Rule this design follows

**We never touch audio.** SVC does capture, noise handling, the codec and playback, end to end.
The link only carries SVC's own Opus packets from one server to the other, untouched. There is no
decoding, mixing, re-encoding, gain or bitrate setting anywhere in our code. Audio has to be a
complete drop-in system.

## What players see

1. Each server has a permanent SVC group called **voice-link** (not deleted when it's empty). Players
   join it from SVC's normal group screen, the same as any other group.
2. Everyone in voice-link on Survival hears everyone in voice-link on Creative, and the other way round.
   Players in voice-link on the same server hear each other the normal SVC way.
3. Voices from the other server play non-positionally, like group voice. In SVC's **Adjust
   volumes** screen they're under one entry per server, e.g. "Survival (voice-link)", with its own
   volume slider.
4. When you join voice-link you get a chat line listing who is in it on the other server, e.g.
   `voice-link: Eldridge, Lennox on Survival`. You also get a chat line whenever someone on the other
   server joins or leaves voice-link.
5. If the relay is down, voice-link keeps working on each server by itself. The chat line says
   `voice-link: Survival not connected`.

**SVC limit:** remote speakers can't show up in SVC's group list or speaking icons. That list
only holds players on the same server, and the API can't add others to it. Point 4 is the
replacement. There is no action-bar "who's talking" line.

## Pieces

```
Survival: SVC + MT Hub Server ──wss──┐            ┌──wss── Creative: SVC + MT Hub Server
                                  └─ voicelink relay ─┘
                     (reverse proxy: /voicelink → the relay's local port)
```

1. **SVC 2.6.24** on both servers and on every client that wants voice. Server config:
   `port=` the voice port the host forwards to the server. Leave `bind_address` blank and
   `force_voice_chat=false`. Everything else stays at
   SVC's defaults. Never use `port=-1`; the SVC wiki warns it can crash the server.
2. **Link plugin**, a feature of **MT Hub Server**, the server-only jar of the MT Hub mod
   ([`mthub-mod`](https://github.com/grandpaul2/mthub-mod)). It turns on only when SVC is
   installed and `voice_link` is set in
   `config/mthub.json`. This is the same pattern as the WaterFrames aliases. Players need
   nothing from us beyond SVC.
3. **`voicelink` relay**, a small Go program on a public server (`cmd/voicelink` in this repo,
   since the
   hub backend is Go). It runs on a machine with a good public connection, behind the reverse
   proxy that already serves the hub, not behind a home connection that every packet would
   have to cross.

## Link plugin (MT Hub Server)

Registered through SVC's Fabric entrypoint `"voicechat"`, compiled against `voicechat-api`
only (the mod itself is All Rights Reserved; the API is published for plugins).

1. **Group:** on `VoicechatServerStartedEvent`, create the voice-link group with `groupBuilder()`:
   name `voice-link`, persistent, type `NORMAL` (SVC's default type), no password. Keep the same group
   id across restarts (a fixed UUID in config).
2. **Members:** track local voice-link members with `JoinGroupEvent`, `LeaveGroupEvent` and
   `PlayerDisconnectedEvent`. Send each change to the relay. Show the remote roster as chat
   lines (What players see, point 4).
3. **Outbound audio:** in `MicrophonePacketEvent`, if the sender's group is voice-link, put
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
   - Targets are the current local voice-link members.
   - A frame is sent with `channel.send(opus)`. An empty frame is sent with `channel.flush()`,
     which ends the stream cleanly on every client.
   - Safety net: if a remote speaker sends nothing for 500 ms, `flush()` anyway, in case the
     end packet was lost. Drop the channel after 60 s of silence.
5. **Ordering:** SVC numbers packets per channel by itself, and each client buffers and
   reorders them (`AudioChannel`, `AudioPacketBuffer`). The relay connection is TCP, so packets
   arrive in order and none are lost. The client's normal buffer smooths delay.

## Relay protocol

One WebSocket per game server: `wss://<hub address>/voicelink`, header
`Authorization: Bearer <link token>`. The relay knows each token's server name, so a server
can't pretend to be the other one. Messages are binary, with the type in the first byte:

| Type | Direction | Body |
|---|---|---|
| `1` audio | server → relay → other servers | speaker uuid (16 bytes) + Opus bytes (empty = stopped) |
| `2` roster | both ways | JSON `{"members":[{"uuid","name"}]}`, the full list on every change |
| `3` status | relay → server | JSON `{"servers":["survival","creative"]}`, sent on any connect or disconnect |

The relay adds the source server name to everything it forwards. Each speaker's audio is about
2–4 KB/s.

## Relay

1. Listens on a local port only, and the reverse proxy forwards `/voicelink*` to it, so no new
   firewall port and no new certificate are needed.
2. Config is a JSON file of tokens and the server each one names:
   `{"tokens": {"<token>": "survival", ...}}`. A token is a long random string.
3. The relay holds no state beyond the open connections and the last roster from each server.
   A restart only drops speech for the second it takes to reconnect.
4. The plugin reconnects with backoff (1 s, doubling to 30 s) and resends its roster.
5. It logs connects and disconnects only, never audio.

## Config (`config/mthub.json` of the MT Hub Server mod)

```json
"voice_link": {
  "url": "wss://<hub address>/voicelink",
  "token": "",
  "group_id": "<fixed uuid>"
}
```

If the key is missing or the token is empty, the feature is off and Link isn't created.

### Server rooms

```json
"voice_room": "Survival"
```

Each server also has its own permanent room, named after the server (**Survival**,
**Creative**), for talking without the other server. It is a plain SVC group (persistent, type
`NORMAL`, no password) that never touches the relay, and it works with voice-link off. Its id is
derived from the name, so nothing is stored. Empty or missing means no room. A player is in one
SVC group at a time, so being in a server room means not being in voice-link.

## Security

- Only the two game servers hold link tokens; players never see one.
- The relay accepts nothing without a token, and forwards only between authenticated servers.
- Anyone on a server can join voice-link and so be heard on the other server. That's the same trust
  as joining the server itself. A password on the group is a config option if that ever changes.

## Failure cases

| What breaks | Result |
|---|---|
| Relay down | voice-link works on each server separately; chat line says the other server isn't connected |
| One game server down | The other server's voice-link players see the roster empty |
| SVC missing on a server | MT Hub mod runs as today; no voice-link group |
| Player without SVC on their client | No voice for them (SVC's normal behaviour) |

## Not in scope

- Hub and web users in the room. That would need decoding and re-encoding, which breaks the rule
  above. It comes back only if a finished component does it.
- Recording, radios and other SVC addons.
