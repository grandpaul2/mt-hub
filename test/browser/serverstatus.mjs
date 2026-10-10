// /serverstatus: a command typed in the message box. It's offered as you type, posts nothing,
// and its answer (a card with each game server's players, mspt and memory) is drawn for you
// alone until dismissed.
import { execFileSync } from 'node:child_process';
import { api, check, DATA, done, ev, HUB, key, send, settle, shot, typeText } from './lib.mjs';

const token = (server) => execFileSync(process.env.MTHUB_BIN, ['token', '-data', DATA, 'add', '-server', server]).toString().match(/mt_\S+/)[0];
const report = (tok, body) => fetch(HUB + '/api/server-status', { method: 'POST', headers: { authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }).then((r) => r.status);
const survival = token('survival');
token('creative'); // never reports: offline

const GB = 2 ** 30;
check('a server reports', await report(survival, { players: ['Steve', 'Alex'], bots: 1, mspt: 12.34, mem_used: 6 * GB, mem_max: 16 * GB }), 204);
await settle(1100);
await report(survival, { players: ['Steve', 'Alex'], bots: 1, mspt: 61, mspt_max: 340, mem_used: 8 * GB, mem_max: 16 * GB });

await api('POST', '/api/channels/general/messages', { text: 'first' }, 'Steve');
await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(2500);

const C = `document.querySelector('#main-chat .compose')`;
const value = () => ev(`${C}.value`);
const clear = async () => {
  await ev(`(() => { const c = ${C}; c.value = ''; c.dispatchEvent(new Event('input')); c.focus(); })()`);
  await settle(100);
};
const popup = () => ev(`(() => { const p = document.querySelector('.ac-pop'); return !p || p.hidden ? null :
  { head: p.querySelector('.ac-head').textContent, rows: [...p.querySelectorAll('.ac-row .ac-name')].map((r) => r.textContent) }; })()`);
const sent = () => ev(`document.querySelectorAll('#main-chat .msg:not(.private) .msg-body').length`);
const cards = (pane = '#main-chat') => ev(`document.querySelectorAll('${pane} .msg.private .st-card').length`);
const text = (sel) => ev(`[...document.querySelectorAll('#main-chat .msg.private ${sel}')].map((e) => e.textContent)`);

// The popup: / at the start of the box, not in the middle of a message.
await clear();
const before = await sent();
await typeText('/s');
await settle(150);
check('/s offers the command', await popup(), { head: 'Commands', rows: ['/serverstatus'] });
await shot('popup');
await key('Tab');
check('Tab completes it', [await value(), await popup()], ['/serverstatus ', null]);
await clear();
await typeText('see a/s');
await settle(150);
check('not offered mid-message', await popup(), null);
await clear();
await typeText('/x');
await settle(150);
check('no such command: no popup', await popup(), null);

// Running it: nothing is posted, a card appears.
await clear();
await typeText('/serverstatus');
await settle(150);
check('typed in full: no popup in the way', await popup(), null);
await key('Enter');
await settle(600);
check('nothing posted, box emptied, one card', [await sent(), await value(), await cards()], [before, '', 1]);
check('servers, survival first', await text('.st-name'), ['Survival', 'Creative']);
check('who is on', await text('.st-who'), ['Alex, Steve + 1 bot']);
check('counts and offline', await text('.st-count'), ['2 online', 'Offline']);
check('mspt (the average, red at 50 or more is not reached) and memory', await text('.st-val'), ['36.7 peak 340.0', '7.0 / 16 GB']);
check('the graph has a line and the 50 mark', await ev(`(() => { const g = document.querySelector('#main-chat .st-graph'); return [g.querySelectorAll('.st-line').length, g.querySelectorAll('.st-limit').length]; })()`), [1, 1]);
check('only you', (await text('.only-you'))[0], 'Only you can see this · Dismiss');
await shot('card');
const stored = await api('GET', '/api/channels/general/messages?limit=100', undefined, 'Steve').then((r) => r.json());
check('the chat holds only the real message', stored.map((m) => m.text), ['first']);

// A message arriving later goes under the card, with its name shown; the card stays.
await api('POST', '/api/channels/general/messages', { text: 'second' }, 'Steve');
await settle(500);
check('new message under the card', await ev(`[...document.querySelectorAll('#main-chat .messages-items > .msg')].map((e) => e.classList.contains('private') ? 'card' : e.querySelector('.msg-body').textContent + (e.querySelector('.who') ? ' (named)' : ''))`),
  ['first (named)', 'card', 'second (named)']);

// A lagging server's number is red.
await report(survival, { players: [], mspt: 200, mem_used: 8 * GB, mem_max: 16 * GB });
await clear();
await typeText('/serverstatus');
await key('Enter');
await settle(600);
check('a second card; mspt over 50 is marked', [await cards(), await ev(`document.querySelectorAll('#main-chat .st-num.bad').length`)], [2, 1]);
check('nobody on', (await text('.st-who')).at(-1), 'Nobody online');

// Dismiss removes one; switching chat clears the rest; nothing ever reached the other pane.
await ev(`document.querySelector('#main-chat .only-you button').click()`);
await settle(150);
check('Dismiss removes that card', await cards(), 1);
check('the side chat never showed one', await cards('#chat'), 0);
await api('POST', '/api/channels', { name: 'other' }, 'Paul');
await send('Page.navigate', { url: HUB + '/#chan=other' });
await settle(800);
await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(800);
check('gone after leaving the chat', await cards(), 0);

// The side chat runs it too, at full width.
const S = `document.querySelector('#chat .compose')`;
await ev(`${S}.focus()`);
await typeText('/serverstatus');
await key('Enter');
await settle(600);
check('a card in the side chat', await cards('#chat'), 1);
check('it fits the side chat', await ev(`(() => { const c = document.querySelector('#chat .st-card'), l = document.querySelector('#chat .messages'); return c.getBoundingClientRect().right <= l.getBoundingClientRect().right && l.scrollWidth <= l.clientWidth; })()`), true);
await shot('side');

await done();
