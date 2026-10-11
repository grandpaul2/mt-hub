// A sent message shows at once (Discord): greyed in the feed until the hub confirms it, then
// replaced by the real one, never shown twice. One that fails stays, in red, with Retry and
// Delete under it, and the box stays empty.
import { check, done, ev, HUB, hub, send, settle, shot, sleep } from './lib.mjs';

const texts = async () => (await (await hub('/api/channels/general/messages')).json()).map((m) => m.text);
await send('Page.navigate', { url: HUB });
await settle(500);
await ev(`localStorage.setItem('mt-chat-hidden','1')`);
await send('Page.navigate', { url: `${HUB}/?r=1#chan=general` });
await settle(2000);
const M = '#main-chat';
const box = `document.querySelector('${M} .compose')`;
// Enter without waiting for the page to go quiet: what shows straight away is the point.
const say = async (text) => {
  await ev(`(() => { const b = ${box}; b.focus(); b.value = ${JSON.stringify(text)}; })()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(300);
};
const rows = (text) => ev(`[...document.querySelectorAll('${M} .msg')].filter((m) => m.querySelector('.msg-body')?.textContent === ${JSON.stringify(text)})
  .map((m) => [m.classList.contains('unsent'), m.classList.contains('failed'), !!m.querySelector('.msg-tools'), getComputedStyle(m.querySelector('.msg-body')).opacity])`);
// Slow the page's own posts down: 'before' holds a message back from the hub, 'after' holds
// the hub's answer back (so the live event gets there first).
await ev(`(() => { const real = window.fetch; window.__slow = '';
  window.fetch = async (url, o = {}) => {
    const mine = o.method === 'POST' && /\\/messages$/.test(String(url));
    if (mine && window.__slow === 'before') await new Promise((r) => setTimeout(r, 1500));
    const res = await real(url, o);
    if (mine && window.__slow === 'after') await new Promise((r) => setTimeout(r, 1500));
    return res;
  }; })()`);

// On its way: in the feed at once, greyed, with no toolbar; the box is empty; not on the hub yet.
await ev(`window.__slow = 'before'`);
await say('on its way');
check('shows at once, greyed', [await rows('on its way'), await ev(`${box}.value`), (await texts()).includes('on its way')], [[[true, false, false, '0.5']], '', false]);
await shot('sending');
await sleep(2200);
check('then it is the real message, once', [await rows('on its way'), (await texts()).filter((t) => t === 'on its way').length], [[[false, false, true, '1']], 1]);

// The live event arrives before the hub's answer: still shown once, at every moment.
await ev(`window.__slow = 'after'`);
await say('event first');
await sleep(400);
const early = await rows('event first');
await sleep(2000);
check('never shown twice', [early, await rows('event first')], [[[false, false, true, '1']], [[false, false, true, '1']]]);
await ev(`window.__slow = ''`);

// A second message while the first is still on its way keeps its place after it.
await ev(`window.__slow = 'before'`);
await say('first of two');
await say('second of two');
check('two on their way, in order', await ev(`[...document.querySelectorAll('${M} .msg.unsent .msg-body')].map((b) => b.textContent)`), ['first of two', 'second of two']);
await sleep(2500);
check('both arrive, in order', (await texts()).slice(-2), ['first of two', 'second of two']);
await ev(`window.__slow = ''`);

// The hub can't be reached: the message stays, red, with Retry and Delete; the box is empty.
await send('Network.setBlockedURLs', { urls: ['*/api/channels/general/messages'] });
await say('will fail');
await sleep(800);
check('failed: red, says why, offers Retry and Delete', [await rows('will fail'), await ev(`document.querySelector('${M} .msg.unsent.failed .send-failed')?.textContent`), await ev(`${box}.value`),
  await ev(`getComputedStyle(document.querySelector('${M} .msg.unsent.failed .msg-body')).color`)],
  [[[true, true, false, '1']], 'Couldn’t send it: can’t reach the hub. Retry · Delete', '', 'rgb(244, 112, 103)']);
await shot('failed');
await say('also fails');
await sleep(800);
await ev(`[...document.querySelectorAll('${M} .msg.unsent.failed')].at(-1).querySelector('.send-failed .key:last-child').click()`);
check('Delete drops it', [(await rows('also fails')).length, (await rows('will fail')).length], [0, 1]);
await send('Network.setBlockedURLs', { urls: [] });
await ev(`document.querySelector('${M} .msg.unsent.failed .send-failed .key').click()`);
await settle(1500);
check('Retry sends it', [await rows('will fail'), (await texts()).filter((t) => t === 'will fail' || t === 'also fails')], [[[false, false, true, '1']], ['will fail']]);

await done();
