// Files at the edges (the bug sweep's finds): a top-level file named like a page opens as
// the file, Back to the very first address opens #general again, and deleting a file
// someone already deleted closes it with a word instead of nothing.
import { answerDialogs, api, check, done, ev, HUB, hub, key, send, settle } from './lib.mjs';

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
await ev(`document.querySelector('#toolbar button[title="Move to Trash"]').click()`);
await settle(1200);
check('says it was already deleted, and closes it', [await ev(`document.getElementById('toast').textContent`), await ev(`location.hash`)],
  ['Someone already moved it to Trash.', '#folder=notes']); // its folder, which stays though it's empty now

// A file at the top has a Back button too: its folder is Files. Esc does the same.
await send('Page.navigate', { url: `${HUB}/?r=9#README.md` });
await settle(1500);
const back = `document.querySelector('#toolbar .single-bar > button')`;
check('a top-level file has Back to Files', await ev(`${back}?.textContent ?? null`), '← Back to Files');
await ev(`${back}.click()`);
await settle(600);
check('it opens Files', [await ev(`location.hash`), await ev(`document.getElementById('main-folder').hidden`)], ['#folder=', false]);
await send('Page.navigate', { url: `${HUB}/?r=10#README.md` });
await settle(1500);
await key('Escape');
check('Esc from a top-level file opens Files', await ev(`location.hash`), '#folder=');

await done();
