// Autocomplete in message boxes (style guide 6.4 and 14), as in Discord:
//   @  the matching people, then @everyone and @here
//   :  plus two letters: the matching emoji (:fire → 🔥); a whole :name: typed out turns into
//      its emoji at once
//   /  at the very start of the message box: the commands (commands.ts)
// The popup sits just above the box, at the caret. ↑/↓ move, Enter or Tab inserts, Esc closes and leaves the
// text as typed; the box keeps focus throughout. The box's own key handler asks key(e) first.
import { COMMANDS } from './commands';
import { emojiImg, emojiLoaded, emojiNamed, findEmoji, loadEmoji, nameFor, usedEmoji } from './emoji';
import { h } from './util';

type Row = { el: HTMLElement; text: string; emoji?: string }; // text replaces what's typed
type Token = { kind: '@' | ':' | '/'; start: number; q: string };

const pop = h('div', { class: 'ac-pop', hidden: true });
let box: HTMLTextAreaElement | null = null; // the box the popup is for
let rows: Row[] = [];
let at = 0;
let token: Token | null = null;

export type Autocomplete = { key: (e: KeyboardEvent) => boolean };

// autocomplete hooks up a message box. names is everyone who can be @mentioned; commands:
// the box runs commands (the message box does, the edit box doesn't).
export function autocomplete(t: HTMLTextAreaElement, names: () => string[], commands = false): Autocomplete {
  if (!pop.isConnected) {
    document.body.append(pop);
    window.addEventListener('resize', close);
  }
  const update = () => {
    if (convert(t)) return close();
    show(t, names, commands);
  };
  t.addEventListener('input', update);
  t.addEventListener('click', update);
  t.addEventListener('blur', () => box === t && close());
  return {
    key(e) {
      if (box !== t || pop.hidden || e.isComposing) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        select((at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
      } else if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
        pick(rows[at]);
      } else if (e.key === 'Escape') {
        close();
      } else {
        return false;
      }
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
  };
}

export function close() {
  pop.hidden = true;
  box = null;
  token = null;
  rows = [];
}

// What's being typed just before the caret, if it's a mention or an emoji name.
function typing(t: HTMLTextAreaElement, commands: boolean): Token | null {
  if (t.selectionStart !== t.selectionEnd) return null;
  const before = t.value.slice(0, t.selectionStart);
  // A command is the whole message, so only while nothing else is in the box.
  if (commands && before === t.value && /^\/[a-z]*$/i.test(before)) return { kind: '/', start: 0, q: before.slice(1) };
  let m = /(^|[^\w@])@([\w-]{0,32})$/.exec(before);
  if (m) return { kind: '@', start: before.length - m[2].length - 1, q: m[2] };
  m = /(^|[\s(])(:([\w+-]{2,32}))$/.exec(before);
  if (m) return { kind: ':', start: before.length - m[2].length, q: m[3] };
  return null;
}

// convert turns a :name: that was just finished into its emoji. True if it did.
function convert(t: HTMLTextAreaElement) {
  if (t.selectionStart !== t.selectionEnd) return false;
  const before = t.value.slice(0, t.selectionStart);
  const m = /(^|[\s(]):([\w+-]{1,32}):$/.exec(before);
  const e = m && emojiNamed(m[2]);
  if (!e) return false;
  replace(t, before.length - m[2].length - 2, e.ch);
  usedEmoji(e.ch);
  return true;
}

function show(t: HTMLTextAreaElement, names: () => string[], commands: boolean) {
  const tok = typing(t, commands);
  if (!tok) return close();
  if (tok.kind === ':' && !emojiLoaded()) {
    loadEmoji().then(() => document.activeElement === t && show(t, names, commands));
    return;
  }
  const q = tok.q.toLowerCase();
  const out: Row[] = [];
  let title: string;
  if (tok.kind === '/') {
    title = 'Commands';
    // Typed out in full, there's nothing left to offer: Enter runs it.
    for (const c of COMMANDS.filter((c) => c.name.startsWith(q) && c.name !== q)) {
      out.push({ el: h('div', { class: 'ac-row' }, h('span', { class: 'ac-name ac-command' }, ...mark('/' + c.name, '/' + q)), h('span', { class: 'muted' }, c.about)), text: '/' + c.name + ' ' });
    }
  } else if (tok.kind === '@') {
    title = 'Members';
    const seen = new Set<string>();
    const people = names().filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
    const starts = people.filter((n) => n.toLowerCase().startsWith(q));
    const inside = people.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
    for (const n of [...starts.sort(byName), ...inside.sort(byName)].slice(0, 8)) {
      out.push({ el: h('div', { class: 'ac-row' }, h('span', { class: 'ac-name' }, ...mark(n, q))), text: '@' + n + ' ' });
    }
    for (const n of ['everyone', 'here']) {
      if (n.startsWith(q)) {
        out.push({ el: h('div', { class: 'ac-row' }, h('span', { class: 'ac-name' }, ...(q ? mark('@' + n, '@' + q) : ['@' + n])),
          h('span', { class: 'muted' }, n === 'everyone' ? 'everyone in the hub' : 'everyone here now')), text: '@' + n + ' ' });
      }
    }
  } else {
    title = `Emoji matching :${tok.q}`;
    for (const e of findEmoji(q, 10)) {
      const name = nameFor(e, q);
      out.push({ el: h('div', { class: 'ac-row' }, emojiImg(e.ch), h('span', {}, ':', ...mark(name, q), ':')), text: e.ch + ' ', emoji: e.ch });
    }
  }
  if (!out.length) return close();
  box = t;
  token = tok;
  rows = out;
  out.forEach((r, i) => {
    r.el.onmousedown = (e) => e.preventDefault(); // the box keeps focus
    r.el.onmousemove = () => i !== at && select(i);
    r.el.onclick = () => pick(r);
  });
  pop.replaceChildren(h('div', { class: 'ac-head' }, title), ...out.map((r) => r.el));
  pop.hidden = false;
  select(0);
  place(t, tok.start);
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

// mark is text with the typed part highlighted (style guide 6.4: search words in --flash).
function mark(text: string, q: string): (Node | string)[] {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return [text];
  return [text.slice(0, i), h('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

function select(i: number) {
  rows[at]?.el.classList.remove('on');
  at = i;
  rows[at]?.el.classList.add('on');
  rows[at]?.el.scrollIntoView({ block: 'nearest' });
}

function pick(r: Row | undefined) {
  if (!r || !box || !token) return;
  if (r.emoji) usedEmoji(r.emoji);
  const t = box;
  replace(t, token.start, r.text);
  close();
}

// replace puts text in place of what's between from and the caret, as if typed (so undo and
// the box's own input handling, drafts and growing, see it).
function replace(t: HTMLTextAreaElement, from: number, text: string) {
  t.setSelectionRange(from, t.selectionStart);
  if (!document.execCommand('insertText', false, text)) {
    t.setRangeText(text, from, t.selectionEnd, 'end');
    t.dispatchEvent(new Event('input'));
  }
}

// place puts the popup just above the box, lined up with the text being completed (below
// the box if there's no room above), kept on screen.
function place(t: HTMLTextAreaElement, index: number) {
  const r = t.getBoundingClientRect();
  const w = pop.offsetWidth;
  const ht = pop.offsetHeight;
  pop.style.left = `${Math.max(4, Math.min(caretX(t, index) - 12, window.innerWidth - w - 4))}px`;
  pop.style.top = `${r.top - ht - 6 >= 4 ? r.top - ht - 6 : r.bottom + 6}px`;
}

// caretX is where a character of a text box is across the screen, measured with a hidden
// copy of the box (a textarea can't report it).
function caretX(t: HTMLTextAreaElement, index: number) {
  const s = getComputedStyle(t);
  const copy = h('div');
  for (const p of ['font', 'letterSpacing', 'wordSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom',
    'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'tabSize'] as const) {
    (copy.style as any)[p] = s[p];
  }
  Object.assign(copy.style, {
    position: 'fixed', visibility: 'hidden', top: '0', left: '0', width: t.offsetWidth + 'px',
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', borderStyle: 'solid',
  });
  const marker = h('span', {}, '\u200b');
  copy.append(t.value.slice(0, index), marker);
  document.body.append(copy);
  const x = t.getBoundingClientRect().left + marker.offsetLeft - t.scrollLeft;
  copy.remove();
  return x;
}
