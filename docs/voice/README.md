# Hub voice rooms: research summary

The research is in four reports in this folder. This page draws them together.

- `noise-suppression.md`: noise models that run in the browser.
- `audio-chain.md`: voice detection, echo cancellation, gain and Opus settings.
- `transport.md`: the server, the TURN relay and where media runs.
- `prior-art.md`: what Jitsi, Element Call, Mumble, Stoat, Fluxer and others ship, and what users complain about.

## Proposed design (not decided yet)

**Server:** a self-hosted LiveKit server, one binary with no Redis, on the Vultr relay VPS.
- **Signalling:** goes through Caddy.
- **Media:** goes directly over UDP.
- **Fallbacks:** LiveKit's own TURN relay and ICE/TCP.
- **Login:** the hub checks your session and gives the browser a short-lived LiveKit token.
- **Not on the home server:** the ssh tunnel only carries TCP, and it adds a hop.
- **Runner-up:** Galène.

**The sending chain, in order:**
1. **Microphone:** mono at 48 kHz. The browser's echo cancellation stays ON; its noise suppression and gain control are OFF. A manual gain slider replaces browser gain control, which can turn down the system mic level.
2. **Noise model** in an AudioWorklet. The candidates:
   - **DeepFilterNet3:** best measured quality. Downloads about 24 MB and adds about 90 ms of delay.
   - **RNNoise 0.2:** cheap and mature, weaker on clicks.
   - **GTCRN:** very cheap, but only 16 kHz.
3. **Voice gate:** Silero VAD (MIT licence) controlling a gain node.
   - **Thresholds:** two, like Mumble: open at about 0.5, close about 0.15 lower.
   - **Timing:** 250 to 400 ms hold, and 150 to 250 ms of buffered audio so the first word isn't clipped.
   - **Settings:** a sensitivity slider and a level meter.
4. **Opus:** mono, about 32 kbps, with error correction (FEC) and silence suppression (DTX), 20 ms packets.
5. **Playback:** incoming voices play in `<audio>` elements, not through Web Audio, so that echo cancellation can hear them.

**Fallback:** if the model overloads the CPU or the level collapses, switch back to the browser's own noise suppression (Fluxer does this).

**Reusable code:** `@sapphi-red/web-noise-suppressor` (MIT, used by Fluxer and Nextcloud) has RNNoise, Speex, gate and GTCRN worklets. Fluxer's code is AGPL, so we can use it only as a design reference.

## The voice lab

**Where:** `https://macrotechmc.com/voice-lab/` (mt-hub `635b2e9`), behind login. Source: `~/mt-hub/web/src/voicelab.ts`.

**Recording:**
- Every filter runs live on one audio graph during a single recording: raw (echo cancelling only), the browser's own noise suppression (a second capture of the mic), RNNoise, GTCRN and DeepFilterNet3.
- The recorder notes whenever the audio thread falls behind, so recording with the game in front tests the background-tab risk.
- If the browser can't give the second capture its own setting, the Browser track is dropped and the page says so, rather than tainting every track.

**Playback:**
- Tracks are lined up and set to the same speech loudness.
- Keys 1–5 switch track without losing your place.
- Gate choices are off, a volume gate, or a Silero v6 speech gate. The speech gate's timing is simulated honestly: 2 frames to open, 200 ms of buffered audio so the first word survives, 500 ms hold. A sensitivity slider adjusts it.

**Numbers it reports:** the delay each filter adds, plus CPU cost from an offline run of each filter.

**First results on the dev box** (Chromium, synthetic speech plus typing):
- **Delay added:** RNNoise 21 ms, GTCRN 32 ms, DeepFilterNet3 41 ms.
- **CPU:** RNNoise about 1% of one core, GTCRN about 3.5%, DeepFilterNet3 about 5%. Firefox measured about the same.

## Finding: Firefox's echo cancellation chops up the voice

**Symptom:** on Paul's setup, a separate ATR2100x USB mic plus BH300 USB headphones in Firefox 156, the first few seconds were quiet or missing, and after that the audio was spotty. It was the same on every track, including Raw. Discord was fine with the same hardware.

**How it was narrowed down,** with the lab's switches and dropout counters:
- **Not lost audio:** no data-less blocks and no exact-zero blocks were recorded. The sound was squashed, not missing.
- **Both switches on:** spotty.
- **Both off:** clear.
- **Echo cancelling on, second capture off:** spotty. So the cause is Firefox's echo cancellation, not the second capture, the filters or the clock.

**Consequence:** this overturns the research's "keep the browser's echo cancellation on". Voice rooms default to echo cancellation **off** (as Discord's headphone users effectively have it), with a setting to turn it on for people on speakers. The lab now starts with it off (mt-hub `e230d24`).

**Not known yet:** why it squashes speech when there's no far-end audio to cancel.

## Paul's listening results (Firefox, ATR2100x, headphones)

- **Speech gate:** at every sensitivity, typing alone never opens it. Keyboard noise only gets through while he's talking. Whole stretches of typing come out silent on every track, Raw included, which is the gate doing its job.
- **Noise filters, gate off:**
  - **RNNoise and DeepFilterNet3:** both filter out the keyboard well.
  - **DeepFilterNet3:** slightly better while he's talking.
- **Recordings:** sound fine to him.

**Chosen chain:**
- **Main filter:** DeepFilterNet3, with RNNoise as the fallback (lighter; used when the CPU can't keep up).
- **Gate:** the Silero speech gate.
- **Echo cancellation:** off by default.

The lab is done; no more work on it (Paul: "waaaaay into the weeds").

**Left for when voice rooms get built:**
- **Mic level:** Paul's take peaked at only −31 dBFS with all processing off. Voice rooms will need a gain slider, or some form of auto gain, for quiet mics.
- **Drawing quirk:** the lab sometimes showed DeepFilterNet3 as flat when its audio was fine. Not chased.
- **Delay budget:** mouth to ear should stay under about 150 ms (ITU G.114).
  - **The filter:** DeepFilterNet3's 41 ms against RNNoise's 21 ms is not a reason to choose RNNoise.
  - **The gate:** its 200 ms hold-back is the big item. Try about 100 ms and check that word starts survive.

## Open questions only our own tests answer

- **Keyboard noise:** no benchmark measures mechanical keyboards, so we need our own recordings.
- **Firefox:** DeepFilterNet3's CPU load in Firefox on x86 hasn't been measured, and the `web-noise-suppressor` worklets haven't been tried in Firefox.
- **Speakers:** the game's own audio is never cancelled, so on speakers it leaks into the mic. Headphones are the real fix.
- **Linux:** echo cancellation on Linux/PipeWire hasn't been tested.
- **Strict networks:** a TURN relay over TLS on port 443 would clash with Caddy. Without it, some strict networks can't connect.
- **Background tabs:** browsers can throttle a background tab and starve the worklet. Fluxer confirmed this causes choppy audio.
