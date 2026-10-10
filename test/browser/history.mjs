// Back and Forward: opening a file, chat, folder or the Schematic Manager is a history entry,
// so the browser's Back/Forward step through them; re-renders add nothing; Back from a file
// with unsaved changes asks first, and keeping the file puts its address back.
import { answerDialogs, asked, check, COOKIE, done, ev, HUB, send, settle, ws } from './lib.mjs';

await fetch(`${HUB}/api/file/notes/edit-me.txt?base=`, { method: 'PUT', headers: { cookie: COOKIE.Paul }, body: 'line one\n' });
await send('Page.navigate', { url: HUB });
await settle(2500);
await answerDialogs(false);
const where = () => ev(`[decodeURIComponent(location.hash), ['file-area', 'main-chat', 'main-folder', 'main-schems'].find((id) => !document.getElementById(id).hidden)]`);
const row = (p) => ev(`document.querySelector('#tree .row[data-path="${p}"]').click()`);
const back = async () => { await ev('history.back()'); await settle(900); };
const forward = async () => { await ev('history.forward()'); await settle(900); };

const start = await ev('history.length');
await ev(`document.querySelector('#tree .row[data-path="docs"] .twisty')?.click()`);
await settle(300);
await row('docs/guide.md');
await settle(900);
await ev(`[...document.querySelectorAll('#channels .row')].find((r) => r.textContent.replace(/\\s/g, '') === '#general').click()`);
await settle(900);
await row('schematics');
await settle(900);
await ev(`[...document.querySelectorAll('#main-folder .shot-bar button')].find((b) => b.textContent === 'Schematic Manager').click()`);
await settle(1200);
check('four places, four entries', [await where(), await ev('history.length') - start], [['#schems', 'main-schems'], 4]);
await ev(`(() => { const s = document.querySelector('#main-schems input[type=search]'); s.value = 'build'; s.dispatchEvent(new Event('input')); })()`);
await settle(400);
check('typing in the board search adds none', await ev('history.length') - start, 4);

await back();
check('back: the folder', await where(), ['#folder=schematics', 'main-folder']);
await back();
check('back: the chat', await where(), ['#chan=general', 'main-chat']);
await back();
check('back: the file', [await where(), await ev(`document.querySelector('#toolbar .single-name')?.textContent`)], [['#docs/guide.md', 'file-area'], 'guide.md']);
await forward();
check('forward: the chat again', await where(), ['#chan=general', 'main-chat']);

// Unsaved changes: Back to another file asks; keeping them leaves the address on this file.
// (Back to a chat or folder doesn't ask: the edits stay, as they always have.)
await row('docs/guide.md');
await settle(900);
await ev(`document.querySelector('#tree .row[data-path="notes"] .twisty')?.click()`);
await settle(300);
await row('notes/edit-me.txt');
await settle(1200);
await ev(`[...document.querySelectorAll('#toolbar .single-actions > button')].find((b) => b.textContent === 'Edit').click()`);
await settle(500);
const box = await ev(`(() => { const r = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect(); return [r.x + 100, r.y + 8]; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
await settle(200);
for (const ch of 'xyz') { await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); await settle(80); }
await settle(300);
await back();
check('back to a file asks; kept: still here, address too', [(await asked()).length, await where()], [1, ['#notes/edit-me.txt', 'file-area']]);
await answerDialogs(true);
await back();
check('back again, discarding: the other file', [(await asked()).length, await where()], [1, ['#docs/guide.md', 'file-area']]);

await done();
