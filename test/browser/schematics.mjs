// The Schematic Manager: the schematics/ folder (a folder per post: schematic file, renders,
// README.md) shown as a board of big cards from the sidebar, below the chats. Posts open on
// their own; a post is made and edited on its own page, writing plain files; changes made in Files show up on the board.
import { answerDialogs, check, COOKIE, done, ev, HUB, hub, key, png, SEED, send, settle, shot } from './lib.mjs';

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded','[]')`);
await answerDialogs(true);
await send('Page.reload');
await settle(2000);
await answerDialogs(true);
const rows = () => ev(`[...document.querySelectorAll('#tree .row[data-path]')].map((r) => r.dataset.path)`);
const hash = () => ev(`decodeURIComponent(location.hash)`);
const cards = () => ev(`[...document.querySelectorAll('#main-schems .schem-card .schem-title')].map((t) => t.textContent)`);
const tree = async () => (await (await hub(`/api/tree`)).json()).map((e) => e.path);
const readme = async (dir) => (await hub(`/api/file/schematics/${encodeURIComponent(dir)}/README.md`)).text();
const typeInto = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input')); })()`);
const fileInto = (sel, name, bytes, type) => ev(`(() => { const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([${[...bytes]}])], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  const el = document.querySelector(${JSON.stringify(sel)}); el.files = dt.files; el.dispatchEvent(new Event('change')); })()`);
const titles = SEED.schems.map((s) => s[0]);

check('top level in name order, schematics a real folder', await rows(), ['boards', 'docs', 'large', 'map art', 'notes', 'schematics', 'screenshots', 'README.md']);
// The Manager's button is in schematics/' folder bar (Paul, S56), not in the sidebar or
// other folders.
const manager = () => ev(`(() => { const b = [...document.querySelectorAll('#main-folder .shot-bar button')].find((b) => b.textContent === 'Schematic Manager'); return b ? b.checkVisibility() : null; })()`);
await ev(`location.hash = '#folder=screenshots'`);
await settle(800);
check('no Manager button in other folders, none in the sidebar', [await manager(), await ev(`!!document.getElementById('open-schems')`), await ev(`document.getElementById('side-foot').checkVisibility()`)], [false, false, false]);
await ev(`location.hash = '#folder=schematics'`);
await settle(800);
check('Manager button in schematics/ bar', await manager(), true);

// The board: big cards, newest first, built from the folders' READMEs.
await ev(`[...document.querySelectorAll('#main-folder .shot-bar button')].find((b) => b.textContent === 'Schematic Manager').click()`);
await settle(600);
check('board', [await hash(), await cards()], ['#schems', [...titles].reverse()]);
check('card: credit, description, date and file, render', await ev(`(() => { const c = document.querySelector('#main-schems .schem-card');
  return [c.querySelector('.schem-credit')?.textContent, c.querySelector('.schem-desc')?.textContent, c.querySelector('.schem-meta').textContent, !!c.querySelector('.schem-thumb img')]; })()`),
  ['Design by Paul', 'How to use Build 6.', '2026-07-06 · tnt duper.litematic', true]);
check('dragging a card links its folder', await ev(`(() => { const dt = new DataTransfer();
  document.querySelector('#main-schems .schem-card').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  return dt.getData('text/x-mt-path'); })()`), 'schematics/Build 6');
await shot('board');
const searchX = () => ev(`document.querySelector('.schem-bar input[type=search]').getBoundingClientRect().x`);
const x0 = await searchX();
await typeInto('.schem-bar input[type=search]', 'farm');
check('search (title, credit, description, file)', [await cards(), await ev(`document.querySelector('.schem-bar .count').textContent`), await searchX()], [['Build 3', 'Build 1'], '2 of 6', x0]);
await typeInto('.schem-bar input[type=search]', '');

// One post: the shared single-item bar, ←/→ along the board, Esc back.
await ev(`document.querySelector('#main-schems .schem-card').click()`);
await settle(300);
check('post', [await hash(), await ev(`document.querySelector('.schem-post h1').textContent`), await ev(`document.querySelector('.schem-bar').hidden`),
  await ev(`[...document.querySelectorAll('#main-schems .single-bar .vtool')].map((v) => v.title)`), await ev(`[...document.querySelectorAll('#main-schems .single-bar > button, #main-schems .single-actions > button')].map((b) => b.textContent)`)],
  ['#schem=Build 6', 'Build 6', true, ['Forward', 'Download', 'Move to Trash', 'Previous (←)', 'Next (→)', 'Full window'], ['← All schematics', 'Edit', 'Open folder']]);
await shot('post');
await key('ArrowRight');
await settle(200);
check('arrow steps to the next card', await hash(), '#schem=Build 5');
await key('Escape');
await settle(200);
check('Esc back to the board', await hash(), '#schems');

// In Files, schematics/ is a folder of post folders; a post's folder has Open post.
await ev(`document.querySelector('.row[data-path="schematics"]').click()`);
await settle(500);
check('schematics/ in the folder view', [await hash(), await ev(`[...document.querySelectorAll('#main-folder .shot')].length`)], ['#folder=schematics', SEED.schems.length]);
await ev(`document.querySelector('#main-folder .shot[data-path="schematics/Build 2"]').click()`);
await settle(400);
check('a post folder', [await ev(`[...document.querySelectorAll('#main-folder .shot')].map((t) => t.dataset.path.split('/').pop())`),
  await ev(`!document.querySelector('#main-folder .shot-bar button[title^="Open this post"]').hidden`)], [['1.png', 'README.md', 'sorter.litematic'], true]);
await ev(`document.querySelector('#main-folder .shot-bar button[title^="Open this post"]').click()`);
await settle(300);
check('Open post', await hash(), '#schem=Build 2');

// Editing the README in Files changes the card.
const rev = (await (await hub(`/api/stat/schematics/Build%202/README.md`)).json()).rev;
await fetch(`${HUB}/api/file/schematics/Build%202/README.md?base=${rev}`, { method: 'PUT', headers: { cookie: COOKIE.Paul }, body: '# Item Sorter\n\nDesign by Lennox · posted 2026-07-02\n\nSorts.\n' });
await settle(1500);
check('README edit shows on the post', [await ev(`document.querySelector('.schem-post h1').textContent`), await ev(`document.querySelector('.schem-post .schem-credit').textContent`)], ['Item Sorter', 'Design by Lennox']);

// New post: the post's page, empty and being edited; Post writes a folder (file, renders as
// 1.png…, README).
const barButton = (label) => ev(`[...document.querySelectorAll('#main-schems .single-actions > button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
const bar = () => ev(`[...document.querySelectorAll('#main-schems .single-actions > button')].map((b) => b.textContent + (b.classList.contains('primary') ? '*' : ''))`);
await ev(`[...document.querySelectorAll('.schem-bar button')].find((b) => b.textContent === 'New post').click()`);
await settle(300);
check('a new post is the page, being edited', [await ev(`document.querySelector('.schem-edit .schem-edit-title').value`), await bar(), await ev(`document.querySelector('#main-schems .single-name').textContent`)], ['', ['Post', 'Cancel'], 'New post']);
await fileInto('.schem-edit input[type=file][accept^=".litematic"]', 'Mob_Farm.litematic', Buffer.from('mob farm'), 'application/octet-stream');
check('title from the file name', [await ev(`document.querySelector('.schem-edit-title').value`), await bar()], ['Mob Farm', ['Post*', 'Cancel']]);
await typeInto('.schem-edit-credit', 'Flutter');
await typeInto('.schem-edit-desc', 'DO NOT ROTATE!');
await ev(`(() => { const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([${[...png(40, 20, [200, 0, 0])]}])], 'shot.png', { type: 'image/png' }));
  document.querySelector('.schem-edit').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
await settle(200);
await barButton('Post');
await settle(2500);
check('new post written', [(await tree()).filter((p) => p.startsWith('schematics/Mob Farm/')), await hash()],
  [['schematics/Mob Farm/1.png', 'schematics/Mob Farm/Mob_Farm.litematic', 'schematics/Mob Farm/README.md'], '#schem=Mob Farm']);
const today = await ev(`(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
check('its README', await readme('Mob Farm'), `# Mob Farm\n\nDesign by Flutter · posted ${today}\n\nDO NOT ROTATE!\n`);
await key('Escape');
await settle(300);
check('the new post is first on the board', (await cards())[0], 'Mob Farm');

// A title that's taken: offered as a new version in that post's folder.
await ev(`location.hash = '#schems'`);
await settle(300);
await answerDialogs(null); // this question is looked at, then answered by hand
await ev(`[...document.querySelectorAll('.schem-bar button')].find((b) => b.textContent === 'New post').click()`);
await settle(300);
await fileInto('.schem-edit input[type=file][accept^=".litematic"]', 'tnt duper v2.litematic', Buffer.from('v2'), 'application/octet-stream');
await typeInto('.schem-edit-title', 'build 6');
await barButton('Post');
await settle(300);
check('asks to add it as a version', await ev(`[document.querySelector('#dialog h2').textContent, document.querySelector('#dialog p').textContent]`), ['Add tnt duper v2.litematic to “Build 6”?', 'There’s already a post called “Build 6”. The file goes in it as a new version.']);
await ev(`document.querySelector('#dialog .primary').click()`);
await answerDialogs(true);
await settle(1500);
check('added to that folder', [(await tree()).filter((p) => p.startsWith('schematics/Build 6/')), await hash()],
  [['schematics/Build 6/1.png', 'schematics/Build 6/README.md', 'schematics/Build 6/tnt duper v2.litematic', 'schematics/Build 6/tnt duper.litematic'], '#schem=Build 6']);

// Edit is in place: the same page, the title in a box where it was, Save grey until
// something changes.
const pressEdit = () => ev(`[...document.querySelectorAll('#main-schems .single-actions > button')].find((b) => b.textContent === 'Edit').click()`);
// (Measured from the bar's bottom: in a narrow panel the bar's buttons take a second line in
// View, and Edit's two fit on one.)
const underBar = (sel) => `Math.round(document.querySelector('${sel}').getBoundingClientRect().y - document.querySelector('#main-schems .single-bar').getBoundingClientRect().bottom)`;
const titleY = await ev(underBar('.schem-post h1'));
await pressEdit();
await settle(300);
check('edits on the post\'s own page', [await ev(`document.querySelector('.schem-edit .schem-edit-title').value`),
  await ev(`Math.abs(${underBar('.schem-edit-title')} - ${titleY}) <= 6`),
  await ev(`document.querySelector('.schem-edit-desc').value`), await bar(), await hash()],
  ['Build 6', true, 'How to use Build 6.', ['Save', 'Cancel'], '#schem=Build 6']);
await shot('edit');
await typeInto('.schem-edit-desc', 'Changed.');
check('Save turns blue', await bar(), ['Save*', 'Cancel']);
// Cancel, or Back, with changes asks; saying no keeps them, yes drops them.
const question = () => ev(`document.querySelector('#dialog h2')?.textContent ?? null`);
const answer = (n) => ev(`document.querySelectorAll('#dialog .actions button')[${n}].click()`);
await answerDialogs(null);
await barButton('Cancel');
await settle(300);
check('Cancel asks', await question(), 'Discard your changes to “Build 6”?');
await answer(0);
await settle(300);
check('saying no keeps the edit', [await ev(`document.querySelector('.schem-edit-desc').value`), await bar()], ['Changed.', ['Save*', 'Cancel']]);
await ev(`document.querySelector('#main-schems .single-bar > button').click()`);
await settle(300);
check('Back asks too', await question(), 'Discard your changes to “Build 6”?');
await answer(1);
await settle(400);
check('discarding goes to the board, nothing written', [await hash(), await readme('Build 6')], ['#schems', '# Build 6\n\nDesign by Paul · posted 2026-07-06\n\nHow to use Build 6.\n']);
await answerDialogs(true);
await ev(`document.querySelector('.schem-card[data-dir="Build 6"]').click()`);
await settle(300);

// A new picture moved in front becomes 1.png; the old one moves to 2.png.
await pressEdit();
await settle(300);
await ev(`(() => { const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([${[...png(30, 30, [0, 200, 0])]}])], 'new.png', { type: 'image/png' }));
  document.querySelector('.schem-edit').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
await settle(200);
await ev(`document.querySelectorAll('.schem-edit-img')[1].querySelector('button').click()`);
await typeInto('.schem-edit-credit', 'Paul and Alex');
await barButton('Save');
await settle(2500);
const b6 = (await (await hub(`/api/schematics`)).json()).find((p) => p.dir === 'Build 6');
check('edit reorders the renders', b6.images.map((i) => [i.name, i.size]).map(([n, s]) => n + (s > 0)), ['1.pngtrue', '2.pngtrue']);
check('new picture is first', (await (await hub(`/api/file/schematics/Build%206/1.png`)).arrayBuffer()).byteLength, png(30, 30, [0, 200, 0]).length);
check('README keeps the date', await readme('Build 6'), '# Build 6\n\nDesign by Paul and Alex · posted 2026-07-06\n\nHow to use Build 6.\n');

// Move to Trash: the folder goes, with nothing asked.
await ev(`[...document.querySelectorAll('#main-schems .single-bar .vtool')].find((v) => v.title === 'Move to Trash').click()`);
await settle(1500);
check('delete removes the folder', [(await tree()).some((p) => p.startsWith('schematics/Build 6')), await hash()], [false, '#schems']);

// The board's Back goes to the schematics folder (where its button is); Esc does too.
check('New post sits by the search box', await ev(`[...document.querySelector('.schem-bar').children].map((c) => c.textContent || c.tagName).slice(-3, -1)`), ['New post', 'INPUT']);
check('the board has a Back button', await ev(`document.querySelector('.schem-bar > button').textContent`), '← Back to schematics/');
await ev(`document.querySelector('.schem-bar > button').click()`);
await settle(1200);
check('Back opens the schematics folder', [await hash(), await ev(`document.getElementById('main-schems').hidden`)], ['#folder=schematics', true]);
await ev(`[...document.querySelectorAll('#main-folder .shot-bar button')].find((b) => b.textContent === 'Schematic Manager').click()`);
await settle(400);
check('and its button comes back to the board', await hash(), '#schems');
await ev(`document.activeElement?.blur()`);
await key('Escape');
await settle(400);
check('Esc on the board goes to the folder', await hash(), '#folder=schematics');

await done();
