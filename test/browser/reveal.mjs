// Things inside a panel slide open and shut (style guide 5, Motion): the one suite that runs
// with motion on (lib.mjs). Each check samples a size on every frame (frames in lib.mjs) and
// fails on a page that pops: there the first frame is already the last.
import { api, check, done, ev, frames, HUB, send, settle, STILL } from './lib.mjs';

const farm = await (await api('POST', '/api/channels/general/messages', { text: 'farm is up' })).json();
await api('POST', '/api/channels', { name: 'builds' }, 'Paul');
await send('Page.navigate', { url: HUB });
await settle(500);
await ev(`localStorage.setItem('mt-chat-hidden','1')`);
await send('Page.navigate', { url: `${HUB}/?r=1#chan=general` });
await settle(2000);

// What a run of sizes shows: something between its ends, only one way, how it ended.
const between = (xs, lo, hi) => xs.some((v) => v > lo + 0.5 && v < hi - 0.5);
const oneWay = (xs, up) => xs.every((v, i) => !i || (up ? v >= xs[i - 1] - 0.5 : v <= xs[i - 1] + 0.5));
const size = (el, w = false) => `((e) => e.hidden ? 0 : e.getBoundingClientRect().${w ? 'width' : 'height'})(${el})`;
const left = () => ev(`document.getAnimations().length`);

// ---- Voice Settings: rows, the dialog growing round its middle, warning lines ----
await ev(`document.getElementById('user').click()`);
await settle(150);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Voice Settings').click()`);
await settle(800);
const rowOf = (t) => `[...document.querySelectorAll('#dialog .set-row')].find((r) => r.querySelector('.set-title').textContent === '${t}')`;
const pick = (t, v) => `(() => { const s = ${rowOf(t)}.querySelector('select'); s.value = '${v}'; s.dispatchEvent(new Event('change')); })()`;
const gainRow = size(rowOf('Microphone gain'));
// (the dialog's content: in the test's short window it is at its most and scrolls, 6.8)
const dialog = `document.getElementById('dialog').scrollHeight`;

let run = await frames(pick('Gain', 'manual'), `[${gainRow}, ${dialog}]`);
let row = run.map((f) => f[0]), dlg = run.map((f) => f[1]);
const full = row.at(-1);
check('Gain → Manual: Microphone gain slides open (shut at first, below its 48 px least on the way), the dialog’s content grows all the way',
  [row[0], between(row, 0, 48), full >= 48, oneWay(row, true), oneWay(dlg, true), dlg.at(-1) > dlg[0], await left()], [0, true, true, true, true, true, 0]);
check('and nothing is left on it', await ev(`${rowOf('Microphone gain')}.getAttribute('style')`), null);

run = await frames(pick('Gain', 'auto'), gainRow);
check('Auto: it slides shut and ends hidden', [between(run, 0, full), oneWay(run, false), await ev(`${rowOf('Microphone gain')}.hidden`)], [true, true, true]);

// Turned round midway, both ways: it never reaches the far end, and never jumps.
const jumps = (xs) => xs.some((v, i) => i && Math.abs(v - xs[i - 1]) > full / 2);
run = await frames(`${pick('Gain', 'manual')}; setTimeout(() => ${pick('Gain', 'auto')}, 70)`, gainRow);
check('opening, turned round midway: back to shut without reaching open or jumping', [Math.max(...run) < full - 0.5, jumps(run), run.at(-1)], [true, false, 0]);
await ev(pick('Gain', 'manual'));
await settle(400);
run = await frames(`${pick('Gain', 'auto')}; setTimeout(() => ${pick('Gain', 'manual')}, 70)`, gainRow);
check('closing, turned round midway: back to open without reaching shut or jumping', [Math.min(...run) > 0.5, jumps(run), run.at(-1)], [true, false, full]);

// The red line under Gain came with Manual; it goes with Auto, sliding too.
const warn = size(`${rowOf('Gain')}.querySelector('.set-warn')`);
run = await frames(pick('Gain', 'auto'), warn);
check('a warning line slides shut', [between(run, 0, run[0]), run.at(-1)], [true, 0]);
await settle(300);

// One row out, three in, together: the dialog's content never leaves the span of its ends.
run = await frames(pick('Activation method', 'ptt'), dialog);
const shown = (t) => ev(`!${rowOf(t)}.hidden`);
check('Voice → Push to Talk: the rows swap in one move', [Math.min(...run) >= Math.min(run[0], run.at(-1)) - 0.5, Math.max(...run) <= Math.max(run[0], run.at(-1)) + 0.5,
  await shown('Push to Talk key'), await shown('Voice activation'), await shown('Keyboard noise gate')], [true, true, true, false, false]);
await ev(pick('Activation method', 'voice'));
await settle(400);

// Reduced motion: instant.
await send('Emulation.setEmulatedMedia', { features: STILL });
run = await frames(pick('Gain', 'manual'), gainRow, 100);
check('reduced motion: open in the first frame', [run[0], run[0] === run.at(-1)], [full, true]);
await ev(pick('Gain', 'auto'));
await send('Emulation.setEmulatedMedia', { features: [] });
await ev(`document.querySelector('#dialog .dialog-x').click()`);
await settle(200);

// ---- Chat: the reply bar and the tray, sliding; another chat's tray drawn at once ----
const M = '#main-chat';
const reply = size(`document.querySelector('${M} .reply-bar')`);
run = await frames(`document.querySelector('${M} .msg[data-id="${farm.id}"] .msg-tools [data-tool="reply"]').click()`, reply);
check('Reply: the bar slides open', [run[0], between(run, 0, run.at(-1)), run.at(-1) > 0], [0, true, true]);
run = await frames(`document.querySelector('${M} .reply-bar button').click()`, reply);
check('its x: the bar slides shut', [between(run, 0, run[0]), run.at(-1)], [true, 0]);

const drop = (name) => `(() => { const dt = new DataTransfer(); dt.items.add(new File(['text'], '${name}', { type: 'text/plain' }));
  document.querySelector('${M} .chat-body').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`;
const tray = `[${size(`document.querySelector('${M} .pend-tray')`)}, document.querySelectorAll('${M} .pend-tray .pend').length]`;
run = await frames(drop('plan.txt'), tray, 600);
const trayH = run.at(-1)[0];
check('a first file: the tray slides open', [run[0][0], between(run.map((f) => f[0]), 0, trayH), run.at(-1)[1]], [0, true, 1]);
await ev(`location.hash = '#chan=builds'`);
await settle(800);
run = await frames(`location.hash = '#chan=general'`, `${size(`document.querySelector('${M} .pend-tray')`)}`, 600);
check('back in the chat with the file: its tray is drawn at once, not slid', [between(run, 0, trayH), run.at(-1)], [false, trayH]);
run = await frames(`document.querySelector('${M} .pend [title="Remove file"]').click()`, tray, 600);
check('its last file removed: the tray slides shut with the card still in it', [between(run.map((f) => f[0]), 0, trayH), run.filter((f) => f[0] > 0).every((f) => f[1] === 1), run.at(-1)[0]], [true, true, 0]);

// ---- Files: the screenshots folder's filters slide out sideways; another folder at once ----
await ev(`document.querySelector('.row[data-path="screenshots"]').click()`);
await settle(800);
const filters = size(`document.querySelector('#main-folder .filters')`, true);
const toggle = `document.querySelector('#main-folder .filters-toggle').click()`;
run = await frames(toggle, `[${filters}, document.querySelector('#main-folder .filters').getBoundingClientRect().height]`);
const fW = run.at(-1)[0];
check('Filters: they slide out sideways, on one line as they go', [run[0][0], between(run.map((f) => f[0]), 0, fW), run.filter((f) => f[0] > 0).every((f) => f[1] <= run.at(-1)[1] + 0.5)], [0, true, true]);
run = await frames(toggle, filters);
check('and back in', [between(run, 0, fW), run.at(-1)], [true, 0]);
await ev(toggle);
await settle(400);
run = await frames(`document.querySelector('.row[data-path="map art"]').click()`, filters);
check('opening another folder puts them away at once, not slid', [between(run, 0, fW), run.at(-1)], [false, 0]);

await done();
