# OPEN: the hub's unfinished work for now

**State, not history**: rewrite it as things change, never append. If it isn't here or in
[`LATER.md`](LATER.md) (ideas and work held for later), it isn't open.
Every item leaves **done**, **won't-fix with a written reason**, or **as a line here with a next
action**. Waiting is not a next action: an item that only waits goes, its facts kept where they
belong, and comes back as a new item when it shows again.

Anyone may take an item: say so in the chat or open a draft pull request, so two people don't
build the same thing. An item's number stays when others close.

Last reconciled: **2026-10-31** (nothing opened or closed: the folder list, Upload Schematic and the tree closing its own folders were asked for and shipped the same day, #78 and #79).

## Open

### Voice Link

1. **A player the game puts into voice-link: what they say before their LiveKit participant
   has joined doesn't reach the hub.** Kept so on purpose: the hub's join sound marks the
   moment they are heard. The bridge starts the join as the roster
   arrives; the join itself took 30 ms or 1.08 s against a local LiveKit, at random, cause not
   found. *Next:* time the joins on the relay (`journalctl -u voicebridge`) and, if the 1 s is
   there too, find what it waits for.

(`relay.mjs` needs an ffmpeg with libx264; some distributions' default builds, such as
Fedora's `ffmpeg-free`, have none. That is a requirement, listed in `AGENTS.md`, not an open
item.)
