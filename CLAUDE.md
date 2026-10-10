# CLAUDE.md

Guidance for an AI agent (or a person) working on mt hub. The README says what the hub is and
how each part behaves; this file is the short version of how to change it.

## What this is

A Discord replacement for one Minecraft group: a git-backed file tree with previews and an
editor, chats, voice chats and screen sharing. One Go binary with the web page built into it.
Plain TypeScript in the page, no framework. Data is plain files in the data directory.

## Commands

    make                                # build bin/mthub (the page is bundled into it)
    make check                          # type check, go vet, go test
    make browser-test                   # every browser suite in headless Chromium, about 30 s
    node test/browser/run.mjs tree chats    # just those suites
    ./bin/mthub                         # run it: http://127.0.0.1:8484, data in ./data
    npm run watch  +  ./bin/mthub -dev  # page work: rebuild on save, refresh to see it

You need Go (the version in `go.mod`), Node with npm, and `chromium` on the PATH for the
browser suites (`CHROMIUM=google-chrome` uses another one). Linux or macOS; on Windows, WSL.
`make firefox-check` opens a real Firefox window for a minute; leave it to a maintainer.

Nothing on GitHub builds or tests anything. Run `make check` and `make browser-test` before
you say a change is done, and say in the pull request that they pass.

## Where a change goes

- `internal/server/`: every route (chat, files, voice, streams, tokens, search, headers).
- `internal/auth`: accounts, sessions, tokens. `internal/workspace`: the Files tree (a git
  repo, every save a commit). `internal/chat`: chats as append-only files.
  `internal/preview`: link previews.
- `web/src/*.ts`: the page, bundled by `build.mjs`. `main.ts` files, `chat.ts` chats,
  `folder.ts` folder view, `viewer.ts` single-file bar, `schems.ts` schematic posts,
  `commands.ts` slash commands, `voice.ts`, `stream.ts`, `admin.ts`, `util.ts` shared helpers.
- `test/browser/`: one suite per area; `lib.mjs` has the helpers and the seed data.
- `cmd/voicelink`: a separate small relay for Simple Voice Chat between game servers.
- `docs/`: `style-guide.md` (how the hub looks and behaves; it wins over the code),
  `hub-backlog.md` (specs and the Later list), and the design docs. `docs/README.md` indexes them.

## Rules

- **A change comes with a check that fails on the old code**: a Go test, or a browser suite.
- **Read `docs/style-guide.md` before changing how anything looks or behaves.**
- **Text a member wrote is never parsed as HTML.** Build nodes with `h()` from `util.ts`.
  The two places that render Markdown go through `cleanHTML`. Don't add an `innerHTML` that
  takes anything but a constant.
- **Every change to data is a `fetch` from the page's script.** The server refuses a form
  post, and the page's policy forbids one; don't add a form that submits.
- **A chat route goes through `inChat`** (`private.go`), so private chats and DMs stay
  private. Search, events and lists must only carry what the caller can see.
- **A token reaches only the routes in `tokenAllow`** (`tokens.go`). A new route is closed to
  tokens unless it is added there on purpose.
- **Anything that stores bytes checks the disk first** (`roomFor`, and `floored` for a large
  upload), and has a size limit.
- **File names and paths go through `workspace.Clean`.**
- **The page a browser has open may be older than the server.** Add to an API's answer; don't
  change the shape of something the page already reads, and the same for cached files.
- **No new dependency without asking.** The page ships its own fonts and emoji and loads
  nothing from other sites (the Content Security Policy in `headers.go` enforces it, and the
  browser suites fail on anything it blocks).
- **Nothing private goes in**: no tokens, addresses or names of real people in code, tests,
  docs or commit messages. Tests use Paul, Steve, Alex and Eve.

## Pull requests

Branch from `master`, keep the change to one thing, and open a pull request that says what a
member will notice and that the checks pass. Bigger ideas are in `docs/hub-backlog.md`; ask
before starting one. Don't add GitHub Actions or other automation to the repo.
