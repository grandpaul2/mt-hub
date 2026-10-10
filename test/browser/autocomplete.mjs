// @mention and :emoji: autocomplete in message boxes, and the emoji picker on the message box
// (backlog items 3 and 4; style guide 6.4 and 14).
import { api, check, done, ev, HUB, key, send, settle, shot, typeText } from './lib.mjs';

await api('POST', '/api/channels/general/messages', { text: 'first' }, 'Steve');
await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(2500);

const C = `document.querySelector('#main-chat .compose')`;
const value = () => ev(`${C}.value`);
const clear = async () => {
  await ev(`(() => { const c = ${C}; c.value = ''; c.dispatchEvent(new Event('input')); c.focus(); })()`);
  await settle(100);
};
const popup = () => ev(`(() => { const p = document.querySelector('.ac-pop'); return p.hidden ? null :
  { head: p.querySelector('.ac-head').textContent, rows: [...p.querySelectorAll('.ac-row')].map((r) => r.textContent),
    on: p.querySelector('.ac-row.on')?.textContent }; })()`);
const sent = () => ev(`document.querySelectorAll('#main-chat .msg-body').length`);

// @: the people whose names match, as you type.
await clear();
const before = await sent();
await typeText('hi @');
await settle(150);
let p = await popup();
check('@ lists people', [p?.head, ['Alex', 'Paul', 'Steve'].every((n) => p.rows.includes(n))], ['Members', true]);
await typeText('al');
await settle(150);
p = await popup();
check('@al: Alex first and highlighted', [p?.rows[0], p?.on], ['Alex', 'Alex']);
check('the popup is above the text', await ev(`document.querySelector('.ac-pop').getBoundingClientRect().bottom <= ${C}.getBoundingClientRect().top + 1`), true);
await shot('mention');
await key('Enter');
check('Enter inserts the name (and sends nothing)', [await value(), await popup(), await sent()], ['hi @Alex ', null, before]);

// Tab inserts too; ↓ moves the highlight; Esc closes and leaves the text.
await clear();
await typeText('@');
await settle(150);
const first = (await popup()).on;
await key('ArrowDown');
const second = (await popup()).on;
check('↓ moves the highlight', second !== first && !!second, true);
await key('Escape');
check('Esc closes, text as typed', [await popup(), await value()], [null, '@']);
await typeText('St');
await settle(150);
await key('Tab');
check('Tab inserts', await value(), '@Steve ');
await clear();
await typeText('@ever');
await settle(150);
check('@everyone offered', (await popup())?.rows[0]?.startsWith('@everyone'), true);
await key('Enter');
check('@everyone inserted', await value(), '@everyone ');

// : plus two letters: emoji by name.
await clear();
await typeText('nice :f');
await settle(300);
check('one letter: nothing yet', await popup(), null);
await typeText('ir');
await settle(400); // the emoji list loads on first use
p = await popup();
check(':fir lists emoji', [p?.head, p?.rows[0]], ['Emoji matching :fir', ':fire:']);
await shot('emoji');
await key('Enter');
check('Enter inserts the emoji', await value(), 'nice 🔥 ');
await typeText(':thumbsup:');
await settle(200);
check('a whole :name: turns into its emoji', [await value(), await popup()], ['nice 🔥 👍', null]);
await clear();
await typeText('at 10:30 or http://x');
await settle(200);
check('not after a digit or in a link', await popup(), null);

// The picker on the message box: search, Enter inserts, and it closes.
await clear();
await typeText('dig ');
await ev(`document.querySelector('#main-chat .compose-row .smile').click()`);
await settle(500);
check('picker opens with the search focused', await ev(`document.activeElement?.classList.contains('emoji-search')`), true);
check('Recently used comes first, newest first', await ev(`[document.querySelector('.emoji-pop .emoji-head').textContent,
  [...document.querySelector('.emoji-pop .emoji-grid').children].slice(0, 3).map((b) => b.querySelector('img').alt)]`),
['Recently used', ['👍', '🔥', '❤️']]);
await shot('picker');
await typeText('pick');
await settle(200);
check('search finds by name', await ev(`document.querySelector('.emoji-foot-name').textContent`), ':pick:');
await key('Enter');
await settle(200);
check('Enter puts it in the box and closes', [await value(), await ev(`!!document.querySelector('.emoji-pop')`)], ['dig ⛏️', false]);

// The edit box has it too.
await clear();
await typeText('to edit');
await key('Enter');
await settle(800);
await ev(`${C}.focus()`);
await key('ArrowUp');
await settle(300);
await typeText(' :tada:');
await settle(200);
check('edit box converts :name:', await ev(`document.querySelector('#main-chat .msg-edit textarea').value`), 'to edit 🎉');
await typeText(' @ste');
await settle(150);
await key('Enter');
check('edit box: Enter picks, not saves', [await ev(`document.querySelector('#main-chat .msg-edit textarea')?.value`)], ['to edit 🎉 @Steve ']);

await done();
