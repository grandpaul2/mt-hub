// Doing things twice, or while something else lands, on a slow link (the bug sweep's finds):
// a double Enter sends once, a double Ctrl+S saves once without a false conflict, a reaction
// arriving while you edit a message keeps what you typed, and a search result for a name
// with % or & in it opens that file.
import { api, check, COOKIE, done, ev, HUB, hub, key, send, settle, typeText } from './lib.mjs';

const msgs = async () => (await (await api('GET', '/api/channels/general/messages')).json());
await send('Network.enable');
const slow = (latency) => send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });

// A double Enter on a slow link sends once.
await send('Page.navigate', { url: `${HUB}/#chan=general` });
await settle(2500);
const compose = `document.querySelector('#main-chat-body .compose')`;
await ev(`${compose}.focus()`);
await typeText('dup test');
await slow(600);
await key('Enter');
await key('Enter');
await settle(1500);
await slow(0);
check('a double Enter sends once', (await msgs()).filter((m) => m.text === 'dup test').length, 1);
check('the box is empty after sending', await ev(`${compose}.value`), '');

// A reaction landing while you edit your message keeps what you've typed.
await ev(`${compose}.focus()`);
await typeText('editme');
await key('Enter');
await settle(1000);
const mine = (await msgs()).find((m) => m.text === 'editme');
await key('ArrowUp'); // edit your last message
await settle(300);
await typeText(' plus more');
await api('PUT', `/api/channels/general/messages/${mine.id}/reactions/${encodeURIComponent('👍')}`, undefined, 'Alex');
await settle(1000);
check('the edit box keeps what you typed', await ev(`document.querySelector('.msg-edit textarea')?.value`), 'editme plus more');

// A double Ctrl+S on a slow link: one save, no conflict view.
await hub('/api/file/notes/race.txt?base=', { method: 'PUT', body: 'start\n' });
await send('Page.navigate', { url: `${HUB}/?r=1#notes/race.txt` });
await settle(2500);
await ev(`[...document.querySelectorAll('#toolbar .single-actions > button')].find((b) => b.textContent === 'Edit').click()`);
await settle(500);
const box = await ev(`(() => { const r = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect(); return [r.x + 100, r.y + 8]; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
await settle(200);
for (const ch of 'xyz') await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
await settle(300);
await slow(600);
const ctrlS = async () => {
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
};
await ctrlS();
await settle(50);
await ctrlS();
await settle(2500);
await slow(0);
check('no conflict view', await ev(`!!document.querySelector('.diff')`), false);
check('saved once', (await (await hub('/api/history/notes/race.txt')).json()).length, 2);

// Search results for names with % and & open those files.
for (const name of ['100%.md', 'a%41.md']) await hub(`/api/file/notes/${encodeURIComponent(name)}?base=`, { method: 'PUT', body: name });
await hub(`/api/file/screenshots/${encodeURIComponent('amp&item=x.png')}?base=`, { method: 'PUT', body: 'not really a png' });
const openFromSearch = async (q) => {
  await ev(`(() => { const b = document.getElementById('search'); b.focus(); b.value = ''; })()`);
  await typeText(q);
  await settle(800);
  await key('Enter');
  await settle(1500);
  return ev(`location.hash`);
};
for (const [q, want] of [['100%', '#notes/100%25.md'], ['a%41', '#notes/a%2541.md']]) {
  check(`search opens ${q}.md`, [await openFromSearch(q), await ev(`document.getElementById('view').textContent.trim()`)], [want, `${q}.md`]);
}
check('search points at amp&item=x.png in its folder', [await openFromSearch('amp&item'), await ev(`document.querySelector('#main-folder .flash')?.dataset.path ?? ''`)],
  ['#folder=screenshots&item=amp%26item%3Dx.png', 'screenshots/amp&item=x.png']);

// A malformed address doesn't throw (the page's errors are printed and fail the suite).
await send('Page.navigate', { url: `${HUB}/#100%` });
await settle(1500);

await done();
