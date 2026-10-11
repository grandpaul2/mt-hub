// The hub going away and coming back, as the live site sees it: behind Caddy, which answers
// 502 while the hub restarts (a browser's live-update stream gives up for good on a 502, so
// the page has to start it again). The connection line shows while the hub can't be reached,
// a send says why it failed, and everything is live again once it's back.
import { createServer, request } from 'node:http';
import { api, check, done, ev, HUB, key, send, settle, sleep, typeText, until } from './lib.mjs';

// A stand-in for Caddy in front of the hub: down, it answers 502 with an empty body and
// drops the open live-update streams.
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

await send('Page.navigate', { url: `${SITE}/#chan=general` });
await settle(2500);
const line = () => ev(`!document.getElementById('offline').hidden`);
// The newest message the hub has (one of yours still waiting to be sent sits after it).
const lastText = () => ev(`[...document.querySelectorAll('.msg:not(.unsent) .msg-body')].at(-1)?.textContent`);
check('no connection line while the hub is there', await line(), false);
await api('POST', '/api/channels/general/messages', { text: 'live before' });
await settle(1500);
check('live updates work to begin with', await lastText(), 'live before');

// The hub restarts.
down = true;
for (const s of streams) s.destroy();
await sleep(1000); // the line waits 2 s
check('no line for a blip', await line(), false);
await until('the connection line', line).catch(() => {});
check('the line is up while the hub is away', await line(), true);
await ev(`document.querySelector('#chat-body .compose, #main-chat-body .compose').focus()`);
await typeText('sent while away');
await key('Enter');
await settle(500);
check('the message stays in the feed and says why it failed', await ev(`(() => { const m = document.querySelector('.msg.unsent.failed'); return [m?.querySelector('.msg-body').textContent, m?.querySelector('.send-failed').textContent]; })()`),
  ['sent while away', 'Couldn’t send it: can’t reach the hub. Retry · Delete']);
check('the box is empty', await ev(`document.querySelector('#chat-body .compose, #main-chat-body .compose').value`), '');

// Back again: the line goes, and the page is live again without a reload.
down = false;
await until('the connection line to go', async () => !(await line())).catch(() => {});
await settle(1000);
check('the line goes when the hub is back', await line(), false);
await api('POST', '/api/channels/general/messages', { text: 'live after the restart' });
await settle(1500);
check('live updates came back', await lastText(), 'live after the restart');
// Retry sends the message that failed while the hub was away.
await ev(`[...document.querySelectorAll('.msg.unsent.failed .send-failed .key')].find((b) => b.textContent === 'Retry').click()`);
await settle(1200);
check('Retry sends it', await ev(`[document.querySelectorAll('.msg.unsent').length, [...document.querySelectorAll('.msg .msg-body')].filter((b) => b.textContent === 'sent while away').length > 0]`), [0, true]);

proxy.close();
await done();
