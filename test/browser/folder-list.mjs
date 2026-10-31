// The folder view as a list: the Size slider's last stop on the left (Paul, S98). A row each:
// the picture small (32px high) or the icon at 16px in the same slot, then name, date and
// size, the columns lined up. A folder row always has its date (a tile only when sorted by
// date). Kept per browser like the tile size; one stop right is tiles again. Picking works
// on rows as on tiles.
import { check, done, ev, HUB, send, settle, SEED, shot } from './lib.mjs';

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-folder-w', '200'); localStorage.setItem('mt-folder-sort', 'name')`);
await send('Page.reload');
await settle(2000);

const slide = async (v) => {
  await ev(`(() => { const s = document.querySelector('#main-folder .size input'); s.value = '${v}'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle(300);
};
const listed = () => ev(`document.querySelector('#main-folder .folder-grid').classList.contains('list')`);
// rows: per row, the media slot's size, and where each column starts (and whether it shows).
const rows = () => ev(`[...document.querySelectorAll('#main-folder .shot[data-path]')].map((t) => {
  const box = (el) => el && el.checkVisibility() ? el.getBoundingClientRect() : null;
  const m = box(t.firstElementChild), icon = box(t.querySelector('.folder-icon img'));
  const [who, when, bytes] = ['.who', '.when', '.bytes'].map((c) => box(t.querySelector(c)));
  return { h: Math.round(t.getBoundingClientRect().height), media: m && [Math.round(m.width), Math.round(m.height)], icon: icon && Math.round(icon.width),
    who: who && Math.round(who.left), when: when && Math.round(when.left), bytes: bytes && Math.round(bytes.right),
    text: [t.querySelector('.when')?.textContent ?? '', t.querySelector('.bytes')?.textContent ?? ''] };
})`);
const same = (xs) => xs.every((x) => x === xs[0]);

// Map art: pictures.
await ev(`location.hash = '#folder=map art'`);
await settle(1000);
check('tiles to start with, the slider says how to get a list', [await listed(), await ev(`document.querySelector('#main-folder .size input').min`), await ev(`document.querySelector('#main-folder label.size').title`)],
  [false, '110', 'Tile size (all the way left: a list)']);
check('a tile shows no size', (await rows()).every((r) => r.bytes === null), true);
await slide(110);
let r = await rows();
check('all the way left: a list', [await listed(), r.length], [true, SEED.mapart.length]);
check('a picture row: 16:9 at 32px high, under 45px tall', r.every((x) => x.media[0] === 57 && x.media[1] === 32 && x.h < 45), true);
check('columns line up: name, date, size', [same(r.map((x) => x.who)), same(r.map((x) => x.when)), same(r.map((x) => x.bytes))], [true, true, true]);
check('every row has a date and a size', r.every((x) => x.text[0] && /\d+(\.\d+)? (B|KB|MB|GB)$/.test(x.text[1])), true);
await shot('folder-list-pictures');
check('kept per browser', await ev(`localStorage.getItem('mt-folder-w')`), '110');

// schematics/: folders, with their date sorted by name too, and no size.
await ev(`location.hash = '#folder=schematics'`);
await settle(1000);
r = await rows();
check('folder rows: the icon at 16px, a date, no size', [r.length, r.every((x) => x.icon === 16 && x.media[1] === 32 && x.text[0] && !x.text[1])], [SEED.schems.length, true]);
check('and the name column starts where a picture row\'s does', same(r.map((x) => x.who)), true);
await shot('folder-list-folders');
// Picking: Ctrl+click picks a row.
const centre = await ev(`(() => { const r = document.querySelector('#main-folder .shot[data-path]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: centre[0], y: centre[1], button: 'left', clickCount: 1, modifiers: 2 });
await settle(300);
check('Ctrl+click picks a row', await ev(`document.querySelectorAll('#main-folder .shot.picked').length`), 1);
const at = (i, dy = 0) => ev(`(() => { const r = document.querySelectorAll('#main-folder .shot[data-path]')[${i}].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2 + ${dy}]; })()`);
const mouse = (type, [x, y], modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers });
const picked = () => ev(`[...document.querySelectorAll('#main-folder .shot.picked')].map((t) => t.dataset.path.split('/').pop())`);
for (const type of ['mousePressed', 'mouseReleased']) await mouse(type, await at(2), 8);
await settle(300);
check('Shift+click picks the rows between', await picked(), ['Build 1', 'Build 2', 'Build 3']);
// A picked row keeps its colour under the pointer; a row that isn't picked shows the hover.
const bg = (i) => ev(`getComputedStyle(document.querySelectorAll('#main-folder .shot[data-path]')[${i}]).backgroundColor`);
const pickedBg = await bg(0);
await mouse('mouseMoved', await at(1));
await settle(200);
const underPointer = await bg(1);
await mouse('mouseMoved', await at(4));
await settle(200);
check('a picked row keeps its colour under the pointer; another shows the hover', [underPointer === pickedBg, (await bg(4)) !== 'rgba(0, 0, 0, 0)'], [true, true]);
// A box from the space under the last row, up over two rows, picks them.
const n = SEED.schems.length;
const [x0, y0] = await at(n - 1, 40);
const [, y1] = await at(n - 2);
check('there is room under the last row', await ev(`document.elementFromPoint(${x0}, ${y0})?.closest('.shot') == null && document.querySelector('#main-folder .folder-grid').contains(document.elementFromPoint(${x0}, ${y0}))`), true);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
for (const y of [y0 - 10, (y0 + y1) / 2, y1]) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + 30, y, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + 30, y: y1, button: 'left', buttons: 0, clickCount: 1 });
await settle(300);
check('a box dragged from under the rows picks what it touches', await picked(), SEED.schems.slice(-2).map((x) => x[0]));

// After a reload it is still a list; one stop right is tiles, the folder's date gone again.
await send('Page.reload');
await settle(2000);
await ev(`location.hash = '#folder=schematics'`);
await settle(1000);
check('still a list after a reload', await listed(), true);
await slide(120);
r = await rows();
check('one stop right: tiles, a folder tile without its date (sorted by name)', [await listed(), r.every((x) => x.when === null && x.bytes === null)], [false, true]);

await done();
