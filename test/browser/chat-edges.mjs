// Chat at the edges (the bug sweep's finds): after the hub restarts, the older history you'd
// loaded and your place stay; a pasted picture with "]" in its name links properly; quotes
// go one level deep; drafts of chats that are gone are cleaned up.
import { createServer, request } from 'node:http';
import { api, check, done, ev, HUB, send, settle } from './lib.mjs';

// The stand-in for Caddy from connection.mjs: down, it answers 502 and drops the streams.
let down = false;
const streams = new Set();
const hubURL = new URL(HUB);
const proxy = createServer((req, res) => {
  if (down) return res.writeHead(502).end();
  const up = request({ host: hubURL.hostname, port: hubURL.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => res.writeHead(502).end());
  req.pipe(up);
  if (req.url.startsWith('/api/events')) {
    streams.add(res);
    res.on('close', () => streams.delete(res));
  }
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${proxy.address().port}`;

for (let i = 1; i <= 160; i++) await api('POST', '/api/channels/general/messages', { text: `message ${i}` });
await send('Page.navigate', { url: `${SITE}/#chan=general` });
await settle(2500);
const list = `document.querySelector('#main-chat-body .messages')`;
const count = () => ev(`document.querySelectorAll('#main-chat-body .msg').length`);
const firstShown = () => ev(`(() => { const top = ${list}.getBoundingClientRect().top;
  return [...document.querySelectorAll('#main-chat-body .msg')].find((m) => m.getBoundingClientRect().bottom > top)?.querySelector('.msg-body')?.textContent; })()`);
// Scroll to the top: the older messages load.
for (let i = 0; i < 4; i++) {
  await ev(`(() => { const l = ${list}; l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); })()`);
  await settle(700);
}
check('older history loaded', await count(), 160);
await ev(`(() => { const l = ${list}; l.scrollTop = 200; l.dispatchEvent(new Event('scroll')); })()`);
await settle(300);
const place = await firstShown();

// The hub restarts; the page reconnects.
down = true;
for (const s of streams) s.destroy();
await settle(1500);
down = false;
await api('POST', '/api/channels/general/messages', { text: 'while away' });
await settle(6000);
check('after a restart: history and place kept, and caught up', [await count(), await firstShown()], [161, place]);

// A pasted picture named with "]" is renamed, so its link can be written.
await ev(`(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'a]b.png', { type: 'image/png' }));
  const box = document.querySelector('#main-chat-body .compose');
  box.focus();
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`);
await settle(1500);
check('the file is named a_b.png', await ev(`document.querySelector('#main-chat-body .composer .pend-name')?.textContent`), 'a_b.png');
await ev(`document.querySelector('#main-chat-body .composer .pend [title="Remove file"]').click()`);

// Quotes: one level; ">" inside one is just text.
await api('POST', '/api/channels/general/messages', { text: '> > > deep' });
await settle(1000);
check('one level of quote', await ev(`(() => { const m = [...document.querySelectorAll('#main-chat-body .msg')].at(-1);
  return [m.querySelectorAll('blockquote').length, m.querySelector('blockquote')?.textContent]; })()`), [1, '> > deep']);

// Drafts of chats that are gone are cleaned up; a live chat's stays.
await ev(`localStorage.setItem('mt-drafts', JSON.stringify({ 'gone-chat': 'old words', general: 'keep me' }))`);
await send('Page.reload');
await settle(2500);
check('drafts of gone chats cleaned up', await ev(`JSON.parse(localStorage.getItem('mt-drafts'))`), { general: 'keep me' });

proxy.close();
await done();
