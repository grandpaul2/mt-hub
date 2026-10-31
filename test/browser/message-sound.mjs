// The new-message sound (ding.ts): when it plays and when it doesn't, the off switch, and
// the file itself.
import { api, check, done, ev, HUB, send, settle, sleep } from './lib.mjs';

await api('POST', '/api/channels', { name: 'other' }, 'Pat');
await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // the page counts as the focused window
await send('Page.navigate', { url: `${HUB}/#chan=general` });
await settle(2500);
await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`); // a first press readies sound

const dings = () => ev(`window.__ding.slice()`);
const say = async (chat, text, who = 'Alex') => {
  await api('POST', `/api/channels/${chat}/messages`, { text }, who);
  await settle(600);
};
const gap = () => sleep(3200); // the sound plays at most once in 3 s

await say('general', 'in the chat Pat is looking at');
check('the chat you are looking at: no sound', await dings(), []);
await say('other', 'in another chat');
check('another chat: a sound', await dings(), ['other']);
await say('other', 'right after');
check('within 3 seconds: no second sound', await dings(), ['other']);
await gap();
await say('other', 'mine', 'Pat');
check('your own message: no sound', await dings(), ['other']);

// The hub isn't the window you're in: even the chat on screen gets one (after the tab's
// note of what it shows has gone stale).
await ev(`document.hasFocus = () => false`);
await sleep(2700); // until the tab's note of what it shows has gone stale
await say('general', 'while Pat is in another window');
check('not focused: a sound for the chat on screen', await dings(), ['other', 'general']);

// Another hub tab, focused and showing the chat: this one stays quiet.
await gap();
await ev(`localStorage.setItem('mt-looking', JSON.stringify({ chats: ['other'], t: Date.now() + 60000 }))`);
await say('other', 'seen in another tab');
check('another tab showing it: no sound', await dings(), ['other', 'general']);
await ev(`localStorage.removeItem('mt-looking')`);

// Sound Settings in the menu on your name: a switch, a volume and a Test button for the
// message sound and for the voice chat sounds.
await ev(`document.hasFocus = () => true`);
await ev(`document.getElementById('user').click()`);
await settle(200);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Sound Settings').click()`);
await settle(300);
const groups = `[...document.querySelectorAll('#dialog .set-group')]`;
check('the dialog', [await ev(`document.querySelector('#dialog .dialog-head h2').textContent`),
  await ev(`${groups}.map((g) => [g.querySelector('h3').textContent, g.querySelector('.set-title').textContent, g.querySelector('.switch').getAttribute('aria-checked')])`),
  await ev(`${groups}.map((g) => { const r = g.querySelectorAll('.set-row')[1]; return [r.querySelector('input').value, r.querySelector('.readout').textContent, r.querySelector('button').textContent]; })`),
  await ev(`!!document.querySelector('#dialog .actions')`)],
  ['Sound settings', [['Message sound', 'Play for new messages', 'true'], ['Voice chat sounds', 'Play for voice chat events', 'true']], [['70', '70%', 'Test'], ['70', '70%', 'Test']], false]);
const volRow = (i) => `${groups}[${i}].querySelectorAll('.set-row')[1]`;
const sw = (i) => `${groups}[${i}].querySelector('.switch')`;
check('a default tick above each slider', await ev(`[...document.querySelectorAll('#dialog .slider .tick')].map((t) => t.title)`), ['Default (70%)', 'Default (70%)']);
check('everything inside the dialog', await ev(`(() => { const d = document.getElementById('dialog').getBoundingClientRect();
  return [...document.querySelectorAll('#dialog .set-row *')].every((el) => { const b = el.getBoundingClientRect(); return b.width === 0 || (b.left >= d.left && b.right <= d.right - 20); }); })()`), true);
// Moving a slider saves it; letting go plays the sound at that level.
await ev(`(() => { const r = ${volRow(0)}.querySelector('input'); r.value = '40'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()`);
check('message volume saved, shown, played', [await ev(`localStorage.getItem('mt-ding-vol')`), await ev(`${volRow(0)}.querySelector('.readout').textContent`), (await dings()).at(-1)], ['40', '40%', 'test']);
await ev(`(() => { const r = ${volRow(1)}.querySelector('input'); r.value = '60'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()`);
check('voice volume saved, played', [await ev(`JSON.parse(localStorage.getItem('mt-voice')).sfxVol`), (await ev(`window.__sfx.slice()`)).at(-1)], [60, 'join']);
// The voice switch off: saved, its Volume row dims, and Test still plays.
await ev(`${sw(1)}.click()`);
const before = (await ev(`window.__sfx.slice()`)).length;
await ev(`${volRow(1)}.querySelector('button').click()`);
check('voice switch off: saved, dimmed; Test still plays', [await ev(`JSON.parse(localStorage.getItem('mt-voice')).sfx`), await ev(`${sw(1)}.getAttribute('aria-checked')`),
  await ev(`${volRow(1)}.classList.contains('off')`), (await ev(`window.__sfx.slice()`)).length], [false, 'false', true, before + 1]);
// The message switch off (by keyboard: a switch is a button), then closed with the X.
await ev(`${sw(0)}.focus()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
await settle(200);
check('Space flips a switch', [await ev(`${sw(0)}.getAttribute('aria-checked')`), await ev(`localStorage.getItem('mt-ding')`)], ['false', 'off']);
await ev(`document.querySelector('#dialog .dialog-x').click()`);
check('the X closes it', await ev(`document.getElementById('overlay').hidden`), true);
const n = (await dings()).length;
await gap();
await say('other', 'with the sound off');
check('message switch off: no sound', (await dings()).length, n);

// The file: served, and a browser can decode it (about 0.2 s).
check('the sound decodes', await ev(`fetch('/sounds/message.mp3').then((r) => r.arrayBuffer()).then((b) => new AudioContext().decodeAudioData(b)).then((a) => Math.round(a.duration * 10) / 10)`), 0.2);
await done();
