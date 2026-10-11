// Relay streams, end to end: a local MediaMTX (fetched/mediamtx) stands in for the stream
// relay and ffmpeg (on the PATH) for OBS, publishing a moving picture and a tone as
// "<channel>-web", which is what the relay's own conversion produces. Paul watches Alex's
// stream: the row in LIVE with its own icon, #stream=, picture and sound, the viewer count,
// the volume kept, sound refused without a click, a stream with B-frames, the stream ending,
// and a phone.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { api, check, DATA, done, ev as quiet, HUB, send, settle, shot } from './lib.mjs';
import { ensureMediamtx } from './support/mediamtx.mjs';

const MTX = ensureMediamtx();
if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('the relay suite needs ffmpeg (with libx264 and libopus) on the PATH; skip it: node test/browser/run.mjs <the other suites>');
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const [rtsp, whep, apiPort, ice] = [await freePort(), await freePort(), await freePort(), await freePort()];
const conf = join(DATA, 'mediamtx.yml');
writeFileSync(conf, `logLevel: warn
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
run(MTX, [conf]);
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

await send('Page.navigate', { url: HUB });
await until('the page', () => ev(`!!document.getElementById('channels').children.length`));
await settle(300);

const live = () => ev(`document.getElementById('live-section').hidden ? null : [...document.querySelectorAll('#live-list .row.live')].map((r) => r.dataset.who + (r.classList.contains('relay') ? ' (stream)' : '') + (r.classList.contains('here') ? '*' : ''))`);
const panel = () => ev(`document.getElementById('main-live').hidden ? null : { title: document.querySelector('.live-title').textContent, count: document.querySelector('.live-count').textContent, note: document.querySelector('.live-note').hidden ? '' : document.querySelector('.live-note').firstChild?.textContent ?? '' }`);
const video = () => ev(`(() => { const v = document.querySelector('#main-live video'); return { picture: v.videoWidth > 0 && v.readyState >= 2, muted: v.muted, volume: Math.round(v.volume * 1000) / 1000, sound: v.srcObject?.getAudioTracks().length ?? 0 }; })()`);
const moving = async () => { const a = await ev(`document.querySelector('#main-live video').currentTime`); await settle(700); return (await ev(`document.querySelector('#main-live video').currentTime`)) > a; };
const controls = () => ev(`(() => { const s = document.querySelector('.live-sound'); return s.hidden ? null : { bar: s.querySelector('input').value, button: s.querySelector('button').title, on: !document.querySelector('.live-sound-on').hidden }; })()`);

check('nobody streaming: no LIVE', [await live(), (await (await api('GET', '/api/streams')).json()).relay], [null, []]);

// Alex starts streaming: within the hub's 5-second check, LIVE has a row with the stream icon.
const alexFeed = publish('alexcam', 0);
await until('LIVE', async () => (await live()) !== null, 20000);
check('LIVE has Alex’s stream', await live(), ['Alex (stream)']);
check('its icon is not the screen share’s, its tooltip says stream', await ev(`(() => { const r = document.querySelector('#live-list .row.relay'); return [r.querySelector('svg circle') !== null, r.title]; })()`), [true, 'Watch Alex’s stream']);
check('the hub lists it with the hold-back', await (async () => { const b = await (await api('GET', '/api/streams')).json(); return [b.relay.map((s) => s.name + ':' + s.viewers.length), b.relayDelay, b.streams.length]; })(), [['Alex:0'], 300, 0]);
check('the relay answers nobody but the hub', (await fetch(`http://127.0.0.1:${whep}/alexcam-web/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0' })).status, 401);

// Watching: a click on the row.
await ev(`document.querySelector('#live-list .row.relay').click()`);
await until('the picture', async () => (await video()).picture, 20000);
check('address and panel', [await ev(`location.hash`), (await panel())?.title, (await panel())?.note], ['#stream=Alex', 'Alex’s stream', '']);
check('picture and sound arrive, sound on', await video(), { picture: true, muted: false, volume: 1, sound: 1 });
check('the picture moves', await moving(), true);
check('the sound controls show', await controls(), { bar: '100', button: 'Mute', on: false });
check('the row is the active one', await ev(`document.querySelector('#live-list .row.relay').classList.contains('active')`), true);
await until('the viewer count', async () => (await panel())?.count === '1 watching', 12000);
check('Paul is counted', [(await panel())?.count, await ev(`document.querySelector('.live-count').title`), (await (await api('GET', '/api/streams')).json()).relay[0].viewers], ['1 watching', 'Paul', ['Paul']]);
await shot('watching');

// Volume and mute, kept for next time.
await ev(`(() => { const i = document.querySelector('.live-sound input'); i.value = '50'; i.dispatchEvent(new Event('input')); })()`);
check('half volume (cubed)', [(await video()).volume, await ev(`localStorage.getItem('mt-stream-sound')`)], [0.125, '{"level":50,"muted":false}']);
await ev(`document.querySelector('.live-sound button').click()`);
check('mute', [(await video()).muted, await controls()], [true, { bar: '0', button: 'Unmute', on: false }]);
await ev(`document.querySelector('.live-sound button').click()`);
check('unmute goes back to the level', [(await video()).muted, (await controls()).bar], [false, '50']);

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
await ev(`[...document.querySelectorAll('#live-list .row.relay')].find((r) => r.dataset.who === 'Steve').click()`);
await until('the note', async () => (await panel())?.note.includes('can’t be shown'), 20000);
check('a stream with B-frames says what it needs', (await panel())?.note, 'Steve’s stream can’t be shown in the hub: it needs the OBS setting bframes=0.');

// Someone who isn't streaming; then Alex's stream ends while Paul watches.
await ev(`location.hash = '#stream=Eve'`);
await until('the note', async () => (await panel())?.note.includes('isn’t streaming'));
check('nobody by that name streaming', (await panel())?.note, 'Eve isn’t streaming right now.');
await ev(`[...document.querySelectorAll('#live-list .row.relay')].find((r) => r.dataset.who === 'Alex').click()`);
await until('the picture again', async () => (await video()).picture, 20000);
alexFeed.kill();
await until('stopped', async () => (await panel())?.note.includes('stopped'), 20000);
check('the stream ending says so', [(await panel())?.note, await live()], ['Alex stopped streaming.', ['Steve (stream)']]);

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
