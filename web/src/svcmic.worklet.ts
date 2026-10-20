// The microphone chain's audio worklet (voice.ts builds it; the chain is svcmic.ts). Gathers the
// browser's 128-sample blocks into 20 ms frames of 16-bit samples, as Simple Voice Chat reads
// a microphone, runs each through the chain, and plays what is to be sent (silence otherwise)
// one frame later. The page sends settings and states over the port; the worklet sends the
// level for the settings meter.
import { FRAME, SvcMic, natives, type MicSettings } from './svcmic';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: { wasm: ArrayBuffer; settings: MicSettings } }) => AudioWorkletProcessor): void;

type Msg = { settings?: MicSettings; muted?: boolean; pttDown?: boolean; testing?: boolean };

const QUEUE = FRAME * 4; // output waiting to play: a frame, plus room for the blocks around it

class SvcMicProcessor extends AudioWorkletProcessor {
  private mic: SvcMic;
  private frame = new Int16Array(FRAME);
  private filled = 0;
  private queue = new Float32Array(QUEUE);
  private read = 0;
  private queued = 0;
  private started = false; // nothing plays until the first frame is in, so the delay is one frame
  private peak = 0;
  private lastLevel = 0;

  constructor(options: { processorOptions: { wasm: ArrayBuffer; settings: MicSettings } }) {
    super();
    if (sampleRate !== 48000) throw new Error(`the microphone chain needs 48 kHz, not ${sampleRate}`);
    // Compiled here, at once: a worklet can't wait for a promise before it starts processing.
    this.mic = new SvcMic(natives(new WebAssembly.Module(options.processorOptions.wasm)), options.processorOptions.settings);
    this.port.onmessage = (e: MessageEvent<Msg>) => Object.assign(this.mic, e.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const x = inputs[0]?.[0];
    const y = outputs[0][0];
    const n = y.length;
    for (let i = 0; i < n; i++) {
      // The browser's samples are the microphone's 16-bit ones over 32768 (or near: clamp).
      const v = x ? Math.round(x[i] * 32768) : 0;
      this.frame[this.filled++] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      if (this.filled === FRAME) {
        this.filled = 0;
        const out = this.mic.process(this.frame);
        this.push(out);
      }
    }
    if (this.started && this.queued >= n) {
      for (let i = 0; i < n; i++) {
        const s = this.queue[this.read];
        y[i] = s;
        const a = s < 0 ? -s : s;
        if (a > this.peak) this.peak = a;
        this.read = (this.read + 1) % QUEUE;
      }
      this.queued -= n;
    }
    if (currentTime - this.lastLevel > 0.05) {
      this.port.postMessage(this.peak);
      this.peak = 0;
      this.lastLevel = currentTime;
    }
    return true;
  }

  private push(out: Int16Array | null) {
    if (this.queued + FRAME > QUEUE) return; // can't happen at one frame in per frame out
    let at = (this.read + this.queued) % QUEUE;
    for (let i = 0; i < FRAME; i++) {
      this.queue[at] = out ? out[i] / 32768 : 0;
      at = (at + 1) % QUEUE;
    }
    this.queued += FRAME;
    this.started = true;
  }
}

registerProcessor('svc-mic', SvcMicProcessor);
