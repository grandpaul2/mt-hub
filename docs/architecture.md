# Architecture

One screen on how the hub is put together. The pieces behave as the README and the other
docs describe; this is the map.

## The binary

`mthub` (`cmd/mthub`) is one Go program with the web page built into it. `make` bundles
`web/src` with `build.mjs` into `web/dist`, and `web/embed.go` embeds that folder in the
binary. Run with `-dev` it serves `web/dist` from disk instead, so `npm run watch` shows
a change after a page refresh.

It listens on one port (`-addr`, default `127.0.0.1:8484`) for the page and the API. It speaks
plain http and expects a reverse proxy in front of it for HTTPS. Unless started with `-lan`,
it answers only connections from its own machine (the proxy) and from Tailscale addresses.
`mthub passwd`, `mthub user` and `mthub token` are small commands in the same binary that edit
the accounts and tokens in the data directory.

## The data directory

Everything the hub knows is plain files in the data directory (`-data`, default `./data`):

| Path | What |
|------|------|
| `users.json`, `secret` | accounts (bcrypt hashes) and the key that signs session cookies |
| `tokens.json` | game-server tokens and the release token (only hashes) |
| `workspace/` | the Files tree: an ordinary git repo, every save a commit. `large/`, `screenshots/` and `map art/` are plain files outside git |
| `chat/<chat>/<YYYY-MM>.jsonl` | one file per chat per month; every message, edit or delete is one appended JSON line. `meta.json` holds a chat's kind and members, `media/` the files posted in it |
| `voice.json` | LiveKit's addresses, key and secret; without it voice and screen sharing are off |
| `voice-chats.json`, `streams.json` | the live voice chats and screen shares |
| `thumbs/`, `previews/` | caches (picture thumbnails, link previews) |
| `admin-log.jsonl`, `seen.json` | recent admin actions, last-seen times |

## The Go packages

- `internal/auth`: accounts, session cookies, tokens.
- `internal/workspace`: the Files tree on git, and the trash (`workspace.Clean` checks every
  path from outside).
- `internal/chat`: chats as append-only files, kept in memory and rebuilt from the files at
  start.
- `internal/preview`: link previews (public internet only).
- `internal/server`: every route, the Content Security Policy (`headers.go`), disk limits
  (`limits.go`) and the event stream.
- `cmd/voicelink`: a separate small relay for Simple Voice Chat between game servers.

## The page

Plain TypeScript with no framework, bundled by esbuild (`build.mjs`). The page builds its
elements with `h()` from `util.ts` and talks to the server only with `fetch` and one event
stream. The editor (Monaco) and the LiveKit client are separate bundles loaded on first use.
The page ships its own fonts and emoji; the Content Security Policy lets it load nothing from
other sites.

## Live updates

A page opens `GET /api/events`, a Server-Sent Events stream. The server sends `message`,
`edit`, `delete`, `channel` and `files` events through one broker (`events.go`); private chats
send only to their members. A page that is too slow misses an event and reloads what it shows
when it reconnects. File changes made directly on disk are committed by the server before it
next lists or changes anything, and announced the same way.

## Voice chats and screen sharing

Audio and video go through a LiveKit server that the operator runs; the hub only decides who
may join what. The page reaches LiveKit through the same reverse proxy (`/rtc` for the browser,
`/twirp` for the hub's own API calls). The hub signs the LiveKit tokens, keeps the list of chats
and shares, and learns who joined and left from LiveKit's webhook (`POST /api/voice/webhook`,
signed with the shared secret) plus a check every 20 seconds. Details: `voice-and-streams.md`.

## Game servers

A Minecraft server with the MT Hub Server mod
([`mthub-mod`](https://github.com/grandpaul2/mthub-mod)) holds one server token and
makes every call for its players. A token can reach only the routes in `tokenAllow`
(`internal/server/tokens.go`), so a token in a rented server's config file cannot read chats
or touch accounts. Details: `admin.md`.
