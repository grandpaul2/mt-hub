// The microphone chain of the hub's voice chats: what Simple Voice Chat 2.6.24 does with a
// player's microphone, then MT Utils' keyboard noise gate, so a hub member sounds the way they
// do in game (spec and sources: docs/voice/svc-mic.md). No browser APIs here: the audio
// worklet (svcmic.worklet.ts) runs it, and so do the unit tests (test/unit/svcmic/).
//
// Per 20 ms frame (960 samples, 16-bit, 48 kHz):
//   RNNoise (denoise, or only its speech probability with Noise Suppression off)
//   -> Gain: Auto (Speex's preprocessor; the gain may rise 12 dB/s only on frames RNNoise is
//      at least 95% sure are speech) or Manual (a fixed gain that never clips)
//   -> activation: Voice (Auto: RNNoise >= 0.5; Manual: the frame's peak above a threshold) or
//      Push to Talk (the key), then a tail (500 ms Voice, 100 ms Push to Talk)
//   -> the keyboard gate (Voice only): Silero on the frames that got this far, the audio held
//      back 3 frames, open from a probability >= 0.5 for 11 frames
//   -> the frame to send, or nothing.

export const FRAME = 960;

export type MicSettings = {
  agc: boolean; // Gain: Auto
  gainDb: number; // Microphone Gain, -40..24, with Gain: Manual
  denoise: boolean; // Noise Suppression
  ptt: boolean; // Activation Method: Push to Talk (else Voice)
  vad: boolean; // Voice Activation: Auto
  thresholdDb: number; // Voice Activation Threshold, with Voice Activation: Manual
  keyboardGate: boolean;
};

export const DEFAULT_SETTINGS: MicSettings = { agc: true, gainDb: 0, denoise: true, ptt: false, vad: true, thresholdDb: -50, keyboardGate: true };

// What svc-mic.wasm exports (native/svc-mic/shim.c).
export type Natives = {
  memory: WebAssembly.Memory;
  frame(): number;
  denoise(replace: number): number;
  gain(increment: number): void;
  listen(): number;
  forget(): void;
};

// natives starts one instance of svc-mic.wasm: one microphone's state.
export function natives(module: WebAssembly.Module): Natives {
  const x = new WebAssembly.Instance(module, {}).exports as unknown as Natives & { _initialize(): void; init(): number };
  x._initialize();
  const err = x.init();
  if (err) throw new Error(`svc-mic.wasm didn't start (${err})`);
  return x;
}

const VOICE_TAIL = 25; // frames: voice_deactivation_delay
const PTT_TAIL = 5; // frames: ptt_deactivation_delay
const AGC_PROBABILITY = 0.95;
const ACTIVATION_PROBABILITY = 0.5;
const GATE_THRESHOLD = 0.5;
const GATE_TAIL = 8;
const GATE_LOOK_AHEAD = 3;
const GATE_STALE = 50; // frames (1 s) without one reaching the gate: its verdict and held audio are dropped

// peakDb is a frame's loudest sample in dBFS, bottoming out at -127.
export function peakDb(frame: Int16Array): number {
  let top = 0;
  for (const s of frame) {
    const a = s <= -32768 ? 32767 : Math.abs(s);
    if (a > top) top = a;
  }
  if (top === 0) return -127;
  return Math.max(-127, Math.min(0, 20 * Math.log10(top / 32768)));
}

// ManualGain is Gain: Manual. The gain is lowered for a frame when the loudest of the last 50
// would otherwise clip at it.
export class ManualGain {
  private recent = new Float64Array(50).fill(-1);
  private at = 0;
  apply(frame: Int16Array, db: number) {
    const want = db <= -40 ? 0 : 10 ** (db / 20);
    let top = 0;
    for (const s of frame) {
      const a = s <= -32768 ? 32767 : Math.abs(s);
      if (a > top) top = a;
    }
    this.recent[this.at] = top === 0 ? want : Math.min(want, 32766 / top);
    this.at = (this.at + 1) % this.recent.length;
    let min = -1;
    for (const m of this.recent) if (m >= 0 && (min < 0 || m < min)) min = m;
    const k = Math.min(min, want);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.trunc(frame[i] * k); // Java's (short) cast
  }
}

// KeyboardGate is MT Utils' NoiseGate on the natives' Silero.
class KeyboardGate {
  private prob = 0;
  private tailLeft = 0;
  private last = -1;
  private held: Int16Array[] = [];
  private x: Natives;
  constructor(x: Natives) {
    this.x = x;
  }
  // process takes a frame that is about to be sent (already in the natives' buffer) and returns
  // the frame to send in its place, or null.
  process(frame: Int16Array, n: number): Int16Array | null {
    if (this.last >= 0 && n - this.last > GATE_STALE) {
      this.prob = 0;
      this.tailLeft = 0;
      this.held = [];
      this.x.forget();
    }
    this.last = n;
    this.prob = this.x.listen();
    let open: boolean;
    if (this.prob >= GATE_THRESHOLD) {
      this.tailLeft = GATE_TAIL + GATE_LOOK_AHEAD;
      open = true;
    } else if (this.tailLeft > 0) {
      this.tailLeft--;
      open = true;
    } else open = false;
    this.held.push(frame.slice());
    while (this.held.length > GATE_LOOK_AHEAD + 1) this.held.shift();
    if (this.held.length <= GATE_LOOK_AHEAD) return null;
    const out = this.held.shift()!;
    return open ? out : null;
  }
  probability() {
    return this.prob;
  }
}

export class SvcMic {
  muted = false; // the hub's mute
  pttDown = false; // the Push to Talk key
  testing = false; // the Mic test: Push to Talk sends without the key, a muted Voice mic still gains
  // Diagnostics for the tests and the settings meter.
  speech = 0; // RNNoise's last probability
  sentByActivation = false;
  lastSent: Int16Array | null = null; // the frame activation let through, before the keyboard gate
  private tail = 0;
  private transmitting = false; // Push to Talk, as of the last frame
  private manual = new ManualGain();
  private gate: KeyboardGate;
  private n = 0;
  private x: Natives;
  settings: MicSettings;

  constructor(x: Natives, settings: MicSettings) {
    this.x = x;
    this.settings = settings;
    this.gate = new KeyboardGate(x);
  }

  // process takes one frame from the microphone and returns what to send, or null. The frame
  // returned may be another array than the one given (the keyboard gate sends 3 frames late).
  process(input: Int16Array): Int16Array | null {
    const s = this.settings;
    const frame = new Int16Array(this.x.memory.buffer, this.x.frame(), FRAME);
    frame.set(input);
    const n = this.n++;

    // preprocess
    const p = this.x.denoise(s.denoise ? 1 : 0);
    this.speech = p;
    if (s.agc) {
      const adjust = s.ptt ? this.transmitting : !this.muted || this.testing;
      this.x.gain(p >= AGC_PROBABILITY && adjust ? 12 : 0);
    } else this.manual.apply(frame, s.gainDb);

    // activation and tail
    let active: boolean;
    if (s.ptt) {
      this.transmitting = this.pttDown || this.testing;
      active = this.transmitting;
    } else if (this.muted && !this.testing) {
      this.tail = 0;
      active = false;
    } else active = s.vad ? p >= ACTIVATION_PROBABILITY : peakDb(frame) > s.thresholdDb;
    let send: boolean;
    if (active) {
      this.tail = s.ptt ? PTT_TAIL : VOICE_TAIL;
      send = true;
    } else if (this.tail > 0) {
      this.tail--;
      send = true;
    } else send = false;
    if (this.muted && !this.testing) send = false;
    this.sentByActivation = send;
    if (!send) return null;

    const out = frame.slice();
    this.lastSent = out;
    if (!s.keyboardGate || s.ptt) return out;
    return this.gate.process(out, n);
  }

  gateProbability() {
    return this.gate.probability();
  }
}
