# voice-link: the lock

The lock keeps you in voice-link as you move between the hub and the game. It's for someone
in **#voice-link** ([`hub-link-spec.md`](hub-link-spec.md)), whose account has a Minecraft name
(an admin sets it).

## What it does

You are in voice-link, in the hub's #voice-link or in the group in game. Joining #voice-link in
the hub turns the lock on by itself (once you're in); you can also click the lock beside your
name, to turn it on or off. While it is on:

- **You join a game server:** the hub cuts its own side first, then the server puts you in the
  voice-link group (one place at a time, below). In game you are only in Simple Voice Chat, so
  proximity chat works as usual and nobody hears you twice. You're moved into the game's
  voice-link this way even if you join #voice-link in the hub while already playing.
- **You leave the game server:** the hub's page takes over again, by itself.
- **You go from one server to another:** the hub holds you in between.

It ends when you leave on purpose: Leave in the hub, joining another voice chat in the hub, or
leaving the group in game (or joining another group there). The lock is then off. It also goes
off when an admin disconnects you from #voice-link, when the account's Minecraft name is taken
away or changed (the lock was for the old player), when it is banned, and after 30 seconds in
neither place. Closing or reloading the hub's page is not leaving, and nor is joining
#voice-link from another tab or device (the first one says "You joined this voice chat
somewhere else."). The 30 seconds don't count while the hub can't tell who is where: while it
can't ask LiveKit (a hub that just started, or LiveKit not answering), and while the bridge is
out of #voice-link's room (the bridge or the relay down, or restarting: the players in game
vanish from the room then, not from the game). The lock waits for the bridge, however long,
and the 30 seconds start again from its return. (With link voice switched off altogether there
is nothing to wait for and nothing to count: a lock left behind stays until its account leaves,
is banned or changes its name.)

A dropped voice connection is not leaving either. When LiveKit drops the hub's page while you
are locked (its own reconnecting, about 45 seconds of it, has failed: a long LiveKit outage, or
a bad line), the page keeps the lock and the microphone it holds, says "Voice chat dropped,
rejoining…", and joins again by itself as soon as it can, every two seconds until it is in,
until the lock is off, or until your player is in game. Not locked, a drop is a disconnect as
before.

Nobody else sees whether you are locked.

## One place at a time

voice-link is one place with two ways in, and you are in it one way at a time: the old way is
shut before the new one opens, so a switch is a short silence and never two copies of anyone.

- **Into the game by the lock:** before the hub names you to a game server as locked, it removes
  you from #voice-link's room with LiveKit (`RemoveParticipant`, which cuts a participant off at
  the server whatever their page does). If LiveKit doesn't do it, you're left out of the answer,
  and the server asks again two seconds later.
- **Into the game by hand** (the group screen in game, or its command): MT Utils holds the join
  and asks the hub to cut your hub side first (`POST /api/voice-link/joining`); if the hub
  doesn't answer, the join is refused with a line in chat.
- **In through the game, the hub has nothing to join:** while your player is in the group, or
  you were just cut for the game, #voice-link offers you no Join and the hub refuses a token
  (409 "Your player is in voice-link in Minecraft."). Leave the group in game to come back to the
  hub (with the lock on, the page takes over by itself).
- **Found in both, cut:** if your account is ever in the room while your player is in the group
  (a page that connected after a cut, the bridge coming back after a restart), the hub cuts the
  account at once.
- **The page, cut:** a page removed this way hangs up quietly, keeping the lock and the held
  microphone (`GET /api/voice` says `handover: true` for you for ten seconds, or until your
  player appears). If your player doesn't appear in game within 15 seconds, it takes over once
  and turns the lock off, so a put that keeps failing can't send you back and forth. Without the
  lock it says "You're in voice-link in Minecraft."

Why: before this, the hub's page stepped back only when it saw your player in game, about two
seconds after the server had put you in, and for that time everyone heard you twice and you
heard yourself.

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
  hub, or your player in the group in game); unlocking is always allowed. Joining by hand
  (`POST /api/voice/voice-link/join`; the page's own take-overs send `{"lock": false}`) locks you
  once LiveKit says you're in. `GET /api/voice` has `lock: true` on #voice-link for the account
  asking, and for nobody else.
- **A game server asks the hub** which of its players are locked:
  `POST /api/voice-link/locked` `{"players": [...]}` → `{"locked": [...]}` (game server tokens
  only; at most 100 Minecraft names; the answer keeps the names as asked). A player is locked
  while their account (not banned) holds a lock for that Minecraft name and is in #voice-link
  right now, in the hub or in the group in game (or was just cut for the game). The hub cuts
  each one from the room before it names them. MT Utils asks about its players who are in voice
  chat and in no group, when one connects and every two seconds; since 2.6.1 it puts a player
  in only on an answer asked after their voice connected, and uses each answer once.
- **Nobody in the room can see a lock.** #voice-link's token carries only the participant
  attribute `mc` (the Minecraft name; an admin's change of it reaches LiveKit at once), and
  the bridge's roster carries `mc` and no lock. (Before 2026-10-14 the lock went to the game
  servers as a `lock` attribute the bridge put in its roster; MT Utils 2.5.2 still reads a
  roster `lock` if the hub answers its question with 404.)
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

- Start a session: the lock comes on only for someone already in voice-link.
- Work with the hub closed, or in a page that hasn't held your microphone since it loaded.
- A browser that discards background tabs (Chrome's Memory Saver) ends it as a closed page would.
- Phones are not considered.
- Show you in game while your player is online somewhere in no group and you stay in the hub's
  #voice-link with the lock off (or after a put that failed). The players in voice-link there
  hear you with no list entry, head or volume slider. Won't fix (maintainer, 2026-10-30): voice-link
  is built for the happy path, players on our servers with the lock on, not to cover every case a
  voice chat service would; the lock is the answer.

## Tests

`internal/server/voice_lock_test.go` (who may lock; who is told; what takes it off; the report
and the question for game servers only; a replaced session; checks failing; a changed
Minecraft name; the old lock file; `TestVoiceLinkHandover`: the cut before the answer, a failed
cut, `/joining`, nothing to join while in game, found in both, the lock on a join by hand), `internal/voicebridge` `TestRosters` (no `lock` in the roster;
it is sent again when a Minecraft name changes), `TestOneRosterAtATime`, `TestListenerFollowsRelay`,
`test/browser/voice-lock.mjs` (end to end with a local LiveKit, relay and bridge and a stand-in
game server; Chromium's fake microphone; Chromium's autoplay rule forced by a stub), and the lock views in `test/firefox/check.mjs`.
