# voice-link: the lock

The lock keeps you in voice-link as you move between the hub and the game. It's for someone
in **#voice-link** ([`hub-link-spec.md`](hub-link-spec.md)), whose account has a Minecraft name
(an admin sets it).

## What it does

You are in voice-link, in the hub's #voice-link or in the group in game. With the hub open in a
browser, you click the lock beside your name in #voice-link. From then on:

- **You join a game server:** the server puts you in the voice-link group, and the hub's page
  stops its own voice. In game you are only in Simple Voice Chat, so proximity chat works as
  usual and nobody hears you twice.
- **You leave the game server:** the hub's page takes over again, by itself.
- **You go from one server to another:** the hub holds you in between.

It ends when you leave on purpose: Leave in the hub, joining another voice chat in the hub, or
leaving the group in game (or joining another group there). The lock is then off. It also goes
off when an admin disconnects you from #voice-link, when the account's Minecraft name is taken
away or changed (the lock was for the old player), when it is banned, and after 30 seconds in
neither place. Closing or reloading the hub's page is not leaving, and nor is joining
#voice-link from another tab or device (the first one says "You joined this voice chat
somewhere else."). The 30 seconds don't count while the hub can't ask LiveKit who is where (a
hub that just started, or LiveKit not answering).

Nobody else sees whether you are locked. Without the lock, everything is as before.

## Why the page holds your microphone

Firefox opens no new microphone for a page you aren't looking at (you're in the game): the
request waits until the tab is in front and its window focused, even with a remembered Allow
(Mozilla bug 1195654; the Media Capture spec's "MUST wait … until the … document is fully active
and has focus"). A microphone track the page already holds comes back when it is enabled again,
and the page can start audio and play sound then (tested in Firefox 157 with the page in a
background tab and another application focused).

So while you are locked the page holds your microphone, disabled while it isn't in use: from
the click on the lock, or as soon as a page loaded while you are locked is in view (a page
in the background asks for nothing; one that was refused asks again only on a
click on the red lock or when you look at it again). Only #voice-link uses the held
microphone; another voice chat, and the Mic test, get one of their own. Firefox's
microphone indicator should show it as not in use (gray) while you are in game; that is from
Mozilla's bug 1299515, not seen in a test. A page that has no microphone yet shows the
lock in red ("Click here to stay in voice-link when you leave the game"), and can't take over
until it has one.

## How it works

- **The hub** keeps the locked accounts, each with the Minecraft name it was locked for
  (`voice-locks.json`: `{"account": "Minecraft name"}`). `POST /api/voice/voice-link/lock`
  `{"on"}` locks you, if your account has a Minecraft name and you are in voice-link (in the
  hub, or your player in the group in game); unlocking is always allowed. `GET /api/voice` has
  `lock: true` on #voice-link for the account asking, and for nobody else.
- **A game server asks the hub** which of its players are locked:
  `POST /api/voice-link/locked` `{"players": [...]}` → `{"locked": [...]}` (game server tokens
  only; at most 100 Minecraft names; the answer keeps the names as asked). A player is locked
  while their account (not banned) holds a lock for that Minecraft name and is in #voice-link
  right now, in the hub or in the group in game. MT Utils 2.5.2 asks about its players who are
  in voice chat and in no group, when one connects and every two seconds.
- **Until both game servers run 2.5.2**, the lock also goes to them the old way: #voice-link's
  token carries the participant attribute `lock` beside `mc` (the Minecraft name), a change
  while you are in the room is sent to LiveKit (`UpdateParticipant`), and the bridge
  (`internal/voicebridge`) puts `lock` in its roster. That goes after; `mc` stays, and an
  admin's change of a Minecraft name reaches LiveKit at once.
- **A game server** puts a player in the group when the hub says they are locked, their voice
  chat is connected and they are in no group (nobody is pulled out of another group). When a
  member leaves the group while still connected to voice chat, the server first tells the hub
  (`POST /api/voice-link/left` `{"player"}`, game server tokens only), which takes the lock off,
  and only then sends its changed roster (it waits for the answer, two seconds at most). It
  doesn't put that player back while the hub still says locked.
- **The page** (`web/src/voice.ts`, "the lock") watches #voice-link: locked and in the voice
  chat, it hangs up without telling the hub when your player appears in game; when your player
  goes again, it joins by itself on the microphone it held, asking for no new one. Only a page
  that saw your player in game takes over; a page loaded later doesn't. Two tabs: one joins
  (`navigator.locks`, and a check that the account isn't in the room already). While you are
  locked and your player is in game, #voice-link offers no Join. While #voice-link is not
  connected to the game servers (the bridge or the relay down) the page neither steps back nor
  takes over: players vanishing then is not you leaving the game, and the bridge leaves the
  room while the relay is down so that it shows. A take-over that can't run (no microphone)
  says so in the voice bar. In Chromium a page with no click since it loaded (a reload) can't
  play or record sound: the voice bar then says "Click to turn on sound and your mic", and one
  click anywhere on the page does.

## What it doesn't do

- Start a session: the lock can only be clicked by someone already in voice-link.
- Work with the hub closed, or in a page that hasn't held your microphone since it loaded.
- A browser that discards background tabs (Chrome's Memory Saver) ends it as a closed page would.
- Phones are not considered.

## Tests

`internal/server/voice_lock_test.go` (who may lock; who is told; what takes it off; the report
and the question for game servers only; a replaced session; checks failing; a changed
Minecraft name; the old lock file), `internal/voicebridge` `TestRosters` (the roster's `lock`,
sent again on a change), `TestOneRosterAtATime`, `TestListenerFollowsRelay`,
`test/browser/voice-lock.mjs` (end to end with a local LiveKit, relay and bridge and a stand-in
game server; Chromium's fake microphone; Chromium's autoplay rule forced by a stub), and the lock views in `test/firefox/check.mjs`.
