# Voice rooms: transport / server side

Researched 2026-10-03. Web research only. "(unverified)" marks claims I did not confirm in a primary source.

## 1. Verdict

Run **LiveKit (self-hosted OSS, single Go binary, no Redis) on the Vultr VPS**, behind the existing Caddy for signalling and with its built-in TURN. The hub mints short-lived LiveKit JWTs after checking the session cookie.
Runner-up: **Galene** (smaller, one binary, its own token auth) if LiveKit feels too heavy.
Mesh is viable for audio only at 2-8 users, but you would need TURN anyway and screen share later would not work well.
Do **not** run media on the home server behind the ssh tunnel.

## 2. Comparison

| Option | Audio-only scale | Resources / ops | Firefox | Opus DTX / FEC / RED | Screen share later | Auth with cookie login |
|---|---|---|---|---|---|---|
| Mesh WebRTC (hub signals) | 6-10 peers is the rough audio-only ceiling (blog consensus, no hard number). Upload is (N-1) x ~40-50 kbps, so 8 users is about 300-350 kbps up (my arithmetic). Connections grow as N^2. | No media server. Still needs STUN/TURN, and any failed pair is an N^2 failure. Little code to write, a lot of edge cases (glare, reconnects, ICE restarts). | Works; the standards-based path is the best tested. | Browser-native: set `usedtx` / `useinbandfec` in SDP fmtp. RED needs manual work (unverified in Firefox). | Poor: every viewer costs the sharer an extra video upload. | None needed beyond the hub WebSocket. |
| **LiveKit OSS** | Built for large rooms. Their audio benchmark: 10 speakers + 3,000 listeners on one 16-core instance. 8 users is trivial. | One Go binary, YAML config. Redis is "recommended for production" for multi-node only; single node works without it. Needs 7880 (WS), 7881 (ICE/TCP), UDP range or single mux port 7882, TURN 3478/5349. | Supported by livekit-client. Open issues exist (Firefox connecting to a self-host, livekit#4359, Mar 2026; AV1 subscriber bug in Firefox 155+ with a fix in PR #2120). Neither is an audio problem. | `dtx` and `red` are publish options, on by default for mono. Server has RED downtrack support. FEC is browser Opus in-band. | First class (simulcast, track subscribe). Nothing to rebuild. | HS256 JWT with API key/secret; hub signs with `livekit/server-sdk-go`, with room and identity grants. |
| Galene | Designed for small to medium groups. Needs "very moderate" resources. Exact numbers not verified. | One static Go binary, no Redis. 8443/TCP, built-in IPv4-only TURN on 1194 TCP+UDP, UDP range restrictable with `-udp-range`. | Primary development target is Firefox-friendly (unverified). | Audio passthrough as plain RTP, so Opus DTX/FEC work end to end. RED unverified. | Yes, built in. | External portal or auth server issues a signed JWT (30 s expiry) via the protocol. Cookie check in the hub, then redirect with token: fits well. Client is Galene's own JS (not an SDK) with a documented protocol. |
| mediasoup | Excellent (C++ workers). | A Node/Rust library, not a server. You write the signalling, rooms, auth. Most work. | Historic Firefox bugs (2017-2019), none current found. | DTX supported (OpenVidu 3.8 notes). | Yes. | Whatever you write. |
| Janus | Good. | C, GPL-3.0, plugin config, more moving parts (videoroom/audiobridge plugins). | Fine. | Configurable. | Yes. | Own token mechanism. |
| Pion custom SFU (Go) | Fine for 8 users. | Same language as the hub. You own signalling, renegotiation, reconnect, bandwidth estimation. pion/webrtc is very active (v4.2.22, Sep 2026). **ion-sfu**: last release 2021-11, last push 2023-07: unmaintained, avoid. | Depends on your code. | Passthrough easy; RED manual. | You build it. | Native in the hub (reuses the session). |
| MediaMTX (already on the VPS) | Built for one-to-many streaming (WHIP/WHEP), not conferencing. | Already deployed. | OK. | n/a | Possible for streaming only. | n/a |

## 3. Notes by area

### Mesh
- Pros: no new server, hub signals over its existing WebSocket. Keeps latency lowest on a good direct path.
- Cons: some pairs behind symmetric NAT or CGNAT need TURN, so you must run coturn or equivalent anyway. Each client encodes and sends N-1 copies. Screen share later is where mesh fails. Chrome peer-connection limit of 10 came from an old forum thread (unverified now).
- With 8 users the audio bandwidth is fine. The risk is reliability and code you must maintain, not bandwidth.

### SFU choice
- LiveKit: biggest ecosystem, official JS SDK for plain JS (`livekit-client` UMD or ESM), Go server SDK for token minting, built-in TURN, Apache-2.0. v1.13.7 on 2026-09-14, active. Cost: the largest surface of config and a client SDK dependency.
- Galene: closest to the owner's "fewest layers": one binary, files for config, JWT auth fits an existing login. Maintained by Juliusz Chroboczek (last push 2026-09-25). Smaller community, no official SDK, TURN IPv4 only.
- ion-sfu: stale. mediasoup/Janus: too much glue for the size of this project.

### TURN / STUN
- LiveKit's TURN is embedded and uses the same API credentials. Defaults: UDP 3478 (also STUN), TLS 5349, `domain:` required for TLS, and it needs its own certificate in the LiveKit config (it cannot sit behind a TLS-terminating proxy).
- LiveKit docs say TURN/TLS on **443** has the broadest reach (corporate firewalls). Caddy already owns 443 on the VPS, so options are: (a) accept 5349 and 3478 only (some strict networks fail); (b) use a second IP or subdomain on a second address for 443 TURN; (c) Caddy layer4 SNI routing (a plugin, unverified for this setup). Recommended: start with (a). For 5-15 friends this is almost always enough.
- Alternative is coturn (mature, 4.18 docker release 2026-09-08) as a separate daemon. Only worth it for the mesh option. Galene's built-in TURN is IPv4-only.

### UDP vs TCP through Caddy
- Caddy proxies HTTP/WebSocket only. Media must **not** go through Caddy.
- Signalling WebSocket: Caddy `reverse_proxy localhost:7880` (WebSocket proxying is automatic).
- Media: UDP direct to the VPS public IP. Fallbacks: ICE/TCP 7881 (direct), TURN/TLS 5349. TCP media is worse for latency (head-of-line blocking) but fine as a last resort.

### Ports to open on the VPS (LiveKit)
| Port | Proto | Use |
|---|---|---|
| 443 | TCP | Caddy (already open): site + signalling WS |
| 7881 | TCP | ICE/TCP fallback |
| 7882 | UDP | single-port ICE mux (use instead of the 50000-60000 range; simpler firewall) |
| 3478 | UDP | TURN + STUN |
| 5349 | TCP | TURN/TLS |
| 7880 | TCP | **localhost only**, behind Caddy |

Set `rtc.use_external_ip: true` (or `node_ip`) so ICE candidates carry the VPS address. Vultr has no default cloud firewall on instances; use ufw/nftables.

### VPS bandwidth and CPU (my estimates, not measured)
- One speaker's Opus voice, 24-32 kbps plus RTP/IP overhead is about 40-50 kbps. With RED on, expect roughly double on the wire for that stream (RED is redundancy, "costs more bandwidth" per LiveKit).
- A room of 8 with 2 people talking at once (DTX mutes silence): outgoing is about 8 listeners x 2 talkers x 50 kbps, well under 1-2 Mbps. Worst case, all 8 talking: 8 x 7 x 50 kbps = 2.8 Mbps out, 0.4 Mbps in.
- Even 15 users in one room all talking is under about 10 Mbps. Monthly transfer for typical use is a few GB. CPU is negligible (an SFU forwards packets, it doesn't transcode). A 1 vCPU / 1 GB VPS is enough for audio; screen share (video, e.g. 2-4 Mbps per viewer) is what will raise bandwidth.
- Existing MediaMTX load on the same box is the unknown; check its current CPU and transfer usage first.

### Where media runs
- **VPS (public IP)**: media takes the shortest path from each client: client to VPS and back. Typical added latency is the client-VPS RTT only.
- **Home server behind NAT, tunnelled**: an ssh tunnel is TCP. It would force media into TCP with head-of-line blocking and add the VPS to home leg both ways (client to VPS to home to VPS to client for every packet), plus the home upload and NAT. WireGuard UDP would remove the TCP problem but keeps the extra hop. Not recommended.
- Keep the hub (signalling, tokens, presence) on the home server as today. Only the SFU lives on the VPS. The hub reaches it for admin API (`RoomService`, e.g. to kick/mute) via localhost-bound port over an outbound tunnel or by calling its HTTPS API through Caddy (e.g. protected path). Choose one at implementation time.

### Auth with the existing session cookie
1. Browser calls `POST /api/voice/token?room=X` to the hub (cookie sent).
2. Hub verifies the session and the user's right to the room, then signs a LiveKit JWT (identity = username, room, `canPublish`, `canSubscribe`, TTL ~10 min) with `livekit-server-sdk-go`.
3. Browser connects to `wss://macrotechmc.com/rtc` (or a `lk.` subdomain) with that token.
- The LiveKit API key/secret live in the VPS `livekit.yaml` and in the hub config. Never sent to the browser.
- Bans: hub refuses tokens; for instant removal call RoomService `RemoveParticipant`.
- Galene equivalent: hub acts as the authentication portal and redirects with a JWT; 30 s expiry per the protocol doc.

### Firefox
- No known Firefox audio bug in LiveKit or mediasoup found. The Firefox issues seen were AV1 (video, matters for later screen share; fix PR #2120) and one self-host connection report (livekit#4359). Test early with Firefox on Linux with the real VPS, including Firefox's `media.peerconnection.ice.*` defaults and any `privacy.resistFingerprinting` or mDNS setting that hides candidates (unverified relevance).
- Screen share later: restrict the video codec to VP8/H.264 for Firefox to avoid AV1 issues.

## 4. Biggest risks
1. TURN/TLS on 443 clashes with Caddy on the same host. Without it some restrictive networks cannot connect. (Mitigation above.)
2. LiveKit surface area (config, SDK versioning) vs the owner's "fewest layers" preference. Galene is the fallback.
3. Not yet measured: the VPS's current MediaMTX load and monthly transfer cap.
4. Firefox behaviour with the self-hosted setup (livekit#4359): test before committing.

## 5. Sources
- LiveKit repo: https://github.com/livekit/livekit (v1.13.7, 2026-09-14, via `gh api`)
- LiveKit deployment: https://docs.livekit.io/transport/self-hosting/deployment/
- LiveKit ports and firewall: https://docs.livekit.io/transport/self-hosting/ports-firewall/
- LiveKit benchmark: https://docs.livekit.io/transport/self-hosting/benchmark/
- LiveKit sample config: https://raw.githubusercontent.com/livekit/livekit/master/config-sample.yaml
- LiveKit audio RED / DTX: https://docs.livekit.io/recipes/audio-red/ and https://github.com/livekit/client-sdk-js/pull/470
- LiveKit Firefox: https://github.com/livekit/livekit/issues/4359 , https://github.com/livekit/client-sdk-js/issues/2116 , https://github.com/livekit/client-sdk-js/pull/2120
- Galene install: https://galene.org/INSTALL.html ; protocol: https://galene.org/galene-protocol.html ; repo https://github.com/jech/galene
- ion-sfu (stale): https://github.com/ionorg/ion-sfu
- pion/webrtc: https://github.com/pion/webrtc ; pion/turn: https://github.com/pion/turn
- mediasoup: https://github.com/versatica/mediasoup ; DTX note: https://openvidu.io/latest/docs/releases/
- Janus: https://github.com/meetecho/janus-gateway
- coturn: https://github.com/coturn/coturn
- MediaMTX: https://github.com/bluenviron/mediamtx
- Mesh limits (secondary, rough): https://groups.google.com/g/discuss-webrtc/c/Kvv2LfSr1jY , https://antmedia.io/webrtc-network-topology/ , https://trembit.com/blog/how-many-participants-can-we-place-in-one-webrtc-peer-2-peer-room/
