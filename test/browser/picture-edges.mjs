// Pictures and posts at the edges (the bug sweep's finds): a "picture" that isn't one shows
// its file icon, not a broken image; a picture deleted while you look at it says so plainly
// and the arrows go to its neighbours; a post title with no letters is refused, and a long
// one with accents posts (its folder name shortened, the title whole).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, check, done, ev, HUB, hub, key, OUT, SEED, send, settle } from './lib.mjs';

// Not really a picture: the tile shows the file's icon.
await hub(`/api/file/screenshots/${encodeURIComponent('zz-text.png')}?base=`, { method: 'PUT', body: 'not a picture' });
await send('Page.navigate', { url: `${HUB}/#folder=screenshots` });
await settle(2500);
check('a bad picture shows its icon, not a broken image', await ev(`(() => {
  const tile = document.querySelector('#main-folder .shot[data-path="screenshots/zz-text.png"]');
  return [!!tile.querySelector('.folder-icon'), [...document.querySelectorAll('#main-folder img.thumb')].filter((i) => i.complete && !i.naturalWidth).length];
})()`), [true, 0]);

// A picture deleted while you look at it: plain words, and → goes to its neighbour.
const shots = SEED.shots.toSorted(); // the folder's order: by name, which is by time
const second = `screenshots/${shots[1]}`;
await send('Page.navigate', { url: `${HUB}/?r=2#${encodeURIComponent(second).replace(/%2F/g, '/')}` });
await settle(2500);
const rev = (await (await api('GET', `/api/stat/${encodeURIComponent(second).replace(/%2F/g, '/')}`)).json()).rev;
await api('DELETE', `/api/file/${encodeURIComponent(second).replace(/%2F/g, '/')}?base=${encodeURIComponent(rev)}`);
await settle(4000);
check('the banner says it went to Trash', await ev(`document.getElementById('banner').textContent`), 'Someone moved this file to Trash.');
await ev(`document.getElementById('view').focus()`);
await key('ArrowRight');
await settle(1500);
check('→ goes to its neighbour, not the first', await ev(`decodeURIComponent(location.hash)`), `#screenshots/${shots[2]}`);

// Post titles.
writeFileSync(join(OUT, 'edge.litematic'), 'abc');
await send('DOM.enable');
const setFile = async (sel, path) => {
  const doc = await send('DOM.getDocument');
  const n = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
  await send('DOM.setFileInputFiles', { files: [path], nodeId: n.nodeId });
};
const post = async (title) => {
  await send('Page.navigate', { url: `${HUB}/?r=${Math.random()}#schems` });
  await settle(1500);
  await ev(`[...document.querySelectorAll('#main-schems button')].find((b) => b.textContent === 'Upload Schematic').click()`);
  await settle(300);
  await setFile('.schem-edit input[type=file][accept^=".litematic"]', join(OUT, 'edge.litematic'));
  await ev(`(() => { const t = document.querySelector('.schem-edit-title'); t.value = ${JSON.stringify(title)}; t.dispatchEvent(new Event('input')); })()`);
  await ev(`[...document.querySelectorAll('#main-schems .single-actions > button')].find((b) => b.textContent === 'Post').click()`);
  await settle(1500);
  return ev(`document.getElementById('toast').textContent`);
};
const loose = async () => (await (await hub('/api/tree')).json()).filter((e) => /^schematics\/[^/]+$/.test(e.path) && !e.dir).map((e) => e.path);
check('a title of dots is refused', [await post('...'), await loose()], ['Pick a title with letters or numbers.', []]);
const long = 'ünï☃'.repeat(45); // 180 characters, 405 bytes
await post(long);
const made = (await (await hub('/api/schematics')).json()).find((p) => p.title === long);
check('a long accented title posts, its folder shortened', [!!made, new TextEncoder().encode(made?.dir ?? '').length <= 200], [true, true]);

await done();
