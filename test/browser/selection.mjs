// Selecting several files: Ctrl and Shift in the tree, Ctrl, Shift and a dragged box in the
// folder view, and what a selection does: the menu, moving (all or nothing), deleting after
// one question, a zip, links in chat. The tree and the folder view each keep their own.
import { answerDialogs, api, check, done, ev, HUB, hub, key, send, settle, shot } from './lib.mjs';

const CTRL = 2, SHIFT = 8;
const put = (p) => hub(`/api/file/${encodeURIComponent(p).replace(/%2F/g, '/')}?base=`, { method: 'PUT', body: p });
const files = async () => (await (await hub('/api/tree')).json()).filter((e) => !e.dir).map((e) => e.path);
const has = async (...paths) => { const all = await files(); return paths.map((p) => all.includes(p)); };
for (const p of ['one.md', 'two.md', 'three.md', 'four.md', 'notes/two.md']) await put(p);

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','["docs","notes"]')`);
await send('Page.navigate', { url: `${HUB}/?r=1#README.md` });
await settle(1500);

const row = (p) => `document.querySelector('#tree .row[data-path=${JSON.stringify(p)}]')`;
const tile = (p) => `document.querySelector('#main-folder .shot[data-path=${JSON.stringify(p)}]')`;
const rows = () => ev(`[...document.querySelectorAll('#tree .row[data-path]')].map((r) => r.dataset.path)`);
const selected = () => ev(`[...document.querySelectorAll('#tree .row.selected')].map((r) => r.dataset.path)`);
const picked = () => ev(`[...document.querySelectorAll('#main-folder .shot.picked')].map((r) => r.dataset.path)`);
const active = () => ev(`document.querySelector('#tree .row.active')?.dataset.path ?? null`);
const toastText = () => ev(`document.getElementById('toast').firstChild?.textContent ?? ''`); // (without its Undo button)
const hash = () => ev(`decodeURIComponent(location.hash)`);
const menu = () => ev(`document.getElementById('menu').hidden ? null : [...document.querySelectorAll('#menu > button')].map((b) => b.firstChild.textContent)`);
const menuPick = (label) => ev(`[...document.querySelectorAll('#menu > button')].find((b) => b.firstChild.textContent === ${JSON.stringify(label)}).click()`);
const closeMenu = () => key('Escape');
const centre = (el) => ev(`(() => { const el = ${el}; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
// A real click, with Ctrl or Shift held.
const click = async (el, modifiers = 0) => {
  const [x, y] = await centre(el);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, modifiers });
  await settle(300);
};
const rightClick = async (el) => {
  await ev(`(() => { const el = ${el}; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 5 })); })()`);
  await settle(200);
};
const chord = async (k, code, vk, modifiers) => {
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await settle(250);
};
const ctrlA = () => chord('a', 'KeyA', 65, CTRL);
// A drag from one element to another, as the page sees it. Returns whether the drop was allowed.
const drag = async (from, to) => {
  const ok = await ev(`(() => { const dt = new DataTransfer();
    (${from}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const to = ${to};
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    to.dispatchEvent(over);
    if (over.defaultPrevented) to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    return over.defaultPrevented; })()`);
  await settle(900);
  return ok;
};

// ---- the tree ----

// A click selects one and opens it; Ctrl+click adds and removes without opening anything.
await click(row('one.md'));
check('a click selects one', [await selected(), await active()], [['one.md'], 'one.md']);
await click(row('three.md'), CTRL);
await click(row('docs/guide.md'), CTRL);
check('Ctrl+click adds, opens nothing', [await selected(), await active()], [['docs/guide.md', 'one.md', 'three.md'], 'one.md']);
check('the keys are on the row last clicked', await ev(`document.querySelector('#tree .row.focused').dataset.path`), 'docs/guide.md');
await click(row('one.md'), CTRL);
check('Ctrl+click takes one out', await selected(), ['docs/guide.md', 'three.md']);
await shot('tree-several');

// Shift+click: from the row last clicked to this one, over the rows on screen.
const order = await rows();
const between = (a, b) => order.slice(Math.min(order.indexOf(a), order.indexOf(b)), Math.max(order.indexOf(a), order.indexOf(b)) + 1);
await click(row('notes/todo.md'));
await click(row('four.md'), SHIFT);
check('Shift+click selects the range', [await selected(), await active()], [between('notes/todo.md', 'four.md'), 'notes/todo.md']);
check('the range is more than its two ends', (await selected()).length > 2, true);
check('no text got selected', await ev(`String(getSelection())`), '');

// Keys: Shift+arrows stretch it, Ctrl+A takes every row, Esc goes back to one.
await click(row('one.md'));
await chord('ArrowDown', 'ArrowDown', 40, SHIFT);
await chord('ArrowDown', 'ArrowDown', 40, SHIFT);
check('Shift+↓ stretches', await selected(), order.slice(order.indexOf('one.md'), order.indexOf('one.md') + 3));
await chord('ArrowUp', 'ArrowUp', 38, SHIFT);
check('Shift+↑ pulls it back', await selected(), order.slice(order.indexOf('one.md'), order.indexOf('one.md') + 2));
await ctrlA();
check('Ctrl+A selects every row', await selected(), order);
await key('Escape');
check('Esc goes back to one, and stays on the file', [(await selected()).length, await hash()], [1, '#one.md']);
await key('ArrowDown');
check('a plain arrow selects one', (await selected()).length, 1);

// The menu: for all of them on a selected row, for one on any other.
await click(row('one.md'));
await click(row('two.md'), CTRL);
await rightClick(row('two.md'));
check('menu for several', [await menu(), await selected()], [['Download as Zip', 'Cut', 'Copy', 'Duplicate', 'Move to Trash', 'Copy Paths'], ['one.md', 'two.md']]);
await ev(`document.addEventListener('click', (e) => { if (e.target.tagName === 'A' && e.target.hasAttribute('download')) { window.__zip = e.target.getAttribute('href'); e.preventDefault(); } }, true)`);
await menuPick('Download as Zip');
const zipURL = await ev(`window.__zip`);
check('the zip asks for both', zipURL, '/api/zip?p=one.md&p=two.md');
const zip = await hub(zipURL);
check('and the hub sends one', [zip.status, zip.headers.get('content-type')], [200, 'application/zip']);
await rightClick(row('three.md'));
check('menu on another row: just that one', [(await menu()).includes('Rename…'), await selected()], [true, ['three.md']]);
await closeMenu();

// Delete: the selection goes to the Trash, with nothing asked (trash.mjs has the rest).
await click(row('three.md'));
await click(row('four.md'), CTRL);
await answerDialogs(null);
await key('Delete');
await settle(900);
check('Delete moves them to Trash, unasked', [await has('three.md', 'four.md'), await toastText(), await ev(`document.getElementById('overlay').hidden`)], [[false, false], 'Moved 2 items to Trash', true]);
const hist = await (await hub('/api/history/one.md')).json();
check('(one.md untouched)', hist.length, 1);

// Dragging a selected row moves the selection; a name taken there stops all of it.
await click(row('one.md'));
await click(row('two.md'), CTRL);
check('a taken name refuses the drop’s move', [await drag(row('one.md'), row('notes')), await toastText(), await has('one.md', 'two.md', 'notes/one.md')], [true, 'two.md already exists in notes/', [true, true, false]]);
check('several move together', [await drag(row('one.md'), row('docs')), await has('docs/one.md', 'docs/two.md', 'one.md'), await toastText()], [true, [true, true, false], 'Moved 2 items to docs/']);
check('the selection went along', await selected(), ['docs/one.md', 'docs/two.md']);
check('they can’t be dropped where they are', await drag(row('docs/one.md'), row('docs')), false);
// A fixed top-level folder stays, and the rest goes.
await click(row('large'), CTRL);
check('a taken name stops it with large/ picked too', [await drag(row('docs/one.md'), row('notes')), await toastText(), await has('notes/one.md', 'docs/two.md', 'large/world.zip')], [true, 'two.md already exists in notes/', [false, true, true]]);
await click(row('docs/one.md'));
await click(row('large'), CTRL);
check('one and large/: the one moves', [await drag(row('docs/one.md'), row('notes')), await toastText(), await has('notes/one.md', 'large/world.zip')], [true, 'large/ stays where it is', [true, true]]);

// Someone else deletes a selected file: the selection lets go of it.
await click(row('docs/two.md'));
await click(row('notes/one.md'), CTRL);
await click(row('README.md'), CTRL);
await api('POST', '/api/batch/delete', { paths: ['notes/one.md'] });
await settle(1000);
check('a row someone deleted leaves the selection', await selected(), ['docs/two.md', 'README.md']);

// Into a chat: a card for each.
await ev(`document.querySelector('#chat-body .compose').value = ''`);
await ev(`(() => { const dt = new DataTransfer();
  (${row('docs/two.md')}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  document.querySelector('#chat-body').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
check('dragged into chat: a card for every one', await ev(`[document.querySelector('#chat-body .compose').value, [...document.querySelectorAll('#chat-body .composer .pend-name')].map((n) => n.textContent)]`), ['', ['two.md', 'README.md']]);

// ---- the folder view ----

await send('Page.navigate', { url: `${HUB}/?r=2#folder=${encodeURIComponent('map art')}` });
await settle(1500);
const art = (n) => `map art/MA-00${n} ${['Logo', 'Album art', 'Keyboard', 'Flag', 'Starry Night'][n - 1]}.png`;
const here = '#folder=map art';
await click(tile(art(1)), CTRL);
await click(tile(art(3)), CTRL);
check('Ctrl+click picks tiles, opens nothing', [await picked(), await hash()], [[art(1), art(3)], here]);
check('the tree keeps its own selection', (await selected()).includes(art(1)), false);
await click(tile(art(1)), CTRL);
check('Ctrl+click lets one go', await picked(), [art(3)]);
await click(tile(art(4)), SHIFT); // from the tile last clicked (the first), though that click let it go
check('Shift+click picks the range', await picked(), [art(1), art(2), art(3), art(4)]);
await shot('tiles-picked');
await ctrlA();
check('Ctrl+A picks every tile', (await picked()).length, 5);
await key('Escape');
check('Esc lets go, and stays in the folder', [await picked(), await hash()], [[], here]);

// A search lets go of what it hides.
await ctrlA();
await ev(`(() => { const s = document.querySelector('#main-folder input[type=search]'); s.value = 'Flag'; s.dispatchEvent(new Event('input')); })()`);
await settle(300);
check('a search keeps only what it shows picked', await picked(), [art(4)]);
await ev(`(() => { const s = document.querySelector('#main-folder input[type=search]'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
await settle(300);
check('and they don’t come back', await picked(), [art(4)]);
await key('Escape');

// The box: dragged from empty space over the tiles; a click on empty space picks nothing.
const box = await ev(`(() => { const s = document.querySelector('#main-folder .shot-scroll').getBoundingClientRect();
  const first = (${tile(art(1))}).getBoundingClientRect(), second = (${tile(art(2))}).getBoundingClientRect();
  return { empty: [s.right - 30, s.bottom - 20], first: [first.x + 20, first.y + 20], gap: [first.right + 4, first.y + 20], second: [second.x + 20, second.y + 20] }; })()`);
const mouse = (type, [x, y], modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers });
await mouse('mousePressed', box.empty);
await mouse('mouseMoved', [box.empty[0] - 40, box.empty[1] - 40]);
await mouse('mouseMoved', box.first);
await settle(200);
check('the box picks what it touches', [await ev(`!!document.querySelector('#main-folder .pick-box')`), (await picked()).length], [true, 5]);
await shot('box');
await mouse('mouseMoved', [box.empty[0] - 40, box.empty[1] - 40]);
await settle(200);
check('pulled back, it lets go again', (await picked()).length < 5, true);
await mouse('mouseMoved', box.first);
await mouse('mouseReleased', box.first);
await settle(200);
check('released: the box is gone, the tiles stay picked', [await ev(`!!document.querySelector('#main-folder .pick-box')`), (await picked()).length, await hash()], [false, 5, here]);
await mouse('mousePressed', box.empty);
await mouse('mouseReleased', box.empty);
await settle(200);
check('a click on empty space picks nothing', await picked(), []);
// With Ctrl held the box adds to what is picked.
await click(tile(art(5)), CTRL);
await mouse('mousePressed', box.gap, CTRL);
await mouse('mouseMoved', [box.gap[0] - 30, box.gap[1] + 10], CTRL);
await mouse('mouseReleased', [box.gap[0] - 30, box.gap[1] + 10], CTRL);
await settle(200);
check('a Ctrl box adds', await picked(), [art(1), art(5)]);

// The menu and the Delete key, as in the tree.
await rightClick(tile(art(5)));
check('menu for several tiles', await menu(), ['Download as Zip', 'Cut', 'Copy', 'Duplicate', 'Move to Trash', 'Copy Paths']);
await closeMenu();
await rightClick(tile(art(2)));
check('menu on another tile: just that one', [(await menu()).includes('Rename…'), await picked()], [true, [art(2)]]);
await closeMenu();
await click(tile(art(3)), CTRL);
await key('Delete');
await settle(900);
check('Delete moves the picked to Trash', [await has(art(2), art(3), art(1)), (await picked()).length, await toastText()], [[false, false, true], 0, 'Moved 2 items to Trash']);

// Moving: picked tiles dropped on a folder's tile, and on Back.
for (const p of ['m1.md', 'm2.md']) await put(p);
await send('Page.navigate', { url: `${HUB}/?r=3#folder=` });
await settle(1500);
await click(tile('m1.md'), CTRL);
await click(tile('m2.md'), CTRL);
check('picked tiles drop on a folder tile', [await drag(tile('m1.md'), tile('docs')), await has('docs/m1.md', 'docs/m2.md', 'm1.md')], [true, [true, true, false]]);
check('a folder’s tile can be dragged too', [await drag(tile('notes'), tile('docs')), await has('docs/notes/todo.md')], [true, [true]]);
await send('Page.navigate', { url: `${HUB}/?r=4#folder=docs` });
await settle(1500);
await click(tile('docs/m1.md'), CTRL);
await click(tile('docs/m2.md'), CTRL);
check('and on Back, to the folder above', [await drag(tile('docs/m1.md'), `document.querySelector('#main-folder .shot-bar button')`), await has('m1.md', 'm2.md', 'docs/m1.md')], [true, [true, true, false]]);
check('Esc with nothing picked still goes up', [await picked(), (await key('Escape'), await hash())], [[], '#folder=']);

await done();
