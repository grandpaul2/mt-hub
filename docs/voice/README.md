# Hub voice chats: design and research

**Status:** the built design is first on this page and in [`rooms-design.md`](rooms-design.md).
The research reports in this folder are records of how it was chosen; the original proposal,
which the lab results overturned in one place (echo cancellation), is kept at the end, marked
superseded.

- [`rooms-design.md`](rooms-design.md): the design as built (current spec).
- `noise-suppression.md`: noise models that run in the browser (research record).
- `audio-chain.md`: voice detection, echo cancellation, gain and Opus settings (research
  record).
- `transport.md`: the server, the TURN relay and where media runs (research record).
- `prior-art.md`: what Jitsi, Element Call, Mumble, Stoat, Fluxer and others ship, and what
  users complain about (research record).
- `svc/`: Simple Voice Chat and Voice Link between game servers.

## The design as built

**Server:** a self-hosted LiveKit server, one binary with no Redis.
- **Signalling:** goes through the reverse proxy.
- **Media:** goes directly over UDP.
- **Login:** the hub checks your session and gives the browser a short-lived LiveKit token.

**The sending chain, in order:**
1. **Microphone:** mono at 48 kHz, with the browser's echo cancellation, noise suppression and
   gain control all off by default (see the finding below).
2. **Gain.** A mic level setting for quiet microphones.
3. **DeepFilterNet3**, with RNNoise as the fallback (lighter; used when the CPU can't keep up).
4. **Silero speech gate**, holding back about 100 to 200 ms (the delay budget is about 150 ms
   mouth to ear).
5. **Opus:** mono, with FEC and DTX, published to LiveKit.

The filters load only when someone first joins voice. The files are served by the hub itself.

## The voice lab

**Where:** `/voice-lab/` on the hub, behind login. Source: `web/src/voicelab.ts`. It is a test
page that was used to choose the chain above by ear, and it stays as a tool.

**Recording:**
- Every filter runs live on one audio graph during a single recording: raw (echo cancelling
  only), the browser's own noise suppression (a second capture of the mic), RNNoise, GTCRN and
  DeepFilterNet3.
- The recorder notes whenever the audio thread falls behind, so recording with the game in
  front tests the background-tab risk.
- If the browser can't give the second capture its own setting, the Browser track is dropped
  and the page says so, rather than tainting every track.

**Playback:**
- Tracks are lined up and set to the same speech loudness.
- Keys 1 to 5 switch track without losing your place.
- Gate choices are off, a volume gate, or a Silero v6 speech gate. The speech gate's timing is
  simulated honestly: 2 frames to open, 200 ms of buffered audio so the first word survives,
  500 ms hold. A sensitivity slider adjusts it.

**Numbers it reports:** the delay each filter adds, plus CPU cost from an offline run of each
filter.

**First results** (Chromium, synthetic speech plus typing):
- **Delay added:** RNNoise 21 ms, GTCRN 32 ms, DeepFilterNet3 41 ms.
- **CPU:** RNNoise about 1% of one core, GTCRN about 3.5%, DeepFilterNet3 about 5%. Firefox
  measured about the same.

### Finding: Firefox's echo cancellation chops up the voice

**Symptom:** with a separate USB microphone and USB headphones in Firefox 156, the first few
seconds were quiet or missing, and after that the audio was spotty. It was the same on every
track, including Raw. Discord was fine with the same hardware.

**How it was narrowed down,** with the lab's switches and dropout counters:
- **Not lost audio:** no data-less blocks and no exact-zero blocks were recorded. The sound was
  squashed, not missing.
- **Both switches on:** spotty.
- **Both off:** clear.
- **Echo cancelling on, second capture off:** spotty. So the cause is Firefox's echo
  cancellation, not the second capture, the filters or the clock.

**Consequence:** this overturned the research's "keep the browser's echo cancellation on". Voice
chats default to echo cancellation **off** (as Discord's headphone users effectively have it),
with a setting to turn it on for people on speakers. The lab starts with it off.

**Not known:** why it squashes speech when there's no far-end audio to cancel.

### Listening results (Firefox, USB microphone, headphones)

- **Speech gate:** at every sensitivity, typing alone never opens it. Keyboard noise only gets
  through while the person is talking. Whole stretches of typing come out silent on every track,
  Raw included, which is the gate doing its job.
- **Noise filters, gate off:**
  - **RNNoise and DeepFilterNet3:** both filter out the keyboard well.
  - **DeepFilterNet3:** slightly better while talking.
- **Recordings:** sound fine.

Chosen: DeepFilterNet3 as the main filter with RNNoise as the fallback, the Silero speech gate,
echo cancellation off by default.

### Left over from the lab

- **Mic level:** one take peaked at only −31 dBFS with all processing off. Quiet mics need a
  gain slider, or some form of auto gain.
- **Drawing quirk:** the lab sometimes showed DeepFilterNet3 as flat when its audio was fine.
  Not chased.
- **Delay budget:** mouth to ear should stay under about 150 ms (ITU G.114).
  - **The filter:** DeepFilterNet3's 41 ms against RNNoise's 21 ms is not a reason to choose
    RNNoise.
  - **The gate:** its 200 ms hold-back is the big item. Try about 100 ms and check that word
    starts survive.

### Open questions only our own tests answer

- **Keyboard noise:** no benchmark measures mechanical keyboards, so we need our own
  recordings.
- **Firefox:** DeepFilterNet3's CPU load in Firefox on x86 hasn't been measured, and the
  `web-noise-suppressor` worklets haven't been tried in Firefox.
- **Speakers:** the game's own audio is never cancelled, so on speakers it leaks into the mic.
  Headphones are the real fix.
- **Linux:** echo cancellation on Linux/PipeWire hasn't been tested.
- **Strict networks:** a TURN relay over TLS on port 443 would clash with a reverse proxy on
  the same port. Without it, some strict networks can't connect.
- **Background tabs:** browsers can throttle a background tab and starve the worklet. Fluxer
  confirmed this causes choppy audio.

## Original proposal (superseded)

The first proposal, before the lab. It differs from the design above in the microphone step
and may differ in playback. Kept for the reasoning.

- **Server:** LiveKit, one binary with no Redis. Fallbacks: LiveKit's own TURN relay and
  ICE/TCP. Runner-up: Galène.
- **Microphone:** mono at 48 kHz. **The browser's echo cancellation stays ON;** its noise
  suppression and gain control are OFF (superseded: the lab found echo cancellation chops up
  voices in Firefox, so it is off by default). A manual gain slider replaces browser gain
  control, which can turn down the system mic level.
- **Noise model** in an AudioWorklet. The candidates:
  - **DeepFilterNet3:** best measured quality. Downloads about 24 MB and adds about 90 ms of
    delay.
  - **RNNoise 0.2:** cheap and mature, weaker on clicks.
  - **GTCRN:** very cheap, but only 16 kHz.
- **Voice gate:** Silero VAD (MIT licence) controlling a gain node. Two thresholds, like
  Mumble: open at about 0.5, close about 0.15 lower. 250 to 400 ms hold, and 150 to 250 ms of
  buffered audio so the first word isn't clipped. A sensitivity slider and a level meter.
- **Opus:** mono, about 32 kbps, with FEC and DTX, 20 ms packets.
- **Playback:** incoming voices in `<audio>` elements, not through Web Audio, so
  that echo cancellation can hear them.
- **Fallback:** if the model overloads the CPU or the level collapses, switch back to the
  browser's own noise suppression (Fluxer does this).
- **Reusable code:** `@sapphi-red/web-noise-suppressor` (MIT, used by Fluxer and Nextcloud) has
  RNNoise, Speex, gate and GTCRN worklets. Fluxer's code is AGPL, so it is only a design
  reference.
