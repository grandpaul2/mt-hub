// Shared harness for the browser suites. Importing it starts a fresh hub (its own temp data
// directory and free port, seeded with SEED below) and a headless Chromium driven over the
// DevTools protocol, then hands the suite small helpers. Each suite ends with `await done()`.
//
// Run suites through run.mjs, which builds the hub once and passes it in MTHUB_BIN.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const BIN = process.env.MTHUB_BIN;
if (!BIN) throw new Error('MTHUB_BIN is not set: run suites with `node test/browser/run.mjs`');
const SUITE = basename(process.argv[1], '.mjs');
export const OUT = join(import.meta.dirname, 'out');
const tmp = mkdtempSync(join(tmpdir(), `mthub-${SUITE}-`));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// until waits for fn to give something truthy (checked every 100 ms) and returns it.
export const until = async (what, fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    try { const v = await fn(); if (v) return v; } catch {}
  }
  throw new Error(`timed out waiting for ${what}`);
};

const freePort = () => new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

// What every suite starts with. Suites that need more add it themselves through the API.
export const SEED = {
  files: ['boards/anchor/a.md', 'boards/handheld-device/erc_outputs/ERC.rpt', 'boards/handheld-device/board.toml',
    'boards/handheld-device/parts.md', 'docs/guide.md', 'notes/todo.md', 'README.md', 'large/world.zip'],
  // Files in screenshots/, named "<date> <time> <poster>"; two share a second, so the
  // second is " (2)".
  shots: ['2026-09-01 15.00.01 Paul.png', '2026-09-02 15.00.02 Alex.png', '2026-09-03 15.00.03 eldridge.png',
    '2026-09-04 15.00.04 eldridge.png', '2026-09-04 15.00.04 eldridge (2).png', '2026-09-05 15.00.05 Lennox.png'],
  // Files in map art/, named by their titles.
  mapart: ['MA-001 Logo.png', 'MA-002 Album art.png', 'MA-003 Keyboard.png', 'MA-004 Flag.png', 'MA-005 Starry Night.png'],
  // Schematic posts, a folder each in schematics/: [title, file, date, credit]. Even ones
  // have a render (1.png). Build 6 is the newest.
  schems: [['Build 1', 'farm.litematic', '2026-07-01', 'Glowsquid'], ['Build 2', 'sorter.litematic', '2026-07-02', ''],
    ['Build 3', 'farm.litematic', '2026-07-03', 'Flutter'], ['Build 4', 'door.schem', '2026-07-04', ''],
    ['Build 5', 'wither cage.litematic', '2026-07-05', ''], ['Build 6', 'tnt duper.litematic', '2026-07-06', 'Paul']],
};

// png makes a small solid-colour PNG, so the picture folders have real images without fixture files.
export function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill([r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

// The hub.
const serverLog = join(tmp, 'server.log');
// Accounts: Paul is the owner (an admin), Alex and Steve aren't admins. Each password is
// "<name>-password".
export const DATA = join(tmp, 'data');
const USERS = { Paul: true, Alex: false, Steve: false };
for (const [name, admin] of Object.entries(USERS)) {
  execFileSync(BIN, ['passwd', '-data', DATA, `-admin=${admin}`, name], { input: `${name}-password\n`, stdio: ['pipe', 'ignore', 'inherit'] });
}
execFileSync(BIN, ['user', '-data', DATA, '-owner=true', 'Paul'], { stdio: ['ignore', 'ignore', 'inherit'] });
// Suites start side by side, so another one can take the free port first. A hub that can't
// have its port exits at once; then try another, and never talk to someone else's hub.
const logChunks = [];
let server, chrome, hubPort;
// A suite that crashes or is timed out by run.mjs never reaches done(): still stop the
// browser and the hub, so nothing is left running.
let finished = false;
process.on('exit', () => {
  chrome?.kill();
  server?.kill();
  if (!finished) {
    writeFileSync(serverLog, Buffer.concat(logChunks));
    console.log(`suite did not finish (hub data and log kept in ${tmp})`);
  }
});
process.on('SIGTERM', () => process.exit(1));
for (let tries = 0; ; tries++) {
  hubPort = await freePort();
  const p = spawn(BIN, ['-addr', `127.0.0.1:${hubPort}`, '-data', DATA, '-min-free', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => logChunks.push(d));
  const gone = new Promise((r) => p.on('exit', () => r(false)));
  const listening = until('the hub to start', () => Buffer.concat(logChunks).includes('mthub on http://')).then(() => sleep(150)).then(() => true);
  if (await Promise.race([gone, listening]) && p.exitCode === null) { server = p; break; }
  if (tries === 5) throw new Error(`the hub did not start: ${Buffer.concat(logChunks)}`);
  logChunks.length = 0;
}
export const HUB = `http://127.0.0.1:${hubPort}`;
await until('the hub to answer', async () => (await fetch(`${HUB}/api/me`)).status === 401);

// A change a suite makes through the API reaches the page as a live update; settle() waits
// for one. owed is when the last such change started (null: nothing owed).
let owed = null;
const nodeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url).startsWith(HUB) && !['GET', 'HEAD'].includes(init?.method ?? 'GET')) owed = Date.now();
  return nodeFetch(url, init);
};

// COOKIE.<name> is a logged-in session for API calls: headers: { cookie: COOKIE.Paul }.
export const COOKIE = {};
for (const name of Object.keys(USERS)) {
  const r = await fetch(`${HUB}/api/login`, { method: 'POST', body: JSON.stringify({ name, password: `${name}-password` }) });
  COOKIE[name] = r.headers.getSetCookie()[0].split(';')[0];
}
// hub is fetch on the hub, as Paul unless init.headers says otherwise.
export const hub = (path, init = {}) => fetch(HUB + path, { ...init, headers: { cookie: COOKIE.Paul, ...init.headers } });
export const api = (method, path, body, who = 'Alex') =>
  fetch(HUB + path, { method, body: body && JSON.stringify(body), headers: { cookie: COOKIE[who] } });
const ok = async (what, res) => { if (!(await res).ok) throw new Error(`seed: ${what} failed`); };
for (const p of SEED.files) await ok(p, fetch(`${HUB}/api/file/${p}?base=`, { method: 'PUT', headers: { cookie: COOKIE.Paul }, body: 'x' }));
const putPic = (p, body) => fetch(`${HUB}/api/file/${encodeURIComponent(p).replace(/%2F/g, '/')}?base=`, { method: 'PUT', headers: { cookie: COOKIE.Paul }, body });
for (const [i, name] of SEED.shots.entries()) await ok('shot', putPic(`screenshots/${name}`, png(160, 90, [40 * i, 120, 200])));
for (const [i, name] of SEED.mapart.entries()) await ok('map art', putPic(`map art/${name}`, png(128, 128, [200, 40 * i, 80])));
for (const [i, [title, file, date, credit]] of SEED.schems.entries()) {
  const dir = `schematics/${title}`;
  await ok('schematic', putPic(`${dir}/${file}`, `schematic ${i}`));
  if (i % 2) await ok('render', putPic(`${dir}/1.png`, png(200, 120, [90, 30 * i, 160])));
  await ok('readme', putPic(`${dir}/README.md`, `# ${title}\n\n${credit ? `Design by ${credit} · posted ${date}` : `Posted ${date}`}\n\nHow to use ${title}.\n`));
}

// The browser. Port 0 lets Chromium pick one; it writes the choice to DevToolsActivePort.
const profile = join(tmp, 'chrome');
// A fake microphone that needs no permission prompt, and sound that plays without a click (the voice lab): Chromium's beeps, or the
// WAV file in FAKE_AUDIO.
chrome = spawn('chromium', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--window-size=1200,800', '--hide-scrollbars', '--no-first-run',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  ...(process.env.FAKE_AUDIO ? [`--use-file-for-fake-audio-capture=${process.env.FAKE_AUDIO}`] : []),
  'about:blank'], { stdio: 'ignore' });
const cdpPort = await until('Chromium to start', () =>
  existsSync(join(profile, 'DevToolsActivePort')) && readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
const page = await until('a Chromium page', async () =>
  (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page'));
export const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});

// Uncaught errors in the page are printed, so a failing check comes with its cause.
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log(`PAGE ERROR: ${(d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' | ')}`);
  }
});

let fails = 0;

// Anything the Content Security Policy blocks is a failure: the page or a worker tried to
// load or connect to something the hub's policy (headers.go) doesn't allow.
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Log.entryAdded' && /Content Security Policy/.test(m.params.entry.text)) {
    fails++;
    console.log(`FAIL CSP: ${m.params.entry.text.slice(0, 300)}`);
  }
});

// send is one DevTools call; ev evaluates in the page and returns the value.
export const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
export const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const KEYS = { Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Enter: 13, F2: 113, Escape: 27, Delete: 46, Home: 36, End: 35 };
export const key = async (k) => {
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k] });
  await settle(150);
};
export const typeText = (text) => send('Input.insertText', { text });
await send('Runtime.enable');
await send('Log.enable');

// settle(ms) is the pause after doing something: it returns as soon as the page has nothing
// in progress, and after ms at the latest. Use sleep(ms) only when time itself has to pass
// (a rate limit, a timeout under test), and until() to wait for one particular thing.
//
// "Nothing in progress" is: the page is loaded; no request is open; the live-update stream
// is connected; no timer or animation is due before ms is up; a change made through the API since
// the last settle has been followed by a live update; and nothing has changed in the page or
// arrived from the network for QUIET ms. Anything it can't tell keeps it waiting the full ms,
// which is what a fixed pause would do.
//
// SETTLE_AUDIT=1 waits the full ms every time and prints a LATE line wherever the page still
// did something after settle would have returned: those places need until() or sleep().
const QUIET = 60;
const AUDIT = !!process.env.SETTLE_AUDIT;
const net = { open: new Map(), last: 0, live: 0 };
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data), p = m.params;
  // (A worker's script never reports as finished here, so it isn't counted.)
  if (m.method === 'Network.requestWillBeSent') { if (p.type !== 'EventSource' && !/worker\.js$/.test(p.request.url)) net.open.set(p.requestId, p.request.url); net.last = Date.now(); }
  else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { net.open.delete(p.requestId); net.last = Date.now(); }
  else if (m.method === 'Network.eventSourceMessageReceived') net.live = net.last = Date.now();
  else if (m.method === 'Network.webSocketFrameReceived') net.last = Date.now();
  // A new page loads everything fresh: nothing is owed, and the old page's requests are gone.
  else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) { owed = null; net.open.clear(); }
});
await send('Network.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `{
  const S = (window.__settle = { fetches: 0, timers: new Map(), at: performance.now(), what: 'start', n: 0 });
  const did = (what) => { S.at = performance.now(); S.what = what; S.n++; };
  const name = (r) => { const t = r.target.nodeType === 1 ? r.target : r.target.parentElement; return r.type + ' ' + (t ? t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + (typeof t.className === 'string' && t.className ? '.' + t.className.split(' ').join('.') : '') : '?'); };
  // (the editor's blinking cursor is not the page doing something)
  new MutationObserver((rs) => { const r = rs.find((r) => !r.target.parentElement?.closest('.cursors-layer')); if (r) did(name(r)); }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  const st = (S.st = window.setTimeout.bind(window)), ct = window.clearTimeout.bind(window);
  window.setTimeout = (fn, ms = 0, ...a) => {
    const id = st(() => { S.timers.delete(id); did('timer'); typeof fn === 'function' ? fn(...a) : (0, eval)(fn); }, ms);
    S.timers.set(id, performance.now() + (+ms || 0));
    return id;
  };
  window.clearTimeout = (id) => { S.timers.delete(id); ct(id); };
  const f = window.fetch.bind(window);
  window.fetch = (...a) => { S.fetches++; const end = () => { S.fetches--; did('fetch'); }; return f(...a).then((r) => { end(); return r; }, (e) => { end(); throw e; }); };
  const ES = window.EventSource;
  S.streams = [];
  window.EventSource = class extends ES { constructor(...a) { super(...a); S.streams.push(this); } };
  const xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) { S.fetches++; this.addEventListener('loadend', () => { S.fetches--; did('upload'); }); return xs.apply(this, a); };
}` });
const PROBE = `(async () => {
  const S = window.__settle;
  if (!S) return null;
  await new Promise((r) => requestAnimationFrame(() => S.st(r, 0)));
  const now = performance.now();
  let timer = 1e9, anim = 1e9; // not Infinity, which would arrive here as null
  for (const due of S.timers.values()) timer = Math.min(timer, due - now);
  for (const a of document.getAnimations()) {
    const left = a.playState === 'running' ? a.effect?.getComputedTiming().endTime - (a.currentTime ?? 0) : Infinity;
    if (isFinite(left)) anim = Math.min(anim, left);
  }
  return { ready: document.readyState === 'complete', fetches: S.fetches, quiet: now - S.at, timer, anim, n: S.n, what: S.what,
    connecting: S.streams.some((e) => e.readyState === 0),
    image: [...document.images].some((i) => !i.complete && i.loading !== 'lazy') };
})()`;
const caller = () => (new Error().stack.split('\n').find((l) => l.includes('file://') && !l.includes('/lib.mjs')) ?? '').match(/([^/]+\.mjs:\d+)/)?.[1] ?? '?';
export const waited = { asked: 0, took: 0, full: new Map() };
export const settle = async (ms) => {
  const start = Date.now(), end = start + ms;
  // Work that will certainly finish (a page loading, a request) is waited for a while past ms
  // too: on a busy machine it can take longer than the pause that used to be enough.
  const SURE = ['the page not answering in time', 'the page loading', 'a request'];
  const hard = end + Math.min(2 * ms + 1000, 5000);
  let busy = 'time';
  for (let left; (left = end - Date.now()) > 0 || (SURE.some((b) => busy?.startsWith(b)) && Date.now() < hard); await sleep(15)) {
    const p = await Promise.race([ev(PROBE), sleep(Math.max(100, Math.min(left, 1000)))]);
    const now = Date.now();
    left = end - now;
    busy = !p ? 'the page not answering in time' : !p.ready ? 'the page loading' : p.fetches ? 'a request' : net.open.size ? `a request (${[...net.open.values()][0].replace(HUB, '').slice(0, 60)})`
      : p.connecting ? 'the live updates connecting' : p.image ? 'a picture' : p.timer < left ? 'a timer' : p.anim < left ? 'an animation' : owed !== null && net.live < owed ? 'a live update'
      : p.quiet < QUIET ? 'changes' : now - net.last < QUIET ? 'the network' : now - start < QUIET ? 'the shortest wait' : null;
    if (busy) continue;
    if (AUDIT) {
      const idle = now - start, lastNet = net.last;
      await sleep(Math.max(0, end - Date.now()));
      const q = await Promise.race([ev(PROBE), sleep(1000)]);
      if (!q || q.n !== p.n || net.last !== lastNet) console.log(`LATE ${caller()}: idle after ${idle} of ${ms} ms, then ${!q ? 'the page went away' : q.n !== p.n ? q.what : 'network'}`);
    }
    break;
  }
  owed = null;
  waited.asked += ms;
  waited.took += Date.now() - start;
  if (busy) { const c = `${caller()} ${busy}`; waited.full.set(c, (waited.full.get(c) ?? 0) + ms); }
};

// The hub asks in its own dialog (ask() in util.ts). answerDialogs(true | false) makes the
// page answer every question (confirm or Cancel) and note its title, across reloads (kept in
// sessionStorage); null stops answering. asked() is the titles since last called.
await send('Page.enable'); // needed for the script below to run on each new page
await send('Page.addScriptToEvaluateOnNewDocument', { source: `{
  const seen = new WeakSet();
  new MutationObserver(() => {
    const t = document.querySelector('#dialog.ask h2');
    const a = sessionStorage.getItem('__answer');
    if (!t || a === null || seen.has(t)) return;
    seen.add(t);
    const asked = JSON.parse(sessionStorage.getItem('__asked') ?? '[]');
    asked.push(t.textContent);
    sessionStorage.setItem('__asked', JSON.stringify(asked));
    setTimeout(() => document.querySelector(a === 'yes' ? '#dialog .actions button:last-child' : '#dialog .actions button:first-child')?.click());
  }).observe(document, { childList: true, subtree: true });
}` });
export const answerDialogs = (yes) => ev(yes === null ? `sessionStorage.removeItem('__answer')` : `sessionStorage.setItem('__answer', '${yes ? 'yes' : 'no'}')`);
export const asked = () => ev(`(() => { const a = JSON.parse(sessionStorage.getItem('__asked') ?? '[]'); sessionStorage.removeItem('__asked'); return a; })()`);

// as logs the browser in as someone (reload the page to see it); suites start as Paul.
export const as = (who) => send('Network.setCookie', { name: 'mt_session', value: COOKIE[who].split('=')[1], url: HUB });
await as('Paul');

// shot saves a screenshot to out/<suite>-<name>.png for a person to look at; nothing checks it.
// Pass a clip ({ x, y, width, height }) for part of the page; the default is the whole view.
export const shot = async (name, clip) => {
  const s = await send('Page.captureScreenshot', clip ? { clip: { ...clip, scale: 1 } } : {});
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${SUITE}-${name}.png`), Buffer.from(s.data, 'base64'));
};

export const check = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${pass ? '' : ` (want ${JSON.stringify(want)})`}`);
};

// done reports, stops the browser and hub, and removes the temp directory (kept on failure,
// with the hub's log, so there is something to look at).
export async function done() {
  finished = true;
  if (process.env.SETTLE_REPORT || AUDIT) {
    console.log(`WAITS ${SUITE}: ${waited.took} of ${waited.asked} ms`);
    for (const [c, ms] of [...waited.full].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`FULL ${ms} ms ${c}`);
  }
  ws.close();
  chrome.kill();
  server.kill();
  if (fails) {
    writeFileSync(serverLog, Buffer.concat(logChunks));
    console.log(`${fails} FAILED (hub data and log kept in ${tmp})`);
    process.exitCode = 1;
  } else {
    console.log('all passed');
    await sleep(200); // let Chromium let go of its profile
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(); // an open pipe or socket must not keep a finished suite running
}
