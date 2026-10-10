// The voice lab (/voice-lab/), with Chromium's fake microphone: every filter loads from the
// hub, a recording comes back as five aligned tracks, the gates and players work, and the CPU
// measurement fills in. FAKE_AUDIO=<wav> records that file instead of the beeps.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, DATA, done, ev, HUB, send, settle, shot, sleep } from './lib.mjs';

const until = async (what, js, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await settle(200)) if (await ev(js)) return;
  throw new Error(`timed out waiting for ${what}: ${await ev(`document.getElementById('status').textContent`)}`);
};
const statusText = () => ev(`document.getElementById('status').textContent`);

// Logged out: it says so instead of loading 40 MB of filters.
await send('Network.clearBrowserCookies');
await send('Page.navigate', { url: `${HUB}/voice-lab/` });
await until('the page', `document.getElementById('status').textContent.startsWith('Log in')`);
check('logged out: asks to log in', await statusText(), 'Log in on the hub first, then come back to this page. Go to the hub');
const { as } = await import('./lib.mjs');
await as('Paul');

await send('Page.navigate', { url: `${HUB}/voice-lab/` });
await until('the filters to load', `document.getElementById('status').textContent.startsWith('Ready')`, 60000);
check('record button ready', await ev(`document.getElementById('record').disabled`), false);

await ev(`document.getElementById('record').click()`);
await until('recording', `document.getElementById('status').textContent.startsWith('Recording')`);
check('stop button is red', await ev(`document.getElementById('record').className`), 'danger');
// The fake microphone beeps once a second, so watch the meter for a while.
let moved = false;
for (let i = 0; i < 30 && !moved; i++, await settle(100)) moved = await ev(`parseFloat(document.querySelector('#meter > div').style.width) > 0`);
check('the level meter moves', moved, true);
await sleep(process.env.FAKE_AUDIO ? 20000 : 6000); // the length of the recording
await ev(`document.getElementById('record').click()`);
await until('the analysis', `!document.getElementById('results').hidden`, 120000);
console.log('status:', await statusText());

const tracks = await ev(`[...document.querySelectorAll('.track')].map((t) => [t.dataset.id, t.style.opacity !== '.45'])`);
check('five tracks, all recorded', tracks, [['raw', true], ['browser', true], ['rnnoise', true], ['gtcrn', true], ['dfn3', true]]);
const stats = await ev(`Object.fromEntries([...document.querySelectorAll('#stats tr')].map((r) => [r.cells[0].textContent, r.cells[1].textContent]))`);
console.log(stats);
// Headless Chromium's fake microphone can't give one capture suppression and not the other;
// the page says so rather than pretending.
check('browser track says what it got', /^(separate capture, suppression on|the browser reports)/.test(stats['Browser track']), true);
for (const n of ['RNNoise', 'GTCRN', 'DeepFilterNet3']) {
  const ms = Number(stats[n]?.match(/adds (\d+) ms/)?.[1]);
  check(`${n}: a delay was measured (0-300 ms)`, ms >= 0 && ms <= 300, true);
}

// Playing, switching tracks with the keys, keeping the place.
await ev(`document.getElementById('play').click()`);
await settle(1200);
check('playing', await ev(`document.getElementById('play').textContent`), 'Pause');
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '5' }))`);
await settle(300);
check('5 picks DeepFilterNet3', await ev(`document.querySelector('.track.on').dataset.id`), 'dfn3');
check('still playing, not from the start', await ev(`parseInt(document.getElementById('pos').value) > 0 && document.getElementById('play').textContent === 'Pause'`), true);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))`);
await settle(200);
check('Space pauses', await ev(`document.getElementById('play').textContent`), 'Play');

// The gates: off shows no open stretches' sensitivity, the volume gate shows dB.
await ev(`(() => { const g = document.getElementById('gate'); g.value = 'level'; g.dispatchEvent(new Event('change')); })()`);
check('volume gate shows a dB threshold', await ev(`document.getElementById('sens-val').textContent`), '-45 dB');
await ev(`(() => { const g = document.getElementById('gate'); g.value = 'off'; g.dispatchEvent(new Event('change')); })()`);
check('gate off hides sensitivity', await ev(`document.getElementById('sens-label').hidden`), true);
await ev(`(() => { const g = document.getElementById('gate'); g.value = 'speech'; g.dispatchEvent(new Event('change')); })()`);
check('speech gate shows a probability', await ev(`document.getElementById('sens-val').textContent`), '0.50');
await shot('results');

await ev(`document.getElementById('speed').click()`);
await until('the CPU measurement', `document.getElementById('speed').textContent === 'Measure CPU cost' && /core/.test(document.getElementById('stats').textContent)`, 120000);
const cpu = await ev(`[...document.querySelectorAll('#stats tr')].filter((r) => /faster/.test(r.cells[1].textContent)).length`);
check('CPU cost for all three filters', cpu, 3);
console.log(await ev(`[...document.querySelectorAll('#stats tr')].map((r) => r.cells[0].textContent + ': ' + r.cells[1].textContent).join('\\n')`));

// Each take and CPU measurement left a report in voice-lab.jsonl, as Paul.
const reports = () => readFileSync(join(DATA, 'voice-lab.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
await settle(500);
const rs = reports();
const t = rs.find((r) => r.report.kind === 'take');
check('a take report, by Paul', [t?.user, Object.keys(t?.report.perSecondDb ?? {}).sort()], ['Paul', ['browser', 'dfn3', 'gtcrn', 'raw', 'rnnoise']]);
check('it has the numbers and the capture settings', [typeof t?.report.numbers?.Length, typeof t?.report.capture?.main?.echoCancellation], ['string', 'boolean']);
check('and a CPU report', /core/.test(rs.find((r) => r.report.kind === 'cpu')?.report.numbers?.DeepFilterNet3 ?? ''), true);

// A take without the second capture: no Browser track, and every other track still drawn.
await ev(`document.getElementById('opt-second').checked = false`);
await ev(`document.getElementById('record').click()`);
await until('recording again', `document.getElementById('status').textContent.startsWith('Recording')`);
await settle(3000);
await ev(`document.getElementById('record').click()`);
await until('the second analysis', `document.getElementById('status').textContent.startsWith('Recorded')`, 120000);
check('browser track not recorded', await ev(`document.querySelector('.track[data-id=browser] .note').textContent`), "not recorded (switched off for this take)");
const drawn = (id) => ev(`(() => { const c = document.querySelector('.track[data-id=${id}] canvas'); return c.width > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0); })()`);
check('tracks after the missing one are drawn', [await drawn('raw'), await drawn('rnnoise'), await drawn('gtcrn'), await drawn('dfn3')], [true, true, true, true]);

await done();
