# mt hub

The MacroTech shared workspace: a file tree you can preview, download and edit,
plus text channels. It replaces Discord for the group.
Design: `docs/discord-replacement.md`.

## How it runs

`mthub -data <data>` serves the page and the API on one port (8484) and keeps everything it
knows in `<data>`, the data directory: plain files, described below. It speaks plain http and
expects a reverse proxy in front of it for HTTPS. Unless started with `-lan`, it answers only
connections from its own machine (the proxy) and from Tailscale addresses; anyone else is told
to use the public address.

MacroTech's own copy is at `https://macrotechmc.com`. How that one is deployed, backed up and
restored is in MacroTech's private ops repo, not here.

Requests from loopback (the proxy) are trusted for its `X-Forwarded-Proto` (the session
cookie is `Secure` over HTTPS) and `X-Forwarded-For` (failed-login limit: 5 per address per
15 minutes).

**Everything is behind a login.** Accounts live in `<data>/users.json` (name, `owner`, `admin`,
`banned`, bcrypt hash); the hub rereads it when it changes, so no restart is needed.

**The Admin page** (menu on your name, admins only) lists every account with when it last had
the hub open, with Ban/Unban, Reset password (a temporary one, shown once) and Delete on each
member, and Add account (also a temporary password). Ban, Reset and Delete need a second click.
Every admin sees the same page, one list; each person's ⋯ menu holds what you may do to them.
The owner's menus also have Make Admin on a member, and Reset password and Remove admin on an
admin (S51: this replaced a separate Owner section). Recent actions are listed under it (`<data>/admin-log.jsonl`); last-seen times are in
`<data>/seen.json`.

- **Who may do what:** admins act on regular members. Only the owner (`grandpaul`) can make or
  remove admins or reset one's password, and nobody can act on the owner. To ban or delete an
  admin, remove admin first.
- **A ban is immediate:** the banned person's requests are refused, and their open pages drop
  to the login form, which says the account is banned. Unbanning restores their old logins.
- **Deleting** an account keeps their messages and files under their name.

On the hub's machine (the only way to set the owner, and a ban that works without the page):

    mthub passwd -data <data> [-admin=true] <name>     # set a password
    mthub user -data <data> -banned=true <name>        # or -admin, -owner

A login is a signed cookie that lasts 60 days from when the hub was last used (renewed at most
daily; the key is `<data>/secret`, and replacing it logs everyone out). Changing your password,
or **Log Out Everywhere** (both in the menu on your name), logs out your other sessions.
Password guesses are limited per address (5 in 15 minutes) and per account (10 an hour), at
login and in Change Password; a right password clears both. A new account's or reset
password is temporary: until its owner picks their own, every call but `/api/me`,
`/api/password` and `/api/logout` answers 403, and the page asks for a new one. Admins can also rename and delete chats, pin, and delete or edit anyone's
messages.

**Server tokens: how our game servers log in** (`internal/auth/tokens.go`, `<data>/tokens.json`).
The MT Hub mod on a game server does the hub's work for that server's players: `/b`'s
shortcuts, the schematics list and files, and posting screenshots. Players never log in from
the game. (Per-player "game tokens" existed briefly in S46 and were removed in S47.)
- **Format:** sent as `Authorization: Bearer mt_<id>_<secret>`. Tokens never expire, and are
  revoked by hand: make a new one (and revoke the old) when someone loses access to that server's panel.
- **Storage:** only a hash is stored. A token is shown once, when it's made (below).
- **A token reaches only its routes** (`tokenAllow` in `internal/server/tokens.go`):
  `/api/me`, reading `commands/`, `/api/schematics`, `GET /api/file/schematics/…`,
  `POST /api/screenshots`, `POST /api/server-status` and `/api/server-link` (reading and posting). Everything else is 403. A token sitting in a config file on a
  rented server can't read chats, edit files or touch accounts.
- **Screenshots:** a server names the player with `?poster=<Minecraft name>` (letters, digits,
  `_`, 1–16 characters). If someone linked that Minecraft name to their account (menu on your
  name → Minecraft Name; one account per name, any case), the screenshot goes under their hub
  name. Otherwise it goes under the Minecraft name.

        mthub token -data <data> add -server survival   # prints the token once
        mthub token -data <data> list
        mthub token -data <data> revoke <id>

**The release token** (S60): mod release cards are posted to #mod-discussion with it, as
**MacroTech**. It isn't an account (no login,
and no account may be named MacroTech) and reaches only `GET /api/me` and posting, editing or
deleting its own messages in #mod-discussion. Made with `mthub token … add -release`.

**Release cards** (S60): a message shaped like this is drawn as a card (`parseRelease` in
`web/src/chat.ts`); anything else stays ordinary text:

    ## <mod> <version>
    -# Client · Required             (Client, Server or Client + Server; Required or Optional)
    #mods/client/<file>.jar          (optional: the jar to download)
    - what changed …
    **Note:** …                      (optional: a special step or need-to-know)

The card's **Readme** button opens `mods/mod info/<mod>.md` when that page exists.

**The chat list's order** is everyone's, set by admins: drag a chat, or right-click → Move
Up / Move Down (`<data>/chat/order.json`). DMs come last, the most recent message first.

**Private chats and direct messages.**
- **Kinds:** a chat is public, private or a DM. It's set in `<data>/chat/<chat>/meta.json`;
  a chat without one is public.
- **Private chats** are for their members and every admin. Admins make them ("+" next to
  CHATS) and change their members (right-click: Members…, Make Private…, Make Public).
- **DMs** are for their 2 to 10 people only, admins included. Anyone starts one from the "+"
  next to CHATS (New Direct Message…); they're listed under the chats. Their folders are named `dm-<random>`. A DM can't be renamed or
  deleted, only hidden, and it comes back on its next message.
- **The server checks every chat request** (`inChat` in `internal/server/private.go`):
  a chat you can't see answers "not found". Live events, search and the renames list only
  carry what you can see.
- **Files posted** in a chat are kept with it (`<data>/chat/<chat>/media/`), outside Files,
  and served only to its people (see Files posted in chat).
- **Private means private from other players:** the hub stores everything as plain files,
  so whoever runs it can read them all.

## The pieces

- `cmd/mthub`: the server. One Go binary with the web page built into it.
- `internal/auth`: accounts (`users.json`) and session cookies.
- `internal/workspace`: file storage. A git repo where every save is a commit.
- `internal/chat`: text channels, stored as plain append-only files.
- `web/src`: the page, bundled by `build.mjs`:
  - `main.ts`: files (Monaco editor)
  - `chat.ts`: channels
  - `admin.ts`: the Admin page
  - `util.ts`: shared helpers
  - `voice.ts` + `vad.worker.ts`: voice chats (see Voice chats below)
  - `stream.ts`: screen sharing (see Screen sharing below)
  - `voicelab.ts` + `voicelab.html`: the voice lab at `/voice-lab/`, a test page that records
    the microphone through several noise filters at once to choose one for voice rooms by ear.
    Its filter files are served by the hub; DeepFilterNet3's two aren't on npm, so `build.mjs`
    downloads them once into `fetched/` (not in git) and checks their hashes.

## Common tasks

    make                    # build bin/mthub
    make check              # type check, go vet, go test
    make browser-test       # drive the page in headless Chromium (needs chromium)
    make firefox-check      # real Firefox window, GPU rendering: screen vs what Firefox meant to draw

To try a change, run `./bin/mthub` and open http://127.0.0.1:8484
(data goes in `./data`). For frontend work, run `npm run watch` alongside `./bin/mthub -dev`
and refresh the page after each change.


## Browser tests

`test/browser/` has one suite per area: tree, moves, schematics, pictures, viewer,
chats, chat-actions, chat-media, chat-links, chat-scroll, new-chat, editor, login, admin, previews, search, drafts, history, formatting,
autocomplete, new-line,
add-to-files, private,
conformance, chat-order, folder-sort, folder-search, voice-lab, voice and stream. Each suite starts its own hub on a free port
with a throwaway data directory, seeded by `lib.mjs` (a few files, screenshots, map art and
schematic posts), and drives it in headless Chromium over the DevTools protocol, so they need
nothing from npm. A failed suite keeps its data and the hub's log in `/tmp/mthub-<suite>-*`.

    node test/browser/run.mjs              # all except previews (which fetches real sites)
    node test/browser/run.mjs tree moves   # just those
    node test/browser/run.mjs --all        # including previews
    node test/browser/run.mjs --serial     # one at a time (they run side by side by default)

Screenshots from the runs land in `test/browser/out/` for a person to look at.

`CHROMIUM=<program>` drives another Chromium-based browser (`google-chrome`, say), and
`CHROMIUM_FLAGS` adds flags for it.

The browser has a fake microphone (beeps). `FAKE_AUDIO=<file.wav> node test/browser/run.mjs
voice-lab` records that file instead: speech mixed with noise shows the filters and the speech
gate doing their job in the screenshot.

## Voice chats

Started from CHATS' "+" (New Voice Chat, New Private Voice Chat…; also VOICE's own "+"); no
permanent rooms. VOICE appears in the sidebar only while there's a voice chat. A
voice chat is shown as its people in join order and ends when the last one leaves. A private
one is seen only by the people invited, not even admins. At most 3 at once. The agreed design
is `docs/voice/rooms-design.md`, with the research and the voice
lab's results beside it.

- **Audio:** a LiveKit server (ours is 1.13.7), reached through the same reverse proxy:
  `/rtc` for browsers and `/twirp` for the hub's API calls.
- **The hub** (`internal/server/voice.go`) keeps the list (`<data>/voice-chats.json`, so a
  restart doesn't lose it), decides who sees and joins what, and signs LiveKit tokens. LiveKit's
  webhooks (`POST /api/voice/webhook`, signed with the shared secret, no login) say who joined
  and left; every 20 seconds the hub also asks LiveKit, in case one went missing.
- **`<data>/voice.json`** holds LiveKit's addresses, key and secret (the same as in LiveKit's
  own config). Without it voice chats are off; edits take effect without a restart.
- **In the page** (`voice.ts`): mic with no browser processing (Firefox's echo cancelling chops
  up voices on headphones) → level → DeepFilterNet3 (or RNNoise, or off) → 150 ms hold-back →
  the Silero speech gate (`vad.worker.ts`) → LiveKit. Settings are per browser.
- **Tests:** `TestVoice` (rules, privacy, webhooks, restart) and the `voice` browser suite,
  which runs a local LiveKit (`fetched/livekit-server`, downloaded on first run) with two
  people in two browser profiles. `FAKE_AUDIO=<speech.wav>` also checks the speaking light.

## Screen sharing

Video only, Discord style (S55; agreed design `docs/stream/screen-share-spec.md`). Share Your Screen… (CHATS' or LIVE's "+") asks the browser for a window or
screen; while someone shares, LIVE appears in the sidebar and anyone clicks to watch in the
main panel (`#live=<name>`, silent, Full screen). It ends on Stop, when the shared window
closes, when the page closes or reloads, or when the connection drops. At most 3 at once;
1080p at 30 fps, 5 Mbit/s, VP8 (720p looked too soft). An admin can stop someone's (right-click, admin log
`stream-stop`). Phones watch from a strip at the top of the chat.

- **Same LiveKit as voice** (`voice.json`): each stream is its own room `s…`; the streamer's
  token may publish only a screen share, viewers' only watch (identity `name~<tab>`, so you
  can watch in two tabs, or your own stream). LiveKit needs no extra setup for it.
- **`internal/server/stream.go`** keeps the list (`<data>/streams.json`), listed once the
  picture arrives. LiveKit sends every room's webhooks to `/api/voice/webhook`; rooms starting
  with `s` go to the streams, so watching never takes anyone out of a voice chat. Every 20
  seconds the hub asks LiveKit too (ends one whose streamer left, or that never showed a
  picture within a minute; removes banned people). Closing a room needs LiveKit's
  `roomCreate` permission on the hub's API token (`twirp`).
- **In the page:** `stream.ts`; the capture is marked `contentHint = 'motion'` (without it
  browsers drop to a few frames a second to keep text sharp).
- **Tests:** `TestStreams`, `TestStreamCheck`, and the `stream` browser suite (Chromium's fake
  screen capture, two profiles, a phone).

## Firefox check

Headless browsers can't see what a GPU actually puts on screen. `make firefox-check`
(`test/firefox/check.mjs`) opens a visible Firefox window for about a minute, with a throwaway
profile set to GPU rendering (WebRender over EGL/DMA-BUF) and a throwaway hub,
and for each main view compares the real screen pixels with Firefox's own capture. It caught
the bottom pixel row of g/p/y going missing in file-tree names (text cut short with "…" whose
box edge sat on a half pixel). Run it by hand, before a styling change is released; it needs the
X display, i3 and maim. Native sliders are left out (GTK draws their thumb a few pixels
differently in the capture). `--software` runs it with software rendering, for comparison.

## Editing files directly

    cd <data>/workspace          # use any editor, cp, rsync, git, ...

The Files tree is an ordinary folder, so it can be changed directly on the hub's machine by
whoever owns the files. Before listing or changing anything, the server commits whatever
changed on disk ("Edit on the box: ..."), credited to the files' owner. So direct edits get
history within a few seconds, and a page save can't silently overwrite them.

Uploads stop when the disk is down to 20 GB free (`-min-free`, in GB). The page and its
workers carry a Content Security Policy (`internal/server/headers.go`): nothing loads from or
connects to anywhere but the hub, its voice server and YouTube embeds. The browser tests fail
on anything it blocks.

## Chat

Channels are folders in `<data>/chat/`, holding one file per month:
`<data>/chat/<channel>/<YYYY-MM>.jsonl`. Each message, edit or delete is one JSON line,
appended. So on the hub's machine you can watch and search the chat:

    tail -f <data>/chat/general/2026-10.jsonl
    grep -h farm <data>/chat/*/*.jsonl

Read them freely, but don't edit them while the server runs; it keeps chat in memory and
rebuilds it from these files at startup.

How it behaves:
- **Two chat panes:**
  - the right-hand panel has a channel dropdown, hides with », and resizes by dragging its
    left edge (double-click resets the width)
  - clicking a channel in the left list opens it in the main panel instead of the file
  - so you can have two channels open at once; a file you had open keeps its unsaved edits
    while a channel is showing
  - `#chan=<name>` in the address opens a channel in the main panel
- **Delivery:** messages arrive live over Server-Sent Events (`/api/events`). The same
  stream tells pages about file changes, including edits made over ssh.
- **Links:** `#path/to/file` (or `#[path with spaces]`) becomes a link that opens the file.
  A link to a schematic post's folder (`#[schematics/<title>]`) shows as the post's card and
  opens it in the Schematic Manager. Drag a file or folder from the tree, a tile from a
  folder, or a card from the Manager onto a chat to insert its link.
- **Files posted in chat:** anything dropped or pasted on a chat (or picked with its +
  button), up to 50 MB, is kept with the chat (`<data>/chat/<chat>/media/`, outside Files and
  its history) and linked in the message box as `#media/<chat>/<file>`. Only people who can
  see the chat can fetch it. Pictures, videos and sounds show as previews under the message
  (pictures as thumbnails), anything else as a file card (name, size, Download), instead of
  as links. A file over 50 MB is offered a place in `large/` instead. **Save to Files…**
  (message toolbar and menu, the viewer, the chat's file list) copies one into a Files
  folder. The 📎 button in a chat's header lists its files, newest first. A chat rename takes
  its files along (old links follow). A message that links a file from another chat (pasted
  or forwarded, when posted or edited) gets its own copy in its chat, so its people can see
  it and it outlives the original; only from chats the poster can see. Deleting the last message that links a file asks
  whether to delete the file too (ticked; it goes to the trash); a file another message still
  links is never deleted. Deleting a chat keeps its files with it in `chat/.deleted/`.
  `media/` is not a Files folder: Files refuses the name. Until 2026-10-05 public chats' files
  were in `media/<chat>/` in Files and only pictures, videos and sounds were taken.
- **Pictures full size:** clicking a picture anywhere (chat, files, folder views,
  schematic posts) opens the full-window viewer: zoom, forward, download, open in a
  new tab, close; ←/→ step through the set. Opened from chat, it also has Open folder (a
  picture in Files: shows it there) or Save to Files… (a picture posted in chat).
- **Folder view:** clicking any folder (or a `#path` link to it) opens it as a grid of its
  folders and files, with one bar: Upload, a name search, Size (`#folder=<path>`). Ctrl+V
  pastes pictures in. Pictures and videos show as thumbnails, other files as their tree icon.
  `screenshots/` opens at its newest;
  everything is folders first, then by name (`x.png` before `x (2).png`). A README is just
  a file in it. The folder stays the selected row and isn't expanded. A nested folder has
  `← Back to <parent>/` (and Esc) to go up.
- **Screenshots and map art** are ordinary folders that keep no history (like `large/`). A screenshot is named `<date> <time> <poster>.png`, which its tile shows as the
  poster and time; any folder with such names gets who/from/to filters. Anything uploaded,
  dropped or pasted into `screenshots/` is named that way (taken time, your name); a pasted
  picture anywhere gets the same kind of name. Map art is named by its title
  (`MA-001 MacroTech Logo.png`). The old `#shots` and `#mapart` addresses open the folders.
  Until 2026-10-02 both were separate stores; a one-off script moved them in.
- **One item on its own** (a picture or video file, one schematic post) gets the same bar: back and the name on the left; previous/next (also ←/→,
  Esc goes back) and icon buttons on the right: full window, forward, download, open in a
  new tab, edit (posts), delete (red on hover), and ⋯ listing the same actions. The folder's own bar (filters, search, size) hides meanwhile.
  Any other file opened on its own (text, Markdown, binaries) gets `← Back to <folder>/` and
  Esc too (Esc works from the tree as well, which keeps only its arrow keys; with a menu open,
  Esc just closes the menu).
- **Schematic Manager** (the Schematic Manager button in `schematics/`' folder bar): `schematics/` in Files shown as a board of
  big cards, newest first, with search and a card-height slider (`#schems`). Each post is a
  folder, `schematics/<title>/`: its schematic file(s), its renders (`1.png`, `2.png`…; the
  first is the card picture) and a `README.md` the card is read from:

      # 260x260 8gt Floor Placer

      Design by Glowsquid · posted 2025-07-09

      For placing a floor of a single block type…

  (`Posted <date>` alone when there's no credit; everything under that line is the
  description.) A post opens on its own (`#schem=<folder>`) with the single-item bar, Open
  folder, Edit and Delete. A post is edited in place: Edit turns its page's title, credit and
  description into boxes where they sit and puts move/remove buttons on its pictures, with
  Save and Cancel in the bar (leaving with changes asks). New post is the same page, empty.
  Both write those files; a title that's taken offers
  the file to that post as a new version (same name: replaces it, history keeps the old).
  Anything changed in Files shows on the board, and a post's folder view has Open post.
  `schematics/` keeps history like the rest of Files. Until 2026-10-02 posts were a
  separate store; a one-off script moved them in.
- **Mentions:** `@name` (anyone who has posted) and `@everyone`/`@here` get Discord's purple
  highlight. There are no notifications.
- **Message actions** (hover toolbar, or right-click): react, reply, forward (a copy, which
  survives the original changing), edit your own, copy, delete your own (admins: any; Shift
  skips the question), copy a link to the message (`#chan=<name>&msg=<id>`), and for admins,
  pin. The 📌 button in a chat's header lists its pins.
- **Emoji** are drawn with Twemoji images (`/emoji/<codepoints>.svg`, graphics CC-BY 4.0), so
  they look the same in every browser, including Linux ones with no emoji font.
- **Editing:** Arrow-Up in an empty box edits your last message.
- **Unread markers:** kept per browser, since there are no accounts yet.
- **Phones:** under 700 px wide the page shows chat only, and a file link downloads the file.

## Large files and other no-history areas

Anything under `large/` (worlds, client packs) is stored as plain files, outside git. Those
files have no history, because git handles multi-GB files badly. Everywhere else, files are
capped at 50 MB; the page offers to put a bigger upload in `large/` instead. Uploads and
downloads stream, so memory stays flat even for multi-GB files, and downloads can resume.
On the hub's machine, just `rsync` into `<data>/workspace/large/`. `screenshots/` and
`map art/` are kept the same way (pictures don't change, and git handles piles of them
badly).

## How files are stored

`<data>/workspace` is an ordinary git repo. Every save, upload or delete
is a commit under the person's name. A save carries the revision the editor started from. If
the file has changed since then, the server refuses the save (HTTP 409) and the page shows
both versions side by side.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/login` | `{name, password}`: sets the session cookie; the only call that works logged out |
| POST | `/api/logout` | clears it |
| POST | `/api/logout-all` | Log Out Everywhere: ends all your sessions; this browser gets a new cookie |
| GET | `/api/me` | `{name, admin}`; with a server token, the server's name and `token: server` |
| POST | `/api/mc` | `{mc}` links your Minecraft name (`""` unlinks); 400 if taken or not a Minecraft name. `/api/me` shows it as `mc` |
| POST | `/api/password` | `{old, new}` (8+ characters): your other sessions end |
| POST | `/api/screenshots?name=<game file name>&poster=<Minecraft name>` | body = PNG. Saved as `screenshots/<date> <time> <poster>.png` (the poster: a server token's `?poster=`, or the hub account that Minecraft name is linked to; from the page, you), the time from Minecraft's `2026-10-03_21.04.11.png` name (the player's clock), else now; numbered if taken. `{path}`. A server token may post 300 a day |
| POST | `/api/server-status` | a game server's report, server tokens only, every 10 s: `{players, bots, mspt, mspt_max, mem_used, mem_max}` (the average tick since its last report, and the longest one) (bytes of Java heap). Kept in memory for ten minutes, never stored |
| GET | `/api/server-status` | for the page's `/serverstatus` command: every server that has a token, `[{name, up, seen, players, bots, mspt, peak, mem_used, mem_max, hist}]`. `up`: reported in the last 30 s; `mspt` and `mem_used` are the last minute's average; `peak` is the longest single tick in the ten minutes; `hist` is `[seconds ago, mspt]` pairs. Survival first |
| POST | `/api/server-link` | server tokens only: `{player, text}`, a line a player started with `$ ` in game. Posted in `#server-link` under the hub account that Minecraft name is linked to (else the Minecraft name), with `via`: the server's tag (SMP, CMP). 60 a minute per server |
| GET | `/api/server-link?after=<id>&wait=<seconds>` | server tokens only: `{you, last, messages: [{id, tag, user, text}]}`, the messages in `#server-link` newer than `after` that this server didn't send, as plain one-line text (tag SMP, CMP or HUB), `user` being the Minecraft name linked to that hub account (the hub name if none). With none, the answer waits up to `wait` (30 s at most) for one. Without `after`: just `last`, where to start. The first call makes the chat |
| GET | `/api/users` | `[{name, admin}]`, every account |
| GET | `/api/tree` | every file and directory |
| GET | `/api/stat/<path>` | size, rev, kind (`text`/`markdown`/`image`/`binary`), `large` |
| GET | `/api/file/<path>?rev=&download=1` | raw bytes; `rev` empty = current |
| PUT | `/api/file/<path>?base=<rev>` | body = content; `base` empty = create; 409 `{current}` on conflict; 413 over 50 MB outside `large/` |
| DELETE | `/api/file/<path>?base=<rev>` | same conflict rule; `?dir=1` deletes a folder and its contents |
| GET | `/api/history/<path>` | commits, newest first, following renames |
| POST | `/api/move` | `{from, to}` file or folder, one commit; 409 if `to` exists |
| GET | `/api/moves` | `[{from, to, author}]` oldest first, from the move commits; how old links find moved files |
| POST | `/api/mkdir` | `{path}` empty folder (on disk only until a file goes in) |
| GET | `/api/zip/<path>` | a folder as `<name>.zip`, streamed |
| GET | `/api/thumb/<path>?v=<mod>` | a 640-wide JPEG of a workspace picture (chat previews), cached in `thumbs/` |
| GET | `/api/channels` | `[{name, last_id}]` |
| POST | `/api/channels` | `{name}` creates one |
| PATCH / DELETE | `/api/channels/<name>` | admins: `{name}` renames; delete moves its folder (files posted in it included) to `chat/.deleted/<name>-<time>` |
| POST | `/api/channels/<name>/media?name=<file>` | body: a file (any kind, at most 50 MB) posted in the chat; a name already there gets " (2)". `{path}`: `media/<chat>/<file>`, to link |
| GET | `/api/channels/<name>/media/<file>` | a file posted in the chat; `?download=1` saves it |
| GET | `/api/channels/<name>/thumb/<file>` | a thumbnail of a picture posted in the chat (as `/api/thumb`) |
| POST | `/api/channels/<name>/media/<file>/save` | `{dir}`: copies it into Files (" (2)" for a taken name; over 50 MB into `large/`). `{path}` |
| GET | `/api/channels/<name>/files` | `[{path, size, id, user, t}]`: the files its messages link, newest first, with the first message linking each |
| GET | `/api/channel-renames` | `[{from, to, t, user}]` oldest first (`chat/renames.jsonl`); how old `#chan=` links find a renamed chat |
| GET | `/api/channels/<name>/messages?before=<id>&limit=` | oldest first, up to 200 |
| POST | `/api/channels/<name>/messages` | `{text, reply_to?, forward?: {channel, id}}`; a forward stores a copy of the original (`fwd`) and needs no text; files posted in another chat (one the poster can see) that it links are copied into this one, and its links point at the copies (also on edit) |
| PATCH / DELETE | `/api/channels/<name>/messages/<id>` | edit: own messages only; delete: own, or admins; `?files=1` also moves the files posted in chat only it links to the trash |
| GET | `/api/channels/<name>/messages/<id>/orphans` | `{paths}`: files posted in chat that the message links and no other message (any chat, forwards included) does |
| PUT / DELETE | `/api/channels/<name>/messages/<id>/reactions/<emoji>` | add or take back your reaction |
| PUT / DELETE | `/api/channels/<name>/messages/<id>/pin` | admins: pin or unpin |
| GET | `/api/channels/<name>/pins` | pinned messages, most recently pinned first |
| GET | `/api/preview?url=<link>` | link preview `{kind: page/image/youtube/none, site, title, desc, color, image, w, h, large, video}`; fetched once (public internet only), cached in `previews/`; 60 new links per person per 10 minutes (429 past that) |
| GET | `/api/preview/img/<id>` | a cached preview image |
| GET | `/api/search?q=<query>` | search: words (all must appear, any case; `"quoted"` together) plus filters `in:#chat` / `in:folder/`, `from:`, `mentions:`, `has:link/image/video/file/schematic/pin`. Returns `{error?, words, chat, files, text, schematics}`, each `{total, items}` (first 50; 20 posts). `from`/`mentions`/`has` search chat only. Reads everything each time (text files cached by size+time) |
| GET | `/api/events` | SSE: `message`, `edit` (also reactions and pins: the whole message), `delete`, `channel`, `files` |

Every call except `/api/login` answers 401 without a session, and writes are credited to its user.

## Contributing

Open a pull request against `master` from a branch or a fork.

- Run `make check` and `make browser-test` yourself first, and say in the pull request that
  they pass. Nothing on GitHub builds or tests a pull request; a maintainer runs both again
  before merging. The browser suites need Linux or macOS with `chromium` (on Windows, WSL).
- A change comes with a check that fails on the old code: a Go test, or a browser suite in
  `test/browser/` (`lib.mjs` has the helpers).
- `docs/style-guide.md` says how the hub looks and behaves, and it wins over the code. A
  styling change also needs `make firefox-check`, which a maintainer runs: the browser tests
  are Chromium only, and some drawing bugs exist only in Firefox on a GPU.
- Say in the description what a member will notice.

Bigger ideas are in `docs/hub-backlog.md`; ask before starting one. Releasing a change to
MacroTech's hub is done by the maintainers after a merge.

## Licence

MIT, see `LICENSE`. What the page bundles from other projects, and under which licences, is in
`THIRD-PARTY.md`.

