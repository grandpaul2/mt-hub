// The keyboard noise gate's ear, as MT Utils runs it in the game: Silero VAD's 16 kHz network
// (MIT, github.com/snakers4/silero-vad) in plain float arithmetic, and the low-pass filter that
// brings 48 kHz down to 16 kHz in front of it. The same operations in the same order as the
// mod's Java (IEEE single precision, no fused multiply-add: build.sh passes -ffp-contract=off),
// so the hub and the game get the same probabilities. Weights: silero16k.bin (README.md).
#include <math.h>
#include <string.h>

#define WINDOW 512
#define CONTEXT 64
#define PADDED (CONTEXT + WINDOW + 64)
#define BINS 129
#define HIDDEN 128
#define TAPS 61

static const int CHANNELS[5] = {BINS, 128, 64, 64, 128};
static const int STRIDES[4] = {1, 2, 2, 1};

static const float *lowpass, *basis, *conv_w[4], *conv_b[4];
static const float *w_ih, *w_hh, *b_ih, *b_hh, *out_w, *out_b;

static float padded[PADDED], gates[4 * HIDDEN], h[HIDDEN], c[HIDDEN];
static float buf_a[BINS * 4], buf_b[BINS * 4];
static float history[TAPS], window_[WINDOW];
static int position, phase, filled;
static float probability;

// silero_load points at the arrays in the file (magic, then each array as a count and floats);
// 0 when every count is what the network needs.
static int silero_load(const unsigned char *d, int len) {
  if (len < 8 || memcmp(d, "MTSV1\0\0\0", 8)) return 1;
  int at = 8, want[] = {TAPS, 2 * BINS * 256,
                        128 * BINS * 3, 128, 64 * 128 * 3, 64, 64 * 64 * 3, 64, 128 * 64 * 3, 128,
                        4 * HIDDEN * HIDDEN, 4 * HIDDEN * HIDDEN, 4 * HIDDEN, 4 * HIDDEN, HIDDEN, 1};
  const float **into[] = {&lowpass, &basis, &conv_w[0], &conv_b[0], &conv_w[1], &conv_b[1], &conv_w[2],
                          &conv_b[2], &conv_w[3], &conv_b[3], &w_ih, &w_hh, &b_ih, &b_hh, &out_w, &out_b};
  for (int i = 0; i < 16; i++) {
    int n;
    if (at + 4 > len) return 2;
    memcpy(&n, d + at, 4);
    if (n != want[i] || at + 4 + n * 4 > len) return 3;
    *into[i] = (const float *)(d + at + 4); // the file is embedded aligned (build.sh)
    at += 4 + n * 4;
  }
  return 0;
}

static float dot(const float *w, const float *x, int n) {
  float sum = 0.0f;
  for (int i = 0; i < n; i++) sum += w[i] * x[i];
  return sum;
}

static float sigmoid(float v) { return (float)(1.0 / (1.0 + exp(-(double)v))); }

static float silero_window(void) {
  memmove(padded, padded + WINDOW, CONTEXT * sizeof(float));
  memcpy(padded + CONTEXT, window_, WINDOW * sizeof(float));
  for (int j = 0; j < 64; j++) padded[CONTEXT + WINDOW + j] = padded[CONTEXT + WINDOW - 2 - j];

  int time = 4;
  float *x = buf_a, *y = buf_b;
  for (int t = 0; t < time; t++) {
    for (int bin = 0; bin < BINS; bin++) {
      float re = dot(basis + bin * 256, padded + t * 128, 256);
      float im = dot(basis + (bin + BINS) * 256, padded + t * 128, 256);
      x[bin * time + t] = (float)sqrt((double)(re * re + im * im));
    }
  }
  for (int layer = 0; layer < 4; layer++) {
    int in = CHANNELS[layer], out = CHANNELS[layer + 1], stride = STRIDES[layer];
    int out_time = (time + stride - 1) / stride;
    const float *w = conv_w[layer], *bias = conv_b[layer];
    for (int o = 0; o < out; o++) {
      for (int t = 0; t < out_time; t++) {
        float sum = bias[o];
        int centre = t * stride;
        for (int k = 0; k < 3; k++) {
          int at = centre + k - 1;
          if (at < 0 || at >= time) continue;
          int wi = o * in * 3 + k;
          for (int i = 0; i < in; i++) sum += w[wi + i * 3] * x[i * time + at];
        }
        y[o * out_time + t] = sum > 0.0f ? sum : 0.0f;
      }
    }
    float *swap = x;
    x = y;
    y = swap;
    time = out_time;
  }
  for (int g = 0; g < 4 * HIDDEN; g++)
    gates[g] = b_ih[g] + b_hh[g] + dot(w_ih + g * HIDDEN, x, HIDDEN) + dot(w_hh + g * HIDDEN, h, HIDDEN);
  float out = out_b[0];
  for (int n = 0; n < HIDDEN; n++) {
    float cell = sigmoid(gates[HIDDEN + n]) * c[n] + sigmoid(gates[n]) * (float)tanh((double)gates[2 * HIDDEN + n]);
    c[n] = cell;
    h[n] = sigmoid(gates[3 * HIDDEN + n]) * (float)tanh((double)cell);
    out += out_w[n] * (h[n] > 0.0f ? h[n] : 0.0f);
  }
  return sigmoid(out);
}

// silero_hear takes 960 samples at 48 kHz: low-pass, every third sample, and a probability
// each time 512 new 16 kHz samples are in. Returns the newest probability.
static float silero_hear(const short *in, int n) {
  for (int s = 0; s < n; s++) {
    history[position] = in[s] / 32768.0f;
    position = (position + 1) % TAPS;
    if (phase == 0) {
      float sum = 0.0f;
      int at = position;
      for (int k = TAPS - 1; k >= 0; k--) {
        sum += lowpass[k] * history[at];
        at = at + 1 == TAPS ? 0 : at + 1;
      }
      window_[filled++] = sum;
      if (filled == WINDOW) {
        probability = silero_window();
        filled = 0;
      }
    }
    phase = phase == 2 ? 0 : phase + 1;
  }
  return probability;
}
