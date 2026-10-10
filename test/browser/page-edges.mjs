// The page at the edges (the bug sweep's finds): a dialog takes the keys and gives them back,
// and nothing behind it answers them; the main panel keeps its room in a narrow window (the
// chat panel folds to its strip) and when the window shrinks; the search dropdown closes when
// the keys move on.
import { check, done, ev, HUB, key, send, settle, typeText } from './lib.mjs';

const size = (width) => send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
await size(1200);
await send('Page.navigate', { url: `${HUB}/#docs/guide.md` });
await settle(2500);
const focus = () => ev(`(() => { const a = document.activeElement; return a.closest('#dialog') ? 'dialog' : a.id || a.tagName; })()`);

// A dialog takes the keys, keeps Tab inside, ignores / behind it, and gives the keys back.
await ev(`document.getElementById('user').focus()`);
await ev(`document.getElementById('user').click()`);
await settle(200);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Sound Settings')).click()`);
await settle(400);
check('the dialog has the keys', await focus(), 'dialog');
for (let i = 0; i < 12; i++) await key('Tab');
check('Tab stays in the dialog', await focus(), 'dialog');
await send('Input.dispatchKeyEvent', { type: 'char', text: '/', key: '/' });
await settle(150);
check('/ doesn’t reach the search box behind it', await focus(), 'dialog');
await key('Escape');
await settle(200);
check('closing gives the keys back to the account button', await focus(), 'user');

// The search dropdown closes when Tab moves on.
await ev(`document.getElementById('search').focus()`);
await typeText('guide');
await settle(800);
check('the dropdown is open', await ev(`!document.getElementById('search-drop').hidden`), true);
await key('Tab');
await settle(200);
check('Tab closes it', await ev(`document.getElementById('search-drop').hidden`), true);

// A narrow window folds the chat panel; the main panel keeps at least 320 px.
const main = () => ev(`Math.round(document.getElementById('main').getBoundingClientRect().width)`);
await size(760);
await settle(500);
check('760 px: chat folded, main has room', [await ev(`document.body.classList.contains('chat-hidden')`), (await main()) >= 320], [true, true]);
await size(1200);
await settle(500);
check('wider again: chat back', await ev(`document.body.classList.contains('chat-hidden')`), false);

// Wide panels, then a smaller window: they give way; nothing scrolls sideways.
await ev(`localStorage.setItem('mt-side-w', '600'); localStorage.setItem('mt-chat-w', '600')`);
await size(1600);
await send('Page.reload');
await settle(2500);
await size(1000);
await settle(500);
check('shrunk with wide panels: main keeps 320 px, no sideways scroll',
  [(await main()) >= 320, await ev(`document.documentElement.scrollWidth <= innerWidth`)], [true, true]);

await done();
