// Voice chats, end to end: a local LiveKit (fetched/livekit-server, see README), Paul in the
// suite's page and Alex in a second browser profile (his own login). Starting from the "+"
// menu, the other person seeing it and joining under the first name, hearing each other
// (Alex gets Paul's audio track), the bar, leaving, a private voice chat hidden from an admin,
// and the limit of 3.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { api, check, COOKIE, DATA, done, ev, HUB, send, settle, shot, ws } from './lib.mjs';

const root = join(import.meta.dirname, '..', '..');
// The LiveKit server the VPS runs, fetched once into fetched/ (not in git), checksum checked.
const LK = join(root, 'fetched', 'livekit-server');
const LK_VERSION = '1.13.7';
if (!existsSync(LK)) {
  const base = `https://github.com/livekit/livekit/releases/download/v${LK_VERSION}`;
  const tar = `livekit_${LK_VERSION}_linux_amd64.tar.gz`;
  execFileSync('sh', ['-ec', `cd "$1" && curl -sSLO "$2/$3" && curl -sSL "$2/checksums.txt" | grep "  $3$" | sha256sum -c - >/dev/null && tar xzf "$3" livekit-server && rm "$3"`,
    'sh', join(root, 'fetched'), base, tar]);
}
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const port = await freePort();
const tcp = await freePort();
const SECRET = 'test-secret-that-is-long-enough-0123456789';
const conf = join(DATA, 'livekit.yaml');
writeFileSync(conf, `port: ${port}
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: ${tcp}
  port_range_start: 52000
  port_range_end: 52100
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
  for (const end = Date.now() + ms; Date.now() < end; await settle(150)) if (await fn()) return;
  throw new Error(`timed out waiting for ${what}`);
};
const rows = (evaluate) => evaluate(`[...document.querySelectorAll('#voice-list .row.voice')].map((r) => r.dataset.who + (r.classList.contains('here') ? '*' : ''))`);

// Alex: a second browser profile with its own cookies, driven over the browser's own
// DevTools socket (the suite's is the page's, which can't make profiles).
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
const alex = { send: (m, p) => raw(m, p, sessionId), ev: async (expression) => (await raw('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId))?.result?.value };
await alex.send('Network.enable');
await alex.send('Network.setCookie', { name: 'mt_session', value: COOKIE.Alex.split('=')[1], url: HUB });

await send('Page.navigate', { url: HUB });
await alex.send('Page.navigate', { url: HUB });
await until('both pages', async () => (await ev(`!!document.getElementById('channels').children.length`)) && (await alex.ev(`!!document.getElementById('channels').children.length`)));
await settle(500);

// Voice Settings from the menu on your name, before joining: Mic test plays you back.
const testBtn = (evaluate) => evaluate(`document.querySelector('#dialog .mic-test')?.textContent`);
await ev(`document.getElementById('user').click()`);
await settle(150);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Voice Settings').click()`);
await until('settings', () => ev(`document.querySelector('#dialog h2')?.textContent === 'Voice settings'`));
check('Mic test button', await testBtn(ev), 'Test');
await ev(`document.querySelector('#dialog .mic-test').click()`);
await until('test running', async () => (await testBtn(ev)) === 'Stop test', 20000);
check('Mic test runs (Test turns to Stop test, still grey)', [await testBtn(ev), await ev(`document.querySelector('#dialog .mic-test').classList.contains('danger')`)], ['Stop test', false]);
await ev(`document.querySelector('#dialog .mic-test').click()`);
check('Stop test stops it', await testBtn(ev), 'Test');
await ev(`document.querySelector('#dialog .mic-test').click()`);
await until('test running again', async () => (await testBtn(ev)) === 'Stop test', 20000);
// Echo cancelling is a switch, saved as it flips.
await ev(`document.querySelector('#dialog .switch').click()`);
await settle(200);
check('echo switch on, saved', [await ev(`document.querySelector('#dialog .switch').getAttribute('aria-checked')`), await ev(`JSON.parse(localStorage.getItem('mt-voice')).echo`)], ['true', true]);
await ev(`document.querySelector('#dialog .switch').click()`);
await settle(200);
check('and off again', await ev(`JSON.parse(localStorage.getItem('mt-voice')).echo`), false);
await ev(`document.querySelector('#dialog .dialog-x').click()`);
check('the X closes it (and ends the test)', await ev(`document.getElementById('overlay').hidden`), true);

// The + menu offers voice chats.
await ev(`document.getElementById('new-channel').click()`);
await settle(200);
const items = await ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent + (b.disabled ? ' (off)' : ''))`);
check('+ menu has the voice entries', items.filter((i) => /Voice/.test(i)), ['New Voice Chat', 'New Private Voice Chat…']);
check('no VOICE section while there are no voice chats', await ev(`document.getElementById('voice-section').hidden`), true);

// Paul starts one: it's just his name, the bar shows, and Alex sees it.
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'New Voice Chat').click()`);
await until('Paul connected', () => ev(`!document.getElementById('voice-bar').hidden`), 30000);
await until('Paul listed', async () => JSON.stringify(await rows(ev)) === '["Paul*"]');
check('Paul’s voice chat is just his name', await rows(ev), ['Paul*']);
check('it’s under VOICE, not in CHATS', [await ev(`document.getElementById('voice-section').hidden`), await ev(`!!document.querySelector('#channels .row.voice')`)], [false, false]);
const sfx = (evaluate) => evaluate(`window.__sfx.slice()`);
check('Paul hears the join sound', (await sfx(ev)).at(-1), 'join');
await until('Alex sees it', async () => JSON.stringify(await rows(alex.ev)) === '["Paul"]');
check('Alex sees it', await rows(alex.ev), ['Paul']);

// Alex clicks it: he's listed under Paul, on both pages, and gets Paul's audio.
await alex.ev(`document.querySelector('#voice-list .row.voice').click()`);
await until('Alex joined', async () => JSON.stringify(await rows(alex.ev)) === '["Paul*","Alex*"]', 30000);
await until('Paul sees Alex', async () => JSON.stringify(await rows(ev)) === '["Paul*","Alex*"]');
check('Alex under Paul (Paul’s page)', await rows(ev), ['Paul*', 'Alex*']);
await until('Paul hears Alex arrive', async () => (await sfx(ev)).at(-1) === 'otherJoin');
check('sounds: Alex hears his join, Paul hears someone arrive', [(await sfx(alex.ev)).at(-1), (await sfx(ev)).at(-1)], ['join', 'otherJoin']);
check('only the first has the speaker icon', await ev(`[...document.querySelectorAll('#voice-list .row.voice')].map((r) => !!r.querySelector('.hash svg'))`), [true, false]);
await until('Alex hears Paul', () => alex.ev(`document.querySelectorAll('body > div[hidden] audio').length >= 1`), 15000);
await until('Paul hears Alex', () => ev(`document.querySelectorAll('body > div[hidden] audio').length >= 1`), 15000);
check('each hears the other (an audio element each)', [await alex.ev(`document.querySelectorAll('body > div[hidden] audio').length`), await ev(`document.querySelectorAll('body > div[hidden] audio').length`)], [1, 1]);
// With speech for a microphone (FAKE_AUDIO), the gate opens and Paul's name lights up on
// Alex's page. (The default fake microphone only beeps, which the gate rightly keeps shut.)
if (process.env.FAKE_AUDIO) {
  await until('Paul speaking, seen by Alex', () => alex.ev(`!!document.querySelector('#voice-list .row.voice.speaking[data-who="Paul"]')`), 20000)
    .then(() => check('speech opens the gate: Paul lights up for Alex', true, true), () => check('speech opens the gate: Paul lights up for Alex', false, true));
}
await shot('in-voice');

// Mute and deafen on the bar.
const bar = (evaluate) => evaluate(`[...document.querySelectorAll('#voice-bar .voice-buttons button')].map((b) => b.title)`);
check('bar buttons', await bar(ev), ['Mute', 'Deafen', 'Voice settings', 'Leave the voice chat']);
await ev(`document.querySelector('#voice-bar button[title="Deafen"]').click()`);
await settle(300);
check('deafen mutes you too', await bar(ev), ['Unmute', 'Undeafen', 'Voice settings', 'Leave the voice chat']);
check('and silences the others', await ev(`[...document.querySelectorAll('body > div[hidden] audio')].every((a) => a.muted)`), true);
await ev(`document.querySelector('#voice-bar button[title="Undeafen"]').click()`);
await settle(300);
check('undeafen', await bar(ev), ['Mute', 'Deafen', 'Voice settings', 'Leave the voice chat']);
await ev(`document.querySelector('#voice-bar button[title="Mute"]').click()`);
await settle(200);
await ev(`document.querySelector('#voice-bar button[title="Unmute"]').click()`);
await settle(200);
check('sounds: deafen, undeafen, mute, unmute', (await sfx(ev)).slice(-4), ['deafen', 'undeafen', 'mute', 'unmute']);

// Settings: the gear opens them; the level shows the meter while in a voice chat.
await ev(`document.querySelector('#voice-bar button[title="Voice settings"]').click()`);
await until('settings', () => ev(`document.querySelector('#dialog h2')?.textContent === 'Voice settings'`));
check('voice sounds aren’t here (they’re in Sound Settings)', await ev(`[...document.querySelectorAll('#dialog .set-title')].some((t) => /sound/i.test(t.textContent))`), false);
check('settings: groups, rows, the meter under Mic test, echo off, readouts', [
  await ev(`[...document.querySelectorAll('#dialog .set-group')].map((g) => [g.querySelector('h3').textContent, ...[...g.querySelectorAll('.set-title')].map((t) => t.textContent)])`),
  await ev(`!!document.querySelector('#dialog .set-row .voice-meter')`), await ev(`document.querySelector('#dialog .switch').getAttribute('aria-checked')`),
  await ev(`[...document.querySelectorAll('#dialog .readout')].map((r) => r.textContent)`)],
  [[['Input', 'Microphone', 'Mic level', 'Mic test'], ['Output', 'Speaker', 'Output volume'], ['Processing', 'Noise filter', 'Voice gate sensitivity', 'Echo cancelling']], true, 'false', ['+0 dB', '100%', '50%']]);
// In a voice chat, Mic test plays back the live microphone.
await ev(`document.querySelector('#dialog .mic-test').click()`);
await until('test in a call', async () => (await testBtn(ev)) === 'Stop test', 20000);
check('Mic test in a voice chat', await testBtn(ev), 'Stop test');
await ev(`document.querySelector('#dialog .dialog-x').click()`);
check('still connected after the test', await ev(`!document.getElementById('voice-bar').hidden`), true);

// Right-click someone in your voice chat (Discord's menu): Message, User Volume, Mute; and,
// for an admin on someone below them, Mute for Everyone and Disconnect.
const rightClick = (evaluate, name) => evaluate(`(() => { const r = [...document.querySelectorAll('#voice-list .row.voice')].find((x) => x.dataset.who === '${name}');
  const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`);
const menuItems = (evaluate) => evaluate(`[...document.getElementById('menu').children].map((c) => c.classList.contains('sep') ? '-' : c.classList.contains('menu-volume') ? 'User Volume ' + c.querySelector('input').value : c.firstChild.textContent + (c.classList.contains('danger') ? ' (red)' : ''))`);
const closeMenu = (evaluate) => evaluate(`document.getElementById('menu').hidden = true`);
await rightClick(ev, 'Alex');
await settle(200);
check('Paul (owner) right-clicks Alex', await menuItems(ev), ['Leave', '-', 'Message', '-', 'User Volume 100', 'Mute', '-', 'Mute for Everyone', 'Disconnect (red)']);
await shot('person-menu');
// User Volume: squared (50% is a quarter); above 100% a Web Audio gain plays them louder; saved.
const setVol = (v) => ev(`(() => { const i = document.querySelector('#menu .menu-volume input'); i.value = '${v}'; i.dispatchEvent(new Event('input')); })()`);
const levels = () => ev(`window.__voiceLevels().Alex`);
await setVol(50);
check('50%: a quarter, on the element', [await levels(), await ev(`document.querySelector('#menu .menu-volume .readout').textContent`)], [{ el: 0.25, muted: false, boost: null }, '50%']);
await setVol(200);
check('200%: the element at 0, a 4x boost', await levels(), { el: 0, muted: false, boost: 4 });
check('saved per person', await ev(`JSON.parse(localStorage.getItem('mt-voice-people')).Alex.vol`), 200);
await closeMenu(ev);
await rightClick(ev, 'Alex');
await settle(200);
check('the menu remembers it', (await menuItems(ev))[4], 'User Volume 200');
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Mute').click()`);
await settle(100);
check('Mute (for you): silent, nothing boosted', await levels(), { el: 0, muted: false, boost: null });
await rightClick(ev, 'Alex');
await settle(200);
check('then the menu offers Unmute', (await menuItems(ev))[5], 'Unmute');
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Unmute').click()`);
await rightClick(ev, 'Alex');
await settle(200);
await setVol(100);
await closeMenu(ev);
check('back to normal', await levels(), { el: 1, muted: false, boost: null });
// A member sees no admin items, and the hub refuses them anyway.
await rightClick(alex.ev, 'Paul');
await settle(200);
check('Alex (member) right-clicks Paul', await menuItems(alex.ev), ['Leave', '-', 'Message', '-', 'User Volume 100', 'Mute']);
await closeMenu(alex.ev);
const vid = await ev(`[...document.querySelectorAll('#voice-list .row.voice')][0].dataset.voice`);
check('a member can’t mute or disconnect', [(await api('POST', `/api/voice/${vid}/mute`, { name: 'Paul' }, 'Alex')).status,
  (await api('POST', `/api/voice/${vid}/disconnect`, { name: 'Paul' }, 'Alex')).status], [403, 403]);
// Mute for Everyone: Alex's microphone goes quiet; his page shows him muted and says why.
await rightClick(ev, 'Alex');
await settle(200);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Mute for Everyone').click()`);
await until('Alex muted by Paul', async () => (await bar(alex.ev))[0] === 'Unmute', 10000).catch(() => {});
check('Alex muted for everyone: his bar, and a notice', [(await bar(alex.ev))[0], await alex.ev(`document.getElementById('toast').textContent`)],
  ['Unmute', 'An admin muted you for everyone. Unmute when you’re ready.']);
await alex.ev(`document.querySelector('#voice-bar button[title="Unmute"]').click()`);
await settle(300);
check('and he can unmute himself', (await bar(alex.ev))[0], 'Mute');

// Paul leaves: Alex moves to the top; then Paul (an admin, not in it) disconnects Alex and it's gone.
await ev(`document.querySelector('#voice-bar button[title="Leave the voice chat"]').click()`);
await until('Paul gone', async () => JSON.stringify(await rows(alex.ev)) === '["Alex*"]');
await until('Paul’s page updated', async () => JSON.stringify(await rows(ev)) === '["Alex"]').catch(() => {});
check('Alex is now the top (Alex’s page)', await rows(alex.ev), ['Alex*']);
await until('Alex hears Paul go', async () => (await sfx(alex.ev)).at(-1) === 'otherLeave');
check('sounds: Paul hears his leave, Alex hears someone go', [(await sfx(ev)).at(-1), (await sfx(alex.ev)).at(-1)], ['leave', 'otherLeave']);
check('Paul’s page: Alex only, bar hidden', [await rows(ev), await ev(`document.getElementById('voice-bar').hidden`)], [['Alex'], true]);
await rightClick(ev, 'Alex');
await settle(200);
check('Paul right-clicks Alex, not in it', await menuItems(ev), ['Join', '-', 'Message', '-', 'Mute for Everyone', 'Disconnect (red)']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Disconnect').click()`);
await settle(100);
check('Disconnect asks first', await menuItems(ev), ['Join', '-', 'Message', '-', 'Mute for Everyone', 'Disconnect? Click again (red)']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Disconnect? Click again').click()`);
await until('it ends', async () => (await rows(ev)).length === 0);
check('the last voice chat gone: VOICE goes too', await ev(`document.getElementById('voice-section').hidden`), true);
check('the last one out (disconnected) ends it', [await rows(ev), await alex.ev(`document.getElementById('voice-bar').hidden`), await alex.ev(`document.getElementById('toast').textContent`)],
  [[], true, 'An admin disconnected you from the voice chat.']);
check('both in the admin log', (await (await api('GET', '/api/admin/log', undefined, 'Paul')).json()).slice(0, 2).map((e) => e.action), ['voice-disconnect', 'voice-mute']);

// A private voice chat Alex starts with Steve: Paul (an admin) never sees it.
await alex.ev(`(async () => { const r = await fetch('/api/voice', { method: 'POST', body: JSON.stringify({ private: true, invite: ['Steve'] }) }); return r.status; })()`);
const listed = async (who) => (await (await api('GET', '/api/voice', undefined, who)).json()).chats.length;
check('private: Alex and Steve see it, Paul doesn’t', [await listed('Alex'), await listed('Steve'), await listed('Paul')], [1, 1, 0]);

// The limit: with 3, the menu entries are greyed out.
// (Each person can hold one empty voice chat, so it takes three people; the refusal of a
// fourth is in the Go test.)
await api('POST', '/api/voice', {}, 'Steve');
await api('POST', '/api/voice', {}, 'Steve');
await api('POST', '/api/voice', {}, 'Paul');
check('starting again replaces your empty one: three in all', await listed('Steve'), 3);
await ev(`document.dispatchEvent(new MouseEvent('mousedown'))`);
await settle(300);
await send('Page.reload');
await until('reloaded', () => ev(`!!document.getElementById('channels').children.length`));
await settle(800);
await ev(`document.getElementById('new-channel').click()`);
await settle(200);
check('with 3, the voice entries are greyed out', (await ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent + (b.disabled ? ' (off)' : ''))`)).filter((i) => /Voice/.test(i)),
  ['New Voice Chat (off)', 'New Private Voice Chat… (off)']);

bws.close();
lk.kill();
await done();
