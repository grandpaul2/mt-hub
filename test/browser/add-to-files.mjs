// Files posted in chat go to Files only when someone asks: Save to Files… (message toolbar
// and menu, the viewer, the chat's file list) copies them into a folder picked in one
// question (style guide 14). A file too big for chat (over 50 MB) is offered a place in
// large/ instead.
import { api, check, COOKIE, done, ev, HUB, hub, key, send, settle, shot, typeText } from './lib.mjs';

const postFile = async (chat, name, body) =>
  (await (await fetch(`${HUB}/api/channels/${chat}/media?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie: COOKIE.Alex }, body })).json()).path;
const notes = await postFile('general', 'notes.txt', 'some notes');
const farm = await postFile('general', 'farm.litematic', 'schem');
const m1 = await (await api('POST', '/api/channels/general/messages', { text: `notes #${notes}` })).json();
const m2 = await (await api('POST', '/api/channels/general/messages', { text: `the farm #${farm}` })).json();

await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(2500);
const tree = async () => (await (await hub('/api/tree')).json()).map((e) => e.path);
const S = '#chat-body'; // the side panel's chat (the main panel shows the folder picked in the tree)
const msgEl = (id) => `document.querySelector('${S} .msg[data-id="${id}"]')`;
const compose = () => ev(`document.querySelector('${S} .compose').value`);
const drop = (files) => ev(`(() => {
  const dt = new DataTransfer();
  for (const [n, size] of ${JSON.stringify(files)}) dt.items.add(new File([size ? new Uint8Array(size) : 'text'], n, { type: 'text/plain' }));
  document.querySelector('${S}').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
})()`);
const dlg = () => ev(`(() => { if (document.getElementById('overlay').hidden) return null; const d = document.getElementById('dialog');
  return { title: d.querySelector('h2').textContent, folder: d.querySelector('input')?.value,
    picked: d.querySelector('.folder-row.picked')?.textContent ?? null, note: d.querySelector('.folder-note')?.textContent,
    text: d.textContent }; })()`);
const button = (label) => ev(`[...document.querySelectorAll('#dialog .actions button')].find((b) => b.textContent === '${label}').click()`);

// Any file goes straight into the chat, linked in the box: no question.
await drop([['plan.txt']]);
await settle(1200);
check('a text file is posted in the chat', [await dlg(), await compose(), (await tree()).some((p) => p.endsWith('plan.txt'))], [null, '#media/general/plan.txt ', false]);
await ev(`document.querySelector('${S} .compose').value = ''`);

// A file card: its name, size and Download.
check('file card', await ev(`(() => { const c = ${msgEl(m1.id)}.querySelector('.file-card');
  return [c.querySelector('.file-name').textContent, c.querySelector('.file-size').textContent, c.querySelector('a[title="Download"]').getAttribute('href'), !!${msgEl(m1.id)}.querySelector('.file-link')]; })()`),
  ['notes.txt', '10 B', '/api/channels/general/media/notes.txt?download=1', false]);
await shot('file-card');

// Save to Files…: the tree's selected folder first.
await ev(`document.querySelector('#tree .row[data-path="docs"]').click()`);
await settle(600);
check('Save to Files on the toolbar', await ev(`!!${msgEl(m1.id)}.querySelector('.msg-tools [data-tool="save"]')`), true);
await ev(`${msgEl(m1.id)}.querySelector('.msg-tools [data-tool="save"]').click()`);
await settle(400);
let d = await dlg();
check('one question, named file, tree folder first', [d?.title, d?.folder, d?.picked], ['Save notes.txt to Files?', 'docs', 'docs/']);
await shot('dialog');
check('every folder listed to start with', await ev(`document.querySelectorAll('#dialog .folder-row').length > 8`), true);
check('confirm is blue, Cancel first', await ev(`[...document.querySelectorAll('#dialog .actions button')].map((b) => b.textContent + (b.classList.contains('primary') ? '*' : ''))`), ['Cancel', 'Save*']);

// Type to narrow the list, click a folder, Save.
await ev(`document.querySelector('#dialog input').select()`);
await typeText('boa');
await settle(150);
check('typing narrows the list', await ev(`[...document.querySelectorAll('#dialog .folder-row')].map((b) => b.textContent)`), ['boards/', 'boards/anchor/', 'boards/handheld-device/', 'boards/handheld-device/erc_outputs/']);
await ev(`[...document.querySelectorAll('#dialog .folder-row')].find((b) => b.textContent === 'boards/').click()`);
await button('Save');
await settle(1200);
check('a copy in that folder; the chat keeps its own', [(await tree()).includes('boards/notes.txt'), await dlg(), (await hub(`/api/channels/general/media/notes.txt`)).status],
  [true, null, 200]);
check('saved, said so', await ev(`document.getElementById('toast').textContent`), 'Saved to boards/notes.txt');

// Again from the menu, into a new folder; then the same name gets (2).
await ev(`${msgEl(m2.id)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))`);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'Save to Files…').click()`);
await settle(300);
await ev(`document.querySelector('#dialog input').select()`);
await typeText('stuff/new');
await settle(150);
check('a new folder is named as such', (await dlg())?.note, 'stuff/new/ is a new folder; it’s made for you.');
await key('Enter');
await settle(1200);
check('Enter saves it there', (await tree()).includes('stuff/new/farm.litematic'), true);
await ev(`${msgEl(m1.id)}.querySelector('.msg-tools [data-tool="save"]').click()`);
await settle(300);
await ev(`document.querySelector('#dialog input').value = 'boards'`);
await button('Save');
await settle(1200);
check('a name already there gets (2)', (await tree()).includes('boards/notes (2).txt'), true);

// Esc leaves everything as it was.
const before = (await tree()).length;
await ev(`${msgEl(m1.id)}.querySelector('.msg-tools [data-tool="save"]').click()`);
await settle(300);
await key('Escape');
await settle(300);
check('Esc cancels', [await dlg(), (await tree()).length], [null, before]);

// Over 50 MB: too big for chat, offered large/ in Files.
await drop([['huge.bin', (50 << 20) + 1]]);
await settle(600);
d = await dlg();
check('a big file is offered large/', [d?.title, d?.text.includes('Chat takes files up to 50 MB, so this one goes in large/')], ['Add huge.bin to Files?', true]);
await button('Cancel');
await settle(200);
check('Cancel closes, nothing uploaded', [await dlg(), (await tree()).some((p) => p.includes('huge'))], [null, false]);

await done();
