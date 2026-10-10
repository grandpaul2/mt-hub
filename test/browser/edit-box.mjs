// Editing a long message: the box stays where it is while you type. (Fitting the box to its
// text takes it down to one line for a moment; at the bottom of the feed that scrolled the
// feed up, and the box ended up mostly below the view.)
import { api, check, done, ev, HUB, key, send, settle, typeText } from './lib.mjs';

for (let i = 0; i < 30; i++) await api('POST', '/api/channels/general/messages', { text: `filler ${i}` }, 'Alex');
const long = Array.from({ length: 60 }, (_, i) => `line ${i} of a long message that someone is going to edit`).join('\n');
await api('POST', '/api/channels/general/messages', { text: long }, 'Paul');
await send('Page.navigate', { url: `${HUB}/#README.md` });
await settle(2000);
const L = `document.querySelector('#chat .messages')`;
const B = `document.querySelector('#chat .msg textarea')`;
// where: the box's top in the feed's view, how far its bottom is below the view's (negative:
// inside), and how far the feed is from its bottom.
const where = () => ev(`(() => { const l = ${L}, b = ${B}, lr = l.getBoundingClientRect(), br = b.getBoundingClientRect();
  return [Math.round(br.top - lr.top), Math.round(br.bottom - lr.bottom) <= 0, Math.round(l.scrollHeight - l.scrollTop - l.clientHeight)]; })()`);

// ↑ in the empty box edits your last message, caret at its end.
await ev(`document.querySelector('#chat .compose').focus()`);
await key('ArrowUp');
await settle(500);
const start = await where();
check('the edit box opens inside the view, the feed at its bottom', start.slice(1), [true, 0]);
await typeText('x');
await settle(300);
check('typing at the end leaves it there', await where(), start);
await ev(`(() => { const b = ${B}; b.setSelectionRange(200, 200); b.scrollTop = 0; })()`);
for (const c of 'more words') await typeText(c);
await settle(300);
check('typing near the start too', await where(), start);

await done();
