// The Schematic Manager: the schematics/ folder in Files shown as a board of big cards, a
// post per folder. A post's folder holds its schematic file(s), its renders (the first by
// name is the card picture: 1.png, 2.png…) and a README.md with the title, design credit,
// date and description (see internal/server/schematics.go). The board is built from the
// folders (/api/schematics), so anything changed in Files shows here too. A post is edited
// in place: Edit turns its own page into text boxes where the title, credit and description
// sit, with move and remove buttons on its pictures, and Save writes plain files. A new post
// is the same page, empty. Opened from the button in schematics/' folder bar.
import { marked } from 'marked';
import { $, ask, bytes, cleanHTML, GLYPH, glyphs, closeDialog, dialog, enc, fileURL, go, h, load, req, store, toast, toastError, typing, type Live, thumbOr } from './util';
import { openViewer, singleBar, viewerOpen } from './viewer';

type Item = { name: string; size: number; mod: number };
type Post = { dir: string; title: string; credit?: string; date: string; desc?: string; files: Item[]; images: Item[] };
type Hooks = {
  show(): void; // switch the main panel to the Manager
  shown(): boolean;
  forward(link: string): void; // post a link in a chat
  openFolder(path: string): void; // show a folder in Files (a post's, or schematics/ itself)
  changed(): void; // the posts changed (chat shows links to them as cards)
};

export const SCHEM_DIR = 'schematics';

let hooks: Hooks;
let posts: Post[] = []; // newest first, as the server sends them
let loaded = false;
// What the panel shows: the board, one post, or a post being edited ("form"; a new post
// when dir is '').
let view: { kind: 'list' } | { kind: 'post'; dir: string } | { kind: 'form'; dir: string } = { kind: 'list' };
let form: FormState | null = null;

// The edited post's pictures: ones already in the folder (by name) and new ones (files).
type Pic = { old: string; url: string } | { file: File; url: string };
// was: what it held when editing began (see snap), so Save knows when there's something to save.
type FormState = { title: string; credit: string; desc: string; pics: Pic[]; file: File | null; busy: boolean; was: string };
const snap = (f: Omit<FormState, 'was'>) => JSON.stringify([f.title, f.credit, f.desc, f.pics.map((p) => ('old' in p ? p.old : null)), !!f.file]);
const dirty = (f: FormState) => snap(f) !== f.was;

const search = h('input', { type: 'search', placeholder: 'Search…', title: 'Search title, credit, description, file' });
const count = h('span', { class: 'muted count' });
const height = h('input', { type: 'range', min: 90, max: 420, step: 10, title: 'Card height' });
const body = h('div', { class: 'schem-body' });
const head = h('div', { class: 'chat-head shot-bar schem-bar' }); // the board's bar: hidden on a post
const postBar = h('div', {}); // a post's own bar (the shared single-item bar)

const path = (p: Post, name = '') => `${SCHEM_DIR}/${p.dir}${name ? '/' + name : ''}`;
const imgURL = (p: Post, im: Item) => `/api/file/${enc(path(p, im.name))}?v=${im.mod}`;
const thumbURL = (p: Post, im: Item) => (/\.gif$/i.test(im.name) ? imgURL(p, im) : `/api/thumb/${enc(path(p, im.name))}?v=${im.mod}`);
const pathRef = (p: string) => (/[^\w./-]/.test(p) ? `#[${p}]` : `#${p}`);

export function setupSchems(events: Live, h_: Hooks) {
  hooks = h_;
  const add = h('button', { title: 'Post a schematic' }, 'New post');
  add.onclick = () => openForm('');
  // Back to the folder the board is a view of, where its button is.
  const back = h('button', { title: 'Back to the schematics folder (Esc)' }, ...glyphs(`← Back to ${SCHEM_DIR}/`));
  const toFolder = () => hooks.openFolder(SCHEM_DIR);
  back.onclick = toFolder;
  head.append(back, h('span', {}, 'Schematics'), count,
    h('span', { class: 'spacer' }), add, search, h('label', { class: 'size', title: 'Card height' }, 'Size ', height));
  $('main-schems').append(head, postBar, body);
  // A post: ←/→ for the previous/next one on the board, Esc back to the board; on the board,
  // Esc back to the folder. Not while typing, or while the full-window viewer has the keys;
  // the tree keeps its arrows.
  document.addEventListener('keydown', (e) => {
    if (!hooks.shown() || viewerOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (typing(e)) return;
    // Editing: only Esc, which is Cancel.
    if (view.kind === 'form') {
      if (e.key !== 'Escape') return;
      cancelForm();
      return e.preventDefault();
    }
    if (view.kind === 'list') {
      if (e.key !== 'Escape') return;
      toFolder();
      return e.preventDefault();
    }
    if (e.key !== 'Escape' && t.closest('#tree')) return;
    if (e.key === 'ArrowLeft') stepPost(view.dir, -1);
    else if (e.key === 'ArrowRight') stepPost(view.dir, 1);
    else if (e.key === 'Escape') backToBoard();
    else return;
    e.preventDefault();
  });
  height.value = load('mt-schem-h') ?? '150';
  sizeCards();
  height.oninput = () => {
    store('mt-schem-h', height.value);
    sizeCards();
  };
  search.oninput = () => {
    if (view.kind !== 'list') view = { kind: 'list' };
    render();
  };
  document.addEventListener('paste', (e) => {
    if (!hooks.shown() || view.kind !== 'form') return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addPics(files);
  });
  // Files changed (here, in Files, or over ssh): rebuild from the folders.
  events.addEventListener('files', () => refresh());
  events.addEventListener('open', () => refresh());
  refresh();
}

// openSchems shows the Manager: the board, or one post when dir is given.
export async function openSchems(dir = '') {
  hooks.show();
  if (!loaded) await refresh();
  // Coming back from elsewhere keeps a post being edited; another post asks first.
  if (view.kind === 'form' && (!dir || dir === view.dir || !await leaveForm())) return render();
  view = dir && posts.some((p) => p.dir === dir) ? { kind: 'post', dir } : { kind: 'list' };
  render();
}

// schemPost is a post's title, credit and file for a chat link to its folder; null if p
// isn't a post's folder.
export function schemPost(p: string) {
  const dir = p.startsWith(SCHEM_DIR + '/') ? p.slice(SCHEM_DIR.length + 1) : '';
  const post = dir && !dir.includes('/') ? posts.find((x) => x.dir === dir) : undefined;
  return post ? { dir: post.dir, title: post.title, credit: post.credit, file: post.files[0]?.name ?? '' } : null;
}

let lastJSON = '';
async function refresh() {
  const r = await req('GET', '/api/schematics').catch(() => null);
  if (!r?.ok) return;
  const text = await r.text();
  if (loaded && text === lastJSON) return;
  lastJSON = text;
  posts = JSON.parse(text);
  loaded = true;
  if (hooks.shown() && view.kind !== 'form') render();
  hooks.changed();
}

function render() {
  head.hidden = view.kind !== 'list';
  if (view.kind === 'list') postBar.replaceChildren();
  if (view.kind === 'post') renderPost(view.dir);
  else if (view.kind === 'form') renderForm();
  else renderList();
}

// ---- board ----

function matches(p: Post, words: string[]) {
  const hay = [p.title, p.credit, p.desc, ...p.files.map((f) => f.name)].join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

// shown is the board as listed: the posts matching the search, newest first.
function shown() {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  return posts.filter((p) => matches(p, words));
}

function renderList() {
  go('#schems');
  const list = shown();
  count.textContent = list.length === posts.length ? `${posts.length}` : `${list.length} of ${posts.length}`;
  const top = body.scrollTop;
  body.replaceChildren(...list.map(card));
  if (!list.length) body.append(h('div', { class: 'muted pad' },
    posts.length ? 'Nothing found.' : 'No schematics yet. Click New post to add one.'));
  body.scrollTop = top;
}

// card is a post on the board: title, credit, the start of its description, date and file,
// and its first render.
function card(p: Post) {
  const text = h('div', { class: 'schem-text' }, h('div', { class: 'schem-title' }, p.title));
  if (p.credit) text.append(h('div', { class: 'schem-credit' }, `Design by ${p.credit}`));
  if (p.desc) text.append(h('div', { class: 'schem-desc' }, p.desc));
  text.append(h('div', { class: 'schem-meta' }, [p.date, ...p.files.map((f) => f.name)].filter(Boolean).join(' · ')));
  const im = p.images[0];
  const pic = im
    ? h('div', { class: 'schem-thumb' }, thumbOr(h('img', { src: thumbURL(p, im), alt: '', loading: 'lazy', draggable: false }), imgURL(p, im), () => {
      pic.classList.add('none'); // not a picture after all: as if there were none
      return document.createTextNode('no render');
    }))
    : h('div', { class: 'schem-thumb none' }, 'no render');
  const el = h('div', { class: 'schem-card' }, text, pic);
  el.dataset.dir = p.dir;
  el.onclick = () => {
    view = { kind: 'post', dir: p.dir };
    render();
    body.scrollTop = 0;
  };
  // Drag a card onto a chat to link the post (its folder).
  el.draggable = true;
  el.ondragstart = (e) => e.dataTransfer?.setData('text/x-mt-path', path(p));
  return el;
}

// sizeCards applies the slider: card height, render size, and how many description lines fit.
function sizeCards() {
  const ch = Number(height.value);
  const s = body.style;
  s.setProperty('--card-h', `${ch}px`);
  s.setProperty('--thumb-w', `${Math.round((ch - 24) * 16 / 9)}px`);
  // title + credit + meta take about 70px; a description line is about 19px.
  s.setProperty('--desc-lines', String(Math.max(1, Math.floor((ch - 24 - 70) / 19))));
}

// ---- one post ----

function renderPost(dir: string) {
  const p = posts.find((x) => x.dir === dir);
  if (!p) {
    view = { kind: 'list' };
    return renderList();
  }
  go('#schem=' + encodeURIComponent(p.dir));
  const list = listed(p.dir);
  const i = list.findIndex((x) => x.dir === p.dir);
  const pictures = () => p.images.map((im, n) => ({
    src: imgURL(p, im), name: `${p.title} ${n + 1}`, when: p.date,
    forward: () => hooks.forward(pathRef(path(p))),
  }));
  const folder = h('button', { title: 'Show the folder in Files' }, 'Open folder');
  folder.onclick = () => hooks.openFolder(path(p));
  const file = p.files[0];
  postBar.replaceChildren(singleBar({
    back: { label: '← All schematics', title: 'Back to the board (Esc)', go: backToBoard },
    name: p.title,
    info: p.date,
    prev: i > 0 ? () => stepPost(p.dir, -1) : null,
    next: i < list.length - 1 ? () => stepPost(p.dir, 1) : null,
    zoom: p.images.length ? () => openViewer(pictures(), 0) : undefined,
    forward: () => hooks.forward(pathRef(path(p))),
    download: file ? { href: fileURL(path(p, file.name), '', true), name: file.name } : undefined,
    edit: () => openForm(p.dir),
    del: async () => {
      if (!await ask({ title: `Delete “${p.title}”?`, body: `Its folder (${path(p)}/) goes too. Its files stay in the hub’s history.`, confirm: 'Delete', danger: true })) return;
      const r = await req('DELETE', `/api/file/${enc(path(p))}?dir=1`);
      if (!r.ok) return toastError(`Couldn’t delete the post: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
      backToBoard();
      refresh();
    },
    extra: [folder],
  }));
  // Every schematic file, each downloadable (the bar's button is the first).
  const files = h('div', { class: 'schem-meta' }, ...p.files.flatMap((f, n) => [
    n ? ' · ' : '', h('a', { href: fileURL(path(p, f.name), '', true), download: f.name }, f.name), ` (${bytes(f.size)})`]));
  const desc = h('div', { class: 'schem-full-desc markdown' });
  desc.replaceChildren(cleanHTML(marked.parse(p.desc ?? '', { async: false, gfm: true, breaks: true })));
  const page = h('div', { class: 'schem-post' },
    h('h1', {}, p.title),
    p.credit ? h('div', { class: 'schem-credit' }, `Design by ${p.credit}`) : '',
    h('div', { class: 'schem-meta' }, `Posted ${p.date}`),
    files,
    desc,
    h('div', { class: 'schem-images' }, ...p.images.map((im, n) => {
      const a = h('a', { href: imgURL(p, im), title: 'Full size' }, h('img', { src: imgURL(p, im), alt: '', loading: 'lazy' }));
      a.onclick = (e) => {
        e.preventDefault();
        openViewer(pictures(), n);
      };
      return a;
    })));
  body.replaceChildren(page);
}

// listed is the board order a post steps through: the search's results if it's among
// them, else every post.
function listed(dir: string) {
  const list = shown();
  return list.some((x) => x.dir === dir) ? list : posts;
}

function stepPost(dir: string, d: number) {
  const list = listed(dir);
  const next = list[list.findIndex((x) => x.dir === dir) + d];
  if (!next) return;
  view = { kind: 'post', dir: next.dir };
  render();
  body.scrollTop = 0;
}

function backToBoard() {
  view = { kind: 'list' };
  render();
}

// ---- editing a post in place (and a new post) ----

function openForm(dir: string) {
  const p = posts.find((x) => x.dir === dir);
  const f = p
    ? { title: p.title, credit: p.credit ?? '', desc: p.desc ?? '', file: null, busy: false,
      pics: p.images.map((im) => ({ old: im.name, url: imgURL(p, im) })) }
    : { title: '', credit: '', desc: '', pics: [], file: null, busy: false };
  form = { ...f, was: snap(f) };
  view = { kind: 'form', dir };
  render();
  if (!p) body.scrollTop = 0;
}

// leaveForm ends the editing, asking first when something would be lost; false to stay.
async function leaveForm() {
  if (view.kind !== 'form' || !form) return true;
  if (form.busy) return false;
  const p = posts.find((x) => x.dir === (view as { dir: string }).dir);
  if (dirty(form) && !await ask({
    title: p ? `Discard your changes to “${p.title}”?` : 'Discard this new post?',
    body: 'Your unsaved changes will be lost. This can’t be undone.', confirm: 'Discard', danger: true,
  })) return false;
  form = null;
  return true;
}

// cancelForm is Cancel (and Esc): back to the post as it was, or to the board from a new one.
async function cancelForm() {
  if (view.kind !== 'form') return;
  const dir = view.dir;
  if (!await leaveForm()) return;
  view = dir && posts.some((x) => x.dir === dir) ? { kind: 'post', dir } : { kind: 'list' };
  render();
}

// The post's page with its parts as text boxes and its pictures with their buttons: the
// same layout as renderPost, so nothing jumps between reading and editing.
function renderForm() {
  if (view.kind !== 'form' || !form) return;
  const f = form;
  const dir = view.dir;
  const editing = posts.find((x) => x.dir === dir);
  go(editing ? '#schem=' + encodeURIComponent(editing.dir) : '#schems');

  // The bar: Save (blue once there's something to save) and Cancel, as for a text file.
  const save = h('button', { disabled: f.busy }, editing ? 'Save' : 'Post');
  save.onclick = () => submit(editing);
  const cancel = h('button', { disabled: f.busy }, 'Cancel');
  cancel.onclick = cancelForm;
  const mark = () => save.classList.toggle('primary', dirty(f));
  mark();
  postBar.replaceChildren(singleBar({
    back: { label: '← All schematics', title: 'Back to the board', go: async () => {
      if (await leaveForm()) backToBoard();
    } },
    name: editing ? editing.title : 'New post',
    info: editing ? 'Editing' : '',
    extra: [save, cancel],
  }));

  const title = h('input', { class: 'schem-edit-title', value: f.title, maxLength: 200, placeholder: 'Title' });
  title.oninput = () => {
    f.title = title.value;
    mark();
  };
  const credit = h('input', { class: 'schem-edit-credit', value: f.credit, maxLength: 200, placeholder: 'who designed it (leave empty if you did)' });
  credit.oninput = () => {
    f.credit = credit.value;
    mark();
  };
  const desc = h('textarea', { class: 'schem-edit-desc', value: f.desc, rows: 4, maxLength: 8000, placeholder: 'Description: how to use it, warnings (DO NOT ROTATE!), materials…' });
  // As tall as its text, like the description it stands in for.
  const grow = () => {
    desc.style.height = 'auto';
    desc.style.height = `${desc.scrollHeight + 2}px`;
  };
  desc.oninput = () => {
    f.desc = desc.value;
    grow();
    mark();
  };

  // The file line: the files already here, and one to add (a same-named one replaces).
  const input = h('input', { type: 'file', accept: '.litematic,.schem,.schematic,.nbt', hidden: true });
  input.onchange = () => {
    f.file = input.files?.[0] ?? null;
    if (f.file && !f.title.trim()) f.title = f.file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    renderForm();
  };
  const pick = h('button', { type: 'button', title: editing ? 'A file with the same name as one here replaces it (the old one stays in its history)' : 'The schematic to post' },
    editing ? 'Add or replace file' : 'Choose schematic file');
  pick.onclick = () => input.click();
  const replaces = !!f.file && !!editing?.files.some((x) => x.name === f.file!.name);
  const files = h('div', { class: 'schem-meta schem-edit-file' },
    editing?.files.length ? h('span', {}, editing.files.map((x) => `${x.name} (${bytes(x.size)})`).join(' · ')) : '',
    pick, input,
    f.file ? h('span', { class: 'schem-picked' }, `${replaces ? 'Replacing with' : editing ? 'Adding' : ''} ${f.file.name} (${bytes(f.file.size)})`.trim()) : '');

  const imgs = h('div', { class: 'schem-images' }, ...f.pics.map((pic, i) => {
    const up = h('button', { title: 'Move up (the first picture is the card picture)', disabled: i === 0, innerHTML: GLYPH.up });
    up.onclick = () => move(i, -1);
    const down = h('button', { title: 'Move down', disabled: i === f.pics.length - 1, innerHTML: GLYPH.down });
    down.onclick = () => move(i, 1);
    const rm = h('button', { title: 'Remove', innerHTML: GLYPH.close });
    rm.onclick = () => {
      f.pics.splice(i, 1);
      renderForm();
    };
    return h('div', { class: 'schem-edit-img' }, h('img', { src: pic.url, alt: '' }),
      h('div', { class: 'schem-img-tools' }, i === 0 ? h('span', {}, 'Card picture') : '', up, down, rm));
  }));
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  picker.onchange = () => {
    addPics([...(picker.files ?? [])]);
    picker.value = '';
  };
  const addBtn = h('button', { type: 'button', class: 'schem-add-pic' }, h('span', {}, 'Add pictures'),
    h('span', { class: 'muted' }, 'or drop them here, or paste with Ctrl+V. The first one is the card picture.'));
  addBtn.onclick = () => picker.click();
  imgs.append(addBtn, picker);

  const page = h('div', { class: 'schem-post schem-edit' },
    title,
    h('div', { class: 'schem-credit schem-edit-by' }, 'Design by ', credit),
    h('div', { class: 'schem-meta' }, `Posted ${editing?.date ?? today()}`),
    files,
    desc,
    imgs);
  page.ondragover = (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };
  page.ondrop = (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((x) => x.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addPics(files);
  };
  const top = body.scrollTop;
  body.replaceChildren(page);
  body.scrollTop = top;
  grow();
}

function move(i: number, d: number) {
  const p = form!.pics;
  [p[i], p[i + d]] = [p[i + d], p[i]];
  renderForm();
}

function addPics(files: File[]) {
  if (!form) return;
  for (const file of files.filter((x) => x.type.startsWith('image/'))) form.pics.push({ file, url: URL.createObjectURL(file) });
  renderForm();
}

// ---- writing the folder ----

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// readme is the README.md the board reads a post from.
function readme(title: string, credit: string, date: string, desc: string) {
  const meta = credit.trim() ? `Design by ${credit.trim()} · posted ${date}` : `Posted ${date}`;
  return `# ${title.trim()}\n\n${meta}\n${desc.trim() ? '\n' + desc.trim() + '\n' : ''}`;
}

// rev is a file's current revision, '' if it isn't there (so a PUT creates it).
async function rev(p: string) {
  const r = await req('GET', `/api/stat/${enc(p)}`);
  return r.ok ? ((await r.json()).rev as string) : '';
}

// put writes a file, replacing what's there (its history keeps the old one).
async function put(p: string, body: Blob | string) {
  const r = await req('PUT', `/api/file/${enc(p)}?base=${await rev(p)}`, body);
  if (!r.ok) throw new Error(`${p}: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
}

async function mv(from: string, to: string) {
  const r = await req('POST', '/api/move', JSON.stringify({ from, to }));
  if (!r.ok) throw new Error(`${from}: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
}

const extOf = (name: string) => (/\.[^.]+$/.exec(name)?.[0] ?? '.png').toLowerCase();

// writePics makes the folder's pictures the form's, in order: 1.png, 2.jpg… Pictures
// already there that move are parked under temporary names first, so none overwrites another.
async function writePics(dir: string, pics: Pic[], before: Item[]) {
  const keep = new Set(pics.flatMap((p) => ('old' in p ? [p.old] : [])));
  for (const im of before) {
    if (keep.has(im.name)) continue;
    const r = await req('DELETE', `/api/file/${enc(`${dir}/${im.name}`)}?base=${await rev(`${dir}/${im.name}`)}`);
    if (!r.ok) throw new Error(`${im.name}: could not delete`);
  }
  const target = pics.map((p, i) => `${i + 1}${extOf('old' in p ? p.old : p.file.name)}`);
  const parked = new Map<number, string>();
  for (const [i, p] of pics.entries()) {
    if (!('old' in p) || p.old === target[i]) continue;
    const tmp = `moving-${Date.now()}-${i}${extOf(p.old)}`;
    await mv(`${dir}/${p.old}`, `${dir}/${tmp}`);
    parked.set(i, tmp);
  }
  for (const [i, p] of pics.entries()) {
    if ('old' in p) {
      if (parked.has(i)) await mv(`${dir}/${parked.get(i)}`, `${dir}/${target[i]}`);
    } else {
      await put(`${dir}/${target[i]}`, p.file);
    }
  }
}

// folderName turns a title into a folder name: no slashes, no leading dots.
// folderName is a post's folder, from its title: no slashes, control characters or leading
// dots, and at most 200 bytes (a name can't pass 255; the title itself is kept whole in the
// README).
function folderName(title: string) {
  let name = '';
  for (const ch of title.trim().replace(/[/\\]/g, '-').replace(/\p{Cc}/gu, '').replace(/^\.+/, '')) {
    if (new TextEncoder().encode(name + ch).length > 200) break;
    name += ch;
  }
  return name.trim();
}

async function submit(editing: Post | undefined) {
  if (view.kind !== 'form' || !form || form.busy) return;
  const f = form;
  if (!editing && !f.file) return toastError('Pick the schematic file first.');
  if (!f.title.trim()) return toastError('A post needs a title.');
  if (!/[\p{L}\p{N}]/u.test(folderName(f.title))) return toastError('Pick a title with letters or numbers.');
  if (!editing) {
    // A title that's taken: offer the file to that post as a new version instead.
    const other = posts.find((p) => p.dir.toLowerCase() === folderName(f.title).toLowerCase());
    if (other) {
      const same = other.files.some((x) => x.name === f.file!.name);
      if (!(await ask({ title: `Add ${f.file!.name} to “${other.title}”?`,
        body: `There’s already a post called “${other.title}”. The file goes in it as a new version.${same ? ' It replaces the file of the same name; the old one stays in its history.' : ''}`,
        confirm: 'Add it' }))) return;
      return write(f, () => put(path(other, f.file!.name), f.file!), other.dir, `Added to "${other.title}"`);
    }
  }
  const dir = editing?.dir ?? folderName(f.title);
  const full = `${SCHEM_DIR}/${dir}`;
  await write(f, async () => {
    if (f.file) await put(`${full}/${f.file.name}`, f.file);
    await writePics(full, f.pics, editing?.images ?? []);
    await put(`${full}/README.md`, readme(f.title, f.credit, editing?.date ?? today(), f.desc));
  }, dir, editing ? 'Saved' : 'Posted');
}

// write runs the edit's writes, then shows the post.
async function write(f: FormState, run: () => Promise<void>, dir: string, done: string) {
  f.busy = true;
  renderForm();
  try {
    await run();
  } catch (e) {
    f.busy = false;
    toastError(`Couldn’t save the post: ${(e as Error).message}.`);
    renderForm();
    return;
  }
  form = null;
  toast(done);
  await refresh();
  view = { kind: 'post', dir };
  render();
}
