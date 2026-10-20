# Third-party work in the hub

The hub's own code is MIT (see `LICENSE`). The page it serves also contains other people's
work. Most of it is not in this repository: it is fetched by `npm ci` and built into `web/dist`,
and so into the `mthub` binary. Two exceptions: the Lucide icon paths, copied into the source,
and the voice microphone chain, `web/src/svc-mic.wasm`, built by `native/svc-mic/build.sh` from
RNNoise, SpeexDSP and Silero VAD's weights and committed; their licence texts are in
`native/svc-mic/licenses/`, and are served beside the module in `web/dist/voice/licenses/`. The new-message sound (`web/src/sounds/message.mp3`) is the project's own: a
script in the same folder generates it, and it is under the project's MIT licence.

The table lists the direct dependencies. Their own dependencies are bundled too, under their
own licences; the full set is in `package-lock.json` (and `go.sum` for Go).

| What | Where it's used | Licence |
|------|-----------------|---------|
| [Lucide](https://lucide.dev) icons | toolbar and button icons, copied as SVG paths into `web/src/*.ts` | ISC (below) |
| [Twemoji](https://github.com/jdecked/twemoji) graphics (`@twemoji/svg`), `@twemoji/parser` | emoji images | graphics CC-BY 4.0, code MIT |
| [Emojibase](https://emojibase.dev) data | emoji names for the picker and `:name:` | MIT |
| Noto Sans, JetBrains Mono (`@fontsource-variable/*`) | the page's fonts | SIL Open Font License 1.1 |
| [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) | file and folder icons (its `LICENSE` is copied into `web/dist/icons/`) | MIT |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | the file editor | MIT |
| [Codicons](https://github.com/microsoft/vscode-codicons) (the icon font inside Monaco, `codicon-*.ttf` in `web/dist`) | the editor's own icons | font CC BY 4.0, code MIT |
| [marked](https://github.com/markedjs/marked) | Markdown files | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | cleaning rendered Markdown | MPL-2.0 or Apache-2.0 |
| [livekit-client](https://github.com/livekit/client-sdk-js) | voice chats and screen sharing | Apache-2.0 |
| [RNNoise](https://github.com/xiph/rnnoise) and its small model, in `web/src/svc-mic.wasm` (`native/svc-mic/`) | the microphone's noise suppression and speech detection | BSD-3-Clause |
| [SpeexDSP](https://github.com/xiph/speexdsp), in `web/src/svc-mic.wasm` | the microphone's automatic gain | BSD-3-Clause |
| [Silero VAD](https://github.com/snakers4/silero-vad) v6 weights (`native/svc-mic/silero16k.bin`), in `web/src/svc-mic.wasm` | the keyboard noise gate's speech detector | MIT |
| Emscripten's SSE headers (`xmmintrin.h`, `emmintrin.h`), used to build `web/src/svc-mic.wasm` | RNNoise's x86 code on WebAssembly | MIT or UIUC |

**Lucide** is used under the ISC licence. Copyright (c) for portions of Lucide are held by
Cole Bemis 2013-2022 as part of Feather (MIT); all other copyright (c) for Lucide are held by
Lucide Contributors 2022.

**Codicons** are © Microsoft Corporation, licensed under the Creative Commons Attribution 4.0
International Public License (<https://creativecommons.org/licenses/by/4.0/>); the font is
unmodified.

Go modules: `golang.org/x/crypto`, `x/image`, `x/term` (BSD-3-Clause) and
`github.com/coder/websocket` (ISC).

The browser tests download a [LiveKit server](https://github.com/livekit/livekit) binary
(Apache-2.0) into `fetched/`; it isn't part of the hub.
