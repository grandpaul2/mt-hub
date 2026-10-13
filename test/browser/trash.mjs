// The Trash: what is deleted in Files goes there unasked, with Undo in the toast; the tree's
// last row opens it; anyone restores (back where it was, under another name where that is
// taken, into a picked folder for a file posted in a chat) or drags a row out onto a folder;
// rows and tiles dropped on the Trash row go in; only admins erase; a private chat's files
// never show.
import { answerDialogs, api, as, asked, check, done, ev, HUB, hub, key, send, settle, shot } from './lib.mjs';

const put = (p, body = p, base = '') => hub(`/api/file/${encodeURIComponent(p).replace(/%2F/g, '/')}?base=${base}`, { method: 'PUT', body });
const files = async () => (await (await hub('/api/tree')).json()).filter((e) => !e.dir).map((e) => e.path);
const has = async (...paths) => { const all = await files(); return paths.map((p) => all.includes(p)); };
const paul = (method, path, body) => api(method, path, body, 'Paul');
for (const p of ['t1.md', 't2.md', 't3.md', 'docs/keep.md', 'docs/sub/deep.md']) await put(p);

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','["docs","notes"]')`);
await send('Page.navigate', { url: `${HUB}/?r=1#README.md` });
await settle(1500);

const row = (p) => `document.querySelector('#tree .row[data-path=${JSON.stringify(p)}]')`;
const bin = `document.querySelector('#tree .row.trash-row')`;
const selected = () => ev(`[...document.querySelectorAll('#tree .row.selected')].map((r) => r.dataset.path ?? 'Trash')`);
const toastText = () => ev(`document.getElementById('toast').hidden ? null : document.getElementById('toast').firstChild?.textContent`);
const hash = () => ev(`decodeURIComponent(location.hash)`);
const noDialog = () => ev(`document.getElementById('overlay').hidden`);
// The Trash's rows: "name | the line under it", and each row's buttons.
const listed = () => ev(`[...document.querySelectorAll('#main-trash .trash-item')].map((r) => r.querySelector('.trash-name').textContent + ' | ' + r.querySelector('.trash-meta').textContent.replace(/ · [A-Z][a-z]{2} \\d+, [^·]+?(?= ·)/, ''))`);
const names = () => ev(`[...document.querySelectorAll('#main-trash .trash-item .trash-name > span:first-child')].map((r) => r.textContent)`);
const item = (name) => `[...document.querySelectorAll('#main-trash .trash-item')].find((r) => r.querySelector('.trash-name > span').textContent === ${JSON.stringify(name)})`;
const press = async (name, label) => { await ev(`[...(${item(name)}).querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`); await settle(900); };
const click = async (el, modifiers = 0) => {
  const [x, y] = await ev(`(() => { const el = ${el}; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, modifiers });
  await settle(400);
};
const drag = async (from, to) => {
  const ok = await ev(`(() => { const dt = new DataTransfer();
    (${from}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const to = ${to};
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    to.dispatchEvent(over);
    if (over.defaultPrevented) to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    return over.defaultPrevented; })()`);
  await settle(1000);
  return ok;
};

// The Trash is the tree's last row, and opens empty.
check('the tree ends with Trash', await ev(`[...document.querySelectorAll('#tree .row')].pop().textContent`), 'Trash');
await click(bin);
check('it opens, empty', [await hash(), await ev(`document.querySelector('#main-trash .muted.pad')?.textContent`), await ev(`document.getElementById('main-trash').hidden`), await selected()],
  ['#trash', 'Trash is empty. What you move here stays 30 days.', false, ['Trash']]);

// Delete: to the Trash, unasked, and Undo brings it back.
await answerDialogs(null);
await click(row('t1.md'));
await key('Delete');
await settle(900);
check('Delete moves a file to Trash, unasked', [await has('t1.md'), await toastText(), await noDialog(), await ev(`document.querySelector('#toast .toast-act')?.textContent`)], [[false], 'Moved t1.md to Trash', true, 'Undo']);
await shot('undo');
await ev(`document.querySelector('#toast .toast-act').click()`);
await settle(1000);
check('Undo puts it back', [await has('t1.md'), await toastText(), await selected()], [[true], 'Restored t1.md to Files', ['t1.md']]);
check('with its text', await (await hub('/api/file/t1.md')).text(), 't1.md');

// The menu says Move to Trash; a folder goes as one row; the Trash lists newest first.
await ev(`(() => { const el = ${row('docs/sub')}; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 5 })); })()`);
await settle(200);
await ev(`[...document.querySelectorAll('#menu > button')].find((b) => b.firstChild.textContent === 'Move to Trash').click()`);
await settle(900);
await click(row('t1.md'));
await click(row('t2.md'), 2);
await key('Delete');
await settle(900);
check('several: one toast', [await toastText(), await has('t1.md', 't2.md', 'docs/sub/deep.md')], ['Moved 2 items to Trash', [false, false, false]]);
await click(bin);
check('the Trash lists them, newest first', await listed(), ['t2.md | from Files · Paul · 5 B · 30 days left', 't1.md | from Files · Paul · 5 B · 30 days left', 'sub/ | from docs/ · Paul · 30 days left']);
check('an admin has Delete Forever and Empty Trash', await ev(`[[...(${item('t1.md')}).querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent), document.querySelector('#main-trash .shot-bar button').hidden]`), [['Restore', 'Delete Forever'], false]);
await shot('trash');

// Restore: back where it was (the folder too); a taken name comes back "(restored)".
await press('sub/', 'Restore');
check('a folder is restored with what was in it', [await has('docs/sub/deep.md'), await names(), await toastText(), await hash()], [[true], ['t2.md', 't1.md'], 'Restored sub to docs/', '#trash']);
await put('t1.md', 'someone else’s');
await settle(600);
await press('t1.md', 'Restore');
check('a taken name: restored beside it', [await has('t1 (restored).md', 't1.md'), await toastText()], [[true, true], 'Restored t1 (restored).md to Files']);

// Dragging out: onto a folder in the tree it is restored there. Dragging in: onto the Trash row.
check('a Trash row dragged onto a folder is restored there', [await drag(item('t2.md'), row('notes')), await has('notes/t2.md', 't2.md'), await names()], [true, [true, false], []]);
check('a Trash row can’t be dropped on the Trash', await drag(`document.querySelector('#main-trash')`, bin), false);
await click(row('t3.md'));
await click(row('notes/t2.md'), 2);
check('rows dropped on the Trash row go in', [await drag(row('t3.md'), bin), await has('t3.md', 'notes/t2.md'), await toastText()], [true, [false, false], 'Moved 2 items to Trash']);
check('a fixed folder can’t be dropped there', [await drag(row('large'), bin), await has('large/world.zip')], [false, [true]]);
await click(bin);
check('and are in it', await names(), ['t3.md', 't2.md']);

// The file bar's button, on the open file: to the Trash, and back to its folder.
await click(row('docs/keep.md'));
await ev(`document.querySelector('#toolbar button[title="Move to Trash"]').click()`);
await settle(1000);
check('the open file goes to Trash; its folder shows', [await has('docs/keep.md'), await toastText(), await hash()], [[false], 'Moved keep.md to Trash', '#folder=docs']);

// A replaced file in a folder without history: the old copy is in the Trash, marked.
const stat = await (await hub('/api/stat/large/world.zip')).json();
await put('large/world.zip', 'a newer world', stat.rev);
// Files posted in chats: a public chat's shows, and Restore asks for a folder; a private chat's never shows.
await paul('POST', '/api/channels', { name: 'staff', kind: 'private', members: ['Alex'] });
for (const [chat, file] of [['general', 'plan.txt'], ['staff', 'secret.txt']]) {
  await hub(`/api/channels/${chat}/media?name=${file}`, { method: 'POST', body: file });
  const m = await (await paul('POST', `/api/channels/${chat}/messages`, { text: `#media/${chat}/${file}` })).json();
  await paul('DELETE', `/api/channels/${chat}/messages/${m.id}?files=1`);
}
await settle(1000);
await click(bin);
check('a public chat’s file and a replaced copy show; a private chat’s does not', await listed(),
  ['plan.txt | from #general · Paul · 8 B · 30 days left', 'world.zipreplaced | from large/ · Paul · 1 B · 30 days left', 'keep.md | from docs/ · Paul · 12 B · 30 days left', 't3.md | from Files · Paul · 5 B · 30 days left', 't2.md | from notes/ · Paul · 5 B · 30 days left']);
await press('plan.txt', 'Restore');
check('a chat file asks for a folder', await ev(`[document.querySelector('#dialog h2')?.textContent, document.querySelector('#dialog .actions button:last-child')?.textContent]`), ['Restore plan.txt to Files', 'Restore']);
await ev(`(() => { const b = document.querySelector('#dialog input[type=text]'); b.value = 'saved'; b.dispatchEvent(new Event('input')); document.querySelector('#dialog .actions button:last-child').click(); })()`);
await settle(1000);
check('and lands there', [await has('saved/plan.txt'), await toastText()], [[true], 'Restored plan.txt to saved/']);

// Someone else moves a file to Trash while it is open: it shows.
await api('POST', '/api/batch/delete', { paths: ['saved/plan.txt'] });
await settle(1000);
check('someone else’s shows at once', (await listed())[0], 'plan.txt | from saved/ · Alex · 8 B · 30 days left');

// Erasing: an admin's Delete Forever and Empty Trash ask, in red.
await answerDialogs(null);
await press('keep.md', 'Delete Forever');
check('Delete Forever asks', await ev(`[document.querySelector('#dialog h2').textContent, document.querySelector('#dialog .actions button:last-child').className]`), ['Delete keep.md forever?', 'danger']);
await ev(`document.querySelector('#dialog .actions button:last-child').click()`);
await settle(900);
check('and erases just that', (await names()).includes('keep.md'), false);
await answerDialogs(true);
await ev(`document.querySelector('#main-trash .shot-bar button').click()`);
await settle(1000);
check('Empty Trash asks, then empties', [await asked(), await names(), await toastText()], [['Empty Trash?'], [], 'Trash emptied']);
await answerDialogs(null);

// A member restores but can't erase; the address opens the Trash.
await api('POST', '/api/batch/delete', { paths: ['notes/todo.md'] });
await as('Alex');
await send('Page.navigate', { url: `${HUB}/?r=2#trash` });
await settle(1500);
check('a member sees the Trash, with Restore only', [await hash(), await ev(`[[...(${item('todo.md')}).querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent), document.querySelector('#main-trash .shot-bar button').hidden]`)], ['#trash', [['Restore'], true]]);
await press('todo.md', 'Restore');
check('and restores', await has('notes/todo.md'), [true]);

await done();
