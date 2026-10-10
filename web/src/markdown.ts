// Chat formatting: Discord's Markdown, not CommonMark (marked, used for Markdown files, would
// get __underline__, ||spoilers|| and single line breaks wrong). Messages are stored as typed;
// this only draws them.
//
// Blocks: ```code blocks``` (an optional language on the first line), > quote lines,
// >>> quote the rest, # / ## / ### headings, -# small text, - / * / 1. list items.
// Inline: **bold**, *italic* or _italic_, __underline__, ~~strike~~, ||spoiler||, `code`,
// [text](https://masked.link). A backslash shows the next character as it is.
//
// Plain runs of text go to `leaf` (links, #path links, @mentions, emoji: chat.ts); code is
// never formatted or linked. Not drawn: tables, images, HTML (Discord doesn't either).
import { copyText, h } from './util';

type Leaf = (text: string) => Node[];

// Copy icon for code blocks (same stroke set as the chat's ICON).
const COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const FENCE = /```(?:([\w+#-]{1,20})\n)?([\s\S]*?)```/g;

export function renderMarkdown(text: string, leaf: Leaf, plainLeaf: Leaf = leaf): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    out.push(...blocks(trimBreak(text.slice(last, m.index), 'end'), leaf, plainLeaf));
    out.push(codeBlock(m[2].replace(/^\n|\n$/g, ''), m[1]));
    last = m.index! + m[0].length;
  }
  out.push(...blocks(trimBreak(text.slice(last), last ? 'start' : ''), leaf, plainLeaf));
  return out;
}

// A block's own line break isn't drawn as an empty line next to it.
function trimBreak(s: string, side: '' | 'start' | 'end') {
  if (side === 'end') return s.replace(/\n$/, '');
  if (side === 'start') return s.replace(/^\n/, '');
  return s;
}

function codeBlock(code: string, lang?: string) {
  const copy = h('button', { class: 'md-copy', title: 'Copy code', innerHTML: COPY });
  copy.onclick = (e) => {
    e.stopPropagation();
    copyText(code);
  };
  const pre = h('pre', { class: 'md-pre' }, h('code', {}, code), copy);
  if (lang) pre.dataset.lang = lang;
  return pre;
}

const LIST = /^\s*([-*]|\d{1,3}\.)\s+(.*)$/;

// quoted: inside a quote, where ">" is just text (one level, as in Discord; deeper nesting
// once made a message thousands of pixels wide).
function blocks(text: string, leaf: Leaf, plainLeaf: Leaf, quoted = false): Node[] {
  if (!text) return [];
  const out: Node[] = [];
  const lines = text.split('\n');
  let run: string[] = []; // plain lines, drawn together (line breaks kept)
  const flush = () => {
    if (run.length) out.push(...inline(run.join('\n'), leaf, plainLeaf));
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!quoted && line.startsWith('>>> ')) {
      flush();
      const rest = [line.slice(4), ...lines.slice(i + 1)].join('\n');
      out.push(h('blockquote', { class: 'md-quote' }, ...blocks(rest, leaf, plainLeaf, true)));
      break;
    }
    if (!quoted && (line.startsWith('> ') || line === '>')) {
      flush();
      const q: string[] = [];
      for (; i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>'); i++) q.push(lines[i].slice(2));
      i--;
      out.push(h('blockquote', { class: 'md-quote' }, ...blocks(q.join('\n'), leaf, plainLeaf, true)));
      continue;
    }
    const head = /^(#{1,3}) (.+)$/.exec(line);
    if (head) {
      flush();
      const tag = (['h1', 'h2', 'h3'] as const)[head[1].length - 1];
      out.push(h(tag, { class: 'md-h' }, ...inline(head[2], leaf, plainLeaf)));
      continue;
    }
    if (line.startsWith('-# ') && line.length > 3) {
      flush();
      out.push(h('div', { class: 'md-sub' }, ...inline(line.slice(3), leaf, plainLeaf)));
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const list = h(ordered ? 'ol' : 'ul', { class: 'md-list' });
      if (ordered) list.setAttribute('start', String(parseInt(line, 10)));
      for (; i < lines.length && LIST.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered; i++) {
        list.append(h('li', {}, ...inline(LIST.exec(lines[i])![2], leaf, plainLeaf)));
      }
      i--;
      out.push(list);
      continue;
    }
    run.push(line);
  }
  flush();
  return out;
}

// The inline rules, tried in this order at each position. Each pattern is anchored (sticky).
// The closing marks follow Discord: ** isn't closed by a *** run's first two, and _italic_
// needs word edges, so snake_case_names stay as typed.
const URL_AT = /https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"]/y;
const PATH_AT = /#\[[^\]\n]+\]/y;
const MASKED = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y;
const RULES: [RegExp, (inner: Node[]) => Node][] = [
  [/\*\*([\s\S]+?)\*\*(?!\*)/y, (k) => h('strong', {}, ...k)],
  [/__([\s\S]+?)__(?!_)/y, (k) => h('u', {}, ...k)],
  [/\*(?=\S)([\s\S]*?\S)\*(?!\*)/y, (k) => h('em', {}, ...k)],
  [/_((?:__|\\[\s\S]|[^\\_])+?)_(?!\w)/y, (k) => h('em', {}, ...k)],
  [/~~([\s\S]+?)~~/y, (k) => h('s', {}, ...k)],
  [/\|\|([\s\S]+?)\|\|/y, (k) => spoiler(k)],
];
const ESCAPABLE = '\\*_~`|[]()>#-:<@';

function inline(s: string, leaf: Leaf, plainLeaf: Leaf): Node[] {
  const out: Node[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(...leaf(buf));
    buf = '';
  };
  const at = (re: RegExp, i: number) => {
    re.lastIndex = i;
    return re.exec(s);
  };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
      flush();
      out.push(document.createTextNode(s[i + 1]));
      i += 2;
      continue;
    }
    if (c === '`') {
      const ticks = s[i + 1] === '`' ? '``' : '`';
      const end = s.indexOf(ticks, i + ticks.length + 1);
      if (end > 0) {
        flush();
        let code = s.slice(i + ticks.length, end);
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push(h('code', { class: 'md-code' }, code));
        i = end + ticks.length;
        continue;
      }
    }
    // Links and #[paths] are kept whole, so marks inside them (a_b in a URL) stay as typed.
    const atom = (c === 'h' && at(URL_AT, i)) || (c === '#' && at(PATH_AT, i));
    if (atom) {
      buf += atom[0];
      i += atom[0].length;
      continue;
    }
    if (c === '[') {
      const m = at(MASKED, i);
      if (m) {
        flush();
        out.push(h('a', { href: m[2], target: '_blank', rel: 'noopener noreferrer', title: m[2] }, ...inline(m[1], plainLeaf, plainLeaf)));
        i += m[0].length;
        continue;
      }
    }
    if ('*_~|'.includes(c) && !(c === '_' && /\w/.test(s[i - 1] ?? ''))) {
      const hit = RULES.map(([re, make]) => [at(re, i), make] as const).find(([m]) => m);
      if (hit) {
        const [m, make] = hit;
        flush();
        out.push(make(inline(m![1], leaf, plainLeaf)));
        i += m![0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function spoiler(kids: Node[]) {
  const el = h('span', { class: 'md-spoiler', title: 'Spoiler: click to show' }, ...kids);
  el.onclick = (e) => {
    if (el.classList.contains('shown')) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('shown');
    el.title = '';
  };
  return el;
}

// stripMarkdown is the text without its formatting marks, for one-line snippets (reply
// quotes, search results): what it says, not how it looks. Spoilers stay hidden.
export function stripMarkdown(text: string): string {
  const nodes = renderMarkdown(text, (s) => [document.createTextNode(s)]);
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push(n.textContent ?? '');
      return;
    }
    const el = n as HTMLElement;
    if (el.classList?.contains('md-spoiler')) {
      parts.push('(spoiler)');
      return;
    }
    if (el.classList?.contains('md-copy')) return;
    el.childNodes.forEach(walk);
    if (/^(PRE|BLOCKQUOTE|H1|H2|H3|UL|OL|LI|DIV)$/.test(el.tagName)) parts.push('\n');
  };
  nodes.forEach(walk);
  return parts.join('').replace(/\n{2,}/g, '\n').trim();
}

// withoutCode is the text with its code (blocks and `spans`) left out: links and #paths in
// code are examples, not things to preview.
export function withoutCode(text: string): string {
  return text.replace(FENCE, ' ').replace(/``[^`]+?``|`[^`\n]+`/g, ' ');
}
