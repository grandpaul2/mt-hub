// Message actions in chat: the hover toolbar, reactions, reply, forward, pins (admins),
// message links that load older history, shift-delete, and dragging screenshots, map art
// and schematic posts in from the tree and folder views to link them.
import { answerDialogs, api, check, done, ev, HUB, hub, key, send, settle, shot, typeText } from './lib.mjs';

const paul = (method, path, body) => api(method, path, body, 'Paul');
const msgs = async (ch) => (await (await hub(`/api/channels/${ch}/messages`)).json());
// The oldest message, then enough filler that it's off the first page (100) of history.
const oldest = await (await paul('POST', '/api/channels/general/messages', { text: 'the very first message' })).json();
for (let i = 0; i < 110; i++) await api('POST', '/api/channels/general/messages', { text: `filler ${i}` });
const farm = await (await api('POST', '/api/channels/general/messages', { text: 'farm is up' })).json();
const hello = await (await paul('POST', '/api/channels/general/messages', { text: 'hello' })).json();
await paul('POST', '/api/channels', { name: 'builds' });

await send('Page.navigate', { url: HUB });
await settle(500);
await ev(`localStorage.setItem('mt-chat-hidden','1')`);
await send('Page.navigate', { url: `${HUB}/?r=1#chan=general` });
await settle(2000);
const M = '#main-chat';
const msgEl = (id) => `document.querySelector('${M} .msg[data-id="${id}"]')`;
const tools = (id) => ev(`[...${msgEl(id)}.querySelectorAll('.msg-tools button')].map((b) => b.dataset.tool)`);
const tool = (id, name) => ev(`${msgEl(id)}.querySelector('.msg-tools [data-tool="${name}"]').click()`);
const lastMsg = async () => (await msgs('general')).pop();

// Toolbar: others' messages (admin view) have no Edit; yours do.
check('toolbar on someone else’s', await tools(farm.id), ['react', 'reply', 'forward', 'copy', 'trash', 'more']);
check('toolbar on yours', await tools(hello.id), ['react', 'reply', 'forward', 'edit', 'copy', 'trash', 'more']);
const box = await ev(`(() => { const r = ${msgEl(farm.id)}.getBoundingClientRect(); return [r.x + 200, r.y + 10]; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0], y: box[1] });
await settle(200);
check('toolbar shows on hover', await ev(`getComputedStyle(${msgEl(farm.id)}.querySelector('.msg-tools')).display`), 'flex');
await shot('toolbar');

// Reactions: the picker adds one; someone else adds the same; clicking yours takes it back.
await tool(farm.id, 'react');
await settle(200);
await settle(400); // the emoji list loads on first use
check('picker: recently used + every category', await ev(`[document.querySelector('.emoji-pop .emoji-grid').children.length, document.querySelectorAll('.emoji-pop .emoji-head').length, document.querySelectorAll('.emoji-pop .emoji-cell').length > 1500]`), [8, 10, true]);
await shot('picker');
check('emoji drawn as images', await ev(`[...document.querySelectorAll('.emoji-pop img.emoji')].slice(0, 40).every((i) => i.complete && i.naturalWidth > 0)`), true);
await ev(`[...document.querySelectorAll('.emoji-pop .emoji-cell')].find((b) => b.title === ':fire:').click()`);
await settle(600);
const chips = () => ev(`[...${msgEl(farm.id)}.querySelectorAll('.reaction:not(.add)')].map((b) => b.querySelector('img.emoji').alt + b.textContent + (b.classList.contains('mine') ? '*' : ''))`);
check('reacted', [await chips(), await ev(`!!document.querySelector('.emoji-pop')`)], [['🔥1*'], false]);
await api('PUT', `/api/channels/general/messages/${farm.id}/reactions/${encodeURIComponent('🔥')}`);
await settle(600);
check('someone else’s arrives live', await chips(), ['🔥2*']);
check('chip names who', await ev(`${msgEl(farm.id)}.querySelector('.reaction').title`), 'Paul, Alex reacted with 🔥');
await ev(`${msgEl(farm.id)}.querySelector('.reaction').click()`);
await settle(600);
check('click takes yours back', await chips(), ['🔥1']);

// Reply: the bar, the quote, live edits of the original, Esc cancels.
await tool(farm.id, 'reply');
await settle(200);
check('reply bar', await ev(`document.querySelector('${M} .reply-bar').hidden ? null : document.querySelector('${M} .reply-bar span').textContent`), 'Replying to Alex');
await typeText('nice farm');
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await settle(800);
const reply = await lastMsg();
check('reply stored', [reply.text, reply.reply_to, reply.reply?.text], ['nice farm', farm.id, 'farm is up']);
const quote = () => ev(`${msgEl(reply.id)}?.querySelector('.reply-quote')?.textContent ?? null`);
check('quote shown, bar gone', [await quote(), await ev(`document.querySelector('${M} .reply-bar').hidden`)], ['Alexfarm is up', true]);
await api('PATCH', `/api/channels/general/messages/${farm.id}`, { text: 'farm is up (fixed)' });
await settle(600);
check('quote follows an edit', await quote(), 'Alexfarm is up (fixed)');
await tool(hello.id, 'reply');
await settle(100);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await settle(200);
check('esc cancels reply', await ev(`document.querySelector('${M} .reply-bar').hidden`), true);
await shot('reply');

// Forward: pick a chat, add a note; the copy shows where it came from, which links back.
await tool(hello.id, 'forward');
await settle(200);
check('forward dialog lists chats', await ev(`[...document.querySelectorAll('#dialog .fwd-chan')].map((b) => b.textContent)`), ['#builds', '#general']);
await ev(`document.querySelector('#dialog .fwd-chan').click(); document.querySelector('#dialog textarea').value = 'look at this'`);
await shot('forward');
await ev(`document.querySelector('#dialog .actions .primary').click()`);
await settle(800);
const fw = (await msgs('builds')).pop();
check('forwarded copy', [fw.text, fw.fwd?.text, fw.fwd?.user, fw.fwd?.channel], ['look at this', 'hello', 'Paul', 'general']);
await send('Page.navigate', { url: `${HUB}/?r=2#chan=builds` });
await settle(2000);
check('forward box', await ev(`[document.querySelector('${M} .fwd .fwd-label').textContent, document.querySelector('${M} .fwd .msg-body').textContent]`), ['Forwarded', 'hello']);
await ev(`document.querySelector('${M} .fwd-src').click()`);
await settle(1200);
check('source link goes back', [await ev(`decodeURIComponent(location.hash)`), await ev(`${msgEl(hello.id)}?.classList.contains('flash')`)], ['#chan=general', true]);

// Pins: admins only (menu and server); the pins list jumps to the message.
await ev(`${msgEl(farm.id)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))`);
const menu = await ev(`[...document.querySelectorAll('#menu button span:first-child')].map((s) => s.textContent)`);
check('message menu', menu, ['Add Reaction…', 'Reply', 'Forward…', 'Copy Text', 'Copy Link', 'Pin Message', 'Delete']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Pin Message')).click()`);
await settle(600);
check('pinned mark', await ev(`!!${msgEl(farm.id)}.querySelector('.pin-mark')`), true);
// A pinned message's menu offers Unpin, from ⋯ and right-click.
const menuLabels = () => ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent)`);
await tool(farm.id, 'more');
const moreMenu = await menuLabels();
await key('Escape');
await ev(`${msgEl(farm.id)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))`);
const rightMenu = await menuLabels();
await key('Escape');
check('pinned: menus offer Unpin', [moreMenu.includes('Unpin Message'), moreMenu.includes('Pin Message'), rightMenu.includes('Unpin Message')], [true, false, true]);
check('non-admin can’t pin', (await api('PUT', `/api/channels/general/messages/${hello.id}/pin`)).status, 403);
await ev(`document.querySelector('${M} .pins-btn').click()`);
await settle(500);
check('pins list', await ev(`[...document.querySelectorAll('.pins-pop .pin-item .msg-body')].map((d) => d.textContent)`), ['farm is up (fixed)']);
await shot('pins');
// A real click on the pin button again closes the list (and doesn't reopen it).
const realClick = async (sel) => {
  const [x, y] = await ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};
await realClick(`${M} .pins-btn`);
await settle(500);
check('pin button toggles the list shut', await ev(`!!document.querySelector('.pins-pop')`), false);
await realClick(`${M} .pins-btn`);
await settle(500);
check('pin button opens it again', await ev(`!!document.querySelector('.pins-pop')`), true);
await ev(`document.querySelector('${M} .messages').scrollTop = 0`);
await ev(`document.querySelector('.pins-pop .pin-item').click()`);
await settle(600);
check('pin jumps to message', [await ev(`!!document.querySelector('.pins-pop')`), await ev(`${msgEl(farm.id)}.classList.contains('flash')`)], [false, true]);
// The ⋯ button toggles its menu the same way (real clicks, with the message hovered).
const [hx, hy] = await ev(`(() => { ${msgEl(farm.id)}.scrollIntoView({ block: 'center' }); const r = ${msgEl(farm.id)}.getBoundingClientRect(); return [r.x + 200, r.y + 10]; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy });
await settle(200);
await realClick(`${M} .msg[data-id="${farm.id}"] [data-tool="more"]`);
await settle(300);
check('⋯ opens the menu', await ev(`!document.getElementById('menu').hidden`), true);
await realClick(`${M} .msg[data-id="${farm.id}"] [data-tool="more"]`);
await settle(300);
check('⋯ again closes it', await ev(`document.getElementById('menu').hidden`), true);

// A message link to one far back loads older history until it's there.
await send('Page.navigate', { url: `${HUB}/?r=3#chan=general&msg=${oldest.id}` });
await settle(3000);
check('link loads older and jumps', await ev(`${msgEl(oldest.id)}?.classList.contains('flash') ?? 'not loaded'`), true);

// Drag a screenshot and a schematic post's folder from the tree, and map art from its folder, onto the chat.
await ev(`localStorage.setItem('mt-expanded', '["screenshots","schematics"]')`);
await send('Page.navigate', { url: `${HUB}/?r=4#chan=general` });
await settle(2000);
const dragInto = (srcSel) => ev(`(() => {
  const dt = new DataTransfer();
  document.querySelector(${JSON.stringify(srcSel)}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const pane = document.querySelector('${M} .chat-body');
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  pane.querySelector('.messages').dispatchEvent(over);
  pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return over.defaultPrevented;
})()`);
const compose = () => ev(`document.querySelector('${M} .compose').value`);
const shotRow = await ev(`document.querySelector('#tree .row[data-path^="screenshots/"]').dataset.path`);
const schemRow = 'schematics/Build 1';
check('tree row draggable', await ev(`document.querySelector('#tree .row[data-path^="screenshots/"]').draggable`), true);
check('drop accepted on the messages', await dragInto('#tree .row[data-path^="screenshots/"]'), true);
check('screenshot link in the box', await compose(), `#[${shotRow}] `);
await dragInto('#tree .row[data-path="schematics/Build 1"]');
check('schematic link added', await compose(), `#[${shotRow}] #[${schemRow}] `);
await ev(`document.querySelector('${M} .compose').focus()`);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await settle(1000);
const refMsg = await lastMsg();
check('previews, not links', await ev(`[${msgEl(refMsg.id)}.querySelectorAll('.file-link').length, ${msgEl(refMsg.id)}.querySelector('.ref-pic').title, ${msgEl(refMsg.id)}.querySelector('.ref-file').textContent]`),
  [0, shotRow.slice('screenshots/'.length), 'farm.litematic']);
check('thumbnail + card', await ev(`[${msgEl(refMsg.id)}.querySelectorAll('.ref-pic img').length, ${msgEl(refMsg.id)}.querySelector('.ref-card .ref-title')?.textContent, ${msgEl(refMsg.id)}.querySelector('.ref-card .muted')?.textContent]`), [1, 'Build 1', 'Design by Glowsquid']);
await settle(500);
await shot('refs');
await ev(`${msgEl(refMsg.id)}.querySelector('.ref-pic').click()`);
await settle(300);
check('picture opens the viewer', await ev(`decodeURIComponent(document.querySelector('.viewer-stage img').getAttribute('src'))`), `/api/file/${shotRow}`);
await ev(`document.querySelector('.viewer-tools [title="Open folder"]').click()`);
await settle(800);
check('open folder: the screenshot', await ev(`decodeURIComponent(location.hash)`), `#${shotRow}`);
await ev(`location.hash = '#folder=map art'`);
await settle(1000);
await ev(`localStorage.setItem('mt-chat-hidden','0')`);
await ev(`document.body.classList.contains('chat-hidden') && document.getElementById('chat-hide').click()`);
await settle(300);
check('drop from the map art folder', await ev(`(() => {
  const dt = new DataTransfer();
  document.querySelector('#main-folder .shot').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const pane = document.getElementById('chat-body');
  pane.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return document.querySelector('#chat .compose').value;
})()`), '#[map art/MA-001 Logo.png] ');

// The schematic card opens the post in the Schematic Manager.
await send('Page.navigate', { url: `${HUB}/?r=6#chan=general` });
await settle(2000);
await ev(`${msgEl(refMsg.id)}.querySelector('.ref-card').click()`);
await settle(600);
check('card opens the post', await ev(`decodeURIComponent(location.hash)`), '#schem=Build 1');

// The delete question shows the message as the chat draws it: name, time, text and picture,
// with nothing to click; a long one is capped and scrolls.
const pic = await (await paul('POST', '/api/channels/general/messages', { text: 'look at this #[map art/MA-001 Logo.png]' })).json();
const long = await (await paul('POST', '/api/channels/general/messages', { text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') })).json();
await send('Page.navigate', { url: `${HUB}/?r=7#chan=general` });
await settle(2000);
await answerDialogs(null);
const P = `document.querySelector('#dialog.ask .del-preview')`;
await tool(pic.id, 'trash');
await settle(600);
check('delete question shows the message', await ev(`(() => { const p = ${P}; return [document.querySelector('#dialog h2').textContent, p.querySelector('.msg-head .who').textContent,
  !!p.querySelector('.msg-head .when').textContent, p.querySelector('.msg-body').textContent.trim(), !!p.querySelector('.refs img'), !!p.querySelector('.msg-tools'), p.querySelector('.msg').inert]; })()`),
  ['Delete this message?', 'Paul', true, 'look at this', true, false, true]);
await shot('delete-preview');
await ev(`document.querySelector('#dialog .actions button:first-child').click()`);
await settle(300);
check('Cancel keeps it', (await msgs('general')).some((m) => m.id === pic.id), true);
await tool(long.id, 'trash');
await settle(600);
check('a long message is capped and scrolls', await ev(`(() => { const p = ${P}; return [p.clientHeight <= 200, p.scrollHeight > p.clientHeight, getComputedStyle(p).overflowY]; })()`), [true, true, 'auto']);
await ev(`document.querySelector('#dialog .actions button:last-child').click()`);
await settle(600);
check('Delete deletes it', (await msgs('general')).some((m) => m.id === long.id), false);
await api('DELETE', `/api/channels/general/messages/${pic.id}`);
await settle(300);

// Shift+click delete: no question.
await send('Page.navigate', { url: `${HUB}/?r=5#chan=general` });
await settle(2000);
await answerDialogs(false);
await ev(`${msgEl(hello.id)}.querySelector('[data-tool="trash"]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))`);
await settle(800);
check('shift-delete skips the question', (await msgs('general')).some((m) => m.id === hello.id), false);
await api('DELETE', `/api/channels/general/messages/${farm.id}`);
await settle(600);
check('reply to a deleted message', await quote(), 'Original message was deleted');

await done();
