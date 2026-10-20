# Hub voice chats: design and research

**Status:** the microphone chain as built is [`svc-mic.md`](svc-mic.md) (since 2026-10-20: the
game's own chain, Simple Voice Chat's and the keyboard noise gate's). The server and rooms are
as built in [`rooms-design.md`](rooms-design.md). Everything else on this page and in the
research reports is a record of how the earlier chain was chosen; the original proposal, which
the lab overturned in one place (echo cancellation), is kept at the end, marked superseded.

- [`svc-mic.md`](svc-mic.md): the microphone chain as built (current).
- [`rooms-design.md`](rooms-design.md): the server and rooms as built (current spec).
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

**The sending chain:** the game's, in [`svc-mic.md`](svc-mic.md): raw microphone, RNNoise,
Speex's automatic gain, Simple Voice Chat's activation and tail, the keyboard noise gate, Opus.
Its file (`svc-mic.wasm`, about 2 MB) loads only when someone first uses voice, from the hub.

## The earlier chain and the voice lab (record)

From 2026-10-03 to 2026-10-20 the hub had a chain of its own, chosen by ear in a voice lab
page (`/voice-lab/`, removed with it; its code is in the history): the browser's automatic gain,
a Mic level, DeepFilterNet3 (RNNoise as a fallback), a Silero gate with 150 ms hold-back and a
sensitivity slider, Opus capped at 32 kbit/s. Hub members came out quieter, more heavily gated
and less clear than the same people in game, so it was replaced by the game's own chain. The
findings below are kept for what they found about browsers.

**The lab, as it was:** every filter ran live on one audio graph during a single recording
(raw, the browser's own suppression, RNNoise, GTCRN, DeepFilterNet3); playback lined the
tracks up at the same loudness, with off, a volume gate or a simulated Silero gate.

**Numbers it reported:** the delay each filter adds, plus CPU cost from an offline run of each
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

### Finding: without automatic gain the chain works on too quiet a signal (2026-10-13)

Measured, not listened to: two people's recordings as a browser's microphone (headless
Chromium, and headless Firefox with a virtual microphone), through this chain, into Simple
Voice Chat's decoder, scored with DNSMOS and against the same recordings sent the way a
player's microphone sends them in game.

- Raw speech from the two microphones sits at −45 and −50 dBFS. With gain control off and the
  mic level at 0, that is what the filter and the gate get.
- At that level, in Chromium, DeepFilterNet3 sent **nothing of the quieter microphone for the
  first 30 seconds** after joining, and never its quiet talking; the gate alone (filter off)
  cut 40% of its quiet talking; RNNoise lowered both voices another 6 to 8 dB.
- With the browser's automatic gain on, both voices come out at −24 to −34 dBFS, the 30
  seconds are gone, quiet talking is whole, and DeepFilterNet3 scores as well as or better
  than the same person's in-game microphone on every recording. Raising Mic level by hand
  (+24 dB) does the same. Typing alone and mouse clicks alone still never open the gate.
- Firefox's automatic gain does the same (it lifts a quiet voice by about 25 dB).

**Consequence:** Automatic level is on by default, with a switch in Voice Settings. The
filter was not at fault and stays the default. Mic level, the hand slider, is extra on top and starts at +0 dB; when Automatic level
arrived, every browser's saved Mic level went back to +0 dB once (`mt-voice-level-reset`),
since a boost set before it would have been added to the browser's own.

Also seen: in Firefox, DeepFilterNet3 stalls the audio thread once as it starts (about
280 ms), and the voice then runs about a quarter second late for the session. Not chased.

### Left over from the lab

- **Mic level:** one take peaked at only −31 dBFS with all processing off. Quiet mics need a
  gain slider, or some form of auto gain. (Settled 2026-10-13: the browser's automatic gain,
  finding above.)
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
