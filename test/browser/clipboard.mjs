// Cut, copy, paste and duplicate in the tree and the folder view: the hub's own clipboard
// (Ctrl+X, Ctrl+C, Ctrl+V and the menus), "name copy" where a name is taken, a cut drawn
// dimmed until pasted or cancelled, a big copy asked about, and a picture on the computer's
// clipboard still uploaded.
import { answerDialogs, asked, check, done, ev, HUB, hub, key, send, settle, shot } from './lib.mjs';

const CTRL = 2;
const put = (p, body = p) => hub(`/api/file/${encodeURIComponent(p).replace(/%2F/g, '/')}?base=`, { method: 'PUT', body });
const files = async () => (await (await hub('/api/tree')).json()).filter((e) => !e.dir).map((e) => e.path);
const has = async (...paths) => { const all = await files(); return paths.map((p) => all.includes(p)); };
for (const p of ['c1.md', 'c2.md', 'c3.md', 'notes/c1.md']) await put(p);

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','["docs","notes"]')`);
await send('Page.navigate', { url: `${HUB}/?r=1#README.md` });
await settle(1500);

const row = (p) => `document.querySelector('#tree .row[data-path=${JSON.stringify(p)}]')`;
const tile = (p) => `document.querySelector('#main-folder .shot[data-path=${JSON.stringify(p)}]')`;
const selected = () => ev(`[...document.querySelectorAll('#tree .row.selected')].map((r) => r.dataset.path)`);
const picked = () => ev(`[...document.querySelectorAll('#main-folder .shot.picked')].map((r) => r.dataset.path)`);
const cut = () => ev(`[...document.querySelectorAll('#tree .row.cut, #main-folder .shot.cut')].map((r) => r.dataset.path)`);
const toastText = () => ev(`document.getElementById('toast').firstChild?.textContent ?? ''`); // (without an Undo button)
const hash = () => ev(`decodeURIComponent(location.hash)`);
const menu = () => ev(`[...document.querySelectorAll('#menu > button')].map((b) => b.firstChild.textContent + (b.disabled ? ' (off)' : ''))`);
const menuPick = async (label) => { await ev(`[...document.querySelectorAll('#menu > button')].find((b) => b.firstChild.textContent === ${JSON.stringify(label)}).click()`); await settle(900); };
const click = async (el, modifiers = 0) => {
  const [x, y] = await ev(`(() => { const el = ${el}; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, modifiers });
  await settle(300);
};
const rightClick = async (el) => {
  await ev(`(() => { const el = ${el}; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 5 })); })()`);
  await settle(200);
};
const chord = async (k, vk) => {
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: CTRL });
  await settle(300);
};
const copy = () => chord('c', 67);
const cutKey = () => chord('x', 88);
// Ctrl+V, as the page hears it: a paste where the keys are. withPicture puts a picture on it.
const paste = async (withPicture = false) => {
  await ev(`(async () => { const dt = new DataTransfer();
    if (${withPicture}) { const c = document.createElement('canvas'); c.width = c.height = 8; dt.items.add(new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'image.png', { type: 'image/png' })); }
    (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })); })()`);
  await settle(1200);
};

// ---- the tree ----

// Nothing cut or copied: Paste is greyed, and a paste does nothing.
await click(row('notes'));
await rightClick(row('c1.md'));
check('file menu, nothing to paste', await menu(), ['Open', 'Download', 'Cut', 'Copy', 'Paste (off)', 'Duplicate', 'Rename…', 'Move to Trash', 'Copy Path']);
await key('Escape');

// Copy, then paste into a folder where the name is taken: "c1 copy.md", then "c1 copy 2.md".
await click(row('c1.md'));
await copy();
check('Ctrl+C says so', [await toastText(), await cut()], ['Copied 1 item', []]);
await click(row('notes'));
await paste();
check('pasted where the name is taken: a copy', [await has('notes/c1 copy.md', 'c1.md', 'notes/c1.md'), await toastText(), await selected()], [[true, true, true], 'Copied to notes/c1 copy.md', ['notes/c1 copy.md']]);
check('the copy has the original’s text', await (await hub('/api/file/notes/c1%20copy.md')).text(), 'c1.md');
await click(row('notes/todo.md')); // a file's row: its folder
await paste();
check('a copy can be pasted again', await has('notes/c1 copy 2.md'), [true]);
await click(row('docs'));
await paste();
check('where the name is free it keeps it', await has('docs/c1.md'), [true]);

// Cut: dimmed until pasted; Esc cancels and leaves the selection alone.
await click(row('c2.md'));
await click(row('c3.md'), CTRL);
await cutKey();
check('Ctrl+X dims them', [await cut(), await toastText()], [['c2.md', 'c3.md'], 'Cut 2 items']);
await shot('cut');
await key('Escape');
check('Esc cancels the cut, keeps the selection', [await cut(), await selected(), await has('c2.md', 'c3.md')], [[], ['c2.md', 'c3.md'], [true, true]]);
await cutKey();
await click(row('docs'));
await paste();
check('a cut pasted is a move', [await has('docs/c2.md', 'docs/c3.md', 'c2.md', 'c3.md'), await cut(), await toastText()], [[true, true, false, false], [], 'Moved 2 items to docs/']);
await paste();
check('and is spent: a second paste does nothing', [(await files()).filter((p) => /c2/.test(p)), await toastText()], [['docs/c2.md'], 'Moved 2 items to docs/']);
// A cut onto a taken name is refused, and stays cut.
await click(row('c1.md'));
await cutKey();
await click(row('notes'));
await paste();
check('a cut onto a taken name is refused and stays cut', [await has('c1.md'), await toastText(), await cut()], [[true], 'notes/c1.md already exists', ['c1.md']]);
await ev(`document.getElementById('tree').focus()`);
await key('Escape');
check('(cancelled)', await cut(), []);

// Selected text is the browser's to copy: Ctrl+C leaves the hub's clipboard alone.
await click(row('docs/c2.md'));
await ev(`getSelection().selectAllChildren(document.querySelector('#view'))`);
await ev(`document.getElementById('tree').focus()`);
await copy();
await ev(`getSelection().removeAllRanges()`);
await rightClick(row('docs/c2.md'));
check('with text selected, Ctrl+C is the browser’s', (await menu()).includes('Paste (off)'), true);

// The menus: Duplicate beside the original; a fixed folder can't be cut or doubled.
await menuPick('Duplicate');
check('Duplicate: a copy beside it', [await has('docs/c2 copy.md'), await selected()], [[true], ['docs/c2 copy.md']]);
await rightClick(row('large'));
check('large/: Copy and Paste, no Cut or Duplicate', (await menu()).filter((m) => /Cut|Copy$|Paste|Duplicate/.test(m)), ['Copy', 'Paste (off)']);
await key('Escape');
await click(row('c1.md'));
await click(row('notes'), CTRL);
await rightClick(row('notes'));
check('menu for several', await menu(), ['Download as Zip', 'Cut', 'Copy', 'Duplicate', 'Move to Trash', 'Copy Paths']);
await menuPick('Duplicate');
check('several duplicated, each beside its own', await has('c1 copy.md', 'notes copy/todo.md', 'notes copy/c1 copy.md'), [true, true, true]);
await rightClick(row('c1.md'));
await menuPick('Copy');
await ev(`document.querySelector('#tree').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: document.querySelector('#tree').getBoundingClientRect().bottom - 4 }))`);
await settle(200);
check('the empty space has Paste', (await menu()).includes('Paste'), true);
await key('Escape');
await rightClick(row('notes copy'));
await menuPick('Paste');
check('Paste from a folder’s menu', await has('notes copy/c1.md'), [true]);

// A big copy asks first.
await put('large/big.bin', new Uint8Array(101 * 2 ** 20));
await settle(1500);
await ev(`localStorage.setItem('mt-expanded','["large"]')`);
await send('Page.navigate', { url: `${HUB}/?r=2#README.md` });
await settle(1500);
await click(row('large/big.bin'), CTRL);
await ev(`document.getElementById('tree').focus()`);
await copy();
await answerDialogs(false);
await paste();
const q = await asked();
check('a copy over 100 MB asks, and Cancel copies nothing', [q.length, /^Copy 101(\.0)? MB\?$/.test(q[0] ?? ''), await has('large/big copy.bin')], [1, true, [false]]);
await answerDialogs(null);

// ---- the folder view ----

await ev(`location.hash = '#folder='`);
await settle(1200);
await click(tile('c1.md'), CTRL);
await click(tile('README.md'), CTRL);
await copy();
check('Ctrl+C on picked tiles', await toastText(), 'Copied 2 items');
await ev(`location.hash = '#folder=docs'`);
await settle(1200);
await paste();
check('Ctrl+V in another folder', [await has('docs/README.md', 'docs/c1 copy.md'), await picked(), await hash()], [[true, true], ['docs/c1 copy.md', 'docs/README.md'], '#folder=docs']);
// A picture on the computer's clipboard still uploads, and the hub's clipboard waits.
const before = (await files()).length;
await paste(true);
const after = await files();
check('a picture on the clipboard uploads, as before', [after.length - before, after.filter((p) => /^docs\/\d{4}-.*Paul\.png$/.test(p)).length], [1, 1]);
// Cut tiles are dimmed; Esc cancels the cut first, and stays in the folder.
await key('Escape'); // lets go of the two copies
await click(tile('docs/c2.md'), CTRL);
await cutKey();
check('Ctrl+X dims the tile', await ev(`[...document.querySelectorAll('#main-folder .shot.cut')].map((r) => r.dataset.path)`), ['docs/c2.md']);
await shot('cut-tile');
await key('Escape');
check('Esc cancels the cut and stays', [await cut(), await picked(), await hash()], [[], ['docs/c2.md'], '#folder=docs']);
await cutKey();
await ev(`location.hash = '#folder=notes'`);
await settle(1200);
await paste();
check('cut tiles pasted in another folder', await has('notes/c2.md', 'docs/c2.md'), [true, false]);
await rightClick(tile('notes/c2.md'));
check('a tile’s menu has them too', (await menu()).filter((m) => /Cut|Copy$|Paste|Duplicate/.test(m)), ['Cut', 'Copy', 'Paste (off)', 'Duplicate']);
await key('Escape');

await done();
