// Test input for the microphone chain: a made-up voice, room noise and clicks, from a seed, so
// the same samples come out in Node and in SvcRef.java's input file. No recording of anyone.
//   node signal.mjs <seed> <seconds> out.s16      writes 48 kHz mono 16-bit little-endian
import { writeFileSync } from 'node:fs';

export const RATE = 48000;

// mulberry32: small, seedable, the same on every machine.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Vowels as three formants (Hz): roughly a, e, i, o, u.
const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240]];

// A two-pole resonator at f Hz with bandwidth bw.
function resonator(f, bw) {
  const r = Math.exp((-Math.PI * bw) / RATE);
  const a1 = 2 * r * Math.cos((2 * Math.PI * f) / RATE);
  const a2 = -r * r;
  let y1 = 0, y2 = 0;
  return (x) => {
    const y = (1 - r) * x + a1 * y1 + a2 * y2;
    y2 = y1;
    y1 = y;
    return y;
  };
}

// signal returns Int16Array samples: stretches of "talking" (voiced syllables with a moving
// pitch, a vowel each, at a level that changes from stretch to stretch, some quiet), pauses,
// steady room noise underneath, and bursts of clicks (a stand-in for typing) in some pauses.
export function signal(seed, seconds) {
  const rand = rng(seed);
  const n = Math.round(seconds * RATE);
  const out = new Float64Array(n);
  let i = 0;
  let talking = rand() < 0.5;
  while (i < n) {
    const len = Math.round((talking ? 1 + rand() * 2.5 : 0.4 + rand() * 1.5) * RATE);
    const end = Math.min(n, i + len);
    if (talking) {
      const level = 10 ** ((-38 + rand() * 30) / 20); // -38 to -8 dBFS peaks, quiet talkers too
      let pitch = 90 + rand() * 150;
      let phase = 0;
      let syl = i;
      while (syl < end) {
        const sylLen = Math.round((0.12 + rand() * 0.25) * RATE);
        const sEnd = Math.min(end, syl + sylLen);
        const v = VOWELS[Math.floor(rand() * VOWELS.length)];
        const fs = v.map((f, k) => resonator(f * (0.9 + rand() * 0.2), 60 + k * 40));
        const glide = (rand() - 0.5) * 40;
        for (let j = syl; j < sEnd; j++) {
          const t = (j - syl) / (sEnd - syl);
          const env = Math.sin(Math.PI * t) ** 0.6;
          const f0 = pitch + glide * t;
          phase += f0 / RATE;
          const pulse = phase >= 1 ? ((phase -= 1), 1) : 0; // glottal pulse train
          const src = pulse + (rand() - 0.5) * 0.02; // a little breath
          const y = fs[0](src) * 1.0 + fs[1](src) * 0.6 + fs[2](src) * 0.3;
          out[j] += y * env * level * 18;
        }
        pitch = Math.max(80, Math.min(260, pitch + (rand() - 0.5) * 30));
        syl = sEnd + Math.round(rand() * 0.06 * RATE); // short gaps between syllables
      }
    } else if (rand() < 0.6) {
      // clicks: short decaying noise bursts at typing pace
      const level = 10 ** ((-30 + rand() * 20) / 20);
      for (let j = i; j < end; j += Math.round((0.06 + rand() * 0.14) * RATE)) {
        for (let k = 0; k < 400 && j + k < end; k++) out[j + k] += (rand() - 0.5) * 2 * level * Math.exp(-k / 60);
      }
    }
    i = end;
    talking = !talking;
  }
  const noise = 10 ** (-62 / 20); // room noise floor
  let lp = 0;
  const s = new Int16Array(n);
  for (let j = 0; j < n; j++) {
    lp = 0.97 * lp + 0.03 * (rand() - 0.5);
    const v = (out[j] + lp * noise * 20 + (rand() - 0.5) * noise) * 32768;
    s[j] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return s;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [seed, seconds, file] = process.argv.slice(2);
  const s = signal(Number(seed), Number(seconds));
  writeFileSync(file, Buffer.from(s.buffer));
}
