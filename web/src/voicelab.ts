// Voice lab (/voice-lab/): records the microphone through every candidate noise filter at
// once, then plays the takes back side by side with an optional voice gate, to choose the
// filter for voice rooms by ear (docs/voice/ has the research).
//
// Recording runs every filter live on one audio graph, so the take is also the real-world
// test: with the game in front and this tab in the background, the recorder notes whenever
// the audio thread fell behind. The gates are applied afterwards, simulated the way they
// would run live, so moving the sensitivity slider re-plays the same take instantly.
//
// Nothing is uploaded: the takes live in this tab only.
import { GtcrnWorkletNode, RnnoiseWorkletNode, loadGtcrn, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import { DeepFilterNet3Core } from 'deepfilternet3-noise-filter';
import * as ort from 'onnxruntime-web/wasm';

const BASE = '/voice/'; // the filter files (build.mjs)
const RATE = 48000;
const VAD_RATE = 16000;
const VAD_FRAME = 512; // Silero v5/v6: 32 ms frames at 16 kHz...
const VAD_CONTEXT = 64; // ...each with the previous frame's last 64 samples in front
const GATE_STEP = 480; // the gates decide every 10 ms
const WARMUP_MS = 1500; // filters settle (DeepFilterNet3 passes audio through while it starts)

type Id = 'raw' | 'browser' | 'rnnoise' | 'gtcrn' | 'dfn3';
const TRACKS: { id: Id; name: string; note: string }[] = [
  { id: 'raw', name: 'Raw', note: 'echo cancelling only' },
  { id: 'browser', name: 'Browser', note: "the browser's own noise suppression" },
  { id: 'rnnoise', name: 'RNNoise', note: 'what Jitsi and most others ship' },
  { id: 'gtcrn', name: 'GTCRN', note: 'tiny and new; 16 kHz inside' },
  { id: 'dfn3', name: 'DeepFilterNet3', note: 'best measured; heaviest' },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Errors this page met, for the report each take sends (see report()).
const errors: string[] = [];
addEventListener('error', (e) => errors.push(`error: ${e.message}`));
addEventListener('unhandledrejection', (e) => errors.push(`rejection: ${(e.reason as Error)?.message ?? e.reason}`));
const status = (msg: string, kind: '' | 'error' | 'ok' = '') => {
  if (kind === 'error') {
    errors.push(`status: ${msg}`);
    if (!take || !msg.startsWith('Recorded')) void report('error');
  }
  const s = $('status');
  s.textContent = msg;
  s.className = 'status' + (kind ? ' ' + kind : '');
};
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---- Loading ---------------------------------------------------------------------------

let rnnoiseWasm: ArrayBuffer;
let gtcrnWasm: ArrayBuffer;
let dfn: DeepFilterNet3Core;
let vad: ort.InferenceSession;

async function loadAll() {
  ort.env.wasm.wasmPaths = BASE;
  ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which the hub doesn't set
  // Level 100 = DeepFilterNet's attenuation limit of 100 dB, i.e. no limit: full strength,
  // like the others.
  dfn = new DeepFilterNet3Core({ sampleRate: RATE, noiseReductionLevel: 100, assetConfig: { cdnUrl: BASE + 'dfn3' } });
  [rnnoiseWasm, gtcrnWasm, , vad] = await Promise.all([
    loadRnnoise({ url: BASE + 'rnnoise.wasm', simdUrl: BASE + 'rnnoise_simd.wasm' }),
    loadGtcrn({ url: BASE + 'gtcrn.wasm' }),
    dfn.initialize(),
    ort.InferenceSession.create(BASE + 'silero_vad_v6.onnx'),
  ]);
}

// ---- Recording -------------------------------------------------------------------------

// One worklet takes every track (one input each), keeps the samples while recording and
// sends them over in batches of about 100 ms (a whole number of 128-sample blocks). It also watches the audio clock against the wall clock:
// when the audio thread falls behind (the tab starved, or the filters too slow), wall time
// runs ahead of audio time for good, and the gap is the time lost. And it counts the blocks
// where an input had no data at all (the microphone's samples didn't arrive in time), per
// input, for the first 5 seconds and after.
const RECORDER = `
class LabRecorder extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.n = o.numberOfInputs;
    this.on = false;
    this.size = 128 * 38;
    this.level = 0;
    this.levelAt = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.on = true;
        this.bufs = Array.from({ length: this.n }, () => new Float32Array(this.size));
        this.fill = 0;
        this.t0 = Date.now(); this.f0 = currentFrame;
        this.winEnd = this.t0 + 1000; this.winMin = Infinity; this.first = undefined; this.prev = undefined;
        this.jumps = 0; this.worst = 0;
        this.blocks = 0; this.missing = Array.from({ length: this.n }, () => [0, 0]);
      } else if (e.data === 'stop') {
        this.flush();
        this.closeWindow();
        this.on = false;
        this.port.postMessage({ done: true, lost: this.prev === undefined ? 0 : Math.max(0, this.prev - this.first), jumps: this.jumps, worst: this.worst, missing: this.missing });
      }
    };
  }
  flush() {
    if (!this.fill) return;
    const out = this.bufs.map((b) => b.slice(0, this.fill));
    this.port.postMessage({ chunk: out }, out.map((b) => b.buffer));
    this.fill = 0;
  }
  closeWindow() {
    if (this.winMin === Infinity) return;
    if (this.first === undefined) this.first = this.winMin;
    else if (this.winMin - this.prev > 15) { this.jumps++; this.worst = Math.max(this.worst, this.winMin - this.prev); }
    this.prev = this.winMin;
    this.winMin = Infinity;
  }
  process(inputs) {
    const raw = inputs[0] && inputs[0][0];
    if (raw) for (let i = 0; i < raw.length; i++) this.level = Math.max(this.level, Math.abs(raw[i]));
    if (currentTime - this.levelAt > 0.05) { this.port.postMessage({ level: this.level }); this.level = 0; this.levelAt = currentTime; }
    if (!this.on) return true;
    for (let k = 0; k < this.n; k++) {
      const ch = inputs[k] && inputs[k][0];
      if (ch) this.bufs[k].set(ch, this.fill);
      else { this.bufs[k].fill(0, this.fill, this.fill + 128); this.missing[k][this.blocks * 128 < 5 * sampleRate ? 0 : 1]++; }
    }
    this.blocks++;
    this.fill += 128;
    if (this.fill >= this.size) this.flush();
    const now = Date.now();
    const lag = (now - this.t0) - ((currentFrame - this.f0) / sampleRate) * 1000;
    this.winMin = Math.min(this.winMin, lag);
    if (now >= this.winEnd) { this.closeWindow(); this.winEnd = now + 1000; }
    return true;
  }
}
registerProcessor('lab-recorder', LabRecorder);
`;

type Take = {
  audio: Partial<Record<Id, Float32Array>>; // aligned to the raw track
  delay: Partial<Record<Id, number>>; // ms each filter added
  speech: Partial<Record<Id, Float32Array>>; // Silero's speech probability per 32 ms frame
  gain: Partial<Record<Id, number>>; // to the same speech loudness for playback
  seconds: number;
  gaps: string[]; // per track: how much arrived as no data, or as exact zeros (no real mic gives those)
  lost: number;
  jumps: number;
  worst: number;
  browserNote: string;
  settings: { main: string; second: string };
  cpu: Partial<Record<Id, string>>;
};
let take: Take | null = null;
let capture: unknown = null; // what the browser said about the microphone, for the report

let session: {
  ctx: AudioContext;
  streams: MediaStream[];
  rec: AudioWorkletNode;
  nodes: Partial<Record<Id, AudioNode>>;
  monitor: GainNode;
  chunks: Float32Array[][];
  started: number;
  timer: number;
  browserNote: string;
  settings: { main: string; second: string };
} | null = null;

async function fileStream(url: string) {
  const ctx = new AudioContext({ sampleRate: RATE });
  const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const dst = ctx.createMediaStreamDestination();
  dst.channelCount = 1;
  src.connect(dst);
  src.start();
  return dst.stream;
}

async function startRecording() {
  stopPlayback();
  const echo = $<HTMLInputElement>('opt-echo').checked;
  const second = $<HTMLInputElement>('opt-second').checked;
  // ?mic=<part of a device name> records that microphone instead of the default (the tests
  // use a virtual one). Names are only known once the page may use a microphone.
  const want = new URLSearchParams(location.search).get('mic');
  let pick = {};
  if (want) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    const d = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label.includes(want));
    for (const t of s?.getTracks() ?? []) t.stop();
    if (!d) { status(`No microphone named like "${want}".`, 'error'); return; }
    pick = { deviceId: { exact: d.deviceId } };
  }
  const base = { channelCount: 1, echoCancellation: echo, autoGainControl: false, sampleRate: RATE, ...pick };
  let a: MediaStream;
  try {
    // ?wav=<url> plays that file in place of the microphone, looped (for tests in browsers
    // whose fake microphone is only a tone).
    const wav = new URLSearchParams(location.search).get('wav');
    a = wav ? await fileStream(wav) : await navigator.mediaDevices.getUserMedia({ audio: { ...base, noiseSuppression: false } });
  } catch (e) {
    status(`Couldn't open the microphone: ${(e as Error).message}`, 'error');
    return;
  }
  const deviceId = a.getAudioTracks()[0].getSettings().deviceId;
  // The browser's own noise suppression can only be had from the browser, live, so it gets a
  // second capture of the same microphone with it switched on. Not every browser can give
  // two captures different processing; the note says what happened.
  let b: MediaStream | null = null;
  let browserNote = '';
  if (!second) browserNote = 'switched off for this take';
  else try {
    b = await navigator.mediaDevices.getUserMedia({ audio: { ...base, noiseSuppression: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
    const sa = a.getAudioTracks()[0].getSettings();
    const sb = b.getAudioTracks()[0].getSettings();
    if (sa.noiseSuppression === false && sb.noiseSuppression === true) browserNote = 'separate capture, suppression on';
    else if (sa.noiseSuppression === true) {
      // The second capture switched suppression on for the whole microphone, which would put
      // the browser's filter in front of every other track: drop it and check that's undone.
      for (const t of b.getTracks()) t.stop();
      b = null;
      await new Promise((r) => setTimeout(r, 300));
      browserNote = a.getAudioTracks()[0].getSettings().noiseSuppression === true
        ? "WARNING: this browser turned its own suppression on for every track, so this take doesn't compare the filters fairly"
        : "this browser can't record it alongside the others";
    } else browserNote = `the browser reports suppression ${sb.noiseSuppression} on this track and ${sa.noiseSuppression} on the others, so treat it with suspicion`;
  } catch (e) {
    browserNote = `not available: ${(e as Error).message}`;
    b = null;
  }

  const applied = (st: MediaStream | null) => {
    if (!st) return '';
    const g = st.getAudioTracks()[0].getSettings();
    return `echo cancelling ${g.echoCancellation}, noise suppression ${g.noiseSuppression}, auto gain ${g.autoGainControl}, ${g.sampleRate ?? '?'} Hz, ${g.channelCount ?? '?'} channel(s)`;
  };
  const settings = { main: applied(a), second: applied(b) };
  const full = (st: MediaStream | null) => st && { label: st.getAudioTracks()[0].label, ...st.getAudioTracks()[0].getSettings(), deviceId: undefined, groupId: undefined };
  capture = { echo, second, main: full(a), second_capture: full(b) };
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  const streams = b ? [a, b] : [a];
  const fail = (msg: string) => {
    for (const s of streams) for (const t of s.getTracks()) t.stop();
    void ctx.close();
    status(msg, 'error');
  };
  let srcA: MediaStreamAudioSourceNode;
  let srcB: MediaStreamAudioSourceNode | null = null;
  try {
    srcA = ctx.createMediaStreamSource(a);
    if (b) srcB = ctx.createMediaStreamSource(b);
  } catch (e) {
    // Firefox can't connect a microphone running at another rate to a 48 kHz page.
    const rate = a.getAudioTracks()[0].getSettings().sampleRate;
    fail(`The microphone (${rate ?? 'unknown'} Hz) couldn't join a 48 kHz recording: ${(e as Error).message}. Set the mic to 48 kHz in the system's sound settings and try again.`);
    return;
  }
  try {
    await ctx.audioWorklet.addModule(BASE + 'rnnoise-worklet.js');
    await ctx.audioWorklet.addModule(BASE + 'gtcrn-worklet.js');
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([RECORDER], { type: 'text/javascript' })));
  } catch (e) {
    fail(`Couldn't start the filters: ${(e as Error).message}`);
    return;
  }
  const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: rnnoiseWasm });
  const gtcrn = new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: gtcrnWasm });
  const dfn3 = await dfn.createAudioWorkletNode(ctx);
  for (const n of [rnnoise, gtcrn, dfn3]) srcA.connect(n);
  for (const [name, n] of [['RNNoise', rnnoise], ['GTCRN', gtcrn], ['DeepFilterNet3', dfn3]] as const) {
    n.onprocessorerror = () => errors.push(`${name} worklet stopped with an error`);
  }
  const nodes: Partial<Record<Id, AudioNode>> = { raw: srcA, rnnoise, gtcrn, dfn3, ...(srcB ? { browser: srcB } : {}) };

  const rec = new AudioWorkletNode(ctx, 'lab-recorder', {
    numberOfInputs: TRACKS.length, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
  });
  TRACKS.forEach((t, i) => nodes[t.id]?.connect(rec, 0, i));
  rec.connect(ctx.destination); // silent; keeps the graph pulled
  rec.onprocessorerror = () => status('The recorder stopped with an error; reload the page and try again.', 'error');
  const monitor = ctx.createGain();
  monitor.connect(ctx.destination);

  const chunks: Float32Array[][] = [];
  rec.port.onmessage = (e) => {
    if (e.data.level !== undefined) {
      ($('meter').firstElementChild as HTMLElement).style.width = `${Math.min(100, Math.sqrt(e.data.level) * 100)}%`;
    } else if (e.data.chunk) chunks.push(e.data.chunk);
    else if (e.data.done) void finish(e.data);
  };
  session = { ctx, streams, rec, nodes, monitor, chunks, started: 0, timer: 0, browserNote, settings };
  setMonitor();

  const btn = $<HTMLButtonElement>('record');
  btn.disabled = true;
  btn.textContent = 'Stop recording';
  status('Getting ready…');
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  if (!session) return;
  rec.port.postMessage('start');
  session.started = Date.now();
  session.timer = window.setInterval(() => {
    if (session) $('rec-time').textContent = mmss((Date.now() - session.started) / 1000);
  }, 250);
  btn.disabled = false;
  btn.classList.remove('primary');
  btn.classList.add('danger');
  status('Recording. Talk, type, play; come back and stop when you have 30 seconds or more.', 'ok');
}

function setMonitor() {
  if (!session) return;
  const want = $<HTMLSelectElement>('monitor').value as Id | '';
  for (const n of Object.values(session.nodes)) {
    try { n!.disconnect(session.monitor); } catch { /* wasn't connected */ }
  }
  const n = want && session.nodes[want];
  if (n) n.connect(session.monitor);
}

function stopRecording() {
  if (!session) return;
  $<HTMLButtonElement>('record').disabled = true;
  status('Stopping…');
  session.rec.port.postMessage('stop');
}

async function finish(r: { lost: number; jumps: number; worst: number; missing: [number, number][] }) {
  const s = session!;
  session = null;
  clearInterval(s.timer);
  for (const st of s.streams) for (const t of st.getTracks()) t.stop();
  await s.ctx.close();
  ($('meter').firstElementChild as HTMLElement).style.width = '0';
  const btn = $<HTMLButtonElement>('record');
  btn.textContent = 'Record again';
  btn.classList.remove('danger');
  btn.classList.add('primary');

  const len = s.chunks.reduce((n, c) => n + c[0].length, 0);
  if (len < RATE * 2) {
    btn.disabled = false;
    status('That was too short to compare; record at least a few seconds.', 'error');
    return;
  }
  const audio: Partial<Record<Id, Float32Array>> = {};
  TRACKS.forEach((t, i) => {
    if (t.id === 'browser' && !s.nodes.browser) return;
    const a = new Float32Array(len);
    let at = 0;
    for (const c of s.chunks) { a.set(c[i], at); at += c[i].length; }
    audio[t.id] = a;
  });
  // Exact-zero 128-sample blocks: a microphone always has some noise, so these are audio that
  // never arrived (or a filter shutting off completely).
  const ms = (blocks: number) => Math.round((blocks * 128 * 1000) / RATE);
  const gaps = TRACKS.map((t, i) => {
    const a = audio[t.id];
    if (!a) return '';
    const z = [0, 0];
    for (let b = 0; b + 128 <= a.length; b += 128) {
      let zero = true;
      for (let j = b; j < b + 128; j++) if (a[j] !== 0) { zero = false; break; }
      if (zero) z[b < 5 * RATE ? 0 : 1]++;
    }
    return `no data ${ms(r.missing[i][0])} ms in the first 5 s, ${ms(r.missing[i][1])} ms after; silent blocks ${ms(z[0])} ms in the first 5 s, ${ms(z[1])} ms after`;
  });
  status('Analysing…');
  try {
    take = await analyse(audio, { gaps, seconds: len / RATE, lost: r.lost, jumps: r.jumps, worst: r.worst, browserNote: s.browserNote, settings: s.settings });
  } catch (e) {
    status(`Analysis failed: ${(e as Error).message}`, 'error');
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  if (take.browserNote.startsWith('WARNING')) status(`Recorded ${mmss(take.seconds)}. ${take.browserNote}.`, 'error');
  else status(`Recorded ${mmss(take.seconds)}.`, 'ok');
  showResults();
}

// ---- Analysis --------------------------------------------------------------------------

async function resample(a: Float32Array, to: number) {
  const off = new OfflineAudioContext(1, Math.ceil((a.length * to) / RATE), to);
  const buf = off.createBuffer(1, a.length, RATE);
  buf.copyToChannel(a as Float32Array<ArrayBuffer>, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

// The delay a filter adds, from where its output lines up best with the raw track: over the
// loudest two seconds, at 16 kHz, looking up to 300 ms later.
function delayOf(raw: Float32Array, x: Float32Array) {
  const win = 2 * VAD_RATE;
  const maxLag = 0.3 * VAD_RATE;
  if (raw.length < win + maxLag) return 0;
  let best = 0;
  let bestAt = 0;
  for (let i = 0, e = 0; i + win < raw.length - maxLag; i += VAD_RATE / 10) {
    e = 0;
    for (let j = i; j < i + win; j += 4) e += raw[j] * raw[j];
    if (e > best) { best = e; bestAt = i; }
  }
  let top = -Infinity;
  let lag = 0;
  for (let l = 0; l <= maxLag; l++) {
    let c = 0;
    let n = 0;
    for (let j = bestAt; j < bestAt + win; j++) { c += raw[j] * x[j + l]; n += x[j + l] * x[j + l]; }
    const score = n > 0 ? c / Math.sqrt(n) : 0;
    if (score > top) { top = score; lag = l; }
  }
  return lag / VAD_RATE;
}

const shift = (a: Float32Array, n: number) => {
  const out = new Float32Array(a.length);
  out.set(a.subarray(n));
  return out;
};

async function speechOf(a16: Float32Array) {
  const frames = Math.floor(a16.length / VAD_FRAME);
  const p = new Float32Array(frames);
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_RATE)]));
  const input = new Float32Array(VAD_CONTEXT + VAD_FRAME);
  for (let f = 0; f < frames; f++) {
    input.copyWithin(0, VAD_FRAME, VAD_FRAME + VAD_CONTEXT); // last frame's tail to the front
    input.set(a16.subarray(f * VAD_FRAME, (f + 1) * VAD_FRAME), VAD_CONTEXT);
    const out = await vad.run({ input: new ort.Tensor('float32', input.slice(), [1, input.length]), state, sr });
    state = out.stateN as typeof state;
    p[f] = (out.output.data as Float32Array)[0];
  }
  return p;
}

async function analyse(raw: Partial<Record<Id, Float32Array>>, info: Pick<Take, 'gaps' | 'seconds' | 'lost' | 'jumps' | 'worst' | 'browserNote' | 'settings'>): Promise<Take> {
  const ids = TRACKS.map((t) => t.id).filter((id) => raw[id]);
  const at16: Partial<Record<Id, Float32Array>> = {};
  for (const id of ids) at16[id] = await resample(raw[id]!, VAD_RATE);
  const audio: Take['audio'] = {};
  const delay: Take['delay'] = {};
  const speech: Take['speech'] = {};
  for (const id of ids) {
    const d = id === 'raw' ? 0 : delayOf(at16.raw!, at16[id]!);
    delay[id] = d * 1000;
    audio[id] = shift(raw[id]!, Math.round(d * RATE));
    at16[id] = shift(at16[id]!, Math.round(d * VAD_RATE));
  }
  for (const id of ids) {
    status(`Analysing: speech detector on ${TRACKS.find((t) => t.id === id)!.name}…`);
    speech[id] = await speechOf(at16[id]!);
  }
  // Same loudness of speech everywhere: the RMS over the stretches the detector heard speech
  // in on the raw track, brought to -23 dBFS.
  const gain: Take['gain'] = {};
  const sp = speech.raw!;
  const per = (VAD_FRAME * RATE) / VAD_RATE;
  for (const id of ids) {
    let sum = 0;
    let n = 0;
    const a = audio[id]!;
    for (let f = 0; f < sp.length; f++) {
      if (sp[f] < 0.5) continue;
      for (let i = f * per; i < (f + 1) * per && i < a.length; i++) { sum += a[i] * a[i]; n++; }
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    gain[id] = rms > 1e-5 ? Math.min(30, 10 ** (-23 / 20) / rms) : 1;
  }
  return { audio, delay, speech, gain, ...info, cpu: {} };
}

// ---- Gates -----------------------------------------------------------------------------

// What a live gate would let through, one value per 10 ms step (0 shut, 1 open), simulated
// with the timing it would really have.
//   - volume gate: opens the moment the level passes the threshold (as Discord's slider
//     does), closes after 300 ms below a threshold 6 dB lower.
//   - speech gate: Silero must call two frames in a row speech (64 ms). Live, the audio is
//     held back 200 ms, so the gate opens 200 ms before the moment it decided, which saves
//     the start of the first word; it closes 500 ms after the speech ends, minus the same
//     200 ms. Open above the threshold, stay open above it minus 0.15 (two thresholds, as
//     Mumble does).
const PRE_ROLL = 0.2;
const SPEECH_HOLD = 0.5;
const LEVEL_HOLD = 0.3;

function gateMask(id: Id, mode: string, sens: number): Uint8Array | null {
  if (!take || mode === 'off') return null;
  const a = take.audio[id]!;
  const steps = Math.ceil(a.length / GATE_STEP);
  const mask = new Uint8Array(steps);
  const stepSec = GATE_STEP / RATE;
  if (mode === 'level') {
    const open = -70 + (100 - sens) * 0.5; // sensitivity 0..100 -> -20..-70 dBFS
    const close = open - 6;
    let on = false;
    let quiet = 0;
    for (let s = 0; s < steps; s++) {
      let sum = 0;
      const end = Math.min(a.length, (s + 1) * GATE_STEP);
      for (let i = s * GATE_STEP; i < end; i++) sum += a[i] * a[i];
      const db = 10 * Math.log10(sum / GATE_STEP + 1e-12);
      if (!on && db > open) { on = true; quiet = 0; } else if (on) {
        quiet = db < close ? quiet + stepSec : 0;
        if (quiet >= LEVEL_HOLD) on = false;
      }
      mask[s] = on ? 1 : 0;
    }
    return mask;
  }
  const p = take.speech[id]!;
  const frameSec = VAD_FRAME / VAD_RATE;
  const open = 0.9 - sens * 0.008; // sensitivity 0..100 -> 0.9..0.1
  const close = Math.max(0.05, open - 0.15);
  let on = false;
  let run = 0;
  let quiet = 0;
  const decided: [number, boolean][] = []; // (time decided, open?)
  for (let f = 0; f < p.length; f++) {
    const t = (f + 1) * frameSec; // known at the end of the frame
    if (!on) {
      run = p[f] >= open ? run + 1 : 0;
      if (run >= 2) { on = true; quiet = 0; decided.push([t, true]); }
    } else {
      quiet = p[f] < close ? quiet + frameSec : 0;
      if (quiet >= SPEECH_HOLD) { on = false; run = 0; decided.push([t, false]); }
    }
  }
  let k = 0;
  let state = false;
  for (let s = 0; s < steps; s++) {
    const audioT = s * stepSec + PRE_ROLL; // this audio goes out PRE_ROLL later, when the gate is at audioT
    while (k < decided.length && decided[k][0] <= audioT) state = decided[k++][1];
    mask[s] = state ? 1 : 0;
  }
  return mask;
}

// The track as it would be heard: loudness matched, gate applied with 10 ms fades.
function rendered(id: Id, mask: Uint8Array | null) {
  const a = take!.audio[id]!;
  const g = take!.gain[id]!;
  const out = new Float32Array(a.length);
  let level = mask ? mask[0] : 1;
  const stepSize = 1 / GATE_STEP;
  for (let i = 0; i < a.length; i++) {
    const want = mask ? mask[Math.floor(i / GATE_STEP)] : 1;
    if (level < want) level = Math.min(want, level + stepSize);
    else if (level > want) level = Math.max(want, level - stepSize);
    out[i] = Math.max(-1, Math.min(1, a[i] * g * level));
  }
  return out;
}

// ---- Playback --------------------------------------------------------------------------

let playCtx: AudioContext | null = null;
let current: Id = 'raw';
let player: { src: AudioBufferSourceNode; startedAt: number; from: number } | null = null;
let pos = 0; // seconds, while paused
let masks: Partial<Record<Id, Uint8Array | null>> = {};

const gateMode = () => $<HTMLSelectElement>('gate').value;
const sens = () => Number($<HTMLInputElement>('sens').value);
const now = () => (player ? player.from + (playCtx!.currentTime - player.startedAt) : pos);

function play(from = now()) {
  if (!take) return;
  stopPlayback(false);
  playCtx ??= new AudioContext({ sampleRate: RATE });
  void playCtx.resume();
  if (from >= take.seconds - 0.05) from = 0;
  const data = rendered(current, masks[current] ?? null);
  const buf = playCtx.createBuffer(1, data.length, RATE);
  buf.copyToChannel(data, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  src.start(0, from);
  player = { src, startedAt: playCtx.currentTime, from };
  src.onended = () => {
    if (player?.src === src) { pos = take!.seconds; player = null; $('play').textContent = 'Play'; }
  };
  $('play').textContent = 'Pause';
}

function stopPlayback(remember = true) {
  if (!player) return;
  if (remember) pos = now();
  const p = player;
  player = null;
  p.src.onended = null;
  p.src.stop();
  $('play').textContent = 'Play';
}

function choose(id: Id) {
  if (!take?.audio[id]) return;
  current = id;
  for (const el of document.querySelectorAll('.track')) el.classList.toggle('on', (el as HTMLElement).dataset.id === id);
  if (player) play();
}

function regate() {
  if (!take) return;
  masks = {};
  for (const t of TRACKS) if (take.audio[t.id]) masks[t.id] = gateMask(t.id, gateMode(), sens());
  const mode = gateMode();
  $('sens-label').hidden = mode === 'off';
  $('sens-val').textContent = mode === 'level' ? `${(-70 + (100 - sens()) * 0.5).toFixed(0)} dB` : mode === 'speech' ? `${(0.9 - sens() * 0.008).toFixed(2)}` : '';
  drawAll();
  if (player) play();
}

// ---- Drawing ---------------------------------------------------------------------------

function draw(id: Id, canvas: HTMLCanvasElement) {
  const a = take!.audio[id]!;
  const g = take!.gain[id]!;
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const c = canvas.getContext('2d')!;
  c.clearRect(0, 0, w, h);
  const mask = masks[id];
  if (mask) {
    c.fillStyle = css('--mention-tint');
    for (let x = 0; x < w; x++) {
      const s = Math.floor(((x / w) * a.length) / GATE_STEP);
      if (mask[s]) c.fillRect(x, 0, 1, h);
    }
  }
  c.fillStyle = css('--chat-muted');
  const per = a.length / w;
  for (let x = 0; x < w; x++) {
    let peak = 0;
    for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) peak = Math.max(peak, Math.abs(a[i]));
    const v = Math.min(1, peak * g) * (h / 2);
    c.fillRect(x, h / 2 - v, 1, Math.max(1, 2 * v));
  }
  if (gateMode() === 'speech') {
    const p = take!.speech[id]!;
    c.strokeStyle = css('--ok');
    c.lineWidth = devicePixelRatio;
    c.beginPath();
    for (let x = 0; x < w; x++) {
      const y = h - 1 - p[Math.min(p.length - 1, Math.floor((x / w) * p.length))] * (h - 2);
      if (x) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.stroke();
  }
}

function drawAll() {
  for (const el of document.querySelectorAll<HTMLElement>('.track')) {
    if (take!.audio[el.dataset.id as Id]) draw(el.dataset.id as Id, el.querySelector('canvas')!); // not the browser track when it wasn't recorded
  }
}

function tick() {
  if (take) {
    const t = Math.min(now(), take.seconds);
    $('clock').textContent = `${mmss(t)} / ${mmss(take.seconds)}`;
    if (player) $<HTMLInputElement>('pos').value = String(Math.round((t / take.seconds) * 1000));
  }
  requestAnimationFrame(tick);
}

// ---- Results ---------------------------------------------------------------------------

function showResults() {
  const t = take!;
  $('results').hidden = false;
  const list = $('tracks');
  list.replaceChildren();
  TRACKS.forEach((tr, i) => {
    const row = document.createElement('div');
    row.className = 'track';
    row.dataset.id = tr.id;
    const avail = !!t.audio[tr.id];
    row.innerHTML = `<span class="key">${i + 1}</span><div><div class="name"></div><div class="note"></div></div><canvas></canvas>`;
    row.querySelector('.name')!.textContent = tr.name;
    row.querySelector('.note')!.textContent = avail ? tr.note : `not recorded (${t.browserNote})`;
    if (avail) row.onclick = () => choose(tr.id);
    else row.style.opacity = '.45';
    list.append(row);
  });
  pos = 0;
  current = 'raw';
  choose('raw');
  regate();
  stats();
  void report('take');
}

function stats() {
  const t = take!;
  const rows: [string, string][] = [
    ['Length', mmss(t.seconds)],
    ['Web browser', navigator.userAgent.match(/(Firefox|Chrome|Edg)\/[\d.]+/)?.[0] ?? navigator.userAgent],
    ['Audio fell behind', t.jumps ? `${t.jumps} time${t.jumps > 1 ? 's' : ''}, ${Math.round(t.lost)} ms in all, worst ${Math.round(t.worst)} ms (all filters running at once)` : 'never'],
    ['Browser track', t.browserNote],
    ['Main capture got', t.settings.main],
    ['Raw: dropouts', t.gaps[0]],
    ...(t.gaps[1] ? [['Browser: dropouts', t.gaps[1]] as [string, string]] : []),
    ...(t.settings.second ? [['Second capture got', t.settings.second] as [string, string]] : []),
  ];
  for (const tr of TRACKS) {
    const a = t.audio[tr.id];
    if (!a) continue;
    // What the track holds, before loudness matching: a track that looks flat is told apart
    // here (very quiet, all exact zeros, or NaN from a filter that broke).
    let sum = 0, peak = 0, zeros = 0, nan = 0;
    for (const v of a) {
      if (Number.isNaN(v)) { nan++; continue; }
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
      if (v === 0) zeros++;
    }
    const pct = (n: number) => `${Math.round((100 * n) / a.length)}%`;
    const level = `level ${(10 * Math.log10(sum / a.length + 1e-12)).toFixed(0)} dB, peak ${peak.toFixed(3)}, exact zeros ${pct(zeros)}, NaN ${pct(nan)}`;
    const cpu = t.cpu[tr.id];
    rows.push([tr.name, tr.id === 'raw' ? level : `${level}; adds ${Math.round(t.delay[tr.id]!)} ms delay` + (cpu ? `; ${cpu}` : '')]);
  }
  lastRows = rows;
  const table = $('stats');
  table.replaceChildren();
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    const td = document.createElement('td');
    th.textContent = k;
    td.textContent = v;
    tr.append(th, td);
    table.append(tr);
  }
}

// Each filter alone, over the raw take, as fast as the browser will go: how many times faster
// than real time it runs is roughly how little of one CPU core it needs live.
async function speedTest() {
  if (!take) return;
  const btn = $<HTMLButtonElement>('speed');
  btn.disabled = true;
  const raw = take.audio.raw!;
  for (const id of ['rnnoise', 'gtcrn', 'dfn3'] as Id[]) {
    btn.textContent = `Measuring ${TRACKS.find((t) => t.id === id)!.name}…`;
    const off = new OfflineAudioContext(1, raw.length, RATE);
    let node: AudioNode;
    if (id === 'rnnoise') {
      await off.audioWorklet.addModule(BASE + 'rnnoise-worklet.js');
      node = new RnnoiseWorkletNode(off as unknown as AudioContext, { maxChannels: 1, wasmBinary: rnnoiseWasm });
    } else if (id === 'gtcrn') {
      await off.audioWorklet.addModule(BASE + 'gtcrn-worklet.js');
      node = new GtcrnWorkletNode(off as unknown as AudioContext, { maxChannels: 1, wasmBinary: gtcrnWasm });
    } else {
      node = await dfn.createAudioWorkletNode(off as unknown as AudioContext);
    }
    const buf = off.createBuffer(1, raw.length, RATE);
    buf.copyToChannel(raw as Float32Array<ArrayBuffer>, 0);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(node).connect(off.destination);
    src.start();
    const t0 = performance.now();
    await off.startRendering();
    const x = take.seconds / ((performance.now() - t0) / 1000);
    take.cpu[id] = `${x.toFixed(0)}× faster than real time (about ${(100 / x).toFixed(1)}% of one core)`;
    stats();
  }
  btn.textContent = 'Measure CPU cost';
  btn.disabled = false;
  void report('cpu');
}

// Every take (and CPU measurement, and error) is reported to the hub, which appends it to
// voice-lab.jsonl in its data directory, so the results can be read without screenshots:
// the Numbers table, what the browser said about the microphone, every track's level second
// by second (a track going flat shows when), and the errors met.
let lastRows: [string, string][] = [];
async function report(kind: 'take' | 'cpu' | 'error') {
  const perSecond: Partial<Record<Id, number[]>> = {};
  if (take && kind === 'take') {
    for (const [id, a] of Object.entries(take.audio) as [Id, Float32Array][]) {
      const out: number[] = [];
      for (let i = 0; i + RATE <= a.length; i += RATE) {
        let sum = 0;
        for (let j = i; j < i + RATE; j++) sum += a[j] * a[j];
        out.push(Number.isNaN(sum) ? NaN : Math.round(10 * Math.log10(sum / RATE + 1e-12)));
      }
      perSecond[id] = out;
    }
  }
  const body = {
    kind, page: location.search, ua: navigator.userAgent, capture,
    numbers: kind === 'error' ? undefined : Object.fromEntries(lastRows),
    perSecondDb: kind === 'take' ? perSecond : undefined,
    errors: errors.splice(0),
  };
  try {
    await fetch('/api/voice-lab/log', { method: 'POST', body: JSON.stringify(body) });
  } catch { /* the lab works without it */ }
}

// ---- Wiring ----------------------------------------------------------------------------

async function main() {
  const me = await fetch('/api/me');
  if (!me.ok) {
    status('Log in on the hub first, then come back to this page.', 'error');
    const a = document.createElement('a');
    a.href = '/';
    a.textContent = ' Go to the hub';
    $('status').append(a);
    return;
  }
  if (typeof AudioWorkletNode === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    status("This browser can't run the lab (it needs AudioWorklet and microphone access over HTTPS).", 'error');
    return;
  }
  const t0 = performance.now();
  try {
    await loadAll();
  } catch (e) {
    status(`Couldn't load the filters: ${(e as Error).message}`, 'error');
    return;
  }
  status(`Ready (filters loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s).`);
  const rec = $<HTMLButtonElement>('record');
  rec.disabled = false;
  rec.onclick = () => (session ? stopRecording() : void startRecording());
  $('monitor').onchange = setMonitor;
  $('play').onclick = () => (player ? stopPlayback() : play());
  $('gate').onchange = regate;
  $('sens').oninput = regate;
  $('speed').onclick = () => void speedTest();
  $('pos').oninput = () => {
    if (!take) return;
    const t = (Number($<HTMLInputElement>('pos').value) / 1000) * take.seconds;
    if (player) play(t); else pos = t;
  };
  document.addEventListener('keydown', (e) => {
    if (!take || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as Element).closest?.('select, input:not([type=range])')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= TRACKS.length) choose(TRACKS[n - 1].id);
    else if (e.key === ' ') player ? stopPlayback() : play();
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const t = Math.max(0, Math.min(take.seconds, now() + (e.key === 'ArrowLeft' ? -5 : 5)));
      if (player) play(t); else pos = t;
    } else return;
    e.preventDefault();
  });
  addEventListener('resize', () => take && drawAll());
  requestAnimationFrame(tick);
}

// For the tests: the last take.
(window as unknown as { __lab: unknown }).__lab = { take: () => take };

void main();
