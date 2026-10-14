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
off when the account loses its Minecraft name or is banned, and after 30 seconds in neither
place. Closing or reloading the hub's page is not leaving.

Nobody else sees whether you are locked. Without the lock, everything is as before.

## Why the page holds your microphone

Firefox opens no new microphone for a page you aren't looking at (you're in the game): the
request waits until the tab is in front and its window focused, even with a remembered Allow
(Mozilla bug 1195654; the Media Capture spec's "MUST wait … until the … document is fully active
and has focus"). A microphone track the page already holds comes back when it is enabled again,
and the page can start audio and play sound then (tested in Firefox 157 with the page in a
background tab and another application focused).

So while you are locked the page holds your microphone, disabled while it isn't in use: from
the click on the lock, or as soon as a page loaded while you are locked may have it. Firefox's
microphone indicator should show it as not in use (gray) while you are in game; that is from
Mozilla's bug 1299515, not seen in a test. A page that has no microphone yet shows the
lock in red ("Click here to stay in voice-link when you leave the game"), and can't take over
until it has one.

## How it works

- **The hub** keeps the locked accounts (`voice-locks.json`). `POST /api/voice/voice-link/lock`
  `{"on"}` locks you, if your account has a Minecraft name and you are in voice-link (in the
  hub, or your player in the group in game); unlocking is always allowed. `GET /api/voice` has
  `lock: true` on #voice-link for the account asking, and for nobody else. #voice-link's token
  carries the participant attributes `mc` (the Minecraft name) and `lock`; a change of lock
  while you are in the room is sent to LiveKit (`UpdateParticipant`).
- **The bridge** (`internal/voicebridge`) puts `lock` in its roster for the game servers, and
  sends the roster again when a participant's attributes change.
- **A game server** puts a player in the group when their name matches a locked hub member,
  their voice chat is connected and they are in no group (nobody is pulled out of another
  group). When a member leaves the group while still connected to voice chat, the server first
  tells the hub (`POST /api/voice-link/left` `{"player"}`, game server tokens only), which takes
  the lock off, and only then sends its changed roster (it waits for the answer, two seconds at
  most). It doesn't put that player back while the hub's roster still says locked.
- **The page** (`web/src/voice.ts`, "the lock") watches #voice-link: locked and in the voice
  chat, it hangs up without telling the hub when your player appears in game; when your player
  goes again, it joins by itself on the microphone it held, asking for no new one. Only a page
  that saw your player in game takes over; a page loaded later doesn't. Two tabs: one joins
  (`navigator.locks`, and a check that the account isn't in the room already). While you are
  locked and your player is in game, #voice-link offers no Join.

## What it doesn't do

- Start a session: the lock can only be clicked by someone already in voice-link.
- Work with the hub closed, or in a page that hasn't held your microphone since it loaded.
- A browser that discards background tabs (Chrome's Memory Saver) ends it as a closed page would.
- Phones are not considered.

## Tests

`internal/server/voice_lock_test.go` (who may lock; who is told; what takes it off; the report
for game servers only), `internal/voicebridge` `TestRosters` (the roster's `lock`, sent again on
a change), `test/browser/voice-lock.mjs` (end to end with a local LiveKit, relay and bridge and
a stand-in game server; Chromium's fake microphone), and the lock views in
`test/firefox/check.mjs`.
