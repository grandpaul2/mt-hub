// Screen sharing, end to end: a local LiveKit (fetched/livekit-server, as in the voice suite),
// Paul in the suite's page and Alex in a second browser profile. Chromium's fake screen
// capture stands in for a real window. Sharing from the "+" menu, LIVE appearing for the
// other person, watching (the picture arrives), the viewer count, watching your own stream,
// Stop, an admin stopping someone, the streamer reloading, and a phone watching.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { api, check, COOKIE, DATA, done, HUB, send, settle, shot, ws } from './lib.mjs';
import { ensureLivekit } from './support/livekit.mjs';

const LK = ensureLivekit();
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const port = await freePort();
const tcp = await freePort();
const udp = 52200 + Math.floor(Math.random() * 500); // apart from the voice suite's, which may run alongside
const SECRET = 'test-secret-that-is-long-enough-0123456789';
const conf = join(DATA, 'livekit.yaml');
writeFileSync(conf, `port: ${port}
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
room:
  empty_timeout: 5
  departure_timeout: 2
`);
const lk = spawn(LK, ['--config', conf], { stdio: 'ignore' });
process.on('exit', () => lk.kill());
for (let i = 0; i < 50; i++) {
  await settle(100);
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
}
writeFileSync(join(DATA, 'voice.json'), JSON.stringify({ url: `ws://127.0.0.1:${port}`, api: `http://127.0.0.1:${port}`, key: 'mthub', secret: SECRET }));

const until = async (what, fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await settle(150)) if (await fn()) return true;
  console.log(`(timed out waiting for ${what})`);
  return false;
};

// Paul's page; evaluations count as a click (getDisplayMedia needs one).
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }))?.result?.value;

// Alex: a second browser profile with its own cookies (as in the voice suite).
const cdp = new URL(ws.url).host;
const bws = new WebSocket((await (await fetch(`http://${cdp}/json/version`)).json()).webSocketDebuggerUrl);
await new Promise((r) => bws.addEventListener('open', r));
let sid = 0;
const pending = new Map();
bws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
process.on('exit', () => bws.close());
const raw = (method, params = {}, sessionId) => new Promise((r) => { const id = ++sid; pending.set(id, r); bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { browserContextId } = await raw('Target.createBrowserContext');
const { targetId } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
const alex = {
  send: (m, p) => raw(m, p, sessionId),
  ev: async (expression) => (await raw('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId))?.result?.value,
};
await alex.send('Network.enable');
await alex.send('Network.setCookie', { name: 'mt_session', value: COOKIE.Alex.split('=')[1], url: HUB });

await send('Page.navigate', { url: HUB });
await alex.send('Page.navigate', { url: HUB });
await until('both pages', async () => (await ev(`!!document.getElementById('channels').children.length`)) && (await alex.ev(`!!document.getElementById('channels').children.length`)));
await settle(500);

const live = (evaluate) => evaluate(`(() => { const rows = [...document.querySelectorAll('#live-list .row.live')].map((r) => r.dataset.who + (r.classList.contains('here') ? '*' : '')); return rows.length ? rows : null; })()`);
const shareBar = (evaluate) => evaluate(`document.getElementById('share-bar').hidden ? null : document.querySelector('#share-bar .muted').textContent`);
const panel = (evaluate) => evaluate(`document.getElementById('main-live').hidden ? null : { title: document.querySelector('.live-title').textContent, count: document.querySelector('.live-count').textContent, note: document.querySelector('.live-note').hidden ? '' : document.querySelector('.live-note').firstChild?.textContent ?? '' }`);
const picture = (evaluate) => evaluate(`(() => { const v = document.querySelector('#main-live video'); return !!v && v.videoWidth > 0 && v.readyState >= 2; })()`);
const menu = (evaluate) => evaluate(`[...document.getElementById('menu').children].map((c) => c.classList.contains('sep') ? '-' : c.firstChild.textContent + (c.disabled ? ' (off)' : ''))`);
const pick = (evaluate, label) => evaluate(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === ${JSON.stringify(label)}).click()`);

check('nobody sharing: no LIVE', [await live(ev), await live(alex.ev)], [null, null]);

// LIVE is in the sidebar with nobody sharing. Paul shares from its +.
check('LIVE is there, empty, with its +', await ev(`(() => { const s = document.getElementById('live-section'); const b = document.getElementById('new-share'); return [s.hidden, s.querySelector('.side-head span').textContent, b.hidden, b.disabled, b.title]; })()`), [false, 'LIVE', false, false, 'Share your screen']);
await ev(`document.getElementById('new-channel').click()`);
await settle(200);
check('TEXT’s + does not share screens', (await menu(ev)).includes('Share Your Screen…'), false);
await ev(`document.getElementById('menu').hidden = true`);
await ev(`document.getElementById('new-share').click()`);
await until('Paul sharing', async () => (await shareBar(ev)) !== null, 20000);
check('Paul’s bar', await shareBar(ev), 'Nobody watching yet');
await until('Alex sees LIVE', async () => JSON.stringify(await live(alex.ev)) === '["Paul"]', 20000);
check('LIVE appears for Alex, with Paul', await live(alex.ev), ['Paul']);
check('and for Paul, marked as his', await live(ev), ['Paul*']);
check('the hub lists it', (await (await api('GET', '/api/streams', undefined, 'Steve')).json()).streams.map((s) => s.name), ['Paul']);

// Alex watches: the picture arrives; both see the viewer.
await alex.ev(`document.querySelector('#live-list .row.live').click()`);
await until('Alex sees the picture', () => picture(alex.ev), 20000);
check('Alex watching: address, panel, picture', [await alex.ev(`location.hash`), (await panel(alex.ev))?.title, await picture(alex.ev)], ['#live=Paul', 'Paul’s screen', true]);
await until('Paul sees a viewer', async () => (await shareBar(ev)) === '1 watching');
check('Paul’s bar counts Alex', [await shareBar(ev), await ev(`document.querySelector('#share-bar .muted').title`)], ['1 watching', 'Alex']);
await until('count on Alex’s panel', async () => (await panel(alex.ev))?.count === '1 watching');
check('Alex’s panel: count, no note', await panel(alex.ev), { title: 'Paul’s screen', count: '1 watching', note: '' });
check('Alex’s row is the active one', await alex.ev(`document.querySelector('#live-list .row.live').classList.contains('active')`), true);
await alex.send('Page.captureScreenshot').then((s) => writeFileSync(join(import.meta.dirname, 'out', 'stream-watching.png'), Buffer.from(s.data, 'base64'))).catch(() => {});

// Alex opens a chat: the screen keeps coming behind it, he still counts, and a bar leads back.
await alex.ev(`location.hash = '#chan=general'`);
await until('Alex in the chat', () => alex.ev(`!document.getElementById('main-chat').hidden`));
const at = await alex.ev(`document.querySelector('#main-live video').currentTime`);
// (Frames from the fake capture come slowly when every suite runs at once: wait for one.)
await until('a new frame behind the chat', async () => (await alex.ev(`document.querySelector('#main-live video').currentTime`)) > at, 8000);
check('behind a chat: the picture keeps coming, a bar says so', [(await alex.ev(`document.querySelector('#main-live video').currentTime`)) > at, await alex.ev(`[...document.querySelectorAll('#watch-bar .share-where span')].map((s) => s.textContent)`), await alex.ev(`document.querySelectorAll('#watch-bar > button').length`)], [true, ['Watching', 'Paul’s screen'], 2]);
check('Alex still counts', await shareBar(ev), '1 watching');
await alex.ev(`document.querySelector('#watch-bar .share-where').click()`);
await until('Alex back at the picture', async () => (await panel(alex.ev)) !== null);
check('the bar leads back', [await alex.ev(`location.hash`), await picture(alex.ev), await alex.ev(`document.getElementById('watch-bar').hidden`)], ['#live=Paul', true, false]);

// Paul watches his own stream (each viewer is its own connection).
await ev(`document.querySelector('#live-list .row.live').click()`);
await until('Paul sees his own picture', () => picture(ev), 20000);
check('Paul watches himself', [(await panel(ev))?.title, await picture(ev)], ['Your screen', true]);
await until('two watching', async () => (await shareBar(ev)) === '2 watching');
check('two watching', await shareBar(ev), '2 watching');
// A tag: a line under your name in LIVE saying what the stream is. Yours to add, change and
// remove from your row's menu; everyone sees it, under the row and in the stream's bar.
const ownMenu = async (evaluate) => { await evaluate(`(() => { const r = document.querySelector('#live-list .row.live'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`); await settle(200); return menu(evaluate); };
const chips = (evaluate) => evaluate(`[[...document.querySelectorAll('#live-list .live-tag .live-chip')].map((c) => c.textContent), (() => { const c = document.querySelector('#main-live .live-head .live-chip'); return c && !c.hidden ? c.textContent : null; })()]`);
check('your own row’s menu has Add Tag…', await ownMenu(ev), ['Stop Watching', '-', 'Add Tag…', '-', 'Stop Sharing']);
check('someone else’s row has none', (await ownMenu(alex.ev)).filter((i) => i.includes('Tag')), []);
await alex.ev(`document.getElementById('menu').hidden = true`);
await pick(ev, 'Add Tag…');
await settle(300);
check('a dialog asks for it', [await ev(`document.querySelector('#dialog h2').textContent`), await ev(`document.activeElement === document.querySelector('#dialog input')`), await ev(`document.querySelector('#dialog input').maxLength`)], ['Add tag', true, 40]);
await ev(`(() => { document.querySelector('#dialog input').value = 'ghast farm,   phase 2'; document.querySelector('#dialog form').requestSubmit(); })()`);
await until('the tag on Alex’s page', async () => (await chips(alex.ev))[0].length === 1);
check('the tag shows under the row and in the bar, for both', [await chips(ev), await chips(alex.ev), await ev(`document.getElementById('overlay').hidden`)], [[['ghast farm, phase 2'], 'ghast farm, phase 2'], [['ghast farm, phase 2'], 'ghast farm, phase 2'], true]);
check('the chip is under the name, in the sidebar’s width', await ev(`(() => { const row = document.querySelector('#live-list .row.live').getBoundingClientRect(); const c = document.querySelector('#live-list .live-chip').getBoundingClientRect(); const side = document.getElementById('side').getBoundingClientRect();
  return [c.top >= row.bottom, c.left > row.left + 20, c.right <= side.right]; })()`), [true, true, true]);
check('then the menu has Edit Tag… and Remove Tag', await ownMenu(ev), ['Stop Watching', '-', 'Edit Tag…', 'Remove Tag', '-', 'Stop Sharing']);
await ev(`document.getElementById('menu').hidden = true`);
check('41 characters are refused; someone not live can’t have one; a member can’t touch another’s', [
  (await api('PUT', '/api/streams/tags/Paul', { tag: 'x'.repeat(41) }, 'Paul')).status, (await api('PUT', '/api/streams/tags/Alex', { tag: 'hello' }, 'Alex')).status,
  (await api('PUT', '/api/streams/tags/Paul', { tag: '' }, 'Alex')).status], [400, 409, 403]);
await ownMenu(ev);
await pick(ev, 'Remove Tag');
await until('the tag gone from Alex’s page', async () => (await chips(alex.ev))[0].length === 0);
check('Remove Tag takes it away', [await chips(ev), await chips(alex.ev)], [[[], null], [[], null]]);
await shot('own');
// Stop watching goes back; the count drops.
await ev(`[...document.querySelectorAll('#main-live button')].find((b) => b.textContent === 'Stop watching').click()`);
await settle(300);
check('Stop watching: panel gone, address back', [await panel(ev), await ev(`location.hash`)], [null, '#chan=general']);
await until('one watching again', async () => (await shareBar(ev)) === '1 watching');
check('back to one', await shareBar(ev), '1 watching');

// Paul's right-click on his own row; Alex's on Paul's (a member: no Stop Stream).
await ev(`(() => { const r = document.querySelector('#live-list .row.live'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`);
await settle(200);
check('Paul right-clicks his own', await menu(ev), ['Watch', '-', 'Add Tag…', '-', 'Stop Sharing']);
await ev(`document.getElementById('menu').hidden = true`);
await alex.ev(`(() => { const r = document.querySelector('#live-list .row.live'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`);
await settle(200);
check('Alex right-clicks Paul’s, which he is watching', await menu(alex.ev), ['Stop Watching', '-', 'Message']);
await alex.ev(`document.getElementById('menu').hidden = true`);
const sid1 = (await (await api('GET', '/api/streams', undefined, 'Alex')).json()).streams[0].id;
check('a member can’t stop someone else’s', (await api('POST', `/api/streams/${sid1}/stop`, {}, 'Alex')).status, 403);

// Paul presses Stop: Alex's panel says so; LIVE goes for both.
await ev(`document.querySelector('#share-bar button').click()`);
await until('Alex told', async () => (await panel(alex.ev))?.note === 'Paul stopped sharing.');
check('Alex’s panel: stopped', (await panel(alex.ev))?.note, 'Paul stopped sharing.');
await until('LIVE gone', async () => (await live(alex.ev)) === null && (await live(ev)) === null);
check('LIVE gone for both; Paul’s bar gone', [await live(alex.ev), await live(ev), await shareBar(ev)], [null, null, null]);
await alex.ev(`document.querySelector('.live-note button').click()`);
await settle(300);
check('Back leaves the panel', await panel(alex.ev), null);

// Alex shares; Paul (an admin) stops it from the right-click menu.
await alex.ev(`document.getElementById('new-share').click()`);
await until('Alex sharing', async () => JSON.stringify(await live(ev)) === '["Alex"]', 20000);
check('LIVE’s own + shares too', await live(ev), ['Alex']);
await ev(`(() => { const r = document.querySelector('#live-list .row.live'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`);
await settle(200);
check('Paul (owner) right-clicks Alex’s', await menu(ev), ['Watch', '-', 'Message', '-', 'Stop Stream']);
await pick(ev, 'Stop Stream');
await settle(100);
await pick(ev, 'Stop? Click again');
await until('Alex stopped', async () => (await shareBar(alex.ev)) === null && (await live(ev)) === null, 15000);
check('Alex’s stream ended; he’s told', [await shareBar(alex.ev), await live(ev), await alex.ev(`document.getElementById('toast').textContent`)],
  [null, null, 'An admin stopped your screen sharing.']);
check('in the admin log', (await (await api('GET', '/api/admin/log', undefined, 'Paul')).json())[0].action, 'stream-stop');

// Reloading the page ends your stream.
await ev(`document.getElementById('new-share').click()`);
await until('Paul sharing again', async () => JSON.stringify(await live(alex.ev)) === '["Paul"]', 20000);
await send('Page.reload');
await until('ended by the reload', async () => (await live(alex.ev)) === null, 20000);
check('the streamer reloading ends it', await live(alex.ev), null);

// A phone: the strip at the top of the chat, and watching covers the screen.
await until('Paul’s page back', () => ev(`!!document.getElementById('channels').children.length`));
await settle(500);
await alex.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 1, mobile: true });
await ev(`document.getElementById('new-share').click()`);
await until('strip on the phone', () => alex.ev(`!document.getElementById('live-strip').hidden && getComputedStyle(document.getElementById('live-strip')).display !== 'none'`), 20000);
check('phone: the strip', await alex.ev(`document.querySelector('.live-strip-item').textContent`), 'Paul is sharing their screenWatch');
await alex.ev(`document.querySelector('.live-strip-item').click()`);
await until('phone picture', () => picture(alex.ev), 20000);
check('phone: watching covers the screen', await alex.ev(`(() => { const r = document.getElementById('main').getBoundingClientRect(); return [r.width, r.height, getComputedStyle(document.getElementById('main')).position]; })()`), [400, 800, 'fixed']);
await alex.send('Page.captureScreenshot').then((s) => writeFileSync(join(import.meta.dirname, 'out', 'stream-phone.png'), Buffer.from(s.data, 'base64'))).catch(() => {});
await alex.ev(`[...document.querySelectorAll('#main-live button')].find((b) => b.textContent === 'Stop watching').click()`);
await settle(300);
check('phone: Stop watching gives the chat back', await alex.ev(`getComputedStyle(document.getElementById('main')).display`), 'none');
await alex.send('Emulation.clearDeviceMetricsOverride');

// An address for someone who isn't sharing.
await alex.ev(`location.hash = '#live=Steve'`);
await until('note', async () => (await panel(alex.ev))?.note === 'Steve isn’t sharing their screen right now.');
check('#live= for someone not sharing', (await panel(alex.ev))?.note, 'Steve isn’t sharing their screen right now.');

bws.close();
lk.kill();
await done();
