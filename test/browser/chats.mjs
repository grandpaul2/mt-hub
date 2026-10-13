// The TEXT list: unread, right-click menu, inline rename, delete, admin-only actions.
import { answerDialogs, api, as, check, done, ev, HUB, key, send, settle, shot, typeText } from './lib.mjs';

await api('POST', '/api/channels', { name: 'builds' });
await api('POST', '/api/channels', { name: 'redstone' });
await api('POST', '/api/channels/builds/messages', { text: 'new farm is up' });
await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','["boards"]'); localStorage.setItem('mt-chat-side','general')`);
await send('Page.reload');
await settle(2000);
const chans = () => ev(`[...document.querySelectorAll('#channels .row')].map((r) => r.querySelector('.name')?.textContent + (r.classList.contains('unread') ? '*' : ''))`);
const menuFor = async (name) => {
  await ev(`[...document.querySelectorAll('#channels .row')].find((r) => r.textContent === '#${name}').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 500 }))`);
  return ev(`[...document.querySelectorAll('#menu button span:first-child')].map((s) => s.textContent)`);
};
const pick = (label) => ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('${label}')).click()`);
await ev(`document.activeElement.blur()`);
check('list, builds unread', await chans(), ['builds*', 'general', 'redstone']);
await shot('sidebar');
check('style', await ev(`(() => { const r = document.querySelector('#channels .row'); const hs = getComputedStyle(r.querySelector('.hash'));
  const t = getComputedStyle(document.querySelector('#tree .row .name'));
  return [r.offsetHeight, hs.fontSize, t.fontSize, t.color]; })()`), [34, '23px', '14px', 'rgb(224, 224, 224)']);

check('admin menu on unread', await menuFor('builds'), ['Open', 'Open in Side Panel', 'Mark as Read', 'Copy Link', 'Move Down', 'Make Private…', 'Rename…', 'Delete']);
await pick('Mark as Read');
await settle(200);
check('marked read', await chans(), ['builds', 'general', 'redstone']);
check('read menu has no Mark as Read', (await menuFor('general')).includes('Mark as Read'), false);
await pick('Open in Side Panel');
await settle(300);
check('side panel shows general', await ev(`document.getElementById('chat-select').value`), 'general');
await menuFor('builds');
await pick('Open');
await settle(300);
check('open in main', [await ev(`decodeURIComponent(location.hash)`), await ev(`document.getElementById('main-chat-title').textContent`)], ['#chan=builds', '# builds']);

// Rename inline; the main pane follows.
await menuFor('builds');
await pick('Rename');
await settle(200);
check('rename box', await ev(`document.querySelector('#channels input.rename')?.value`), 'builds');
await typeText('Farm Builds');
await key('Enter');
await settle(800);
check('renamed (normalized)', await chans(), ['farm-builds', 'general', 'redstone']);
check('main pane followed', [await ev(`decodeURIComponent(location.hash)`), await ev(`document.getElementById('main-chat-title').textContent`)], ['#chan=farm-builds', '# farm-builds']);
check('messages kept', await ev(`[...document.querySelectorAll('#main-chat-body .msg-body')].map((m) => m.textContent)`), ['new farm is up']);
await menuFor('general');
await pick('Rename');
await settle(100);
await key('Escape');
await settle(200);
check('escape cancels', await chans(), ['farm-builds', 'general', 'redstone']);

// Delete.
await answerDialogs(true);
await menuFor('redstone');
await pick('Delete');
await settle(800);
check('deleted', await chans(), ['farm-builds', 'general']);

// Non-admins: no rename/delete in the menu, and the server refuses.
check('server refuses non-admin', [(await api('PATCH', '/api/channels/general', { name: 'x' })).status, (await api('DELETE', '/api/channels/general')).status], [403, 403]);
await as('Alex');
await send('Page.reload');
await settle(2000);
check('non-admin menu', await menuFor('general'), ['Open', 'Open in Side Panel', 'Copy Link']);

// Both side panels resize by dragging their inner edge; the width sticks across a reload,
// and a double-click restores the default.
const drag = async (sel, dx) => {
  const [x, y] = await ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + 200]; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y, button: 'left', clickCount: 1 });
  await settle(200);
};
const sideW = () => ev(`document.getElementById('side').offsetWidth`);
const w0 = await sideW();
await drag('#side-resize', 100);
const w1 = await sideW();
check('sidebar drag widens it', Math.abs(w1 - (w0 + 100)) <= 3, true);
await send('Page.reload');
await settle(1500);
check('width kept across reload', await sideW(), w1);
await ev(`document.getElementById('side-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
await settle(200);
check('double-click: default width', await sideW(), w0);

// The day divider: the date in the middle of a line across the feed (Discord's).
await api('POST', '/api/channels/general/messages', { text: 'a day' });
await settle(800);
check('day divider: centred, a line each side', await ev(`(() => { const d = document.querySelector('#chat-body .day'); if (!d) return null;
  const r = d.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(d); const t = range.getBoundingClientRect();
  return [d.textContent, getComputedStyle(d, '::before').borderTopStyle, Math.abs((t.left + t.right) / 2 - (r.left + r.right) / 2) < 2]; })()`), ['Today', 'solid', true]);
await shot('day-divider');

// A chat's row is the open one (grey) only while the chat is the main panel: a folder opened
// from it, by its address, takes the mark away.
await ev(`location.hash = '#chan=general'`);
await settle(800);
const openRows = () => ev(`[...document.querySelectorAll('#channels .row.active .name')].map((r) => r.textContent)`);
check('the open chat’s row is marked', await openRows(), ['general']);
await ev(`location.hash = '#folder=docs'`);
await settle(800);
check('a folder in the main panel: no chat row is marked', [await ev(`document.getElementById('main-folder').hidden`), await openRows()], [false, []]);

// One height for every panel's bar, so the lines under them meet across the three columns:
// the sidebar's head, the main panel's bar whatever it shows, and the side chat's.
const barEnds = () => ev(`['#side > .side-head', '#main > :not([hidden]) .chat-head, #main > :not([hidden]) #toolbar, #main > :not([hidden]) .single-bar', '#chat .chat-head'].map((sel) => { const e = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length); return e ? e.getBoundingClientRect().bottom : null; })`);
// (In a window wide enough for each bar to be one line; a narrow panel's bar wraps to two.)
await send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 900, deviceScaleFactor: 1, mobile: false });
const ends = {};
for (const hash of ['#chan=general', '#folder=docs', '#docs/guide.md', '#screenshots/2026-09-01 15.00.01 Paul.png', '#schems', '#schem=Build 2']) {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  await settle(900);
  ends[hash] = await barEnds();
}
check('the bars end on one line, whatever the main panel shows', ends, Object.fromEntries(Object.keys(ends).map((k) => [k, [75, 75, 75]])));

await done();
