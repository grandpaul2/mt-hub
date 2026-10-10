// The speech gate's ear (voice.ts): Silero VAD v6 on the microphone, in a worker so the page's
// own work never delays it. The gate's worklet sends it 32 ms frames at 16 kHz straight over
// a MessagePort; it answers the page with "open" or "shut" when that changes.
//
// Open when two frames in a row are speech (above the threshold); shut once nothing has been
// above the threshold minus 0.15 for HOLD seconds (two thresholds, as Mumble does). Tested in
// the voice lab (docs/voice/): typing alone never opens it.
import * as ort from 'onnxruntime-web/wasm';

const FRAME = 512;
const CONTEXT = 64; // Silero v5/v6 want the previous frame's last 64 samples in front
const HOLD = 0.5;

let session: ort.InferenceSession;
let state: ort.Tensor;
let sr: ort.Tensor;
let input = new Float32Array(CONTEXT + FRAME);
let threshold = 0.5;
let open = false;
let run = 0;
let quiet = 0;
let busy: Promise<void> = Promise.resolve();
// (The project's types are the page's, where postMessage takes a target origin too.)
const post = (m: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);

async function frame(f: Float32Array) {
  input.copyWithin(0, FRAME, FRAME + CONTEXT);
  input.set(f, CONTEXT);
  const out = await session.run({ input: new ort.Tensor('float32', input.slice(), [1, input.length]), state, sr });
  state = out.stateN;
  const p = (out.output.data as Float32Array)[0];
  const was = open;
  if (!open) {
    run = p >= threshold ? run + 1 : 0;
    if (run >= 2) { open = true; quiet = 0; }
  } else {
    quiet = p < Math.max(0.05, threshold - 0.15) ? quiet + FRAME / 16000 : 0;
    if (quiet >= HOLD) { open = false; run = 0; }
  }
  if (open !== was) post({ type: 'gate', open });
}

self.onmessage = async (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'init') {
    ort.env.wasm.wasmPaths = d.base;
    ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which the hub doesn't set
    session = await ort.InferenceSession.create(d.base + 'silero_vad_v6.onnx');
    state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    sr = new ort.Tensor('int64', BigInt64Array.from([16000n]));
    input = new Float32Array(CONTEXT + FRAME);
    (d.port as MessagePort).onmessage = (m) => {
      // One frame at a time, in order; if the model ever falls behind, frames queue up.
      busy = busy.then(() => frame(m.data as Float32Array)).catch((err) => post({ type: 'error', message: String(err) }));
    };
    post({ type: 'ready' });
  } else if (d.type === 'threshold') {
    threshold = d.value;
  }
};
