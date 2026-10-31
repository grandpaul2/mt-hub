# OPEN: the hub's unfinished work for now

**State, not history**: rewrite it as things change, never append. If it isn't here or in
[`LATER.md`](LATER.md) (ideas and work held for later), it isn't open.
Every item leaves **done**, **won't-fix with a written reason**, or **as a line here with a next
action**. Waiting is not a next action: an item that only waits goes, its facts kept where they
belong, and comes back as a new item when it shows again.

Anyone may take an item: say so in the chat or open a draft pull request, so two people don't
build the same thing. An item's number stays when others close.

Last reconciled: **2026-10-30** (items 7 and 1 built, item 2 won't-fix: see `docs/voice/svc/lock-spec.md` → What it doesn't do).

## Open

### Voice Link

1. **A player the game puts into voice-link: what they say before their LiveKit participant
   has joined doesn't reach the hub.** Kept so on purpose: the hub's join sound marks the
   moment they are heard (maintainer, 2026-10-30). The bridge starts the join as the roster
   arrives; the join itself took 30 ms or 1.08 s against a local LiveKit, at random, cause not
   found. *Next:* time the joins on the relay (`journalctl -u voicebridge`) and, if the 1 s is
   there too, find what it waits for.

### Tests

6. **`chat-scroll.mjs` and `relay.mjs` can fail under load.** `chat-scroll`'s "the bottom message
   holds its place on every frame" check (to a whole pixel), and `relay`'s "timed out waiting
   for LIVE", when something heavy runs beside the suites; alone both pass. *Next:* make each
   wait for the state it checks instead of a fixed time, and rerun beside a busy machine.

(`relay.mjs` needs an ffmpeg with libx264; some distributions' default builds, such as
Fedora's `ffmpeg-free`, have none. That is a requirement, listed in `AGENTS.md`, not an open
item.)
