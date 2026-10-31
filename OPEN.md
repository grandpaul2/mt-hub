# OPEN: the hub's unfinished work for now

**State, not history**: rewrite it as things change, never append. If it isn't here or in
[`LATER.md`](LATER.md) (ideas and work held for later), it isn't open.
Every item leaves **done**, **won't-fix with a written reason**, or **as a line here with a next
action**. Waiting is not a next action: an item that only waits goes, its facts kept where they
belong, and comes back as a new item when it shows again.

Anyone may take an item: say so in the chat or open a draft pull request, so two people don't
build the same thing. An item's number stays when others close.

Last reconciled: **2026-10-30** (first version: the old backlog's Later list split into this
file and `LATER.md`; item 2 decided).

## Open

### Voice Link

2. **With the lock off, a hub member whose player is online in game but in no group is heard
   in voice-link with no list entry, head or volume slider**: they play from a stand-in speaker,
   because an online player is not shown as a remote member. It happens when someone clicks
   the lock off and stays in #voice-link while playing, or when a put into the game fails for
   15 s and the hub takes over and turns the lock off. **Decided** (maintainer, 2026-10-30): the
   lock off means "keep me out of the in-game group", not "keep me silent": staying in the hub
   is a fair choice (no switch pauses and beeps when moving between servers a lot, or a mod not
   updated), so they stay heard and are **shown like any hub member**, while their player is
   online. *Next:* a short spec of the game server's side of the link showing them, and the
   test that fails today.
3. **Two voice specs are out of date.** `docs/voice/svc/link-spec.md` says a remote voice's
   channel is deliberately not the speaker's own uuid; since MT Utils 2.4.0 shown members use
   their own uuid. `docs/voice/svc/hub-link-spec.md` says someone in both places is heard twice
   and nothing prevents it; since the hand-over (#55, #56) a player is in one place at a time.
   *Next:* correct both, docs only.
4. **Two cuts of one account at once can lose the hand-over mark.** In `cutForGame`
   (`internal/server/voice_lock.go`) call A sets the mark and call B, finding it fresh, sets
   none; if A's `RemoveParticipant` fails and B's succeeds, A deletes the mark B's cut relied
   on, and the cut page reads no hand-over and treats it as an admin's Disconnect (lock off).
   *Next:* a Go test of two cuts at once with the first failing; then keep the mark when any
   call cut the account.
7. **Leaving #voice-link takes a right-click.** Your own row has the lock but no way out: you
   leave from the row's menu (Leave) or the voice bar's hang-up. Wanted: a small ✕ beside the
   lock that leaves the channel. *Next:* a short spec (when the ✕ shows, what it does when your
   player is in the group in game), then the button and a browser test.

### Tests

5. **`reveal.mjs` fails on Chromium 155** (`run.map is not a function`: its `frames()` helper
   gets no array back), on `master` too. *Next:* find what `frames()` gets back on 155 and make
   it work on both. A fix is welcome.
6. **`chat-scroll.mjs` and `relay.mjs` can fail under load.** `chat-scroll`'s "the bottom message
   holds its place on every frame" check (to a whole pixel), and `relay`'s "timed out waiting
   for LIVE", when something heavy runs beside the suites; alone both pass. *Next:* make each
   wait for the state it checks instead of a fixed time, and rerun beside a busy machine.

(`relay.mjs` needs an ffmpeg with libx264; some distributions' default builds, such as
Fedora's `ffmpeg-free`, have none. That is a requirement, listed in `AGENTS.md`, not an open
item.)
