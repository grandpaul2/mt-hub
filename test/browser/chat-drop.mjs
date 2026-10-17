// One rule for files in chat (spec: anything dragged or pasted in becomes a card, never text).
// How a message shows its links: every link to a file or folder gets a card under the message;
// its text is hidden when it stands alone (its own line, or after the words at the end), and
// stays a blue link inside a sentence. Then the drops: from the tree, out of a message, into a
// message being edited, onto the rest of the page, and a private chat's file into another chat.
// The drops here are synthesized DragEvents in headless Chromium, not real drags.
import { api, check, done, ev, HUB, hub, png, SEED, send, settle, shot } from './lib.mjs';

const M = '#main-chat';
const msgs = async (ch) => (await (await hub(`/api/channels/${ch}/messages`)).json());
const postFile = (ch, name, body) => hub(`/api/channels/${ch}/media?name=${encodeURIComponent(name)}`, { method: 'POST', body });
const say = async (ch, text, who = 'Paul') => (await (await api('POST', `/api/channels/${ch}/messages`, { text }, who)).json());
const msgEl = (id) => `document.querySelector('${M} .msg[data-id="${id}"]')`;

await api('POST', '/api/channels', { name: 'shapes' }, 'Paul');
await api('POST', '/api/channels', { name: 'staff', kind: 'private', members: ['Alex'] }, 'Paul');
await postFile('shapes', 'a.png', png(120, 80, [200, 40, 40]));
await postFile('staff', 'secret.png', png(120, 80, [40, 200, 40]));
const shot1 = `screenshots/${SEED.shots[0]}`;

// ---- how a message shows its links ----

// [label, text, body as shown (each line's end trimmed; null: no body), cards' classes, blue links]
const SHAPES = [
  ['known answer: only a picture', '#media/shapes/a.png', null, ['ref-pic'], 0],
  ['link on its own line, then words (the gap)', `#[${shot1}]\nGot the farm placed.`, 'Got the farm placed.', ['ref-pic'], 0],
  ['words, then the link on its own line', 'Her name is Sue.\n#media/shapes/a.png', 'Her name is Sue.', ['ref-pic'], 0],
  ['words, then the link at the end', 'Damn, so close... #[media/shapes/a.png]', 'Damn, so close...', ['ref-pic'], 0],
  ['a picture inside a sentence stays a link', 'look at #media/shapes/a.png it is big', 'look at a.png it is big', ['ref-pic'], 1],
  ['a Files file alone', '#docs/guide.md', null, ['file-card'], 0],
  ['a Files file inside a sentence', 'see #docs/guide.md for it', 'see docs/guide.md for it', ['file-card'], 1],
  ['a folder alone', '#notes', null, ['folder-card'], 0],
  ['a schematic post', '#[schematics/Build 1]', null, ['ref-card'], 0],
  ['words, then two links on a line', 'Stripped log farm\n#media/shapes/a.png #docs/guide.md', 'Stripped log farm', ['ref-pic', 'file-card'], 0],
  ['a link at the start of a sentence', '#docs/guide.md is the plan', 'docs/guide.md is the plan', ['file-card'], 1],
  ['in code: left alone', 'try `#docs/guide.md`', 'try #docs/guide.md', [], 0],
  ['in a quote', '> #docs/guide.md', 'docs/guide.md', ['file-card'], 1],
  ['in a list item', 'farms:\n- #docs/guide.md', 'farms:\ndocs/guide.md', ['file-card'], 1],
  ['a link to nothing is text', '#docs/nope.md', '#docs/nope.md', [], 0],
  ['not a path', '#1 is first', '#1 is first', [], 0],
  ['past ten cards a link keeps its text', [...SEED.shots.map((s) => `#[screenshots/${s}]`), ...SEED.mapart.map((s) => `#[map art/${s}]`), '#docs/guide.md'].join('\n'),
    `map art/${SEED.mapart[4]}\ndocs/guide.md`, [...Array(10).fill('ref-pic')], 2],
  ['a release card has no second card', '## MT Utils 2.5.2\n-# Client · Required\n#[docs/guide.md]\n- fixes', 'REL', [], 0],
];
const shapes = [];
for (const [label, text] of SHAPES) shapes.push({ label, text, id: (await say('shapes', text)).id });
await send('Page.navigate', { url: HUB });
await settle(500);
await ev(`localStorage.setItem('mt-chat-hidden','1')`);
await send('Page.navigate', { url: `${HUB}/?r=1#chan=shapes` });
await settle(2500);
const drawn = (id) => ev(`(() => {
  const m = ${msgEl(id)};
  if (!m) return 'not drawn';
  const b = m.querySelector('.msg-body');
  const body = !b ? null : m.querySelector('.rel-card') ? 'REL' : b.innerText.replace(/[ \\t]+$/gm, '').replace(/\\s*\\(edited\\)$/, '');
  return [body, [...m.querySelectorAll('.refs > *')].map((e) => e.className), b ? b.querySelectorAll('a.file-link').length : 0];
})()`);
check('every shape drawn', await ev(`${JSON.stringify(shapes.map((s) => s.id))}.filter((id) => document.querySelector('${M} .msg[data-id="' + id + '"]')).length`), shapes.length);
for (const [i, [label, , body, cards, blue]] of SHAPES.entries()) check(label, await drawn(shapes[i].id), [body, cards, blue]);
await shot('shapes');

// The edit box: stand-alone links are its cards, in-sentence ones stay in the words; saving
// unchanged leaves the message exactly as it was.
const editOf = async (i) => {
  await ev(`${msgEl(shapes[i].id)}.querySelector('.msg-tools [data-tool="edit"]').click()`);
  await settle(400);
  const got = await ev(`[${msgEl(shapes[i].id)}.querySelector('.msg-edit textarea').value, [...${msgEl(shapes[i].id)}.querySelectorAll('.msg-edit .pend-name')].map((n) => n.textContent)]`);
  await ev(`${msgEl(shapes[i].id)}.querySelector('.msg-edit textarea').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await settle(800);
  const stored = (await msgs('shapes')).find((m) => m.id === shapes[i].id);
  return [...got, stored.text === SHAPES[i][1], !!stored.edited];
};
check('edit: link-then-words', await editOf(1), ['Got the farm placed.', [SEED.shots[0]], true, false]);
check('edit: a Files file in a sentence stays in the words', await editOf(6), ['see #docs/guide.md for it', [], true, false]);
check('edit: a folder alone is a card', await editOf(7), ['', ['notes'], true, false]);

// ---- drops ----

// A drop carries a DataTransfer from its dragstart (the page fills it) to the drop.
await ev(`localStorage.setItem('mt-expanded', '["screenshots","docs"]')`);
await send('Page.navigate', { url: `${HUB}/?r=2#chan=general` });
await settle(2000);
const tray = () => ev(`[...document.querySelectorAll('${M} .composer .pend')].map((c) => [c.querySelector('.pend-name').textContent, c.className.replace('pend ', '')])`);
const compose = () => ev(`document.querySelector('${M} .compose').value`);
const clearTray = async () => {
  while (await ev(`!!document.querySelector('${M} .composer .pend [title="Remove file"]')`)) await ev(`document.querySelector('${M} .composer .pend [title="Remove file"]').click()`);
};
// drag starts on src and is dropped on dst; it returns whether dragover and drop were taken
// (prevented). before runs between the two (another chat opened, say).
const drag = (src, dst, before = '') => ev(`(async () => {
  const dt = new DataTransfer();
  document.querySelector(${JSON.stringify(src)}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  ${before}
  const to = document.querySelector(${JSON.stringify(dst)});
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  to.dispatchEvent(over);
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  to.dispatchEvent(drop);
  return [over.defaultPrevented, drop.defaultPrevented];
})()`);
// fileDrop drops a file from the computer on dst.
const fileDrop = (dst, name = 'drop.txt') => ev(`(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], ${JSON.stringify(name)}, { type: 'text/plain' }));
  const to = document.querySelector(${JSON.stringify(dst)});
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  to.dispatchEvent(over);
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  to.dispatchEvent(drop);
  return [over.defaultPrevented, drop.defaultPrevented];
})()`);
const enter = async (sel) => {
  await ev(`${sel}.focus()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await settle(1200);
};
const BOX = `document.querySelector('${M} .compose')`;

// Known answer: a file from the computer is a card (as before).
await fileDrop(`${M} .chat-body`, 'known.txt');
await settle(300);
check('known answer: a computer file is a card', await tray(), [['known.txt', 'ready']]);
await clearTray();

// From the tree: a card, not text; the same file twice is one card; a folder is a card too.
check('tree file: drop taken', await drag(`#tree .row[data-path="${shot1}"]`, `${M} .chat-body .messages`), [true, true]);
await drag(`#tree .row[data-path="${shot1}"]`, `${M} .chat-body .messages`);
await drag('#tree .row[data-path="docs"]', `${M} .chat-body .messages`);
await settle(300);
check('tree: cards, no text, one per file', [await tray(), await compose()], [[[SEED.shots[0], 'done'], ['docs', 'done']], '']);
await enter(BOX);
const sent = (await msgs('general')).pop();
check('stored as plain links', sent.text, `#[${shot1}] #docs`);
check('drawn as a picture and a folder card', await drawn(sent.id), [null, ['ref-pic', 'folder-card'], 0]);

// Out of a message: the picture and the file link carry the hub's path, not a URL. In the
// same chat only the message box takes them (a picture dragged by accident and let go over
// the messages, or anywhere else, goes nowhere); another chat takes them anywhere.
const posted = await say('general', 'here #docs/guide.md is the plan\n#media/shapes/a.png');
await settle(800);
const pic = `${M} .msg[data-id="${posted.id}"] .ref-pic`;
// (The page still keeps the drop from the browser, so a dragged link never opens in the tab.)
check('same chat, over the messages: taken nowhere', [await drag(pic, `${M} .chat-body .messages`), await tray(), await ev(`document.querySelector('${M}-body').classList.contains('drop')`)], [[true, true], [], false]);
await drag(pic, '#channels');
await settle(300);
check('same chat, let go on the chat list: nowhere', await tray(), []);
check('a picture in a message drags as a card onto the box', await drag(pic, `${M} .compose`), [true, true]);
await drag(`${M} .msg[data-id="${posted.id}"] .msg-body a.file-link`, `${M} .composer`);
await settle(300);
check('picture and file link: cards, no URL text', [await tray(), await compose()], [[['a.png', 'done'], ['guide.md', 'done']], '']);
await clearTray();
check('another chat takes it anywhere', await drag(pic, `${M} .chat-body .messages`, `location.hash = '#chan=shapes'; await new Promise((r) => setTimeout(r, 1200));`), [true, true]);
await settle(300);
check('(the card is in that chat)', await tray(), [['a.png', 'done']]);
await clearTray();
await ev(`location.hash = '#chan=general'`);
await settle(1200);

// A private chat's file into another chat: a copy, uploaded on send.
await send('Page.navigate', { url: `${HUB}/?r=3#chan=staff` });
await settle(1500);
const secret = await say('staff', '#media/staff/secret.png');
await settle(800);
await drag(`${M} .msg[data-id="${secret.id}"] .ref-pic`, `${M} .chat-body .messages`, `location.hash = '#chan=general'; await new Promise((r) => setTimeout(r, 1200));`);
await settle(1500);
check('from a private chat: a copy waiting to upload', await tray(), [['secret.png', 'ready']]);
await enter(BOX);
check('the copy is the chat’s own', (await msgs('general')).pop().text, '#media/general/secret.png');

// Into a message being edited: its own box, not the new message's.
const mine = await say('general', 'first words');
await settle(800);
await ev(`${msgEl(mine.id)}.querySelector('.msg-tools [data-tool="edit"]').click()`);
await settle(400);
check('edit box takes a tree drop', await drag(`#tree .row[data-path="docs/guide.md"]`, `${M} .msg[data-id="${mine.id}"] .msg-edit textarea`), [true, true]);
await fileDrop(`${M} .msg[data-id="${mine.id}"] .msg-edit`, 'added.txt');
await settle(300);
check('cards in the edit box, none in the tray', [await ev(`[...${msgEl(mine.id)}.querySelectorAll('.msg-edit .pend-name')].map((n) => n.textContent)`), await tray()],
  [['guide.md', 'added.txt'], []]);
await enter(`${msgEl(mine.id)}.querySelector('.msg-edit textarea')`);
check('saved with both', (await msgs('general')).find((m) => m.id === mine.id).text, 'first words #docs/guide.md #media/general/added.txt');

// Anywhere else on the page: the open chat takes it, and the page never opens the file.
check('a file on the chat list: taken', await fileDrop('#channels', 'stray.txt'), [true, true]);
check('a file on the top bar: taken', await fileDrop('#top', 'top.txt'), [true, true]);
await settle(300);
check('both in the open chat’s tray', await tray(), [['stray.txt', 'ready'], ['top.txt', 'ready']]);
await clearTray();
check('a tree file on the chat list: a card', [await drag(`#tree .row[data-path="docs/guide.md"]`, '#channels'), await tray()], [[true, true], [['guide.md', 'done']]]);
await clearTray();
check('text dropped on the chat list is left alone', await ev(`(() => {
  const dt = new DataTransfer(); dt.setData('text/plain', 'hello');
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  document.querySelector('#channels').dispatchEvent(over);
  return over.defaultPrevented;
})()`), false);
await shot('drops');

await done();
