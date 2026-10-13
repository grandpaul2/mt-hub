# API

Every route is in `internal/server/` (`server.go` registers the file and chat routes; the rest
register their own). The page is the main client, so the shapes here are what the page reads;
a route's handler and its test are the full truth. The routes for game servers (a token
instead of a login) are marked.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/login` | `{name, password}`: sets the session cookie; the only call that works logged out |
| POST | `/api/logout` | clears it |
| POST | `/api/logout-all` | Log Out Everywhere: ends all your sessions; this browser gets a new cookie |
| GET | `/api/me` | `{name, admin}`; with a server token, the server's name and `token: server` |
| POST | `/api/mc` | admins: `{mc}` sets your own Minecraft name (`""` takes it away); 400 if taken or not a Minecraft name; 403 for a member (an admin sets theirs, below). `/api/me` shows it as `mc` |
| POST | `/api/password` | `{old, new}` (8+ characters): your other sessions end |
| POST | `/api/screenshots?name=<game file name>&poster=<Minecraft name>` | body = PNG. Saved as `screenshots/<date> <time> <poster>.png` (the poster: a server token's `?poster=`, or the hub account that Minecraft name is linked to; from the page, you), the time from Minecraft's `2026-10-03_21.04.11.png` name (the player's clock), else now; numbered if taken. `{path}`. A server token may post 300 a day |
| POST | `/api/server-status` | a game server's report, server tokens only, every 10 s: `{players, bots, mspt, mspt_max, mem_used, mem_max}` (the average tick since its last report, and the longest one) (bytes of Java heap). Kept in memory for ten minutes, never stored |
| GET | `/api/server-status` | for the page's `/serverstatus` command: every server that has a token, `[{name, up, seen, players, bots, mspt, peak, mem_used, mem_max, hist}]`. `up`: reported in the last 30 s; `mspt` and `mem_used` are the last minute's average; `peak` is the longest single tick in the ten minutes; `hist` is `[seconds ago, mspt]` pairs. Survival first |
| POST | `/api/server-link` | server tokens only: `{player, text}`, a line a player started with `$ ` in game. Posted in `#text-link` under the hub account that Minecraft name is linked to (else the Minecraft name), with `via`: the server's tag (SMP, CMP). Or `{notice}`: one line the server reports by itself (a bot died), posted as **MacroTech** with `via` and `notice: true`. 60 a minute per server |
| GET | `/api/server-link?after=<id>&wait=<seconds>` | server tokens only: `{you, last, messages: [{id, tag, user, text}]}`, the messages in `#text-link` newer than `after` that this server didn't send, as plain one-line text (tag SMP, CMP or HUB), `user` being the Minecraft name linked to that hub account (the hub name if none); a notice has `notice: true` and is printed without the name. With none, the answer waits up to `wait` (30 s at most) for one. Without `after`: just `last`, where to start. The first call makes the chat |
| GET | `/api/users` | `[{name, admin}]`, every account |
| GET | `/api/admin/users` | admins: every account with last-seen time, roles, ban and tag |
| POST | `/api/admin/users` | admins: `{name, admin, mc?}` makes an account, with its Minecraft name if given (409 if another account has it, and no account is made), and returns its temporary password, once |
| PATCH | `/api/admin/users/<name>` | `{banned?, admin?}` or `{mc}` (their Minecraft name; `""` takes it away; 409 if another account has it); what you may do to whom is the Admin page's rule (see [`admin.md`](admin.md)), and `{mc}` alone also works on yourself |
| PUT | `/api/admin/users/<name>/tag` | `{tag}`: an admin's tag colour; your own, or anyone's for the owner |
| POST | `/api/admin/users/<name>/password` | a new temporary password, returned once; ends their sessions |
| DELETE | `/api/admin/users/<name>` | removes the account; their messages and files keep the name, which is retired |
| GET | `/api/admin/log` | recent admin actions |
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
| GET | `/api/schematics` | every post in `schematics/`, newest first (also open to server tokens) |
| GET | `/api/channels` | `[{name, last_id}]` |
| POST | `/api/channels` | `{name}` creates one |
| PATCH / DELETE | `/api/channels/<name>` | admins: `{name}` renames; delete moves its folder (files posted in it included) to `chat/.deleted/<name>-<time>`. `400` for `#text-link` on a hub with a game server token: that chat is always there |
| POST | `/api/channels/<name>/media?name=<file>` | body: a file (any kind, at most 50 MB) posted in the chat; a name already there gets " (2)". `{path}`: `media/<chat>/<file>`, to link |
| GET | `/api/channels/<name>/media/<file>` | a file posted in the chat; `?download=1` saves it |
| GET | `/api/channels/<name>/thumb/<file>` | a thumbnail of a picture posted in the chat (as `/api/thumb`) |
| POST | `/api/channels/<name>/media/<file>/save` | `{dir}`: copies it into Files (" (2)" for a taken name; over 50 MB into `large/`). `{path}` |
| GET | `/api/channels/<name>/files` | `[{path, size, id, user, t}]`: the files its messages link, newest first, with the first message linking each |
| PUT | `/api/channel-order` | admins: `{names: [...]}`, the chat list's order (DMs are not in it) |
| POST | `/api/dms` | `{members: [...]}`: the DM between you and them, the existing one or a new one |
| GET | `/api/channel-renames` | `[{from, to, t, user}]` oldest first (`chat/renames.jsonl`); how old `#chan=` links find a renamed chat |
| GET | `/api/channels/<name>/messages?before=<id>&limit=` | oldest first, up to 200 |
| POST | `/api/channels/<name>/messages` | `{text, reply_to?, forward?: {channel, id}, nonce?}`; a `nonce` (64 characters at most) comes back on the message in the answer and the live event, and is not stored; a forward stores a copy of the original (`fwd`) and needs no text; files posted in another chat (one the poster can see) that it links are copied into this one, and its links point at the copies (also on edit) |
| PATCH / DELETE | `/api/channels/<name>/messages/<id>` | edit: own messages only, and a file posted in the chat that the edit takes out and nothing else links goes to the trash; delete: own, or admins; `?files=1` also moves the files posted in chat only it links to the trash |
| GET | `/api/channels/<name>/messages/<id>/orphans` | `{paths}`: files posted in chat that the message links and no other message (any chat, forwards included) does |
| PUT / DELETE | `/api/channels/<name>/messages/<id>/reactions/<emoji>` | add or take back your reaction |
| PUT / DELETE | `/api/channels/<name>/messages/<id>/pin` | admins: pin or unpin |
| GET | `/api/channels/<name>/pins` | pinned messages, most recently pinned first |
| GET | `/api/preview?url=<link>` | link preview `{kind: page/image/youtube/none, site, title, desc, color, image, w, h, large, video}`; fetched once (public internet only), cached in `previews/`; 60 new links per person per 10 minutes (429 past that) |
| GET | `/api/preview/img/<id>` | a cached preview image |
| GET | `/api/search?q=<query>` | search: words (all must appear, any case; `"quoted"` together) plus filters `in:#chat` / `in:folder/`, `from:`, `mentions:`, `has:link/image/video/file/schematic/pin`. Returns `{error?, words, chat, files, text, schematics}`, each `{total, items}` (first 50; 20 posts). `from`/`mentions`/`has` search chat only. Reads everything each time (text files cached by size+time) |
| GET | `/api/voice` | `{enabled, chats, max, full, url}`: the voice chats you can see (see [`voice-and-streams.md`](voice-and-streams.md)). `#voice-link`, where it is set up, is first, with `link: true`, `linked` (the bridge to the game servers is in it), and for each player in game a person with `show` (their Minecraft name) and `via` (their server's tag); it is not counted in `full` |
| POST | `/api/voice` | `{private, invite?: [names]}` starts a voice chat and returns a LiveKit token; 409 at the limit of 3, 503 when voice is not set up |
| POST | `/api/voice/<id>/join` | a token for joining one you can see |
| POST | `/api/voice/<id>/leave` | takes you off the list at once |
| POST | `/api/voice/<id>/invite` | adds people to a private voice chat; only its starter may |
| POST | `/api/voice/<id>/mute` and `/disconnect` | `{name}`: an admin acting on someone they outrank; recorded in the admin log |
| POST | `/api/voice/webhook` | LiveKit's webhook, signed with the shared secret; the one call besides login that needs no session |
| GET | `/api/streams` | `{enabled, streams, max, full}`: the live screen shares |
| POST | `/api/streams` | starts your share (one you already have is ended) and returns a LiveKit token that may publish a screen share only |
| POST | `/api/streams/<id>/watch` | a watch-only token |
| POST | `/api/streams/<id>/stop` | the streamer, or an admin who outranks them |
| PUT | `/api/streams/tags/<name>` | `{tag}`: the line under your name in LIVE while you share or stream (40 characters at most, 400; 409 when you have nothing live); `""` takes it away, which an admin may do to anyone's. Each entry of `streams` and `relay` carries its person's `tag`. It goes a minute after their stream ends |
| GET | `/api/streams` | also `relay`: `[{name, started, viewers}]`, the live relay streams, and `relayDelay` (ms the page holds them back); `relayOn`: relay streams are set up |
| POST | `/api/relay/<name>/watch` | `{sdp}` (a WebRTC offer): passed to the stream relay with the hub's account; returns `{id, sdp}` (the answer). 404 when that person isn't streaming |
| DELETE | `/api/relay/sessions/<id>` | ends your own watching session on the relay |
| POST | `/api/voice-lab/log` | a line from the voice lab test page, appended to `voice-lab.jsonl` (size-limited) |
| GET | `/api/events` | SSE: `message`, `edit` (also reactions and pins: the whole message), `delete`, `channel`, `files`, `users`, `voice`, `stream` |

Every call except `/api/login` and the signed LiveKit webhook answers 401 without a session
or a server token, and writes are credited to its user. A server token reaches only the routes
in `tokenAllow` (`internal/server/tokens.go`); everything else answers 403.
