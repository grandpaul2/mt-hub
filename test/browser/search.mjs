// The search box in the top bar: / opens it with the filter list, results come grouped
// (messages, schematics, files, in files), arrows + Enter or a click open one where it is,
// filters suggest their values as they're typed.
import { api, check, done, ev, HUB, hub, key, send, settle, shot, typeText } from './lib.mjs';

const farms = ['# Farms', '', 'Notes on the farms.', '', '## Gold', 'At the nether roof.', '', '## Iron', 'The iron farm is at spawn.', ''].join('\n');
await hub('/api/file/notes/farms.md?base=', { method: 'PUT', body: farms });
const iron = await (await api('POST', '/api/channels/general/messages', { text: 'the iron farm works' })).json();
await api('POST', '/api/channels/general/messages', { text: '@Alex look #[screenshots/2026-09-03 15.00.03 eldridge.png]' }, 'Pat');

await send('Page.navigate', { url: HUB });
await settle(2500);

const state = () => ev(`(() => {
  const d = document.getElementById('search-drop');
  return { open: !d.hidden, heads: [...d.querySelectorAll('.search-head')].map((x) => x.textContent),
    rows: [...d.querySelectorAll('.search-row')].map((x) => x.textContent), on: d.querySelector('.search-row.on')?.textContent ?? null,
    error: d.querySelector('.pad')?.textContent ?? null };
})()`);
const search = async (q) => {
  await ev(`(() => { const b = document.getElementById('search'); b.focus(); b.value = ''; })()`);
  await typeText(q);
  await settle(700);
  return state();
};
const hash = () => ev('decodeURIComponent(location.hash)');

await key('/');
await settle(400);
let s = await state();
check('/ focuses, filters listed', [await ev(`document.activeElement.id`), s.heads, s.rows.length], ['search', ['Filters'], 4]);
await shot('filters');

s = await search('IRON');
check('grouped results, first selected', [s.heads, s.on], [['Messages · 1', 'Files and folders · 0', 'In files · 1'].filter((x) => !x.includes('· 0')), s.rows[0]]);
check('marks the words', await ev(`[...document.querySelectorAll('#search-drop mark')].map((m) => m.textContent)`), ['iron', 'Iron']);
await shot('results');
await key('Enter');
await settle(1200);
check('Enter opens the message, flashed', [await hash(), await ev(`!!document.querySelector('#main-chat .msg.flash[data-id="${iron.id}"]')`), await ev(`document.getElementById('search-drop').hidden`)],
  ['#chan=general', true, true]);

s = await search('iron spawn');
check('in files: the best line', s.rows, ['farms.md notes9: The iron farm is at spawn.  (+1 more line)']);
await key('Enter');
await settle(1500);
check('opens the file, Markdown block at the line flashes', [await hash(), await ev(`document.querySelector('.markdown .flash')?.textContent.trim()`)],
  ['#notes/farms.md', 'The iron farm is at spawn.']);

s = await search('from:');
check('from: suggests accounts', s.rows, ['Alex', 'Pat', 'Steve']);
await key('ArrowDown');
await key('Enter');
await settle(800);
s = await state();
check('picked: box completed, searched', [await ev(`document.getElementById('search').value`), s.heads, s.rows[0]?.startsWith('# generalAlex')],
  ['from:Alex ', ['Messages · 1'], true]);

s = await search('in:');
check('in: suggests chats and folders', [s.rows.includes('# general'), s.rows.includes('boards/')], [true, true]);
s = await search('mentions:alex');
check('mentions', [s.heads, s.rows[0].includes('look')], [['Messages · 1'], true]);
s = await search('has:image');
check('has:image', [s.heads, s.rows[0].includes('screenshots/')], [['Messages · 1'], true]);
s = await search('eldridge in:screenshots/');
check('in a folder', s.heads, ['Files and folders · 3']);
await key('Enter');
await settle(1200);
check('a picture opens in its folder', await hash(), '#folder=screenshots&item=2026-09-03 15.00.03 eldridge.png');

s = await search('glowsquid');
check('schematic posts as cards', [s.heads, s.rows], [['Schematics · 1'], ['Build 1Design by Glowsquid · 2026-07-01']]);
await key('Enter');
await settle(1200);
check('opens the post', await hash(), '#schem=Build 1');

s = await search('in:nowhere');
check('bad filter says why', s.error, 'no chat or folder called nowhere');
s = await search('zzzz');
check('nothing found', s.error, 'Nothing found.');
await key('Escape');
await settle(200);
check('Esc closes', [(await state()).open, await ev(`document.activeElement.id`)], [false, '']);

await done();
