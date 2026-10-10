# Simple Voice Chat: plugins, Discord bridge, and a cross-server link

Research date 2026-10-09. Read-only research; nothing installed or touched.
Items marked **(unverified)** came from search summaries or reasoning, not from source I read.

## 1. Simple Voice Chat (SVC) basics

- **Latest for us:** Fabric `1.21.11-2.6.24`, published 2026-09-20 ([Modrinth API](https://api.modrinth.com/v2/project/simple-voice-chat/version)). Upstream `master` has moved to MC 26.3 and Java 25 ([gradle.properties](https://github.com/henkelmax/simple-voice-chat/blob/master/gradle.properties)); the 1.21.11 line stays on the older toolchain.
- **License:** the mod is "All Rights Reserved" ([fabric.mod.json](https://github.com/henkelmax/simple-voice-chat/blob/master/fabric/src/main/resources/fabric.mod.json)). The API is meant for third parties; our plugin only depends on the API jar, so that is fine. We cannot copy mod internals.
- **Client:** players need the SVC mod (same major version as the server). No client mod, no voice. Server can set `force_voice_chat` to kick players without it.
- **Server config** (`config/voicechat/voicechat-server.properties`, [wiki](https://modrepo.de/minecraft/voicechat/wiki/server_config)):
  - `port=24454` (UDP). Separate from the game's TCP port. `-1` shares the Minecraft port, but the wiki says it can crash the server; it is for dedicated servers only.
  - `bind_address` blank = use `server-ip`; `voice_host` = the host(:port) clients are told to use (needed when the public UDP port differs from the internal one).
  - `codec=VOIP` (alternatives `AUDIO`, `RESTRICTED_LOWDELAY`), `mtu_size=1275`, `keep_alive=1000` ms, `enable_groups=true`, `max_voice_distance=48`, `allow_recording`, `force_voice_chat`.
  - There is **no bitrate setting**. Source shows fixed 48 kHz, mono, 20 ms frames (960 samples), max Opus payload 1275 bytes ([AudioUtils](https://github.com/henkelmax/simple-voice-chat/blob/master/common/src/main/java/de/maxhenkel/voicechat/voice/common/AudioUtils.java), [OpusManager](https://github.com/henkelmax/simple-voice-chat/blob/master/common/src/main/java/de/maxhenkel/voicechat/natives/OpusManager.java)). The codec setting only picks the libopus "application" (VOIP / AUDIO / LOW_DELAY).
- **Hosting caveat for DatHost:** SVC needs an extra public UDP port per server. I found no DatHost-specific guide; generic advice is "ask the host for an extra UDP allocation, or use `port=-1`" ([general guide](https://physgun.com/help/game-hosting/minecraft/how-to-use-simple-voice-chat-in-minecraft/)). **Open question to settle with DatHost first:** can each server get a UDP port (then set `port`, maybe `voice_host`)? If not, `port=-1` is the fallback and has crash risk. Since you said voice already works elsewhere, check what the panel offers.
- **Proxy support:** an official Velocity/BungeeCord plugin gives one public UDP port for many backends and detects each backend's voice port ([proxy config](https://modrepo.de/minecraft/voicechat/wiki/proxy_config), [proxy setup](https://modrepo.de/minecraft/voicechat/wiki/proxy_setup)). It is networking only: each player is on one backend at a time. We have no proxy, so this is irrelevant unless you add one.
- **Groups:** players create/join groups in the GUI (name, optional password). Types: `NORMAL` (group members also hear nearby non-group players, not vice versa), `OPEN` (both ways), `ISOLATED` (only group members). Groups can be persistent (survive empty) and hidden, via the API ([Group.java](https://github.com/henkelmax/simple-voice-chat/blob/master/api/src/main/java/de/maxhenkel/voicechat/api/Group.java)). Groups are per server; there is no built-in cross-server group.

## 2. The plugin API (voicechat-api)

- **Fabric entrypoint:** a mod declares `"entrypoints": {"voicechat": ["your.Plugin"]}` in `fabric.mod.json`; the class implements `de.maxhenkel.voicechat.api.VoicechatPlugin` (`getPluginId`, `initialize`, `registerEvents`). The kaelvanzz Fabric bridge uses exactly this ([repo](https://github.com/kaelvanzz/voice-bridge-fabric)). The API pages are at [modrepo.de/.../api](https://modrepo.de/minecraft/voicechat/api) (Overview, Getting Started, Your Plugin, Registering Events, Javadocs). Same plugin interface works on Bukkit, Fabric, Forge, etc.
- **Receiving audio:** `MicrophonePacketEvent` (player's mic, before SVC distributes it; `getSenderConnection()`, `getPacket()`; cancellable). `MicrophonePacket` gives `getOpusEncodedData()`, `isWhispering()`, `toStaticSoundPacket()`. Also `EntitySoundPacketEvent`, `LocationalSoundPacketEvent`, `StaticSoundPacketEvent` (what is about to be sent to a player). The `PlayerAudioListener` (built with `api.playerAudioListenerBuilder().setPacketListener(...)`) hears everything a given player would hear. ([API source](https://github.com/henkelmax/simple-voice-chat/tree/master/api/src/main/java/de/maxhenkel/voicechat/api))
- **Sending audio:** `VoicechatServerApi` offers
  - `createStaticAudioChannel(UUID)` (non-positional; `addTarget(connection)`, `removeTarget`, `clearTargets`, `setBypassGroupIsolation`),
  - `createEntityAudioChannel`, `createLocationalAudioChannel`,
  - `AudioChannel.send(byte[] opus)` / `send(MicrophonePacket)` / `flush()`,
  - `sendStaticSoundPacketTo(connection, packet)` (used by the official [broadcast plugin](https://github.com/henkelmax/voicechat-broadcast-plugin) to re-send a mic packet to everyone),
  - `createAudioPlayer(channel, encoder, Supplier<short[]>)` to play PCM,
  - `createAudioSender(connection)` + `registerAudioSender` to inject audio **as** a real player.
- **Opus:** `api.createEncoder(OpusEncoderMode)` / `createDecoder()`: `encode(short[])` (one 960-sample frame), `decode(byte[])` -> `short[]`, `decode(null)` for packet loss concealment.
- **Groups API:** `createGroup(name, password, persistent)`, `groupBuilder()` (id, name, password, persistent, hidden, type), `removeGroup`, `getGroups`, `connection.getGroup()/setGroup(...)`. Events: `CreateGroupEvent`, `JoinGroupEvent`, `LeaveGroupEvent`, `RemoveGroupEvent`. Other events: `PlayerConnectedEvent`, `PlayerDisconnectedEvent`, `PlayerStateChangedEvent`, `VoicechatServerStartedEvent`, `VoiceHostEvent`, `VoiceDistanceEvent`.
- **Net result:** everything needed for a link plugin exists in the public API. No mixins into SVC needed.

## 3. Discord bridge plugin(s)

Main one: **Simple Voice Chat Discord Bridge** by amsam0 (formerly naturecodevoid). Fabric (1.16.5 to 1.21.11, plus 26.x folders) and Paper/Purpur, MIT, needs SVC >= 2.4.11 and Fabric API. Source on [GitLab](https://gitlab.com/amsam0/voicechat-discord), issues/releases on [GitHub](https://github.com/amsam0/voicechat-discord), [Modrinth](https://modrinth.com/plugin/simple-voice-chat-discord-bridge).

**How it works** (read from source: `core/src/main/java/.../DiscordBot.java`, `core/src/main/rust/discord_bot/*.rs`):
- Mixed Java + **Rust** (native lib via JNI). Discord side uses Rust `serenity` + `songbird`; decoding with `opus2`.
- The "bot" is a Discord bot in a voice channel; a **real in-game player** runs `/dvc start` and that player's SVC connection is the endpoint.
- **SVC -> Discord:** a `PlayerAudioListener` on that player receives every sound packet they would hear (entity, locational, static). Each packet is Opus-decoded per sender (one decoder per sender), volume scaled by distance, buffered, **mixed** (`combine_audio_parts`) and handed to songbird as raw PCM; songbird re-encodes for Discord.
- **Discord -> SVC:** songbird's VoiceTick gives the raw Opus RTP payload of **only the first speaker** in the tick; a Java thread feeds it to an `AudioSender` registered for that player, so SVC treats it as the player's own mic. No decode/mix on this path (cheap), but only one speaker at a time works. Their README: more than one person speaking causes "weird audio glitches", so limit bot channels to 2 users.
- Players/groups: one bot = one Discord user = one linked player. Groups are managed via `/dvc group create/join/list/remove` (so a Discord-linked player can sit in a group via `JoinGroup`/`LeaveGroup` events in `GroupManager`).
- Latency/quality: not documented; extra hop through Discord plus decode/mix/re-encode. Known quality problems: single-speaker limit, glitches on overlap, resets of senders after silence (a reset thread every 500 ms).
- Other related projects: [TripleOh7/voicechat-discord-discordsrv](https://github.com/TripleOh7/voicechat-discord-discordsrv) (a variant), [CrossTalk](https://github.com/craftedkind54-netizen/crosstalk-bedrock-voice-bridge) (Paper plugin + browser voice for Bedrock players; browser <-> SVC, so a precedent for web users), [PfauMC/voice-bridge](https://github.com/PfauMC/voice-bridge) and its [Fabric port](https://github.com/kaelvanzz/voice-bridge-fabric) (SVC <-> Plasmo Voice, MIT, 1.21.11 only, proximity only, Opus passthrough with no transcode: "audio.passthrough").

**Lesson for us:** the Discord bridge needs decode+mix+Rust only because Discord has one mixed stream per bot and its own codec. Between two SVC servers both sides are Opus 48k mono 20 ms, so we can forward Opus frames untouched and let each SVC client mix.

## 4. Cross-server voice for SVC: what exists

- **Velocity/Bungee proxy plugin** (official): single UDP port, no shared groups ([wiki](https://modrepo.de/minecraft/voicechat/wiki/proxy_setup)). Predecessor [nilathedragon/simple-voice-chat-velocity](https://github.com/nilathedragon/simple-voice-chat-velocity), now adopted upstream.
- **Cross-server groups:** my searches found **no existing plugin** that bridges SVC groups between separate servers. Closest are the voice-bridge projects (one server, different mods) and the Discord bridge.
- **Plasmo Voice comparison:** it has a proxy install mode (Velocity/Bungee plugin) and add-ons that run on the proxy; [pv-addon-groups](https://plasmovoice.com/docs/server/proxy/) works across servers when installed on the proxy, and [pv-addon-broadcast](https://github.com/plasmoapp/pv-addon-broadcast) can broadcast to all servers on the proxy. So Plasmo has cross-server groups, but only behind a proxy (our two servers are separate DatHost boxes with no proxy). Switching mod would also mean new clients, so it is not a reason to change.
- **Built vs. to write:** built = Opus, groups, audio channels, plugin loading, per-player UDP/encryption. To write = the relay protocol, a relay service, the Fabric plugin, group<->room mapping.

## 5. Other SVC addons worth knowing (one line each)

- [Enhanced Groups](https://github.com/henkelmax/enhanced-groups) (henkelmax): server-side group improvements.
- [Sound Physics Remastered](https://modrinth.com/user/henkelmax): reverb/occlusion for sound (doesn't touch voice much).
- [Voice Chat Recording](https://modrinth.com/mod/voice-chat-recording) / Replay Voice Chat: record player voices (SVC also has built-in recording).
- Voice Messages: voice clips in chat.
- Simple Voice Chat Radio, Simple Radio, Walkie-Talkie, Super Simple Voice Radio, Wiretap: radio/frequency/microphone-speaker blocks.
- [Broadcast plugin](https://github.com/henkelmax/voicechat-broadcast-plugin) (henkelmax): group named "broadcast" is heard server-wide; official API example.
- Voice Chat Interaction / Voiceless Survival: voice triggers sculk sensors / mobs.
- Curated list: [Modrinth "Simple Voice Chat Addons"](https://modrinth.com/user/henkelmax) (67 projects).

## 6. Design sketch for our link

### Shape
```
Survival (Fabric+SVC)                               Creative (Fabric+SVC)
 link-plugin  <--- WebSocket/TCP (TLS) --->  relay (VPS)  <--- WebSocket/TCP (TLS) ---> link-plugin
```
The relay is a plain network service, **not** an SVC server. Players only ever talk SVC to their own game server.

### Game-server plugin (Java, Fabric, `voicechat` entrypoint, API-only dependency)
1. On start create a persistent group, e.g. "Link" (type `ISOLATED`, optional password), via `groupBuilder()`.
2. **Outbound:** `MicrophonePacketEvent`: if `getSenderConnection().getGroup()` is the Link group, copy `getOpusEncodedData()` plus sender UUID/name and a frame counter to the relay. Do **not** cancel the event, so local members still hear each other normally.
3. **Inbound:** per remote speaker create one `StaticAudioChannel` (stable UUID per remote player); targets = current local Link members (maintain via `JoinGroupEvent`/`LeaveGroupEvent`, `addTarget`/`removeTarget`); `channel.send(opusBytes)` for each frame. Each remote player becomes a separate voice, with their own volume control in the SVC UI (name via a display category or volume category, unverified).
4. Empty silence: when a speaker stops, the SVC client expects the stream to end; may need `flush()` or a short pause detection (test).

### Encoding / mixing
- Both ends are Opus 48 kHz mono 20 ms, so forward the Opus frames **untouched**, about 2 to 4 KB/s per active speaker. **No server-side mixing**: each SVC client already mixes separate channels in OpenAL. This avoids the Discord bridge's "one speaker at a time" limit.
- Only needed if bridging to something that wants one mixed stream (Discord-style): decode via `api.createDecoder()` per sender, sum PCM with clipping, re-encode (`createEncoder`). Not needed for SVC-to-SVC.

### Latency
- DatHost Dallas to Vultr Dallas is a few ms. Expect +20 to 60 ms total (one 20 ms frame, jitter buffering, relay hop). Fine for speech. (estimate)
- Keep it UDP-like: TCP/WebSocket head-of-line blocking can cause bursts after packet loss. A small relay-side UDP or QUIC channel with a sequence number is better; start with WebSocket for simplicity since both ends are in one datacenter region (unverified how much loss there is).
- Test: whether `AudioChannel.send(byte[])` assigns sequence numbers and how the client jitter buffer reacts to bursty arrival (I did not read this code path).

### Reusable code
- [voicechat-broadcast-plugin](https://github.com/henkelmax/voicechat-broadcast-plugin): the skeleton for "MicrophonePacketEvent -> filter by group name -> forward". (Note: its plugin is Bukkit; the event API is the same.)
- [voice-bridge-fabric](https://github.com/kaelvanzz/voice-bridge-fabric) (MIT): Fabric `voicechat` entrypoint, `AudioRelay`/`SessionManager` structure, Opus passthrough. Closest working template for a Fabric 1.21.11 server plugin.
- [Discord bridge](https://gitlab.com/amsam0/voicechat-discord) (MIT): `PlayerAudioListener`/`AudioSender` pattern, group management, per-sender decoder and mixing code if we ever need a mixed output. Its Rust parts are not needed.
- Our own: the mt hub and MT Hub mod already have a server credential model (the server holds one hub token and does every hub call for its players); the relay can reuse the same single-server-token approach, and the plugin could ride the MT Hub mod rather than being a new mod (decide later).

### Relay (VPS)
- Small service (Node or Go): authenticates each game server with a token, keeps the room, forwards each frame from one server to the others (and, later, to web clients). No audio processing. A few hundred lines.

### Later: web/phone users via LiveKit (feasibility only)
- Feasible. The relay would act as a LiveKit participant per remote Minecraft speaker (publish) and subscribe to the room for incoming browser audio. LiveKit's server SDKs (Go, Node `@livekit/rtc-node`) deal in PCM frames, so this path needs decode (Opus to PCM) outbound and encode (PCM to Opus, one mixed or per-speaker stream) inbound: the first place we do need `OpusDecoder`/`OpusEncoder` equivalents (libopus in Go/Node). Browser audio into SVC would arrive as a static channel the same way as remote players. CrossTalk is a precedent for browser <-> SVC ([repo](https://github.com/craftedkind54-netizen/crosstalk-bedrock-voice-bridge)). Audio rate matches (LiveKit Opus is 48 kHz, mono is fine).

### Risks and open items
1. DatHost extra UDP port for SVC on both servers (blocker if refused).
2. Players must have SVC installed: replaces the browser voice for in-game users; hub voice stays as a separate option.
3. Mod licensing: depend on the API only.
4. Verify on a throwaway server (recipe: `reference_throwaway_test_server` in project memory): jitter/sequence behavior, speaker end-of-stream, 2+ simultaneous remote speakers, group joins/leaves, plugin restart while players are in the group.
5. Spoofing: only the relay-authenticated game server may inject; per-player mute/permissions go through the Link group's password or an op-gated join (SVC fabric-permissions-api is "suggested").
