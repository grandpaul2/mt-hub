// Files posted in chat: anything dropped, pasted or picked into a chat is kept with the chat
// (not in Files) and linked in the box; links to pictures, videos and sounds (and to
// screenshots, map art and schematics) show as previews, other files as a card. Also the
// chat's file list, mention highlights, reply quotes of picture-only messages, a chat rename
// taking its files along, and deleting a message with its files.
import { api, check, COOKIE, done, ev, HUB, hub, key, SEED, send, settle, shot } from './lib.mjs';

const paul = (method, path, body) => api(method, path, body, 'Paul');
const tree = async () => (await (await hub(`/api/tree`)).json()).map((e) => e.path);
const msgs = async (ch) => (await (await hub(`/api/channels/${ch}/messages`)).json());
const postFile = async (chat, name, body) =>
  (await (await fetch(`${HUB}/api/channels/${chat}/media?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie: COOKIE.Paul }, body })).json()).path;
await api('POST', '/api/channels/general/messages', { text: 'hi all' }); // Alex has posted: a known name

await send('Page.navigate', { url: HUB });
await settle(500);
await ev(`localStorage.setItem('mt-chat-hidden','1')`);
await send('Page.navigate', { url: `${HUB}/?r=1#chan=general` });
await settle(2000);
const M = '#main-chat';
const compose = () => ev(`document.querySelector('${M} .compose').value`);
const clear = () => ev(`document.querySelector('${M} .compose').value = ''`);
// A real PNG made in the page, wrapped as a File.
const fileJs = (name, type = 'image/png') => `(async () => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 120;
  const g = c.getContext('2d'); g.fillStyle = '#3a7'; g.fillRect(0, 0, 200, 120);
  return new File([await new Promise((r) => c.toBlob(r, 'image/png'))], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
})()`;
const dropFiles = (names) => ev(`(async () => {
  const dt = new DataTransfer();
  for (const n of ${JSON.stringify(names)}) {
    if (n.endsWith('.png')) dt.items.add(await ${fileJs('NAME').replace('"NAME"', 'n')});
    else dt.items.add(new File(['text'], n, { type: 'text/plain' }));
  }
  const pane = document.querySelector('${M} .chat-body');
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  pane.querySelector('.messages').dispatchEvent(over);
  pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return over.defaultPrevented;
})()`);
const enter = async () => {
  await ev(`document.querySelector('${M} .compose').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await settle(1000);
};
const msgEl = (id) => `document.querySelector('${M} .msg[data-id="${id}"]')`;

// Drop a picture and a text file: both are posted in the chat, links go in the box; nothing
// lands in Files.
check('pane takes files', await dropFiles(['farm.png', 'notes.txt']), true);
await settle(1500);
check('posted in the chat', [(await tree()).filter((p) => p.startsWith('media')), await ev(`document.getElementById('toast').textContent`),
  (await hub(`/api/channels/general/media/farm.png`)).status], [[], 'Uploaded 2 files', 200]);
check('links in the box', await compose(), '#media/general/farm.png #media/general/notes.txt ');
await clear();
await dropFiles(['farm.png']);
await settle(1500);
check('same name gets (2)', await compose(), '#[media/general/farm (2).png] ');

// Paste a picture (browsers call it image.png): named after the time and the poster.
await ev(`(async () => {
  const dt = new DataTransfer(); dt.items.add(await ${fileJs('image.png')});
  document.querySelector('${M} .compose').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
})()`);
await settle(1500);
check('pasted picture named by time', /#\[media\/general\/\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d Paul\.png\] $/.test(await compose()), true);
await ev(`document.querySelector('${M} .compose').value = 'look at these ' + document.querySelector('${M} .compose').value + ' #media/general/notes.txt'`);
await enter();
const posted = (await msgs('general')).pop();
const prev = () => ev(`[...${msgEl(posted.id)}.querySelectorAll('.refs > *')].map((e) => e.className)`);
check('message: text only, no link chips', await ev(`[${msgEl(posted.id)}.querySelector('.msg-body').textContent.trim(), ${msgEl(posted.id)}.querySelectorAll('.file-link').length]`), ['look at these', 0]);
check('a preview for each picture, a card for the file', await prev(), ['ref-pic', 'ref-pic', 'file-card']);
await settle(800);
check('thumbnails load', await ev(`[...${msgEl(posted.id)}.querySelectorAll('.ref-pic img')].map((i) => [i.getAttribute('src').startsWith('/api/channels/general/thumb/'), i.naturalWidth])`), [[true, 200], [true, 200]]);
check('thumbnail is a JPEG', (await hub(`/api/channels/general/thumb/farm.png`)).headers.get('content-type'), 'image/jpeg');
check('file card: name and size', await ev(`[${msgEl(posted.id)}.querySelector('.file-card .file-name').textContent, ${msgEl(posted.id)}.querySelector('.file-card .file-size').textContent]`), ['notes.txt', '4 B']);
await shot('previews');
await ev(`${msgEl(posted.id)}.querySelector('.ref-pic').click()`);
await settle(300);
check('click opens the viewer on the message’s pictures', await ev(`[document.querySelector('.viewer-stage img').getAttribute('src'), document.querySelector('.viewer-when').textContent.endsWith('1 / 2'), !!document.querySelector('.viewer-tools [title="Save to Files…"]')]`),
  ['/api/channels/general/media/farm%20(2).png', true, true]);
await key('Escape');
await send('Page.navigate', { url: `${HUB}/?r=2#chan=general` });
await settle(2000);

// A video and a screenshot link: a player, and the screenshot's picture, no chips.
const clip = await postFile('general', 'clip.mp4', 'not really a video');
await paul('POST', '/api/channels/general/messages', { text: `#${clip} #[screenshots/${SEED.shots[0]}]` });
await settle(1000);
const vid = (await msgs('general')).pop();
check('video player + screenshot', await ev(`[[...${msgEl(vid.id)}.querySelectorAll('.refs > *')].map((e) => e.className), !!${msgEl(vid.id)}.querySelector('video[controls]'), !!${msgEl(vid.id)}.querySelector('.msg-body')]`), [['ref-video', 'ref-pic'], true, false]);
// Files posted in chat get Save to Files on the toolbar; pictures in Files get Open folder.
check('save to Files on the toolbar', await ev(`[...${msgEl(vid.id)}.querySelectorAll('.msg-tools button')].map((b) => b.dataset.tool).includes('save')`), true);
await paul('POST', '/api/channels/general/messages', { text: `#[screenshots/${SEED.shots[0]}]` });
await settle(1000);
const shotMsg = (await msgs('general')).pop();
await ev(`${msgEl(shotMsg.id)}.querySelector('.msg-tools [data-tool="folder"]').click()`);
await settle(600);
check('open folder shows a picture in Files', await ev(`document.querySelector('#tree .row.active')?.dataset.path`), `screenshots/${SEED.shots[0]}`);
await send('Page.navigate', { url: `${HUB}/?r=3#chan=general` });
await settle(1500);

// Reply to a picture-only message: the quote names the files, not their links.
await ev(`${msgEl(vid.id)}.querySelector('[data-tool="reply"]').click()`);
await ev(`document.querySelector('${M} .compose').value = 'nice'`);
await enter();
const reply = (await msgs('general')).pop();
const quoteText = await ev(`${msgEl(reply.id)}.querySelector('.reply-quote .text').textContent`);
check('quote names media, no codes', [quoteText.startsWith('[clip.mp4] [2026-'), quoteText.endsWith('.png]'), quoteText.includes('#')], [true, true, false]);

// Mentions: someone who has posted, and @everyone, get the highlight; unknown names don't.
await paul('POST', '/api/channels/general/messages', { text: '@Alex and @everyone, not @nobody or me@mail' });
await settle(800);
const men = (await msgs('general')).pop();
check('mention highlights', await ev(`[...${msgEl(men.id)}.querySelectorAll('.mention')].map((s) => s.textContent)`), ['@Alex', '@everyone']);
await shot('mentions');

// The + button opens a file picker for any file.
check('+ button', await ev(`[!!document.querySelector('${M} .attach'), document.querySelector('${M} input[type=file]').accept]`), [true, '']);

// Both panes' headers: files, then pins rightmost.
check('header buttons: files, then pins', await ev(`['#main-chat', '#chat'].map((p) => [...document.querySelectorAll(p + ' .chat-head .tool')].filter((b) => b.matches('.files-btn, .pins-btn')).map((b) => b.classList[1]))`),
  [['files-btn', 'pins-btn'], ['files-btn', 'pins-btn']]);

// The chat's file list (the paperclip): newest first; a click jumps to the message.
await ev(`document.querySelector('#main-chat .files-btn').click()`);
await settle(600);
const listed = await ev(`[...document.querySelectorAll('.pins-pop .file-item .file-name')].map((n) => n.textContent)`);
check('file list', [listed?.length, listed?.[0], listed?.[1], /Paul\.png$/.test(listed?.[2]), listed?.[3]], [4, 'clip.mp4', 'notes.txt', true, 'farm (2).png']);
await shot('file-list');
await ev(`[...document.querySelectorAll('.pins-pop .file-item')].at(-1).click()`);
await settle(800);
check('click jumps to its message', await ev(`[!document.querySelector('.pins-pop'), ${msgEl(posted.id)}.classList.contains('flash')]`), [true, true]);
// Files can't use the name media/.
check('Files keeps media/ free', (await fetch(`${HUB}/api/file/media/x.txt?base=`, { method: 'PUT', headers: { cookie: COOKIE.Paul }, body: 'x' })).status, 400);

// Renaming the chat takes its files along; the old links still show their pictures.
await paul('PATCH', '/api/channels/general', { name: 'lobby' });
await settle(1500);
check('old links still preview', await ev(`[...${msgEl(posted.id)}?.querySelectorAll('.ref-pic img') ?? []].map((i) => i.getAttribute('src').startsWith('/api/channels/lobby/thumb/'))`), [true, true]);

// Deleting the last message that links a file offers to delete the file (ticked); a file
// another message still links just stays, with the plain question. Linked from another chat,
// a file gets its own copy there.
const solo = await postFile('lobby', 'solo.png', 'x');
const sharedFile = await postFile('lobby', 'shared.zip', 'x');
await paul('POST', '/api/channels', { name: 'builds' });
const soloMsg = await (await paul('POST', '/api/channels/lobby/messages', { text: `just mine #${solo}` })).json();
const shared = await (await paul('POST', '/api/channels/lobby/messages', { text: `#${sharedFile}` })).json();
await paul('POST', '/api/channels/lobby/messages', { text: `again #[${sharedFile}]` });
const copied = await (await paul('POST', '/api/channels/builds/messages', { text: `also here #[${sharedFile}]` })).json();
check('linked from another chat: its own copy', [copied.text, (await hub(`/api/channels/builds/media/shared.zip`)).status], ['also here #media/builds/shared.zip', 200]);
await settle(1000);
await ev(`${msgEl(soloMsg.id)}.querySelector('[data-tool="trash"]').click()`);
await settle(500);
check('last link: asks about the file', await ev(`[!document.getElementById('overlay').hidden, document.querySelector('#dialog label.check')?.textContent, document.querySelector('#dialog label.check input').checked]`),
  [true, 'Also delete its file: solo.png. No other message links it, and files posted in chat have no history: this can’t be undone.', true]);
await shot('delete-file');
await ev(`document.querySelector('#dialog .actions .danger').click()`);
await settle(800);
check('message and file gone', [(await msgs('lobby')).some((m) => m.id === soloMsg.id), (await hub(`/api/channels/lobby/media/solo.png`)).status], [false, 404]);
await ev(`${msgEl(shared.id)}.querySelector('[data-tool="trash"]').click()`);
await settle(500);
check('still linked elsewhere: a plain question, red Delete', await ev(`[document.querySelector('#dialog h2').textContent, !!document.querySelector('#dialog label.check'), document.querySelector('#dialog .actions button:last-child').className]`), ['Delete this message?', false, 'danger']);
await ev(`document.querySelector('#dialog .actions .danger').click()`);
await settle(800);
check('still linked elsewhere: file kept', [await ev(`document.getElementById('overlay').hidden`), (await msgs('lobby')).some((m) => m.id === shared.id), (await hub(`/api/channels/lobby/media/shared.zip`)).status], [true, false, 200]);

// Deleting a chat: one plain question; its files go with it.
await paul('POST', '/api/channels', { name: 'trash-me' });
await settle(1000);
await ev(`[...document.querySelectorAll('#channels .row.channel')].find((r) => r.textContent.includes('trash-me')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }))`);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Delete')).click()`);
await settle(500);
check('chat delete: one question', await ev(`[document.querySelector('#dialog h2').textContent, document.querySelector('#dialog p')?.textContent, !!document.querySelector('#dialog label.check')]`),
  ['Delete #trash-me?', 'It disappears for everyone. Its messages and files are kept on the server (chat/.deleted).', false]);
await ev(`document.querySelector('#dialog .actions .danger').click()`);
await settle(800);
check('chat gone', (await (await hub(`/api/channels`)).json()).some((c) => c.name === 'trash-me'), false);

await done();
