// The server link: #server-link is shared with game chat. Lines a game server posts show
// with its tag (SMP, CMP) by the name; the chat says what it is at the top; and what's typed
// here reaches the servers' feed as one plain line.
import { execFileSync } from 'node:child_process';
import { api, check, DATA, done, ev, HUB, key, send, settle, shot, typeText } from './lib.mjs';

const token = (server) => execFileSync(process.env.MTHUB_BIN, ['token', '-data', DATA, 'add', '-server', server]).toString().match(/mt_\S+/)[0];
const asServer = (tok, method, query = '', body) => fetch(`${HUB}/api/server-link${query}`, { method, headers: { authorization: 'Bearer ' + tok }, body: body && JSON.stringify(body) });
const survival = token('survival'), creative = token('creative');

await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(2500);
const chats = () => ev(`[...document.querySelectorAll('#channels .row')].map((r) => r.textContent.replace(/\\s/g, ''))`);
check('no link chat before a server connects', (await chats()).includes('#server-link'), false);

// A server connects: the chat appears in the open page by itself.
const start = await (await asServer(survival, 'GET')).json();
await settle(600);
check('the chat appears when the first server connects', [(await chats()).includes('#server-link'), start.you], [true, 'SMP']);

check('lines from the game are accepted', [(await asServer(survival, 'POST', '', { player: 'Steve', text: 'anyone on creative?' })).status,
  (await asServer(survival, 'POST', '', { player: 'Steve', text: 'hello?' })).status,
  (await asServer(creative, 'POST', '', { player: 'Steve', text: 'yep, over here' })).status,
  (await asServer(creative, 'POST', '', { player: 'gypsy_jay', text: 'hi' })).status], [200, 200, 200, 200]);
await api('POST', '/api/channels/server-link/messages', { text: 'on in ten' }, 'Steve');

await send('Page.navigate', { url: HUB + '/#chan=server-link' });
await settle(1200);
const rows = () => ev(`[...document.querySelectorAll('#main-chat .messages-items > .msg')].map((m) => [m.querySelector('.who')?.textContent ?? '', m.querySelector('.tag.via')?.textContent ?? '', m.querySelector('.msg-body').textContent])`);
// Steve on Survival, Steve on Creative and Steve on the hub are three headers: the tag is
// part of who said it. Two lines in a row from the same place group as usual.
check('names, tags and grouping', await rows(), [['Steve', 'SMP', 'anyone on creative?'], ['', '', 'hello?'], ['Steve', 'CMP', 'yep, over here'], ['gypsy_jay', 'CMP', 'hi'], ['Steve', '', 'on in ten']]);
check('the tag says which server', await ev(`document.querySelector('#main-chat .tag.via').title`), 'Said in game on Survival');
check('the chat says what it is', await ev(`(() => { const n = document.querySelector('#main-chat .chat-privacy'); return [n.hidden, n.textContent]; })()`),
  [false, 'Linked to game chat: messages here show in game on both servers. In game, start a line with $ and a space to say it here.']);
await shot('chat');

// Typed here: it reaches each server once, as a plain line marked HUB; a server's own lines don't come back.
await ev(`document.querySelector('#main-chat .compose').focus()`);
await typeText('**storage** hall');
await key('Enter');
await settle(500);
const feed = async (tok) => (await (await asServer(tok, 'GET', '?after=' + start.last)).json()).messages.map((m) => `[${m.tag}] ${m.user}: ${m.text}`);
check('survival reads', await feed(survival), ['[CMP] Steve: yep, over here', '[CMP] gypsy_jay: hi', '[HUB] Steve: on in ten', '[HUB] Paul: storage hall']);
check('creative reads', await feed(creative), ['[SMP] Steve: anyone on creative?', '[SMP] Steve: hello?', '[HUB] Steve: on in ten', '[HUB] Paul: storage hall']);

// Other chats are untouched: no note, no tags.
await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(800);
check('no note on an ordinary chat', await ev(`document.querySelector('#main-chat .chat-privacy').hidden`), true);

await done();
