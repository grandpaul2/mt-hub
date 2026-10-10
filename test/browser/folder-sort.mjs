// The folder view's sort: the bar's button reads "sort:name" or "sort:date" and opens a menu with both.
// By date is newest first, folders too (a folder's date is its newest file's); the choice is
// one for every folder, kept per browser, and ←/→ on a single picture follow it.
import { utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { check, DATA, done, ev, HUB, key, SEED, send, settle, shot } from './lib.mjs';

// Dates on disk: map art from oldest to newest is 2, 4, 1, 5, 3; Build 2's folder holds the
// newest schematic file, then Build 5.
const ws = join(DATA, 'workspace');
const day = (n) => new Date(Date.UTC(2026, 0, n, 12));
const touch = (p, n) => utimesSync(join(ws, p), day(n), day(n));
[1, 3, 0, 4, 2].forEach((i, n) => touch(`map art/${SEED.mapart[i]}`, 10 + n));
for (const d of readdirSync(join(ws, 'schematics'), { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const n = d.name === 'Build 2' ? 25 : d.name === 'Build 5' ? 24 : 5;
  for (const f of readdirSync(join(ws, 'schematics', d.name))) touch(`schematics/${d.name}/${f}`, n);
}

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','[]')`);
await send('Page.reload');
await settle(2000);
const hash = () => ev(`decodeURIComponent(location.hash)`);
const tiles = () => ev(`[...document.querySelectorAll('#main-folder .shot')].map((t) => t.dataset.path.slice(t.dataset.path.indexOf('/') + 1))`);
const open = async (dir) => {
  await ev(`document.querySelector('.row[data-path="${dir}"]').click()`);
  await settle(800);
};
const button = () => ev(`document.querySelector('#main-folder .sort').textContent`);
// pick opens the sort menu and clicks an item; it answers what the menu showed.
const pick = async (label) => {
  await ev(`document.querySelector('#main-folder .sort').click()`);
  await settle(300);
  const menu = await ev(`[...document.querySelectorAll('#menu > button')].map((b) => b.firstElementChild.textContent + (b.querySelector('.key svg') ? ' ✓' : ''))`);
  await ev(`[...document.querySelectorAll('#menu > button')].find((b) => b.firstElementChild.textContent === ${JSON.stringify(label)}).click()`);
  await settle(500);
  return menu;
};
const byDate = [2, 4, 0, 3, 1].map((i) => SEED.mapart[i]);

await open('map art');
check('by name to begin with', [await button(), await tiles()], ['sort:name', SEED.mapart]);
check('the menu ticks the sort in use', await pick('Date modified'), ['Name ✓', 'Date modified']);
check('by date, newest first', [await button(), await tiles()], ['sort:date', byDate]);
await shot('folder-sort-date');

// ←/→ on one picture step in the same order.
await ev(`document.querySelector('#main-folder .shot[data-path="map art/${byDate[0]}"]').click()`);
await settle(600);
await key('ArrowRight');
await settle(500);
check('arrows follow the sort', await hash(), `#map art/${byDate[1]}`);
await key('Escape');
await settle(500);

// Folders follow too, by their newest file, and show that date.
await open('schematics');
const posts = await tiles();
check('folders by their newest file', posts.slice(0, 2), ['Build 2', 'Build 5']);
check('the rest by name', posts.slice(2).filter((p) => p.startsWith('Build')), ['Build 1', 'Build 3', 'Build 4', 'Build 6']);
check('a folder shows its date', await ev(`!!document.querySelector('#main-folder .shot[data-path="schematics/Build 2"] .when')?.textContent`), true);

// screenshots/ by date: newest at the top, like any folder (by name it opens at the bottom).
await open('screenshots');
const shots = await tiles();
check('screenshots newest first', [shots[0], shots.at(-1)], [SEED.shots[5], SEED.shots[0]]);
check('opens at the top', await ev(`document.querySelector('#main-folder .shot-scroll').scrollTop`), 0);

// The choice is kept; Name puts everything back.
await send('Page.reload');
await settle(2000);
await open('map art');
check('kept across a reload', [await button(), await tiles()], ['sort:date', byDate]);
check('the tick moved', await pick('Name'), ['Name', 'Date modified ✓']);
check('back by name', [await button(), await tiles()], ['sort:name', SEED.mapart]);
await open('schematics');
check('folders by name, no date', [(await tiles()).filter((p) => p.startsWith('Build')), await ev(`!!document.querySelector('#main-folder .shot[data-path="schematics/Build 2"] .when')`)],
  [SEED.schems.map((s) => s[0]), false]);

await done();
