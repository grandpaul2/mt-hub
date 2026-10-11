// Files in the message box (Discord's way): a pasted, dropped or picked file waits as a card
// above the text and reaches the hub only when the message is sent. Each card can be removed;
// a failed upload turns its card red and nothing is posted; a message can be files only.
// Editing shows the words without the file links, and the files as cards with an x.
import { api, check, done, ev, HUB, hub, send, settle, shot } from './lib.mjs';

const msgs = async (ch) => (await (await hub(`/api/channels/${ch}/messages`)).json());
const status = async (file) => (await hub(`/api/channels/general/media/${encodeURIComponent(file)}`)).status;

await api('POST', '/api/channels', { name: 'builds' }, 'Paul');
await send('Page.navigate', { url: HUB });
await settle(500);
await ev(`localStorage.setItem('mt-chat-hidden','1')`);
await send('Page.navigate', { url: `${HUB}/?r=1#chan=general` });
await settle(2000);
const M = '#main-chat';
const box = `document.querySelector('${M} .compose')`;
const type = (text) => ev(`${box}.value = ${JSON.stringify(text)}`);
const cards = () => ev(`[...document.querySelectorAll('${M} .composer .pend')].map((c) => [c.querySelector('.pend-name').textContent, c.className.replace('pend ', ''), c.querySelector('.pend-note').textContent])`);
const give = (how, names) => ev(`(async () => {
  const dt = new DataTransfer();
  for (const n of ${JSON.stringify(names)}) {
    if (n.endsWith('.png')) {
      const c = document.createElement('canvas'); c.width = 200; c.height = 120;
      c.getContext('2d').fillRect(0, 0, 200, 120);
      dt.items.add(new File([await new Promise((r) => c.toBlob(r, 'image/png'))], n, { type: 'image/png' }));
    } else dt.items.add(new File(['text'], n, { type: 'text/plain' }));
  }
  if (${JSON.stringify(how)} === 'paste') ${box}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  else document.querySelector('${M} .chat-body').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
})()`);
const enter = async (sel = box) => {
  await ev(`${sel}.focus()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await settle(1200);
};
const msgEl = (id) => `document.querySelector('${M} .msg[data-id="${id}"]')`;

// Dropped and pasted files wait in the tray: no link text in the box, nothing on the hub.
check('no tray to start with', await ev(`document.querySelector('${M} .pend-tray').hidden`), true);
await give('drop', ['farm.png', 'notes.txt']);
await give('paste', ['image.png']);
await settle(500);
const waiting = await cards();
check('three cards: name, state, size', [waiting.length, waiting[0], waiting[1], /^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d Paul\.png$/.test(waiting[2][0])],
  [3, ['farm.png', 'ready', waiting[0][2]], ['notes.txt', 'ready', '4 B'], true]);
check('the box has no link text', await ev(`${box}.value`), '');
check('a picture shows from the browser, a file as its icon', await ev(`[...document.querySelectorAll('${M} .composer .pend-thumb > *')].map((e) => [e.tagName, e.src.slice(0, 5), e.classList.contains('icon')])`),
  [['IMG', 'blob:', false], ['IMG', 'http:', true], ['IMG', 'blob:', false]]);
check('nothing is on the hub yet', [await status('farm.png'), await status('notes.txt')], [404, 404]);
await settle(600);
await shot('tray');

// The x takes a file out; it never reached the hub.
await ev(`document.querySelectorAll('${M} .composer .pend')[1].querySelector('[title="Remove file"]').click()`);
check('x removes a card', (await cards()).map((c) => c[0]).slice(0, 1).concat((await cards()).length), ['farm.png', 2]);

// The tray stays with its chat (like the draft) while another chat is open.
await ev(`location.hash = '#chan=builds'`);
await settle(800);
const elsewhere = await ev(`[document.querySelector('${M} .pend-tray').hidden, document.querySelectorAll('${M} .composer .pend').length]`);
await ev(`location.hash = '#chan=general'`);
await settle(800);
check('the tray belongs to its chat', [elsewhere, (await cards()).length], [[true, 0], 2]);

// A failed upload: its card turns red, nothing is posted, and the text stays in the box.
const before = (await msgs('general')).length;
await type('look at these');
await send('Network.setBlockedURLs', { urls: ['*/api/channels/general/media?*'] });
await enter();
const failed = await cards();
check('failed cards say so', [failed.map((c) => c[1]), failed[0][2].startsWith('Couldn’t upload: ')], [['failed', 'failed'], true]);
check('nothing posted, text kept', [(await msgs('general')).length, await ev(`${box}.value`), await ev(`${box}.readOnly`)], [before, 'look at these', false]);
await shot('failed');
await send('Network.setBlockedURLs', { urls: [] });
await ev(`document.querySelector('${M} .composer .pend [title="Try again"]').click()`);
await settle(1500);
const posted = (await msgs('general')).pop();
check('Try again sends the message with its files', [posted.text.startsWith('look at these #media/general/farm.png #[media/general/'), await status('farm.png'), (await cards()).length, await ev(`${box}.value`)],
  [true, 200, 0, '']);
check('drawn as words and pictures, no link text', await ev(`[${msgEl(posted.id)}.querySelector('.msg-body').textContent.trim(), [...${msgEl(posted.id)}.querySelectorAll('.refs > *')].map((e) => e.className), ${msgEl(posted.id)}.querySelectorAll('.file-link').length]`),
  ['look at these', ['ref-pic', 'ref-pic'], 0]);

// A message can be files only. It has no Copy Text; one with words does.
await give('drop', ['plan.txt']);
await settle(300);
await enter();
const only = (await msgs('general')).pop();
check('a files-only message', [only.text, await ev(`[...${msgEl(only.id)}.querySelectorAll('.refs > *')].map((e) => e.className)`)], ['#media/general/plan.txt', ['file-card']]);
check('Copy text only where there are words', await ev(`[${msgEl(posted.id)}, ${msgEl(only.id)}].map((m) => !!m.querySelector('.msg-tools [data-tool="copy"]'))`), [true, false]);

// More than ten files: the first ten wait, and a toast says why.
await give('drop', Array.from({ length: 12 }, (_, i) => `f${i}.txt`));
await settle(300);
check('ten files a message', [(await cards()).length, await ev(`document.getElementById('toast').textContent`)], [10, 'A message takes up to 10 files.']);
for (let i = 0; i < 10; i++) await ev(`document.querySelector('${M} .composer .pend [title="Remove file"]').click()`);
check('tray empties and hides', await ev(`document.querySelector('${M} .pend-tray').hidden`), true);

// Editing: the box has the words only; the files are cards. Removing one and saving takes it
// out of the message, and the hub trashes it.
const editBox = `${msgEl(posted.id)}.querySelector('.msg-edit textarea')`;
await ev(`${msgEl(posted.id)}.querySelector('.msg-tools [data-tool="edit"]').click()`);
await settle(500);
check('edit box: words, and a card per file', [await ev(`${editBox}.value`), await ev(`[...${msgEl(posted.id)}.querySelectorAll('.msg-edit .pend-name')].map((n) => n.textContent)`).then((n) => [n.length, n[0]])],
  ['look at these', [2, 'farm.png']]);
await shot('edit');
await ev(`${msgEl(posted.id)}.querySelector('.msg-edit .pend [title="Remove file"]').click()`);
await ev(`${editBox}.value = 'look at this'`);
await enter(editBox);
const edited = (await msgs('general')).find((m) => m.id === posted.id);
check('saved: new words, one file fewer', [edited.text.startsWith('look at this #[media/general/'), edited.text.includes('farm.png'), await status('farm.png')], [true, false, 404]);
check('still drawn without link text', await ev(`[${msgEl(posted.id)}.querySelector('.msg-body').textContent.trim().replace(/\\s*\\(edited\\)$/, ''), ${msgEl(posted.id)}.querySelectorAll('.refs .ref-pic').length]`), ['look at this', 1]);

// Editing everything away asks to delete the message instead (Discord).
await ev(`${msgEl(only.id)}.querySelector('.msg-tools [data-tool="edit"]').click()`);
await settle(400);
await ev(`${msgEl(only.id)}.querySelector('.msg-edit .pend [title="Remove file"]').click()`);
await enter(`${msgEl(only.id)}.querySelector('.msg-edit textarea')`);
check('nothing left: asks to delete', await ev(`document.querySelector('#dialog h2, #dialog .title')?.textContent`), 'Delete this message?');

await done();
