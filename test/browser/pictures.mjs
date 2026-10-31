// screenshots/ and map art/: ordinary no-history folders in the folder view. Screenshots read
// like a feed with who/from/to filters from their "<date> <time> <poster>" names, and new
// ones (upload, drop, paste) get such a name; map art goes by its titles.
import { check, COOKIE, done, ev, HUB, hub, key, png, SEED, send, settle, shot } from './lib.mjs';

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','[]')`);
await send('Page.reload');
await settle(2000);
const hash = () => ev(`decodeURIComponent(location.hash)`);
const tiles = () => ev(`[...document.querySelectorAll('#main-folder .shot')].map((t) => t.dataset.path.slice(t.dataset.path.indexOf('/') + 1))`);
const tree = async () => (await (await hub(`/api/tree`)).json()).map((e) => e.path);
const setFilter = (sel, v) => ev(`(() => { const el = document.querySelector('#main-folder ${sel}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('change')); })()`);

// Screenshots: name order (= when taken), the poster and time on each tile, and a Filters
// button with the filters put away.
const filt = () => ev(`(() => { const b = document.querySelector('#main-folder .filters-toggle'), f = document.querySelector('#main-folder .filters'), c = f.querySelector('button');
  return { button: !b.hidden, out: !f.hidden, pressed: b.getAttribute('aria-pressed') === 'true', clearBlue: c.classList.contains('primary') }; })()`);
const pressFilters = async () => {
  await ev(`document.querySelector('#main-folder .filters-toggle').click()`);
  await settle(300);
};
await ev(`document.querySelector('.row[data-path="screenshots"]').click()`);
await settle(800);
check('screenshots folder view', [await hash(), await tiles(), await filt()],
  ['#folder=screenshots', SEED.shots, { button: true, out: false, pressed: false, clearBlue: false }]);
check('tiles show poster and time', await ev(`[...document.querySelectorAll('#main-folder .shot .who')].map((w) => w.textContent)`),
  ['Pat', 'Alex', 'eldridge', 'eldridge', 'eldridge', 'Lennox']);
check('opens at the bottom (newest)', await ev(`(() => { const s = document.querySelector('#main-folder .shot-scroll'); return s.scrollTop + s.clientHeight >= s.scrollHeight - 2; })()`), true);
check('no history', await ev(`document.querySelector('.row[data-path="screenshots"]').title.includes('no history')`), true);
await shot('screenshots');
await pressFilters();
check('Filters brings them out, left of it', [await filt(), await ev(`document.querySelector('#main-folder .filters').getBoundingClientRect().right <= document.querySelector('#main-folder .filters-toggle').getBoundingClientRect().left`)],
  [{ button: true, out: true, pressed: true, clearBlue: false }, true]);
await pressFilters();
check('and puts them away', (await filt()).out, false);
await pressFilters();
check('who list', await ev(`[...document.querySelectorAll('#main-folder .filters select option')].map((o) => o.textContent)`), ['Everyone', 'Alex', 'eldridge', 'Lennox', 'Pat']);
await setFilter('.filters select', 'eldridge');
check('who filter', [(await tiles()).length, await ev(`document.querySelector('#main-folder .count').textContent`)], [3, '3 of 6']);
check('a filter set: Clear is blue', (await filt()).clearBlue, true);
await pressFilters();
check('and Filters can\'t put them away', [await filt(), (await tiles()).length], [{ button: true, out: true, pressed: true, clearBlue: true }, 3]);
await setFilter('input[title="From (inclusive)"]', '2026-09-04');
check('from filter', (await tiles()).length, 2);
await ev(`document.querySelector('#main-folder .filters button').click()`);
check('clear', [(await tiles()).length, await filt()], [SEED.shots.length, { button: true, out: true, pressed: true, clearBlue: false }]);
await pressFilters();
check('cleared, Filters puts them away again', (await filt()).out, false);

// A picture opens on its own; ←/→ step in the folder's order; Esc goes back.
await ev(`document.querySelector('#main-folder .shot[data-path="screenshots/${SEED.shots[1]}"]').click()`);
await settle(600);
check('opens one picture', [await hash(), await ev(`document.querySelector('#toolbar .single-bar > button')?.textContent`)], [`#screenshots/${SEED.shots[1]}`, '← Back to screenshots/']);
await key('ArrowRight');
await settle(500);
check('arrow steps', await hash(), `#screenshots/${SEED.shots[2]}`);
await key('Escape');
await settle(400);
check('Esc back to the folder', await hash(), '#folder=screenshots');

// Dropped on the folder, a picture is named by when it was taken and who posts it.
await ev(`(async () => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([${[...png(8, 8, [1, 2, 3])]}])], 'Screenshot from my phone.png', { type: 'image/png', lastModified: new Date('2026-10-01T21:09:08').getTime() }));
  document.querySelector('#main-folder .shot-scroll').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
})()`);
await settle(1500);
check('upload gets a stamped name', (await tree()).includes('screenshots/2026-10-01 21.09.08 Pat.png'), true);
// Pasting one (the clipboard has no file name or date) is named by now.
await ev(`(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([${[...png(8, 8, [3, 2, 1])]}])], 'image.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));
})()`);
await settle(1500);
const today = await ev(`(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
check('paste gets a stamped name', (await tree()).some((p) => p.startsWith(`screenshots/${today} `) && p.endsWith(' Pat.png')), true);

// Map art: titles, in name order; no who/from/to (the names aren't stamped).
await ev(`document.querySelector('.row[data-path="map art"]').click()`);
await settle(800);
check('map art folder view', [await hash(), await tiles(), await filt()],
  ['#folder=map art', SEED.mapart, { button: false, out: false, pressed: false, clearBlue: false }]);
check('tiles show titles', await ev(`document.querySelector('#main-folder .shot .who').textContent`), SEED.mapart[0]);
await shot('map-art');

// Old addresses still land in the folders.
await send('Page.navigate', { url: `${HUB}/?r=2#mapart` });
await settle(1500);
check('#mapart opens map art/', await hash(), '#folder=map art');
await send('Page.navigate', { url: `${HUB}/?r=3#shots` });
await settle(1500);
check('#shots opens screenshots/', await hash(), '#folder=screenshots');

// The folders themselves stay put (like large/); files in them rename freely.
const mv = await fetch(`${HUB}/api/move`, { method: 'POST', headers: { cookie: COOKIE.Pat }, body: JSON.stringify({ from: 'map art', to: 'art' }) });
check('map art/ can\'t be renamed', mv.ok, false);
const rn = await fetch(`${HUB}/api/move`, { method: 'POST', headers: { cookie: COOKIE.Pat }, body: JSON.stringify({ from: `map art/${SEED.mapart[4]}`, to: 'map art/MA-005 The Starry Night.png' }) });
check('a picture renames', [rn.ok, (await tree()).includes('map art/MA-005 The Starry Night.png')], [true, true]);

await done();
