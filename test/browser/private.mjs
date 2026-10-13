// Private chats and DMs (backlog item 13; style guide 14): starting a DM from the TEXT
// "+" menu, its media kept out of Files, who sees what, a private chat with a lock, hiding a
// DM until its next message, and making a chat public again.
import { api, as, check, done, ev, HUB, hub, key, send, settle, shot, typeText } from './lib.mjs';

const tree = async () => (await (await hub('/api/tree')).json()).map((e) => e.path);
const M = '#main-chat';
const reload = async (hash = '') => {
  await send('Page.navigate', { url: `${HUB}/?r=${Math.random()}${hash}` });
  await settle(2500);
};
const rows = (id) => ev(`[...document.querySelectorAll('#${id} .row')].map((r) => r.querySelector('.hash').textContent + r.querySelector('.name').textContent + (r.querySelector('.lock') ? '🔒' : ''))`);
const tick = (name) => ev(`[...document.querySelectorAll('#dialog label.member')].find((l) => l.textContent === '${name}').querySelector('input').click()`);
const confirmBtn = (label) => ev(`[...document.querySelectorAll('#dialog .actions button')].find((b) => b.textContent === '${label}').click()`);
const rowMenu = async (id, label) => {
  await ev(`(() => { const r = [...document.querySelectorAll('#${id} .row')].find((r) => r.querySelector('.name').textContent === '${label}');
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 })); })()`);
  await settle(150);
  return ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent)`);
};
const menuPick = (label) => ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === '${label}').click()`);

// Steve starts a DM with Alex.
await as('Steve');
await reload('#chan=general');
check('+ offers a DM (no private chat for members)', await (async () => {
  await ev(`document.getElementById('new-channel').click()`);
  await settle(100);
  return ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent)`);
})(), ['New Chat', 'New Direct Message…']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'New Direct Message…').click()`);
await settle(200);
check('DM picker: everyone but you', await ev(`[document.querySelector('#dialog h2').textContent, [...document.querySelectorAll('#dialog label.member')].map((l) => l.textContent)]`),
  ['New direct message', ['Alex', 'Paul']]);
check('Message waits for someone', await ev(`[...document.querySelectorAll('#dialog .actions button')].pop().disabled`), true);
await tick('Alex');
await shot('dm-picker');
await confirmBtn('Message');
await settle(1200);
check('DM opens, named by who it’s with, in TEXT after the chats', [await ev(`document.getElementById('main-chat-title').textContent`), await rows('channels')], ['@ Alex', ['#general', '@Alex']]);
check('who can see it, said at the top', await ev(`document.querySelector('${M} .chat-privacy').textContent.startsWith('Only the people in this conversation')`), true);
check('placeholder', await ev(`document.querySelector('${M} .compose').placeholder`), 'Message @Alex');
await ev(`document.querySelector('${M} .compose').focus()`);
await typeText('just us');
await key('Enter');
await settle(800);
const dm = await ev(`location.hash.replace('#chan=', '')`);
check('DM has a dm- name', dm.startsWith('dm-'), true);

// A picture in the DM stays with it: not in Files, still shown.
await ev(`(async () => {
  const c = document.createElement('canvas'); c.width = 120; c.height = 80; c.getContext('2d').fillRect(0, 0, 120, 80);
  const f = new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'secret.png', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(f);
  document.querySelector('${M} .chat-body').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
})()`);
await settle(1200);
check('waiting in the box', await ev(`[document.querySelector('${M} .compose').value, document.querySelector('${M} .composer .pend-name')?.textContent]`), ['', 'secret.png']);
await ev(`document.querySelector('${M} .compose').focus()`);
await key('Enter');
await settle(1200);
check('not in Files', (await tree()).some((p) => p.includes('secret')), false);
check('shown in the DM', await ev(`(() => { const i = document.querySelector('${M} .ref-pic img'); return !!i && i.complete && i.naturalWidth === 120; })()`), true);
await shot('dm');

// Any other file stays in the DM too; one too big for chat goes in Files, with a warning
// that Files is everyone's.
await ev(`document.querySelector('${M} .compose').value = ''`);
const dropIn = (name, size) => ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${size} ? new Uint8Array(${size}) : 'x'], '${name}', { type: 'text/plain' }));
  document.querySelector('${M} .chat-body').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
await dropIn('notes.txt', 0);
await settle(1200);
await ev(`document.querySelector('${M} .compose').focus()`);
await key('Enter');
await settle(1200);
check('a text file stays in the DM', [await ev(`[...document.querySelectorAll('${M} .msg')].at(-1).querySelector('.file-card .file-name')?.textContent`), (await tree()).some((p) => p.includes('notes.txt'))], ['notes.txt', false]);
await dropIn('huge.bin', (50 << 20) + 1);
await settle(600);
check('too big for chat: Files warns from a DM', await ev(`document.querySelector('#dialog .warn-line')?.textContent ?? null`), 'This is a private conversation, but Files is visible to everyone in the hub.');
await key('Escape');

// Paul (an admin) doesn't see it; he makes a private chat with Steve.
await as('Paul');
await reload('#chan=general');
check('an admin sees no one else’s DMs', await rows('channels'), ['#general']);
await ev(`document.getElementById('new-channel').click()`);
await settle(100);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'New Private Chat…').click()`);
await settle(200);
await typeText('staff');
await tick('Steve');
await confirmBtn('Create');
await settle(1200);
check('private chat: a lock in the list and the title', [await rows('channels'), await ev(`!!document.querySelector('#main-chat-title .lock')`)], [['#general', '#staff🔒'], true]);
check('its note', await ev(`document.querySelector('${M} .chat-privacy').textContent.startsWith('Private: only its members and the admins')`), true);
check('admin menu on a private chat', await rowMenu('channels', 'staff'), ['Open', 'Open in Side Panel', 'Copy Link', 'Move Up', 'Members…', 'Make Public', 'Rename…', 'Delete']);
await key('Escape');
await api('POST', '/api/channels/staff/messages', { text: 'staff only' }, 'Paul');

// Alex sees neither the private chat nor anything from it; the DM is his.
await as('Alex');
await reload('#chan=general');
check('Alex: no staff, and the DM with Steve', await rows('channels'), ['#general', '@Steve']);
check('a link to staff goes nowhere', (await (await fetch(`${HUB}/api/channels/staff/messages`, { headers: { cookie: (await import('./lib.mjs')).COOKIE.Alex } })).status), 404);
check('DM menu has Hide', (await rowMenu('channels', 'Steve')).filter((x) => x !== 'Mark as Read'), ['Open', 'Open in Side Panel', 'Copy Link', 'Hide']); // read markers are per browser, shared by the test's accounts
await menuPick('Hide');
await settle(800);
check('hidden', await rows('channels'), ['#general']);
await api('POST', `/api/channels/${dm}/messages`, { text: 'still there?' }, 'Steve');
await settle(1000);
check('back on its next message', await rows('channels'), ['#general', '@Steve']);

// Paul makes staff public: Alex's list gets it live.
await api('PUT', '/api/channels/staff/kind', { kind: '' }, 'Paul');
await settle(1000);
check('made public: it appears for Alex', await rows('channels'), ['#general', '#staff', '@Steve']);

await done();
