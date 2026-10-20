// The hub's microphone chain (web/src/svcmic.ts, native/svc-mic/) against Simple Voice Chat's
// own natives and MT Utils' keyboard gate, on made-up input (signal.mjs; references in ref/,
// written by make-refs.sh). Run by `make check`, or: node --test test/unit/
//
// What must hold, and why (docs/voice/svc-mic.md):
//   - Speex, Manual gain and Silero: the same samples and probabilities, exactly.
//   - RNNoise: within 0.03, never on the other side of 0.5 unless the reference is within 0.03
//     of it. On x86 RNNoise uses the processor's approximate reciprocal, which Intel and AMD
//     implement differently; the hub divides exactly, so it can't equal every player's game.
//   - The whole chain at the defaults: the same frames sent, and the same frames out of the
//     keyboard gate, on every frame of both references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { signal } from './signal.mjs';
import { DEFAULT_SETTINGS, FRAME, ManualGain, SvcMic, natives, peakDb } from '../../../web/src/svcmic.ts';

const here = new URL('.', import.meta.url).pathname;
const module = new WebAssembly.Module(readFileSync(new URL('../../../web/src/svc-mic.wasm', import.meta.url)));
const SEEDS = [2, 3];
const SECONDS = 60;

const sha = (a) => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
const ref = (f) => readFileSync(`${here}ref/${f}`);
const f32 = (f) => { const b = ref(f); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const inputs = new Map(SEEDS.map((s) => [s, signal(s, SECONDS)]));
const frameOf = (a, i) => a.subarray(i * FRAME, (i + 1) * FRAME);
const frames = (s) => inputs.get(s).length / FRAME;
const put = (x, f) => new Int16Array(x.memory.buffer, x.frame(), FRAME).set(f);
const view = (x) => new Int16Array(x.memory.buffer, x.frame(), FRAME);

for (const seed of SEEDS) {
  test(`seed ${seed}: the input is the one the references were made from`, () => {
    assert.equal(sha(inputs.get(seed)), ref(`in${seed}.sha256`).toString().trim());
  });

  test(`seed ${seed}: Speex gives the same samples (Noise Suppression off, Gain Auto)`, () => {
    const x = natives(module);
    const want = f32(`raw${seed}.prob.f32`);
    const out = new Int16Array(inputs.get(seed).length);
    for (let i = 0; i < frames(seed); i++) {
      put(x, frameOf(inputs.get(seed), i));
      x.denoise(0);
      x.gain(want[i] >= 0.95 ? 12 : 0); // the reference's increments, so only Speex is tested
      out.set(view(x), i * FRAME);
    }
    assert.equal(sha(out), ref(`raw${seed}.out.sha256`).toString().trim());
  });

  test(`seed ${seed}: Manual gain gives the same samples (+12 dB, Noise Suppression off)`, () => {
    const g = new ManualGain();
    const out = inputs.get(seed).slice();
    for (let i = 0; i < frames(seed); i++) g.apply(frameOf(out, i), 12);
    assert.equal(sha(out), ref(`raw-manual${seed}.out.sha256`).toString().trim());
  });

  test(`seed ${seed}: RNNoise's probabilities are within 0.03 and agree about 0.5`, () => {
    const x = natives(module);
    const want = f32(`auto${seed}.prob.f32`);
    let worst = 0;
    for (let i = 0; i < frames(seed); i++) {
      put(x, frameOf(inputs.get(seed), i));
      const p = x.denoise(1);
      x.gain(p >= 0.95 ? 12 : 0);
      worst = Math.max(worst, Math.abs(p - want[i]));
      if (Math.abs(want[i] - 0.5) >= 0.03) assert.equal(p >= 0.5, want[i] >= 0.5, `frame ${i}: ${p} against ${want[i]}`);
    }
    assert.ok(worst <= 0.03, `worst difference ${worst}`);
  });

  test(`seed ${seed}: Silero gives the same probabilities`, () => {
    const x = natives(module);
    const want = f32(`silero${seed}.f32`);
    for (let i = 0; i < frames(seed); i++) {
      put(x, frameOf(inputs.get(seed), i));
      assert.equal(Math.fround(x.listen()), want[i], `frame ${i}`);
    }
  });

  test(`seed ${seed}: at the defaults, the same frames are sent as in the game`, () => {
    const mic = new SvcMic(natives(module), { ...DEFAULT_SETTINGS });
    const want = ref(`chain${seed}.txt`).toString().trim().split('\n').map((l) => l.split(' '));
    const recent = []; // [input frame, samples] of the last few frames activation let through
    let out = 0;
    for (let i = 0; i < frames(seed); i++) {
      const o = mic.process(frameOf(inputs.get(seed), i));
      const [sent, which] = want[i];
      assert.equal(mic.sentByActivation, sent === '1', `frame ${i}: activation`);
      if (mic.sentByActivation) recent.push([i, mic.lastSent]);
      if (recent.length > 8) recent.shift();
      if (which === '-') {
        assert.equal(o, null, `frame ${i}: the gate let a frame out`);
        continue;
      }
      assert.ok(o, `frame ${i}: the gate let nothing out`);
      const from = recent.find(([, f]) => f === o || (f.length === o.length && f.every((v, k) => v === o[k])));
      assert.equal(from?.[0], Number(which), `frame ${i}: another frame went out`);
      out++;
    }
    // Silero hears seed 2's made-up voice as speech (2200 frames out), seed 3's hardly at all (61).
    assert.ok(out > 50, `only ${out} frames out`);
  });
}

// The settings, on a few frames of made-up talking.
const talk = signal(5, 4);
function run(settings, opts = {}) {
  const mic = new SvcMic(natives(module), { ...DEFAULT_SETTINGS, ...settings });
  Object.assign(mic, opts);
  const sent = [];
  for (let i = 0; i < talk.length / FRAME; i++) {
    if (opts.keyAt) mic.pttDown = opts.keyAt(i);
    sent.push(mic.process(frameOf(talk, i)) !== null);
  }
  return sent;
}
const count = (a) => a.filter(Boolean).length;

test('Push to Talk sends only with the key, and 5 frames after it', () => {
  assert.equal(count(run({ ptt: true })), 0);
  const sent = run({ ptt: true }, { keyAt: (i) => i >= 10 && i < 30 });
  assert.equal(sent.slice(0, 10).some(Boolean), false);
  assert.ok(sent.slice(10, 30).every(Boolean), 'not every frame with the key went out');
  assert.ok(sent.slice(30, 35).every(Boolean) && !sent[35], 'the tail is not 5 frames');
});

test('Push to Talk skips the keyboard gate; the mic test sends without the key', () => {
  assert.equal(count(run({ ptt: true }, { testing: true })), talk.length / FRAME);
});

test('a muted microphone sends nothing', () => {
  assert.equal(count(run({}, { muted: true })), 0);
  assert.equal(count(run({ ptt: true }, { muted: true, keyAt: () => true })), 0);
});

test('Voice Activation: Manual opens on the peak level, and -127 dB lets all through', () => {
  // (Noise Suppression off: RNNoise makes silence exact zeros, which -127 dB doesn't pass.)
  const sent = run({ vad: false, thresholdDb: -127, keyboardGate: false, denoise: false });
  assert.equal(count(sent), talk.length / FRAME);
  assert.equal(count(run({ vad: false, thresholdDb: 0, keyboardGate: false })), 0);
});

test('peakDb is the loudest sample in dBFS', () => {
  assert.equal(peakDb(new Int16Array(FRAME)), -127);
  assert.equal(Math.round(peakDb(Int16Array.of(16384)) * 100) / 100, -6.02);
  assert.equal(peakDb(Int16Array.of(-32768)), 20 * Math.log10(32767 / 32768));
});
