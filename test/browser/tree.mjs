// The file tree: keyboard, F2 rename, right-click menu, drag-to-move, delete.
import { answerDialogs, check, COOKIE, done, ev, HUB, hub, key, send, settle, shot, typeText } from './lib.mjs';

const focusedRow = () => ev(`document.querySelector('#tree .row.focused')?.dataset.path ?? null`);
const tree = async () => (await (await hub(`/api/tree`)).json()).map((e) => e.path).filter((p) => !/^(large|screenshots|map art|schematics)(\/|$)/.test(p)).join(' ');

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','[]')`);
await send('Page.reload');
await settle(1500);
await answerDialogs(true);

// Keyboard: rows are boards, docs, large, map art, notes, schematics, screenshots,
// README.md.
await ev(`document.getElementById('tree').focus()`);
await key('ArrowDown');
check('down from nothing', await focusedRow(), 'boards');
await key('ArrowRight');
check('right expands', await ev(`document.querySelector('.row[data-path="boards"]').classList.contains('open')`), true);
await key('ArrowRight');
check('right again steps in', await focusedRow(), 'boards/anchor');
await key('ArrowLeft');
check('left goes to parent', await focusedRow(), 'boards');
await key('ArrowLeft');
check('left collapses', await ev(`document.querySelector('.row[data-path="boards"]').classList.contains('open')`), false);
await key('End');
check('end', await focusedRow(), 'README.md');
await key('Enter');
await settle(400);
check('enter opens file', await ev(`location.hash || document.querySelector('.row.active')?.dataset.path`), await ev(`location.hash`) || 'README.md');

// One selection: clicking a folder, then a file, leaves only the file highlighted, and new
// files go to the file's folder.
const click = (p) => ev(`document.querySelector('#tree .row[data-path="${p}"]').click()`);
await click('boards');
await settle(200);
check('folder click selects', [await focusedRow(), await ev(`document.getElementById('target').textContent`)], ['boards', '→ boards/']);
await click('README.md');
await settle(400);
check('file click moves the one selection', [await ev(`[...document.querySelectorAll('#tree .row.focused')].map((r) => r.dataset.path)`), await ev(`document.getElementById('target').textContent`)], [['README.md'], '']);

// F2 rename.

await ev(`document.getElementById('tree').focus()`);
await key('F2');
check('rename box selects stem', await ev(`(() => { const b = document.querySelector('input.rename'); return [b.value, b.selectionStart, b.selectionEnd]; })()`), ['README.md', 0, 6]);
await typeText('INTRO');
await key('Enter');
await settle(600);
check('renamed on server', (await tree()).includes('INTRO.md') && !(await tree()).includes('README.md'), true);
check('open file followed rename', await ev(`document.querySelector('.row.active')?.dataset.path`), 'INTRO.md');
check('history follows rename', (await (await hub(`/api/history/INTRO.md`)).json()).length >= 2, true);
await key('F2');
await typeText('nope');
await key('Escape');
await settle(300);
check('escape cancels', (await tree()).includes('nope'), false);

// Right-click menu on a folder.
const r = await ev(`(() => { const b = document.querySelector('.row[data-path="docs"]').getBoundingClientRect(); return [b.x + 30, b.y + 10]; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'right', clickCount: 1 });
await settle(300);
check('folder menu', await ev(`[...document.querySelectorAll('#menu button span:first-child')].map((s) => s.textContent)`),
  ['New File…', 'New Folder…', 'Upload…', 'Download as Zip', 'Cut', 'Copy', 'Paste', 'Duplicate', 'Rename…', 'Move to Trash', 'Copy Path']);
await shot('menu');
await key('Escape');
check('escape closes menu', await ev(`document.getElementById('menu').hidden`), true);

// Drag notes onto the docs folder (synthetic drag events with a real DataTransfer).
await ev(`(() => {
  const dt = new DataTransfer();
  const src = document.querySelector('.row[data-path="notes"]');
  const dst = document.querySelector('.row[data-path="docs"]');
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  window.__hl = document.querySelector('.row[data-path="docs"]').classList.contains('drop-target');
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
})()`);
await settle(700);
check('drop target highlighted', await ev(`window.__hl`), true);
check('dragged folder moved', await tree(), 'INTRO.md boards boards/anchor boards/anchor/a.md boards/handheld-device boards/handheld-device/board.toml boards/handheld-device/erc_outputs boards/handheld-device/erc_outputs/ERC.rpt boards/handheld-device/parts.md docs docs/guide.md docs/notes docs/notes/todo.md');
check('destination expanded', await ev(`document.querySelector('.row[data-path="docs"]').classList.contains('open')`), true);
await shot('after-move');

// Drag a file onto a file: lands in that file's folder. Then delete a folder by key.
await ev(`(() => {
  const dt = new DataTransfer();
  document.querySelector('.row[data-path="INTRO.md"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const dst = document.querySelector('.row[data-path="docs/guide.md"]');
  dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
})()`);
await settle(700);
check('file onto file -> its folder', (await tree()).includes('docs/INTRO.md'), true);
check('open file followed move', await ev(`document.querySelector('.row.active')?.dataset.path`), 'docs/INTRO.md');
await ev(`document.querySelector('.row[data-path="boards"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 100 }))`);
await key('Escape');
await ev(`document.getElementById('tree').focus()`);
await key('Delete');
await settle(600);
check('folder deleted', (await tree()).includes('boards'), false);

// Any folder opens the folder view: folders first, then files by name. A README is just a
// file in it. The folder stays the highlighted row and doesn't expand.
const put = (p, body) => fetch(`${HUB}/api/file/${p}?base=`, { method: 'PUT', headers: { cookie: COOKIE.Pat }, body });
await put('notes/ReadMe.md', '# Notes folder');
await put('notes/b.md', 'b');
await put('notes/a/x.md', 'x');
await settle(800);
const tiles = () => ev(`[...document.querySelectorAll('#main-folder .shot')].map((t) => t.dataset.path)`);
await ev(`document.querySelector('#tree .row[data-path="notes"]').click()`);
await settle(600);
check('folder click opens the folder view', [await ev(`location.hash`), await ev(`document.getElementById('main-folder').hidden`), await tiles(),
  await ev(`[...document.querySelectorAll('#tree .row.active, #tree .row.focused')].map((r) => r.dataset.path)`),
  await ev(`document.querySelector('#tree .row[data-path="notes"]').classList.contains('open')`)],
  ['#folder=notes', false, ['notes/a', 'notes/b.md', 'notes/ReadMe.md'], ['notes'], false]);
check('file tiles show their tree icon', await ev(`document.querySelector('#main-folder .shot[data-path="notes/b.md"] .folder-icon img').getAttribute('src')`), '/icons/markdown.svg');
await shot('folder-view');
// Search filters by name; the count says how many of how many.
await ev(`(() => { const s = document.querySelector('#main-folder input[type=search]'); s.value = 'readme'; s.dispatchEvent(new Event('input')); })()`);
await settle(200);
check('search filters', [await tiles(), await ev(`document.querySelector('#main-folder .count').textContent`)], [['notes/ReadMe.md'], '1 of 3']);
// A subfolder tile opens that folder (search cleared); a file tile opens the file.
await ev(`(() => { const s = document.querySelector('#main-folder input[type=search]'); s.value = 'a'; s.dispatchEvent(new Event('input')); })()`);
await settle(200);
await ev(`document.querySelector('#main-folder .shot[data-path="notes/a"]').click()`);
await settle(400);
check('subfolder tile opens it', [await ev(`location.hash`), await tiles(), await ev(`document.querySelector('#main-folder input[type=search]').value`)], ['#folder=notes/a', ['notes/a/x.md'], '']);
await ev(`document.querySelector('#main-folder .shot[data-path="notes/a/x.md"]').click()`);
await settle(600);
check('file tile opens the file', [await ev(`location.hash`), await ev(`document.querySelector('#toolbar .single-name')?.textContent`)], ['#notes/a/x.md', 'x.md']);
// Any file opened on its own has a way back to its folder: the bar's back button, or Esc.
check('file has a back button', await ev(`document.querySelector('#toolbar button')?.textContent`), '← Back to notes/a/');
// (Focus is on the tree here, which keeps its arrow keys but not Esc.)
await key('Escape');
await settle(400);
check('Esc goes back to the folder', await ev(`location.hash`), '#folder=notes/a');
await ev(`document.querySelector('#main-folder .shot[data-path="notes/a/x.md"]').click()`);
await settle(500);
await ev(`document.querySelector('#toolbar button').click()`);
await settle(400);
check('back button goes back', await ev(`location.hash`), '#folder=notes/a');
// A nested folder goes back up the same way (button or Esc); a top-level one goes back to
// Files (the top), which has none.
check('nested folder has a back button', await ev(`document.querySelector('#main-folder .shot-bar button')?.textContent`), '← Back to notes/');
await key('Escape');
await settle(400);
check('Esc goes up a folder', [await ev(`location.hash`), await ev(`document.querySelector('#main-folder .shot-bar button').textContent`)], ['#folder=notes', '← Back to Files']);
await ev(`document.querySelector('#main-folder .shot[data-path="notes/a"]').click()`);
await settle(400);
await ev(`document.querySelector('#main-folder .shot-bar button').click()`);
await settle(400);
check('back button goes up', await ev(`location.hash`), '#folder=notes');
// The address survives a reload, and a plain folder link (#notes) opens the view too.
await ev(`document.querySelector('#tree .row[data-path="notes"]').click()`);
await settle(400);
const notesOpen = () => ev(`document.querySelector('#tree .row[data-path="notes"]').classList.contains('open')`);
const wasOpen = await notesOpen(); // opening notes/a/x.md revealed it in the tree
await send('Page.reload');
await settle(1500);
check('reload keeps the folder view', [await ev(`document.getElementById('main-folder').hidden`), await tiles().then((t) => t.length),
  await ev(`document.querySelector('#tree .row.active')?.dataset.path`), await notesOpen()], [false, 3, 'notes', wasOpen]);
await send('Page.navigate', { url: `${HUB}/?r=2#notes` });
await settle(1500);
check('folder link opens the view', [await ev(`document.querySelector('#main-folder .shot-bar > span').textContent`), await ev(`document.querySelector('#tree .row.active')?.dataset.path`)], ['notes/', 'notes']);
// large/ (no history) is a folder like any other.
await ev(`document.querySelector('#tree .row[data-path="large"]').click()`);
await settle(600);
check('large/ opens the folder view', await tiles(), ['large/world.zip']);

// New File and New Folder: Enter makes it once and closes the box (its blur used to make it
// again: "already exists", and the box stayed open).
for (const [btn, name] of [['new-folder', 'made'], ['new-file', 'made.md']]) { // (a new file's box starts as .md)
  await click('notes');
  await settle(300);
  await ev(`document.getElementById('toast').hidden = true`);
  await ev(`document.getElementById('${btn}').click()`);
  await settle(200);
  await typeText(name.replace(/\.md$/, ''));
  await key('Enter');
  await settle(800);
  check(`${btn}: made once, box closed, no error`, [(await tree()).includes(`notes/${name}`), await ev(`!!document.querySelector('#tree input.rename')`),
    await ev(`document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`)], [true, false, '']);
}

// Deleting the folder that's open in the main view (from the tree) shows its parent.
await ev(`document.querySelector('#tree .row[data-path="notes/made"]').click()`);
await settle(400);
check('made/ open', await ev(`location.hash`), '#folder=notes/made');
await ev(`document.getElementById('tree').focus()`);
await key('Delete');
await settle(800);
check('deleted open folder: its parent shows', [(await tree()).includes('notes/made '), await ev(`location.hash`), await tiles().then((t) => t.includes('notes/made'))], [false, '#folder=notes', false]);

// FILES opens the top folder in the main view; its header stays at the top as the sidebar scrolls.
await ev(`document.getElementById('files-head').click()`);
await settle(400);
check('FILES opens the top folder', [await ev(`location.hash`), await ev(`document.querySelector('#main-folder .shot-bar > span').textContent`), (await tiles()).includes('notes'),
  await ev(`document.querySelector('#main-folder .shot-bar button').hidden`)], ['#folder=', 'Files', true, true]);
// A top-level folder's back button (and Esc) goes to Files.
await ev(`document.querySelector('#main-folder .shot[data-path="notes"]').click()`);
await settle(400);
await ev(`document.querySelector('#main-folder .shot-bar button').click()`);
await settle(400);
check('top-level back goes to Files', await ev(`location.hash`), '#folder=');
await ev(`(() => { const s = document.getElementById('side'); s.style.height = '200px'; s.scrollTop = 150; })()`);
await settle(100);
check('FILES header stays at the top', await ev(`(() => { const s = document.getElementById('side'), h = document.querySelector('#side .side-head'); return [s.scrollTop > 0, Math.round(h.getBoundingClientRect().top - s.getBoundingClientRect().top)]; })()`), [true, 0]);
await ev(`(() => { const s = document.getElementById('side'); s.style.height = ''; s.scrollTop = 0; })()`);

// The folder bar: New file, New folder, Upload, README (greyed out without one).
const bar = () => ev(`[...document.querySelectorAll('#main-folder .shot-bar .vtool')].map((b) => [b.title, b.getAttribute('aria-disabled')])`);
await ev(`document.querySelector('#tree .row[data-path="notes"]').click()`);
await settle(400);
await ev(`document.getElementById('toast').hidden = true`);
await shot('folder-bar');
check('folder bar buttons (README here)', await bar(), [['New file', null], ['New folder', null], ['Upload files here (or drop them on the grid)', null], ['Open ReadMe.md', 'false'], ['Search names', null]]);
await ev(`document.querySelector('#main-folder .vtool[title="Open ReadMe.md"]').click()`);
await settle(500);
check('README opens it', await ev(`location.hash`), '#notes/ReadMe.md');
await ev(`document.querySelector('#tree .row[data-path="notes/a"]').click()`);
await settle(400);
check('no README: greyed out', (await bar())[3], ['No README here', 'true']);
await ev(`document.querySelector('#main-folder .vtool[title="No README here"]').click()`);
await settle(300);
check('greyed README does nothing', await ev(`location.hash`), '#folder=notes/a');
// New file / New folder from the folder view: the name box is a tile in the grid, not in the tree.
const gridBox = () => ev(`(() => { const t = document.querySelector('#main-folder .shot.creating'); const tiles = [...document.querySelectorAll('#main-folder .folder-grid .shot')];
  return t && [tiles.indexOf(t), document.activeElement === t.querySelector('input.rename'), t.querySelector('input').value, t.querySelector('input').selectionStart, !!document.querySelector('#tree .row.creating')]; })()`);
const before = await tree();
await ev(`document.querySelector('#main-folder .vtool[title="New folder"]').click()`);
await settle(300);
check('folder view New folder: a tile first, focused, not in the tree', await gridBox(), [0, true, '', 0, false]);
await key('Escape');
await settle(300);
check('Esc cancels it', [await gridBox(), (await tree()) === before], [null, true]);
await ev(`document.querySelector('#main-folder .vtool[title="New folder"]').click()`);
await settle(300);
await typeText('sub');
await key('Enter');
await settle(800);
check('folder made, still in the folder view, its tile flashed', [(await tree()).includes('notes/a/sub'), await ev(`location.hash`),
  await ev(`document.querySelector('#main-folder .shot[data-path="notes/a/sub"]')?.classList.contains('flash')`)], [true, '#folder=notes/a', true]);
await ev(`document.querySelector('#main-folder .vtool[title="New file"]').click()`);
await settle(300);
check('folder view New file: a tile after the folders, cursor before .md', await gridBox(), [1, true, '.md', 0, false]);
await shot('folder-new-file');
await typeText('fromview');
await key('Enter');
await settle(800);
check('file made in the open folder and opened', [(await tree()).includes('notes/a/fromview.md'), await ev(`location.hash`)], [true, '#notes/a/fromview.md']);
await ev(`document.querySelector('#tree .row[data-path="notes/a"]').click()`);
await settle(400);
await ev(`document.querySelector('#main-folder .vtool[title="New file"]').click()`);
await settle(300);
await typeText('fromview');
await key('Enter');
await settle(800);
check('a taken name: toast, the box stays with the name', [await ev(`document.getElementById('toast').textContent`), (await gridBox())?.[2]], ['fromview.md already exists here', 'fromview.md']);
await key('Escape');
await settle(300);
// Right-click a tile: the tree's menu for it.
await ev(`document.querySelector('#tree .row[data-path="notes"]').click()`);
await settle(400);
await ev(`document.querySelector('#main-folder .shot[data-path="notes/b.md"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }))`);
check('file tile menu', await ev(`[...document.querySelectorAll('#menu button span:first-child')].map((s) => s.textContent)`), ['Open', 'Download', 'Cut', 'Copy', 'Paste', 'Duplicate', 'Rename…', 'Move to Trash', 'Copy Path']);
await key('Escape');
await ev(`document.querySelector('#main-folder .shot[data-path="notes/a"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }))`);
check('folder tile menu', await ev(`[...document.querySelectorAll('#menu button span:first-child')].map((s) => s.textContent)`), ['New File…', 'New Folder…', 'Upload…', 'Download as Zip', 'Cut', 'Copy', 'Paste', 'Duplicate', 'Rename…', 'Move to Trash', 'Copy Path']);
// Rename… from a tile: the box shows in the tree even with notes collapsed.
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Rename')).click()`);
await settle(300);
check('tile Rename… opens the box', await ev(`document.querySelector('#tree input.rename')?.value`), 'a');
await key('Escape');
await settle(300);
await ev(`document.querySelector('#main-folder .shot[data-path="notes/a"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }))`);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('New Folder')).click()`);
await settle(400);
check('tile New Folder…: opens that folder, box in the grid', [await ev(`location.hash`), (await gridBox())?.slice(1)], ['#folder=notes/a', [true, '', 0, false]]);
await key('Escape');
await settle(300);

// Markdown tables render as tables (marked needs gfm: true beside breaks: true).
await put('notes/table.md', '# T\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
await settle(600);
await send('Page.navigate', { url: `${HUB}/?r=3#notes/table.md` });
await settle(1500);
check('markdown table renders', await ev(`[...document.querySelectorAll('#view .markdown table td')].map((t) => t.textContent)`), ['1', '2']);

// Markdown is written by members, so its HTML can't act for the reader or pass for the hub's
// own controls: no forms or fields (a planted form posts as whoever clicks it), no styles
// (a see-through button over the page), no ids (the page finds its own parts by id). The
// text and a task list's checkboxes stay.
await put('notes/form.md', [
  '# Form',
  '',
  '<form action="/api/channels/general/messages" method="post" enctype="text/plain"><input type="hidden" name=\'{"text":"planted","x":"\' value=\'"}\'><button>Click me</button><textarea>t</textarea><select><option>o</option></select></form>',
  '',
  '<style>#toast{display:none} form,button{position:fixed;inset:0;opacity:0}</style>',
  '',
  '<div id="menu" class="menu" style="position:fixed;inset:0" name="n">plain text stays</div>',
  '',
  '- [x] done',
  '- [ ] to do',
  ''].join('\n'));
await settle(600);
await send('Page.navigate', { url: `${HUB}/?r=4#notes/form.md` });
await settle(1500);
check('markdown: no forms, fields, styles, ids', await ev(`(() => {
  const m = document.querySelector('#view .markdown');
  const n = (sel) => m.querySelectorAll(sel).length;
  return [n('form'), n('button'), n('textarea'), n('select'), n('input:not([type=checkbox])'), n('style'), n('[id]'), n('[style]'), n('[class]'), n('[name]')];
})()`), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
check('markdown: text and task-list boxes stay, switched off', await ev(`(() => {
  const m = document.querySelector('#view .markdown');
  return [m.textContent.includes('plain text stays'), [...m.querySelectorAll('input[type=checkbox]')].map((i) => [i.checked, i.disabled])];
})()`), [true, [[true, true], [false, true]]]);
check('markdown: the page still finds its own menu', await ev(`document.getElementById('menu').closest('.markdown') === null`), true);

// Folder icons: only our special folders (by path) get one; any other folder is plain, even
// one with a name the icon theme knows (docs, notes, client). Files keep the theme's icons.
for (const d of ['mods/client', 'mods/server', 'docs/client', 'commands']) await hub('/api/mkdir', { method: 'POST', body: JSON.stringify({ path: d }) });
await ev(`localStorage.setItem('mt-expanded', '["mods","docs","notes"]')`);
await send('Page.navigate', { url: `${HUB}/?r=4` });
await settle(1500);
const icon = (p) => ev(`document.querySelector('#tree .row[data-path="${p}"] img.icon')?.src.split('/icons/')[1]`);
check('special folder icons', await Promise.all(['commands', 'large', 'map art', 'mods', 'mods/client', 'mods/server', 'schematics', 'screenshots'].map(icon)),
  ['folder-command.svg', 'folder-archive.svg', 'folder-theme.svg', 'folder-plugin-open.svg', 'folder-client.svg', 'folder-server.svg', 'folder-layout.svg', 'folder-images.svg']);
check('other folders plain', await Promise.all(['docs', 'docs/client', 'notes', 'notes/a'].map(icon)), ['folder-open.svg', 'folder.svg', 'folder-open.svg', 'folder.svg']);
check('files keep theme icons', await Promise.all(['notes/b.md', 'notes/ReadMe.md'].map(icon)), ['markdown.svg', 'readme.svg']);
await ev(`document.querySelector('#tree .row[data-path="mods"]').click()`);
await settle(500);
check('folder view tiles too', await ev(`[...document.querySelectorAll('#main-folder .shot .folder-icon img')].map((i) => i.src.split('/icons/')[1])`), ['folder-client.svg', 'folder-server.svg']);

await done();
