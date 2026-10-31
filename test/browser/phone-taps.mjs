// Phones: a tap on a message shows its hover-only buttons (the toolbar, + reaction), and the
// same tap's click must not press whichever of them appeared under the finger. A second tap,
// on the buttons now showing, works. A real mouse click on desktop still works.
import { api, check, done, ev, HUB, send, settle } from './lib.mjs';

const { id } = await (await api('POST', '/api/channels/general/messages', { text: 'tap me' }, 'Pat')).json();
await api('PUT', `/api/channels/general/messages/${id}/reactions/${encodeURIComponent('👍')}`, undefined, 'Alex');
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
await send('Page.navigate', { url: `${HUB}/#chan=general` });
await settle(2500);

const msg = `[...document.querySelectorAll('#chat .msg')].at(-1)`;
// The middle of a hover-only button, measured with it shown for a moment.
const spot = (sel) => ev(`(() => { const b = ${msg}.querySelector('${sel}'), hide = ${msg}.querySelector('.msg-tools');
  ${msg}.classList.add('__show'); const r = b.getBoundingClientRect(); ${msg}.classList.remove('__show');
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
// A phone shows them (sticky :hover) the moment a finger lands; headless Chromium doesn't, so
// a touch's pointerdown does it here, before the tap's click.
const reveal = () => ev(`(() => { const s = document.createElement('style'); s.textContent = '.msg.__show .msg-tools { display: flex } .msg.__show .reaction.add { display: inline-flex }'; document.head.append(s);
  document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') ${msg}.classList.add('__show'); }, { capture: true }); })()`);
await reveal();
const tap = async (p) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await settle(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle(400);
};
const replying = () => ev(`!document.querySelector('#chat .reply-bar').hidden`);
const picker = () => ev(`!!document.querySelector('.emoji-picker:not([hidden]), #emoji-picker:not([hidden])')`);

const reply = await spot('[data-tool=reply]');
await tap(reply);
check('one tap where Reply would be: no reply', await replying(), false);
await tap(reply);
check('a second tap, on the toolbar now showing: reply', await replying(), true);
await ev(`document.querySelector('#chat .reply-bar button').click()`);

// A fresh page, so the message isn't already selected by the taps above.
await send('Page.navigate', { url: `${HUB}/?r=2#chan=general` });
await settle(2500);
await reveal();
const add = await spot('.reaction.add');
await tap(add);
check('one tap where + reaction would be: no picker', await picker(), false);
await tap(add);
check('a second tap: the picker', await picker(), true);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

// Desktop: the mouse hovers (the toolbar shows), then clicks Reply.
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.clearDeviceMetricsOverride');
await send('Page.navigate', { url: `${HUB}/#chan=general` });
await settle(2500);
const m = await ev(`(() => { const r = [...document.querySelectorAll('#main-chat .msg')].at(-1).getBoundingClientRect(); return { x: r.x + 100, y: r.y + r.height / 2 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y });
await settle(200);
const r = await ev(`(() => { const r = [...document.querySelectorAll('#main-chat .msg')].at(-1).querySelector('[data-tool=reply]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
await settle(300);
check('desktop: a mouse click on Reply works', await ev(`!document.querySelector('#main-chat .reply-bar').hidden`), true);
await done();
