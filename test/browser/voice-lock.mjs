// The lock in #voice-link, end to end (docs/voice/svc/lock-spec.md): a local LiveKit, the real
// relay and bridge, and a stand-in game server speaking the relay's protocol, as in
// voice-link.mjs. Paul (Minecraft name PaulMC) on the page: the lock on his own row only, on by
// itself when he joins by hand; the game server's question cuts his page before his player is
// put in the group (macrotech-ops tech-notes/voice-link-handover-spec.md), quietly, the lock
// kept; a cut with no player after it takes over once and the lock goes; a join by hand in game
// cuts an unlocked page; the hub refuses a join while his player is in; locked,
// his page hangs up when his player appears in game and joins again by itself when it goes,
// on the microphone it held, asking for no new one; no Join while his player is in game; the
// game server's report means no take-over; a page loaded with the player gone does not join;
// a page that has lost the microphone says so; two tabs, one joins; Leave and unlocking let
// the microphone go. Chromium's fake microphone, not a real one, and Chromium, not Firefox
// (Firefox's rule that makes the page hold the microphone was tested on Paul's own Firefox:
// the spec's Step 0).
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { api, check, COOKIE, DATA, done, HUB, send, settle, shot, ws } from './lib.mjs';
import { ensureLivekit } from './support/livekit.mjs';

const root = join(import.meta.dirname, '..', '..');
const LK = ensureLivekit();
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const [port, tcp, relayPort] = [await freePort(), await freePort(), await freePort()];
const udp = 52900 + Math.floor(Math.random() * 300);
const SECRET = 'test-secret-that-is-long-enough-0123456789';
const TOKENS = { game: 'game-token-0123456789abcdef0123456789abcdef', hub: 'hub-token-0123456789abcdef0123456789abcdef0' };
writeFileSync(join(DATA, 'livekit.yaml'), `port: ${port}
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: ${tcp}
  port_range_start: ${udp}
  port_range_end: ${udp + 100}
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  mthub: ${SECRET}
webhook:
  api_key: mthub
  urls: ["${HUB}/api/voice/webhook"]
`);
writeFileSync(join(DATA, 'voicelink.json'), JSON.stringify({ tokens: { [TOKENS.game]: 'survival', [TOKENS.hub]: 'hub' } }));
writeFileSync(join(DATA, 'voicebridge.json'), JSON.stringify({ relay: `ws://127.0.0.1:${relayPort}/voicelink`, token: TOKENS.hub, livekit: `ws://127.0.0.1:${port}`, key: 'mthub', secret: SECRET, room: 'voice-link' }));
for (const p of ['voicelink', 'voicebridge']) execFileSync('go', ['build', '-o', join(DATA, p), `./cmd/${p}`], { cwd: root, stdio: 'inherit' });
const kids = [];
process.on('exit', () => kids.forEach((k) => k.kill('SIGKILL')));
const run = (cmd, args) => { const p = spawn(cmd, args, { stdio: 'ignore' }); kids.push(p); return p; };
run(LK, ['--config', join(DATA, 'livekit.yaml')]);
run(join(DATA, 'voicelink'), ['-addr', `127.0.0.1:${relayPort}`, '-config', join(DATA, 'voicelink.json')]);
for (let i = 0; i < 50; i++) {
  await settle(100);
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
}
writeFileSync(join(DATA, 'voice.json'), JSON.stringify({ url: `ws://127.0.0.1:${port}`, api: `http://127.0.0.1:${port}`, key: 'mthub', secret: SECRET, link_voice: true }));
run(join(DATA, 'voicebridge'), ['-config', join(DATA, 'voicebridge.json')]);
// The game server's own hub token, for its report.
const serverToken = execFileSync(process.env.MTHUB_BIN, ['token', '-data', DATA, 'add', '-server', 'survival'], { encoding: 'utf8' }).trim().split('\n')[0].trim();

// wait is real time: settle() ends early once the page is idle, and some checks are about time
// passing (still listed 3 s later).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (await fn()) return true;
  console.log(`(timed out waiting for ${what})`);
  return false;
};
const ev = async (expression, s = send) => (await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }))?.result?.value;

// The stand-in game server: the hub's roster as it arrives (names, and any member with a "lock",
// which must be none: the lock is in no roster), its own roster, PaulMC's player in the group or
// not, and asking the hub who of its players is locked, as MT Utils 2.5.2 does.
const PAUL_UUID = '4f1c2a7e-9b3d-4e8a-a1b2-c3d4e5f60718';
const game = { hub: null, locked: null, ws: new WebSocket(`ws://127.0.0.1:${relayPort}/voicelink`, { headers: { Authorization: `Bearer ${TOKENS.game}` } }) };
game.ws.binaryType = 'arraybuffer';
await new Promise((ok, no) => { game.ws.onopen = ok; game.ws.onerror = () => no(new Error('the stand-in game server could not reach the relay')); });
game.ws.onmessage = (e) => {
  const b = new Uint8Array(e.data);
  if (b[0] !== 2) return;
  const from = new TextDecoder().decode(b.subarray(2, 2 + b[1]));
  if (from !== 'hub') return;
  const m = JSON.parse(new TextDecoder().decode(b.subarray(2 + b[1]))).members;
  game.hub = m.map((x) => x.name);
  game.locked = m.filter((x) => 'lock' in x).map((x) => x.name);
};
const inGame = (yes) => game.ws.send(new TextEncoder().encode('\x02' + JSON.stringify({ members: yes ? [{ uuid: PAUL_UUID, name: 'PaulMC' }] : [] })));
const askLocked = async () => (await (await fetch(`${HUB}/api/voice-link/locked`, { method: 'POST', headers: { Authorization: `Bearer ${serverToken}` }, body: JSON.stringify({ players: ['PaulMC'] }) })).json()).locked;

// Paul's Minecraft name (an admin sets it; Paul is one). Every page counts its microphone
// requests and keeps the tracks it got; one may be made to wait, as Firefox makes a page you
// aren't looking at wait.
check('Paul gets a Minecraft name', (await api('POST', '/api/mc', { mc: 'PaulMC' }, 'Paul')).status, 200);
const GUM = `(() => {
  const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__gum = { n: 0, tracks: [] };
  navigator.mediaDevices.getUserMedia = async (c) => {
    window.__gum.n++;
    if (sessionStorage.getItem('gum-wait') === '1') await new Promise((r) => (window.__gumGo = r));
    if (sessionStorage.getItem('gum-fail') === '1') {
      sessionStorage.removeItem('gum-fail');
      throw new DOMException('Permission denied', 'NotAllowedError');
    }
    const s = await g(c);
    window.__gum.tracks.push(...s.getAudioTracks());
    return s;
  };
})()`;
// Chromium's autoplay rule, forced (the suite runs with the rule off): while 'ctx-block' is set,
// every AudioContext says suspended and its resume() never answers, until a real (trusted)
// click or key. A stand-in for a page with no click since it loaded.
const CTX = `(() => {
  const state = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state').get;
  const resume = AudioContext.prototype.resume;
  const seen = new Set();
  const blocked = () => sessionStorage.getItem('ctx-block') === '1';
  // 'ctx-slow': a new context says suspended for its first 300 ms, as Firefox's does on every join.
  const slow = new WeakMap();
  Object.defineProperty(BaseAudioContext.prototype, 'state', { get() { return blocked() || (slow.get(this) ?? 0) > performance.now() ? 'suspended' : state.call(this); } });
  AudioContext.prototype.resume = function () {
    seen.add(this);
    if (sessionStorage.getItem('ctx-slow') === '1' && !slow.has(this)) {
      slow.set(this, performance.now() + 300);
      setTimeout(() => this.dispatchEvent(new Event('statechange')), 320);
    }
    return blocked() ? new Promise(() => {}) : resume.call(this);
  };
  for (const e of ['pointerdown', 'keydown']) window.addEventListener(e, (ev) => {
    if (!ev.isTrusted || !blocked()) return;
    sessionStorage.removeItem('ctx-block');
    for (const c of seen) c.dispatchEvent(new Event('statechange'));
  }, true);
})()`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: GUM });
await send('Page.addScriptToEvaluateOnNewDocument', { source: CTX });
// A cut with no player after it waits 15 s before the page takes over; 11 s here (just past the
// hub's 10 s, while a join would still be refused).
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__handoverWait = 11000' });
await send('Page.navigate', { url: HUB });
await until('the page', () => ev(`!!document.getElementById('channels').children.length`));
await until('the bridge in #voice-link', async () => !(await ev(`!!document.querySelector('#voice-list .voice-note')`)), 20000);

const rows = (s) => ev(`[...document.querySelectorAll('#voice-list > *')].filter((r) => !r.classList.contains('voice-note')).map((r) => (r.classList.contains('link') ? '#' : '  ') + r.querySelector('.name').textContent + (r.querySelector('.tag.via') ? ' [' + r.querySelector('.tag.via').textContent + ']' : '') + (r.classList.contains('here') ? '*' : '') + (r.querySelector('.voice-lock') ? ' ' + (r.querySelector('.voice-lock.lost') ? '(lock lost)' : r.querySelector('.voice-lock.on') ? '(locked)' : '(lock)') : ''))`, s);
const inVoice = (s) => ev(`!document.getElementById('voice-bar').hidden && !!document.querySelector('#voice-bar .voice-buttons')`, s); // (the bar also shows, alone, a take-over that couldn't run)
const gum = (s) => ev(`({ n: window.__gum.n, tracks: window.__gum.tracks.map((t) => t.readyState === 'ended' ? 'ended' : t.readyState + (t.enabled ? '' : '/off')) })`, s);
const lockTitle = () => ev(`document.querySelector('#voice-list .voice-lock')?.title`);
const clickLock = () => ev(`document.querySelector('#voice-list .voice-lock').click()`);
const apiLock = async (who) => (await (await api('GET', '/api/voice', undefined, who)).json()).chats.find((c) => c.link).lock ?? false;

// Not in voice-link: no row of his, no lock anywhere.
check('not in voice-link: no lock', await rows(), ['#voice-link']);

// Paul joins: the lock on his row, on by itself (joining by hand); his player isn't anywhere
// yet. (His browser's sound takes 300 ms to start, as Firefox's does: the bar never asks for a
// click for that.)
await ev(`sessionStorage.setItem('ctx-slow', '1'); window.__bar = []; new MutationObserver(() => window.__bar.push(document.getElementById('voice-bar').textContent)).observe(document.getElementById('voice-bar'), { childList: true, subtree: true, characterData: true })`);
await ev(`document.querySelector('#voice-list .row.voice.link').click()`);
await until('Paul in the voice chat', () => inVoice(), 20000);
await wait(1500);
check('sound starting a moment late: the bar never asked for a click', await ev(`[window.__bar.some((t) => t.includes('Click to turn on')), document.querySelector('#voice-bar .voice-ok')?.textContent]`), [false, 'Voice connected']);
await ev(`sessionStorage.removeItem('ctx-slow')`);
await until('Paul listed, locked', async () => (await rows()).includes('  Paul* (locked)'));
check('joined by hand: the lock on by itself, closed, with its hint', [await rows(), await lockTitle()], [['#voice-link*', '  Paul* (locked)'], 'Staying in voice-link when you leave the game. Click to stop']);
check('GET /api/voice says so to Paul and to nobody else', [await apiLock('Paul'), await apiLock('Alex')], [true, false]);
const joinedWith = await gum();
check('joining asked for the microphone once, and the lock holds that one', joinedWith, { n: 1, tracks: ['live'] });
await until('the hub\'s roster', async () => game.hub?.includes('Paul'));
check('the roster carries no lock', [game.hub, game.locked], [['Paul'], []]);
await shot('locked');

// Hub to game: the game server asks who is locked before it puts him in the group, and the hub
// cuts his page first. The page hangs up quietly (no "admin" toast) without leaving: still
// locked, the microphone held but quiet. Then his player appears: the lock on his player's
// row, no Join.
await ev(`document.getElementById('toast').hidden = true`);
const t1 = Date.now();
check('the game server\'s question names him, once his page is cut', await askLocked(), ['PaulMC']);
await until('the page cut', async () => !(await inVoice()), 20000);
const stepBackMs = Date.now() - t1;
await until('Paul gone from the room', async () => !(await rows()).some((r) => /^  Paul\*? \(/.test(r)), 15000);
check('cut for the game: no toast, still locked, the microphone held and quiet', [await ev(`document.getElementById('toast').hidden`), await apiLock('Paul'), await gum()], [true, true, { n: 1, tracks: ['live/off'] }]);
const forced = await api('POST', '/api/voice/voice-link/join', {}, 'Paul');
check('going into the game: the hub has nothing to join', [forced.status, (await forced.json()).error], [409, 'Your player is in voice-link in Minecraft.']);
inGame(true);
await until('his player listed', async () => (await rows()).includes('  Paul [SMP] (locked)'), 15000);
check('his player in game: his player listed with his lock', await rows(), ['#voice-link', '  Paul [SMP] (locked)']);
// On the hub, hub names: his player shows as Paul; the hover names the player in game. And the
// lock on reads as on: light blurple on its blurple chip.
check('his player under his hub name, the game name in the hover', await ev(`document.querySelector('#voice-list .row.voice.in-link').title`), 'PaulMC is in the voice-link group in game');
check('the lock on: light blurple on a chip', await ev(`(() => { const b = document.querySelector('#voice-list .voice-lock.on'); const c = getComputedStyle(b); return [c.color, c.backgroundColor, c.opacity]; })()`), ['rgb(201, 205, 251)', 'rgba(88, 101, 242, 0.25)', '1']);
check('still locked', await apiLock('Paul'), true);
check('the microphone held, quiet, and no new one asked for', await gum(), { n: 1, tracks: ['live/off'] });
await ev(`document.querySelector('#voice-list .row.voice.link').click(); document.querySelector('#voice-list .row.voice.in-link').click()`);
await settle(1500);
check('no Join while his player is in game (clicking the rows does nothing)', await inVoice(), false);
await ev(`(() => { const r = document.querySelector('#voice-list .row.voice.link'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`);
await settle(200);
check('and no menu with Join', await ev(`document.getElementById('menu').hidden || ![...document.getElementById('menu').children].some((c) => c.textContent === 'Join')`), true);
await ev(`document.getElementById('menu').hidden = true`);
await shot('in-game');

// Game to hub: his player goes. The page joins by itself, on the held microphone. (With
// Chromium's autoplay rule forced: no click on the page since... the bar asks for one.)
await ev(`sessionStorage.setItem('ctx-block', '1')`);
const t2 = Date.now();
inGame(false);
await until('the page took over', () => inVoice(), 20000);
const takeOverMs = Date.now() - t2;
await until('Paul back in the room', async () => (await rows()).includes('  Paul* (locked)'), 15000);
check('his player gone: the page joined by itself, still locked', await rows(), ['#voice-link*', '  Paul* (locked)']);
check('on the held microphone, asking for no new one', await gum(), { n: 1, tracks: ['live'] });
const barText = () => ev(`document.querySelector('#voice-bar .voice-where > span')?.textContent`);
await until('the bar asking for a click', async () => (await barText()) === 'Click to turn on sound and your mic', 5000);
check('sound blocked (forced, a stand-in for Chromium\'s rule): the bar asks for a click', await barText(), 'Click to turn on sound and your mic');
await shot('blocked');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 300, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 600, y: 300, button: 'left', clickCount: 1 });
await until('the bar back to normal', async () => (await barText()) === 'Voice connected', 5000);
check('one click anywhere: sound on, the bar back to normal', [await barText(), await ev(`sessionStorage.getItem('ctx-block')`)], ['Voice connected', null]);
console.log(`  (hand-over in the test: stepped back ${stepBackMs} ms after the game's roster, took over ${takeOverMs} ms after)`);

// The game server's report (he left the group on purpose): the lock goes off before his player
// leaves the roster, so the page does not take over.
inGame(true);
await until('stepped back again', async () => !(await inVoice()), 20000);
const r = await fetch(`${HUB}/api/voice-link/left`, { method: 'POST', headers: { Authorization: `Bearer ${serverToken}` }, body: JSON.stringify({ player: 'paulmc' }) });
check('the server reports the leave', r.status, 204);
await until('the lock off on the page', async () => (await rows()).includes('  Paul [SMP] (lock)'));
const t3 = Date.now();
inGame(false);
if (!(await until('his player gone', async () => !(await rows()).some((x) => x.startsWith('  Paul [SMP]')), 15000))) {
  console.log('  (the hub still lists: ' + JSON.stringify((await (await api('GET', '/api/voice', undefined, 'Paul')).json()).chats.find((c) => c.link).people) + ')');
}
console.log(`  (his player left the list ${Date.now() - t3} ms after the game's roster)`);
await settle(2000);
check('after the report: no take-over, and the held microphone let go', [await inVoice(), await rows(), (await gum()).tracks], [false, ['#voice-link'], ['ended']]);

// A page loaded while locked, his player already gone (it never saw it leave): it doesn't join.
// Its first microphone request waits (as Firefox makes a page in the background wait): the lock
// says the page can't take over; once answered, it can.
await ev(`document.querySelector('#voice-list .row.voice.link').click()`);
await until('Paul in again', () => inVoice(), 20000);
await until('his row, locked by the join', async () => (await rows()).includes('  Paul* (locked)'));
await until('locked again', async () => apiLock('Paul'));
await ev(`sessionStorage.setItem('gum-wait', '1')`);
await send('Page.reload');
await until('the page again', () => ev(`!!document.getElementById('channels')?.children.length`));
await until('the page asking', async () => (await gum()).n === 1, 10000);
await settle(3000);
check('a page loaded with the player gone does not join', await inVoice(), false);
check('its microphone not yet given: the lock says it can’t take over', [await rows(), await lockTitle()], [['#voice-link'], undefined]);
// (Paul's row is gone: LiveKit dropped the old page. Bring the player in to see the lock.)
inGame(true);
await until('his player listed', async () => (await rows()).some((x) => x.startsWith('  Paul [SMP]')), 15000);
check('the lock on his player shows it can’t take over', [await rows(), await lockTitle()], [['#voice-link', '  Paul [SMP] (lock lost)'], 'Click here to stay in voice-link when you leave the game']);
await shot('lost');
await ev(`sessionStorage.removeItem('gum-wait'); window.__gumGo()`);
await until('the microphone held', async () => (await rows()).includes('  Paul [SMP] (locked)'));
check('answered: locked, holding it', [await rows(), (await gum()).tracks], [['#voice-link', '  Paul [SMP] (locked)'], ['live/off']]);

// A page loaded while locked whose microphone request is refused asks again only when you click
// the lock or look at the page again, not on every change to the list. (His player comes and
// goes meanwhile: with no microphone the page can't take over, and the bar says so.)
await ev(`sessionStorage.setItem('gum-fail', '1')`);
await send('Page.reload');
await until('the page again', () => ev(`!!document.getElementById('channels')?.children.length`));
await until('the page asking', async () => (await gum()).n === 1, 10000);
await until('his player listed', async () => (await rows()).some((x) => x.startsWith('  Paul [SMP]')), 15000);
inGame(false);
await until('his player gone', async () => !(await rows()).some((x) => x.startsWith('  Paul [SMP]')), 15000);
inGame(true);
await until('his player back', async () => (await rows()).some((x) => x.startsWith('  Paul [SMP]')), 15000);
await wait(2000);
check('refused: not asked again as the list changed, the lock red', [(await gum()).n, await rows()], [1, ['#voice-link', '  Paul [SMP] (lock lost)']]);
inGame(false);
await until('the take-over that can\'t run says so', async () => (await barText()) === 'Couldn’t rejoin voice-link: microphone unavailable', 10000);
check('no microphone: the take-over says it can\'t', [await inVoice(), await barText()], [false, 'Couldn’t rejoin voice-link: microphone unavailable']);
await ev(`window.dispatchEvent(new Event('focus'))`);
await until('asked again on a look, and holding it', async () => (await gum()).tracks.length === 1, 5000);
check('looking at the page again asks again, and holds it', [(await gum()).n, (await gum()).tracks], [2, ['live/off']]);
inGame(true);
await until('his player listed', async () => (await rows()).includes('  Paul [SMP] (locked)'), 15000);

// Two tabs, both holding the microphone: his player goes, one tab joins.
const cdp = new URL(ws.url).host;
const bws = new WebSocket((await (await fetch(`http://${cdp}/json/version`)).json()).webSocketDebuggerUrl);
await new Promise((r) => bws.addEventListener('open', r));
let sid = 0;
const pending = new Map();
bws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
process.on('exit', () => bws.close());
const raw = (method, params = {}, sessionId) => new Promise((ok) => { const id = ++sid; pending.set(id, ok); bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { targetId } = await raw('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
const tab2 = (m, p) => raw(m, p, sessionId);
await tab2('Page.addScriptToEvaluateOnNewDocument', { source: GUM });
await tab2('Page.navigate', { url: HUB });
await until('the second tab', () => ev(`!!document.getElementById('channels')?.children.length`, tab2));
await until('the second tab holds the microphone', async () => (await rows(tab2)).includes('  Paul [SMP] (locked)'), 15000);
inGame(false);
await until('a tab joined', async () => (await inVoice()) || (await inVoice(tab2)), 20000);
await settle(4000);
check('two tabs: one joined', [await inVoice(), await inVoice(tab2)].filter(Boolean).length, 1);
// The other tab joins too: LiveKit drops the first (one account, one session). That is not
// Leave: the lock stays, and the second stays listed.
const [first, second] = (await inVoice()) ? [send, tab2] : [tab2, send];
await ev(`document.querySelector('#voice-list .row.voice.link').click()`, second);
await until('the second tab in', () => inVoice(second), 20000);
await until('the first tab out', async () => !(await inVoice(first)), 10000);
await wait(3000);
const listed = (await (await api('GET', '/api/voice', undefined, 'Paul')).json()).chats.find((c) => c.link).people.some((p) => p.name === 'Paul');
check('joined elsewhere: still locked, the second tab listed 3 s later, the first not in voice', [await apiLock('Paul'), listed, await inVoice(second), await inVoice(first)], [true, true, true, false]);
await raw('Target.closeTarget', { targetId });
await until('the remaining page in voice-link', async () => { if (!(await inVoice())) await ev(`document.querySelector('#voice-list .row.voice.link').click()`); return inVoice(); }, 20000);

// Unlocking in the voice chat keeps the microphone in use; Leave then lets it go.
await until('his row', async () => (await rows()).includes('  Paul* (locked)'));
await clickLock();
await until('unlocked', async () => (await rows()).includes('  Paul* (lock)'));
check('unlocked: GET /api/voice and the hub\'s answer agree; the roster carries no lock', [await apiLock('Paul'), await askLocked(), game.locked], [false, [], []]);
check('the microphone still in use by the voice chat', (await gum()).tracks.at(-1), 'live');
await clickLock();
await until('locked', async () => apiLock('Paul'));
await ev(`[...document.querySelectorAll('#voice-bar button')].at(-1).click()`);
await until('Paul out', async () => !(await inVoice()));
await settle(1000);
check('Leave takes the lock off and lets the microphone go', [await apiLock('Paul'), (await gum()).tracks.filter((t) => t !== 'ended')], [false, []]);

// Locked and stepped back for the game, he starts another voice chat: the lock goes (joining
// another voice chat), and the new voice chat has a live microphone of its own.
await ev(`document.querySelector('#voice-list .row.voice.link').click()`);
await until('Paul in again', () => inVoice(), 20000);
await until('his row, locked by the join', async () => (await rows()).includes('  Paul* (locked)'));
await until('locked', async () => apiLock('Paul'));
inGame(true);
await until('stepped back', async () => !(await inVoice()), 20000);
const before = (await gum()).n;
await ev(`document.getElementById('new-voice').click()`);
await ev(`[...document.querySelectorAll('#menu > *')].find((m) => m.textContent.startsWith('New Voice Chat')).click()`);
await until('in the new voice chat', () => inVoice(), 20000);
await wait(3000);
const mic = await gum();
check('another voice chat while stepped back: a microphone of its own, live 3 s later; the lock off', [mic.n - before, mic.tracks.at(-1), await inVoice(), await apiLock('Paul')], [1, 'live', true, false]);
await ev(`[...document.querySelectorAll('#voice-bar button')].at(-1).click()`);
await until('Paul out', async () => !(await inVoice()));
inGame(false);
// (While his player is listed in game there is nothing to join.)
await until('his player gone', async () => !(await rows()).some((x) => x.startsWith('  Paul [SMP]')), 15000);

// A tab opened in the background while locked asks for no microphone until it is looked at.
await ev(`document.querySelector('#voice-list .row.voice.link').click()`);
await until('Paul in again', () => inVoice(), 20000);
await until('his row, locked by the join', async () => (await rows()).includes('  Paul* (locked)'));
await until('locked', async () => apiLock('Paul'));
const bg = await raw('Target.createTarget', { url: 'about:blank', background: true });
const bgs = (await raw('Target.attachToTarget', { targetId: bg.targetId, flatten: true })).sessionId;
const tab3 = (m, p) => raw(m, p, bgs);
await tab3('Page.enable');
await tab3('Page.addScriptToEvaluateOnNewDocument', { source: GUM });
await tab3('Page.navigate', { url: HUB });
await until('the background tab', () => ev(`!!document.getElementById('channels')?.children.length`, tab3));
await wait(2000);
check('a tab in the background: hidden, and no microphone asked for', [await ev(`document.visibilityState`, tab3), await ev(`window.__gum?.n ?? 'no counter'`, tab3)], ['hidden', 0]);
await raw('Target.activateTarget', { targetId: bg.targetId });
await until('the background tab holding it once looked at', async () => (await gum(tab3))?.tracks.length === 1, 10000);
check('looked at: it asks, and holds it', (await gum(tab3)).tracks, ['live/off']);
await raw('Target.closeTarget', { targetId: bg.targetId });
await ev(`[...document.querySelectorAll('#voice-bar button')].at(-1).click()`);

// A cut with no player after it (the put failed, the game never got that far): the page takes
// over once, after 15 s (11 s here), and the lock goes off, so it can't go back and forth.
await until('Paul out', async () => !(await inVoice()));
await ev(`document.querySelector('#voice-list .row.voice.link').click()`);
await until('Paul in, locked', async () => (await rows()).includes('  Paul* (locked)'), 20000);
check('the question cuts him', await askLocked(), ['PaulMC']);
await until('the page cut', async () => !(await inVoice()), 10000);
await until('the page back by itself', () => inVoice(), 20000);
await until('the lock off', async () => !(await apiLock('Paul')), 5000);
check('no player after the cut: the page took over once, and the lock is off', [await inVoice(), await apiLock('Paul'), await askLocked()], [true, false, []]);

// Not locked, he joins the group by hand in game: the server holds the join and asks the hub,
// which cuts his page first; the page says where he is (no "admin" toast).
await ev(`document.getElementById('toast').hidden = true`);
const hand = await fetch(`${HUB}/api/voice-link/joining`, { method: 'POST', headers: { Authorization: `Bearer ${serverToken}` }, body: JSON.stringify({ player: 'PaulMC' }) });
check('the server asks before a join by hand', hand.status, 204);
await until('the page cut', async () => !(await inVoice()), 10000);
await until('the toast', async () => (await ev(`document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`)) !== '', 5000);
check('cut for a join by hand: the page says where he is, no lock', [await ev(`document.getElementById('toast').textContent`), await apiLock('Paul')], ['You’re in voice-link in Minecraft.', false]);
inGame(true);
await until('his player listed', async () => (await rows()).includes('  Paul [SMP] (lock)'), 15000);
await ev(`document.querySelector('#voice-list .row.voice.link').click()`);
await settle(1500);
check('his player in game, not locked: no Join either', await inVoice(), false);
inGame(false);

await done();
