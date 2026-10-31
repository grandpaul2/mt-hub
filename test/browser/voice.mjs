// Voice chats, end to end: a local LiveKit (fetched/livekit-server, see support/livekit.mjs), Pat in the
// suite's page and Alex in a second browser profile (his own login). Starting from the "+"
// menu, the other person seeing it and joining under the first name, hearing each other
// (Alex gets Pat's audio track), the bar, leaving, a private voice chat hidden from an admin,
// and the limit of 3.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { api, check, COOKIE, DATA, done, ev, frames, HUB, send, settle, shot, STILL, ws } from './lib.mjs';
import { ensureLivekit } from './support/livekit.mjs';

const LK = ensureLivekit();
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

// When the game's microphone chain arrived, the old filter, gate, level and echo settings went
// and the microphone's settings started again at Simple Voice Chat's defaults, once; devices
// and volumes stayed. A setting chosen after that is kept.
const reload = async (q) => { await send('Page.navigate', { url: `${HUB}/?${q}` }); await until('the page again', () => ev(`!!document.getElementById('channels')?.children.length`)); };
const saved = () => ev(`(() => { const s = JSON.parse(localStorage.getItem('mt-voice') ?? '{}'); return [s.level, s.filter, s.echo, s.outVol, s.agc, s.keyboardGate, localStorage.getItem('mt-voice-svc')]; })()`);
await ev(`localStorage.setItem('mt-voice', JSON.stringify({ level: 12, filter: 'off', echo: true, gain: false, outVol: 150 })); localStorage.removeItem('mt-voice-svc')`);
await reload('old-settings');
check('old settings gone, volumes kept, the rest at the defaults, once', await saved(), [undefined, undefined, undefined, 150, true, true, '1']);
await ev(`localStorage.setItem('mt-voice', JSON.stringify({ agc: false }))`);
await reload('new-settings');
check('a setting chosen since is kept', (await saved())[4], false);
await ev(`localStorage.removeItem('mt-voice')`);
await reload('clean');
await settle(500);

// Voice Settings from the menu on your name, before joining: Mic test plays you back. (The
// page's microphones are watched from here on: what each was asked for.)
await ev(`(() => { window.mics = []; const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (c) => { window.mics.push(c?.audio); return gum(c); }; })()`);
const testBtn = (evaluate) => evaluate(`document.querySelector('#dialog .mic-test')?.textContent`);
await ev(`document.getElementById('user').click()`);
await settle(150);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Voice Settings').click()`);
await until('settings', () => ev(`document.querySelector('#dialog h2')?.textContent === 'Voice settings'`));
check('Mic test button', await testBtn(ev), 'Test');
await ev(`document.querySelector('#dialog .mic-test').click()`);
await until('test running', async () => (await testBtn(ev)) === 'Stop test', 20000);
check('Mic test runs (Test turns to Stop test, still grey)', [await testBtn(ev), await ev(`document.querySelector('#dialog .mic-test').classList.contains('danger')`)], ['Stop test', false]);
const asked = await ev(`window.mics.at(-1)`);
check('the microphone is asked for raw, as the game reads it', [asked?.echoCancellation, asked?.noiseSuppression, asked?.autoGainControl, asked?.channelCount], [false, false, false, 1]);
await ev(`document.querySelector('#dialog .mic-test').click()`);
check('Stop test stops it', await testBtn(ev), 'Test');

// The settings are Simple Voice Chat's; a change that makes you sound worse turns red and says why.
const titles = () => ev(`[...document.querySelectorAll('#dialog .set-group')].map((g) => [g.querySelector('h3').textContent, ...[...g.querySelectorAll('.set-row')].filter((r) => !r.hidden).map((r) => r.querySelector('.set-title').textContent)])`);
const rowOf = (t) => `[...document.querySelectorAll('#dialog .set-row')].find((r) => r.querySelector('.set-title').textContent === '${t}')`;
const red = (t) => ev(`(() => { const r = ${rowOf(t)}; return [r.querySelector('.set-title').classList.contains('off-default'), r.querySelector('.set-warn:not([hidden])')?.textContent ?? null]; })()`);
const pickIn = (t, v) => ev(`(() => { const s = ${rowOf(t)}.querySelector('select'); s.value = '${v}'; s.dispatchEvent(new Event('change')); })()`);
const slide = (t, v) => ev(`(() => { const s = ${rowOf(t)}.querySelector('input[type=range]'); s.value = '${v}'; s.dispatchEvent(new Event('input')); })()`);
const mine = () => ev(`JSON.parse(localStorage.getItem('mt-voice') ?? '{}')`);
check('the rows at the defaults', await titles(),
  [['Input', 'Microphone', 'Gain', 'Noise suppression', 'Mic test'], ['Activation', 'Activation method', 'Voice activation', 'Keyboard noise gate'], ['Output', 'Speaker', 'Output volume']]);
check('nothing red at the defaults', await ev(`document.querySelectorAll('#dialog .off-default, #dialog .set-warn:not([hidden])').length`), 0);
await pickIn('Gain', 'manual');
check('Gain: Manual is red, says why, and shows Microphone gain', [await red('Gain'), (await titles())[0], (await mine()).agc],
  [[true, 'Leave this on Auto so everyone hears you at a steady level.'], ['Input', 'Microphone', 'Gain', 'Microphone gain', 'Noise suppression', 'Mic test'], false]);
await slide('Microphone gain', 12);
check('Microphone gain above +10 dB is red and says why', [await red('Microphone gain'), await ev(`${rowOf('Microphone gain')}.querySelector('.readout').textContent`), (await mine()).gainDb],
  [[true, 'More than +10 dB can distort your voice.'], '+12 dB', 12]);
await slide('Microphone gain', 6);
check('+6 dB is not', (await red('Microphone gain'))[0], false);
await pickIn('Gain', 'auto');
await pickIn('Voice activation', 'manual');
check('Voice activation: Manual shows the threshold at -50 dB', [(await titles())[1], await ev(`${rowOf('Voice activation threshold')}.querySelector('.readout').textContent`)],
  [['Activation', 'Activation method', 'Voice activation', 'Voice activation threshold', 'Keyboard noise gate'], '-50 dB']);
await slide('Voice activation threshold', -5);
check('a threshold of -10 dB or more is red', (await red('Voice activation threshold'))[0], true);
await slide('Voice activation threshold', 0);
check('and 0 dB says the microphone never opens', (await red('Voice activation threshold'))[1], 'At 0 dB your microphone never opens.');
await slide('Voice activation threshold', -50);
await pickIn('Voice activation', 'auto');
await pickIn('Activation method', 'ptt');
check('Push to Talk: asks for its key, says where it works, hides the voice rows', [(await titles())[1], await ev(`${rowOf('Push to Talk key')}.querySelector('button').textContent`), await ev(`${rowOf('Push to Talk key')}.querySelector('.set-sub').textContent`)],
  [['Activation', 'Activation method', 'Push to Talk key'], 'Press a key…', 'Only while the hub is in front.']);
await ev(`${rowOf('Push to Talk key')}.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', bubbles: true }))`);
check('the key pressed is the key', [await ev(`${rowOf('Push to Talk key')}.querySelector('button').textContent`), (await mine()).pttKey, (await mine()).ptt], ['V', 'KeyV', true]);
await pickIn('Activation method', 'voice');
check('back at the defaults, nothing is red', await ev(`document.querySelectorAll('#dialog .off-default, #dialog .set-warn:not([hidden])').length`), 0);
await ev(`document.querySelector('#dialog .dialog-x').click()`);
check('the X closes it (and ends the test)', await ev(`document.getElementById('overlay').hidden`), true);

// TEXT's + makes chats only; VOICE's own + offers voice chats.
await ev(`document.getElementById('new-channel').click()`);
await settle(200);
check('TEXT’s + has no voice or sharing entries', (await ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent)`)).filter((i) => /Voice|Screen/.test(i)), []);
await ev(`document.getElementById('menu').hidden = true`);
await ev(`document.getElementById('new-voice').click()`);
await settle(200);
const items = await ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent + (b.disabled ? ' (off)' : ''))`);
check('+ menu has the voice entries', items.filter((i) => /Voice/.test(i)), ['New Voice Chat', 'New Private Voice Chat…']);
check('VOICE is there with no voice chats, under TEXT', [await ev(`document.getElementById('voice-section').hidden`), await ev(`[...document.querySelectorAll('#side .side-head')].filter((x) => x.offsetParent).map((x) => x.querySelector('span').textContent)`)], [false, ['FILES', 'TEXT', 'VOICE', 'LIVE']]);

// Pat starts one: it's just his name, the bar shows, and Alex sees it.
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'New Voice Chat').click()`);
await until('Pat connected', () => ev(`!document.getElementById('voice-bar').hidden`), 30000);
await until('Pat listed', async () => JSON.stringify(await rows(ev)) === '["Pat*"]');
check('Pat’s voice chat is just his name', await rows(ev), ['Pat*']);
check('it’s under VOICE, not in TEXT', [await ev(`document.getElementById('voice-section').hidden`), await ev(`!!document.querySelector('#channels .row.voice')`)], [false, false]);
const sfx = (evaluate) => evaluate(`window.__sfx.slice()`);
check('Pat hears the join sound', (await sfx(ev)).at(-1), 'join');
await until('Alex sees it', async () => JSON.stringify(await rows(alex.ev)) === '["Pat"]');
check('Alex sees it', await rows(alex.ev), ['Pat']);

// Alex clicks it: he's listed under Pat, on both pages, and gets Pat's audio.
await alex.ev(`document.querySelector('#voice-list .row.voice').click()`);
await until('Alex joined', async () => JSON.stringify(await rows(alex.ev)) === '["Pat*","Alex*"]', 30000);
await until('Pat sees Alex', async () => JSON.stringify(await rows(ev)) === '["Pat*","Alex*"]');
check('Alex under Pat (Pat’s page)', await rows(ev), ['Pat*', 'Alex*']);
await until('Pat hears Alex arrive', async () => (await sfx(ev)).at(-1) === 'otherJoin');
check('sounds: Alex hears his join, Pat hears someone arrive', [(await sfx(alex.ev)).at(-1), (await sfx(ev)).at(-1)], ['join', 'otherJoin']);
check('people in a voice chat are light blurple (green while talking)', await ev(`[...document.querySelectorAll('#voice-list .row.voice .name')].map((n) => getComputedStyle(n).color).every((c) => ['rgb(201, 205, 251)', 'rgb(115, 201, 145)'].includes(c))`), true);
check('only the first has the speaker icon', await ev(`[...document.querySelectorAll('#voice-list .row.voice')].map((r) => !!r.querySelector('.hash svg'))`), [true, false]);
// Each has a ✕ on their own row only (Leave), at the row's right end.
const leaveX = (evaluate) => evaluate(`[...document.querySelectorAll('#voice-list .row.voice')].map((r) => r.dataset.who + (r.querySelector('.voice-leave') ? ' ✕' + (r.lastElementChild.classList.contains('voice-leave') ? '' : ' (not last)') + ' ' + r.querySelector('.voice-leave').title : ''))`);
check('a ✕ on your own row only', [await leaveX(ev), await leaveX(alex.ev)], [['Pat ✕ Leave the voice chat', 'Alex'], ['Pat', 'Alex ✕ Leave the voice chat']]);
await until('Alex hears Pat', () => alex.ev(`document.querySelectorAll('body > div[hidden] audio').length >= 1`), 15000);
await until('Pat hears Alex', () => ev(`document.querySelectorAll('body > div[hidden] audio').length >= 1`), 15000);
check('each hears the other (an audio element each)', [await alex.ev(`document.querySelectorAll('body > div[hidden] audio').length`), await ev(`document.querySelectorAll('body > div[hidden] audio').length`)], [1, 1]);
// With speech for a microphone (FAKE_AUDIO), the gate opens and Pat's name lights up on
// Alex's page. (The default fake microphone only beeps, which the gate rightly keeps shut.)
if (process.env.FAKE_AUDIO) {
  await until('Pat speaking, seen by Alex', () => alex.ev(`!!document.querySelector('#voice-list .row.voice.speaking[data-who="Pat"]')`), 20000)
    .then(() => check('speech opens the gate: Pat lights up for Alex', true, true), () => check('speech opens the gate: Pat lights up for Alex', false, true));
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
check('settings: the meter under Mic test, readouts', [
  await ev(`!!document.querySelector('#dialog .set-row .voice-meter')`),
  await ev(`[...document.querySelectorAll('#dialog .set-row:not([hidden]) .readout')].map((r) => r.textContent)`)],
  [true, ['100%']]);
// In a voice chat, Mic test plays back the live microphone.
await ev(`document.querySelector('#dialog .mic-test').click()`);
await until('test in a call', async () => (await testBtn(ev)) === 'Stop test', 20000);
check('Mic test in a voice chat', await testBtn(ev), 'Stop test');
await ev(`document.querySelector('#dialog .dialog-x').click()`);
check('still connected after the test', await ev(`!document.getElementById('voice-bar').hidden`), true);

// The game's chain runs in the page (svc-mic.wasm in its worklet). Chromium's fake microphone
// is a beep. With Push to Talk it goes out only while the key is down; with Voice activation:
// Manual at -127 dB and the keyboard gate off, always. (Whether the defaults let a beep out is
// Silero's call on a tone, borderline either way; test/unit/svcmic/ checks the defaults.) loudest: the loudest the chain let out (__micPeak, per 50 ms) over 1.2 s
// of real time, which always holds a beep, starting 0.6 s from now, once what came before (a
// tail, the frame queue) is out. (settle() won't do here: it returns when the page is idle.)
const loudest = () => ev(`new Promise((r) => setTimeout(() => { let m = 0; const t0 = performance.now(); window.__micPeak = 0;
  const iv = setInterval(() => { m = Math.max(m, window.__micPeak ?? 0); if (performance.now() - t0 > 1200) { clearInterval(iv); r(m); } }, 20); }, 600))`);
const quiet = async (what) => check(what, await loudest(), 0);
const heard = async (what) => { const m = await loudest(); check(what, m > 0.01 ? 'out' : `nothing (${m})`, 'out'); };
const settingsOpen = async () => {
  await ev(`document.querySelector('#voice-bar button[title="Voice settings"]').click()`);
  await until('settings', () => ev(`document.querySelector('#dialog h2')?.textContent === 'Voice settings'`));
};
const closeSettings = () => ev(`document.querySelector('#dialog .dialog-x').click()`);
await settingsOpen();
await pickIn('Activation method', 'ptt');
await closeSettings();
await quiet('Push to Talk without the key: nothing goes out');
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', bubbles: true }))`);
await heard('with the key down, it goes out');
await ev(`document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', key: 'v', bubbles: true }))`);
await quiet('and stops when the key comes up');
await settingsOpen();
await pickIn('Activation method', 'voice');
await pickIn('Voice activation', 'manual');
await slide('Voice activation threshold', -127);
await ev(`${rowOf('Keyboard noise gate')}.querySelector('.switch').click()`);
await closeSettings();
await heard('Voice activation: Manual at -127 dB lets the beep out');
await settingsOpen();
await slide('Voice activation threshold', -50);
await pickIn('Voice activation', 'auto');
await ev(`${rowOf('Keyboard noise gate')}.querySelector('.switch').click()`);
check('back at the defaults', await ev(`(({ agc, denoise, ptt, vad, thresholdDb, keyboardGate }) => [agc, denoise, ptt, vad, thresholdDb, keyboardGate])(JSON.parse(localStorage.getItem('mt-voice')))`), [true, true, false, true, -50, true]);
await closeSettings();

// Right-click someone in your voice chat (Discord's menu): Message, User Volume, Mute; and,
// for an admin on someone below them, Mute for Everyone and Disconnect.
const rightClick = (evaluate, name) => evaluate(`(() => { const r = [...document.querySelectorAll('#voice-list .row.voice')].find((x) => x.dataset.who === '${name}');
  const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`);
const menuItems = (evaluate) => evaluate(`[...document.getElementById('menu').children].map((c) => c.classList.contains('sep') ? '-' : c.classList.contains('menu-volume') ? 'User Volume ' + c.querySelector('input').value : c.firstChild.textContent + (c.classList.contains('danger') ? ' (red)' : ''))`);
const closeMenu = (evaluate) => evaluate(`document.getElementById('menu').hidden = true`);
await rightClick(ev, 'Alex');
await settle(200);
check('Pat (owner) right-clicks Alex', await menuItems(ev), ['Leave', '-', 'Message', '-', 'User Volume 100', 'Mute', '-', 'Mute for Everyone', 'Disconnect (red)']);
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
await rightClick(alex.ev, 'Pat');
await settle(200);
check('Alex (member) right-clicks Pat', await menuItems(alex.ev), ['Leave', '-', 'Message', '-', 'User Volume 100', 'Mute']);
await closeMenu(alex.ev);
const vid = await ev(`[...document.querySelectorAll('#voice-list .row.voice')][0].dataset.voice`);
check('a member can’t mute or disconnect', [(await api('POST', `/api/voice/${vid}/mute`, { name: 'Pat' }, 'Alex')).status,
  (await api('POST', `/api/voice/${vid}/disconnect`, { name: 'Pat' }, 'Alex')).status], [403, 403]);
// Mute for Everyone: Alex's microphone goes quiet; his page shows him muted and says why.
await rightClick(ev, 'Alex');
await settle(200);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Mute for Everyone').click()`);
await until('Alex muted by Pat', async () => (await bar(alex.ev))[0] === 'Unmute', 10000).catch(() => {});
check('Alex muted for everyone: his bar, and a notice', [(await bar(alex.ev))[0], await alex.ev(`document.getElementById('toast').textContent`)],
  ['Unmute', 'An admin muted you for everyone. Unmute when you’re ready.']);
await alex.ev(`document.querySelector('#voice-bar button[title="Unmute"]').click()`);
await settle(300);
check('and he can unmute himself', (await bar(alex.ev))[0], 'Mute');

// Pat leaves: Alex moves to the top; then Pat (an admin, not in it) disconnects Alex and it's gone.
// With motion on for this once (lib.mjs turns it off): the bottom of the sidebar slides shut
// with the bar still in it (style guide 5, Motion).
await send('Emulation.setEmulatedMedia', { features: [] });
const foot = await frames(`document.querySelector('#voice-bar button[title="Leave the voice chat"]').click()`,
  `[document.getElementById('side-foot').hidden ? 0 : document.getElementById('side-foot').getBoundingClientRect().height, document.querySelectorAll('#voice-bar .voice-buttons button').length]`, 2000);
await send('Emulation.setEmulatedMedia', { features: STILL });
check('leaving: the sidebar’s bottom slides shut, the bar in it to the end', [foot.some(([h]) => h > 0.5 && h < foot[0][0] - 0.5), foot.filter(([h]) => h > 0).every(([, n]) => n === 4), foot.at(-1)[0]], [true, true, 0]);
await until('Pat gone', async () => JSON.stringify(await rows(alex.ev)) === '["Alex*"]');
await until('Pat’s page updated', async () => JSON.stringify(await rows(ev)) === '["Alex"]').catch(() => {});
check('Alex is now the top (Alex’s page)', await rows(alex.ev), ['Alex*']);
await until('Alex hears Pat go', async () => (await sfx(alex.ev)).at(-1) === 'otherLeave');
check('sounds: Pat hears his leave, Alex hears someone go', [(await sfx(ev)).at(-1), (await sfx(alex.ev)).at(-1)], ['leave', 'otherLeave']);
check('Pat’s page: Alex only, bar hidden, no ✕', [await rows(ev), await ev(`document.getElementById('voice-bar').hidden`), await leaveX(ev)], [['Alex'], true, ['Alex']]);
await rightClick(ev, 'Alex');
await settle(200);
check('Pat right-clicks Alex, not in it', await menuItems(ev), ['Join', '-', 'Message', '-', 'Mute for Everyone', 'Disconnect (red)']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Disconnect').click()`);
await settle(100);
check('Disconnect asks first', await menuItems(ev), ['Join', '-', 'Message', '-', 'Mute for Everyone', 'Disconnect? Click again (red)']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Disconnect? Click again').click()`);
await until('it ends', async () => (await rows(ev)).length === 0);
check('the last voice chat gone: VOICE stays, empty', [await ev(`document.getElementById('voice-section').hidden`), await ev(`document.getElementById('voice-list').children.length`)], [false, 0]);
check('the last one out (disconnected) ends it', [await rows(ev), await alex.ev(`document.getElementById('voice-bar').hidden`), await alex.ev(`document.getElementById('toast').textContent`)],
  [[], true, 'An admin disconnected you from the voice chat.']);
check('both in the admin log', (await (await api('GET', '/api/admin/log', undefined, 'Pat')).json()).slice(0, 2).map((e) => e.action), ['voice-disconnect', 'voice-mute']);

// A private voice chat Alex starts with Steve: Pat (an admin) never sees it.
await alex.ev(`(async () => { const r = await fetch('/api/voice', { method: 'POST', body: JSON.stringify({ private: true, invite: ['Steve'] }) }); return r.status; })()`);
const listed = async (who) => (await (await api('GET', '/api/voice', undefined, who)).json()).chats.length;
check('private: Alex and Steve see it, Pat doesn’t', [await listed('Alex'), await listed('Steve'), await listed('Pat')], [1, 1, 0]);

// The limit: with 3, the menu entries are greyed out.
// (Each person can hold one empty voice chat, so it takes three people; the refusal of a
// fourth is in the Go test.)
await api('POST', '/api/voice', {}, 'Steve');
await api('POST', '/api/voice', {}, 'Steve');
await api('POST', '/api/voice', {}, 'Pat');
check('starting again replaces your empty one: three in all', await listed('Steve'), 3);
await ev(`document.dispatchEvent(new MouseEvent('mousedown'))`);
await settle(300);
await send('Page.reload');
await until('reloaded', () => ev(`!!document.getElementById('channels').children.length`));
await settle(800);
await ev(`document.getElementById('new-voice').click()`);
await settle(200);
check('with 3, the voice entries are greyed out', (await ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent + (b.disabled ? ' (off)' : ''))`)).filter((i) => /Voice/.test(i)),
  ['New Voice Chat (off)', 'New Private Voice Chat… (off)']);

bws.close();
lk.kill();
await done();
