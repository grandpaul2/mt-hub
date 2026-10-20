# The microphone chain: the game's, in the hub

**Status:** as built, 2026-10-20. Every hub voice chat sends your microphone through the chain a
player's microphone goes through in game: Simple Voice Chat 2.6.24 at its defaults, then the
keyboard noise gate of the group's game mod (MT Utils). Switching between the hub and the game
should not change how you sound. This replaced the hub's own chain (DeepFilterNet3, a Silero
gate with its own rules, the browser's automatic gain), which sounded quieter, more heavily
gated and less clear than the same person in game.

## The chain, per 20 ms frame

| Step | What | Default |
|------|------|---------|
| Capture | `getUserMedia` with echo cancelling, noise suppression and automatic gain all off; mono, 48 kHz | — |
| RNNoise | two 480-sample frames; the frame's speech probability is the higher of the two. With Noise Suppression off, only the probability is taken | on |
| Gain: Auto | Speex's preprocessor (its own denoiser at its default, −15 dB, and automatic gain to −5 dBFS peak, max 30 dB). The gain may rise 12 dB/s only on frames RNNoise is at least 95% sure are speech, and not while muted | Auto |
| Gain: Manual | a fixed gain, −40 to +24 dB, lowered for a frame when the loudest of the last 50 would clip | 0 dB |
| Activation: Voice | Auto: RNNoise ≥ 0.5. Manual: the frame's peak above the threshold | Auto, −50 dB |
| Activation: Push to Talk | the key, while the hub's page has the keyboard | — |
| Tail | Voice 25 frames (500 ms), Push to Talk 5 (100 ms) | — |
| Keyboard gate | Voice only, on the frames that got this far: Silero v6 every 32 ms, the audio held back 3 frames (60 ms), open from a probability ≥ 0.5 for 8 + 3 frames; its verdict and held audio dropped after a second without a frame | on |
| Opus | LiveKit, mono, DTX, RED, at most 51 kbit/s (what Opus picks for 20 ms mono at 48 kHz, as in the game) | — |

Changing the Activation method starts the chain afresh, as Simple Voice Chat makes a new
microphone processor for it. Code: `web/src/svcmic.ts` (the chain), `svcmic.worklet.ts` (the
audio worklet), `native/svc-mic/` (RNNoise, SpeexDSP, Silero as WebAssembly), `voice.ts`
(settings and wiring).

## Voice Settings

Simple Voice Chat's settings, with its defaults; the hub's own words. A setting moved off its
default in a way that makes you sound worse to others is shown in red with a line saying why,
as the game does: Gain: Manual; Microphone gain above +10 dB; a Voice activation threshold of
−10 dB or more (at 0 dB the microphone never opens). Push to Talk works only while the hub is in
front. Gone with the old chain: the noise filter choice, the gate's sensitivity, Automatic
level, Mic level and Echo cancelling. Saved settings went back to these defaults once
(`mt-voice-svc`); devices and volumes were kept.

## How close it is

Measured in `test/unit/svcmic/` against Simple Voice Chat's own natives and the game mod's gate
classes, on made-up input (a synthetic voice, room noise, clicks; two minutes):

- **Speex, Manual gain, Silero:** the same samples and probabilities, exactly.
- **RNNoise:** within 0.03 in probability. On x86, RNNoise's SSE2 code uses the processor's
  approximate reciprocal (`rcpps`), whose low bits Intel and AMD implement differently, so two
  players on different processors don't get the same numbers either. The hub divides exactly.
  A native build of the same sources reproduces Simple Voice Chat exactly with `rcpps` and the
  hub exactly with division: that instruction is the whole difference.
- **The whole chain at the defaults:** the same frames sent, and the same frames out of the
  keyboard gate, on every frame; the level of what is sent the same to 0.001 dB.
- **Not the same:** Opus is the browser's, and a page can't set its expected loss or force
  FEC (Simple Voice Chat always plans for 5% loss).

Cost: about 0.4 ms per 20 ms frame on one core, Silero half of it.
