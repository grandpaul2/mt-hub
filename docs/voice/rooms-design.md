# Hub voice chats: agreed design

**Status:** built and live in S45 (mt-hub `64df87e`; Mic Test `b4ba713`; pluck sounds `b6f2282`). How it's run: `~/mt-hub/README.md` → Voice chats; VPS side: `server/relay/README.md`.

Changes after the first design: the speaking lights fire at −55 dBov (LiveKit `active_level: 55`), because quiet mics had to yell. Sound effects are soft two-note plucks, chosen by ear on Paul's wireless BH300: pure tones and slides buzzed through it. Voice Settings is also in the menu on your name, with Mic Test.

Agreed with Paul. The audio choices come from the research and the lab (`README.md` in this folder).

## What people see

- **No permanent rooms.** CHATS' "+" menu gets **New Voice Chat** and **New Private Voice Chat…**; the second uses the same member picker as private chats.
- **A voice chat has no name.** It's the list of people in it, in join order, shown in CHATS under the text chats and above the DMs. Whoever is at the top labels it; when that person leaves, the next one moves up. A name lights up while that person is talking.
- **Lifetime:** it lasts until the last person leaves.
- **Joining:** click a voice chat you can see. You're in one at a time; joining another moves you.
- **Private voice chats:** only the invited people see them, not admins and not the owner. The starter can invite more later from the right-click menu.
- **Limits:** at most 3 voice chats at once. When there are 3, "New Voice Chat" is greyed out with a tooltip. No cap on people per chat.
- **While in one:** a bar at the bottom of the sidebar, Discord style, with mute, deafen, leave and a settings gear. The gear holds:
  - mic choice
  - mic level (quiet mics: Paul's ATR2100x peaks at −31 dBFS)
  - noise filter on/off
  - voice gate sensitivity
  - echo cancellation, off by default (Firefox's chops up voices on headphones)

## How it works

**LiveKit:**
- Runs on the relay VPS, as one binary plus a Caddy route on `macrotechmc.com` (no DNS change).
- Needs about 100 UDP ports and one TCP port opened on the VPS (Paul OK'd).

**The hub owns the voice chats:**
- Who exists, who may see and join each one, and the invite lists. Only invited people see a private one.
- It hands out short-lived LiveKit tokens.
- LiveKit's webhooks tell it who joined or left. The sidebar updates live over the existing events stream, filtered by who may see each chat. An empty chat is removed.

**The audio chain in the browser:**
1. Microphone, with echo cancellation, noise suppression and auto gain all off by default.
2. Gain.
3. DeepFilterNet3, with RNNoise as the fallback.
4. Silero speech gate, holding back about 100–200 ms (tune it: the delay budget is about 150 ms mouth to ear).
5. Published to LiveKit as Opus mono with FEC and DTX.

**When the filters load:** only on first joining voice.
