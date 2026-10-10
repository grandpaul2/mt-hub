// Files at the edges (the bug sweep's finds): a top-level file named like a page opens as
// the file, Back to the very first address opens #general again, and deleting a file
// someone already deleted closes it with a word instead of nothing.
import { answerDialogs, api, check, done, ev, HUB, hub, send, settle } from './lib.mjs';

await hub('/api/file/schems?base=', { method: 'PUT', body: 'my file called schems' });
await send('Page.navigate', { url: HUB });
await settle(2500);
await answerDialogs(true);
const view = () => ev(`document.getElementById('view').textContent.replace(/\\s/g, ' ').trim()`); // Monaco's spaces are non-breaking

// A file named like the Schematic Manager's address opens as the file, after a reload too.
await ev(`location.hash = '#schems'`);
await settle(1500);
check('#schems opens the file called schems', [(await view()).endsWith('my file called schems'), await ev(`document.getElementById('main-schems').hidden`)], [true, true]);
await send('Page.reload');
await settle(2500);
check('after a reload too', (await view()).endsWith('my file called schems'), true);

// The bare address opens #general (in place), and Back to it shows #general again.
await send('Page.navigate', { url: HUB });
await settle(2500);
check('the bare address opens #general', [await ev(`location.hash`), await ev(`document.getElementById('main-chat').hidden`)], ['#chan=general', false]);
await ev(`location.hash = '#docs/guide.md'`);
await settle(1500);
await ev(`history.back()`);
await settle(1500);
check('Back to the first address shows #general', [await ev(`location.hash`), await ev(`document.getElementById('main-chat').hidden`)], ['#chan=general', false]);

// Deleting a file someone else already deleted: closes it, and says so.
await ev(`location.hash = '#notes/todo.md'`);
await settle(1500);
const rev = (await (await api('GET', '/api/stat/notes/todo.md')).json()).rev;
await api('DELETE', `/api/file/notes/todo.md?base=${rev}`);
await ev(`document.querySelector('#toolbar button[title^="Delete"]').click()`);
await settle(1200);
check('says it was already deleted, and closes it', [await ev(`document.getElementById('toast').textContent`), await ev(`location.hash`)],
  ['Someone already deleted it.', '']); // notes/ went with its only file: the empty file area

await done();
