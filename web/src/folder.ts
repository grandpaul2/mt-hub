// The folder view: any workspace folder shown in the main panel as a grid of its folders and
// files, with one bar everywhere (title, count | New file, New folder, Upload, README, the
// search glass | search, sort, Size). Pictures and videos
// show as thumbnails, everything else as its file-tree icon. screenshots/ reads like a chat
// feed, oldest at the top and opening at the bottom; other
// folders are folders first, then by name. The glass slides the search box in and out (out also clears it). The Sort button sorts every folder by date
// instead, newest first (a folder's date is its newest file's). Clicking a file opens it (full size is a click
// further). Files named "<date> <time> <poster>" (screenshots, pasted pictures) show their
// poster and date, and a folder of them gets a Filters button that brings out who/from/to
// (and can't put them away while one is set). New File / New Folder
// name the new one in a tile, as the tree does in a row.
import { iconURL } from './icons';
import { ICON } from './viewer';
import { $, GLYPH, glyphs, baseName, date, dateTime, bytes, enc, go, h, load, showMenu, store, user, typing, thumbOr } from './util';

// mod: when a file last changed; a folder's is its newest file's, however deep.
export type FolderFile = { path: string; size: number; mod?: number; dir: boolean };
type Hooks = {
  list(dir: string): FolderFile[]; // the folder's own files and folders
  show(): void; // switch the main panel to the folder view
  open(dir: string): void; // open another folder (a subfolder tile)
  openFile(path: string): void;
  upload(files: File[], dir: string): void;
  post(dir: string): (() => void) | null; // a schematic post's folder: opens it in the Manager
  manager(): void; // open the Schematic Manager (from schematics/)
  make(path: string, folder: boolean): Promise<boolean>; // create it (false: it wasn't, a toast says why)
  menu(e: MouseEvent, path: string): void; // a tile's right-click menu (the tree's)
};

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO = /\.(mp3|ogg|wav|m4a|flac)$/i;
// Thumbnails are this wide on the server; bigger tiles load the original.
const THUMB_W = 640;

// isFeed: screenshots/, opened at the bottom (the newest), like a chat.
export const isFeed = (dir: string) => dir === 'screenshots';
// By date it reads like every other folder: newest at the top.
const feedNow = () => isFeed(dir) && sort === 'name';

// byName orders paths by name, numbers by value, and a name before its numbered copies
// ("x.png" before "x (2).png"; comparing whole names would put the space first).
const stem = (p: string) => p.replace(/\.[^./]+$/, '');
export const byName = (a: string, b: string) =>
  stem(a).localeCompare(stem(b), undefined, { numeric: true }) || a.localeCompare(b, undefined, { numeric: true });

// The sort is one choice for every folder, kept per browser: by name, or by date (newest first).
let sort: 'name' | 'date' = load('mt-folder-sort') === 'date' ? 'date' : 'name';

// folderOrder is the order a folder's files show in (also the order ←/→ step through):
// folders first, then by name (which for screenshots starts with the date) or by date.
export function folderOrder(_dir: string) {
  return (a: FolderFile, b: FolderFile) =>
    Number(b.dir) - Number(a.dir) || (sort === 'date' ? shownTime(b) - shownTime(a) : 0) || byName(a.path, b.path);
}

// A stamped name: "2026-07-10 18.52.58 eldridge.png", or "… eldridge (2).png" when several
// share the second.
const STAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2})\.(\d{2})\.(\d{2}) (.+?)(?: \(\d+\))?\.[^.]+$/;

// stamped reads a stamped name: who posted it and when (local time).
export function stamped(name: string): { who: string; day: string; t: Date } | null {
  const m = STAMP.exec(name);
  return m ? { who: m[5], day: m[1], t: new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`) } : null;
}

// shownTime is the date a tile shows, and what Date sorts by: a stamped name's, or when the
// file last changed.
const shownTime = (f: FolderFile) => (f.dir ? null : stamped(baseName(f.path)))?.t.getTime() ?? f.mod ?? 0;

// stampName names a picture by when it was taken and who posts it, numbered if that name
// is taken in the folder.
export function stampName(t: number, ext: string, taken: (name: string) => boolean) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())} ${user.name}`;
  if (!taken(base + ext)) return base + ext;
  for (let n = 2; ; n++) if (!taken(`${base} (${n})${ext}`)) return `${base} (${n})${ext}`;
}

let hooks: Hooks;
let dir = '';
// Back to the parent folder (a top-level folder has none: the tree is its parent).
const back = h('button', { title: 'Back to the parent folder (Esc)' });
const title = h('span', {});
const openPost = h('button', { title: 'Open this post in the Schematic Manager' }, 'Open post');
// schematics/ itself gets the Manager's button, where a screenshots folder has its filters.
const manager = h('button', { title: 'Open the Schematic Manager' }, 'Schematic Manager');
const count = h('span', { class: 'muted count' });
const search = h('input', { type: 'search', placeholder: 'Search names…', tabIndex: -1 });
// The search box is tucked away until the glass (the last of the bar's icon buttons) is
// clicked: the glass turns blue and the buttons slide left as the box comes in. A second
// click, or Esc in the box, slides it out again and clears it.
const searchSlot = h('span', { class: 'search-slot' }, search);
const glass = h('button', { class: 'vtool', title: 'Search names', innerHTML: ICON.search });
function showSearch(on: boolean) {
  searchSlot.classList.toggle('open', on);
  glass.setAttribute('aria-pressed', String(on));
  search.tabIndex = on ? 0 : -1;
  if (on) return search.focus({ preventScroll: true });
  search.blur();
  if (search.value) {
    search.value = '';
    render();
  }
}
// Who/from/to, for a folder of stamped names (hidden otherwise).
const who = h('select', { title: 'Who posted it' });
const from = h('input', { type: 'date', title: 'From (inclusive)' });
const to = h('input', { type: 'date', title: 'To (inclusive)' });
const clear = h('button', { title: 'Clear the filters' }, 'Clear');
const filters = h('span', { class: 'filters' }, who, h('label', {}, 'From ', from), h('label', {}, 'To ', to), clear);
// Filters brings them out, to its left, and puts them away again. While a filter is set they
// stay out (Clear is blue then: the way to put them away), so nothing is filtered unseen.
const filtersBtn = h('button', { class: 'filters-toggle' }, 'Filters');
let filtersOpen = false;
const filtered = () => !!(who.value || from.value || to.value);
// Reads "sort:name" or "sort:date" (the sort in use); a click opens the menu with both.
const sortBtn = h('button', { class: 'sort', title: 'Sort by' });
const size = h('input', { type: 'range', min: 120, max: 1200, step: 10, title: 'Tile size' });
const grid = h('div', { class: 'shot-grid folder-grid' });
const scroller = h('div', { class: 'shot-scroll' }, grid);
const picker = h('input', { type: 'file', multiple: true, hidden: true });
// README opens the folder's README; greyed out (still with its tooltip) when there's none.
const readme = h('button', { class: 'vtool', innerHTML: ICON.readme });

export const folderDir = () => dir;

// New File / New Folder: a tile with a name box, like the tree's (Enter or clicking away
// creates it, Esc cancels; a new file starts as ".md", left at just that it's a cancel).
// draft keeps what's typed across re-renders (live updates).
let creating: { folder: boolean; draft: string | null } | null = null;

export function startCreate(folder: boolean) {
  creating = { folder, draft: null };
  render();
  grid.querySelector('.creating')?.scrollIntoView({ block: 'nearest' });
}

function createTile() {
  const c = creating!;
  const box = h('input', { class: 'rename', value: c.draft ?? (c.folder ? '' : '.md'), spellcheck: false });
  const icon = h('img', { src: iconURL(box.value, c.folder, false), alt: '', draggable: false });
  box.oninput = () => {
    c.draft = box.value;
    icon.src = iconURL(box.value, c.folder, false);
  };
  let over = false;
  const finish = async (save: boolean) => {
    if (over || creating !== c) return;
    over = true;
    const name = save ? box.value.trim().replace(/^\/+|\/+$/g, '') : '';
    if (!name || (!c.folder && name === '.md')) {
      creating = null;
      return render();
    }
    const p = (dir ? dir + '/' : '') + name;
    if (!await hooks.make(p, c.folder)) {
      // Keep the box open with the name, so it can be fixed.
      creating = { folder: c.folder, draft: name };
      return render();
    }
    creating = null;
    render();
    grid.querySelector(`[data-path="${CSS.escape(p)}"]`)?.classList.add('flash');
  };
  box.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  };
  box.onclick = (ev) => ev.stopPropagation();
  // Blur saves, unless it's only a re-render swapping in a new box.
  box.onblur = () => setTimeout(() => {
    if (!(document.activeElement as HTMLElement | null)?.classList.contains('rename')) finish(true);
  });
  const fresh = c.draft === null;
  c.draft = box.value;
  // Focused once it's in the page: a fresh file box has the cursor before ".md".
  requestAnimationFrame(() => {
    box.focus({ preventScroll: true });
    if (fresh) box.setSelectionRange(0, c.folder ? 0 : Math.max(box.value.lastIndexOf('.'), 0));
  });
  return h('div', { class: 'shot creating' },
    h('div', { class: 'folder-icon' }, icon), h('div', { class: 'shot-meta' }, box));
}

export function setupFolder(h_: Hooks) {
  hooks = h_;
  const tool = (icon: string, title: string, fn: () => void) => {
    const b = h('button', { class: 'vtool', title, innerHTML: icon });
    b.onclick = fn;
    return b;
  };
  readme.onclick = () => readme.dataset.path && hooks.openFile(readme.dataset.path);
  const tools = h('div', { class: 'viewer-tools' },
    tool(ICON.filePlus, 'New file', () => startCreate(false)),
    tool(ICON.folderPlus, 'New folder', () => startCreate(true)),
    tool(ICON.upload, 'Upload files here (or drop them on the grid)', () => picker.click()),
    readme, glass);
  glass.onclick = () => showSearch(glass.getAttribute('aria-pressed') !== 'true');
  search.onkeydown = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    showSearch(false);
  };
  picker.onchange = () => {
    hooks.upload([...(picker.files ?? [])], dir);
    picker.value = '';
  };
  back.onclick = goUp;
  manager.onclick = () => hooks.manager();
  $('main-folder').append(h('div', { class: 'chat-head shot-bar' }, back, title, count, openPost, picker,
    h('span', { class: 'spacer' }), filters, filtersBtn, manager, tools, searchSlot, sortBtn,
    h('label', { class: 'size', title: 'Tile size' }, 'Size ', size)), scroller);
  search.oninput = () => render();
  const sortBy = (by: typeof sort) => () => {
    sort = by;
    store('mt-folder-sort', by);
    render();
    scroller.scrollTop = feedNow() ? scroller.scrollHeight : 0;
  };
  sortBtn.onclick = (e) => showMenu(e, [
    ['Name', sortBy('name'), '', '', { checked: sort === 'name' }],
    ['Date modified', sortBy('date'), '', '', { checked: sort === 'date' }],
  ], sortBtn);
  for (const el of [who, from, to]) el.onchange = () => render();
  clear.onclick = () => {
    who.value = from.value = to.value = search.value = '';
    render();
  };
  filtersBtn.onclick = () => {
    if (filtered()) return;
    filtersOpen = !filtersOpen;
    render();
  };
  // Ctrl+V while a folder shows puts the clipboard's pictures in it, named by when and who.
  document.addEventListener('paste', (e) => {
    if ($('main-folder').hidden || typing(e)) return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const names = new Set(hooks.list(dir).map((f) => baseName(f.path)));
    hooks.upload(files.map((f) => {
      const name = stampName(Date.now(), '.' + (f.type.split('/')[1] === 'jpeg' ? 'jpg' : f.type.split('/')[1]), (n) => names.has(n));
      names.add(name);
      return new File([f], name, { type: f.type });
    }), dir);
  });
  size.value = load('mt-folder-w') ?? '200';
  size.oninput = () => {
    store('mt-folder-w', size.value);
    sizeGrid();
  };
  // Esc goes up a folder, unless you're typing somewhere (the search, chat) or a menu is open.
  document.addEventListener('keydown', (e) => {
    // (defaultPrevented: the same Esc just brought you here from the Schematic Manager.)
    if (e.key !== 'Escape' || e.defaultPrevented || $('main-folder').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e)) return;
    if (goUp()) e.preventDefault();
  });
  scroller.ondragover = (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    scroller.classList.add('drop');
  };
  scroller.ondragleave = () => scroller.classList.remove('drop');
  scroller.ondrop = (e) => {
    scroller.classList.remove('drop');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    hooks.upload(files, dir);
  };
}

// openFolder shows a folder; item (a file name in it) is scrolled to and flashed.
export function openFolder(path: string, item = '') {
  const fresh = path !== dir;
  dir = path;
  if (fresh) creating = null;
  if (fresh) who.value = from.value = to.value = search.value = '';
  if (fresh) filtersOpen = false;
  hooks.show();
  render();
  go(`#folder=${enc(path)}${item ? '&item=' + encodeURIComponent(item) : ''}`);
  const tile = item && grid.querySelector<HTMLElement>(`[data-path="${CSS.escape(path + '/' + item)}"]`);
  requestAnimationFrame(() => {
    if (tile) {
      tile.scrollIntoView({ block: 'center' });
      tile.classList.add('flash');
    } else if (fresh) {
      scroller.scrollTop = feedNow() ? scroller.scrollHeight : 0;
    }
  });
}

// goUp opens the parent folder (a top-level folder's is Files, the top); false at the top.
function goUp() {
  if (!dir) return false;
  const parent = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
  hooks.open(parent);
  return true;
}

// refresh redraws after files changed, keeping the scroll position (or a feed's bottom).
export function refreshFolder() {
  const atBottom = feedNow() && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const top = scroller.scrollTop;
  render();
  scroller.scrollTop = atBottom ? scroller.scrollHeight : top;
}

// thumbSrc is a picture tile's image: the server thumbnail, or the original when the tile
// is wider than the thumbnail (GIFs always, so they keep moving).
function thumbSrc(f: FolderFile) {
  const big = Number(size.value) * devicePixelRatio > THUMB_W;
  return /\.gif$/i.test(f.path) || big ? `/api/file/${enc(f.path)}` : `/api/thumb/${enc(f.path)}?v=${f.mod}`;
}

// sizeGrid applies the slider: tile width, and thumbnail vs original per picture.
function sizeGrid() {
  grid.style.setProperty('--shot-w', `${size.value}px`);
  for (const img of grid.querySelectorAll<HTMLImageElement>('img.thumb')) {
    const src = thumbSrc({ path: img.dataset.path!, size: 0, mod: Number(img.dataset.mod), dir: false });
    if (img.getAttribute('src') !== src) img.src = src;
  }
}

function render() {
  title.textContent = dir ? dir + '/' : 'Files';
  sortBtn.textContent = sort === 'date' ? 'sort:date' : 'sort:name';
  const parent = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
  back.hidden = !dir;
  back.replaceChildren(...glyphs(parent ? `← Back to ${parent}/` : '← Back to Files'));
  const post = hooks.post(dir);
  openPost.hidden = !post;
  openPost.onclick = post;
  const all = hooks.list(dir);
  const rm = all.find((f) => !f.dir && /^readme(\.[^.]+)?$/i.test(baseName(f.path)));
  readme.dataset.path = rm?.path ?? '';
  readme.title = rm ? `Open ${baseName(rm.path)}` : 'No README here';
  readme.setAttribute('aria-disabled', String(!rm));
  // Who/from/to show when the folder has stamped names; the people are the posters in it.
  const stamps = all.map((f) => (f.dir ? null : stamped(baseName(f.path))));
  const stampedHere = stamps.some(Boolean);
  manager.hidden = dir !== 'schematics';
  const pick = who.value;
  const people = [...new Set(stamps.flatMap((st) => (st ? [st.who] : [])))].sort((a, b) => a.localeCompare(b));
  who.replaceChildren(h('option', { value: '' }, 'Everyone'), ...people.map((p) => h('option', { value: p, selected: p === pick }, p)));
  const on = filtered();
  filtersBtn.hidden = !stampedHere;
  filters.hidden = !stampedHere || !(filtersOpen || on);
  filtersBtn.setAttribute('aria-pressed', String(!filters.hidden));
  filtersBtn.setAttribute('aria-disabled', String(on));
  filtersBtn.title = on ? 'Clear the filters to hide them' : filters.hidden ? 'Show the filters' : 'Hide the filters';
  clear.classList.toggle('primary', on);
  const q = search.value.trim().toLowerCase();
  const fits = (f: FolderFile, st: ReturnType<typeof stamped>) => {
    if (q && !baseName(f.path).toLowerCase().includes(q)) return false;
    if (!who.value && !from.value && !to.value) return true;
    if (!st) return false;
    return (!who.value || st.who === who.value) && (!from.value || st.day >= from.value) && (!to.value || st.day <= to.value);
  };
  const shown = all.filter((f, i) => fits(f, stamps[i])).sort(folderOrder(dir));
  count.textContent = shown.length === all.length ? String(all.length) : `${shown.length} of ${all.length}`;
  grid.replaceChildren(...shown.map((f) => (f.dir ? folderTile(f) : fileTile(f))));
  // The new tile goes first among its kind (folders, then files).
  if (creating) grid.insertBefore(createTile(), creating.folder ? grid.firstChild : grid.children[shown.filter((f) => f.dir).length] ?? null);
  else if (!all.length) grid.append(h('div', { class: 'muted pad' }, 'Empty folder. Drop files here to upload them.'));
  else if (!shown.length) grid.append(h('div', { class: 'muted pad' }, 'Nothing found.'));
  sizeGrid();
}

function folderTile(f: FolderFile) {
  const name = baseName(f.path);
  const el = h('div', { class: 'shot', title: f.path },
    h('div', { class: 'folder-icon' }, h('img', { src: iconURL(f.path, true, false), alt: '', draggable: false })),
    h('div', { class: 'shot-meta' }, h('span', { class: 'who' }, name),
      // Sorted by date, a folder shows the date it's sorted by.
      sort === 'date' && f.mod ? h('span', { class: 'when' }, date(new Date(f.mod))) : ''));
  el.dataset.path = f.path;
  el.onclick = () => hooks.open(f.path);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    hooks.menu(e, f.path);
  };
  return el;
}

function fileTile(f: FolderFile) {
  const name = baseName(f.path);
  let media: HTMLElement;
  if (IMAGE.test(f.path)) {
    media = thumbOr(h('img', { class: 'thumb', loading: 'lazy', alt: name, draggable: false, src: thumbSrc(f) }), `/api/file/${enc(f.path)}`,
      () => h('div', { class: 'folder-icon' }, h('img', { src: iconURL(name, false, false), alt: '', draggable: false })));
    media.dataset.path = f.path;
    media.dataset.mod = String(f.mod ?? 0);
  } else if (VIDEO.test(f.path)) {
    media = h('div', { class: 'folder-video' }, h('video', { src: `/api/file/${enc(f.path)}#t=0.1`, preload: 'metadata', muted: true }), h('span', { class: 'play', innerHTML: GLYPH.play }));
  } else if (AUDIO.test(f.path)) {
    // A sound: its icon with the play mark a video has; a click opens it with a player.
    media = h('div', { class: 'folder-icon folder-audio' }, h('img', { src: iconURL(name, false, false), alt: '', draggable: false }), h('span', { class: 'play', innerHTML: GLYPH.play }));
  } else {
    media = h('div', { class: 'folder-icon' }, h('img', { src: iconURL(name, false, false), alt: '', draggable: false }));
  }
  // A stamped name shows as its poster and date and time; anything else as its name and date.
  const st = stamped(name);
  const t = st?.t ?? (f.mod ? new Date(f.mod) : null);
  const when = st ? dateTime(st.t) : t ? date(t) : '';
  const el = h('div', { class: 'shot', title: `${name} · ${bytes(f.size)}` }, media,
    h('div', { class: 'shot-meta' }, h('span', { class: 'who' }, st?.who ?? name), h('span', { class: 'when' }, when)));
  el.dataset.path = f.path;
  el.onclick = () => hooks.openFile(f.path);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    hooks.menu(e, f.path);
  };
  // Drag onto a chat to link it.
  el.draggable = true;
  el.ondragstart = (e) => e.dataTransfer?.setData('text/x-mt-path', f.path);
  return el;
}
