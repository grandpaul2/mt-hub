// Search: one box in the top bar (/ or Ctrl+K from anywhere) over chat messages, schematic
// posts, file and folder names, and the text inside files. The server does the looking
// (GET /api/search, see search.go); this is the box, its dropdown and its keys.
//
// Filters, as in Discord: in:#chat or in:folder/, from:name, mentions:name,
// has:link|image|video|file|schematic|pin. Typing one suggests its values.
import { accounts, baseName, date, dirName, enc, h, json, labels, req, typing, thumbOr } from './util';
import { iconURL } from './icons';
import { stripMarkdown } from './markdown';

type ChatHit = { channel: string; id: string; user: string; t: string; text: string };
type FileHit = { path: string; dir?: boolean; mod?: number };
type TextHit = { path: string; line: number; text: string; hits: number };
type SchemHit = { dir: string; title: string; credit?: string; date: string; image?: string; mod?: number };
type Group<T> = { total: number; items: T[] | null };
type Result = {
  error?: string; words: string[];
  chat: Group<ChatHit>; files: Group<FileHit>; text: Group<TextHit>; schematics: Group<SchemHit>;
};

type Hooks = {
  go: (hash: string) => void; // open an address (#chan=…&msg=…, #schem=…, #path, …)
  openAt: (path: string, line: number, words: string[]) => void; // a text file at a line
  folders: () => string[];
};

let hooks: Hooks;
const box = h('input', { id: 'search', type: 'search', placeholder: 'Search', autocomplete: 'off', spellcheck: false });
const drop = h('div', { id: 'search-drop', hidden: true });
let rows: { el: HTMLElement; go: () => void }[] = []; // what the arrow keys step through
let at = -1;
let asked = 0; // the newest search sent; older answers are dropped
let timer = 0;
let chats: string[] = [];

const FILTERS: [string, string][] = [
  ['from:', 'messages by someone'],
  ['mentions:', 'messages that @mention someone'],
  ['in:', 'one chat (in:#general) or folder (in:schematics/)'],
  ['has:', 'link, image, video, file, schematic or pin'],
];
const HAS = ['link', 'image', 'video', 'file', 'schematic', 'pin'];
const MEDIA = /\.(png|jpe?g|gif|webp|mp4|webm|mov|m4v)$/i;

export function setupSearch(h_: Hooks) {
  hooks = h_;
  box.title = 'Search chats and files (/ or Ctrl+K)';
  const wrap = h('div', { class: 'search-wrap' }, box, drop);
  document.getElementById('user')!.before(wrap); // right side, left of your name

  box.oninput = () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 150);
  };
  box.onfocus = async () => {
    run();
    chats = (await json<{ name: string }[]>(await req('GET', '/api/channels'))).map((c) => c.name);
  };
  // Clicking anywhere else closes it (the dropdown's own clicks keep it).
  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
  // So does the keys moving elsewhere (Tab), and the window changing size under it.
  wrap.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !wrap.contains(e.relatedTarget as Node)) close();
  });
  window.addEventListener('resize', close);
  box.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (n) select(e.key === 'ArrowDown' ? (at + 1) % n : (at <= 0 ? n : at) - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (rows[at] ?? rows[0])?.go();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      box.blur();
    }
  };
  // / or Ctrl+K from anywhere, unless typing somewhere else.
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('overlay')!.hidden) return; // not behind a dialog
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey) || (e.key === '/' && !typing(e) && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      e.preventDefault();
      box.focus();
      box.select();
    }
  });
}

function close() {
  drop.hidden = true;
  rows = [];
  at = -1;
}

function select(i: number) {
  rows[at]?.el.classList.remove('on');
  at = i;
  rows[at]?.el.classList.add('on');
  rows[at]?.el.scrollIntoView({ block: 'nearest' });
}

// open runs a result: the box closes and keeps its text, ready for the next one.
function open(fn: () => void) {
  return () => {
    close();
    box.blur();
    fn();
  };
}

// The filter being typed at the end of the box, if any: key and the value so far.
function typingFilter(): [string, string] | null {
  const m = /(?:^|\s)(from|mentions|in|has):("?[^\s"]*)$/i.exec(box.value);
  return m ? [m[1].toLowerCase(), m[2].replace(/^"/, '')] : null;
}

// complete puts a value in place of the one being typed.
function complete(value: string) {
  return () => {
    const v = /\s/.test(value) ? `"${value}"` : value;
    box.value = box.value.replace(/((?:from|mentions|in|has):)"?[^\s"]*$/i, (_, key) => key + v) + ' ';
    box.focus();
    run();
  };
}

function suggestions(): HTMLElement[] {
  if (!box.value.trim()) {
    return [h('div', { class: 'search-head' }, 'Filters'), ...FILTERS.map(([k, what]) =>
      row(h('div', { class: 'search-sug' }, h('b', {}, k), h('span', { class: 'muted' }, ' ' + what)), () => {
        box.value = k;
        box.focus();
        run();
      }))];
  }
  const f = typingFilter();
  if (!f) return [];
  const [key, typed] = f;
  const t = typed.toLowerCase();
  let values: [string, string][] = []; // value, label
  if (key === 'from' || key === 'mentions') values = accounts.map((a) => [a.name, a.name]);
  else if (key === 'has') values = HAS.map((v) => [v, v]);
  else {
    values = [...chats.map((c): [string, string] => ['#' + c, labels.chat(c)]),
      ...hooks.folders().map((d): [string, string] => [d + '/', d + '/'])];
  }
  const shown = values.filter(([v]) => v.toLowerCase().replace(/^#/, '').startsWith(t.replace(/^#/, '')) || v.toLowerCase().includes(t)).slice(0, 8);
  if (!shown.length || (shown.length === 1 && shown[0][0].toLowerCase() === t)) return [];
  return [h('div', { class: 'search-head' }, key + ':'),
    ...shown.map(([v, label]) => row(h('div', { class: 'search-sug' }, label), complete(v)))];
}

function row(el: HTMLElement, go: () => void) {
  el.classList.add('search-row');
  const r = { el, go };
  el.onmousedown = (e) => e.preventDefault(); // keep the box focused
  el.onclick = go;
  el.onmousemove = () => {
    const i = rows.indexOf(r);
    if (i !== at) select(i);
  };
  rows.push(r);
  return el;
}

async function run() {
  const q = box.value.trim();
  const n = ++asked;
  rows = [];
  at = -1;
  const sug = suggestions();
  // Nothing to search yet (empty, or only a filter being typed): just the suggestions.
  const filterOnly = /^((from|mentions|in|has):("?[^\s"]*)\s*)*$/i.test(q) && typingFilter() !== null;
  if (!q || (filterOnly && sug.length)) {
    show(sug);
    return;
  }
  const r = await req('GET', '/api/search?q=' + encodeURIComponent(q));
  if (n !== asked || document.activeElement !== box) return;
  const res = await json<Result>(r);
  rows = [];
  at = -1;
  const out = suggestions();
  if (res.error) {
    out.push(h('div', { class: 'pad search-error' }, res.error)); // a filter it can't use: red, as errors are
  } else {
    out.push(...results(res));
    if (!out.length) out.push(h('div', { class: 'muted pad' }, 'Nothing found.'));
  }
  show(out);
  if (rows.length && !typingFilter()) select(0);
}

function show(nodes: HTMLElement[]) {
  drop.replaceChildren(...nodes);
  drop.hidden = !nodes.length;
  drop.scrollTop = 0;
}

function results(res: Result): HTMLElement[] {
  const w = res.words;
  const out: HTMLElement[] = [];
  const group = <T>(title: string, g: Group<T>, one: (x: T) => HTMLElement) => {
    if (!g.total) return;
    out.push(h('div', { class: 'search-head' }, `${title} · ${g.total}`));
    for (const x of g.items ?? []) out.push(one(x));
    if (g.total > (g.items?.length ?? 0)) {
      out.push(h('div', { class: 'search-more muted' }, `${g.total - g.items!.length} more. Add words or a filter to narrow it down.`));
    }
  };
  group('Messages', res.chat, (m) => row(h('div', { class: 'search-msg' },
    h('div', { class: 'search-meta' }, h('span', { class: 'search-chan' }, labels.chat(m.channel)), h('b', {}, m.user),
      h('span', { class: 'muted' }, when(m.t))),
    h('div', { class: 'search-text' }, ...marked(stripMarkdown(m.text), w))),
  open(() => hooks.go(`#chan=${m.channel}&msg=${m.id}`))));
  group('Schematics', res.schematics, (p) => row(h('div', { class: 'search-schem' },
    p.image ? thumbOr(h('img', { src: `/api/thumb/${enc(`schematics/${p.dir}/${p.image}`)}?v=${p.mod}`, alt: '', loading: 'lazy' }),
      `/api/file/${enc(`schematics/${p.dir}/${p.image}`)}`, () => h('span', { class: 'search-noimg' })) : h('span', { class: 'search-noimg' }),
    h('div', {}, h('div', {}, ...marked(p.title, w)),
      h('div', { class: 'muted' }, ...marked([p.credit && `Design by ${p.credit}`, p.date].filter(Boolean).join(' · '), w)))),
  open(() => hooks.go('#schem=' + encodeURIComponent(p.dir)))));
  group('Files and folders', res.files, (f) => row(fileRow(f.path, !!f.dir, w),
    open(() => hooks.go(!f.dir && MEDIA.test(f.path) && dirName(f.path)
      ? `#folder=${enc(dirName(f.path))}&item=${encodeURIComponent(baseName(f.path))}` : '#' + enc(f.path)))));
  group('In files', res.text, (t) => {
    const el = fileRow(t.path, false, w);
    el.append(h('div', { class: 'search-text mono' }, h('span', { class: 'muted' }, `${t.line}: `), ...marked(t.text, w),
      t.hits > 1 ? h('span', { class: 'muted' }, `  (+${t.hits - 1} more line${t.hits > 2 ? 's' : ''})`) : ''));
    return row(el, open(() => hooks.openAt(t.path, t.line, w)));
  });
  return out;
}

function fileRow(path: string, dir: boolean, words: string[]) {
  const name = baseName(path);
  const parent = dirName(path);
  return h('div', { class: 'search-file' },
    h('div', { class: 'search-name' }, h('img', { class: 'icon', src: iconURL(path, dir, false), alt: '' }),
      h('span', {}, ...marked(name, words)), parent ? h('span', { class: 'muted' }, ' ', ...marked(parent, words)) : ''));
}

// marked is text with the searched-for words highlighted.
function marked(text: string, words: string[]): (Node | string)[] {
  const ws = words.filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ws.length) return [text];
  const out: (Node | string)[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(ws.join('|'), 'gi'))) {
    out.push(text.slice(last, m.index), h('mark', {}, m[0]));
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const when = date;
