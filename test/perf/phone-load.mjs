// How long the page takes to show chat on a phone, against a fresh local hub (the browser
// suites' harness). Not a pass/fail suite: it prints numbers to compare before and after a
// change.
//
//   make web && go build -o bin/mthub-test ./cmd/mthub && MTHUB_BIN=bin/mthub-test node test/perf/phone-load.mjs
//
// The phone: 390x844 at 3x, touch, its processor 4x slower than this machine (Chrome's
// "mid-tier mobile"). The local hub doesn't compress (Caddy does that in front of the real
// one), so time on the network isn't measured here; the bytes sent over it are printed, as
// compressed the way Caddy would (gzip).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { api, done, ev, HUB, send, sleep } from '../browser/lib.mjs';

const RUNS = 5;

for (let i = 0; i < 30; i++) await api('POST', '/api/channels/general/messages', { text: `message ${i}` }, i % 2 ? 'Paul' : 'Alex');

await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
await send('Emulation.setCPUThrottlingRate', { rate: 4 });

// What the page fetched, and how big each is compressed.
const fetched = new Set();
const { ws } = await import('../browser/lib.mjs');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.startsWith(HUB)) fetched.add(new URL(m.params.request.url).pathname);
});

// One load: from navigating to the first chat message on screen. Script = time the main
// thread spent compiling and running scripts (the phone's processor, not the network).
async function load(cold) {
  await send('Network.setCacheDisabled', { cacheDisabled: cold });
  await send('Performance.enable');
  await send('Page.navigate', { url: `${HUB}/` });
  const t = await ev(`new Promise((ok) => {
    const tick = () => document.querySelector('.msg') ? ok(performance.now()) : requestAnimationFrame(tick);
    tick();
  })`);
  const m = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  await send('Performance.disable');
  return { chat: t, script: m.ScriptDuration * 1000 };
}

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const cold of [true, false]) {
  if (!cold) await load(false); // fill the cache
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(await load(cold));
    await sleep(300);
  }
  console.log(`${cold ? 'first visit' : 'return visit'} (median of ${RUNS}): chat shows at ${Math.round(median(runs.map((r) => r.chat)))} ms, ` +
    `script ${Math.round(median(runs.map((r) => r.script)))} ms`);
}

// Bytes a first visit downloads from the built files, gzipped as Caddy would send them.
const dist = join(import.meta.dirname, '..', '..', 'web', 'dist');
let raw = 0;
let wire = 0;
const rows = [];
for (const p of [...fetched].filter((p) => p !== '/' && !p.startsWith('/api/'))) {
  const f = join(dist, decodeURIComponent(p));
  try { if (!statSync(f).isFile()) continue; } catch { continue; }
  const b = readFileSync(f);
  const z = gzipSync(b).length;
  raw += b.length;
  wire += z;
  rows.push([p, b.length, z]);
}
rows.sort((a, b) => b[2] - a[2]);
for (const [p, r, z] of rows.slice(0, 8)) console.log(`  ${(z / 1e3).toFixed(0).padStart(6)} KB gzip  ${(r / 1e3).toFixed(0).padStart(6)} KB raw  ${p}`);
console.log(`static files fetched: ${rows.length}, ${(wire / 1e6).toFixed(2)} MB over the wire (${(raw / 1e6).toFixed(2)} MB raw)`);
await done();
