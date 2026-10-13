# Hub voice chats: design

**Status:** current spec, built. How the hub runs it:
[`../voice-and-streams.md`](../voice-and-streams.md).

The speaking lights fire at −55 dBov (LiveKit `active_level: 55`), because quiet mics had to
yell. Sound effects are soft two-note plucks, chosen by ear: pure tones and slides buzzed
through a wireless headset. Voice Settings is in the menu on your name, with Mic Test.

The audio choices come from the research and the lab (`README.md` in this folder).

## What people see

- **No permanent rooms.** VOICE's "+" menu has **New Voice Chat** and **New Private Voice
  Chat…**; the second uses the same member picker as private chats. (Until 2026-10-13 they
  were in the chats' "+" menu, because VOICE was only in the sidebar while in use.)
- **A voice chat has no name.** It's the list of people in it, in join order, shown under
  VOICE, a section of the sidebar that is always there. Whoever is at the top labels it; when that person
  leaves, the next one moves up. A name lights up while that person is talking.
- **Lifetime:** it lasts until the last person leaves.
- **Joining:** click a voice chat you can see. You're in one at a time; joining another moves you.
- **Private voice chats:** only the invited people see them, not admins and not the owner. The
  starter can invite more later from the right-click menu.
- **Limits:** at most 3 voice chats at once. When there are 3, "New Voice Chat" is greyed out
  with a tooltip. No cap on people per chat.
- **While in one:** a bar at the bottom of the sidebar, Discord style, with mute, deafen, leave
  and a settings gear. The gear holds:
  - mic choice
  - automatic level, on by default (the browser's own automatic gain; without it a quiet
    microphone reaches the filter and the gate too low for either to work)
  - mic level, extra on top (one USB microphone peaks at −31 dBFS)
  - noise filter on/off
  - voice gate sensitivity
  - echo cancellation, off by default (Firefox's chops up voices on headphones)

## How it works

**LiveKit:**
- Runs as one binary beside the hub, with a route in the reverse proxy for signalling.
- Needs about 100 UDP ports and one TCP port open for media.

**The hub owns the voice chats:**
- Who exists, who may see and join each one, and the invite lists. Only invited people see a
  private one.
- It hands out short-lived LiveKit tokens.
- LiveKit's webhooks tell it who joined or left. The sidebar updates live over the existing
  events stream, filtered by who may see each chat. An empty chat is removed.

**The audio chain in the browser:**
1. Microphone, with echo cancellation, noise suppression and auto gain all off by default.
2. Gain.
3. DeepFilterNet3, with RNNoise as the fallback.
4. Silero speech gate, holding back about 100–200 ms (tune it: the delay budget is about 150 ms
   mouth to ear).
5. Published to LiveKit as Opus mono with FEC and DTX.

**When the filters load:** only on first joining voice.
