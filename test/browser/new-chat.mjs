// The new-chat box (names tidied as typed, inline errors) and top-centre toasts.
import { check, done, ev, HUB, key, send, settle, shot, typeText } from './lib.mjs';

await send('Page.navigate', { url: HUB });
await settle(500);
await send('Page.navigate', { url: HUB + '/?r=7' });
await settle(2000);
const chans = () => ev(`[...document.querySelectorAll('#channels .row')].map((r) => r.querySelector('.name')?.textContent ?? '[box]')`);
const boxState = () => ev(`(() => { const b = document.querySelector('#channels input.rename'); return b ? [b.value, document.activeElement === b, document.querySelector('#channels .chan-error')?.textContent ?? ''] : null; })()`);

// Paul is an admin: + offers New Chat or New Private Chat.
const newChat = async () => {
  await ev(`document.getElementById('new-channel').click()`);
  await settle(100);
  await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'New Chat').click()`);
};
await newChat();
await settle(200);
check('box at top, focused', [(await chans())[0], (await boxState())?.[1]], ['[box]', true]);
await typeText('Farm Builds!');
await settle(100);
check('tidied as typed', (await boxState())[0], 'farm-builds');
await key('Enter');
await settle(800);
check('created and opened', [await chans(), await ev(`decodeURIComponent(location.hash)`)], [['farm-builds', 'general'], '#chan=farm-builds']);

await newChat();
await settle(200);
await typeText('farm builds');
await key('Enter');
await settle(600);
check('duplicate: error under box, box kept', await boxState(), ['farm-builds', true, '#farm-builds already exists']);
await shot('chan-error');
await typeText(' 2');
await settle(100);
check('typing clears the error', await boxState(), ['farm-builds-2', true, '']);
await key('Enter');
await settle(800);
check('second one created', await chans(), ['farm-builds', 'farm-builds-2', 'general']);

await newChat();
await settle(200);
await key('Escape');
await settle(200);
check('esc closes', await boxState(), null);
await newChat();
await settle(200);
await ev(`document.querySelector('#channels input.rename').blur()`);
await settle(300);
check('empty + click away closes quietly', [await boxState(), await chans()], [null, ['farm-builds', 'farm-builds-2', 'general']]);

// Rename shares the box: errors show the same way.
await ev(`[...document.querySelectorAll('#channels .row')].find((r) => r.textContent === '#farm-builds-2').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 400 }))`);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Rename')).click()`);
await settle(200);
check('rename box selected', await ev(`(() => { const b = document.querySelector('#channels input.rename'); return [b.value, b.selectionStart, b.selectionEnd]; })()`), ['farm-builds-2', 0, 13]);
await typeText('General');
await key('Enter');
await settle(600);
check('rename onto existing: inline error', await boxState(), ['general', true, '#general already exists']);
await key('Escape');

// Toasts: top centre.
await ev(`document.getElementById('tree').focus(); document.querySelector('.row[data-path="screenshots"]').click()`);
await ev(`document.getElementById('tree').focus()`);
await key('F2');
await settle(200);
check('toast top centre', await ev(`(() => { const r = document.getElementById('toast').getBoundingClientRect(); return [Math.round(r.top), Math.abs(Math.round(r.left + r.width / 2 - innerWidth / 2)) <= 1]; })()`), [44, true]);
await shot('toast');

await done();
