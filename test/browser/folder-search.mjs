// The folder view's search box is tucked away: the glass at the end of the bar's icon
// buttons slides it in (turning blue, the buttons moving left) and out again, and sliding
// it out clears the search.
import { check, done, ev, HUB, key, SEED, send, settle, shot, typeText } from './lib.mjs';

// Wide enough that the bar is one row, as on a desktop (narrower, the box wraps below).
await send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','[]')`);
await send('Page.reload');
await settle(2000);
await ev(`document.querySelector('.row[data-path="map art"]').click()`);
await settle(800);

const glass = `document.querySelector('#main-folder .viewer-tools .vtool:last-child')`;
const state = () => ev(`(() => {
  const g = ${glass}, slot = document.querySelector('#main-folder .search-slot'), box = slot.querySelector('input');
  return { on: g.getAttribute('aria-pressed') === 'true', width: Math.round(slot.getBoundingClientRect().width),
    focused: document.activeElement === box, text: box.value, blue: getComputedStyle(g).color === 'rgb(55, 148, 255)' };
})()`);
const toolsX = () => ev(`Math.round(document.querySelector('#main-folder .viewer-tools').getBoundingClientRect().x)`);
const count = () => ev(`document.querySelector('#main-folder .count').textContent`);
const click = async () => {
  await ev(`${glass}.click()`);
  await settle(600);
};

check('the glass is the last icon button', await ev(`${glass}.title`), 'Search names');
check('hidden to begin with', await state(), { on: false, width: 0, focused: false, text: '', blue: false });
const x0 = await toolsX();
await click();
check('the glass slides it in', await state(), { on: true, width: 222, focused: true, text: '', blue: true });
check('the buttons moved left by the box', x0 - await toolsX(), 230);
await typeText('logo');
await settle(400);
check('it searches', await count(), `1 of ${SEED.mapart.length}`);
await shot('folder-search-open');
await click();
check('the glass slides it out and clears it', [await state(), await count(), await toolsX()],
  [{ on: false, width: 0, focused: false, text: '', blue: false }, String(SEED.mapart.length), x0]);

// Esc in the box closes it too, and doesn't leave the folder.
await click();
await typeText('flag');
await settle(300);
await key('Escape');
await settle(600);
check('Esc closes it', [await state(), await count(), await ev(`decodeURIComponent(location.hash)`)],
  [{ on: false, width: 0, focused: false, text: '', blue: false }, String(SEED.mapart.length), '#folder=map art']);

await done();
