// make firefox-check: does a real screen show what Firefox meant to draw?
//
// Runs a real Firefox (about a minute and a half) with a throwaway profile using Pat's
// graphics settings (GPU WebRender over EGL/DMA-BUF), against a throwaway hub. For each main
// view it compares the real screen pixels with Firefox's own capture of the same page. Those
// differ only where the GPU path drew something other than the page: the bug that cut the
// bottom row off g/p/y in file-tree names. Headless browsers, including the browser tests,
// can't see this.
//
// Two ways: on i3 with X11 the window is on the real screen (i3-msg places it, maim grabs the
// screen). On a Wayland desktop it runs in a headless KWin of its own (headless-kwin.sh: no
// window on the real screens; mouse and focus play no part): a throwaway KWin script sizes the
// window, KWin's screenshot interface grabs it, and the page is its bottom innerWidth ×
// innerHeight (Firefox on Wayland doesn't know where its window is). The two are different GPU
// paths (X11 EGL to the screen vs Wayland EGL to a headless KWin); the verdict says which.
//
//   node test/firefox/check.mjs [--software] [--views=<name>,…] [--shift=<px>]
//   --software  software WebRender, for comparison
//   --views     only these views (setup runs)
//   --shift     Wayland: crop the screen grab this many pixels higher, to see the compare fail
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createHash, createHmac } from 'node:crypto';

const root = join(import.meta.dirname, '..', '..');
const BIN = join(root, 'bin', 'mthub');
const OUT = join(root, 'test', 'firefox', 'out');
const SOFTWARE = process.argv.includes('--software');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ONLY = arg('views')?.split(',');
const SHIFT = Number(arg('shift') ?? 0);
const X = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', XAUTHORITY: process.env.XAUTHORITY || `${process.env.HOME}/.Xauthority` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const works = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore', env: X }); return true; } catch { return false; } };

// Which desktop, and its tools, before anything starts. On Wayland the check runs in a
// headless KWin of its own (headless-kwin.sh): the desktop's screens, mouse and focus play no part.
const WAYLAND = process.env.XDG_SESSION_TYPE === 'wayland' || process.env.MTHUB_KWIN_INNER === '1';
const missing = (WAYLAND ? [['kwin_wayland', ['--version']], ['dbus-run-session', ['--version']], ['python3', ['-c', 'import dbus']]] : [['i3-msg', ['-t', 'get_version']], ['maim', ['--version']]])
  .concat([['python3', ['-c', 'import PIL']]]).filter(([c, a]) => !works(c, a)).map(([c, a]) => c === 'python3' ? `python3 with ${a[1].slice(7)}` : c);
if (missing.length) { console.log(`FAIL needs ${missing.join(', ')} (${WAYLAND ? 'Wayland: a headless KWin' : 'i3 on X11'})`); process.exit(2); }
if (WAYLAND && process.env.MTHUB_KWIN_INNER !== '1') {
  const r = spawnSync(join(import.meta.dirname, 'headless-kwin.sh'), [process.execPath, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 2);
}
const KWIN = WAYLAND;

const tmp = mkdtempSync(join(tmpdir(), 'mthub-firefox-'));
let ff, hub;
process.on('exit', () => {
  ff?.kill(); hub?.kill();
  rmSync(tmp, { recursive: true, force: true });
});
setTimeout(() => { console.log('timed out'); process.exit(2); }, 180000);

function png(w, h, [r, g, b]) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill([r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

// The hub, seeded with text that has tails (g, p, y, j) in every kind of place.
const data = join(tmp, 'data');
for (const [n, admin] of [['Pat', 'true'], ['Peggy', 'false']]) execFileSync(BIN, ['passwd', '-data', data, `-admin=${admin}`, n], { input: `${n}-password\n` });
// #voice-link, with no LiveKit behind it: the lock is drawn from what the hub lists.
writeFileSync(join(data, 'voice.json'), JSON.stringify({ url: 'ws://127.0.0.1:1', api: 'http://127.0.0.1:1', key: 'k', secret: 'check-secret-0123456789', link_voice: true }));
const port = await freePort(), HUB = `http://127.0.0.1:${port}`;
hub = spawn(BIN, ['-addr', `127.0.0.1:${port}`, '-data', data, '-min-free', '0'], { stdio: 'ignore' }); // /tmp is small
await sleep(800);
const login = async (n) => (await fetch(`${HUB}/api/login`, { method: 'POST', body: JSON.stringify({ name: n, password: `${n}-password` }) })).headers.getSetCookie()[0].split(';')[0];
const pat = await login('Pat'), peggy = await login('Peggy');
// Seeding fails loudly: a refused upload would leave the views checking empty pages.
const put = async (p, body) => { const r = await fetch(`${HUB}/api/file/${p.split('/').map(encodeURIComponent).join('/')}?base=`, { method: 'PUT', headers: { cookie: pat }, body }); if (!r.ok) throw new Error(`seeding ${p}: ${r.status}`); return r; };
await put('boards/Playground juggling glyphs query.md', '# Piggy jig\n\nGypsy jiggly query: `typography` and *quipping*.\n');
await put('gyp/jiggly.md', 'x');
await put('screenshots/2026-09-01 15.00.01 Peggy.png', png(160, 90, [40, 120, 200]));
await put('screenshots/2026-09-02 15.00.02 Peggy.png', png(160, 90, [90, 60, 200]));
await put('schematics/Piggy gyp jig/piggy jig gyp.litematic', 'schem');
await put('schematics/Piggy gyp jig/README.md', '# Piggy gyp jig\n\nDesign by Peggy · posted 2026-07-06\n\nHow to use it.\n');
const say = (cookie, body) => fetch(`${HUB}/api/channels/general/messages`, { method: 'POST', headers: { cookie }, body: JSON.stringify(body) }).then((r) => r.json());
const m = await say(peggy, { text: 'gypsy jiggly query piggy: typography quipping' });
await say(pat, { text: 'replying, gauging the jig', reply_to: m.id });
await say(pat, { text: 'grouped: piggyback jogging' });
await say(peggy, { text: '**jiggy** *gyp* __pig__ ~~quip~~ `gyp jig` ||spy||\n> quoting a piggy\n- jig\n```\ngypsy query = jig;\n```' });
// A message meant for Pat (who looks at the page): its whole row is tinted.
await say(peggy, { text: 'hey @Pat, jiggy gyp query for you' });
// Files posted in chat: a file card (a name with tails) and a picture.
const posted = async (name, body) => { const r = await fetch(`${HUB}/api/channels/general/media?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie: peggy }, body }); if (!r.ok) throw new Error(`seeding ${name}: ${r.status}`); return (await r.json()).path; };
await say(peggy, { text: `jiggy gyp files #[${await posted('piggy jig gyp.litematic', 'schem')}] #${await posted('gyp.png', png(160, 90, [200, 120, 40]))}` });
// A mod release card: tags, a Note and a jar's Download.
await put('mods/client/piggy-jig-1.2.3.jar', 'jar');
await put('mods/mod info/Piggy Jig.md', '# Piggy Jig\n');
await say(pat, { text: '## Piggy Jig 1.2.3-gyp\n-# Client + Server · Required\n#mods/client/piggy-jig-1.2.3.jar\n- Gypsy jiggly query, quipping typography\n**Note:** jog the piggy `gyp` setting.' });
await fetch(`${HUB}/api/channels`, { method: 'POST', headers: { cookie: pat }, body: JSON.stringify({ name: 'piggy-jig' }) });
// jig-staff: a private chat (lock, privacy line), and a DM in the sidebar.
await fetch(`${HUB}/api/channels`, { method: 'POST', headers: { cookie: pat }, body: JSON.stringify({ name: 'jig-staff', kind: 'private', members: ['Peggy'] }) });
await fetch(`${HUB}/api/dms`, { method: 'POST', headers: { cookie: pat }, body: JSON.stringify({ members: ['Peggy'] }) });
// piggy-jig: a long chat with a NEW line part way down (read up to `readTo`, set in the view).
const sayIn = (body) => fetch(`${HUB}/api/channels/piggy-jig/messages`, { method: 'POST', headers: { cookie: peggy }, body: JSON.stringify(body) }).then((r) => r.json());
let readTo = '';
for (let i = 1; i <= 70; i++) {
  const r = await sayIn({ text: `jiggly gyp ${i}` });
  if (i === 3) readTo = r.id;
}

// /serverstatus: Survival reports (names with tails), Creative never does.
const serverToken = (name) => execFileSync(BIN, ['token', '-data', data, 'add', '-server', name]).toString().match(/mt_\S+/)[0];
const survival = serverToken('survival');
const creative = serverToken('creative');
const report = async (mspt) => { const r = await fetch(`${HUB}/api/server-status`, { method: 'POST', headers: { authorization: `Bearer ${survival}` },
  body: JSON.stringify({ players: ['Peggy_jig', 'gypsy_jay'], bots: 2, mspt, mspt_max: mspt * 4, mem_used: Math.round(9.4 * 2 ** 30), mem_max: 16 * 2 ** 30 }) }); if (!r.ok) throw new Error(`seeding status: ${r.status}`); };
await report(14);
// The server link: lines said in game (their tags), one typed here, and the note at the top.
const linkSay = async (tok, player, text) => { const r = await fetch(`${HUB}/api/server-link`, { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ player, text }) }); if (!r.ok) throw new Error(`seeding the link: ${r.status}`); };
await linkSay(survival, 'Peggy_jig', 'jiggy gyp query');
await linkSay(creative, 'gypsy_jay', 'piggy jig');
await fetch(`${HUB}/api/channels/text-link/messages`, { method: 'POST', headers: { cookie: peggy }, body: JSON.stringify({ text: 'gyp typed on the hub' }) });

// #voice-link: the bridge in it and Pat's player in the group in game (as LiveKit's signed
// webhooks would say), and Pat's Minecraft name, so his player's row has his lock.
const webhook = async (id, identity, event = 'participant_joined') => {
  const body = JSON.stringify({ id, event, room: { name: 'voice-link' }, participant: { identity, joinedAt: '1' } });
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const msg = enc({ alg: 'HS256', typ: 'JWT' }) + '.' + enc({ iss: 'k', exp: Math.floor(Date.now() / 1000) + 60, sha256: createHash('sha256').update(body).digest('base64') });
  const r = await fetch(`${HUB}/api/voice/webhook`, { method: 'POST', headers: { authorization: `Bearer ${msg}.${createHmac('sha256', 'check-secret-0123456789').update(msg).digest('base64url')}` }, body });
  if (!r.ok) throw new Error(`seeding #voice-link: ${r.status}`);
};
if (!(await fetch(`${HUB}/api/mc`, { method: 'POST', headers: { cookie: pat }, body: JSON.stringify({ mc: 'Pat_mc' }) })).ok) throw new Error('seeding the Minecraft name');
await webhook('w1', 'link:listener');
await webhook('w2', 'link:survival:Pat_mc');
const setLock = async (on) => { const r = await fetch(`${HUB}/api/voice/voice-link/lock`, { method: 'POST', headers: { cookie: pat }, body: JSON.stringify({ on }) }); if (!r.ok) throw new Error(`the lock: ${r.status}`); };

// Firefox: no extensions (their welcome tabs would cover the page), one tab, in front.
const prof = join(tmp, 'profile');
mkdirSync(prof);
const gfx = SOFTWARE ? ['gfx.webrender.software'] : ['gfx.webrender.all', 'gfx.x11-egl.force-enabled', 'widget.dmabuf.force-enabled'];
writeFileSync(join(prof, 'user.js'), [...gfx.map((k) => `user_pref("${k}", true);`),
  'user_pref("extensions.installDistroAddons", false);', 'user_pref("extensions.enabledScopes", 1);', 'user_pref("extensions.autoDisableScopes", 15);',
  'user_pref("startup.homepage_welcome_url", "");', 'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  // Fedora's Firefox opens start.fedoraproject.org and its first-run pages over the page.
  'user_pref("browser.startup.homepage", "about:blank");', 'user_pref("browser.startup.page", 0);', 'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);', 'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  // Voice settings asks for the microphone (to list devices), and a locked page holds one: no
  // prompt over the page, and Firefox's own fake microphone, never this PC's.
  'user_pref("media.navigator.permission.disabled", true);', 'user_pref("media.navigator.streams.fake", true);', 'user_pref("datareporting.policy.firstRunURL", "");'].join('\n'));
const bidi = await freePort();
// On Wayland the window's app id comes from MOZ_APP_REMOTINGNAME (Fedora's launcher sets
// org.mozilla.firefox unless it is given), not --class; KWin finds the window by its pid.
ff = spawn('firefox', ['--no-remote', '--profile', prof, `--remote-debugging-port=${bidi}`, '--class=MTHubCheck', '--width=1280', '--height=800'],
  { stdio: 'ignore', env: KWIN ? { ...process.env, MOZ_APP_REMOTINGNAME: 'MTHubCheck' } : X });
let ws;
for (let i = 0; i < 60 && !ws; i++) { await sleep(300); try { const w = new WebSocket(`ws://127.0.0.1:${bidi}/session`); await new Promise((ok, no) => { w.onopen = ok; w.onerror = no; }); ws = w; } catch {} }
if (!ws) throw new Error('Firefox did not start');
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); } };
const cmd = (method, params) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => (await cmd('script.evaluate', { expression: expr, target: { context: ctx }, awaitPromise: true })).result?.result?.value;
await cmd('session.new', { capabilities: {} });
// idle(ms) is the pause after a page load or an action: it returns once the page has nothing
// in progress (no request, live updates connected, fonts and pictures in, no animation,
// nothing changed for 300 ms), and after ms at the latest. The page keeps count for it.
// shown() waits for one thing and fails loudly without it: an unready page would look the
// same on screen and in the capture, and so pass.
await cmd('script.addPreloadScript', { functionDeclaration: `() => {
  const s = (window.__s = { f: 0, at: performance.now(), es: [] });
  const did = () => { s.at = performance.now(); };
  new MutationObserver(did).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  const f = window.fetch.bind(window);
  window.fetch = (...a) => { s.f++; const end = () => { s.f--; did(); }; return f(...a).then((r) => { end(); return r; }, (e) => { end(); throw e; }); };
  const ES = window.EventSource;
  window.EventSource = class extends ES { constructor(...a) { super(...a); s.es.push(this); } };
  // 'voice-link no microphone': the microphone refused.
  if (localStorage.getItem('check-gum-fail') === '1') navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
}` });
const BUSY = `(() => {
  const s = window.__s;
  if (!s || document.readyState !== 'complete') return 'the page loading';
  if (s.f) return 'a request';
  if (s.es.some((e) => e.readyState === 0)) return 'live updates connecting';
  if (document.fonts.status !== 'loaded') return 'fonts';
  if ([...document.images].some((i) => !i.complete && i.loading !== 'lazy')) return 'a picture';
  if (document.getAnimations().some((a) => a.playState === 'running' && isFinite(a.effect?.getComputedTiming().endTime))) return 'an animation';
  return performance.now() - s.at < 300 ? 'changes' : '';
})()`;
const full = {};
const idle = async (ms) => {
  let busy = 'time';
  for (const start = Date.now(); Date.now() - start < ms; await sleep(50)) {
    busy = await js(BUSY);
    if (busy === '' && Date.now() - start >= 300) return;
  }
  full[busy] = (full[busy] ?? 0) + 1;
};
let failed = 0;
const shown = async (name, what, expr) => {
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(50)) if (await js(expr)) return;
  console.log(`FAIL ${name}: ${what} didn’t appear`);
  failed++;
};
await sleep(1500);
const tabs = (await cmd('browsingContext.getTree', {})).result.contexts;
const ctx = tabs[0].context;
for (const t of tabs.slice(1)) await cmd('browsingContext.close', { context: t.context });
await cmd('storage.setCookie', { cookie: { name: 'mt_session', value: { type: 'string', value: pat.split('=')[1] }, domain: '127.0.0.1', path: '/' } });
// KWin (the check's own headless one, so nothing else is on it): a throwaway script focuses
// and sizes the window, found by Firefox's pid. It can't report back; the page's size says
// whether it worked.
const bus = (...a) => execFileSync('busctl', ['--user', 'call', ...a]).toString().trim();
const kwinScript = (body) => {
  const file = join(tmp, 'kwin.js');
  writeFileSync(file, `const all = workspace.windowList ? workspace.windowList() : workspace.windows;\nconst w = all.find((w) => w.pid === ${ff.pid} || w.resourceClass.toLowerCase() === 'mthubcheck');\nif (w) { ${body} }\n`);
  works('busctl', ['--user', 'call', 'org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', 'mthub-check']);
  const id = Number(bus('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', file, 'mthub-check').split(' ')[1]);
  if (!(id >= 0)) throw new Error(`KWin refused the script (${id})`);
  bus('org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run');
  bus('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', 'mthub-check');
};
const focus = async () => {
  if (!KWIN) return execFileSync('i3-msg', ['[class="MTHubCheck"] focus'], { env: X, stdio: 'ignore' });
  kwinScript('workspace.activeWindow = w;');
  await cmd('browsingContext.activate', { context: ctx });
};
if (KWIN) {
  kwinScript('w.frameGeometry = { x: 20, y: 20, width: 1280, height: 800 };');
  await focus();
  await sleep(600);
  const [iw, ih, dpr] = JSON.parse(await js('JSON.stringify([innerWidth, innerHeight, devicePixelRatio])'));
  if (dpr !== 1) throw new Error(`devicePixelRatio is ${dpr}: the screen and the capture would differ in scale`);
  if (iw < 1240 || iw > 1280 || ih < 600 || ih > 800) throw new Error(`the page is ${iw}×${ih}: KWin didn't size the window to 1280×800`);
  console.log(`window: page ${iw}×${ih}`);
} else execFileSync('i3-msg', ['[class="MTHubCheck"] floating enable, resize set 1280 800, move position 20 20, focus'], { env: X, stdio: 'ignore' });
await sleep(800);

// Each view: the screen and Firefox's capture, compared pixel by pixel.
const VIEWS = [['tree and chat', 'gyp'], ['file', 'boards/Playground juggling glyphs query.md'], ['folder', 'folder=screenshots'], ['schematics folder', 'folder=schematics'], ['new file tile', 'folder=boards'],
  ['schematics', 'schems'], ['picture', 'screenshots/2026-09-01 15.00.01 Peggy.png'], ['viewer', 'screenshots/2026-09-01 15.00.01 Peggy.png'],
  ['chat (main panel)', 'chan=general'], ['search', 'gyp'], ['mention popup', 'chan=general'], ['command popup', 'chan=general'], ['server status', 'chan=general'], ['emoji picker', 'chan=general'],
  ['new line and jump', 'chan=piggy-jig'], ['save to files', 'chan=general'], ['chat files', 'chan=general'], ['private chat', 'chan=jig-staff'], ['server link', 'chan=text-link'], ['delete question', 'gyp'], ['delete message question', 'chan=general'], ['rows selected', 'gyp'], ['rows cut', 'gyp'], ['trash', 'gyp'], ['tiles picked and the box', 'folder=screenshots'],
  ['minecraft name', 'gyp'], ['message edit', 'chan=general'], ['file tray', 'chan=general'], ['sending and failed', 'chan=general'], ['sound settings', 'gyp'], ['voice settings', 'gyp'], ['voice settings warned', 'gyp'], ['voice-link lock', 'gyp'], ['voice-link locked', 'gyp'], ['voice-link no microphone', 'gyp'], ['admin', 'gyp'], ['folder list', 'folder=screenshots']];
const unknown = (ONLY ?? []).filter((n) => !VIEWS.some(([v]) => v === n));
if (unknown.length) throw new Error(`no such view: ${unknown.join(', ')}`);
mkdirSync(OUT, { recursive: true });
const T = {}; let t0 = Date.now();
let uploadAt = ''; // where Upload Schematic is in schematics/ (the schematics view compares)
const lap = (k) => { const n = Date.now(); T[k] = (T[k] ?? 0) + n - t0; t0 = n; };
console.log(`TIMING startup ${Math.round(process.uptime() * 1000)} ms`);
for (const [name, hash] of VIEWS) {
  if (ONLY && !ONLY.includes(name)) continue;
  t0 = Date.now();
  if (name === 'folder list') await js(`localStorage.setItem('mt-folder-w', '110')`); // the Size slider all the way left (the last view)
  if (name === 'new line and jump') await js(`localStorage.setItem('mt-read', JSON.stringify({ 'piggy-jig': '${readTo}' }))`);
  if (name === 'voice-link lock' || name === 'voice-link locked') await setLock(name === 'voice-link locked');
  if (name === 'voice-link no microphone') await js(`localStorage.setItem('check-gum-fail', '1')`);
  // Voice settings off their defaults, as Simple Voice Chat warns in red: Gain: Manual at +12 dB,
  // Voice activation: Manual at 0 dB. Back to the defaults for the views after it.
  if (name === 'voice settings warned') await js(`localStorage.setItem('mt-voice-svc', '1'); localStorage.setItem('mt-voice', JSON.stringify({ agc: false, gainDb: 12, vad: false, thresholdDb: 0 }))`);
  if (name === 'voice-link lock') await js(`localStorage.removeItem('mt-voice')`);
  // A locked page takes the microphone by itself only in a focused window (as Firefox gives it
  // only then): focus it again, in case a click elsewhere took it during the check.
  if (name.startsWith('voice-link')) await focus();
  await cmd('browsingContext.navigate', { context: ctx, url: `${HUB}/?r=${Math.random()}#${encodeURI(hash)}`, wait: 'complete' });
  lap('load');
  await idle(1800);
  lap('wait after load');
  if (name === 'voice-link lock') await shown(name, 'the open lock on his player', `!!document.querySelector('#voice-list .voice-lock:not(.on)')`);
  if (name.startsWith('voice-link') && !(await js('document.hasFocus()'))) console.log(`(${name}: the page's window isn't focused)`);
  if (name === 'voice-link locked') await shown(name, 'the closed lock, holding the microphone', `!!document.querySelector('#voice-list .voice-lock.on:not(.lost)')`);
  if (name === 'voice-link no microphone') { // locked, the microphone refused, his player leaves the game: the take-over can't run
    await shown(name, 'the red lock', `!!document.querySelector('#voice-list .voice-lock.lost')`);
    await webhook('w3', 'link:survival:Pat_mc', 'participant_left');
    await shown(name, 'the voice bar saying so', `document.querySelector('#voice-bar .voice-bad')?.textContent === 'Couldn’t rejoin voice-link: microphone unavailable'`);
    await idle(600);
  }
  if (name === 'viewer') {
    await js(`document.querySelector('img[title="Click for full size"]').click()`);
    await shown(name, 'the viewer', `document.getElementById('viewer')?.hidden === false`);
    await idle(600);
  }
  if (name === 'search') {
    await js(`(() => { const b = document.getElementById('search'); b.focus(); b.value = 'juggling glyphs'; b.dispatchEvent(new Event('input')); })()`);
    await idle(1200);
  }
  if (name === 'mention popup') {
    await js(`(() => { const c = document.querySelector('#main-chat .compose'); c.focus(); c.value = 'hi @'; c.dispatchEvent(new Event('input')); })()`);
    await shown(name, 'the popup', `!!document.querySelector('.ac-pop')`);
    await idle(600);
  }
  if (name === 'command popup') {
    await js(`(() => { const c = document.querySelector('#main-chat .compose'); c.focus(); c.value = '/s'; c.dispatchEvent(new Event('input')); })()`);
    await shown(name, 'the popup', `!!document.querySelector('.ac-pop')`);
    await idle(600);
  }
  if (name === 'server status') { // the card, in both chats
    await report(22);
    await sleep(1100); // two reports, a moment apart
    await report(57);
    for (const pane of ['#main-chat', '#chat']) {
      await js(`(() => { const c = document.querySelector('${pane} .compose'); c.focus(); c.value = '/serverstatus'; c.dispatchEvent(new Event('input'));
        c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
      await idle(700);
    }
    if ((await js(`document.querySelectorAll('.msg.private .st-card').length`)) !== 2) { console.log('FAIL server status: the cards didn’t appear'); failed++; }
  }
  if (name === 'emoji picker') {
    await js(`document.querySelector('#main-chat .compose-row .smile').click()`);
    await shown(name, 'the picker', `document.querySelector('.emoji-pop .emoji-grid')?.children.length > 0`);
    await idle(1500);
  }
  if (name === 'delete question') {
    await js(`(() => { document.querySelector('#channels .row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }));
      [...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Delete').click(); })()`);
    await shown(name, 'the question', `!document.getElementById('overlay').hidden && !!document.querySelector('#dialog h2')`);
    await idle(800);
  }
  if (name === 'delete message question') {
    // A message with a picture: the question shows it as the chat draws it.
    await js(`[...document.querySelectorAll('#main-chat .msg')].find((m) => m.querySelector('.refs img') && m.querySelector('[data-tool="trash"]')).querySelector('[data-tool="trash"]').click()`);
    await shown(name, 'the message in the question', `!!document.querySelector('#dialog.ask .del-preview .msg-head .who')`);
    await idle(800);
  }
  if (name === 'rows cut') { // Ctrl+X on two rows: dimmed until pasted
    await js(`(() => { for (const r of [...document.querySelectorAll('#tree .row')].slice(3, 5)) r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      document.getElementById('tree').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true, cancelable: true })); })()`);
    await shown(name, 'the cut rows', `document.querySelectorAll('#tree .row.cut').length >= 1`);
    await idle(3500); // the "Cut 2 items" toast goes
  }
  if (name === 'rows selected') {
    // Rows picked with Ctrl+click (beside the open folder's own).
    await js(`(() => { for (const r of [...document.querySelectorAll('#tree .row')].slice(1, 6).filter((_, i) => i !== 1 && i !== 3)) r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); })()`);
    await shown(name, 'the selected rows', `document.querySelectorAll('#tree .row.selected').length >= 3`);
    await idle(800);
  }
  if (name === 'trash') {
    // A file moved to Trash with the Delete key (Ctrl+click picks it beside the open folder's
    // row, which the second Ctrl+click lets go), then the Trash opened from its row (the last
    // in the tree), once the "Moved … to Trash" toast has gone.
    await js(`(() => { const rows = [...document.querySelectorAll('#tree .row[data-path]')];
      for (const r of [rows.find((r) => r.dataset.path === 'gyp'), rows.find((r) => !r.classList.contains('dir'))]) r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      document.getElementById('tree').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); })()`);
    await shown(name, 'the Undo toast', `document.querySelector('#toast .toast-act')?.textContent === 'Undo'`);
    // The toast stays 6 s: wait for it to go (idle() can return long before).
    for (const end = Date.now() + 8000; Date.now() < end && !(await js(`document.getElementById('toast').hidden`)); ) await sleep(100);
    await js(`document.querySelector('#tree .row.trash-row').click()`);
    await shown(name, 'the Trash and its rows', `!document.getElementById('main-trash').hidden && document.querySelectorAll('#main-trash .trash-item').length >= 1 && document.getElementById('toast').hidden`);
    await idle(800);
  }
  if (name === 'tiles picked and the box') {
    // Two tiles picked with Ctrl+click, then a box dragged (Ctrl held, so they stay) from the
    // gap beside the first tile across the second, and left open.
    await js(`(() => { const t = [...document.querySelectorAll('#main-folder .shot[data-path]')];
      for (const el of [t[0], t[t.length - 1]]) el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      const a = t[1].getBoundingClientRect();
      const at = (type, x, y, on) => on.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: x, clientY: y }));
      at('mousedown', a.left - 6, a.top + 30, document.querySelector('#main-folder .shot-grid'));
      at('mousemove', a.left + a.width / 2, a.top + a.height / 2, document); })()`);
    await shown(name, 'the box and the picked tiles', `!!document.querySelector('#main-folder .pick-box') && document.querySelectorAll('#main-folder .shot.picked').length >= 2`);
    await idle(800);
  }
  if (name === 'minecraft name') {
    // An admin gives it, in Admin: the box typed in a person's row (the first row with a "⋯").
    await js(`(() => { document.getElementById('user').click();
      [...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Admin').click(); })()`);
    await shown(name, 'Admin', `document.querySelectorAll('.admin section').length > 0`);
    await js(`document.querySelector('.admin .icon-btn.more').click()`);
    await shown(name, 'the menu', `!document.getElementById('menu').hidden`);
    await js(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Minecraft Name…').click()`);
    await shown(name, 'the box', `!!document.querySelector('.admin .mc-form input')`);
    await js(`document.querySelector('.admin .mc-form input').value = 'Peggy_jig'`);
    await idle(600);
  }
  // The settings dialogs (style guide 6.8), from the menu on your name.
  const fromMenu = { 'sound settings': 'Sound Settings', 'voice settings': 'Voice Settings', 'voice settings warned': 'Voice Settings', admin: 'Admin' }[name];
  if (fromMenu) {
    await js(`(() => { document.getElementById('user').click();
      [...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === '${fromMenu}').click(); })()`);
    await shown(name, 'it', name === 'admin' ? `document.querySelectorAll('.admin section').length > 0` : `!document.getElementById('overlay').hidden && !!document.querySelector('#dialog h2')`);
    await idle(1000);
  }
  if (name === 'message edit') { // the hint with Enter and Esc in blurple
    // (↑ edits only from an empty box, and the mention popup view left a draft in it.)
    await js(`(() => { const c = document.querySelector('#main-chat .compose'); c.focus(); c.value = ''; c.dispatchEvent(new Event('input'));
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); })()`);
    await idle(600);
    if (!(await js(`!!document.querySelector('#main-chat .msg-edit .hint .key')`))) { console.log('FAIL message edit: the edit box didn’t open'); failed++; }
  }
  if (name === 'file tray') { // files waiting in the message box: a picture and a file
    await js(`(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const g = c.getContext('2d'); g.fillStyle = '#c87828'; g.fillRect(0, 0, 320, 180);
      const dt = new DataTransfer();
      dt.items.add(new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'jiggy gyp.png', { type: 'image/png' }));
      dt.items.add(new File(['schem'], 'piggy jig query.litematic', { type: 'application/octet-stream' }));
      document.querySelector('#main-chat .chat-body').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    await shown(name, 'the cards', `document.querySelectorAll('#main-chat .composer .pend').length === 2 && [...document.querySelectorAll('#main-chat .composer .pend-thumb img')].every((i) => i.complete && i.naturalWidth > 0)`);
    await idle(800);
  }
  if (name === 'sending and failed') { // one message the hub refused (red, Retry · Delete), one still on its way (greyed)
    await js(`(() => {
      const real = window.fetch; let n = 0;
      window.fetch = (u, o) => !(o?.method === 'POST' && /\\/messages$/.test(String(u))) ? real(u, o)
        : n++ ? new Promise(() => {}) : Promise.resolve(new Response(JSON.stringify({ error: 'jiggy gyp query' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
      const c = document.querySelector('#main-chat .compose');
      for (const text of ['piggy jig gyp, refused', 'gypsy query, on its way']) {
        c.focus(); c.value = text; c.dispatchEvent(new Event('input'));
        c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      }
    })()`);
    await shown(name, 'the two messages', `!!document.querySelector('#main-chat .msg.unsent.failed .send-failed') && document.querySelectorAll('#main-chat .msg.unsent').length === 2`);
    await idle(800);
  }
  if (name === 'save to files') {
    await js(`(() => { const m = [...document.querySelectorAll('#main-chat .msg')].find((e) => e.querySelector('.file-card'));
      m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }));
      [...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Save to Files…').click(); })()`);
    await shown(name, 'the question', `!document.getElementById('overlay').hidden && !!document.querySelector('#dialog h2')`);
    await idle(600);
  }
  // Upload Schematic is on the same spot in schematics/ and on the board, and Sort fits both its
  // texts (with Firefox's fonts: style.css adds the widths up).
  if (name === 'schematics folder' || name === 'schematics') {
    const at = await js(`(() => { const b = [...document.querySelectorAll('${name === 'schematics' ? '.schem-bar' : '#main-folder .shot-bar'} button')].find((b) => b.textContent === 'Upload Schematic');
      const r = b.getBoundingClientRect(); return Math.round(r.left * 2) / 2 + ',' + Math.round(r.right * 2) / 2; })()`);
    if (name === 'schematics folder') {
      uploadAt = at;
      const fits = await js(`(() => { const s = document.querySelector('#main-folder .sort'); const ok = s.scrollWidth <= s.clientWidth; s.textContent = 'sort:date'; const ok2 = s.scrollWidth <= s.clientWidth; s.textContent = 'sort:name'; return ok && ok2; })()`);
      if (!fits) { console.log('FAIL schematics folder: sort:name or sort:date doesn’t fit the Sort button'); failed++; }
    // (Run alone, the schematics view has no folder view to compare with.)
    } else if (uploadAt && at !== uploadAt) { console.log(`FAIL schematics: Upload Schematic is at ${at}, in the folder at ${uploadAt}`); failed++; }
  }
  if (name === 'folder list') await shown(name, 'the list', `document.querySelector('#main-folder .folder-grid').classList.contains('list')`);
  if (name === 'new file tile') { // the folder view's name box
    await js(`document.querySelector('#main-folder .vtool[title="New file"]').click()`);
    await shown(name, 'the name box', `!!document.querySelector('#main-folder input')`);
    await idle(600);
  }
  if (name === 'chat files') {
    await js(`document.querySelector('#main-chat .files-btn').click()`);
    await shown(name, 'the file list', `document.querySelectorAll('.pins-pop .file-item').length > 0`);
    await idle(1200);
  }
  lap('actions and their waits');
  // No blinking caret: blur, except where the popup needs the box focused (its caret is hidden).
  if (['mention popup', 'command popup', 'emoji picker', 'save to files', 'delete question', 'new file tile'].includes(name)) await js(`document.activeElement.style.caretColor = 'transparent'; document.fonts.ready.then(() => 1)`);
  else await js('document.activeElement?.blur(); document.fonts.ready.then(() => 1)');
  await cmd('browsingContext.activate', { context: ctx });
  lap('blur + activate');
  // A scroll position between pixels (the chat at the bottom can be at 254.85) is rounded one
  // way on screen and another in Firefox's capture, for part of the area: whole pixels only.
  await js(`for (const e of document.querySelectorAll('*')) if (e.scrollTop % 1) e.scrollTop = Math.floor(e.scrollTop)`);
  await sleep(900);
  lap('pause before screenshot');
  if (await js('document.visibilityState') !== 'visible') throw new Error(`${name}: the hub tab isn't the one on screen`);
  const [cx, cy, w, h] = JSON.parse(await js('JSON.stringify([mozInnerScreenX - screenX, mozInnerScreenY - screenY, innerWidth, innerHeight])'));
  // Native sliders are drawn by GTK, which places the thumb a few pixels differently in the
  // capture than on screen: not ours to fix, so they're left out of the comparison.
  const skip = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('input[type=range]')].filter((e) => e.checkVisibility()).map((e) => { const r = e.getBoundingClientRect(); return [Math.floor(r.left) - 2, Math.floor(r.top) - 2, Math.ceil(r.right) + 2, Math.ceil(r.bottom) + 2]; }))`));
  // Scrollbars, likewise: a thumb at a position between pixels is drawn crisp on screen and
  // half a pixel blurred in the capture (and an overlay one shows on screen for a moment
  // after the whole-pixel snap above). The 10 px down the right of each scrolling area.
  skip.push(...JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.checkVisibility()).map((e) => { const r = e.getBoundingClientRect(); return [Math.floor(r.right) - 10, Math.floor(r.top), Math.ceil(r.right), Math.ceil(r.bottom)]; }))`)));
  // KWin rounds the window's bottom corners: not the page's pixels.
  if (KWIN) skip.push([0, h - 8, 8, h], [w - 8, h - 8, w, h]);
  const slug = name.replace(/\W+/g, '-');
  const scr = join(OUT, `${slug}-screen.png`), cap = join(OUT, `${slug}-firefox.png`);
  if (KWIN) {
    // The active window (the only one) through KWin's screenshot interface, without frame or
    // shadow; the page is its bottom w × h. Any other size stops the check.
    const got = execFileSync('python3', ['-c', `
import os, sys, dbus
from PIL import Image
w,h,shift=map(int,sys.argv[2:5])
iface=dbus.Interface(dbus.SessionBus().get_object('org.kde.KWin','/org/kde/KWin/ScreenShot2'),'org.kde.KWin.ScreenShot2')
r,wfd=os.pipe(); fd=dbus.types.UnixFd(wfd); os.close(wfd)
at=iface.CaptureActiveWindow({'include-decoration':False,'include-shadow':False,'include-cursor':False,'native-resolution':True},fd)
W,H,stride=int(at['width']),int(at['height']),int(at['stride'])
if int(at['format']) not in (4,5,6): print('format', at['format']); sys.exit()
data=b''
with os.fdopen(r,'rb') as f:
    while len(data)<stride*H:
        c=f.read(stride*H-len(data))
        if not c: break
        data+=c
a=Image.frombuffer('RGBA',(W,H),data,'raw','BGRA',stride,1).convert('RGB')
ox=(W-w)//2; oy=H-h
if not (0<=W-w<=4 and 30<=oy<=250): print('bad', W, H); sys.exit()
a.crop((ox,oy-shift,ox+w,oy-shift+h)).save(sys.argv[1])
print('ok', W, H)`, scr, String(w), String(h), String(SHIFT)]).toString().trim().split(' ');
    if (got[0] !== 'ok') throw new Error(`${name}: KWin's grab of the active window is ${got.slice(1).join('×')}, not the check's (page ${w}×${h})`);
  } else {
    const tree = JSON.parse(execFileSync('i3-msg', ['-t', 'get_tree'], { env: X }).toString());
    const win = (function find(n) { return n.window_properties?.class === 'MTHubCheck' ? n : [...(n.nodes ?? []), ...(n.floating_nodes ?? [])].map(find).find(Boolean); })(tree);
    execFileSync('maim', ['--hidecursor', '-g', `${w}x${h}+${win.rect.x + cx}+${win.rect.y + cy}`, scr], { env: X });
  }
  const shot = await cmd('browsingContext.captureScreenshot', { context: ctx, clip: { type: 'box', x: 0, y: 0, width: w, height: h } });
  writeFileSync(cap, Buffer.from(shot.result.data, 'base64'));
  lap('screen grab + capture');
  const diff = execFileSync('python3', ['-c', `
import sys, json
from PIL import Image
a=Image.open(sys.argv[1]).convert('L'); b=Image.open(sys.argv[2]).convert('L')
w=min(a.width,b.width); h=min(a.height,b.height); pa=a.load(); pb=b.load()
skip=json.loads(sys.argv[3])
inskip=lambda x,y: any(l<=x<=r and t<=y<=b for l,t,r,b in skip)
bad=[(x,y) for y in range(h) for x in range(w) if abs(pa[x,y]-pb[x,y])>40 and not inskip(x,y)]
if bad:
    xs=[x for x,_ in bad]; ys=[y for _,y in bad]
    print(len(bad), min(xs), min(ys), max(xs), max(ys))
else:
    print(0)`, scr, cap, JSON.stringify(skip)]).toString().trim().split(' ').map(Number);
  lap('pixel compare');
  if (diff[0]) {
    failed++;
    console.log(`FAIL ${name}: ${diff[0]} pixels differ, in x ${diff[1]}-${diff[3]}, y ${diff[2]}-${diff[4]} (see ${slug}-screen.png vs ${slug}-firefox.png in test/firefox/out)`);
  } else console.log(`ok   ${name}${skip.length ? ` (${skip.length} area${skip.length > 1 ? 's' : ''} not compared: sliders, scrollbars${KWIN ? ', window corners' : ''})` : ''}`);
}
const ran = ONLY ? VIEWS.filter(([n]) => ONLY.includes(n)).length : VIEWS.length;
const desk = KWIN ? 'Wayland, in a headless KWin' : 'i3 on X11, on the screen';
console.log(failed ? `${failed} view(s) differ on screen (${desk})` : `all ${ran} views match on screen (${SOFTWARE ? 'software' : 'GPU'} rendering, ${desk})`);
console.log('TIMING ' + Object.entries(T).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(' | '));
if (Object.keys(full).length) console.log('TIMING waits that ran their full time, by what they waited for: ' + Object.entries(full).map(([k, n]) => `${k} ${n}`).join(', '));
process.exitCode = failed ? 1 : 0;
process.exit();
