// Drafts: what's typed in a chat stays with that chat (switching swaps the box's text), is
// still there after a reload, and goes once it's sent.
import { api, check, done, ev, HUB, key, send, settle, typeText } from './lib.mjs';

await api('POST', '/api/channels', { name: 'builds' }, 'Pat');
await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(2500);

const box = () => ev(`document.querySelector('#main-chat .compose').value`);
const open = async (name) => {
  await ev(`[...document.querySelectorAll('#channels .row')].find((r) => r.textContent.replace(/\\s/g, '') === '#${name}').click()`);
  await settle(800);
};

await ev(`document.querySelector('#main-chat .compose').focus()`);
await typeText('half a thought for general');
await open('builds');
check('switching: the text stays behind', await box(), '');
await ev(`document.querySelector('#main-chat .compose').focus()`);
await typeText('builds draft');
await open('general');
check('back: its own draft', await box(), 'half a thought for general');

await send('Page.navigate', { url: HUB + '/?r=1#chan=builds' });
await settle(2500);
check('kept across a reload', await box(), 'builds draft');

await ev(`document.querySelector('#main-chat .compose').focus()`);
await key('Enter');
await settle(800);
await open('general');
await open('builds');
check('sent: the draft is gone', await box(), '');
check('the message went to builds', await ev(`[...document.querySelectorAll('#main-chat .msg-body')].map((b) => b.textContent).includes('builds draft')`), true);

// The box opening in the main panel is its full height (it was sized while still hidden).
await send('Page.navigate', { url: HUB + '/?r=2#chan=general' });
await settle(2500);
check('main box not squashed', await ev(`(() => { const c = document.querySelector('#main-chat .compose'); return c.offsetHeight >= c.scrollHeight && c.offsetHeight > 30; })()`), true);

await done();
