// The full-window picture viewer, Discord style, used everywhere a picture opens full size:
// chat, the galleries, files, folder previews and schematic posts. Everything else is
// darkened; the picture fills nearly the whole window. Who posted it and when (or the file
// name) top left; zoom, forward, download, open in a new tab and close top right, plus
// "open folder" when it was opened from a chat. ←/→ step through the set, Esc closes,
// clicking the dark area closes, clicking the picture zooms (drag to pan).
import { glyphs, dateTime, h, showMenu, type MenuItem } from './util';

export type ViewItem = {
  src: string; // what to show (and download, and open in a new tab)
  name: string; // file name, for downloading
  kind?: 'image' | 'video';
  who?: string; // poster
  when?: string | number; // when it was posted (ISO time or unix ms)
  forward?: () => void; // forward it to a chat
  reveal?: () => void; // "open folder": its place in Files (only when opened from a chat)
  save?: () => void; // "save to Files": a picture posted in chat
};

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
// Lucide icons (ISC licence).
export const ICON = {
  zoomIn: svg('<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>'),
  forward: svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  newTab: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  save: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="m15 13-3 3-3-3"/>'),
  more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  edit: svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2"/>'),
  prev: svg('<path d="m15 18-6-6 6-6"/>'),
  // The folder view's bar (folder.ts).
  filePlus: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>'),
  folderPlus: svg('<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  readme: svg('<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>'),
  next: svg('<path d="m9 18 6-6-6-6"/>'),
  // Voice chats (voice.ts).
  speaker: svg('<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>'),
  mic: svg('<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>'),
  micOff: svg('<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>'),
  headphones: svg('<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>'),
  headphonesOff: svg('<path d="M21 14h-1.343"/><path d="M9.128 3.47A9 9 0 0 1 21 12v3.343"/><path d="m2 2 20 20"/><path d="M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3"/><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364"/>'),
  settings: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  hangUp: svg('<path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 4.568 14.56"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/>'),
};

let state: { items: ViewItem[]; i: number; zoomed: boolean } | null = null;
const root = h('div', { id: 'viewer', hidden: true });

export const viewerOpen = () => !!state;

export function openViewer(items: ViewItem[], index = 0, zoomed = false) {
  if (!items.length) return;
  if (!root.isConnected) {
    document.body.append(root);
    document.addEventListener('keydown', onKey, true);
  }
  state = { items, i: Math.max(0, Math.min(index, items.length - 1)), zoomed: false };
  root.hidden = false;
  render();
  if (zoomed && items[state.i].kind !== 'video') zoom();
}

// SingleBar describes the bar over one item shown on its own in the main panel: a picture or
// video, a text file, a schematic post. One look everywhere: back on the left, then the name
// and details; previous/next and the icon buttons on the right: full window, forward,
// download, open in new tab, edit, then Delete (red only on hover, as in chat) and ⋯, which
// lists the same actions. Each view turns on what applies.
export type SingleBar = {
  back?: { label: string; title: string; go: () => void };
  name: string;
  info?: string; // details after the name (when, size…)
  prev?: (() => void) | null; // undefined: no glyphs; null: at that end
  next?: (() => void) | null;
  zoom?: () => void; // full window
  forward?: () => void; // forward to a chat
  download?: { href: string; name: string };
  newTab?: string;
  edit?: () => void;
  del?: () => void;
  extra?: HTMLElement[]; // anything else (a text button), before the glyphs
};

export function singleBar(o: SingleBar) {
  const tool = (icon: string, title: string, fn: (() => void) | null, cls = '') => {
    const b = h('button', { class: 'vtool ' + cls, title, innerHTML: icon, disabled: !fn });
    if (fn) b.onclick = fn;
    return b;
  };
  const bar = h('div', { class: 'single-bar' });
  if (o.back) {
    const back = h('button', { title: o.back.title }, ...glyphs(o.back.label));
    back.onclick = o.back.go;
    bar.append(back);
  }
  bar.append(h('span', { class: 'single-name', title: o.name }, ...glyphs(o.name)));
  if (o.info) bar.append(h('span', { class: 'single-info' }, o.info));
  // The buttons, together on the right; in a narrow panel they drop below the name.
  const actions = h('div', { class: 'single-actions' }, ...(o.extra ?? []));
  bar.append(actions);
  if (o.prev !== undefined || o.next !== undefined) {
    actions.append(h('div', { class: 'viewer-tools single-nav' },
      tool(ICON.prev, 'Previous (←)', o.prev ?? null), tool(ICON.next, 'Next (→)', o.next ?? null)));
  }
  const tools = h('div', { class: 'viewer-tools' });
  if (o.zoom) tools.append(tool(ICON.zoomIn, 'Full window', o.zoom));
  if (o.forward) tools.append(tool(ICON.forward, 'Forward', o.forward));
  if (o.download) tools.append(h('a', { class: 'vtool', href: o.download.href, download: o.download.name, title: 'Download', innerHTML: ICON.download }));
  if (o.newTab) {
    const url = o.newTab;
    tools.append(tool(ICON.newTab, 'Open in new tab', () => window.open(url, '_blank', 'noopener')));
  }
  if (o.edit) tools.append(tool(ICON.edit, 'Edit', o.edit));
  if (o.del) tools.append(tool(ICON.trash, 'Delete', o.del, 'del'));
  // ⋯: the same actions as a list, like a chat message's.
  const items: MenuItem[] = [];
  if (o.zoom) items.push(['Full Window', o.zoom]);
  if (o.forward) items.push(['Forward…', o.forward]);
  if (o.download) {
    const { href, name } = o.download;
    items.push(['Download', () => h('a', { href, download: name }).click()]);
  }
  if (o.newTab) {
    const url = o.newTab;
    items.push(['Open in New Tab', () => window.open(url, '_blank', 'noopener')]);
  }
  if (o.edit) items.push(['Edit', o.edit]);
  if (o.del) items.push(null, ['Delete', o.del, undefined, undefined, { danger: true }]);
  if (items.length > 1) {
    const more = tool(ICON.more, 'More', null);
    more.disabled = false;
    more.onclick = () => {
      const r = more.getBoundingClientRect();
      showMenu({ clientX: r.left, clientY: r.bottom + 2 } as MouseEvent, items, more);
    };
    tools.append(more);
  }
  if (tools.children.length) actions.append(tools);
  return bar;
}

export function closeViewer() {
  state = null;
  root.hidden = true;
  root.replaceChildren(); // stops a playing video
}

function step(d: number) {
  if (!state) return;
  const i = state.i + d;
  if (i < 0 || i >= state.items.length) return;
  state.i = i;
  state.zoomed = false;
  render();
}

// Keys win over everything underneath (the gallery's own glyphs, Esc in the page).
function onKey(e: KeyboardEvent) {
  if (!state) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function render() {
  if (!state) return;
  const it = state.items[state.i];
  const n = state.items.length;
  const tool = (icon: string, title: string, fn: () => void, cls = '') => {
    const b = h('button', { class: 'vtool ' + cls, title, innerHTML: icon });
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    return b;
  };

  // Top left: who and when, else the file name.
  const when = it.when !== undefined ? dateTime(it.when) : '';
  const info = h('div', { class: 'viewer-info' },
    h('div', { class: 'viewer-who' }, it.who ?? it.name),
    h('div', { class: 'viewer-when' }, [when, n > 1 ? `${state.i + 1} / ${n}` : ''].filter(Boolean).join(' · ')));
  if (it.who) info.title = it.name;

  const tools = h('div', { class: 'viewer-tools' });
  if (it.kind !== 'video') {
    tools.append(tool(state.zoomed ? ICON.zoomOut : ICON.zoomIn, state.zoomed ? 'Zoom out' : 'Zoom in', () => zoom()));
  }
  if (it.forward) tools.append(tool(ICON.forward, 'Forward', () => { const f = it.forward!; closeViewer(); f(); }));
  const dl = h('a', { class: 'vtool', href: it.src, download: it.name, title: 'Download', innerHTML: ICON.download });
  dl.onclick = (e) => e.stopPropagation();
  tools.append(dl, tool(ICON.newTab, 'Open in new tab', () => window.open(it.src, '_blank', 'noopener')));
  if (it.reveal) tools.append(tool(ICON.folder, 'Open folder', () => { const r = it.reveal!; closeViewer(); r(); }));
  if (it.save) tools.append(tool(ICON.save, 'Save to Files…', () => { const r = it.save!; closeViewer(); r(); }));
  const close = tool(ICON.close, 'Close (Esc)', closeViewer, 'close');

  // The picture: fitted to the window, or at full size in a scrolling stage when zoomed.
  const stage = h('div', { class: 'viewer-stage' + (state.zoomed ? ' zoomed' : '') });
  let media: HTMLElement;
  if (it.kind === 'video') {
    media = h('video', { src: it.src, controls: true, autoplay: true });
  } else {
    const img = h('img', { src: it.src, alt: it.name, draggable: false });
    img.onclick = (e) => {
      e.stopPropagation();
      zoom(state!.zoomed ? undefined : e);
    };
    media = img;
    if (state.zoomed) pan(stage);
  }
  media.onclick ??= (e) => e.stopPropagation();
  stage.append(media);
  stage.onclick = () => (state?.zoomed ? zoom() : closeViewer());

  const kids: HTMLElement[] = [h('div', { class: 'viewer-bar' }, info, h('div', { class: 'viewer-right' }, tools, close)), stage];
  if (n > 1) {
    if (state.i > 0) kids.push(tool(ICON.prev, 'Previous (←)', () => step(-1), 'viewer-prev'));
    if (state.i < n - 1) kids.push(tool(ICON.next, 'Next (→)', () => step(1), 'viewer-next'));
  }
  root.replaceChildren(...kids);
  root.onclick = closeViewer;
}

// zoom toggles between fitted and full size. Zooming in from a click keeps the clicked spot
// under the pointer.
function zoom(e?: MouseEvent) {
  if (!state) return;
  const img = root.querySelector<HTMLImageElement>('.viewer-stage img');
  const r = img?.getBoundingClientRect();
  const fx = e && r ? (e.clientX - r.left) / r.width : 0.5;
  const fy = e && r ? (e.clientY - r.top) / r.height : 0.5;
  state.zoomed = !state.zoomed;
  render();
  if (!state.zoomed) return;
  const stage = root.querySelector<HTMLElement>('.viewer-stage')!;
  const big = stage.querySelector('img')!;
  const place = () => {
    stage.scrollLeft = big.offsetWidth * fx - stage.clientWidth / 2;
    stage.scrollTop = big.offsetHeight * fy - stage.clientHeight / 2;
  };
  if (big.complete) place();
  else big.onload = place;
}

// pan lets a zoomed picture be dragged around (a click without dragging zooms back out).
function pan(stage: HTMLElement) {
  let drag: { x: number; y: number; l: number; t: number; moved: boolean } | null = null;
  stage.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop, moved: false };
    stage.setPointerCapture(e.pointerId);
  };
  stage.onpointermove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    stage.scrollLeft = drag.l - dx;
    stage.scrollTop = drag.t - dy;
  };
  stage.onpointerup = () => {
    const moved = drag?.moved;
    drag = null;
    if (moved) stage.addEventListener('click', (e) => e.stopPropagation(), { capture: true, once: true });
  };
}
