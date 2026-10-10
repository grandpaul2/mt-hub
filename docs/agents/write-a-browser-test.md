# Write a browser test

Use this when you add or fix anything the page does. Every change comes with a check that
fails on the old code: a Go test for server rules, a browser suite for what a person sees.

## How a suite works

`test/browser/lib.mjs` starts, on import, a fresh hub (its own temp data directory, a free
port, seeded with a few files, screenshots, map art and schematic posts) and a headless
Chromium driven over the DevTools protocol. A suite is one `.mjs` file that imports helpers
from `./lib.mjs`, drives the page, calls `check(label, got, want)` and ends with
`await done()`. It prints `ok` or `FAIL` for each check and `all passed` at the end.

## Steps

1. **Pick the area.** If a suite for it exists (`ls test/browser`), add checks to it. A new
   area gets a new file `test/browser/<name>.mjs`: `run.mjs` finds every `.mjs` in the folder
   (except `lib` and `run`) and runs it, so there is nothing to register.
2. **Start from a short suite as a model.** `test/browser/serverstatus.mjs` (a command),
   `test/browser/drafts.mjs` (chat box state) and `test/browser/login.mjs` are good ones.
3. **Set up through the API,** not the page: `api(method, path, body, who)` calls the hub as a
   seeded user, `hub(path, init)` as the main one. Create chat messages, files or tokens
   that way, then `send('Page.navigate', { url: HUB + '#chan=general' })` and `await
   settle(ms)`.
4. **Drive and read the page** with `ev(js)` (runs JavaScript in the page and returns the
   value), `key('Enter')`, `typeText('...')`, `answerDialogs(true)` for confirmation dialogs.
5. **Check with `check(label, got, want)`.** Compare plain values (strings, numbers, arrays).
   Wait with `settle(ms)` or `until(what, fn)` instead of fixed sleeps where you can.
6. **Take a screenshot** with `shot('name')` for a person to look at later; it lands in
   `test/browser/out/` (ignored by git). Nothing checks it.
7. **Prove it fails on the old code:** stash your page or server change, run the suite, see
   the `FAIL`, restore the change, see `all passed`.
8. **If it needs a second person,** log in as another seeded user with `as('Alex')` or open a
   second browser profile as `voice.mjs` does.

## Run it

    node test/browser/run.mjs mysuite             # just this one (the rest are listed as skipped)
    node test/browser/run.mjs mysuite other       # several
    make browser-test                             # all, about 30 s on a fast machine

A failed suite keeps its data and the hub's log in `/tmp/mthub-<suite>-*` and prints where.
`run.mjs` builds the page and the server first, so a page change shows up without a separate
`make`.

## What people get wrong

- Running `node test/browser/mysuite.mjs` directly: it needs `MTHUB_BIN`. Go through `run.mjs`.
- Checking with fixed `sleep`s. A change made through the API reaches the page as a live
  update; `settle()` waits for it.
- Leaving a started process or a temp directory behind: end with `await done()`.
- Relying on real websites. The `previews` suite is the only one allowed to, and it is skipped
  unless asked for.
- The `voice` and `stream` suites need a downloaded LiveKit server and Linux x86-64
  (`docs/testing.md`); do not model an ordinary suite on them.
