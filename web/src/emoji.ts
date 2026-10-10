// Emoji: drawing them (Twemoji images), their names (emoji/data.json, made by build.mjs from
// emojibase), Recently used, and the picker. Used by chat.ts (reactions, the message box) and
// autocomplete.ts (:name:).
import { h, load, store } from './util';

export type Emoji = { ch: string; cat: number; names: string[]; label: string };

const CATS = ['Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink', 'Travel & Places',
  'Activities', 'Objects', 'Symbols', 'Flags'];
const CAT_ICON = ['😀', '👋', '🐶', '🍔', '✈️', '⚽', '💡', '🔣', '🏁'];

let all: Emoji[] = [];
const byName = new Map<string, Emoji>();
const byChar = new Map<string, Emoji>();
let loading: Promise<Emoji[]> | null = null;

// loadEmoji fetches the names once; until then the picker and :name: wait for it.
export function loadEmoji(): Promise<Emoji[]> {
  loading ??= fetch('/emoji/data.json').then((r) => r.json()).then((rows: [string, number, string, string][]) => {
    all = rows.map(([ch, cat, names, label]) => ({ ch, cat, names: names.split(' '), label }));
    for (const e of all) {
      byChar.set(e.ch, e);
      for (const n of e.names) if (!byName.has(n)) byName.set(n, e);
    }
    return all;
  }).catch(() => {
    loading = null; // try again next time
    return [];
  });
  return loading;
}
export const emojiLoaded = () => all.length > 0;
export const emojiNamed = (name: string) => byName.get(name.toLowerCase());
export const emojiName = (ch: string) => byChar.get(ch)?.names[0];

// findEmoji is the best matches for typed letters: the exact name, then names starting with
// them, then names containing them, then the description; shorter names first within each
// (so :fir is 🔥 before 🧑‍🚒), then in the picker's order.
export function findEmoji(q: string, n = Infinity): Emoji[] {
  q = q.toLowerCase();
  const score = (e: Emoji) => {
    let best = Infinity;
    for (const x of e.names) {
      const tier = x === q ? 0 : x.startsWith(q) ? 1 : x.includes(q) ? 2 : -1;
      if (tier >= 0) best = Math.min(best, tier * 1000 + x.length);
    }
    if (best === Infinity && e.label.includes(q)) best = 3000 + e.label.length;
    return best;
  };
  return all.map((e) => ({ e, s: score(e) })).filter((x) => x.s < Infinity)
    .sort((a, b) => a.s - b.s).slice(0, n).map((x) => x.e);
}

// The name to show for an emoji found by q: the first that matches, else its first.
export const nameFor = (e: Emoji, q: string) => e.names.find((x) => x.includes(q.toLowerCase())) ?? e.names[0];

// Recently used, newest first, kept in this browser. It starts as the old quick row.
const RECENT_MAX = 27; // three rows of the picker
let recent: string[] = (() => {
  try {
    const r = JSON.parse(load('mt-emoji-recent') ?? 'null');
    if (Array.isArray(r)) return r;
  } catch { /* fall through */ }
  return ['👍', '❤️', '😂', '😮', '😢', '🔥', '✅', '👀'];
})();

export function usedEmoji(ch: string) {
  recent = [ch, ...recent.filter((x) => x !== ch)].slice(0, RECENT_MAX);
  store('mt-emoji-recent', JSON.stringify(recent));
}

// emojiImg draws one emoji as its Twemoji image; alt keeps the character for copying.
// Twemoji names files by code point, joined with -, leaving out the emoji-style selector
// (FE0F) unless the emoji is several joined with a zero-width joiner. lazy waits until it's
// scrolled into view (the picker's grid has nearly 1,900).
export function emojiImg(e: string, lazy = false) {
  const cps = [...e].map((c) => c.codePointAt(0)!.toString(16));
  const code = (e.includes('\u200d') ? cps : cps.filter((c) => c !== 'fe0f')).join('-');
  const img = h('img', { class: 'emoji', src: `/emoji/${code}.svg`, alt: e, draggable: false, loading: lazy ? 'lazy' : 'eager' });
  img.onerror = () => img.replaceWith(e); // one Twemoji doesn't have (newer than the set)
  return img;
}

const COLS = 9;
const clock = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

// emojiPicker is the picker's content (style guide 14): a search box (focused), a row of
// categories, Recently used first, then every emoji by category; the footer names the one
// under the pointer or the arrow keys. A click picks it and closes; Shift+click picks and
// stays open. close is called on a pick.
export function emojiPicker(pick: (ch: string) => void, close: () => void): HTMLElement {
  const search = h('input', { class: 'emoji-search', type: 'text', placeholder: 'Search emoji…', autocomplete: 'off', spellcheck: false });
  const cats = h('div', { class: 'emoji-cats' });
  const body = h('div', { class: 'emoji-body' });
  const footEmoji = h('span', { class: 'emoji-foot-img' });
  const footName = h('span', { class: 'emoji-foot-name' });
  const root = h('div', { class: 'emoji-picker' }, search, cats, body, h('div', { class: 'emoji-foot' }, footEmoji, footName));

  let cells: { el: HTMLElement; e: Emoji | string }[] = []; // in order, for the arrow keys
  let at = -1;
  const label = (x: Emoji | string) => {
    const e = typeof x === 'string' ? byChar.get(x) : x;
    return e ? `:${e.names[0]}:` : (x as string);
  };
  const highlight = (i: number) => {
    cells[at]?.el.classList.remove('on');
    at = i;
    const c = cells[at];
    if (!c) {
      footEmoji.replaceChildren();
      footName.textContent = '';
      return;
    }
    c.el.classList.add('on');
    footEmoji.replaceChildren(emojiImg(typeof c.e === 'string' ? c.e : c.e.ch));
    footName.textContent = label(c.e);
  };
  const choose = (x: Emoji | string, stay: boolean) => {
    const ch = typeof x === 'string' ? x : x.ch;
    usedEmoji(ch);
    if (!stay) close();
    pick(ch);
  };
  const grid = (list: (Emoji | string)[]) => h('div', { class: 'emoji-grid' }, ...list.map((x) => {
    const ch = typeof x === 'string' ? x : x.ch;
    const b = h('button', { class: 'emoji-cell', title: label(x), tabIndex: -1 }, emojiImg(ch, true));
    const i = cells.push({ el: b, e: x }) - 1;
    b.onmousedown = (ev) => ev.preventDefault(); // the search box keeps focus
    b.onmousemove = () => i !== at && highlight(i);
    b.onclick = (ev) => choose(x, ev.shiftKey);
    return b;
  }));
  const heads: HTMLElement[] = [];
  const head = (text: string) => {
    const el = h('div', { class: 'emoji-head' }, text);
    heads.push(el);
    return el;
  };

  const render = () => {
    cells = [];
    at = -1;
    heads.length = 0;
    const q = search.value.trim().replace(/^:|:$/g, '');
    if (q) {
      const found = findEmoji(q);
      body.replaceChildren(...(found.length ? [grid(found)] : [h('div', { class: 'muted pad' }, 'Nothing found.')]));
    } else {
      const parts: HTMLElement[] = [];
      if (recent.length) parts.push(head('Recently used'), grid(recent));
      CATS.forEach((name, c) => parts.push(head(name), grid(all.filter((e) => e.cat === c))));
      body.replaceChildren(...parts);
    }
    body.scrollTop = 0;
    highlight(cells.length ? 0 : -1);
  };

  const catBtn = (icon: Node, title: string, i: number) => {
    const b = h('button', { class: 'emoji-cat', title, tabIndex: -1 }, icon);
    b.onmousedown = (ev) => ev.preventDefault();
    b.onclick = () => {
      if (search.value) {
        search.value = '';
        render();
      }
      const target = heads[recent.length ? i : i - 1];
      if (target) body.scrollTop = target.offsetTop - body.offsetTop;
    };
    return b;
  };
  const clockIcon = h('span', { innerHTML: clock });
  cats.append(catBtn(clockIcon, 'Recently used', 0), ...CATS.map((name, c) => catBtn(emojiImg(CAT_ICON[c]), name, c + 1)));

  search.oninput = render;
  search.onkeydown = (ev) => {
    const n = cells.length;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS };
    if (ev.key in step && n) {
      // Left and right move along the text while there is some to move along.
      if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && search.value) return;
      ev.preventDefault();
      highlight(Math.max(0, Math.min(n - 1, (at < 0 ? 0 : at) + step[ev.key])));
      cells[at].el.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const c = cells[at] ?? cells[0];
      if (c) choose(c.e, ev.shiftKey);
    }
  };

  body.replaceChildren(h('div', { class: 'muted pad' }, 'Loading…'));
  loadEmoji().then(() => {
    if (!all.length) body.replaceChildren(h('div', { class: 'muted pad' }, 'Couldn’t load the emoji list.'));
    else render();
  });
  queueMicrotask(() => search.focus());
  return root;
}
