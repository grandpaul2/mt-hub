import type * as M from 'monaco-editor';
import { marked } from 'marked';
// Our own fonts (SIL Open Font License), bundled and served by the hub: see style.css.
import '@fontsource-variable/noto-sans/wght.css';
import '@fontsource-variable/noto-sans/wght-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';
import {
  cleanHTML,
  $, GLYPH, ago, glyphs, ask, baseName, dateTime, bytes, closeDialog, closeMenu, copyText, dialog, dirName, enc, fileURL, go, h, inMenuAnchor, json, load, loadBundle, MenuItem, req,
  openDialog, setAccounts, showMenu, store, toast, toastError, typing, unreachable, user, Live,
} from './util';
import { openSchems, schemPost, setupSchems } from './schems';
import { byName, folderDir, folderOrder, openFolder, refreshFolder, setupFolder, stampName, startCreate as startFolderCreate } from './folder';
import { ICON, openViewer, singleBar, viewerOpen } from './viewer';
import { iconURL, loadIcons } from './icons';
import { adminChanged, openAdmin } from './admin';
import { setupSearch } from './search';
import { layoutChanged, mainChannel, onFilesChanged as chatFilesChanged, onUsersChanged as chatUsersChanged, openInMain, setupChat, shareLink } from './chat';
import { openSettings, setupVoice } from './voice';
import { setupStreams, streamPanel, watchRelay, watchStream } from './stream';
import { openSoundSettings } from './sounds';

type Entry = { path: string; dir: boolean; size: number; mod?: number; large?: boolean };
type Kind = 'text' | 'markdown' | 'image' | 'video' | 'binary';
type Stat = { path: string; size: number; rev: string; kind: Kind; large?: boolean };

// Same limit as the server: bigger files go in large/, which keeps no history.
const MAX_VERSIONED = 50 << 20;
// large/ (big files), screenshots/ and map art/ keep no history.
const AREAS = ['large', 'screenshots', 'map art'];
const isLarge = (p: string) => AREAS.some((a) => p === a || p.startsWith(a + '/'));
type Commit = { rev: string; author: string; time: string; message: string };
// A text file opens in view (read only; Markdown rendered) and switches to edit; pictures and
// other files are always 'edit' (their normal view).
type Mode = 'view' | 'edit' | 'history' | 'conflict';
// pos: where the reader is in the file, a line number (fractional: part way down that line),
// kept across view/edit switches and re-renders.
// back: the mode to return to when History closes.
// at: a picture's place among its folder's pictures, last seen (mediaSteps).
type Open = { stat: Stat; mode: Mode; model?: M.editor.ITextModel; savedVersion?: number; pos?: number; back?: Mode; at?: number };

// Languages Monaco doesn't know by extension.
const extraLanguages: Record<string, string> = {
  json5: 'javascript', mcmeta: 'json', toml: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
};

// The editor is for notes and configs, edited mostly by non-programmers: a plain text box
// with colours, none of the coding help (suggestion popups, hover cards, lightbulbs,
// error squiggles, auto-inserted brackets). Long lines wrap.
const PLAIN: M.editor.IStandaloneEditorConstructionOptions = {
  quickSuggestions: false, suggestOnTriggerCharacters: false, wordBasedSuggestions: 'off',
  acceptSuggestionOnEnter: 'off', tabCompletion: 'off', snippetSuggestions: 'none', inlineSuggest: { enabled: false },
  parameterHints: { enabled: false }, hover: { enabled: 'off' }, lightbulb: { enabled: 'off' as M.editor.ShowLightbulbIconMode },
  codeLens: false, links: false, colorDecorators: false, contextmenu: false, folding: false, glyphMargin: false,
  autoClosingBrackets: 'never', autoClosingQuotes: 'never', autoSurround: 'never', autoIndent: 'keep',
  formatOnType: false, formatOnPaste: false, matchBrackets: 'never', occurrencesHighlight: 'off',
  selectionHighlight: false, renderValidationDecorations: 'off', unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
  stickyScroll: { enabled: false }, guides: { indentation: false }, minimap: { enabled: false },
  wordWrap: 'on', scrollBeyondLastLine: false, fontSize: 14, lineNumbersMinChars: 3,
  fontFamily: "'JetBrains Mono Variable', monospace",
};

// The editor is its own file (monaco.ts), loaded the first time a text file opens: a page
// that never opens one, like any phone, doesn't download it. monaco is set once it's in.
let monaco: typeof M;
const loadEditor = async () => {
  monaco = await loadBundle<typeof M>('monaco', true);
};

const CHEVRON = '<svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

// ---- state ----

let entries: Entry[] = [];
let treeJSON = '';
const expanded = new Set<string>(JSON.parse(load('mt-expanded') ?? '[]'));
let targetDir = '';
let focused = ''; // the selected tree row (one highlight, as in VS Code)
let lastActive: string | null = null; // tree row of what the main pane showed last render
let visible: Entry[] = []; // tree rows on screen, in order (for the arrow keys)
let renaming: string | null = null; // path with the inline rename box open
let creating: { dir: string; folder: boolean } | null = null; // inline new file/folder box
let renameDraft: string | null = null; // what's typed in either box, kept across re-renders
let dragPath = ''; // tree row being dragged
type Moved = { from: string; to: string; author: string };
let moves: Moved[] = []; // every rename/move, oldest first, so old links still work
let cur: Open | null = null;
let editor: M.editor.IStandaloneCodeEditor | null = null;
let diff: M.editor.IStandaloneDiffEditor | null = null;
let tempModels: M.editor.ITextModel[] = [];
let uploading = 0;
// The main panel shows the open file, a channel, a folder or the Schematic Manager (picked in the left list).
let mainMode: 'file' | 'chat' | 'schems' | 'folder' | 'live' = 'file';

// ---- helpers ----

function banner(msg: string | null) {
  const b = $('banner');
  b.hidden = !msg;
  b.textContent = msg ?? '';
}

const dirty = () => !!cur?.model && cur.model.getAlternativeVersionId() !== cur.savedVersion;
// leaveOK asks before unsaved changes are thrown away (Cancel, Back, Esc, opening another file).
const leaveOK = async () => !dirty() || ask({
  title: `Discard your changes to ${baseName(cur!.stat.path)}?`, body: 'Your unsaved changes will be lost. This can’t be undone.',
  confirm: 'Discard', danger: true,
});

function expandParents(p: string) {
  for (let d = dirName(p); d; d = dirName(d)) expanded.add(d);
  store('mt-expanded', JSON.stringify([...expanded]));
}

// ---- your account ----

// login shows the login form until a name and password work. Nothing else runs before it.
// why is shown on it at first (a banned account is told so).
function login(why = ''): Promise<void> {
  return new Promise((done) => {
    const name = h('input', { autocomplete: 'username', spellcheck: false });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const err = h('div', { class: 'error' }, why);
    const go = h('button', { class: 'primary', type: 'submit' }, 'Log in');
    const form = h('form', {}, h('label', {}, 'Name', name), h('label', {}, 'Password', pass), err,
      h('div', { class: 'actions' }, go));
    form.onsubmit = async (e) => {
      e.preventDefault();
      go.disabled = true;
      err.textContent = '';
      // Not req: a wrong password is a 401 here, not an ended session.
      const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ name: name.value, password: pass.value }) }).catch(() => null);
      go.disabled = false;
      if (!r || unreachable(r)) {
        err.textContent = 'Couldn’t reach the hub. Try again in a moment.';
        return;
      }
      if (!r.ok) {
        err.textContent = (await r.json().catch(() => ({}))).error ?? 'Couldn’t log in';
        pass.select();
        return;
      }
      closeDialog();
      done();
    };
    openDialog({ keep: true }, h('h2', {}, 'MacroTech'), form); // the login: Esc doesn't close it
  });
}

// shortcuts shows every keyboard shortcut (style guide 10), from the menu on your name.
function shortcuts() {
  const rows: [string, string][] = [
    ['Anywhere', '/ or Ctrl+K: search · Esc: close the menu, popup or dialog on top · Alt+← / Alt+→: back and forward'],
    ['Files tree', '↑ / ↓ move · Home / End · → / ← open or close a folder · Enter: open · F2: rename · Delete'],
    ['A picture or post', '← / →: the one before or after · Esc: back to its folder or the board'],
    ['Folder view', 'Esc: up one folder · Ctrl+V: paste pictures'],
    ['Text file', 'Ctrl+S: save · Ctrl+wheel: zoom'],
    ['Message box', 'Enter: send · Shift+Enter: new line · ↑ in an empty box: edit your last message · Esc: cancel a reply · Ctrl+B, Ctrl+I, Ctrl+U: bold, italic, underline'],
    ['Typing a message', '@: mention someone · : and two letters: emoji · ↑ / ↓ and Enter or Tab: pick'],
    ['Menus and popups', '↑ / ↓ move · Enter: pick · Esc: close'],
    ['Picture viewer', '← / →: the one before or after · Esc: close'],
  ];
  openDialog({ wide: true }, h('h2', {}, 'Keyboard shortcuts'),
    h('table', { class: 'keys' }, ...rows.map(([where, keys]) => h('tr', {}, h('th', {}, where), h('td', {}, ...glyphs(keys))))),
    h('div', { class: 'actions' }, Object.assign(h('button', {}, 'Close'), { onclick: closeDialog })));
}

// accountMenu is the menu on your name: the Admin page (admins), change password, log out
// (here or everywhere).
function accountMenu(e: MouseEvent) {
  const items: MenuItem[] = user.admin ? [['Admin', openAdmin], null] : [];
  showMenu(e, [...items, ['Keyboard Shortcuts', shortcuts], ['Voice Settings', () => void openSettings()], ['Sound Settings', openSoundSettings], null, ['Change Password', () => changePassword()], ['Log Out', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
  }], ['Log Out Everywhere', logOutEverywhere]], $('user'));
}

// logOutEverywhere ends your sessions on every other device and browser; this one stays in.
// The server ends this page's event stream too (so does a new password); with its new cookie
// it just reconnects. staying() says that end is expected.
let loggingOutOthers = false;
function staying() {
  loggingOutOthers = true;
  setTimeout(() => (loggingOutOthers = false), 5000); // in case no stream was open to end
}

async function logOutEverywhere() {
  staying();
  const r = await req('POST', '/api/logout-all', undefined, true);
  toast(r.ok ? 'Logged out everywhere else.' : 'Couldn’t log out everywhere', 4000);
}

// changePassword is Change Password from the menu on your name. With forced (logged in
// with a temporary password an admin gave you), it can't be cancelled, and forced runs once
// your own is set.
function changePassword(forced?: () => void) {
  const old = h('input', { type: 'password', autocomplete: 'current-password' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password' });
  const again = h('input', { type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'error' });
  const cancel = h('button', { type: 'button' }, 'Cancel');
  cancel.onclick = closeDialog;
  const form = h('form', {}, ...(forced ? [h('p', { class: 'muted' }, 'You logged in with a temporary password. Choose your own to carry on.')] : []),
    h('label', {}, forced ? 'Temporary password' : 'Current password', old), h('label', {}, 'New password', pw),
    h('label', {}, 'New password again', again), err, h('div', { class: 'actions' }, ...(forced ? [] : [cancel]), h('button', { class: 'primary', type: 'submit' }, 'Change')));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (pw.value !== again.value) return void (err.textContent = 'The new passwords don’t match');
    staying();
    const r = await req('POST', '/api/password', JSON.stringify({ old: old.value, new: pw.value }), true);
    if (!r.ok) return void (err.textContent = (await r.json().catch(() => ({}))).error ?? 'Couldn’t change it');
    closeDialog();
    if (forced) return forced();
    toast('Password changed. You’re logged out everywhere else.', 4000);
  };
  if (forced) {
    openDialog({ keep: true }, h('h2', {}, 'Choose your password'), form);
    old.focus();
  } else dialog(h('h2', {}, 'Change password'), form);
}

// ---- tree ----

async function refreshTree() {
  const r = await req('GET', '/api/tree');
  const text = await r.text();
  if (!r.ok || text === treeJSON) return;
  treeJSON = text;
  entries = JSON.parse(text);
  const m = await req('GET', '/api/moves').catch(() => null);
  if (m?.ok) moves = await m.json();
  renderTree();
  chatFilesChanged();
  if (mainMode === 'folder') {
    // The open folder is gone (deleted or moved, here or by someone else): follow a move,
    // else show the nearest folder above it that's still there.
    const d = folderDir();
    const there = (p: string) => entries.some((e) => e.dir && e.path === p);
    if (d && !there(d)) {
      let to = movedTo(d)?.path ?? dirName(d);
      while (to && !there(to)) to = dirName(to);
      if (to) openFolder(to);
      else closeFile();
    } else refreshFolder();
  }
}

// pathRef is how chat writes a link to a file: #path, or #[path] if it has spaces and such.
const pathRef = (p: string) => (/[^\w./-]/.test(p) ? `#[${p}]` : `#${p}`);

// movedTo follows a path through every later rename and move (a folder's carries the
// files inside it). It returns where p is now, or null if that isn't in the tree.
function movedTo(p: string): { path: string; by?: string } | null {
  let path = p;
  let by: string | undefined;
  for (const m of moves) {
    if (path === m.from || path.startsWith(m.from + '/')) {
      path = m.to + path.slice(m.from.length);
      by = m.author;
    }
  }
  return entries.some((e) => e.path === path) ? { path, by } : null;
}

// Folders before files, by name.
function treeOrder(a: Entry, b: Entry) {
  return Number(b.dir) - Number(a.dir) || byName(a.path, b.path);
}

// isActive: e is what the main pane shows.
const isActive = (e: Entry) => {
  if (e.dir) return mainMode === 'folder' && folderDir() === e.path;
  return mainMode === 'file' && cur?.stat.path === e.path;
};

// select makes e the selected row; new files and uploads go to its folder.
function select(e: Entry) {
  focused = e.path;
  targetDir = e.dir ? e.path : dirName(e.path);
}

function renderTree() {
  const root = $('tree');
  root.replaceChildren();
  // Whatever opens in the main pane (from the tree, a chat link, the address bar) becomes
  // the selected row.
  const shown = entries.find(isActive);
  if ((shown?.path ?? null) !== lastActive) {
    lastActive = shown?.path ?? null;
    if (shown) select(shown);
  }
  $('target').replaceChildren(...glyphs(targetDir ? `→ ${targetDir}/` : ''));

  const children = new Map<string, Entry[]>();
  for (const e of entries) {
    const parent = dirName(e.path);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(e);
  }
  const build = (dir: string, depth: number) => {
    const list = (children.get(dir) ?? []).sort(treeOrder);
    // A new folder's box goes above the folders, a new file's below them, as in VS Code.
    const firstFile = list.findIndex((e) => !e.dir);
    const boxAt = creating?.dir !== dir ? -1
      : creating.folder ? 0
      : firstFile < 0 ? list.length : firstFile;
    for (const [i, e] of [...list, null].entries()) {
      if (i === boxAt) root.append(createRow(depth));
      if (!e) break;
      const open = expanded.has(e.path);
      const name = baseName(e.path);
      let cls = 'row';
      if (e.dir) cls += ' dir';
      if (open) cls += ' open';
      if (isActive(e)) cls += ' active';
      if (focused === e.path) cls += ' focused';
      let title = e.dir ? e.path : `${e.path} · ${bytes(e.size)}`;
      if (AREAS.includes(e.path)) title += ' · no history';
      // One guide line per level, like VS Code's indent guides.
      const guides = h('span', { class: 'indent' });
      for (let i = 0; i < depth; i++) guides.append(h('span', { class: 'guide' }));
      const icon = h('img', { class: 'icon', src: iconURL(e.dir ? e.path : name, e.dir, open), alt: '' });
      const row = h('div', { class: cls, title },
        guides,
        h('span', { class: 'twisty', innerHTML: e.dir ? CHEVRON : '' }),
        icon,
        h('span', { class: 'name' }, name));
      if (renaming === e.path) row.querySelector('.name')!.replaceWith(renameBox(e));
      row.dataset.path = e.path;
      row.dataset.dir = e.dir ? e.path : dirName(e.path);
      row.onclick = () => activate(e);
      if (e.dir) {
        // Only the chevron expands/collapses; clicking the row selects the folder (or
        // opens a viewer folder's viewer).
        (row.querySelector('.twisty') as HTMLElement).onclick = (ev) => {
          ev.stopPropagation();
          select(e);
          setExpanded(e.path, !open);
          renderTree();
        };
      }
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        select(e);
        renderTree();
        $('tree').focus({ preventScroll: true });
        treeMenu(ev, e);
      };
      // Drag onto a folder to move it there, or onto a chat to link it.
      row.draggable = renaming !== e.path;
      row.ondragstart = (ev) => {
        dragPath = e.path;
        ev.dataTransfer?.setData('text/x-mt-path', e.path);
      };
      root.append(row);
      visible.push(e);
      if (e.dir && open) build(e.path, depth + 1);
    }
  };
  visible = [];
  build('', 0);
  // A fresh rename box selects the name without its extension, as VS Code does; a new
  // file's box (".md") has the cursor before the extension. One rebuilt by a re-render (a
  // live update, say) keeps the cursor at the end.
  const box = root.querySelector<HTMLInputElement>('input.rename');
  if (box) {
    box.focus();
    const dot = box.value.lastIndexOf('.');
    if (renameDraft === null) box.setSelectionRange(0, dot > 0 || creating ? Math.max(dot, 0) : box.value.length);
    renameDraft = box.value;
  }
}

// activate is a click on a row: a file opens, a folder opens the folder view (and becomes
// the target for new files and uploads). Neither expands anything.
function activate(e: Entry) {
  select(e);
  return e.dir ? openFolder(e.path) : openFile(e.path); // both render the tree
}

function collapseAll() {
  expanded.clear();
  store('mt-expanded', '[]');
  renderTree();
}



function setExpanded(p: string, open: boolean) {
  if (open) expanded.add(p);
  else expanded.delete(p);
  store('mt-expanded', JSON.stringify([...expanded]));
}

// ---- tree keyboard, rename, menu, moves ----

// Keys work like VS Code's explorer while the tree has focus.
function treeKey(ev: KeyboardEvent) {
  if (renaming || creating || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const i = visible.findIndex((e) => e.path === focused);
  const e = visible[i];
  let next = i;
  switch (ev.key) {
    case 'ArrowDown': next = Math.min(i + 1, visible.length - 1); break;
    case 'ArrowUp': next = i < 0 ? 0 : Math.max(i - 1, 0); break;
    case 'Home': next = 0; break;
    case 'End': next = visible.length - 1; break;
    case 'ArrowRight':
      if (e?.dir && !expanded.has(e.path)) setExpanded(e.path, true);
      else if (e?.dir) next = i + 1 < visible.length && dirName(visible[i + 1].path) === e.path ? i + 1 : i;
      break;
    case 'ArrowLeft':
      if (e?.dir && expanded.has(e.path)) setExpanded(e.path, false);
      else if (e && dirName(e.path)) next = visible.findIndex((v) => v.path === dirName(e.path));
      break;
    case 'Enter':
    case ' ':
      // With no chevron to click, Enter on a folder also opens/closes it.
      if (e?.dir) setExpanded(e.path, !expanded.has(e.path));
      if (e) activate(e);
      break;
    case 'F2':
    case 'Delete':
      ev.preventDefault();
      if (e && ev.key === 'F2') startRename(e.path);
      else if (e) deleteEntry(e);
      return;
    default: return;
  }
  ev.preventDefault();
  if (visible[next]) select(visible[next]);
  renderTree();
  $('tree').querySelector(`.row[data-path="${CSS.escape(focused)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function startRename(p: string) {
  if (AREAS.includes(p)) return toast(`${p}/ keeps its name`);
  expandParents(p); // (from the folder view its row may be hidden)
  focused = p;
  renaming = p;
  renameDraft = null;
  renderTree();
  $('tree').querySelector('input.rename')?.scrollIntoView({ block: 'nearest' });
}

// nameBox is the inline name editor behind rename and new file/folder: Enter or clicking
// away saves, Esc cancels. done gets the trimmed name ('' on cancel) once, unless a
// re-render already replaced the box (live() turns false). Once: Enter's focus move blurs
// the box, which mustn't save again while the first save is still waiting on the server.
function nameBox(initial: string, live: () => boolean, done: (name: string) => void) {
  const box = h('input', { class: 'rename', value: renameDraft ?? initial, spellcheck: false });
  box.oninput = () => (renameDraft = box.value);
  let over = false;
  const finish = (save: boolean) => {
    if (over || !live()) return;
    over = true;
    const name = save ? box.value.trim().replace(/^\/+|\/+$/g, '') : '';
    renameDraft = null;
    done(name);
    $('tree').focus({ preventScroll: true });
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
  return box;
}

function renameBox(e: Entry) {
  return nameBox(baseName(e.path), () => renaming === e.path, (name) => {
    renaming = null;
    const dir = dirName(e.path);
    const to = (dir ? dir + '/' : '') + name;
    if (name && to !== e.path) movePath(e.path, to);
    else renderTree();
  });
}

// createRow is the not-yet-named row for New File / New Folder; its icon follows the name.
// A new file starts as ".md" (nearly every one is); left at just that, it's a cancel.
function createRow(depth: number) {
  const { dir, folder } = creating!;
  const guides = h('span', { class: 'indent' });
  for (let i = 0; i < depth; i++) guides.append(h('span', { class: 'guide' }));
  const icon = h('img', { class: 'icon', alt: '' });
  const mine = creating;
  const box = nameBox(folder ? '' : '.md', () => creating === mine, async (name) => {
    if (!name || (!folder && name === '.md')) {
      creating = null;
      return renderTree();
    }
    const p = (dir ? dir + '/' : '') + name;
    if (!await makeEntry(p, folder)) {
      // Keep the box open with the name, so it can be fixed.
      creating = { dir, folder };
      renameDraft = name;
      return renderTree();
    }
    creating = null;
    focused = p;
    if (folder) targetDir = p;
    await refreshTree();
    renderTree();
    if (!folder) openFile(p);
  });
  box.addEventListener('input', () => (icon.src = iconURL(box.value.split('/').pop()!, folder, false)));
  icon.src = iconURL(box.value, folder, false);
  return h('div', { class: 'row creating' }, guides, h('span', { class: 'twisty' }), icon, box);
}

// makeEntry creates an empty file or folder (tree and folder view); false, with a toast, if
// it couldn't.
async function makeEntry(p: string, folder: boolean) {
  const r = folder
    ? await req('POST', '/api/mkdir', JSON.stringify({ path: p }))
    : await req('PUT', `/api/file/${enc(p)}?base=`, '');
  if (!r.ok) toast(r.status === 409 ? `${baseName(p)} already exists here` : 'Couldn’t create it');
  return r.ok;
}

function startCreate(folder: boolean) {
  if (targetDir) {
    expandParents(targetDir);
    setExpanded(targetDir, true);
  }
  renaming = null;
  creating = { dir: targetDir, folder };
  renameDraft = null;
  renderTree();
  $('tree').querySelector('.row.creating')?.scrollIntoView({ block: 'nearest' });
}

// movePath renames or moves a file or folder, carrying open folders, the open file and
// the selection along with it.
async function movePath(from: string, to: string) {
  const inside = (p: string) => p === from || p.startsWith(from + '/');
  const moved = (p: string) => to + p.slice(from.length);
  if (cur && inside(cur.stat.path) && dirty()) {
    toast(`Save or discard your changes to ${baseName(cur.stat.path)} first`);
    renderTree();
    return;
  }
  const r = await req('POST', '/api/move', JSON.stringify({ from, to }));
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))).error;
    toast(r.status === 409 ? `${to} already exists` : err ?? 'Couldn’t move it');
    renderTree();
    return;
  }
  for (const p of [...expanded]) {
    if (inside(p)) {
      expanded.delete(p);
      expanded.add(moved(p));
    }
  }
  if (dirName(to)) expanded.add(dirName(to)); // show where it landed
  store('mt-expanded', JSON.stringify([...expanded]));
  if (inside(focused)) focused = moved(focused);
  if (inside(targetDir)) targetDir = moved(targetDir);
  await refreshTree();
  if (cur && inside(cur.stat.path)) await openFile(moved(cur.stat.path), true);
  renderTree();
}

async function deleteEntry(e: Entry) {
  const inside = (p: string) => p === e.path || p.startsWith(e.path + '/');
  if (AREAS.includes(e.path)) return toast(`${e.path}/ itself can’t be deleted`);
  const files = entries.filter((x) => !x.dir && inside(x.path)).length;
  const body = (e.dir ? `The ${files} file${files === 1 ? '' : 's'} in it go too. ` : '')
    + (isLarge(e.path) ? 'Large files have no history: this can’t be undone.' : 'Earlier versions stay in the hub’s history, but nothing here brings them back yet.');
  if (!await ask({ title: `Delete ${e.dir ? 'the folder ' : ''}${baseName(e.path)}?`, body, confirm: 'Delete', danger: true })) return;
  let r: Response;
  if (e.dir) {
    r = await req('DELETE', `/api/file/${enc(e.path)}?dir=1`);
  } else {
    const s = await req('GET', `/api/stat/${enc(e.path)}`);
    if (!s.ok) return refreshTree();
    r = await req('DELETE', `/api/file/${enc(e.path)}?base=${(await s.json()).rev}`);
  }
  if (!r.ok) return toastError(r.status === 409 ? 'Someone changed it just now, so it wasn’t deleted.' : 'Couldn’t delete it.');
  toast(`Deleted ${baseName(e.path)}`);
  if (cur && inside(cur.stat.path)) closeFile();
  refreshTree();
}

// treeMenu is the right-click menu; e is null for the empty space below the rows. From a
// folder-view tile (inGrid), New File / New Folder name the new one in the folder view.
function treeMenu(ev: MouseEvent, e: Entry | null, inGrid = false) {
  const here = (fn: () => void) => () => {
    targetDir = e ? (e.dir ? e.path : dirName(e.path)) : '';
    renderTree();
    if (inGrid && (fn === newFile || fn === newFolder)) {
      if (folderDir() !== targetDir) openFolder(targetDir);
      return startFolderCreate(fn === newFolder);
    }
    fn();
  };
  const upload = () => ($('upload-input') as HTMLInputElement).click();
  let items: MenuItem[];
  if (!e) {
    items = [['New File…', here(newFile)], ['New Folder…', here(newFolder)], ['Upload…', here(upload)], null,
      ['Collapse Folders', collapseAll]];
  } else if (e.dir) {
    items = [
      ['New File…', here(newFile)], ['New Folder…', here(newFolder)], ['Upload…', here(upload)],
      ['Download as Zip', () => (location.href = `/api/zip/${enc(e.path)}`)], null,
      ['Rename…', () => startRename(e.path), 'F2'], ['Delete', () => deleteEntry(e), 'Delete'], null,
      ['Copy Path', () => copyText(e.path)],
    ];
  } else {
    items = [
      ['Open', () => openFile(e.path)], ['Download', () => (location.href = fileURL(e.path, '', true))], null,
      ['Rename…', () => startRename(e.path), 'F2'], ['Delete', () => deleteEntry(e), 'Delete'], null,
      ['Copy Path', () => copyText(e.path)],
    ];
  }
  if (e && AREAS.includes(e.path)) items = items.filter((it) => !Array.isArray(it) || (it[0] !== 'Rename…' && it[0] !== 'Delete'));
  showMenu(ev, items);
}

// Tree drop target: a folder row means that folder, a file row its folder, empty space
// the top.
function dropDirAt(target: EventTarget | null): string | null {
  return (target as HTMLElement).closest<HTMLElement>('.row')?.dataset.dir ?? '';
}

// showDrop highlights the folder a drag would land in (all of it, like VS Code) without
// re-rendering, so the row being dragged stays put.
function showDrop(dir: string | null) {
  const tree = $('tree');
  tree.classList.toggle('drop', dir === '');
  for (const row of tree.querySelectorAll<HTMLElement>('.row')) {
    const p = row.dataset.path!;
    row.classList.toggle('drop-target', !!dir && (p === dir || p.startsWith(dir + '/')));
  }
}

// ---- opening and rendering a file ----

// reveal expands the folders above the file so it shows in the tree. at (from search) is a
// line to show, with the searched-for words to select on it.
async function openFile(path: string, force = false, reveal = true, at?: Hit) {
  // Back from a channel to the file that's still open: just show it, edits and all.
  if (!force && cur?.stat.path === path && (mainMode !== 'file' || at)) {
    if (mainMode !== 'file') showFileArea();
    if (at && cur.mode === 'history') {
      cur.mode = 'view';
      render();
    }
    if (at) showHit(at);
    return;
  }
  if (!force && !(await leaveOK())) {
    // Kept the file. After Back, the address already shows the place left behind, and that
    // entry must stay: the file goes back on top as a new entry. After a link, go() sees the
    // same address and adds nothing.
    if (mainMode === 'file' && cur) go('#' + enc(cur.stat.path));
    return;
  }
  const r = await req('GET', `/api/stat/${enc(path)}`);
  if (r.status === 404) {
    const now = movedTo(path);
    if (now && now.path !== path) return openFile(now.path, force, reveal);
    toast(`${path} no longer exists`);
    return;
  }
  const stat = await json<Stat>(r);
  const next: Open = { stat, mode: stat.kind === 'markdown' || stat.kind === 'text' ? 'view' : 'edit' };
  if (stat.kind === 'text' || stat.kind === 'markdown') {
    const [text] = await Promise.all([req('GET', fileURL(path, stat.rev)).then((r) => r.text()), loadEditor()]);
    cur?.model?.dispose();
    next.model = monaco.editor.createModel(text, undefined, monaco.Uri.file('/' + path));
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (next.model.getLanguageId() === 'plaintext' && extraLanguages[ext]) {
      monaco.editor.setModelLanguage(next.model, extraLanguages[ext]);
    }
    next.savedVersion = next.model.getAlternativeVersionId();
    next.model.onDidChangeContent(() => renderToolbar());
  } else {
    cur?.model?.dispose();
  }
  cur = next;
  if (reveal) expandParents(path);
  banner(null);
  showFileArea();
  render();
  if (at) showHit(at);
}

type Hit = { line: number; words: string[] };

// showHit puts a search hit's line near the top and points at it: the first searched-for
// word on it is selected in the editor; in rendered Markdown its block flashes.
function showHit({ line, words }: Hit) {
  if (!cur || (cur.mode !== 'view' && cur.mode !== 'edit')) return;
  showPos(Math.max(line - 3, 1));
  if (editor) {
    const text = editor.getModel()!.getLineContent(line).toLowerCase();
    const found = words.map((w) => [text.indexOf(w), w.length]).filter(([i]) => i >= 0).sort((a, b) => a[0] - b[0])[0];
    const [col, len] = found ?? [0, text.length];
    editor.setSelection(new monaco.Selection(line, col + 1, line, col + 1 + len));
    return;
  }
  const blocks = [...$('view').querySelectorAll<HTMLElement>('.markdown [data-line]')];
  const b = blocks.filter((x) => Number(x.dataset.line) <= line).pop() ?? blocks[0];
  b?.classList.remove('flash');
  void b?.offsetWidth; // restart the animation
  b?.classList.add('flash');
}

function disposeEditors() {
  editor?.dispose();
  diff?.dispose();
  editor = diff = null;
  for (const m of tempModels) m.dispose();
  tempModels = [];
}

let shown: Open | null = null; // what render() last showed

function render() {
  // Same file as before (a view/edit switch, back from history, a re-render): note where the
  // reader is, to put them back there.
  if (cur && shown === cur) cur.pos = readPos() ?? cur.pos;
  shown = cur;
  disposeEditors();
  renderToolbar();
  const view = $('view');
  view.replaceChildren();
  if (!cur) {
    view.append(h('div', { class: 'empty' }, 'Pick a file from the tree, or drop files on it to upload.'));
    return;
  }
  const { stat, mode } = cur;
  if (mode === 'history') {
    renderHistory();
  } else if (stat.kind === 'image') {
    const img = h('img', { src: fileURL(stat.path, stat.rev), title: 'Click for full size' });
    img.onclick = () => viewMedia(stat.path);
    view.append(h('div', { class: 'image' }, img));
  } else if (stat.kind === 'video') {
    view.append(h('div', { class: 'image' }, h('video', { src: fileURL(stat.path, stat.rev), controls: true })));
  } else if (isAudio(stat)) {
    view.append(h('div', { class: 'image audio' }, h('audio', { src: fileURL(stat.path, stat.rev), controls: true })));
  } else if (stat.kind === 'binary') {
    view.append(infoCard(stat));
  } else if (mode === 'view' && stat.kind === 'markdown') {
    view.append(markdownView(cur.model!.getValue()));
    applyZoom();
  } else {
    // Edit, or view for other text: the same editor, read only.
    const host = h('div', { class: 'editor' });
    view.append(host);
    const ro = mode === 'view';
    editor = monaco.editor.create(host, {
      ...PLAIN, model: cur.model!, theme: 'vs-dark', automaticLayout: true, fontSize: 14 * zoom / 100,
      readOnly: ro, readOnlyMessage: { value: 'To change this file, click Edit (top right).' },
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
    if (!ro) editor.focus();
  }
  if (cur.pos != null && (mode === 'view' || mode === 'edit')) showPos(cur.pos);
}

// markdownView renders Markdown with each top-level block tagged with the line it starts on
// (data-line), so switching between view and edit keeps the reader's place.
// (gfm: true must be given with the other options, or marked drops tables and the rest.)
function markdownView(src: string) {
  const div = h('div', { class: 'markdown' });
  const tokens = marked.lexer(src, { gfm: true, breaks: true });
  let line = 1;
  let html = '';
  for (const t of tokens) {
    if (t.type !== 'space') {
      const one = Object.assign([t], { links: tokens.links }) as typeof tokens;
      // breaks: each line is its own line, as in Discord and GitHub comments (macro lists).
      html += `<div data-line="${line}">${marked.parser(one, { gfm: true, breaks: true })}</div>`;
    }
    line += (t.raw.match(/\n/g) ?? []).length;
  }
  div.replaceChildren(cleanHTML(html));
  return div;
}

// readPos is where the reader is in the open file (see Open.pos), or null if nothing shows text.
function readPos(): number | null {
  if (editor) {
    const top = editor.getScrollTop();
    const first = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
    const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
    return first + Math.min(Math.max((top - editor.getTopForLineNumber(first)) / lh, 0), 0.99);
  }
  const blocks = [...$('view').querySelectorAll<HTMLElement>('.markdown [data-line]')];
  if (!blocks.length) return null;
  const top = $('view').scrollTop;
  let i = 0;
  while (i + 1 < blocks.length && blocks[i + 1].offsetTop <= top) i++;
  const b = blocks[i];
  const from = Number(b.dataset.line);
  const to = blocks[i + 1] ? Number(blocks[i + 1].dataset.line) : from + 1;
  return from + Math.min(Math.max((top - b.offsetTop) / Math.max(b.offsetHeight, 1), 0), 1) * (to - from);
}

// showPos scrolls the shown text so that line pos is at the top.
function showPos(pos: number) {
  if (editor) {
    const n = Math.floor(pos);
    const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
    editor.setScrollTop(editor.getTopForLineNumber(n) + (pos - n) * lh);
    return;
  }
  const blocks = [...$('view').querySelectorAll<HTMLElement>('.markdown [data-line]')];
  if (!blocks.length) return;
  let i = 0;
  while (i + 1 < blocks.length && Number(blocks[i + 1].dataset.line) <= pos) i++;
  const b = blocks[i];
  const from = Number(b.dataset.line);
  const to = blocks[i + 1] ? Number(blocks[i + 1].dataset.line) : from + 1;
  $('view').scrollTop = b.offsetTop + Math.min(Math.max((pos - from) / (to - from), 0), 1) * b.offsetHeight;
}

// ---- text zoom: one size for all text files, in view and edit, remembered ----

let zoom = Math.min(Math.max(Number(load('mt-zoom')) || 100, 50), 250);

function setZoom(z: number) {
  const pos = readPos();
  zoom = Math.min(Math.max(Math.round(z / 10) * 10, 50), 250);
  store('mt-zoom', String(zoom));
  applyZoom();
  if (pos != null) showPos(pos); // bigger text: stay at the same line
  const slider = document.querySelector<HTMLInputElement>('#toolbar .size input');
  if (slider) {
    slider.value = String(zoom);
    slider.title = sizeTitle();
  }
}

const sizeTitle = () => `Text size: ${zoom}% (double-click for 100%)`;

function applyZoom() {
  editor?.updateOptions({ fontSize: 14 * zoom / 100 });
  const md = $('view').querySelector<HTMLElement>('.markdown');
  if (md) md.style.fontSize = `${13 * zoom / 100}px`;
}

// sizeControl is the bar's Size slider, the folder view's look: 50% to 250%, the percentage in
// its tooltip, a double-click back to 100%.
function sizeControl() {
  const slider = h('input', { type: 'range', min: 50, max: 250, step: 10, value: String(zoom), title: sizeTitle() });
  slider.oninput = () => setZoom(Number(slider.value));
  slider.ondblclick = () => setZoom(100);
  return h('label', { class: 'size', title: 'Text size' }, 'Size ', slider);
}

// discardEdits is View/Cancel: back to the last saved text (asking first if anything
// changed), then View, at the same place in the file.
async function discardEdits(c: Open) {
  if (!(await leaveOK())) return;
  if (dirty()) {
    const text = await (await req('GET', fileURL(c.stat.path, c.stat.rev))).text();
    if (cur !== c) return;
    c.model!.setValue(text);
    c.savedVersion = c.model!.getAlternativeVersionId();
  }
  c.mode = 'view';
  render();
}

function infoCard(stat: Stat) {
  const ext = stat.path.slice(stat.path.lastIndexOf('.') + 1).toLowerCase();
  const dl = h('dl', {},
    h('dt', {}, 'Size'), h('dd', {}, bytes(stat.size)),
    h('dt', {}, 'Type'), h('dd', {}, ext === 'litematic' ? 'Litematica schematic' : ext.toUpperCase() + ' file'));
  const get = h('button', { class: 'primary' }, 'Download');
  get.onclick = () => (location.href = fileURL(stat.path, '', true));
  const card = h('div', { class: 'card' }, h('h2', {}, baseName(stat.path)), dl, get);
  if (stat.large) card.append(h('p', { class: 'muted' }, 'Large file: kept without version history.'));
  if (ext === 'litematic') card.append(h('p', { class: 'muted' }, 'A 3D preview is planned for later.'));
  return card;
}

function renderToolbar() {
  const bar = $('toolbar');
  bar.replaceChildren();
  if (!cur) return;
  const c = cur;
  if (isMedia(c)) {
    bar.append(mediaBar(c));
    return;
  }
  const p = c.stat.path;
  const name = baseName(p) + (dirty() ? '  ●' : '');
  if (c.mode === 'conflict') { // the conflict view has its own buttons
    bar.append(singleBar({ name }));
    return;
  }
  const text = !!c.model && (c.mode === 'view' || c.mode === 'edit');
  const extra: HTMLElement[] = [];
  // A text file opens in View with a blue Edit; editing, that button is View (Cancel once
  // there are unsaved changes) and a Save comes in on its left (grey until there are unsaved
  // changes). Save keeps its place, hidden, in View, and the toggle keeps one width, so
  // nothing moves.
  if (text) {
    const editing = c.mode === 'edit';
    const s = h('button', { title: 'Save (Ctrl+S)', disabled: !editing || !dirty(), class: editing && dirty() ? 'primary' : '' }, 'Save');
    s.onclick = save;
    if (!editing) s.classList.add('reserved');
    const toggle = h('button', {
      class: 'primary edit-toggle',
      title: !editing ? 'Change this file' : dirty() ? 'Throw away your changes' : 'Stop editing',
      innerHTML: editing ? '' : ICON.edit,
    });
    toggle.append(!editing ? 'Edit' : dirty() ? 'Cancel' : 'View');
    toggle.onclick = editing ? () => discardEdits(c) : () => {
      c.mode = 'edit';
      render();
    };
    extra.push(s, toggle);
  }
  if (!c.stat.large) {
    const hist = h('button', { title: 'Earlier versions' }, c.mode === 'history' ? 'Close history' : 'History');
    hist.onclick = () => {
      if (c.mode === 'history') c.mode = c.back ?? (c.model ? 'view' : 'edit');
      else [c.back, c.mode] = [c.mode, 'history'];
      render();
    };
    extra.push(hist);
  }
  const folder = dirName(p);
  const mod = entries.find((e) => e.path === p)?.mod;
  bar.append(singleBar({
    back: folder ? { label: `← Back to ${folder}/`, title: 'Back to the folder (Esc)', go: () => backToFolder(folder) } : undefined,
    name,
    info: [mod ? dateTime(mod) : '', bytes(c.stat.size)].filter(Boolean).join(' · '),
    forward: () => shareLink(pathRef(p)),
    download: { href: fileURL(p, '', true), name: baseName(p) },
    newTab: `/api/file/${enc(p)}`,
    del,
    extra,
    size: text ? sizeControl() : undefined,
  }));
}

// A picture or video being viewed gets the single-item bar (as schematic
// posts do) instead of the file toolbar.
// A sound file is one too: the hub calls it "binary" (and an older page shows it as a file
// to download), so the page tells by its name.
const AUDIO_FILE = /\.(mp3|ogg|wav|m4a|flac)$/i;
const isAudio = (s: Stat) => s.kind === 'binary' && AUDIO_FILE.test(s.path);
const isMedia = (c: Open) => (c.stat.kind === 'image' || c.stat.kind === 'video' || isAudio(c.stat)) && c.mode === 'edit';
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v|mp3|ogg|wav|m4a|flac)$/i;

// mediaSiblings is the pictures, videos and sounds in p's folder, in the folder view's order.
function mediaSiblings(p: string) {
  const dir = dirName(p);
  return entries.filter((e) => !e.dir && dirName(e.path) === dir && MEDIA_FILE.test(e.path)).sort(folderOrder(dir));
}

// mediaSteps is the places before and after the open picture among its folder's pictures.
// One deleted while it's shown keeps its old place, so the glyphs go to its neighbours.
function mediaSteps(c: Open, sibs: Entry[]): [number, number] {
  const i = sibs.findIndex((e) => e.path === c.stat.path);
  if (i >= 0) {
    c.at = i;
    return [i - 1, i + 1];
  }
  return [(c.at ?? 0) - 1, c.at ?? 0];
}

function mediaBar(c: Open) {
  const p = c.stat.path;
  const folder = dirName(p);
  const sibs = mediaSiblings(p);
  const i = sibs.findIndex((e) => e.path === p);
  const [before, after] = mediaSteps(c, sibs);
  const go = (j: number) => (j >= 0 && j < sibs.length ? () => openFile(sibs[j].path) : null);
  const mod = sibs[i]?.mod;
  const history = h('button', { title: 'Earlier versions' }, 'History');
  history.onclick = () => {
    c.mode = 'history';
    render();
  };
  return singleBar({
    back: folder ? { label: `← Back to ${folder}/`, title: 'Back to the folder (Esc)', go: () => backToFolder(folder) } : undefined,
    name: baseName(p),
    info: [mod ? dateTime(mod) : '', bytes(c.stat.size)].filter(Boolean).join(' · '),
    prev: sibs.length > 1 ? go(before) : undefined,
    next: sibs.length > 1 ? go(after) : undefined,
    zoom: c.stat.kind === 'image' ? () => viewMedia(p) : undefined,
    forward: () => shareLink(pathRef(p)),
    download: { href: `/api/file/${enc(p)}`, name: baseName(p) },
    newTab: `/api/file/${enc(p)}`,
    del,
    extra: c.stat.large ? [] : [history],
  });
}

// viewMedia opens the full-window viewer on p, with the rest of its folder's pictures and
// videos to step through.
function viewMedia(p: string) {
  const sibs = mediaSiblings(p).filter((e) => !AUDIO_FILE.test(e.path)); // (nothing to show full window)
  openViewer(sibs.map((e) => ({
    src: `/api/file/${enc(e.path)}`, name: baseName(e.path), when: e.mod,
    kind: /\.(mp4|webm|mov|m4v)$/i.test(e.path) ? 'video' as const : 'image' as const,
    forward: () => shareLink(pathRef(e.path)),
  })), Math.max(0, sibs.findIndex((e) => e.path === p)));
}

// stepMedia is ←/→ on a picture or video: the previous or next one in its folder.
function stepMedia(d: number) {
  if (!cur || !isMedia(cur)) return;
  const sibs = mediaSiblings(cur.stat.path);
  const j = mediaSteps(cur, sibs)[d < 0 ? 0 : 1];
  if (j >= 0 && j < sibs.length) openFile(sibs[j].path);
}

// backToFolder closes the open file and shows its folder.
async function backToFolder(dir: string) {
  if (!(await leaveOK())) return;
  closeFile();
  targetDir = dir;
  openFolder(dir);
}

// ---- saving, conflicts ----

// saving: a save is on its way. Another Ctrl+S meanwhile waits for it (sent at once, it would
// carry the old revision and come back as a false "someone saved" conflict).
let saving: Promise<void> | null = null;

async function save() {
  while (saving) await saving;
  saving = saveNow().finally(() => (saving = null));
  return saving;
}

async function saveNow() {
  const c = cur;
  if (!c?.model || !dirty() || c.mode === 'conflict') return;
  const text = c.model.getValue();
  const version = c.model.getAlternativeVersionId();
  const r = await req('PUT', `/api/file/${enc(c.stat.path)}?base=${c.stat.rev}`, text);
  if (r.status === 409) {
    const { current } = await r.json();
    showConflict(c, current, text);
    return;
  }
  if (!r.ok) {
    toastError(`Couldn’t save it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
    return;
  }
  const { rev } = await json<{ rev: string }>(r);
  c.stat.rev = rev;
  c.stat.size = new Blob([text]).size;
  c.savedVersion = version;
  banner(null);
  renderToolbar();
  toast('Saved');
  refreshTree();
}

async function showConflict(c: Open, theirsRev: string, mine: string) {
  const path = c.stat.path;
  let theirs = '';
  let who = 'Someone';
  if (theirsRev) {
    theirs = await (await req('GET', fileURL(path, theirsRev))).text();
    const hist = await json<Commit[]>(await req('GET', `/api/history/${enc(path)}`));
    who = hist[0]?.author ?? who;
  }
  if (cur !== c) return;
  c.mode = 'conflict';
  disposeEditors();
  renderToolbar();
  banner(null);

  const lang = c.model!.getLanguageId();
  const left = monaco.editor.createModel(theirs, lang);
  const right = monaco.editor.createModel(mine, lang);
  tempModels.push(left, right);

  const saveRight = h('button', { class: 'primary' }, theirsRev ? 'Save the right side' : 'Recreate with my version');
  saveRight.onclick = async () => {
    const r = await req('PUT', `/api/file/${enc(path)}?base=${theirsRev}`, right.getValue());
    if (r.status === 409) return showConflict(c, (await r.json()).current, right.getValue());
    await json(r);
    toast('Saved');
    refreshTree();
    openFile(path, true);
  };
  const copy = h('button', {}, 'Save mine as a copy');
  copy.onclick = async () => {
    const dot = path.lastIndexOf('.');
    const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
    const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
    for (let n = 1; n < 50; n++) {
      const p = `${stem} (${user.name}${n > 1 ? ' ' + n : ''})${ext}`;
      const r = await req('PUT', `/api/file/${enc(p)}?base=`, right.getValue());
      if (r.status === 409) continue;
      await json(r);
      toast(`Saved as ${baseName(p)}`);
      refreshTree();
      openFile(p, true);
      return;
    }
  };
  const discard = h('button', {}, 'Discard mine');
  discard.onclick = () => (theirsRev ? openFile(path, true) : closeFile());

  const text = theirsRev
    ? `${who} saved this file while you were editing. Left: their version. Right: yours — edit it into what you want, then save.`
    : 'This file was deleted while you were editing.';
  const host = h('div', { class: 'diff' });
  const view = $('view');
  view.replaceChildren(h('div', { class: 'split' },
    h('div', { class: 'note' }, h('span', { class: 'text' }, text), saveRight, copy, discard), host));
  diff = monaco.editor.createDiffEditor(host, {
    ...PLAIN, theme: 'vs-dark', automaticLayout: true, originalEditable: false, renderSideBySide: true,
  });
  diff.setModel({ original: left, modified: right });
}

function closeFile() {
  cur?.model?.dispose();
  cur = null;
  go('');
  mainMode = 'file';
  banner(null);
  renderTree();
  render();
}

async function del() {
  const c = cur;
  if (!c) return;
  const body = c.stat.large ? 'Large files have no history: this can’t be undone.' : 'Earlier versions stay in the hub’s history, but nothing here brings them back yet.';
  if (!await ask({ title: `Delete ${baseName(c.stat.path)}?`, body, confirm: 'Delete', danger: true })) return;
  const r = await req('DELETE', `/api/file/${enc(c.stat.path)}?base=${c.stat.rev}`);
  if (r.status === 409) {
    toastError('Someone changed this file since you opened it, so it wasn’t deleted.');
    return;
  }
  if (r.status === 404) {
    toast('Someone already deleted it.'); // gone either way: close it, as for a delete
  } else if (!r.ok) {
    toastError(`Couldn’t delete it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
    return;
  } else {
    toast(`Deleted ${baseName(c.stat.path)}`);
  }
  closeFile();
  await refreshTree();
  // A file deleted from a folder goes back to the folder.
  const folder = dirName(c.stat.path);
  if (folder && entries.some((e) => e.dir && e.path === folder)) openFolder(folder);
}

// ---- history ----

async function renderHistory() {
  const c = cur!;
  const hist = await json<Commit[]>(await req('GET', `/api/history/${enc(c.stat.path)}`));
  if (cur !== c || c.mode !== 'history') return;
  const list = h('div', { class: 'history' });
  const pane = h('div', { class: 'history-view' });
  $('view').replaceChildren(h('div', { class: 'history-wrap' }, list, pane));
  hist.forEach((cm, i) => {
    const row = h('div', { class: 'commit' },
      h('div', { class: 'who' }, cm.author, i === 0 ? h('span', { class: 'tag' }, 'current') : ''),
      h('div', { class: 'when' }, ago(cm.time)),
      h('div', { class: 'msg' }, cm.message));
    row.onclick = () => {
      list.querySelectorAll('.commit').forEach((el) => el.classList.remove('selected'));
      row.classList.add('selected');
      showRevision(c, cm, i === 0, pane);
    };
    list.append(row);
  });
  (list.children[0] as HTMLElement | undefined)?.click();
}

async function showRevision(c: Open, cm: Commit, isCurrent: boolean, pane: HTMLElement) {
  diff?.dispose();
  diff = null;
  for (const m of tempModels) m.dispose();
  tempModels = [];

  const restore = h('button', { class: 'primary' }, 'Restore this version');
  restore.disabled = isCurrent;
  restore.onclick = async () => {
    if (dirty() && !await ask({ title: 'Restore this version?', body: 'It replaces your unsaved changes, which will be lost. This can’t be undone.', confirm: 'Restore', danger: true })) return;
    const data = await (await req('GET', fileURL(c.stat.path, cm.rev))).arrayBuffer();
    const r = await req('PUT', `/api/file/${enc(c.stat.path)}?base=${c.stat.rev}`, data);
    if (r.status === 409) {
      toast('Someone changed this file meanwhile. Reopen it and try again.');
      return;
    }
    await json(r);
    toast(`Restored the version from ${ago(cm.time)}`);
    openFile(c.stat.path, true);
  };
  const label = isCurrent
    ? `Current version, by ${cm.author}.`
    : `Left: ${cm.author}'s version from ${ago(cm.time)}. Right: current.`;
  const note = h('div', { class: 'note' }, h('span', { class: 'text' }, label), restore);
  const split = h('div', { class: 'split' }, note);
  pane.replaceChildren(split);

  if (c.stat.kind === 'text' || c.stat.kind === 'markdown') {
    const old = await (await req('GET', fileURL(c.stat.path, cm.rev))).text();
    if (cur !== c || c.mode !== 'history') return;
    const lang = c.model!.getLanguageId();
    const left = monaco.editor.createModel(old, lang);
    const right = monaco.editor.createModel(c.model!.getValue(), lang);
    tempModels.push(left, right);
    const host = h('div', { class: 'diff' });
    split.append(host);
    diff = monaco.editor.createDiffEditor(host, {
      theme: 'vs-dark', automaticLayout: true, readOnly: true, originalEditable: false,
    });
    diff.setModel({ original: left, modified: right });
  } else if (c.stat.kind === 'image') {
    split.append(h('div', { class: 'image' }, h('img', { src: fileURL(c.stat.path, cm.rev) })));
  } else {
    const get = h('button', {}, 'Download this version');
    get.onclick = () => (location.href = fileURL(c.stat.path, cm.rev, true));
    split.append(h('div', { class: 'card' }, get));
  }
}

// ---- creating and uploading ----

// New file/folder: an inline name box in the target folder (see createRow).
const newFolder = () => startCreate(true);
const newFile = () => startCreate(false);

// put uploads with progress (fetch can't report upload progress; XHR can).
function put(url: string, body: Blob, onProgress: (fraction: number) => void, method = 'PUT') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let parsed = null;
      try { parsed = JSON.parse(x.responseText); } catch { /* not JSON */ }
      resolve({ status: x.status, body: parsed });
    };
    x.onerror = () => reject(new Error('network error'));
    x.send(body);
  });
}

// uploadInto puts files in a folder without replacing anything (a name already there gets
// " (2)") and returns their paths. Files over 50 MB go in large/, which keeps no history.
async function uploadInto(files: File[], dir: string, pasted = false): Promise<string[]> {
  const out: string[] = [];
  const taken = new Set(entries.map((e) => e.path));
  const dirs = new Set<string>();
  uploading++;
  try {
    for (const f of files) {
      const to = f.size > MAX_VERSIONED && !isLarge(dir) ? 'large' : dir;
      const at = to ? to + '/' : '';
      let name = f.name;
      if (pasted && /^image\.\w+$/.test(name)) name = stampName(Date.now(), name.slice(5), (n) => taken.has(at + n));
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let p = at + name;
      for (let n = 2; taken.has(p); n++) p = `${at}${stem} (${n})${ext}`;
      taken.add(p);
      const r = await put(`/api/file/${enc(p)}?base=`, f,
        (x) => toast(`Uploading ${f.name}: ${Math.floor(x * 100)}% of ${bytes(f.size)}`, 0));
      if (r.status !== 200) {
        toastError(`Couldn’t upload ${f.name}: ${r.body?.error ?? r.status}.`);
        break;
      }
      out.push(p);
      dirs.add(to);
    }
  } catch (e) {
    toastError(`Couldn’t upload: ${(e as Error).message}.`);
  } finally {
    uploading--;
    await refreshTree();
  }
  if (out.length) toast(`Uploaded ${out.length} file${out.length > 1 ? 's' : ''} to ${[...dirs].map((d) => (d ? d + '/' : 'the top level')).join(' and ')}`);
  return out;
}

async function upload(files: File[], dir: string) {
  let done = 0;
  const replaced: string[] = [];
  uploading++;
  try {
    for (const f of files) {
      let target = dir;
      if (f.size > MAX_VERSIONED && !isLarge(dir)) {
        const ok = await ask({ title: `Upload ${f.name} to large/?`, body: `It’s ${bytes(f.size)}. Files over 50 MB go in large/, which keeps no version history.`, confirm: 'Upload to large/' });
        if (!ok) continue;
        target = 'large';
      }
      // Screenshots are named by when they were taken and who posts them.
      let name = f.name;
      if (target === 'screenshots') {
        const ext = (/\.[^.]+$/.exec(f.name)?.[0] ?? '.png').toLowerCase();
        name = stampName(f.lastModified || Date.now(), ext, (n) => entries.some((e) => e.path === `${target}/${n}`));
      }
      const p = (target ? target + '/' : '') + name;
      const progress = (x: number) => toast(`Uploading ${f.name}: ${Math.floor(x * 100)}% of ${bytes(f.size)}`, 0);
      let r = await put(`/api/file/${enc(p)}?base=`, f, progress);
      // Already there: a versioned file is replaced (the old one stays in its history, so
      // there's nothing to ask, style guide 6.6); a large one has no history, so it asks.
      if (r.status === 409) {
        if (isLarge(p) && !await ask({ title: `Replace ${baseName(p)}?`, body: `${p} already exists. Large files have no history: this can’t be undone.`, confirm: 'Replace', danger: true })) continue;
        r = await put(`/api/file/${enc(p)}?base=${r.body.current}`, f, progress);
        if (r.status === 200 && !isLarge(p)) replaced.push(baseName(p));
      }
      if (r.status === 200) {
        done++;
        expandParents(p);
      } else {
        toastError(`Couldn’t upload ${p}: ${r.body?.error ?? r.status}.`);
        return;
      }
    }
  } catch (e) {
    toastError(`Couldn’t upload: ${(e as Error).message}.`);
    return;
  } finally {
    uploading--;
    await refreshTree();
  }
  if (done) toast(`Uploaded ${done} file${done > 1 ? 's' : ''}${replaced.length ? `; replaced ${replaced.join(', ')} (the old version stays in its history)` : ''}`, replaced.length ? 5000 : 2500);
}

// ---- main panel: file or channel ----

function showFileArea() {
  setMode('file');
  go(cur ? '#' + enc(cur.stat.path) : '');
  layoutChanged();
}

function showMainChat() {
  setMode('chat');
  go('#chan=' + mainChannel());
}

// The Schematic Manager sets the address itself (#schems or #schem=<folder>).
function showSchems() {
  setMode('schems');
  layoutChanged();
}

function setMode(m: typeof mainMode) {
  mainMode = m;
  // On a phone the main panel is hidden; a stream being watched covers the screen instead.
  document.body.classList.toggle('watching', m === 'live');
  streamPanel(m === 'live'); // (shows or hides #main-live; a stream goes on playing behind the rest)
  $('file-area').hidden = m !== 'file';
  $('main-chat').hidden = m !== 'chat';
  $('main-schems').hidden = m !== 'schems';
  $('main-folder').hidden = m !== 'folder';
  renderTree();
  layoutChanged(); // (the chat list too: a chat's row is the open one only while the chat is)
}

// openHash opens whatever the address points at: #chan=<name>, #live=<name>, #stream=<name>, #schems, #schem=<folder>
// (a post), #folder=<path> or #<file or folder path>.
// dec decodes part of an address; a malformed one (a stray %) is taken as written.
const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

async function openHash() {
  const raw = location.hash.slice(1);
  const h = dec(raw);
  // A file or folder of that name wins over the page addresses below (a top-level file
  // called "schems" opens, not the board).
  const named = h && entries.find((e) => e.path === h);
  // The old gallery addresses (#shots, #mapart) open their folders.
  const old: Record<string, string> = { shots: 'screenshots', mapart: 'map art' };
  if (!h) {
    // Back to the bare address (where a closed file leaves you): the empty file area.
    if (mainMode === 'live') return showFileArea();
    if (mainMode !== 'file' || !cur) return;
    if (await leaveOK()) closeFile();
    else go('#' + enc(cur.stat.path)); // kept the file: back on top, as openFile does
  } else if (named) {
    if (named.dir) {
      expandParents(h);
      activate(named);
    } else if (mainMode !== 'file' || h !== cur?.stat.path) {
      openFile(h);
    }
  } else if (old[h]) {
    targetDir = old[h];
    openFolder(old[h]);
  } else if (h === 'schems' || h.startsWith('schem=')) {
    openSchems(h.startsWith('schem=') ? h.slice(6) : ''); // an old #schem=<id> finds no post: the board
  } else if (h.startsWith('folder=')) {
    // #folder=<path>, or #folder=<path>&item=<name> to point at one file (Open folder).
    // Split before decoding, so an "&" in a name can't pass for the separator.
    const [path, item] = raw.slice(7).split('&item=').map(dec);
    if (item) {
      expandParents(path + '/' + item);
      focused = path + '/' + item;
    }
    targetDir = path;
    openFolder(path, item ?? '');
  } else if (h.startsWith('live=')) {
    // #live=<name>: watch their screen.
    setMode('live');
    void watchStream(h.slice(5));
  } else if (h.startsWith('stream=')) {
    // #stream=<name>: watch the stream they send to the stream relay.
    setMode('live');
    void watchRelay(h.slice(7));
  } else if (h.startsWith('chan=')) {
    // #chan=<name>, or #chan=<name>&msg=<id> for one message (Copy Link).
    const [name, msg] = h.slice(5).split('&msg=');
    if (msg) openInMain(name, msg);
    else if (mainMode !== 'chat' || mainChannel() !== name) openInMain(name);
  } else if (h) {
    // A folder link acts like clicking the folder.
    const dir = entries.find((e) => e.dir && e.path === h);
    if (dir) {
      expandParents(h);
      activate(dir);
    } else if (mainMode !== 'file' || h !== cur?.stat.path) {
      openFile(h); // follows moves if the link is old
    }
  }
}

// ---- right-hand chat panel: hide/show and resize ----

// A window 701–900 px wide (snapped to half a small screen, or zoomed in) folds the chat
// panel to its strip, as if hidden, so the main panel keeps room; wider, it comes back.
// Showing it by hand there keeps it open until the window leaves that range.
const narrow = () => window.innerWidth > 700 && window.innerWidth <= 900;

function setupChatPanel() {
  let hidden = load('mt-chat-hidden') === '1'; // your choice
  let openedNarrow = false;
  const apply = () => {
    const shut = hidden || (narrow() && !openedNarrow);
    document.body.classList.toggle('chat-hidden', shut);
    $('chat-hide').innerHTML = shut ? GLYPH.panelOpen : GLYPH.panelClose;
    $('chat-hide').title = shut ? 'Show the chat panel' : 'Hide the chat panel';
    layoutChanged();
  };
  apply();
  $('chat-hide').onclick = () => {
    const shut = document.body.classList.contains('chat-hidden');
    hidden = !shut;
    openedNarrow = shut && narrow();
    store('mt-chat-hidden', hidden ? '1' : '');
    apply();
  };

  // Both side panels resize by dragging their inner edge; the main panel keeps at least
  // 320 px, also when the window gets smaller. Double-click goes back to the default width.
  const fits = [
    resizer('chat-resize', '--chat-w', 'mt-chat-w', 240, (x) => window.innerWidth - x, () => $('side').offsetWidth),
    resizer('side-resize', '--side-w', 'mt-side-w', 160, (x) => x, () => $('chat').offsetWidth),
  ];
  let wasNarrow = narrow();
  window.addEventListener('resize', () => {
    if (narrow() !== wasNarrow) {
      wasNarrow = narrow();
      openedNarrow = false;
      apply();
    }
    for (const fit of fits) fit();
  });
}

// resizer makes a side panel's edge draggable. It returns fit, which narrows the panel if
// the window no longer has room for it beside a 320 px main panel.
function resizer(id: string, prop: string, key: string, min: number, widthAt: (x: number) => number, other: () => number) {
  const setWidth = (w: number) => {
    const max = Math.max(min, window.innerWidth - other() - 320);
    w = Math.round(Math.min(Math.max(w, min), max));
    document.body.style.setProperty(prop, `${w}px`);
    return w;
  };
  const saved = Number(load(key));
  if (saved) setWidth(saved);
  const handle = $(id);
  handle.onpointerdown = (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
  };
  handle.onpointermove = (e) => {
    if (handle.hasPointerCapture(e.pointerId)) setWidth(widthAt(e.clientX));
  };
  handle.onpointerup = (e) => {
    handle.releasePointerCapture(e.pointerId);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    store(key, String(setWidth(widthAt(e.clientX))));
    layoutChanged();
  };
  handle.ondblclick = () => {
    document.body.style.removeProperty(prop);
    store(key, '');
    layoutChanged();
  };
  return () => {
    const w = parseInt(document.body.style.getPropertyValue(prop));
    if (w) setWidth(Math.max(w, Number(load(key)) || 0)); // back up to your width when there's room again
  };
}

// ---- live updates ----

async function onFilesChanged() {
  await refreshTree().catch(() => {});
  const c = cur;
  if (!c || (c.mode !== 'edit' && c.mode !== 'view')) return;
  const r = await req('GET', `/api/stat/${enc(c.stat.path)}`).catch(() => null);
  if (!r || cur !== c) return;
  if (r.status === 404) {
    const now = movedTo(c.stat.path);
    if (now && now.path !== c.stat.path) return followMove(c, now.path, now.by ?? 'Someone');
    banner(isMedia(c) ? 'Someone deleted this file.' : 'Someone deleted this file. Saving will offer to recreate it.');
    return;
  }
  const s: Stat = await r.json();
  if (s.rev === c.stat.rev) return;
  if (!dirty()) {
    await openFile(c.stat.path, true);
    toast('Updated to the latest version');
  } else {
    banner('Someone saved a newer version. When you save, you’ll see both versions side by side.');
  }
}

// followMove keeps the open file open after someone else renames or moves it. Unsaved
// edits come along if the file is otherwise unchanged; if it changed too, saving shows
// the usual side-by-side conflict.
async function followMove(c: Open, to: string, by: string) {
  const from = c.stat.path;
  const what = `${by} moved this file to ${to}`;
  if (!dirty()) {
    await openFile(to, true);
    if (by !== user.name) toast(what, 4000); // your own move, from another tab or this one
    return;
  }
  const s = await req('GET', `/api/stat/${enc(to)}`);
  if (!s.ok || cur !== c) return;
  const stat: Stat = await s.json();
  const [mine, theirs] = await Promise.all([
    req('GET', fileURL(from, c.stat.rev)).then((r) => r.text()),
    req('GET', fileURL(to, stat.rev)).then((r) => r.text()),
  ]);
  if (cur !== c) return;
  c.stat.path = to;
  if (mine === theirs) {
    c.stat.rev = stat.rev; // only the name changed: keep editing, save normally
    toast(`${what}. Your unsaved changes came along.`, 5000);
  } else {
    banner(`${what} and changed it. When you save, you’ll see both versions side by side.`);
  }
  history.replaceState(null, '', '#' + encodeURIComponent(to));
  expandParents(to);
  renderToolbar();
  renderTree();
}

// Phones get chat only; a file link there downloads the file (or shows an image).
const isPhone = () => matchMedia('(max-width: 700px)').matches;
function openOnPhone(p: string) {
  const image = /\.(png|jpe?g|gif|webp)$/i.test(p);
  if (image) window.open(fileURL(p), '_blank');
  else location.href = fileURL(p, '', true);
}

// ---- wiring ----

function setup() {
  $('user').onclick = accountMenu;
  $('files-head').onclick = () => {
    targetDir = '';
    focused = '';
    openFolder('');
    renderTree();
  };
  $('new-file').onclick = newFile;
  $('new-folder').onclick = newFolder;
  $('collapse-all').onclick = collapseAll;
  const input = $('upload-input') as HTMLInputElement;
  $('upload').onclick = () => input.click();
  input.onchange = () => {
    upload([...(input.files ?? [])], targetDir);
    input.value = '';
  };

  const tree = $('tree');
  tree.onkeydown = treeKey;
  tree.oncontextmenu = (e) => {
    e.preventDefault();
    treeMenu(e, null);
  };
  // Drops: tree rows move (into a folder; a closed one opens after a moment), files from
  // the computer upload.
  let hoverTimer = 0;
  let hoverDir: string | null = null;
  const internal = (e: DragEvent) => !!e.dataTransfer?.types.includes('text/x-mt-path');
  const canMoveTo = (dir: string) =>
    dragPath && !AREAS.includes(dragPath) && dir !== dirName(dragPath) && dir !== dragPath && !dir.startsWith(dragPath + '/');
  tree.ondragover = (e) => {
    const dir = dropDirAt(e.target);
    const ok = dir !== null && (internal(e) ? canMoveTo(dir) : !!e.dataTransfer?.types.includes('Files'));
    if (dir === null || !ok) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      showDrop(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = internal(e) ? 'move' : 'copy';
    showDrop(dir);
    if (dir !== hoverDir) {
      hoverDir = dir;
      clearTimeout(hoverTimer);
      if (dir && !expanded.has(dir)) {
        hoverTimer = window.setTimeout(() => {
          setExpanded(dir, true);
          renderTree();
          showDrop(dir);
        }, 600);
      }
    }
  };
  const endDrag = () => {
    clearTimeout(hoverTimer);
    hoverDir = null;
    showDrop(null);
  };
  tree.ondragleave = (e) => {
    if (!tree.contains(e.relatedTarget as Node)) endDrag();
  };
  tree.ondrop = (e) => {
    e.preventDefault();
    const dir = dropDirAt(e.target);
    endDrag();
    if (dir === null) return;
    if (internal(e)) {
      if (canMoveTo(dir)) movePath(dragPath, (dir ? dir + '/' : '') + baseName(dragPath));
    } else {
      upload([...(e.dataTransfer?.files ?? [])], dir);
    }
    dragPath = '';
  };
  // A drag that ends anywhere (including the chat box) clears the tree's drag state.
  document.addEventListener('dragend', () => {
    dragPath = '';
    endDrag();
  });

  for (const ev of ['mousedown', 'resize', 'blur'] as const) {
    window.addEventListener(ev, (e) => {
      if (!(e.target instanceof Node && ($('menu').contains(e.target) || (ev === 'mousedown' && inMenuAnchor(e.target))))) closeMenu();
    });
  }
  // Esc with a menu open only closes the menu (caught first, before anything else's Esc).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('menu').hidden) return;
    closeMenu();
    e.stopPropagation();
  }, true);
  // A file on its own: Esc goes back to its folder, and on a picture or video ←/→ step
  // through the folder. Not while typing (the editor included), or while the full-window
  // viewer has the keys.
  window.addEventListener('keydown', (e) => {
    if (mainMode !== 'file' || !cur || cur.mode === 'conflict' || viewerOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (typing(e)) return;
    if (e.key !== 'Escape' && t.closest('#tree')) return; // the tree has its own arrow keys
    const folder = dirName(cur.stat.path);
    if (e.key === 'ArrowLeft' && isMedia(cur)) stepMedia(-1);
    else if (e.key === 'ArrowRight' && isMedia(cur)) stepMedia(1);
    else if (e.key === 'Escape' && folder) backToFolder(folder);
    else return;
    e.preventDefault();
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
  window.addEventListener('hashchange', openHash);
  // Ctrl + wheel over a text file: its text size (rather than the whole page's).
  $('view').addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !cur?.model || (cur.mode !== 'view' && cur.mode !== 'edit')) return;
    e.preventDefault();
    e.stopPropagation();
    setZoom(zoom + (e.deltaY < 0 ? 10 : -10));
  }, { capture: true, passive: false });
  window.addEventListener('beforeunload', (e) => {
    if (dirty() || uploading) e.preventDefault();
  });

  // Live updates: files changed (here or over ssh) and chat. Live reconnects by itself, even
  // after Caddy's 502s while the hub restarts; on every (re)connect, catch up on anything missed.
  const events = new Live('/api/events');
  // A page parked in the back/forward cache would keep its stream open, and browsers allow
  // only 6 connections per server over http, so close it; coming back reloads the page.
  window.addEventListener('pagehide', () => events.close());
  window.addEventListener('pageshow', (e) => e.persisted && location.reload());
  events.addEventListener('files', onFilesChanged);
  events.addEventListener('open', onFilesChanged);
  // The server ends the stream when your session ends (banned, deleted, a new password) or
  // your role changes: reload, which shows the login form (saying why) or the new role.
  events.addEventListener('ended', () => {
    if (loggingOutOthers) return void (loggingOutOthers = false);
    location.reload();
  });
  // A stream that ended some other way and is refused on reconnect: the browser gives up.
  // Reload if the session is really gone.
  events.addEventListener('error', async () => {
    if (events.readyState === EventSource.CLOSED && (await fetch('/api/me')).status === 401) location.reload();
  });
  // Accounts changed: new names for @-mentions and tags, and the Admin page if it's open.
  events.addEventListener('users', async () => {
    setAccounts(await json(await req('GET', '/api/users')));
    adminChanged();
    chatUsersChanged();
  });
  setupChat(events, {
    // A link to a schematic post's folder opens the post; to another folder, the folder view.
    openPath: (p) => {
      const post = schemPost(p);
      if (post) return openSchems(post.dir);
      const dir = entries.find((e) => e.dir && e.path === p);
      if (dir) {
        expandParents(p);
        return activate(dir);
      }
      return isPhone() ? openOnPhone(p) : openFile(p);
    },
    resolvePath: (p) => movedTo(p)?.path ?? null,
    showMainChat,
    mainShowsChat: () => mainMode === 'chat',
    showSidePanel: () => document.body.classList.contains('chat-hidden') && $('chat-hide').click(),
    schemPost,
    fileMod: (p) => entries.find((e) => e.path === p && !e.dir)?.mod ?? null,
    send: (url, f, progress) => put(url, f, progress, 'POST'),
    stampName: (f) => stampName(Date.now(), f.name.slice(f.name.lastIndexOf('.')), () => false),
    uploadInto,
    folders: () => entries.filter((e) => e.dir).map((e) => e.path),
    currentFolder: () => targetDir,
    // Open folder (chat viewer): the file's single preview (its way back leads to the folder),
    // shown in the tree too.
    revealMedia: (p) => {
      expandParents(p);
      focused = p;
      targetDir = dirName(p);
      openFile(p);
    },
  });
  setupVoice(events);
  setupStreams(events, { leave: showFileArea, show: () => setMode('live') });
  setupChatPanel();
  setupSearch({
    // An address the page is already at doesn't fire hashchange: open it anyway.
    go: (hash) => {
      const before = location.hash;
      location.hash = hash;
      if (location.hash === before) openHash();
    },
    openAt: (p, line, words) => {
      if (isPhone()) return openOnPhone(p);
      openFile(p, false, true, { line, words });
    },
    folders: () => entries.filter((e) => e.dir).map((e) => e.path),
  });
  setupSchems(events, {
    show: showSchems, shown: () => mainMode === 'schems', forward: shareLink, changed: chatFilesChanged,
    openFolder: (p) => {
      expandParents(p + '/x');
      targetDir = p;
      openFolder(p);
    },
  });
  setupFolder({
    // A folder's date is its newest file's, however deep (the folder view sorts by it).
    list: (dir) => entries.filter((e) => dirName(e.path) === dir).map((e) => (!e.dir ? e
      : { ...e, mod: entries.reduce((t, x) => (!x.dir && x.path.startsWith(e.path + '/') ? Math.max(t, x.mod ?? 0) : t), 0) })),
    show: () => setMode('folder'),
    open: (dir) => {
      targetDir = dir;
      openFolder(dir);
    },
    openFile,
    upload,
    manager: () => openSchems(''),
    post: (dir) => {
      const p = schemPost(dir);
      return p && (() => openSchems(p.dir));
    },
    make: async (p, folder) => {
      if (!await makeEntry(p, folder)) return false;
      focused = p;
      await refreshTree();
      renderTree();
      if (!folder) openFile(p);
      return true;
    },
    menu: (ev, p) => {
      const e = entries.find((x) => x.path === p);
      if (e) treeMenu(ev, e, true);
    },
  });

  $('user').textContent = user.name;
  $('user').hidden = false;
  loadIcons().then(refreshTree).then(() => {
    render();
    // The bare address opens on #general, not an empty file area (in place, so Back has no
    // empty page to go to).
    if (location.hash.length <= 1) history.replaceState(null, '', '#chan=general');
    openHash();
  });
}

// start logs in if needed, learns who you are and who else has an account, then builds
// the page (events and all, which need the session).
async function start() {
  let r = await fetch('/api/me');
  if (r.status === 401) {
    const why = (await r.json().catch(() => ({}))).error;
    await login(why === 'this account is banned' ? why : '');
    r = await fetch('/api/me');
  }
  Object.assign(user, await json<typeof user>(r));
  if (user.temp) {
    await new Promise<void>((done) => changePassword(done));
    user.temp = undefined;
  }
  setAccounts(await json(await fetch('/api/users')));
  setup();
}

start();
