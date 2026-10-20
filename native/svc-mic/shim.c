// The game's microphone processing for the hub's voice chats (web/src/svcmic.ts): RNNoise
// and Speex's preprocessor, set up the way Simple Voice Chat 2.6.24 sets them up, and the
// keyboard noise gate's Silero as MT Utils runs it, so a hub member's voice goes through the
// same code a player's does. One microphone per instance; the page writes a 20 ms frame of
// 16-bit samples at frame(), then calls denoise, gain and listen.
// Our own code: nothing here is copied from Simple Voice Chat or its native libraries.
// Built by build.sh; why each value is what it is: docs/voice/svc-mic.md.
#include <math.h>
#include "rnnoise.h"
#include "speex/speex_preprocess.h"
#include "weights.h" // the RNNoise model and Silero's weights as bytes (build.sh)
#include "silero.c"

#define FRAME 960 // 20 ms at 48 kHz
#define HALF 480  // RNNoise's frame
#define AGC_TARGET 18427 // -5 dBFS peak: 32768 * 10^(-5/20), rounded

#define EXPORT(name) __attribute__((export_name(name)))

static short samples[FRAME];
static float in[HALF], out[HALF];
static RNNModel *model;
static DenoiseState *rn;
static SpeexPreprocessState *pp;

EXPORT("frame") short *frame(void) { return samples; }

// init loads the model and makes both states; 0 when it worked.
EXPORT("init") int init(void) {
  model = rnnoise_model_from_buffer(weights, sizeof weights);
  if (!model) return 1;
  rn = rnnoise_create(model);
  if (!rn) return 2;
  pp = speex_preprocess_state_init(FRAME, 48000);
  if (!pp) return 3;
  spx_int32_t on = 1, target = AGC_TARGET;
  if (speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_AGC, &on) < 0) return 4;
  if (speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_VAD, &on) < 0) return 5;
  if (speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_AGC_TARGET, &target) < 0) return 6;
  if (silero_load(silero, sizeof silero)) return 7;
  return 0;
}

// denoise runs RNNoise over the frame's two halves and returns the higher speech probability.
// With replace, the cleaned audio takes the frame's place; without, the frame is left alone
// (Noise Suppression off still asks RNNoise whether it's speech).
EXPORT("denoise") float denoise(int replace) {
  float best = 0;
  for (int h = 0; h < 2; h++) {
    short *s = samples + h * HALF;
    for (int i = 0; i < HALF; i++) in[i] = s[i];
    float p = rnnoise_process_frame(rn, out, in);
    if (p > best) best = p;
    if (!replace) continue;
    for (int i = 0; i < HALF; i++) {
      float v = out[i];
      s[i] = v >= 32767.0f ? 32767 : v <= -32768.0f ? -32768 : (short)lrintf(v);
    }
  }
  return best;
}

// gain runs Speex's preprocessor on the frame (its own denoiser at its default, and the
// automatic gain), letting the gain rise by at most increment dB a second.
EXPORT("gain") void gain(int increment) {
  spx_int32_t inc = increment;
  speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_AGC_INCREMENT, &inc);
  speex_preprocess_run(pp, samples);
}

// listen gives the frame to the keyboard gate's Silero and returns the newest probability of
// speech (one per 32 ms; frames between keep the last).
EXPORT("listen") float listen(void) { return silero_hear(samples, FRAME); }

// forget drops the last probability, as the gate does after a second without frames; what
// Silero has heard so far stays, as in the game.
EXPORT("forget") void forget(void) { probability = 0; }
