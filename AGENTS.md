# AGENTS.md

Guidance for an AI coding agent (or a person) changing mt hub. The README says what the hub is
and how to try it; this file is how to change it.

## What this is

mt hub is a small self-hosted web app that replaces Discord for one Minecraft group
(MacroTech): a git-backed file tree with previews and a plain text editor, chats, voice chats
and screen sharing. One Go binary with the page built in. The page is plain TypeScript, no
framework. All data is plain files in the data directory. It is not a code editor or IDE, not
a general chat product, and not a Minecraft mod. The game-server side is MacroTech's own mod
(MT Utils, private to the group), which talks to the hub only through the token routes in
[`docs/api.md`](docs/api.md); that API is the contract.

## What you can build

New features, experiments and fixes are all welcome: build what your human asked for. The hub
is for a group playing a game together, so it is meant to be fun to change. The maintainer
tries every pull request before merging, so it does not have to be perfect. If you want a
starting point: `OPEN.md` is the work open now (take an item by saying so in the chat or
opening a draft pull request), and `LATER.md` holds ideas for later.

To make a change fit in, follow `docs/style-guide.md`: it describes how the page looks and
behaves. If your change does something different on purpose, say so in the pull request.

## Set up and commands

Needs: Go (the version in `go.mod`; an older Go stops with "go.mod requires go >= ..."), Node
with npm (current release; Node 20.11 or newer), and for the browser tests `chromium` on the
PATH (`CHROMIUM=google-chrome` uses another browser).

    make                                  # npm ci, bundle the page, build bin/mthub
    make check                            # tsc, unit tests, go vet, go test ./...   (first run is slower)
    make browser-test                     # the page in headless Chromium, about two minutes
    make browser-test SKIP=voice,stream,relay   # all but those (what your machine can't run)
    node test/browser/run.mjs tree chats  # just those suites
    go test ./internal/server -run TestVoice   # one Go test
    npx tsc                               # type check only

- **Success:** `make check` ends with `ok` lines and no error; `make browser-test` ends with
  `N/N suites passed`.
- **Network for some tests.** The `voice` and `stream` suites download a LiveKit
  server from github.com on their first run; they work on Linux x86-64 only and need `curl`,
  `tar` and `sha256sum`. The `relay` suite downloads a MediaMTX server the same way and needs
  `ffmpeg` (with libx264 and libopus) on the PATH. Elsewhere, leave them out with `SKIP=`.
- **`internal/voicebridge`'s tests need the LiveKit server** the `voice` suite downloads
  (`fetched/livekit-server`). Without it they print `NOT TESTED` and are skipped: run
  `make browser-test` once, or say they were not run.
- **Always build the page before Go.** `web/dist` is generated, and the Go code embeds it. On a
  fresh clone `go vet` or `go test` alone fails with `pattern dist: no matching files found`;
  run `make` or `make check` first.
- **Do not run `make firefox-check`.** It compares a real Firefox's screen with what Firefox
  meant to draw, on the maintainer's machines; only the maintainer runs it. If your change
  touches styling, say in the pull request that it needs the Firefox check.
- **A hub started to try a change is a throwaway.** Give it its own `-data` directory and
  `-addr`, never the default `./data` or port 8484 if something real may be running:
  `./bin/mthub passwd -data /tmp/scratch -admin=true alice` (flags before the name), then
  `./bin/mthub -dev -addr 127.0.0.1:8601 -data /tmp/scratch`. Stop it when you are done.

## Find your task

| If you were asked to... | Guide | Main files |
|---|---|---|
| add or change an API route, a permission, or a server rule | [`docs/agents/add-a-route.md`](docs/agents/add-a-route.md) | `internal/server/*.go`, `docs/api.md` |
| change what the page shows or does | [`docs/agents/change-the-page.md`](docs/agents/change-the-page.md) | `web/src/*.ts`, `web/src/style.css` |
| add a `/` command in the chat box | [`docs/agents/add-a-chat-command.md`](docs/agents/add-a-chat-command.md) | `web/src/commands.ts` |
| write or fix a browser test | [`docs/agents/write-a-browser-test.md`](docs/agents/write-a-browser-test.md) | `test/browser/*.mjs` |
| fix the docs only | edit the file; keep `docs/README.md` true | `docs/`, `README.md` |
| finish, start or drop an open item | rewrite its line in `OPEN.md` in the same pull request (done: remove it) | `OPEN.md`, `LATER.md` |

## Where things are

- `cmd/mthub`: the program and its `passwd`, `user`, `token` commands. `cmd/voicelink`: a
  separate small relay for Simple Voice Chat between game servers (`internal/voicelink`).
  `cmd/voicebridge`: a separate program that joins one hub voice chat to that relay
  (`internal/voicebridge`; it is the only thing that uses LiveKit's Go library, which the
  hub's own binary does not carry).
- `internal/server/`: every route, headers (`headers.go`), disk limits (`limits.go`), tokens
  (`tokens.go`), the event stream (`events.go`).
- `internal/auth`: accounts, sessions, tokens. `internal/workspace`: the Files tree (a git
  repo, every save a commit). `internal/chat`: chats as append-only files.
  `internal/preview`: link previews. `internal/imgs`: image helpers.
- `web/src/*.ts`: the page, bundled by `build.mjs` into `web/dist` (generated, not tracked).
  `main.ts` files, `chat.ts` chats, `folder.ts` folder view, `viewer.ts` single item,
  `schems.ts` schematic posts, `commands.ts` `/` commands, `voice.ts` (and `svcmic.ts`, the
  microphone chain, with its native part in `native/svc-mic/`), `stream.ts`,
  `admin.ts`, `util.ts` shared helpers, `style.css` all styles.
- `test/browser/`: one suite per area; `lib.mjs` has the helpers and the seed data.
  `test/unit/`: Node tests `make check` runs (the microphone chain against reference output).
  `test/perf/`: a page-load measurement, run by hand. `test/firefox/`: the real-screen check
  (maintainer only).
- `docs/`: [`docs/README.md`](docs/README.md) indexes it. `docs/style-guide.md` is the design
  reference and wins over the code; `docs/architecture.md` is the map, with the names the hub
  expects (`#text-link`, `commands/`, ...).

## Rules

- **A change comes with a check that fails on the old code**: a Go test, or a browser suite.
  Otherwise nobody can tell the change does anything.
- **Read `docs/style-guide.md` before changing how anything looks or behaves,** so the change
  fits in with the rest of the page: the sections for your area (the change-the-page guide
  lists them), not all of it. It records the group's decisions on look and behaviour.
- **Text a member wrote is never parsed as HTML.** Build nodes with `h()` from `util.ts`. The
  two places that render Markdown go through `cleanHTML`. Use `innerHTML` only with a constant,
  because a member could otherwise plant a script.
- **Every change to data is a `fetch` from the page's script.** The server refuses a form post
  and the page's policy forbids one; a form could be planted by member-written HTML.
- **A chat route goes through `inChat`** (`private.go`), so private chats and DMs stay
  private. Search, events and lists must only carry what the caller can see.
- **A token reaches only the routes listed for its kind** (`serverAllow` or `releaseAllow` in
  `tokens.go`; `tokenAllow` maps a kind to its list). A game server's token sits in a config
  file on a rented host, so a new route stays closed to tokens unless added there on purpose.
- **Anything that stores bytes checks the disk first** (`roomFor`, and `floored` for a large
  upload) and has a size limit. The hub must never fill its disk.
- **File names and paths go through `workspace.Clean`.** It refuses `.git` parts and control
  characters that would break the history.
- **The page a browser has open may be older than the server.** Add to an API's answer; do not
  change the shape of something the page already reads, and the same for cached files.
- **Keep the page's files inside the hub.** It ships its own fonts and emoji and loads nothing
  from other sites; the Content Security Policy in `headers.go` enforces it and the browser
  suites fail on anything it blocks. A new dependency is fine if it bundles into the page
  that way; mention it in the pull request.
- **Nothing private goes in**: no tokens, addresses, home-folder paths, or real names of people
  in code, tests, docs or commit messages. Use the stand-in names the tests use (Pat, Alex,
  Steve, Peggy, Quinn ...).
- **Write as the project, not as a person.** State a rule as the rule, with its reason in a
  clause. No names, quotes, "X decided", decision numbers or session and date stamps, in docs,
  code comments, test labels or commit messages; say "the maintainer" or "a member" when a role
  matters. A comment says why, never who.
- **No GitHub Actions or other CI.** Nothing on GitHub builds or tests a pull request; the
  maintainer does, on their own machine.

## Check your work

Before you open a pull request, both must pass on your branch:

    make check
    make browser-test        # with SKIP=... for suites your machine can't run; say which

An agent without a display can run both (the browser tests are headless). It cannot run
`make firefox-check`, and cannot judge how something looks on a real screen or a phone. Say
what you could not check: "not checked in Firefox", "not checked on a phone". Never say you
tested something you did not run.

## Send the pull request

- Branch from `master`; one change per pull request; do not bump the version in
  `package.json` (the maintainers release).
- The description says what a member will notice, which commands you ran and their result, and
  what you did not check. It says if an AI agent wrote the change and which. Use the template
  in `.github/pull_request_template.md`.
- Keep tokens, addresses, home-folder paths, surnames and email addresses out of the code,
  the docs and the commit messages.
- Update the docs your change touches (`docs/api.md` for a route, `docs/style-guide.md` for a
  new UI pattern).

## Mistakes agents make here

- **Running `go test` on a fresh clone.** Fails with `pattern dist: no matching files found`.
  Run `make check`, which bundles the page first.
- **Running a suite file directly** (`node test/browser/tree.mjs`). It stops with "MTHUB_BIN
  is not set". Go through `node test/browser/run.mjs tree`.
- **Reading the suite count as all of them.** `previews` is skipped unless you pass `--all`
  (it fetches real sites). Naming or skipping suites lists the rest as "skipped": that is normal.
- **`voice`, `stream` or `relay` failing on a Mac or ARM machine, or without ffmpeg.** They run
  Linux x86-64 servers. Run `make browser-test SKIP=voice,stream,relay` and say so.
- **A failure that is not yours.** A few suites fail on some machines on `master` too
  (`OPEN.md` → Tests); check there before chasing one.
- **Committing generated files:** `web/dist/`, `bin/`, `fetched/`, `data/` and
  `test/browser/out/` are ignored; keep them out of the pull request.
