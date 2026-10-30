# mt hub

A small self-hosted web app for a Minecraft group, built for MacroTech, that replaces Discord for
them: a git-backed file tree with previews and a plain text editor, text chats, voice chats and
screen sharing. It is one Go binary with the page built in, and it runs behind your own HTTPS
reverse proxy.

MacroTech's own copy is at `https://macrotechmc.com`. No releases are published: members use
that copy, and anyone else builds the hub from source (below). Its game-server side is MacroTech's
own mod, MT Utils, private to the group; it uses only the token routes in
[`docs/api.md`](docs/api.md). Another MacroTech project is
[`freecursor`](https://github.com/grandpaul2/freecursor).

## Try it

You need the tools under Requirements. From a fresh clone:

    make                                              # builds bin/mthub
    ./bin/mthub passwd -admin=true alice              # asks for a password (8+ characters): makes the account
    ./bin/mthub user -owner=true alice                # makes alice the owner (optional)
    ./bin/mthub                                       # serves http://127.0.0.1:8484, data in ./data

Open `http://127.0.0.1:8484` and log in as `alice`. The hub has no sign-up: accounts are made
with `mthub passwd` or, once an admin is in, on the Admin page. Flags go before the name, and
`-data <dir>` (on every command) picks another data directory; use one, and another `-addr`,
for a test hub so it does not touch a real one. For page work, run `npm run watch` next to
`./bin/mthub -dev` and refresh the page after each change.

## Requirements

- **Go**, the version in `go.mod`. An older Go stops with an error naming the version
  it needs.
- **Node.js with npm**: a current release (the scripts use `import.meta.dirname`, so Node 20.11
  or newer). `make` runs `npm ci` for the packages.
- **For the browser tests:** `chromium` on the PATH, and for the `voice` and `stream` suites a
  Linux x86-64 machine with `curl`, `tar` and `sha256sum` (they download a LiveKit server).
  The `relay` suite needs the same and `ffmpeg` (with libx264 and libopus) on the PATH; it
  downloads a MediaMTX server. `make browser-test SKIP=voice,stream,relay` runs the rest.

## How it runs

`mthub` serves the page and the API on one port (8484) and keeps everything in the data
directory, as plain files. It speaks plain http, so put a reverse proxy in front for HTTPS: it is
trusted for `X-Forwarded-Proto` and `X-Forwarded-For` when it connects from the same machine.
Unless started with `-lan`, the hub answers only its own machine and Tailscale addresses.
Everything is behind a login. Voice chats and screen sharing need a LiveKit server that you run
and name in `<data>/voice.json`; without that file they are off. Streams sent to a MediaMTX
relay with OBS can be watched too, with `<data>/relay.json` (`docs/voice-and-streams.md`). Setting up a hub for another
group (the proxy, LiveKit, backups) is not documented here.

How the pieces fit together: [`docs/architecture.md`](docs/architecture.md).

## More documentation

All of it is indexed in [`docs/README.md`](docs/README.md). The reference pages:

- [`docs/admin.md`](docs/admin.md): accounts, the Admin page, game-server tokens, private chats.
- [`docs/chat-and-files.md`](docs/chat-and-files.md): how chat, the folder view and the
  Schematic Manager behave.
- [`docs/storage.md`](docs/storage.md): how files and chats are stored, limits.
- [`docs/voice-and-streams.md`](docs/voice-and-streams.md): voice chats and screen sharing.
- [`docs/api.md`](docs/api.md): the HTTP API.
- [`docs/testing.md`](docs/testing.md): Go tests, browser tests, the Firefox check.
- [`docs/style-guide.md`](docs/style-guide.md): how the hub looks and behaves; it wins over the
  code.

## Build and test

    make                    # build bin/mthub
    make check              # type check, go vet, go test
    make browser-test       # the page in headless Chromium, about two minutes

`make firefox-check` checks a real Firefox's screen and is run only by the maintainer. Details,
including how to run one suite or one Go test, are in [`docs/testing.md`](docs/testing.md).

## Contributing

Pull requests are welcome, from a branch or a fork. Nothing on GitHub builds or tests them: the
maintainer runs the checks and tries the change before merging. Start with
[`AGENTS.md`](AGENTS.md); it is written for people and for coding agents, and has the commands,
where a change goes and the rules. New features and experiments are welcome too. Open work anyone can take is in
[`OPEN.md`](OPEN.md); ideas held for later are in [`LATER.md`](LATER.md).

## Licence

MIT, see `LICENSE`, except the MacroTech logo (`docs/topbar/`, and as drawn in `web/src/index.html`: the top bar
and the tab icon), which is MacroTech's own artwork with all rights reserved. What the page bundles from other projects, and under which licences, is in
`THIRD-PARTY.md`.
