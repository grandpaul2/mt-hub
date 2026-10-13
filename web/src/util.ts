// Helpers shared by the file side (main.ts) and chat (chat.ts).
import DOMPurify from 'dompurify';

// Who you're logged in as (set by the login in main.ts before anything else runs), and
// every account, for admin tags and @-mentions. Admins are set in users.json on the server.
export const user: { name: string; admin: boolean; owner: boolean; mc?: string; temp?: boolean } = { name: '', admin: false, owner: false };
// tag is an admin's tag colour (one of TAG_COLOURS).
export let accounts: { name: string; admin: boolean; tag?: string }[] = [];
export const setAccounts = (a: typeof accounts) => (accounts = a);
export const isAdmin = (name: string) => accounts.some((a) => a.name === name && a.admin);

// An admin's tag: "op" in their tag colour (style guide 3.1, --tag-*). Chat and the Admin page
// draw the same one.
export const TAG_COLOURS = ['purple', 'gold', 'blue', 'teal', 'green', 'orange', 'red', 'pink', 'grey'];
export const opTag = (colour = 'purple') => h('span', { class: `tag op t-${colour}` }, 'op');
export const tagOf = (name: string) => accounts.find((a) => a.name === name)?.tag;

// labels names things for the other modules: chat.ts sets chat (a DM is named by its people).
export const labels = { chat: (name: string) => '# ' + name };

export function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window */ }
}

export const $ = (id: string) => document.getElementById(id)!;

// cleanHTML is member-written HTML (a rendered Markdown file or schematic description), safe
// to put in the page. DOMPurify takes out script; this also takes out what could act for the
// reader or pass for the hub's own controls: forms and their fields (a form submits as
// whoever clicks it), style blocks and inline styles (a see-through button over the whole
// page), and id/name/class (the page finds its own parts by id). Task-list checkboxes stay,
// switched off.
const NO_TAGS = ['form', 'button', 'textarea', 'select', 'option', 'optgroup', 'fieldset', 'label', 'datalist', 'output', 'dialog', 'style'];
const NO_ATTRS = ['id', 'name', 'class', 'style', 'form', 'formaction', 'action', 'method', 'enctype'];
export function cleanHTML(html: string): DocumentFragment {
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: NO_TAGS, FORBID_ATTR: NO_ATTRS, RETURN_DOM_FRAGMENT: true });
  for (const input of clean.querySelectorAll('input')) {
    if (input.getAttribute('type') === 'checkbox') input.disabled = true;
    else input.remove();
  }
  return clean;
}


// volumeCurve turns a volume slider's 0..100 into a gain: cubic, like the system's volume
// (PulseAudio's), so 50% sounds about half as loud rather than barely quieter.
export const volumeCurve = (v: number) => (v / 100) ** 3;

// Stroke icons (Lucide, ISC licence) for buttons that used text glyphs (style guide 6.1: no
// ◀ ▶ ✕ » « as icons). play is filled, to sit on pictures.
const icon = (body: string, fill = 'none') =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const GLYPH = {
  left: icon('<path d="m15 18-6-6 6-6"/>'),
  right: icon('<path d="m9 18 6-6-6-6"/>'),
  up: icon('<path d="m18 15-6-6-6 6"/>'),
  down: icon('<path d="m6 9 6 6 6-6"/>'),
  close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  more: icon('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  play: icon('<polygon points="6 3 20 12 6 21 6 3"/>', 'currentColor'),
  check: icon('<path d="M20 6 9 17l-5-5"/>'),
  panelClose: icon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>'),
  panelOpen: icon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 15-3-3 3-3"/>'),
};

// typing: a key or paste is going into a text box (or the editor), so page shortcuts leave it
// alone (style guide 10).
export const typing = (e: Event) => !!(e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable], .monaco-editor');

// go puts a place you moved to (a file, folder, chat, post) in the address, as a new history
// entry, so the browser's Back and Forward (and Alt+←/→, the mouse's back button) step
// through where you've been. The same place again adds nothing: re-renders don't pile up
// entries. Corrections (a renamed chat, a moved file) use history.replaceState instead.
export function go(hash: string) {
  const url = hash.replace(/^#$/, '') || location.pathname;
  if (sameHash(location.hash, hash)) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

const sameHash = (a: string, b: string) => {
  const d = (x: string) => {
    try {
      return decodeURIComponent(x.replace(/^#/, ''));
    } catch {
      return x;
    }
  };
  return d(a) === d(b);
};

// glyphs is text with the symbols our fonts lack drawn as small icons: ← → ↑ ↓ and ●.
// Noto Sans and JetBrains Mono have none of them (Noto's CSS claims ↑ ↓, the file doesn't),
// so the browser borrowed a system font, whose taller lines pushed a button's text down in
// Firefox. The character stays in the text, hidden, so textContent still reads it.
const GLYPHS: Record<string, string> = {
  '←': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  '→': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  '↑': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  '↓': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  '●': '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
};
export function glyphs(text: string): Node[] {
  return text.split(/([←→↑↓●])/).filter(Boolean).map((part) => {
    if (!GLYPHS[part]) return document.createTextNode(part);
    const icon = document.createElement('span');
    icon.className = 'glyph';
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[part]}</svg>`;
    const ch = document.createElement('span');
    ch.hidden = true;
    ch.textContent = part;
    icon.append(ch);
    return icon;
  });
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = String(v);
    else (el as any)[k] = v;
  }
  el.append(...kids);
  return el;
}

// loadBundle fetches one of the page's big optional parts (the editor, voice) the first time
// it's needed: /<name>.js, plus /<name>.css if css, which hands itself over as
// window[name]. Each loads once; a failed load can be tried again.
const bundles = new Map<string, Promise<unknown>>();
export function loadBundle<T>(name: string, css = false): Promise<T> {
  let p = bundles.get(name) as Promise<T> | undefined;
  if (!p) {
    p = new Promise<T>((ok, fail) => {
      if (css) document.head.append(h('link', { rel: 'stylesheet', href: `/${name}.css` }));
      const s = h('script', { src: `/${name}.js` });
      s.onload = () => ok((window as unknown as Record<string, T>)[name]);
      s.onerror = () => {
        bundles.delete(name);
        s.remove();
        fail(new Error(`couldn’t load ${name}.js`));
      };
      document.head.append(s);
    });
    bundles.set(name, p);
  }
  return p;
}

export const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
export const fileURL = (p: string, rev = '', download = false) =>
  `/api/file/${enc(p)}?rev=${rev}${download ? '&download=1' : ''}`;
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${(n / (1 << 30)).toFixed(2)} GB`;
}

// Dates and times, one way everywhere (style guide 8): "Oct 2" this year, "Oct 2, 2025"
// before; the time of day; both ("Oct 2, 3:04 PM"); the full date and time for hovers.
// Relative times (ago) only for "last seen" and history.
type When = string | number | Date;
export function date(t: When) {
  const d = new Date(t);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: thisYear ? undefined : 'numeric' });
}
export const time = (t: When) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const dateTime = (t: When) => `${date(t)}, ${time(t)}`;
export const fullDate = (t: When) => new Date(t).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });

export function ago(t: When) {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  const n = (x: number, unit: string) => `${x} ${unit}${x === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return n(Math.floor(s / 3600), 'hour');
  if (s < 7 * 86400) return n(Math.floor(s / 86400), 'day');
  return date(t);
}

// req is a call to the API. A 401 means the session ended (logged out in another tab, or a
// new password): reloading shows the login form. When the hub can't be reached (no network,
// or Caddy's own 502/504 while it restarts) it answers like a failed call, so callers say
// "Couldn't …" as usual, and the connection line goes up.
//
// renews marks a call that swaps this page's session for a new one (a new password, Log Out
// Everywhere). From the moment the hub does that until the answer brings the new cookie, the
// hub refuses the old one. A call refused in that gap hasn't lost its session: it goes again
// once the answer is in (renewed counts those answers, for a call whose refusal comes after).
let renewing: Promise<unknown> | null = null;
let renewed = 0;
export async function req(method: string, url: string, body?: BodyInit, renews = false): Promise<Response> {
  const before = renewed;
  const sent = fetch(url, { method, body }).catch(() => null);
  if (renews) renewing = sent;
  const r = await sent;
  if (renews) {
    renewed++;
    if (renewing === sent) renewing = null;
  }
  if (!r || unreachable(r)) {
    connection(false);
    return new Response(JSON.stringify({ error: 'can’t reach the hub' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  connection(true);
  if (r.status === 401) {
    if (!renews && (renewing || renewed !== before)) {
      await renewing;
      return req(method, url, body);
    }
    location.reload();
  }
  return r;
}

// unreachable: a gateway error that isn't the hub's own (those are JSON, like voice's 503).
export const unreachable = (r: Response) =>
  [502, 503, 504].includes(r.status) && !r.headers.get('Content-Type')?.includes('application/json');

// Live is the hub's live updates (/api/events). A browser's EventSource retries a dropped
// stream by itself, but gives up for good on an error status, which Caddy sends while the
// hub restarts: then Live starts a new one, with every listener, so the page stays live.
export class Live {
  private es!: EventSource;
  private listeners: [string, EventListener][] = [];
  private retry = 0;
  private closed = false;
  constructor(private url: string) {
    this.start();
  }
  private start() {
    this.es = new EventSource(this.url);
    for (const [type, f] of this.listeners) this.es.addEventListener(type, f);
    this.es.addEventListener('open', () => connection(true));
    this.es.addEventListener('error', () => {
      connection(false);
      if (this.es.readyState !== EventSource.CLOSED || this.closed) return;
      clearTimeout(this.retry);
      this.retry = window.setTimeout(() => this.start(), 3000);
    });
  }
  get readyState() {
    return this.es.readyState;
  }
  addEventListener(type: string, f: (e: MessageEvent) => void) {
    this.listeners.push([type, f as EventListener]);
    this.es.addEventListener(type, f as EventListener);
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.es.close();
  }
}

let downTimer = 0;
// connection shows or hides the connection line (style guide 6.7). It waits 2 s before
// showing, so a blip doesn't flash it.
export function connection(up: boolean) {
  const line = $('offline');
  if (up) {
    clearTimeout(downTimer);
    downTimer = 0;
    line.hidden = true;
  } else if (!downTimer && line.hidden) {
    downTimer = window.setTimeout(() => (line.hidden = false), 2000);
  }
}

export async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).trim()}`);
  return r.json();
}

// thumbOr makes a thumbnail fall back to the picture itself (too big to make a thumbnail of),
// then to fallback() (not a picture after all), rather than a broken-image box.
export function thumbOr(img: HTMLImageElement, full: string, fallback: () => Node) {
  img.addEventListener('error', () => {
    if (img.src !== new URL(full, location.href).href) img.src = full;
    else img.replaceWith(fallback());
  });
  return img;
}

let toastTimer = 0;
// toast shows a message (style guide 6.7): info for 2.5 s; 0 keeps it up until the next one
// (progress). A new one replaces it.
export function toast(msg: string, ms = 2500) {
  show(msg, ms, false);
}

// toastError is the error kind: 6 s, with a red edge.
export function toastError(msg: string) {
  show(msg, 6000, true);
}

// toastUndo is the one toast with a button: what was just moved to the Trash can be put back
// from it. 6 s, long enough to reach for.
export function toastUndo(msg: string, undo: () => void) {
  show(msg, 6000, false);
  const b = h('button', { class: 'toast-act', type: 'button' }, 'Undo');
  b.onclick = () => {
    $('toast').hidden = true;
    undo();
  };
  $('toast').append(b);
}

function show(msg: string, ms: number, error: boolean) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

// dialog opens the dialog with this content (style guide 6.5): focus goes to the first box
// (else the confirm button, the last in .actions). Esc closes it, unless keep is set (the
// login). onClose runs however it closes.
export function dialog(...kids: (Node | string)[]) {
  openDialog({}, ...kids);
}

export function openDialog(o: { wide?: boolean; keep?: boolean; cls?: string; onClose?: () => void }, ...kids: (Node | string)[]) {
  const d = $('dialog');
  closing?.();
  closing = o.onClose ?? null;
  d.className = [o.wide ? 'wide' : '', o.cls ?? ''].join(' ').trim();
  d.onkeydown = null; // a dialog's own keys (set after this) don't outlive it
  d.dataset.keep = o.keep ? '1' : '';
  d.replaceChildren(...kids);
  // Remember where the keys were, to give them back on closing (style guide 12).
  if ($('overlay').hidden) opener = pickedFrom ?? (document.activeElement as HTMLElement | null);
  $('overlay').hidden = false;
  // The first text box takes the keys (not a slider: it would just show a focus ring), else
  // the confirm button, else the close X, else the dialog itself: never the page behind.
  const first = d.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=range]), textarea') ??
    d.querySelector<HTMLElement>('.actions button:last-child') ?? d.querySelector<HTMLElement>('.dialog-x');
  if (first) first.focus();
  else {
    d.tabIndex = -1;
    d.focus();
  }
}

let closing: (() => void) | null = null;
let opener: HTMLElement | null = null; // what had the keys before the dialog opened
let pickedFrom: HTMLElement | null = null; // the button whose menu item is opening a dialog

// Tab stays in the open dialog: past the last control it comes round to the first.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || $('overlay').hidden) return;
  const d = $('dialog');
  const all = [...d.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  if (!all.length) return void e.preventDefault();
  const i = all.indexOf(document.activeElement as HTMLElement);
  if (i < 0 || (e.shiftKey && i === 0) || (!e.shiftKey && i === all.length - 1)) {
    e.preventDefault();
    (e.shiftKey ? all[all.length - 1] : all[0]).focus();
  }
}, true);

// ---- settings dialogs (style guide 6.8) -----------------------------------------------
// Admin, Voice settings and Sound settings: 520 px, a header with the title and a close X,
// then groups of rows. Their settings apply at once, so there's no Done or Save (Esc and
// the X close them).

export function settingsDialog(title: string, kids: (Node | string)[], onClose?: () => void) {
  const x = h('button', { type: 'button', class: 'icon-btn dialog-x', title: 'Close (Esc)', innerHTML: GLYPH.close });
  x.setAttribute('aria-label', 'Close');
  x.onclick = closeDialog;
  openDialog({ cls: 'settings', onClose }, h('div', { class: 'dialog-head' }, h('h2', {}, title), x), ...kids);
}

// group is a titled set of rows: a small uppercase heading, then the rows.
export const group = (title: string, ...rows: (Node | string)[]) => h('section', { class: 'set-group' }, h('h3', {}, title), ...rows);

// row is one setting: its title, and a muted line saying what it does, on the left; the
// control(s) on the right; below (optional) something the full width (a meter).
export function row(title: string | Node, sub: string | Node | null, control: (Node | string)[], below?: Node) {
  return h('div', { class: 'set-row' },
    h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, title), sub ? h('div', { class: 'set-sub' }, sub) : ''),
    h('div', { class: 'set-control' }, ...control),
    below ?? '');
}

// toggle is an on/off switch for a setting that applies at once (a checkbox is only for
// picking from a list before a confirm button). Click, Space or Enter flips it.
export function toggle(on: boolean, label: string, change: (on: boolean) => void) {
  const b = h('button', { type: 'button', class: 'switch' }, h('span', { class: 'knob' }));
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  b.setAttribute('aria-label', label);
  b.onclick = () => {
    const now = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(now));
    change(now);
  };
  return b;
}

// readout is a slider's value, in a fixed width so "+24 dB" or "100%" never wraps.
export const readout = () => h('span', { class: 'readout' });

export function closeDialog() {
  const done = closing;
  closing = null;
  $('overlay').hidden = true;
  $('dialog').className = '';
  $('dialog').replaceChildren();
  $('dialog').removeAttribute('tabindex');
  done?.();
  if (opener?.isConnected && document.activeElement === document.body) opener.focus();
  opener = null;
}

// Esc closes the dialog on top (not the login). Caught first, so nothing underneath (a
// folder's Esc, a file's) acts on it too. A box in the dialog with its own use for Esc (one
// typed in a row, which Esc puts away) is marked data-esc and gets the key instead.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('overlay').hidden || $('dialog').dataset.keep) return;
  if ((e.target as HTMLElement | null)?.closest?.('#dialog [data-esc]')) return;
  e.preventDefault();
  e.stopPropagation();
  closeDialog();
}, true);

// ask is the one way to confirm something (style guide 6.6): a dialog whose title is the
// question, a body saying what's lost and what stays, Cancel, and a confirm button named for
// the action, red when it destroys. An optional tick box (check) is read back from it. Esc
// or Cancel answers false.
export function ask(o: { title: string; body?: string | Node; confirm: string; danger?: boolean; check?: { label: string | Node; value: boolean } }): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const yes = h('button', { class: o.danger ? 'danger' : 'primary' }, o.confirm);
    const no = h('button', {}, 'Cancel');
    const box = o.check && h('input', { type: 'checkbox', checked: o.check.value });
    yes.onclick = () => {
      answer = true;
      if (o.check && box) o.check.value = box.checked;
      closeDialog();
    };
    no.onclick = () => closeDialog();
    openDialog({ cls: 'ask', onClose: () => resolve(answer) },
      h('h2', {}, o.title),
      o.body ? (typeof o.body === 'string' ? h('p', {}, o.body) : o.body) : '',
      o.check && box ? h('label', { class: 'check' }, box, h('span', {}, o.check.label)) : '',
      h('div', { class: 'actions' }, no, yes));
    yes.focus();
  });
}

// dragData is what a dragged file or folder carries: its own path (what chat and the tree
// have always read) and, when a selection is dragged with it, every path in it. Several
// drag as a small "3 items" label.
export function dragData(e: DragEvent, path: string, paths: string[]) {
  e.dataTransfer?.setData('text/x-mt-path', path);
  e.dataTransfer?.setData('text/x-mt-paths', JSON.stringify(paths));
  if (paths.length < 2) return;
  const ghost = h('div', { class: 'drag-ghost' }, `${paths.length} items`);
  document.body.append(ghost);
  e.dataTransfer?.setDragImage(ghost, -12, -8);
  setTimeout(() => ghost.remove());
}

// draggedPaths reads them back at the drop.
export function draggedPaths(e: DragEvent): string[] {
  try {
    const all = JSON.parse(e.dataTransfer?.getData('text/x-mt-paths') || '[]');
    if (Array.isArray(all) && all.length) return all.map(String);
  } catch { /* not ours */ }
  const one = e.dataTransfer?.getData('text/x-mt-path');
  return one ? [one] : [];
}

// copyText works on plain http too, where navigator.clipboard doesn't exist.
export function copyText(text: string) {
  const ta = h('textarea', { value: text });
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  toast('Copied');
}

// MenuItem is a right-click menu entry: label, action, and a shortcut shown on the right.
// null draws a separator.
// [label, action, shortcut shown on the right, why it's greyed out (greyed out if given), extras]
// extras: danger draws it in red text (destructive, style guide 3.3); confirm makes the
// first click only ask (the label becomes confirm, e.g. "Ban? Click again", the menu stays
// open) and a second click within 3 seconds act (6.6); checked ticks the one in use, where
// the items are a choice (the folder view's sort).
export type MenuExtras = { danger?: boolean; confirm?: string; checked?: boolean };
// An element is shown as it is (the voice menu's volume slider); the arrow keys skip it.
export type MenuItem = [string, () => void, string?, string?, MenuExtras?] | null | HTMLElement;

let menuAnchor: HTMLElement | null = null; // the button that opened the menu, if one did

// showMenu opens the right-click menu at the pointer, kept on screen. Clicking elsewhere,
// Esc, resizing or leaving the window closes it (wired in main.ts). A menu opened by a
// button (anchor) closes when that button is clicked again.
export function showMenu(ev: MouseEvent, items: MenuItem[], anchor?: HTMLElement) {
  const menu = $('menu');
  if (anchor && !menu.hidden && menuAnchor === anchor) return closeMenu();
  menuAnchor = anchor ?? null;
  menu.replaceChildren(...items.map((it) => {
    if (!it) return h('div', { class: 'sep' });
    if (it instanceof HTMLElement) return it;
    const b = h('button', {}, h('span', {}, it[0]), h('span', { class: 'key' }, it[2] ?? ''));
    if (it[3]) {
      b.disabled = true;
      b.title = it[3];
    }
    const extras = it[4] ?? {};
    if (extras.danger) b.classList.add('danger');
    if (extras.checked) b.lastElementChild!.innerHTML = GLYPH.check;
    let timer = 0;
    b.onclick = () => {
      if (extras.confirm && !b.classList.contains('arm')) {
        b.classList.add('arm');
        b.firstElementChild!.textContent = extras.confirm;
        timer = window.setTimeout(() => {
          b.classList.remove('arm');
          b.firstElementChild!.textContent = it[0];
        }, 3000);
        return;
      }
      clearTimeout(timer);
      // A dialog the item opens gives the keys back to the menu's button when it closes.
      pickedFrom = menuAnchor;
      setTimeout(() => (pickedFrom = null), 1000);
      closeMenu();
      it[1]();
    };
    return b;
  }));
  menu.hidden = false;
  for (const b of menu.querySelectorAll(':scope > button')) (b as HTMLElement).onmousemove = () => menuSelect(b);
  const { innerWidth: W, innerHeight: H } = window;
  menu.style.left = `${Math.min(ev.clientX, W - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(ev.clientY, H - menu.offsetHeight - 4)}px`;
}

// menuSelect highlights one item (the arrow keys and the pointer share it).
function menuSelect(b: Element | undefined) {
  for (const x of $('menu').querySelectorAll(':scope > button.on')) x.classList.remove('on');
  b?.classList.add('on');
}

// The open menu's keys (style guide 6.3): ↑/↓ move (wrapping), Home/End, Enter picks. Caught
// first, so the box or list underneath doesn't move too.
document.addEventListener('keydown', (e) => {
  const menu = $('menu');
  if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(e.key)) return;
  if ((e.target as Element | null)?.closest?.('#menu input')) return; // a slider in the menu takes its own keys
  e.preventDefault();
  e.stopPropagation();
  const items = [...menu.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')];
  const at = items.findIndex((b) => b.classList.contains('on'));
  const n = items.length;
  if (e.key === 'Enter') return items[at]?.click();
  const next = { ArrowDown: (at + 1) % n, ArrowUp: (at <= 0 ? n : at) - 1, Home: 0, End: n - 1 }[e.key as 'Home'];
  menuSelect(items[next]);
}, true);

export function closeMenu() {
  $('menu').hidden = true;
  menuAnchor = null;
}

// inMenuAnchor: n is inside the button that opened the menu (its click toggles the menu).
export const inMenuAnchor = (n: Node) => !!menuAnchor?.contains(n);
