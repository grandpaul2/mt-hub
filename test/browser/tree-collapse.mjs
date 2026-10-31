// The tree closes the folders it opened itself (Paul, S98). Folders opened by hand (chevron, →,
// Enter) stay open and are kept per browser; folders the hub opened to show where the thing
// in the main panel is close once it shows something not inside them (another file or
// folder, a chat). Closing one of the hub's by hand and opening it again makes it yours. A
// folder a drag opened by hovering shuts when the drag ends; the folder a move lands in stays
// until the next navigation.
import { check, done, ev, HUB, send, settle } from './lib.mjs';

await send('Page.navigate', { url: HUB });
await settle(800);
await ev(`localStorage.setItem('mt-expanded', '[]')`);
await send('Page.reload');
await settle(1500);

const open = () => ev(`[...document.querySelectorAll('#tree .row.dir.open')].map((r) => r.dataset.path)`);
const saved = () => ev(`JSON.parse(localStorage.getItem('mt-expanded'))`);
const to = async (hash) => {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  await settle(700);
};
const chevron = async (p) => {
  await ev(`document.querySelector('#tree .row[data-path="${p}"] .twisty').click()`);
  await settle(200);
};
const ERC = 'boards/handheld-device/erc_outputs/ERC.rpt';

// A link (or search result) to a nested file opens its path, as the hub's: nothing saved.
await to('#' + ERC);
check('a nested file opens its path', [await open(), await saved()], [['boards', 'boards/handheld-device', 'boards/handheld-device/erc_outputs'], []]);
// docs, opened by hand, is yours.
await chevron('docs');
check('a chevron opens one as yours', [await open(), await saved()], [['boards', 'boards/handheld-device', 'boards/handheld-device/erc_outputs', 'docs'], ['docs']]);
// Another file elsewhere: the old path closes, the new one opens; yours stays.
await to('#notes/todo.md');
check('another file: the old path closes, yours stays', await open(), ['docs', 'notes']);
// A chat: the hub's all close.
await to('#chan=general');
check('a chat: the hub\'s close', await open(), ['docs']);
// A reload keeps yours, and rebuilds the path to the open file from the address.
await to('#notes/todo.md');
await send('Page.reload');
await settle(1800);
check('after a reload: yours, and the path to the open file', [await open(), await saved()], [['docs', 'notes'], ['docs']]);

// Closing one of the hub's by hand and opening it again makes it yours.
await to('#' + ERC);
await chevron('boards');
check('a chevron closes one of the hub\'s', (await open()).includes('boards'), false);
// …and it stays shut while the tree redraws (picking another row redraws it).
await ev(`document.querySelector('#tree .row[data-path="notes"]').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
await settle(300);
check('and stays shut through a redraw', (await open()).includes('boards'), false);
await chevron('boards');
await to('#notes/todo.md');
check('opened again by hand, it stays', [await open(), await saved()], [['boards', 'docs', 'notes'], ['docs', 'boards']]);
await chevron('boards');
await chevron('docs');

// #folder=…&item=… (Open folder from a chat's picture): the folder shown and the item's
// folder both open.
await to('#folder=boards/handheld-device&item=parts.md');
check('Open folder: the folder with the item open', await open(), ['boards', 'boards/handheld-device']);
// A folder in the folder view: its parents open, not the folder itself; leaving closes them.
await to('#folder=boards/handheld-device/erc_outputs');
check('a folder view: its parents open, not itself', await open(), ['boards', 'boards/handheld-device']);
await to('#chan=general');
check('and close on leaving', await open(), []);

// Review of S98: a chat between two looks at the same open file keeps its path; two Open
// folder links to one folder don't hold it open after; a #folder= address (and a reload)
// opens the path to the folder.
await to('#' + ERC);
await to('#chan=general');
await to('#' + ERC);
check('back from a chat to the same file: its path opens again', await open(), ['boards', 'boards/handheld-device', 'boards/handheld-device/erc_outputs']);
await to('#folder=boards/handheld-device&item=parts.md');
await to('#folder=boards/handheld-device&item=board.toml');
await to('#notes/todo.md');
check('two Open folder links, then elsewhere: nothing held open', await open(), ['notes']);
await to('#folder=boards/handheld-device/erc_outputs');
await send('Page.reload');
await settle(1800);
check('a #folder= address after a reload: the path to it', await open(), ['boards', 'boards/handheld-device']);
await to('#chan=general');

// A drag hovering over a closed folder opens it; when the drag ends it shuts again.
await ev(`(() => {
  window.__dt = new DataTransfer();
  document.querySelector('.row[data-path="README.md"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }));
  document.querySelector('.row[data-path="notes"]').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
})()`);
await settle(900);
check('a drag hovering opens a folder', await open(), ['notes']);
await ev(`document.querySelector('.row[data-path="README.md"]').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }))`);
await settle(300);
check('and it shuts when the drag ends', [await open(), await saved()], [[], []]);
// The drag's end can be lost (the tree redrew the row it started from): the first mouse move
// after it shuts them.
await ev(`(() => {
  const dt = new DataTransfer();
  document.querySelector('.row[data-path="README.md"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  document.querySelector('.row[data-path="notes"]').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
})()`);
await settle(900);
check('opened by a drag again', await open(), ['notes']);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 300 });
await settle(300);
check('a lost dragend: the next mouse move shuts it', await open(), []);
await ev(`(() => {
  window.__dt2 = new DataTransfer();
  document.querySelector('.row[data-path="README.md"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt2 }));
  document.querySelector('.row[data-path="notes"]').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt2 }));
})()`);
await settle(900);
check('the next drag over the same folder opens it again', await open(), ['notes']);
await ev(`document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt2 }))`);
await settle(300);

// A move: the folder things land in opens, and stays until the next navigation.
await ev(`(() => {
  const dt = new DataTransfer();
  document.querySelector('.row[data-path="README.md"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const dst = document.querySelector('.row[data-path="notes"]');
  dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
})()`);
await settle(900);
check('a move opens where it landed, as the hub\'s', [await open(), await saved()], [['notes'], []]);
await to('#docs/guide.md');
check('the next navigation closes it', await open(), ['docs']);

// An old saved list (both kinds mixed, before this change) all counts as yours.
await ev(`localStorage.setItem('mt-expanded', '["boards","boards/handheld-device"]')`);
await to('#chan=general');
await send('Page.reload');
await settle(1800);
check('an old saved list loads as yours', await open(), ['boards', 'boards/handheld-device']);
await to('#docs/guide.md');
await to('#chan=general');
check('and stays through navigation', await open(), ['boards', 'boards/handheld-device']);

await done();
