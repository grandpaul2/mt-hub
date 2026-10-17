// Moves by someone else: the open file, unsaved edits and chat links follow; inline new file/folder boxes.
import { api, check, done, ev, HUB, hub, key, send, settle, shot, typeText } from './lib.mjs';

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','["docs","notes"]')`);
await send('Page.reload');
await settle(1500);
const active = () => ev(`document.querySelector('#tree .row.active')?.dataset.path ?? null`);
const toastText = () => ev(`document.getElementById('toast').textContent`);

// 1. Someone else renames the open file: we follow it.
await ev(`document.querySelector('.row[data-path="docs/guide.md"]').click()`);
await settle(600);
await api('POST', '/api/move', { from: 'docs/guide.md', to: 'docs/manual.md' });
await settle(1000);
check('followed rename', await active(), 'docs/manual.md');
check('hash updated', await ev(`decodeURIComponent(location.hash)`), '#docs/manual.md');
check('toast names mover', await toastText(), 'Alex moved this file to docs/manual.md');

// 2. Unsaved edits survive a folder move, and save cleanly afterwards.
await ev(`document.querySelector('.row[data-path="notes/todo.md"]').click()`);
await settle(800);
await ev(`[...document.querySelectorAll('#toolbar button')].find((b) => /edit/i.test(b.textContent))?.click()`);
await settle(500);
const box = await ev(`(() => { const r = document.querySelector('.monaco-editor .view-lines')?.getBoundingClientRect(); return r ? [r.x + 50, r.y + 8] : null; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
await typeText(' EDITED');
await settle(300);
await api('POST', '/api/move', { from: 'notes', to: 'archive/notes' });
await settle(1200);
check('followed folder move', await active(), 'archive/notes/todo.md');
check('kept edits toast', await toastText(), 'Alex moved this file to archive/notes/todo.md. Your unsaved changes came along.');
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
await settle(800);
check('saved without conflict', await (await hub(`/api/file/archive/notes/todo.md`)).text(), 'x EDITED');
check('no conflict view', await ev(`!!document.querySelector('.diff')`), false);

// 3. Chat links follow moves.
await api('POST', '/api/channels/general/messages', { Text: 'see #README.md and #[docs/guide.md] for it' });
await api('POST', '/api/move', { from: 'README.md', to: 'INTRO.md' });
await settle(1200);
check('chat links', await ev(`[...document.querySelectorAll('#chat a.file-link')].map((a) => [a.textContent, a.title])`),
  [['INTRO.md', 'Was README.md · Open INTRO.md'], ['docs/manual.md', 'Was docs/guide.md · Open docs/manual.md']]);

// 4. Inline new file / folder boxes.
const exists = async (p) => (await (await hub(`/api/tree`)).json()).some((e) => e.path === p);
const boxRow = () => ev(`(() => { const r = document.querySelector('#tree .row.creating'); if (!r) return null;
  const rows = [...document.querySelectorAll('#tree .row')]; const i = rows.indexOf(r);
  return [rows[i - 1]?.dataset.path ?? '', rows[i + 1]?.dataset.path ?? '', r.querySelector('.icon').getAttribute('src')]; })()`);
await ev(`document.getElementById('files-head').click()`);
await ev(`document.getElementById('new-folder').click()`);
await settle(200);
check('folder box above the folders', (await boxRow()).slice(0, 2), ['', 'archive']);
await typeText('fresh');
await key('Enter');
await settle(700);
check('new folder created', await exists('fresh'), true);
check('new folder is target', await ev(`document.getElementById('target').textContent`), '→ fresh/');
await ev(`document.querySelector('.row[data-path="docs"]').click()`); // target docs (it's open)
await ev(`document.getElementById('new-file').click()`);
await settle(200);
check('file box after docs folders', (await boxRow()).slice(0, 2), ['docs', 'docs/manual.md']);
check('file box starts as .md, cursor before it', await ev(`(() => { const b = document.querySelector('input.rename'); return [b.value, b.selectionStart, b.selectionEnd]; })()`), ['.md', 0, 0]);
await typeText('plan');
await settle(100);
check('icon follows name', (await boxRow())[2], '/icons/markdown.svg');
await key('Enter');
await settle(900);
check('new file created + opened', [await exists('docs/plan.md'), await active()], [true, 'docs/plan.md']);
await ev(`document.getElementById('new-file').click()`);
await settle(200);
await typeText('plan');
await key('Enter');
await settle(700);
check('duplicate keeps box open', [await toastText(), await ev(`document.querySelector('input.rename')?.value`)], ['plan.md already exists here', 'plan.md']);
await key('Escape');
await settle(200);
check('escape cancels', await boxRow(), null);
await ev(`document.getElementById('new-file').click()`);
await settle(200);
await ev(`document.querySelector('input.rename').select()`);
await typeText('blurred.txt');
await ev(`document.querySelector('input.rename').blur()`);
await settle(900);
check('blur creates', await exists('docs/blurred.txt'), true);
await ev(`document.querySelector('.row[data-path="docs"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 100 }))`);
check('folder menu', await ev(`[...document.querySelectorAll('#menu button span:first-child')].map((s) => s.textContent)`),
  ['New File…', 'New Folder…', 'Upload…', 'Download as Zip', 'Cut', 'Copy', 'Paste', 'Duplicate', 'Rename…', 'Move to Trash', 'Copy Path']);
await shot('menu2');

await done();
