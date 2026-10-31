// Relay streams, end to end: a local MediaMTX (fetched/mediamtx) stands in for the stream
// relay and ffmpeg (on the PATH) for OBS, publishing a moving picture and a tone as
// "<channel>-web", which is what the relay's own conversion produces. Paul watches Alex's
// stream: the row in LIVE with its own icon, #stream=, picture and sound, the viewer count,
// the volume kept, playing on behind a chat (the bar in the sidebar, Stop Watching on the row),
// the full-screen bar, a dropped connection reconnecting, sound refused without a click, a
// stream with B-frames, the stream blinking and ending, and a phone.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { api, check, DATA, done, ev as quiet, HUB, send, settle, shot } from './lib.mjs';
import { ensureMediamtx } from './support/mediamtx.mjs';

const MTX = ensureMediamtx();
if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('the relay suite needs ffmpeg (with libx264 and libopus) on the PATH; skip it: node test/browser/run.mjs <the other suites>');
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const [rtsp, whep, apiPort, ice] = [await freePort(), await freePort(), await freePort(), await freePort()];
const conf = join(DATA, 'mediamtx.yml');
writeFileSync(conf, `logLevel: info
logDestinations: [file]
logFile: ${join(DATA, 'mediamtx.log')}
api: true
apiAddress: 127.0.0.1:${apiPort}
rtmp: false
hls: false
srt: false
rtsp: true
rtspAddress: 127.0.0.1:${rtsp}
rtspTransports: [tcp]
webrtc: true
webrtcAddress: 127.0.0.1:${whep}
webrtcLocalUDPAddress: 127.0.0.1:${ice}
webrtcLocalTCPAddress: ''
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts: [127.0.0.1]
authInternalUsers:
  - user: obs
    pass: obs-pass
    ips: ['127.0.0.1']
    permissions:
      - action: publish
  - user: hub
    pass: hub-pass
    ips: []
    permissions:
      - action: read
      - action: api
paths:
  all_others:
`);
const kids = [];
// (cwd: MediaMTX writes a self-signed certificate, auto.crt and auto.key, where it starts.)
const run = (cmd, args) => { const p = spawn(cmd, args, { stdio: 'ignore', cwd: DATA }); kids.push(p); return p; };
process.on('exit', () => kids.forEach((k) => k.kill()));
// MediaMTX quits at once when it can't watch its configuration file ("couldn't initialize
// inotify: too many open files": the user's inotify instances, 128 by default, used up by the
// suites' browsers beside it). Started again until its API answers, as other suites end and
// free some; still down after 30 s, the suite stops here with MediaMTX's own words.
const mtxLog = join(DATA, 'mediamtx.log');
const mtxUp = () => fetch(`http://127.0.0.1:${apiPort}/v3/paths/list`, { headers: { Authorization: 'Basic ' + btoa('hub:hub-pass') } }).then((r) => r.ok, () => false);
for (const end = Date.now() + 30000; ;) {
  const p = run(MTX, [conf]);
  let quit = false;
  p.on('exit', () => (quit = true));
  while (!quit && !(await mtxUp()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  if (!quit && (await mtxUp())) break;
  const why = (existsSync(mtxLog) ? readFileSync(mtxLog, 'utf8') : '').split('\n').filter((l) => l.includes(' ERR ')).at(-1) ?? 'no error in its log';
  if (Date.now() >= end) throw new Error(`MediaMTX did not start in 30 s: ${why}`);
  console.log(`(MediaMTX quit, started again: ${why})`);
  p.kill();
  await new Promise((r) => setTimeout(r, 1000));
}
// What OBS sends once the relay has converted its sound: H.264 and Opus. bframes is the
// number of B-frames (OBS's x264 makes them unless told bframes=0).
const publish = (channel, bframes) => run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30', '-re', '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
  '-c:v', 'libx264', ...(bframes ? ['-preset', 'veryfast', '-bf', String(bframes), '-b_strategy', '0'] : ['-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0']), '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '64k',
  '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://obs:obs-pass@127.0.0.1:${rtsp}/${channel}-web`]);
writeFileSync(join(DATA, 'relay.json'), JSON.stringify({ url: `http://127.0.0.1:${whep}`, api: `http://127.0.0.1:${apiPort}`, user: 'hub', pass: 'hub-pass',
  channels: { alexcam: 'Alex', stevecam: 'Steve', paulcam: 'Paul' }, delay_ms: 300 }));

const until = async (what, fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await settle(150)) if (await fn()) return true;
  console.log(`(timed out waiting for ${what})`);
  return false;
};
// Evaluations that count as a click (a browser plays sound only after one).
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }))?.result?.value;
const sessions = async () => (await (await fetch(`http://127.0.0.1:${apiPort}/v3/webrtcsessions/list`, { headers: { Authorization: 'Basic ' + btoa('hub:hub-pass') } })).json()).items.length;

// The page gives a stream that left the list a minute to come back; here, 12 seconds.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `{ const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, ms === 60000 ? 12000 : ms, ...a); }` });
await send('Page.navigate', { url: HUB });
await until('the page', () => ev(`!!document.getElementById('channels').children.length`));
await settle(300);

const live = () => ev(`(() => { const rows = [...document.querySelectorAll('#live-list .row.live')].map((r) => r.dataset.who + (r.classList.contains('relay') ? ' (stream)' : '') + (r.classList.contains('here') ? '*' : '')); return rows.length ? rows : null; })()`);
const panel = () => ev(`document.getElementById('main-live').hidden ? null : { title: document.querySelector('.live-title').textContent, count: document.querySelector('.live-count').textContent, note: document.querySelector('.live-note').hidden ? '' : document.querySelector('.live-note').firstChild?.textContent ?? '' }`);
const video = () => ev(`(() => { const v = document.querySelector('#main-live video'); return { picture: v.videoWidth > 0 && v.readyState >= 2, muted: v.muted, volume: Math.round(v.volume * 1000) / 1000, sound: v.srcObject?.getAudioTracks().length ?? 0 }; })()`);
// moving: the picture's clock goes forward (a quarter second within three). Polled, not two
// readings a fixed time apart: about 0.4 s into a stream the clock steps back a tenth of a
// second as the hold-back settles, and a reading on either side of that step says "stopped".
const moving = async () => {
  const clock = () => ev(`document.querySelector('#main-live video').currentTime`);
  let from = await clock();
  for (const end = Date.now() + 3000; Date.now() < end;) {
    await new Promise((r) => setTimeout(r, 150));
    const now = await clock();
    if (now > from + 0.25) return true;
    if (now < from) from = now;
  }
  return false;
};
const controls = () => ev(`(() => { const s = document.querySelector('.live-sound'); return s.hidden ? null : { bar: s.querySelector('input').value, button: s.querySelector('button').title, on: !document.querySelector('.live-sound-on').hidden }; })()`);

const media = () => ev(`document.querySelector('#main-live video').srcObject?.id ?? null`);
const bar = () => ev(`(() => { const b = document.getElementById('watch-bar'); return b.hidden ? null : [...b.querySelectorAll('.share-where span')].map((s) => s.textContent); })()`);
const menu = () => ev(`[...document.getElementById('menu').children].map((c) => c.classList.contains('sep') ? '-' : c.firstChild.textContent)`);
const rowMenu = async (who) => { await ev(`(() => { const r = [...document.querySelectorAll('#live-list .row.relay')].find((r) => r.dataset.who === '${who}'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`); await settle(200); return menu(); };
const sessionIds = async () => (await (await fetch(`http://127.0.0.1:${apiPort}/v3/webrtcsessions/list`, { headers: { Authorization: 'Basic ' + btoa('hub:hub-pass') } })).json()).items.map((x) => x.id);
const row = (who) => ev(`[...document.querySelectorAll('#live-list .row.relay')].find((r) => r.dataset.who === '${who}').click()`);

check('nobody streaming: LIVE is there, empty', [await live(), await ev(`document.getElementById('live-section').hidden`), (await (await api('GET', '/api/streams')).json()).relay], [null, false, []]);

// Alex starts streaming: within the hub's 5-second check, LIVE has a row with the stream icon.
const alexFeed = publish('alexcam', 0);
await until('LIVE', async () => (await live()) !== null, 20000);
check('LIVE has Alex’s stream', await live(), ['Alex (stream)']);
check('its icon is a satellite dish, not the screen share’s; its tooltip says stream', await ev(`(() => { const r = document.querySelector('#live-list .row.relay'); return [r.querySelector('svg path[d^="M4 10a7.31"]') !== null, r.querySelector('svg rect') === null, r.title]; })()`), [true, true, 'Watch Alex’s stream']);
check('the hub lists it with the hold-back', await (async () => { const b = await (await api('GET', '/api/streams')).json(); return [b.relay.map((s) => s.name + ':' + s.viewers.length), b.relayDelay, b.streams.length]; })(), [['Alex:0'], 300, 0]);
check('the relay answers nobody but the hub', (await fetch(`http://127.0.0.1:${whep}/alexcam-web/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0' })).status, 401);

// Watching: a click on the row.
await ev(`document.querySelector('#live-list .row.relay').click()`);
await until('the picture', async () => (await video()).picture, 20000);
check('address and panel', [await ev(`location.hash`), (await panel())?.title, (await panel())?.note], ['#stream=Alex', 'Alex’s stream', '']);
check('picture and sound arrive, sound on', await video(), { picture: true, muted: false, volume: 1, sound: 1 });
check('the picture moves', await moving(), true);
check('the sound controls show', await controls(), { bar: '100', button: 'Mute', on: false });
const rowMark = () => ev(`[...document.querySelector('#live-list .row.relay').classList].filter((c) => c === 'active' || c === 'playing')`);
check('the row is the open one (grey)', await rowMark(), ['active']);
await until('the viewer count', async () => (await panel())?.count === '1 watching', 12000);
// Its bar is the single-item bar every picture and post has: name and details, then Stop
// watching as a text button, the sound in an icon pill, and full screen last, in its own pill.
check('the stream’s bar follows the single-item bar', await ev(`(() => { const b = document.querySelector('#main-live .live-head'); const acts = [...b.querySelector('.single-actions').children];
  return [b.classList.contains('single-bar'), [...b.children].filter((e) => !e.hidden).slice(0, 2).map((e) => e.className.split(' ')[0]), acts.map((e) => e.tagName === 'BUTTON' ? e.textContent : e.className),
    [...b.querySelectorAll('.vtool')].map((v) => v.title.split(' (')[0]), b.querySelector('.single-full .vtool').getBoundingClientRect().width]; })()`),
  [true, ['single-name', 'single-info'], ['Stop watching', 'live-sound viewer-tools', 'viewer-tools single-full'], ['Mute', 'Full screen'], 30]);
check('Paul is counted', [(await panel())?.count, await ev(`document.querySelector('.live-count').title`), (await (await api('GET', '/api/streams')).json()).relay[0].viewers], ['1 watching', 'Paul', ['Paul']]);
// A stream sent with OBS takes a tag too; an admin's menu on someone's row can remove it.
await api('PUT', '/api/streams/tags/Alex', { tag: 'wither rose farm' }, 'Alex');
const tag = () => ev(`[[...document.querySelectorAll('#live-list .live-tag .live-chip')].map((c) => c.textContent), (() => { const c = document.querySelector('#main-live .live-head .live-chip'); return c && !c.hidden ? c.textContent : null; })()]`);
await until('Alex’s tag', async () => (await tag())[0].length === 1);
check('a relay stream’s tag: under its row and in the bar', await tag(), [['wither rose farm'], 'wither rose farm']);
await shot('watching');
await rowMenu('Alex');
check('the owner’s menu on it has Remove Tag', (await menu()).filter((i) => i.includes('Tag')), ['Remove Tag']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Remove Tag').click()`);
await until('the tag gone', async () => (await tag())[0].length === 0);
check('Remove Tag takes it away', await tag(), [[], null]);

// Volume and mute, kept for next time.
await ev(`(() => { const i = document.querySelector('.live-sound input'); i.value = '50'; i.dispatchEvent(new Event('input')); })()`);
check('half volume (cubed)', [(await video()).volume, await ev(`localStorage.getItem('mt-stream-sound')`)], [0.125, '{"level":50,"muted":false}']);
await ev(`document.querySelector('.live-sound button').click()`);
check('mute', [(await video()).muted, await controls()], [true, { bar: '0', button: 'Unmute', on: false }]);
await ev(`document.querySelector('.live-sound button').click()`);
check('unmute goes back to the level', [(await video()).muted, (await controls()).bar], [false, '50']);

// Opening something else leaves it playing: the chat shows, the stream goes on behind it with
// its sound, the relay keeps the one session, and a bar in the sidebar says so.
const first = await media();
check('the bar is up in the panel too; the row offers Stop Watching, not Watch', [await bar(), await rowMenu('Alex')], [['Watching', 'Alex’s stream'], ['Stop Watching', '-', 'Message']]);
await ev(`document.getElementById('menu').hidden = true`);
await ev(`location.hash = '#chan=general'`);
await until('the chat', () => ev(`!document.getElementById('main-chat').hidden`));
check('behind a chat: still drawn, still playing, same connection', [await ev(`document.getElementById('main-live').classList.contains('behind') && getComputedStyle(document.getElementById('main-live')).display !== 'none'`), await moving(), (await video()).muted, await sessions(), (await media()) === first], [true, true, false, 1, true]);
check('the bar says what is playing; the row is outlined, the chat’s row is the grey one', [await bar(), await rowMark(), await ev(`getComputedStyle(document.querySelector('#live-list .row.relay')).boxShadow !== 'none'`), await ev(`document.querySelectorAll('#side .row.active, #sidebar .row.active, .row.channel.active').length`)], [['Watching', 'Alex’s stream'], ['playing'], true, 1]);
check('still counted as watching', (await (await api('GET', '/api/streams')).json()).relay[0].viewers, ['Paul']);
await ev(`document.querySelector('#watch-bar > button.tool').click()`);
check('the bar mutes', [(await video()).muted, await ev(`document.querySelector('#watch-bar > button.tool').title`)], [true, 'Unmute']);
await ev(`document.querySelector('#watch-bar > button.tool').click()`);
await shot('behind');
await ev(`document.querySelector('#watch-bar .share-where').click()`);
await until('the panel back', async () => (await panel()) !== null);
check('the bar leads back to the same picture', [await ev(`location.hash`), await rowMark(), (await media()) === first, await sessions()], ['#stream=Alex', ['active'], true, 1]);

// Full screen is the picture with a bar over it: the sound, and a button out.
await ev(`document.querySelector('#main-live .live-head button[title^="Full screen"]').click()`);
await until('full screen', () => ev(`!!document.fullscreenElement`), 5000);
check('full screen: the picture’s box, with the controls and no bar across', [await ev(`document.fullscreenElement?.className`), await ev(`getComputedStyle(document.querySelector('.live-over')).display`), await ev(`document.querySelector('.live-over .live-sound').hidden`), await ev(`getComputedStyle(document.querySelector('.live-over')).backgroundColor`)], ['live-body', 'flex', false, 'rgba(0, 0, 0, 0)']);
await ev(`(() => { const i = document.querySelector('.live-over input'); i.value = '80'; i.dispatchEvent(new Event('input')); })()`);
check('its volume bar works, and the head’s follows', [(await video()).volume, (await controls()).bar], [0.512, '80']);
await ev(`(() => { const i = document.querySelector('.live-over input'); i.value = '50'; i.dispatchEvent(new Event('input')); })()`);
await shot('fullscreen');
await ev(`[...document.querySelectorAll('.live-over button')].find((b) => b.textContent === 'Exit full screen').click()`);
await until('out of full screen', () => ev(`!document.fullscreenElement`), 5000);
check('Exit full screen leaves it, still watching', [await ev(`!!document.fullscreenElement`), (await panel())?.note, await sessions()], [false, '', 1]);
check('outside full screen the bar is not there', await ev(`getComputedStyle(document.querySelector('.live-over')).display`), 'none');

// The connection drops (the relay ends the session): the page says so and connects again by
// itself, with no reload.
await ev(`(() => { window.sameDocument = true; window.notes = []; const n = document.querySelector('.live-note'); new MutationObserver(() => window.notes.push(n.hidden ? '' : n.firstChild?.textContent ?? '')).observe(n, { childList: true, attributes: true }); })()`);
const [before] = await sessionIds();
await fetch(`http://127.0.0.1:${apiPort}/v3/webrtcsessions/kick/${before}`, { method: 'POST', headers: { Authorization: 'Basic ' + btoa('hub:hub-pass') } });
await until('a new session', async () => { const ids = await sessionIds(); return ids.length === 1 && ids[0] !== before && (await panel())?.note === '' && (await moving()); }, 30000);
check('a dropped connection: Reconnecting…, then the picture again by itself', [(await ev(`window.notes`)).includes('Reconnecting…'), (await panel())?.note, await moving(), (await sessionIds()).includes(before), await ev(`window.sameDocument`), await ev(`location.hash`)], [true, '', true, false, true, '#stream=Alex']);
check('the sound is as it was', [(await video()).muted, (await video()).volume], [false, 0.125]);

// Stop Watching from the row, with a chat open: it ends, and the chat stays.
await ev(`location.hash = '#chan=general'`);
await until('the chat', () => ev(`!document.getElementById('main-chat').hidden`));
await rowMenu('Alex');
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Stop Watching').click()`);
await until('the session gone', async () => (await sessions()) === 0, 5000);
check('Stop Watching on the row: ended, bar gone, chat still open', [await sessions(), await bar(), await ev(`location.hash`), await ev(`document.getElementById('main-live').hidden`), await rowMenu('Alex')], [0, null, '#chan=general', true, ['Watch', '-', 'Message']]);
await ev(`document.getElementById('menu').hidden = true`);
await row('Alex');
await until('the picture again', async () => (await sessions()) === 1 && (await moving()), 20000);

// Stop watching: the relay's session ends at once, and the count drops.
check('one session on the relay', await sessions(), 1);
await ev(`[...document.querySelectorAll('#main-live .live-head button')].find((b) => b.textContent === 'Stop watching').click()`);
await until('the session gone', async () => (await sessions()) === 0, 5000);
check('Stop watching ends the session on the relay', [await sessions(), await ev(`document.getElementById('main-live').hidden`)], [0, true]);

// The address opened directly (no click): the browser refuses sound, so it plays muted with
// a button. The kept volume is still there. (The suite's Chromium plays sound unasked, so
// the refusal a member's browser gives is put in its place, on this one address.)
await send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.search === '?again') { const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { return this.muted ? play.call(this) : Promise.reject(new DOMException('no click yet', 'NotAllowedError')); }; }` });
await send('Page.navigate', { url: HUB + '/?again#stream=Alex' }); // another address, so the page loads afresh
await until('the picture after a reload', async () => (await quiet(`(() => { const v = document.querySelector('#main-live video'); return !!v && v.videoWidth > 0; })()`)), 20000);
await settle(300);
check('opened by address: muted, with Turn sound on', [await quiet(`document.querySelector('#main-live video').muted`), await quiet(`(() => { const b = document.querySelector('.live-sound-on'); return b.hidden ? null : b.textContent; })()`), await quiet(`document.querySelector('.live-sound input').value`)], [true, 'Turn sound on', '50']);
await ev(`document.querySelector('.live-sound-on').click()`);
check('Turn sound on', [(await video()).muted, (await controls()).on], [false, false]);

// A stream with B-frames: listed, but the relay won't send it to a browser. The page says why.
publish('stevecam', 2);
await until('Steve listed', async () => (await live())?.includes('Steve (stream)'), 20000);
check('both listed, oldest first', await live(), ['Alex (stream)', 'Steve (stream)']);
// (What the page shows from the click on is recorded, and printed if the note never comes.)
await ev(`(() => { const t0 = performance.now(); const tr = window.__bf = []; let last = ''; const add = (w) => tr.push([Math.round(performance.now() - t0), w]);
  const v = document.querySelector('#main-live video'); for (const e of ['playing', 'resize', 'emptied', 'waiting']) v.addEventListener(e, () => add('event ' + e + ' ' + v.videoWidth));
  setInterval(() => { const n = document.querySelector('.live-note'); const s = (n.hidden ? '' : n.firstChild?.textContent ?? '') + ' | ' + v.videoWidth + 'x' + v.videoHeight + ' | list ' + [...document.querySelectorAll('#live-list .row.relay')].map((r) => r.dataset.who).join(',');
    if (s !== last) { last = s; add(s); } }, 30); })()`);
await ev(`[...document.querySelectorAll('#live-list .row.relay')].find((r) => r.dataset.who === 'Steve').click()`);
if (!await until('the note', async () => (await panel())?.note.includes('can’t be shown'), 20000)) {
  for (const [t, what] of await quiet(`window.__bf`)) console.log(`      ${String(t).padStart(6)} ms  ${what}`);
}
check('a stream with B-frames says what it needs', (await panel())?.note, 'Steve’s stream can’t be shown in the hub: it needs the OBS setting bframes=0.');
// The relay sometimes lets a first frame of such a stream out before it ends the connection
// (seen when the viewer comes within seconds of the stream starting). The page must not take
// that one frozen picture for a stream that works and reconnect for ever: it says the same.
// Here the frame is put in the page's hands: the size a picture has, and its "playing".
await ev(`location.hash = '#chan=general'`);
await until('the chat', () => ev(`!document.getElementById('main-chat').hidden`));
await ev(`(() => { const v = document.querySelector('#main-live video'); const n = document.querySelector('.live-note');
  const o = new MutationObserver(() => { if (n.firstChild?.textContent !== 'Waiting for the picture…') return; o.disconnect();
    Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => 320 }); v.dispatchEvent(new Event('playing')); window.oneFrame = n.hidden; });
  o.observe(n, { childList: true, attributes: true }); })()`);
await ev(`[...document.querySelectorAll('#live-list .row.relay')].find((r) => r.dataset.who === 'Steve').click()`);
await until('the note after one frame', async () => (await panel())?.note.includes('can’t be shown'), 25000);
check('one frame that got through, then nothing: the same answer, not Reconnecting…', [await ev(`window.oneFrame`), (await panel())?.note], [true, 'Steve’s stream can’t be shown in the hub: it needs the OBS setting bframes=0.']);
await ev(`delete document.querySelector('#main-live video').videoWidth`);

// Someone who isn't streaming; then Alex's stream ends while Paul watches.
await ev(`location.hash = '#stream=Eve'`);
await until('the note', async () => (await panel())?.note.includes('isn’t streaming'));
check('nobody by that name streaming', (await panel())?.note, 'Eve isn’t streaming right now.');
await ev(`[...document.querySelectorAll('#live-list .row.relay')].find((r) => r.dataset.who === 'Alex').click()`);
await until('the picture again', async () => (await video()).picture, 20000);
// The stream blinks (the streamer's own connection): the page waits and plays it again.
alexFeed.kill();
await until('waiting', async () => (await panel())?.note.includes('Waiting'), 20000);
check('the stream gone: waiting for it', (await panel())?.note, 'Alex’s stream stopped. Waiting for it to come back…');
let feed = publish('alexcam', 0);
await until('back by itself', async () => (await panel())?.note === '' && (await sessions()) === 1 && (await moving()), 30000);
check('it came back: playing again by itself', [(await panel())?.note, await moving()], ['', true]);
// It ends for good: said after the wait.
feed.kill();
await until('stopped', async () => (await panel())?.note === 'Alex stopped streaming.', 40000);
check('the stream ending says so', [(await panel())?.note, await live()], ['Alex stopped streaming.', ['Steve (stream)']]);
// Streaming again later: the row plays it, though the address has not changed.
feed = publish('alexcam', 0);
await until('Alex listed again', async () => (await live())?.includes('Alex (stream)'), 20000);
check('the address is still the stream’s', await ev(`location.hash`), '#stream=Alex');
await row('Alex');
await until('playing again', async () => (await panel())?.note === '' && (await sessions()) === 1 && (await moving()), 20000);
check('the row plays a stream that ended and came back', [(await panel())?.note, await moving()], ['', true]);
// Ending while it plays behind a chat: a toast, and the bar goes.
await ev(`location.hash = '#chan=general'`);
await until('the chat', () => ev(`!document.getElementById('main-chat').hidden`));
feed.kill();
await until('waiting, on the bar', async () => (await bar())?.[0] === 'Waiting…', 20000);
check('behind a chat, the bar says it is waiting', await bar(), ['Waiting…', 'Alex’s stream']);
await until('the bar gone', async () => (await bar()) === null, 30000);
check('ended behind a chat: a toast, no bar, the panel put away', [await ev(`document.getElementById('toast').textContent`), await bar(), await ev(`document.getElementById('main-live').hidden`)], ['Alex stopped streaming.', null, true]);

// Your own stream, and a phone: the strip names other people's streams.
publish('paulcam', 0);
await until('Paul listed', async () => (await live())?.includes('Paul (stream)*'), 20000);
check('your own row', await ev(`document.querySelector('#live-list .row.relay.here').title`), 'You’re streaming');
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: HUB + '/?phone#chan=general' });
await until('the strip', () => quiet(`!document.getElementById('live-strip').hidden && getComputedStyle(document.getElementById('live-strip')).display !== 'none'`), 20000);
check('phone: the strip lists other people’s streams', await quiet(`[...document.querySelectorAll('.live-strip-item')].map((b) => b.textContent)`), ['Steve is streamingWatch']);
await ev(`location.hash = '#stream=Paul'`);
await until('phone picture', async () => (await video()).picture, 20000);
check('phone: your stream, a mute button and no volume bar', [(await panel())?.title, await ev(`getComputedStyle(document.querySelector('.live-sound input')).display`), await ev(`getComputedStyle(document.querySelector('.live-sound button')).display !== 'none'`)], ['Your stream', 'none', true]);
await shot('phone');

await done();
