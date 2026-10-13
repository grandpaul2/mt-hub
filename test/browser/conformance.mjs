// The style guide's conformance pass, batch 1 (section 15): one themed question with a red
// confirm for destroying, Esc closing dialogs (not the login, and not the folder underneath),
// keyboard in menus, error toasts, toasts above the viewer, focus rings, Keyboard Shortcuts.
import { api, check, done, ev, HUB, key, send, settle, typeText } from './lib.mjs';

await api('POST', '/api/channels/general/messages', { text: 'hello' }, 'Paul');
await send('Page.navigate', { url: `${HUB}/#folder=notes` });
await settle(2500);
const overlay = () => ev(`!document.getElementById('overlay').hidden`);

// The menu on your name, by keyboard: ↓ highlights, Enter picks.
await ev(`document.getElementById('user').click()`);
await settle(150);
await key('ArrowDown');
check('↓ highlights the first item', await ev(`document.querySelector('#menu button.on')?.firstChild.textContent`), 'Admin');
await key('ArrowDown');
check('↓ again: the next', await ev(`document.querySelector('#menu button.on')?.firstChild.textContent`), 'Keyboard Shortcuts');
await key('ArrowUp');
await key('ArrowUp');
check('↑ wraps to the last', await ev(`document.querySelector('#menu button.on')?.firstChild.textContent`), 'Log Out Everywhere');
await key('ArrowUp'); // (past Log Out)
await key('ArrowUp');
await key('ArrowUp');
await key('ArrowUp'); // (past Sound Settings)
await key('ArrowUp'); // (past Voice Settings)
await key('Enter');
await settle(300);
check('Enter picks: Keyboard shortcuts', [await overlay(), await ev(`document.querySelector('#dialog h2').textContent`), await ev(`document.querySelectorAll('#dialog table.keys tr').length >= 8`)],
  [true, 'Keyboard shortcuts', true]);

// Esc closes it, and the folder view underneath stays where it is.
await key('Escape');
await settle(200);
check('Esc closes the dialog, folder untouched', [await overlay(), await ev('location.hash')], [false, '#folder=notes']);

// A destructive question: red confirm named for the action, Cancel first; Esc is Cancel.
await ev(`document.querySelector('#channels .row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }))`);
await settle(150);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Delete').click()`);
await settle(500);
check('delete question', await ev(`[document.querySelector('#dialog h2').textContent, [...document.querySelectorAll('#dialog .actions button')].map((b) => b.textContent + ':' + b.className)]`),
  ['Delete #general?', ['Cancel:', 'Delete:danger']]);
check('the confirm is red', await ev(`getComputedStyle(document.querySelector('#dialog .danger')).backgroundColor`), 'rgb(161, 38, 13)');
await key('Escape');
await settle(300);
check('Esc answers Cancel', [await overlay(), (await (await fetch(`${HUB}/api/channels`, { headers: { cookie: (await import('./lib.mjs')).COOKIE.Paul } })).json()).length], [false, 1]);

// An error toast: its own look.
await send('Page.navigate', { url: `${HUB}/?r=1#chan=general` });
await settle(2500);
await ev(`document.querySelector('#main-chat .compose').focus()`);
await key('ArrowUp');
await settle(300);
// Editing a message: on desktop the hint names the keys (Enter and Esc in blurple) and there
// are no buttons; on a phone, Save and Cancel and no hint.
const editRow = () => ev(`(() => { const e = document.querySelector('#chat .msg-edit') ?? document.querySelector('#main-chat .msg-edit');
  const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
  return [shown(e.querySelector('.hint')) ? e.querySelector('.hint').textContent : null,
    [...e.querySelectorAll('.hint .key')].map((k) => getComputedStyle(k).color),
    [...e.querySelectorAll(':scope > button')].filter(shown).map((b) => b.textContent)]; })()`);
check('desktop edit: keys, no buttons', await editRow(), ['Enter to save · Esc to cancel', ['rgb(88, 101, 242)', 'rgb(88, 101, 242)'], []]);
// The keys in the hint are clickable: Esc cancels, Enter saves.
await ev(`document.querySelector('#main-chat .msg-edit textarea').value = 'not kept'`);
await ev(`[...document.querySelectorAll('#main-chat .msg-edit .hint .key')].find((k) => k.textContent === 'Esc').click()`);
await settle(300);
check('clicking Esc cancels', await ev(`!document.querySelector('#main-chat .msg-edit') && ![...document.querySelectorAll('#main-chat .msg')].some((m) => m.textContent.includes('not kept'))`), true);
await ev(`document.querySelector('#main-chat .compose').focus()`);
await key('ArrowUp');
await settle(300);
await ev(`document.querySelector('#main-chat .msg-edit textarea').value = 'saved by a click'`);
await ev(`[...document.querySelectorAll('#main-chat .msg-edit .hint .key')].find((k) => k.textContent === 'Enter').click()`);
await settle(500);
check('clicking Enter saves', await ev(`!document.querySelector('#main-chat .msg-edit') && [...document.querySelectorAll('#main-chat .msg')].some((m) => m.textContent.includes('saved by a click'))`), true);
// Saving an edit the hub refuses (over 4000 characters): an error toast.
await ev(`document.querySelector('#main-chat .compose').focus()`);
await key('ArrowUp');
await settle(300);
await ev(`(() => { const t = document.querySelector('#main-chat .msg-edit textarea'); t.value = 'x'.repeat(4001); t.focus(); })()`);
await key('Enter');
await settle(500);
check('error toast', await ev(`(() => { const t = document.getElementById('toast'); return [t.hidden, t.classList.contains('error'), t.textContent.startsWith('Couldn’t save it')]; })()`), [false, true, true]);
await key('Escape');
await settle(200);
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: `${HUB}/?r=2#chan=general` });
await settle(2500);
await ev(`document.querySelector('#chat .compose').focus()`);
await key('ArrowUp');
await settle(300);
check('phone edit: buttons, no hint', await editRow(), [null, ['rgb(88, 101, 242)', 'rgb(88, 101, 242)'], ['Save', 'Cancel']]);
await ev(`document.querySelector('#chat .msg-edit textarea').value = 'edited on a phone'`);
await ev(`[...document.querySelectorAll('#chat .msg-edit button')].find((b) => b.textContent === 'Save').click()`);
await settle(500);
check('phone Save saves', await ev(`!document.querySelector('#chat .msg-edit') && [...document.querySelectorAll('#chat .msg')].some((m) => m.textContent.includes('edited on a phone'))`), true);
await send('Emulation.clearDeviceMetricsOverride');
await send('Page.navigate', { url: `${HUB}/?r=3#chan=general` });
await settle(2500);
check('toasts sit above the viewer', await ev(`+getComputedStyle(document.getElementById('toast')).zIndex > +getComputedStyle(document.getElementById('viewer') ?? document.body).zIndex || +getComputedStyle(document.getElementById('toast')).zIndex > 100`), true);

// Keyboard focus shows on buttons.
await ev(`document.getElementById('search').focus()`);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
await settle(150);
check('a focused button has a ring', await ev(`(() => { const b = document.activeElement; return b.tagName + ':' + getComputedStyle(b).outlineStyle; })()`), 'BUTTON:solid');

// Batch 3: icons are icons, not text glyphs; reduced motion is honoured; menus say "…" only
// when more is asked for.
check('the chat panel toggle is an icon', await ev(`(() => { const b = document.getElementById('chat-hide'); return [!!b.querySelector('svg'), b.textContent.trim()]; })()`), [true, '']);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
check('reduced motion: no turning chevrons', await ev(`getComputedStyle(document.querySelector('#tree .row .twisty svg')).transitionDuration`), '0s');
await send('Emulation.setEmulatedMedia', { features: [] });
await send('Page.navigate', { url: `${HUB}/?r=3#chan=general` }); // out of the edit above
await settle(2500);
await ev(`document.querySelector('#main-chat .msg').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))`);
await settle(150);
check('message menu: … where more is asked', await ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent).filter((t) => /Reaction|Forward|Delete/.test(t))`), ['Add Reaction…', 'Forward…', 'Delete']);
await key('Escape');
check('tooltips in sentence case', await ev(`document.querySelector('#main-chat .msg [data-tool="react"]')?.title ?? document.querySelector('.pins-btn').title`), 'Add reaction');

// The login can't be closed with Esc.
await send('Network.clearBrowserCookies');
await send('Page.navigate', { url: `${HUB}/?r=2` });
await settle(2000);
await key('Escape');
await settle(200);
check('login stays on Esc', [await overlay(), await ev(`document.querySelector('#dialog h2').textContent`)], [true, 'MacroTech']);

await done();
