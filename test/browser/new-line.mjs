// The NEW line above the first unread message, and "Jump to present" (backlog item 5; style
// guide 3.3 and 14).
import { api, check, done, ev, HUB, key, send, settle, shot, typeText } from './lib.mjs';

await api('POST', '/api/channels', { name: 'builds' }, 'Pat');
for (let i = 1; i <= 5; i++) await api('POST', '/api/channels/general/messages', { text: `old ${i}` }, 'Steve');
await send('Page.navigate', { url: HUB + '/#chan=builds' });
await settle(2500);
// The side panel on builds too, so nothing on screen reads general behind our back.
await ev(`(() => { const s = document.getElementById('chat-select'); s.value = 'builds'; s.dispatchEvent(new Event('change')); })()`);
await settle(500);

const open = async (name) => {
  await ev(`[...document.querySelectorAll('#channels .row')].find((r) => r.querySelector('.name')?.textContent === '${name}').click()`);
  await settle(900);
};
const M = '#main-chat';
const line = () => ev(`(() => { const l = document.querySelector('${M} .new-line'); if (!l) return null;
  const next = l.nextElementSibling; return { before: next?.querySelector('.msg-body')?.textContent ?? null, header: !!next?.querySelector('.msg-head') }; })()`);
const jumpShown = () => ev(`!document.querySelector('${M} .jump').hidden`);
const unread = (name) => ev(`[...document.querySelectorAll('#channels .row')].find((r) => r.querySelector('.name')?.textContent === '${name}').classList.contains('unread')`);

await open('general');
check('never opened here before: no line', await line(), null);
await open('builds');

// Steve keeps talking: 80 messages while Pat is in builds.
for (let i = 1; i <= 80; i++) await api('POST', '/api/channels/general/messages', { text: `new ${i}` }, 'Steve');
await settle(500);
await open('general');
check('NEW line above the first unread, with its own header', await line(), { before: 'new 1', header: true });
check('scrolled to the line, not the bottom', await ev(`(() => { const l = document.querySelector('${M} .new-line').getBoundingClientRect(); const v = document.querySelector('${M} .messages').getBoundingClientRect(); return l.top > v.top && l.top < v.top + 120; })()`), true);
check('Jump to present shows', await jumpShown(), true);
check('still unread until seen', await unread('general'), true);
await shot('line');

await ev(`document.querySelector('${M} .jump').click()`);
await settle(500);
check('Jump: at the bottom, pill gone, read', [await ev(`(() => { const b = document.querySelector('${M} .messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 60; })()`), await jumpShown(), await unread('general')], [true, false, false]);
check('the line stays while the chat is open', (await line())?.before, 'new 1');

// Back later: everything was read, so no line.
await open('builds');
await open('general');
check('reopened after reading: no line', await line(), null);

// Scrolled up when a message arrives: a line above it. Sending something clears it.
await ev(`document.querySelector('${M} .messages').scrollTop = 0`);
await settle(600);
check('scrolled up: Jump shows', await jumpShown(), true);
await api('POST', '/api/channels/general/messages', { text: 'while you were up there' }, 'Alex');
await settle(600);
check('a message arriving unseen gets the line', (await line())?.before, 'while you were up there');
await ev(`document.querySelector('${M} .jump').click()`);
await settle(300);
await ev(`document.querySelector('${M} .compose').focus()`);
await typeText('back');
await key('Enter');
await settle(800);
check('sending clears the line', await line(), null);

// At the bottom when one arrives: read as it comes, no line.
await api('POST', '/api/channels/general/messages', { text: 'seen live' }, 'Alex');
await settle(600);
check('seen live: no line', await line(), null);

await done();
