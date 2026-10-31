// Chat scroll position while the list changes size (the side panel resized, so every message
// rewraps): at the bottom it stays at the bottom; scrolled up, the message on the bottom edge
// stays put; and resizing doesn't stop new messages from scrolling into view.
import { api, check, done, ev, frames, HUB, send, settle, STILL } from './lib.mjs';

const words = 'the restock line runs from the crafters to the bulk and then the list maker unlocks each slice in turn'.split(' ');
for (let i = 0; i < 120; i++) {
  const n = 3 + ((i * 7) % 40);
  await api('POST', '/api/channels/general/messages', { text: `m${i} ` + Array.from({ length: n }, (_, k) => words[(i + k) % words.length]).join(' ') }, i % 3 ? 'Paul' : 'Alex');
}
const L = `document.querySelector('#chat .messages')`;
// setWidth changes the side panel's width as dragging its edge does, then waits for two drawn
// frames (the chat holds its place just before a frame is drawn).
const setWidth = (w) => ev(`new Promise((ok) => { document.body.style.setProperty('--chat-w', '${w}px'); requestAnimationFrame(() => requestAnimationFrame(ok)); })`);
const gap = () => ev(`(() => { const l = ${L}; return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight); })()`);
// edge: the message on the bottom edge of the view, and how far its bottom is above the view's.
const edge = () => ev(`(() => { const r = ${L}.getBoundingClientRect(); const e = document.elementFromPoint(r.left + 120, r.bottom - 12).closest('.msg');
  return e.querySelector('.msg-body').textContent.split(' ')[0] + ' ' + Math.round(r.bottom - e.getBoundingClientRect().bottom); })()`);
const widths = [...Array.from({ length: 11 }, (_, i) => 340 - i * 10), ...Array.from({ length: 31 }, (_, i) => 240 + i * 12), ...Array.from({ length: 11 }, (_, i) => 600 - i * 26)];

await send('Page.navigate', { url: `${HUB}/#README.md` });
await settle(2000);
await setWidth(340);

// At the bottom: still at the bottom at every width.
const gaps = [];
for (const w of widths) { await setWidth(w); gaps.push(await gap()); }
check('at the bottom through a resize', Math.max(...gaps), 0);
await api('POST', '/api/channels/general/messages', { text: 'newest after the resize' }, 'Alex');
await settle(1200);
check('a new message after resizing scrolls in', [await gap(), await ev(`[...${L}.querySelectorAll('.msg-body')].pop().textContent`)], [0, 'newest after the resize']);

// Scrolled up to read: the message on the bottom edge stays where it is.
await ev(`${L}.scrollTop = ${L}.scrollHeight / 2`);
await settle(300);
// (Scrolling is in whole pixels, so it may be off by one; the old code drifted by hundreds.)
const before = (await edge()).split(' ');
const moved = new Set();
for (const w of widths) {
  await setWidth(w);
  const [id, off] = (await edge()).split(' ');
  moved.add(id === before[0] && Math.abs(off - before[1]) <= 1 ? 'held' : `${id} ${off} (was ${before.join(' ')})`);
}
check('scrolled up: the bottom message holds its place', [...moved], ['held']);
check('scrolled up: not pulled to the bottom', (await gap()) > 1000, true);

// The reply bar sliding open under the messages (motion on for this, style guide 5): the chat
// holds its place on every frame, at the bottom and scrolled up.
await send('Emulation.setEmulatedMedia', { features: [] });
const replyTo = (where) => `${L}.querySelector('.msg${where} .msg-tools [data-tool="reply"]').click()`;
const gapNow = `(() => { const l = ${L}; return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight); })()`;
await ev(`${L}.scrollTop = ${L}.scrollHeight`);
await settle(300);
let run = await frames(replyTo(':last-of-type'), gapNow, 400, true);
check('the reply bar opening: at the bottom on every frame', Math.max(...run), 0);
await ev(`document.querySelector('#chat .reply-bar button').click()`);
await settle(400);
await ev(`${L}.scrollTop = ${L}.scrollHeight / 2`);
await settle(300);
const edgeNow = `(() => { const r = ${L}.getBoundingClientRect(); const e = document.elementFromPoint(r.left + 120, r.bottom - 12).closest('.msg');
  return e.querySelector('.msg-body').textContent.split(' ')[0] + ' ' + Math.round(r.bottom - e.getBoundingClientRect().bottom); })()`;
// (This check once failed beside something heavy, and then passed three full runs of every suite
// at once, 2026-10-30. If it fails again, the failing frame's numbers are in its message.)
run = await frames(replyTo(''), edgeNow, 400, true);
const [id0, off0] = run[0].split(' ');
check('scrolled up: the bottom message holds its place on every frame (to a whole pixel, as above)',
  [...new Set(run.map((e) => { const [id, off] = e.split(' '); return id === id0 && Math.abs(off - off0) <= 1 ? 'held' : `${e} (was ${run[0]})`; }))], ['held']);
await send('Emulation.setEmulatedMedia', { features: STILL });

await done();
