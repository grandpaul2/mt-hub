# Tests

## Go tests

    make check                              # type check, go vet, go test ./...
    go test ./internal/server -run TestVoice   # one Go test (or a few, by name pattern)

`make check` builds the page first, because the Go code embeds it.

## Browser tests

`test/browser/` has one suite per area (`ls test/browser`; each `<name>.mjs` is a suite).
Each suite starts its own hub on a free port with a throwaway data directory, seeded by
`lib.mjs` (a few files, screenshots, map art and schematic posts), and drives it in headless
Chromium over the DevTools protocol, so they need nothing from npm. A failed suite keeps its
data and the hub's log in `/tmp/mthub-<suite>-*`.

    make browser-test                      # all except previews, about 30 s
    node test/browser/run.mjs tree moves   # just those (the rest are listed as skipped)
    node test/browser/run.mjs --all        # including previews, which fetches real sites
    node test/browser/run.mjs --serial     # one at a time (they run side by side by default)

Success is the last line `N/N suites passed`.

Screenshots from the runs land in `test/browser/out/` for a person to look at.

Needs:

- `chromium` on the PATH. `CHROMIUM=<program>` drives another Chromium-based browser
  (`google-chrome`, say), and `CHROMIUM_FLAGS` adds flags for it.
- The `voice` and `stream` suites run a LiveKit server. `run.mjs` downloads it once, before the
  suites start, into `fetched/livekit-server` (not in git; checked against LiveKit's published
  checksum). That needs network access to github.com, `curl`, `tar` and `sha256sum`, and the
  download is the Linux x86-64 build, so on other systems these two suites cannot run: name
  the others instead.
- The `relay` suite runs a MediaMTX server, downloaded the same way into `fetched/mediamtx`
  (Linux x86-64), and `ffmpeg` from the PATH (with libx264 and libopus) as the streamer.

The browser has a fake microphone (beeps). `FAKE_AUDIO=<file.wav> node test/browser/run.mjs
voice-lab` records that file instead: speech mixed with noise shows the filters and the speech
gate doing their job in the screenshot. `FAKE_AUDIO=<speech.wav>` with `voice` also checks the
speaking light.

## Firefox check

Headless browsers can't see what a GPU actually puts on screen. `make firefox-check`
(`test/firefox/check.mjs`) opens a visible Firefox window for about a minute, with a throwaway
profile set to GPU rendering (WebRender over EGL/DMA-BUF) and a throwaway hub, and for each
main view compares the real screen pixels with Firefox's own capture. It caught the bottom
pixel row of g/p/y going missing in file-tree names (text cut short with "…" whose box edge sat
on a half pixel).

It is run by the maintainer, by hand, before a styling change is released; it needs the X
display, i3 and maim, so most contributors cannot run it. A contributor, or their agent, says
in the pull request that a styling change needs it. Native sliders are left out (GTK draws
their thumb a few pixels differently in the capture). `--software` runs it with software
rendering, for comparison.
