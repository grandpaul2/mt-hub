// The full-window viewer and folder previews: a folder of pictures opens a grid like the
// screenshots gallery, whose tiles open the single-file preview; pictures open the viewer
// (zoom, forward, download, new tab, close), with "Open folder" only when opened from a chat,
// which lands on the file in its folder, and "Save to Files…" for a picture posted in chat.
import { api, check, COOKIE, done, ev, HUB, hub, key, png, send, settle, shot } from './lib.mjs';

const putFile = (p, body) => fetch(`${HUB}/api/file/${p}?base=`, { method: 'PUT', headers: { cookie: COOKIE.Paul }, body });
await putFile('pics/a.png', png(400, 300, [200, 60, 60]));
await settle(50);
await putFile('pics/b.png', png(1600, 1200, [60, 60, 200])); // bigger than the window: zoom shows it at full size
await settle(50);
await putFile('pics/clip.mp4', 'not really a video');
await api('POST', '/api/channels/general/messages', { text: 'look #pics/b.png' });

await send('Page.navigate', { url: HUB });
await settle(500);
await ev(`localStorage.setItem('mt-expanded','[]'); localStorage.setItem('mt-chat-hidden','1')`);
await send('Page.navigate', { url: `${HUB}/?r=1` });
await settle(2000);
const hash = () => ev(`decodeURIComponent(location.hash)`);
const viewer = () => ev(`document.getElementById('viewer')?.hidden === false ? {
  who: document.querySelector('.viewer-who').textContent, when: document.querySelector('.viewer-when').textContent,
  src: document.querySelector('.viewer-stage img, .viewer-stage video').getAttribute('src'),
  tools: [...document.querySelectorAll('#viewer .viewer-tools .vtool')].map((b) => b.title) } : null`);

// The folder row opens its preview (the chevron only expands).
await ev(`document.querySelector('.row[data-path="pics"]').click()`);
await settle(600);
check('folder preview', [await hash(), await ev(`document.querySelector('#main-folder .shot-bar > span').textContent`),
  await ev(`[...document.querySelectorAll('#main-folder .shot')].map((t) => t.dataset.path.slice(5))`),
  await ev(`document.querySelector('.row[data-path="pics"]').classList.contains('active')`)],
  ['#folder=pics', 'pics/', ['a.png', 'b.png', 'clip.mp4'], true]);
// ← is drawn as an icon: our fonts don't have it, and the system font standing in made the
// button taller with its text lower in Firefox (S56).
check('back arrow is an icon, text unchanged', await ev(`(() => { const b = document.querySelector('#main-folder .shot-bar > button'); return [!!b.querySelector('.glyph svg'), b.textContent, b.innerText.includes('←')]; })()`),
  [true, '← Back to Files', false]);
check('row click doesn’t expand', await ev(`document.querySelector('.row[data-path="pics"]').classList.contains('open')`), false);
check('thumbnails + video tile', await ev(`[document.querySelector('#main-folder .shot img').getAttribute('src').startsWith('/api/thumb/pics/a.png'), !!document.querySelector('#main-folder .folder-video video')]`), [true, true]);
await shot('folder');

// A tile opens the single-file preview (with its way back); full size is a click further.
await ev(`document.querySelector('#main-folder .shot').click()`);
await settle(800);
check('tile → single file preview', [await hash(), await viewer(), await ev(`!!document.querySelector('#view .image img')`)], ['#pics/a.png', null, true]);
await ev(`document.querySelector('#view .image img').click()`);
await settle(400);
let v = await viewer();
check('picture → viewer, no "Open folder" from here', [v?.who, v?.src, v?.tools],
  ['a.png', '/api/file/pics/a.png', ['Zoom in', 'Forward', 'Download', 'Open in new tab']]);
check('download link', await ev(`(() => { const a = document.querySelector('#viewer .viewer-tools a'); return [a.getAttribute('href'), a.getAttribute('download')]; })()`), ['/api/file/pics/a.png', 'a.png']);
check('darkens everything, fills the window', await ev(`(() => { const r = document.querySelector('.viewer-stage').getBoundingClientRect();
  return [getComputedStyle(document.getElementById('viewer')).backgroundColor, Math.round(r.width) >= innerWidth - 40, Math.round(r.height) >= innerHeight - 80]; })()`),
  ['rgba(0, 0, 0, 0.86)', true, true]);
await shot('viewer');

// Forward from the viewer posts a link in the chat you pick.
await ev(`[...document.querySelectorAll('#viewer .viewer-tools .vtool')].find((b) => b.title === 'Forward').click()`);
await settle(300);
check('viewer closed, picker open', [await viewer(), await ev(`document.querySelector('#dialog h2')?.textContent`)], [null, 'Forward to']);
await ev(`document.querySelector('#dialog .fwd-chan').click(); document.querySelector('#dialog .actions .primary').click()`);
await settle(800);
check('forwarded as a link', (await (await hub(`/api/channels/general/messages`)).json()).pop().text, '#pics/a.png');

// Zoom: full size, scrollable; again returns.
await ev(`location.hash = '#pics/b.png'`);
await settle(1000);
await ev(`document.querySelector('#view .image img').click()`);
await settle(300);
await ev(`document.querySelector('#viewer .viewer-tools [title="Zoom in"]').click()`);
await settle(400);
check('zoomed to full size', await ev(`(() => { const s = document.querySelector('.viewer-stage'); const i = s.querySelector('img');
  return [s.classList.contains('zoomed'), i.offsetWidth, s.scrollWidth > s.clientWidth]; })()`), [true, 1600, true]);
await ev(`document.querySelector('#viewer .viewer-tools [title="Zoom out"]').click()`);
check('zoomed out', await ev(`document.querySelector('.viewer-stage').classList.contains('zoomed')`), false);
await key('Escape');

// A video tile opens the file, which plays.
await ev(`location.hash = '#folder=pics'`);
await settle(800);
await ev(`document.querySelector('#main-folder .shot[data-path="pics/clip.mp4"]').click()`);
await settle(800);
check('video tile → file view player', [await hash(), await ev(`!!document.querySelector('#view video[controls]')`)], ['#pics/clip.mp4', true]);
check('video fits the panel', await ev(`getComputedStyle(document.querySelector('#view video')).maxWidth`), '100%');

// From chat: the poster and time, and "Open folder", which lands on the file in its folder.
await ev(`location.hash = '#chan=general'`);
await settle(1200);
await ev(`document.querySelector('#main-chat .ref-pic').click()`);
await settle(400);
v = await viewer();
check('viewer from chat', [v?.who, v?.src, v?.tools.at(-1)], ['Alex', '/api/file/pics/b.png', 'Open folder']);
await ev(`document.querySelector('#viewer .viewer-tools [title="Open folder"]').click()`);
await settle(1000);
check('open folder: the file’s single preview, shown in the tree', [await hash(), await ev(`!!document.querySelector('#view .image img')`),
  await ev(`document.querySelector('#toolbar button')?.textContent`),
  await ev(`document.querySelector('.row[data-path="pics/b.png"]')?.classList.contains('active') ?? 'not shown'`), await viewer()],
  ['#pics/b.png', true, '← Back to pics/', true, null]);

// A picture posted in chat: from the chat's own store, with Save to Files… instead.
const posted = (await (await fetch(`${HUB}/api/channels/general/media?name=c.png`, { method: 'POST', headers: { cookie: COOKIE.Alex }, body: png(300, 200, [60, 200, 60]) })).json()).path;
await api('POST', '/api/channels/general/messages', { text: `#${posted}` });
await ev(`location.hash = '#chan=general'`);
await settle(1500);
await ev(`[...document.querySelectorAll('#main-chat .ref-pic')].at(-1).click()`);
await settle(400);
v = await viewer();
check('posted picture: its own store, Save to Files…', [v?.src, v?.tools.includes('Open folder'), v?.tools.at(-1)], ['/api/channels/general/media/c.png', false, 'Save to Files…']);
check('posted picture: a thumbnail in chat', await ev(`[...document.querySelectorAll('#main-chat .ref-pic img')].at(-1).getAttribute('src')`), '/api/channels/general/thumb/c.png');
await key('Escape');
await ev(`location.hash = '#folder=pics'`);
await settle(800);

// Clicking the dark area closes; a picture file opened from the tree opens it too.
await ev(`document.querySelector('#main-folder .shot').click()`);
await settle(800);
await ev(`document.querySelector('#view .image img').click()`);
await settle(300);
await ev(`document.getElementById('viewer').click()`);
check('dark area closes', await viewer(), null);
await ev(`document.querySelector('.row[data-path="pics/a.png"]').click()`);
await settle(800);
await ev(`document.querySelector('#view .image img').click()`);
await settle(300);
check('file view → viewer', [(await viewer())?.src.startsWith('/api/file/pics/a.png'), (await viewer())?.tools.includes('Open folder')], [true, false]);
await key('Escape');

// A picture file gets the shared single-item bar: back, name, previous/next through its
// folder, and the viewer's buttons plus Delete.
check('file toolbar buttons', await ev(`[[...document.querySelectorAll('#toolbar .single-bar > button, #toolbar .single-actions > button')].map((b) => b.textContent),
  document.querySelector('#toolbar .single-name').textContent,
  [...document.querySelectorAll('#toolbar .single-bar .vtool')].map((b) => b.title)]`),
  [['← Back to pics/', 'History'], 'a.png', ['Previous (←)', 'Next (→)', 'Full window', 'Forward', 'Download', 'Open in new tab', 'Delete', 'More']]);
// Delete sits with the others and turns red only on hover, as in chat (Paul, S56); ⋯ lists
// the same actions.
check('Delete is quiet until hovered', await ev(`(() => { const b = document.querySelector('#toolbar [title="Delete"]');
  return [getComputedStyle(b).backgroundColor, b.classList.contains('danger')]; })()`), ['rgba(0, 0, 0, 0)', false]);
await ev(`document.querySelector('#toolbar [title="More"]').click()`);
await settle(200);
check('⋯ lists the same actions', await ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent + (b.classList.contains('danger') ? '!' : ''))`),
  ['Full Window', 'Forward…', 'Download', 'Open in New Tab', 'Delete!']);
await ev(`document.querySelector('#toolbar [title="More"]').click()`);
check('⋯ again closes it', await ev(`document.getElementById('menu').hidden`), true);
await shot('file-toolbar', { x: 260, y: 34, width: 940, height: 120 });
await ev(`document.querySelector('#toolbar [title="Full window"]').click()`);
await settle(400);
check('full window opens the viewer on the folder, at this file', (await viewer())?.src.startsWith('/api/file/pics/a.png'), true);
await key('Escape');
const fileShown = () => ev(`document.querySelector('#toolbar .single-name')?.textContent`);
const before = await fileShown();
await key('ArrowRight');
await settle(600);
const after = await fileShown();
await key('ArrowLeft');
await settle(600);
check('arrows step through the folder', [after !== before, await fileShown()], [true, before]);
await ev(`document.querySelector('#toolbar [title="Back to the folder (Esc)"]').click()`);
await settle(500);
check('back to the folder preview', [await hash(), await ev(`document.getElementById('main-folder').hidden`)], ['#folder=pics', false]);
await fetch(`${HUB}/api/file/notes.txt?base=`, { method: 'PUT', headers: { cookie: COOKIE.Paul }, body: 'hi' });
await ev(`location.hash = '#notes.txt'`);
await settle(1200);
// A text file has the same bar, with Edit, History and its text size.
check('text files: the same bar', await ev(`[[...document.querySelectorAll('#toolbar .single-bar > button, #toolbar .single-actions > button, #toolbar .mode-switch button')].filter((b) => getComputedStyle(b).visibility === 'visible').map((b) => b.textContent),
  document.querySelector('#toolbar .single-name').textContent, [...document.querySelectorAll('#toolbar .single-bar .vtool')].map((b) => b.title)]`),
  [['Edit', 'History'], 'notes.txt', ['Smaller text', 'Bigger text', 'Forward', 'Download', 'Open in new tab', 'Delete', 'More']]);

await done();
