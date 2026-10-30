# svc-mic: the microphone chain's native code

`web/src/svc-mic.wasm` is RNNoise, SpeexDSP and Silero VAD built for the browser, so a hub
member's microphone goes through the same code as a player's in Simple Voice Chat 2.6.24 with
the keyboard noise gate. The design, and what it matches how closely: `docs/voice/svc-mic.md`.

The `.wasm` is committed, so building the hub needs none of this. Run `build.sh` only to change
it; it fetches what it needs into `fetched/` and checks each against a pinned hash.

    native/svc-mic/build.sh     # needs git, curl, python3; fetches zig 0.14.1 (about 50 MB)

| File | What |
|------|------|
| `build.sh` | the pins (RNNoise commit and model, SpeexDSP tag, zig, Emscripten's SSE headers) and the build |
| `shim.c` | our exports: `init`, `frame`, `denoise`, `gain`, `listen`, `forget` |
| `silero.c` | Silero VAD's 16 kHz network and the 48 to 16 kHz low-pass, in plain float maths |
| `silero16k.bin` | Silero's weights and the low-pass taps, made by `silero-export.py` from Silero VAD v6 |
| `licenses/` | the licences of what the `.wasm` contains (copied into `web/dist/voice/licenses/`) |

## How each part is pinned

- **RNNoise:** `xiph/rnnoise` at `372f7b4` (one commit after v0.2), its "little" model
  (`rnnoise_data-0b50c45`), built with `USE_WEIGHTS_FILE`. The weights are dumped from that model
  without its float debug copies (`DISABLE_DEBUG_FLOAT`); the result is checked against the hash
  of the file Simple Voice Chat loads (`weights_blob_small.bin`, rnnoise4j 2.1.3), and matches it
  byte for byte.
- **RNNoise's SSE2 code:** on x86-64, where most players are, RNNoise compiles its SSE2 path,
  whose approximations differ from its plain C. Emscripten's `xmmintrin.h` and `emmintrin.h`
  turn those intrinsics into WebAssembly SIMD, so the hub runs the same path.
- **SpeexDSP:** tag `SpeexDSP-1.2.1`, `FLOATING_POINT` and `USE_SMALLFT`, as speex4j 1.0.3.
- **Flags:** `-Oz`, as Simple Voice Chat's natives; `-ffp-contract=off` for `silero.c`, so its
  float maths is Java's.
- **Silero:** the same weights file, byte for byte, as the game's keyboard noise gate.

## Checks

`make check` runs `test/unit/` (`test/unit/svcmic/`), which compares this module with Simple
Voice Chat's natives and the game's keyboard gate on made-up input. The reference data in
`test/unit/svcmic/ref/` is committed, so the check needs nothing else. It is written by
`make-refs.sh` from those mods' jars, one of them MacroTech's private mod, so only the
maintainer regenerates it.
