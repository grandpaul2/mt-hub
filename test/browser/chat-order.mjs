// The chat list's order: admins drag chats (or use Move Up / Move Down), and the order is
// everyone's, live; DMs sit at the bottom, the most recent message first.
import { api, as, check, done, ev, HUB, key, send, settle } from './lib.mjs';

for (const n of ['builds', 'music']) await api('POST', '/api/channels', { name: n }, 'Paul');
const dmAlex = (await (await api('POST', '/api/dms', { members: ['Alex'] }, 'Paul')).json()).name;
const dmSteve = (await (await api('POST', '/api/dms', { members: ['Steve'] }, 'Paul')).json()).name;
await api('POST', `/api/channels/${dmAlex}/messages`, { text: 'first' }, 'Alex');
await api('POST', `/api/channels/${dmSteve}/messages`, { text: 'second' }, 'Steve');

await send('Page.navigate', { url: `${HUB}/#chan=general` });
await settle(2500);
const list = () => ev(`[...document.querySelectorAll('#channels .row')].map((r) => r.querySelector('.hash').textContent + r.querySelector('.name').textContent)`);
check('chats by name, then DMs newest first', await list(), ['#builds', '#general', '#music', '@Steve', '@Alex']);

// Drag music above builds.
const drag = (from, to, below) => ev(`(() => {
  const row = (n) => [...document.querySelectorAll('#channels .row')].find((r) => r.querySelector('.name').textContent === n);
  const a = row('${from}'), b = row('${to}'), r = b.getBoundingClientRect();
  const dt = new DataTransfer();
  const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 20, clientY: r.y + (${below} ? r.height - 3 : 3) };
  a.dispatchEvent(new DragEvent('dragstart', at));
  b.dispatchEvent(new DragEvent('dragover', at));
  const line = b.classList.contains('drop-below') ? 'below' : b.classList.contains('drop-above') ? 'above' : 'none';
  b.dispatchEvent(new DragEvent('drop', at));
  a.dispatchEvent(new DragEvent('dragend', at));
  return line;
})()`);
check('a line shows where it lands', await drag('music', 'builds', false), 'above');
await settle(500);
check('dropped above builds', await list(), ['#music', '#builds', '#general', '@Steve', '@Alex']);
check('saved for everyone', (await (await api('GET', '/api/channels', undefined, 'Steve')).json()).filter((c) => !c.kind).map((c) => c.name), ['music', 'builds', 'general']);
await drag('music', 'general', true);
await settle(500);
check('dropped below general', await list(), ['#builds', '#general', '#music', '@Steve', '@Alex']);
check('DMs can’t be dragged', await ev(`[...document.querySelectorAll('#channels .row')].map((r) => r.draggable)`), [true, true, true, false, false]);

// Move Up from the menu.
await ev(`[...document.querySelectorAll('#channels .row')].find((r) => r.querySelector('.name').textContent === 'general').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }))`);
await settle(150);
check('menu has Move Up and Move Down', await ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent).filter((t) => t.startsWith('Move'))`), ['Move Up', 'Move Down']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Move Up').click()`);
await settle(500);
check('moved up', await list(), ['#general', '#builds', '#music', '@Steve', '@Alex']);

// A new message puts its DM first among the DMs.
await api('POST', `/api/channels/${dmAlex}/messages`, { text: 'back again' }, 'Alex');
await settle(800);
check('newest DM first', await list(), ['#general', '#builds', '#music', '@Alex', '@Steve']);

// Alex: the same order, live; no dragging for members.
await as('Alex');
await send('Page.navigate', { url: `${HUB}/?r=1#chan=general` });
await settle(2500);
check('a member sees the same order', await list(), ['#general', '#builds', '#music', '@Paul']);
check('members can’t drag', await ev(`[...document.querySelectorAll('#channels .row')].some((r) => r.draggable)`), false);
check('members can’t reorder', (await api('PUT', '/api/channel-order', { names: ['music'] }, 'Alex')).status, 403);
await api('PUT', '/api/channel-order', { names: ['music', 'general', 'builds'] }, 'Paul');
await settle(800);
check('an admin’s change arrives live', await list(), ['#music', '#general', '#builds', '@Paul']);

await done();
