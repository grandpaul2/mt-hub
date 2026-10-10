// Text channels. A ChatView is one chat pane (message list + composer); there are two:
// the side panel on the right, and the main panel when a channel is picked in the left
// list. They can show different channels at once. Channel list, unread markers and the
// live event stream are shared.
import { parse as findEmoji } from '@twemoji/parser';
import { openViewer, type ViewItem } from './viewer';
import { renderMarkdown, stripMarkdown, withoutCode } from './markdown';
import { emojiImg, emojiPicker as pickerContent } from './emoji';
import { autocomplete } from './autocomplete';
import { commandIn, type Command } from './commands';
import { voiceMenuItems } from './voice';
import { streamMenuItems } from './stream';
import { dingFor, setupDing } from './ding';
import { $, accounts, ask, bytes, opTag, tagOf, dateTime, fullDate, GLYPH, time, closeDialog, copyText, dialog, enc, h, isAdmin, json, labels, load, req, showMenu, store, toast, toastError, user, type MenuItem, type Live, thumbOr } from './util';
import { iconURL } from './icons';

type Message = {
  id: string; channel: string; t: string; user: string; text: string; edited?: string;
  reply_to?: string; reply?: Quote; fwd?: Forward; reactions?: Reaction[]; pinned?: { by: string; t: string };
  via?: string; // said in game on this server (SMP, CMP): the server link
};
type Quote = { user?: string; text?: string; deleted?: boolean };
type Forward = { channel: string; id: string; user: string; t: string; text: string };
type Reaction = { emoji: string; users: string[] };
// kind: undefined (public), 'private' (members and admins) or 'dm' (members only).
type ChannelInfo = { name: string; last_id: string; kind?: 'private' | 'dm'; members?: string[] };

type Hooks = {
  openPath(path: string): void; // open a file from a #path link
  resolvePath(path: string): string | null; // where a #path is now (it may have moved), or null
  showMainChat(): void; // switch the main panel from file to chat
  mainShowsChat(): boolean;
  showSidePanel(): void; // un-hide the right-hand chat panel
  schemPost(path: string): { title: string; credit?: string; file: string } | null; // a linked schematic post's folder
  fileMod(path: string): number | null; // a workspace file's modification time, or null if it isn't there
  send(url: string, f: File, progress: (fraction: number) => void): Promise<{ status: number; body: any }>; // an upload, with progress
  uploadInto(files: File[], dir: string): Promise<string[]>; // into a Files folder; their paths
  folders(): string[]; // every folder in Files
  currentFolder(): string; // the folder selected in the tree ('' for the top)
  revealMedia(path: string): void; // show a picture or video in Files: its single preview, and in the tree
  stampName(file: File): string; // a pasted picture's name (always image.png) made from the time and who
};

const GROUP_MS = 5 * 60 * 1000; // a run of messages by one person within this shares a header

// Where the last press began. On a phone, a tap on a message first shows its hover-only
// buttons (the toolbar, + reaction) and then delivers its click to whichever of them is now
// under the finger. pressedOn makes those buttons act only for a press that began on them;
// a mouse press does (they show on hover first), and a key press (detail 0) has no pointer.
let pressStart: EventTarget | null = null;
document.addEventListener('pointerdown', (e) => (pressStart = e.target), { capture: true });
const pressedOn = (el: Element, e: MouseEvent) => e.detail === 0 || (pressStart instanceof Node && el.contains(pressStart));

let hooks: Hooks;
let channels: ChannelInfo[] = [];
let renames: { from: string; to: string }[] = []; // every chat rename, oldest first
// Unread markers are per browser while there are no accounts: last message ID seen per channel.
const lastRead: Record<string, string> = JSON.parse(load('mt-read') ?? '{}');
let side: ChatView;
let main: ChatView;
// The inline chat-name box (new chat, or renaming one): what's typed and any error are kept
// across re-renders of the list; focus only moves to the box when it opens or after Enter.
let chanEdit: { kind: 'new' } | { kind: 'rename'; name: string } | null = null;
let chanDraft: string | null = null;
let chanError = '';
let chanFocus = false;

// The server link (internal/server/link.go): this chat is shared with game chat on our servers.
const LINK_CHAT = 'server-link';
const SERVER_NAMES: Record<string, string> = { SMP: 'Survival', CMP: 'Creative' };

class ChatView {
  channel: string;
  msgs: Message[] = [];
  hasOlder = true;
  loadingOlder = false;
  editing: string | null = null;
  replyTo: Message | null = null;
  gone = new Set<string>(); // deleted while shown, so replies to them say so
  olderP: Promise<void> | null = null;
  // Scroll position. Rewrapping (the pane resized) and pictures or cards arriving change the
  // list's height; keep() then holds the view in place, at the bottom of the list (when the
  // reader follows the chat: stuck) or at the message on the bottom edge of the view (when
  // they've scrolled up to read). Only the reader's own scrolling changes which: scrolls we
  // make ourselves are noted in ownTop and ignored. (The browser's scroll anchoring is off for
  // the list: it holds a message near the top, which pushed the newest ones out of view.)
  stuck = true;
  anchor: { el: HTMLElement; fromBottom: number } | null = null;
  ownTop: number | null = null;
  loaded = false; // this chat's messages have been fetched (until then, live ones are ignored)
  // The NEW line goes above the first message after this one: what was read when the chat
  // was opened, or the last one seen before new ones arrived unseen. null: no line. It stays
  // while the chat is open (as in Discord) and goes when you send something.
  newAfter: string | null = null;
  // Rendered messages and day lines by key, so a re-render leaves unchanged ones in place
  // (a playing video keeps playing, previews don't flicker).
  nodes = new Map<string, HTMLElement>();
  // Commands' answers (commands.ts): drawn in the list for you alone, each under the message
  // that was last when it was asked for, until dismissed or the pane moves to another chat.
  privates: { after: string; el: HTMLElement }[] = [];
  readonly list = h('div', { class: 'messages' });
  readonly items = h('div', { class: 'messages-items' }); // inside list: its height is the content's
  readonly compose = h('textarea', { class: 'compose', rows: 1, maxLength: 4000 });
  readonly replyBar = h('div', { class: 'reply-bar', hidden: true });
  readonly picker = h('input', { type: 'file', multiple: true, hidden: true });
  readonly jump = h('button', { class: 'jump', hidden: true, innerHTML: 'Jump to present ' + ICON.down });
  readonly note = h('div', { class: 'chat-privacy', hidden: true }); // who can see a private chat or DM

  constructor(readonly root: HTMLElement, readonly key: string, fallback: string) {
    this.channel = load(key) ?? fallback;
    const attach = h('button', { class: 'tool attach', title: 'Upload files (or drop or paste them here)', innerHTML: ICON.plus });
    attach.onclick = () => this.picker.click();
    this.picker.onchange = () => {
      this.attach([...(this.picker.files ?? [])]);
      this.picker.value = '';
    };
    this.list.append(this.items);
    this.jump.onclick = () => {
      this.scrollToBottom();
      markRead();
    };
    new ResizeObserver(() => this.keep()).observe(this.list);
    new ResizeObserver(() => this.keep()).observe(this.items);
    const smile = h('button', { class: 'tool smile', title: 'Emoji', innerHTML: ICON.smile });
    smile.onclick = () => {
      if (popAnchor === smile) return closePop(); // a second click closes it
      // Above the whole box (not over its edge), lined up with the button's right side.
      const b = smile.getBoundingClientRect();
      const row = this.compose.getBoundingClientRect();
      emojiPicker(new DOMRect(b.x, row.y, b.width, row.height), (e) => {
        insert(this.compose, e);
        this.keepDraft();
      }, smile);
    };
    root.append(this.note, h('div', { class: 'messages-wrap' }, this.list, this.jump), h('div', { class: 'composer' }, this.replyBar, h('div', { class: 'compose-row' }, attach, this.compose, smile), this.picker));
    this.compose.value = drafts[this.channel] ?? '';

    const c = this.compose;
    const ac = autocomplete(c, mentionNames, true);
    c.onkeydown = (e) => {
      if (ac.key(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      } else if (e.key === 'Escape' && this.replyTo) {
        this.cancelReply();
      } else if (e.key === 'ArrowUp' && c.value === '') {
        const mine = [...this.msgs].reverse().find((m) => m.user === user.name);
        if (mine) {
          e.preventDefault();
          this.startEdit(mine.id);
        }
      }
    };
    c.oninput = () => {
      grow(c);
      this.keepDraft();
    };
    c.onpaste = (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      this.attach(files);
    };
    // Drag a file or folder from the tree or a folder view, or a card from the Schematic
    // Manager, anywhere onto the pane to link it in the box. Files from the computer are
    // posted in the chat (see attach) and linked the same way.
    const linkable = (e: DragEvent) => !!e.dataTransfer?.types.some((t) => t === 'text/x-mt-path' || t === 'Files');
    root.ondragover = (e) => {
      if (!linkable(e)) return;
      e.preventDefault();
      root.classList.add('drop');
    };
    root.ondragleave = (e) => {
      if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove('drop');
    };
    root.ondrop = (e) => {
      root.classList.remove('drop');
      const p = e.dataTransfer?.getData('text/x-mt-path');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!p && !files.length) return;
      e.preventDefault();
      if (p) {
        insert(c, (c.value && !/\s$/.test(c.value) ? ' ' : '') + pathRef(p) + ' ');
        this.keepDraft();
      } else this.attach(files);
    };
    this.list.onscroll = () => {
      if (this.list.scrollTop !== this.ownTop) { // the reader's, not ours (keep, scrollToBottom)
        this.ownTop = null;
        this.stuck = this.nearBottom();
        this.anchor = this.stuck ? null : this.bottomEdge();
      }
      if (this.list.scrollTop < 80) this.loadOlder();
      if (this.nearBottom()) markRead();
      this.showJump();
    };
  }

  // attach posts files in this chat (kept with it, any kind) and links them in the box.
  // Chat takes up to 50 MB a file; one question offers to put bigger ones in Files instead.
  async attach(files: File[]) {
    // A "]" would end the #[...] link early (and line breaks aren't allowed in names).
    files = files.map((f) => (/[\]\p{Cc}]/u.test(f.name) ? new File([f], f.name.replace(/[\]\p{Cc}]/gu, '_'), { type: f.type }) : f));
    const fits = files.filter((f) => f.size <= MAX_POSTED);
    const big = files.filter((f) => f.size > MAX_POSTED);
    const priv = !!info(this.channel)?.kind;
    if (fits.length) this.link(await postFiles(fits, this.channel));
    if (big.length) addToLarge(big, async () => this.link(await hooks.uploadInto(big, 'large')), priv);
  }

  // link puts #path links to files in the message box.
  link(paths: string[]) {
    const c = this.compose;
    if (paths.length) insert(c, (c.value && !/\s$/.test(c.value) ? ' ' : '') + paths.map(pathRef).join(' ') + ' ');
    this.keepDraft();
  }

  // keepDraft saves what's in the box as this chat's draft (see drafts).
  keepDraft() {
    setDraft(this.channel, this.compose.value);
  }

  // shown: the pane is on screen (not collapsed, not swapped out for a file).
  shown() {
    return this.root.offsetParent !== null;
  }

  // setChannel switches the pane; the promise settles when its messages are in.
  setChannel(name: string): Promise<void> {
    if (name === this.channel && this.loaded) return Promise.resolve();
    this.channel = name;
    this.loaded = false;
    this.msgs = [];
    this.privates = [];
    this.newAfter = null;
    store(this.key, name);
    this.editing = null;
    this.gone.clear();
    this.cancelReply();
    this.compose.value = drafts[name] ?? '';
    grow(this.compose);
    this.labels();
    return this.load();
  }

  // labels names the chat in the box's placeholder and says who can see it (style guide
  // 14): private chats and DMs get a muted line at the top.
  labels() {
    const c = info(this.channel);
    this.compose.placeholder = `Message ${chatTitle(this.channel, false)}`;
    this.note.hidden = !c?.kind && this.channel !== LINK_CHAT;
    if (this.channel === LINK_CHAT && !c?.kind) {
      this.note.replaceChildren(h('span', { innerHTML: ICON.link }), h('span', {}, 'Linked to game chat: messages here show in game on both servers. In game, start a line with ',
        h('code', { class: 'md-code' }, '$'), ' and a space to say it here.'));
      return;
    }
    this.note.replaceChildren(h('span', { innerHTML: ICON.lock }), c?.kind === 'dm'
      ? 'Only the people in this conversation can see it, not even admins. (Do not share personal info. Direct messages are not encrypted and are recoverable.)'
      : 'Private: only its members and the admins can see this chat. (Do not share personal info. Private chats are not encrypted and are recoverable.)');
  }

  async load() {
    const name = this.channel;
    this.labels();
    const r = await req('GET', `/api/channels/${name}/messages?limit=100`);
    // Gone (renamed or deleted while this page was away): loadChannels moves the pane on.
    if (r.status === 404) return;
    const list = await json<Message[]>(r);
    if (name !== this.channel) return;
    this.msgs = list;
    this.loaded = true;
    this.hasOlder = list.length === 100;
    // Unread since this browser last read the chat: the NEW line, scrolled to (a little of
    // what came before shows above it). A chat never opened here gets no line.
    const read = lastRead[name];
    this.newAfter = read && list.length && list[list.length - 1].id > read ? read : null;
    this.render();
    this.scrollToBottom();
    const line = this.items.querySelector<HTMLElement>('.new-line');
    if (line) {
      this.setTop(line.getBoundingClientRect().top - this.list.getBoundingClientRect().top + this.list.scrollTop - 40);
      this.stuck = this.nearBottom();
      this.anchor = this.stuck ? null : this.bottomEdge();
    }
    this.showJump();
    markRead();
  }

  // refresh catches up after the live updates reconnect (a hub restart): the newest page
  // again, keeping the older messages loaded above it and the reader's place. load() would
  // start over at the bottom. More than a page missed: start over after all.
  async refresh() {
    if (!this.loaded || !this.msgs.length) return this.load();
    const name = this.channel;
    const r = await req('GET', `/api/channels/${name}/messages?limit=100`);
    if (!r.ok) return;
    const list = await json<Message[]>(r);
    if (name !== this.channel) return;
    if (!list.length || list[0].id > this.msgs[this.msgs.length - 1].id) return this.load();
    const stick = this.nearBottom();
    this.msgs = [...this.msgs.filter((m) => m.id < list[0].id), ...list];
    this.render();
    if (stick) this.scrollToBottom();
  }

  // firstNew is the message the NEW line goes above, if any.
  firstNew() {
    const after = this.newAfter;
    return after === null ? null : this.msgs.find((m) => m.id > after)?.id ?? null;
  }

  // showJump shows "Jump to present" while you're more than a screen up from the newest.
  showJump() {
    const b = this.list;
    this.jump.hidden = !b.clientHeight || b.scrollHeight - b.scrollTop - b.clientHeight < b.clientHeight;
  }

  // loadOlder fetches the page before the oldest shown; a call while one is under way
  // shares it.
  loadOlder(): Promise<void> {
    if (!this.hasOlder || !this.msgs.length) return Promise.resolve();
    this.olderP ??= this.fetchOlder().finally(() => (this.olderP = null));
    return this.olderP;
  }

  private async fetchOlder() {
    this.loadingOlder = true;
    const name = this.channel;
    try {
      const older = await json<Message[]>(
        await req('GET', `/api/channels/${name}/messages?limit=100&before=${this.msgs[0].id}`));
      if (name !== this.channel) return;
      this.hasOlder = older.length === 100;
      this.msgs = [...older, ...this.msgs];
      this.render(); // they go in above: keep() holds the view where it was
    } finally {
      this.loadingOlder = false;
    }
  }

  async send() {
    const text = this.compose.value.trim();
    if (!text) return;
    const name = this.channel;
    const cmd = commandIn(text);
    if (cmd) {
      this.compose.value = '';
      setDraft(name, '');
      grow(this.compose);
      return this.run(cmd);
    }
    const reply = this.replyTo;
    // Empty the box at once, so a second Enter before the answer can't send it again.
    this.compose.value = '';
    setDraft(name, '');
    this.cancelReply();
    grow(this.compose);
    const r = await req('POST', `/api/channels/${name}/messages`, JSON.stringify({ text, reply_to: reply?.id ?? '' }));
    if (!r.ok) {
      toastError(`Couldn’t send it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
      // Give it back, unless they've moved on (another chat, or typing something new).
      setDraft(name, text);
      if (this.channel === name && !this.compose.value) {
        this.compose.value = text;
        if (reply) this.startReply(reply);
        grow(this.compose);
      }
    }
    // The message itself arrives over the event stream, like everyone else's.
  }

  onMessage(m: Message) {
    // A pane that hasn't fetched its chat yet picks this up when it does.
    if (!this.loaded || m.channel !== this.channel || this.msgs.some((x) => x.id === m.id)) return;
    const stick = this.nearBottom() || m.user === user.name;
    // Sending dismisses the NEW line; a message arriving unseen (scrolled up, or the tab in
    // the background) starts one, unless there's one already.
    const seen = !document.hidden && this.shown() && this.nearBottom();
    if (m.user === user.name) this.newAfter = null;
    else if (!seen && !this.firstNew() && this.msgs.length) this.newAfter = this.msgs[this.msgs.length - 1].id;
    // In order by id (time), even if two arrive the other way round.
    let at = this.msgs.length;
    while (at > 0 && this.msgs[at - 1].id > m.id) at--;
    this.msgs.splice(at, 0, m);
    this.render();
    if (stick) this.scrollToBottom();
  }

  onEdit(m: Message) {
    const i = this.msgs.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      this.msgs[i] = m;
      this.render();
    }
  }

  onDelete(d: { channel: string; id: string }) {
    if (d.channel !== this.channel) return;
    this.gone.add(d.id);
    if (this.replyTo?.id === d.id) this.cancelReply();
    this.msgs = this.msgs.filter((x) => x.id !== d.id);
    this.render();
  }

  // seenUpTo is the newest message this pane counts as read, or "" if it isn't on screen.
  // run runs a command and shows its answer under the newest message, to you alone.
  async run(cmd: Command) {
    const name = this.channel;
    let answer: HTMLElement;
    try {
      answer = await cmd.run();
    } catch (e) {
      return toastError(`Couldn’t run /${cmd.name}: ${e instanceof Error ? e.message : e}.`);
    }
    if (this.channel !== name) return;
    const dismiss = h('button', {}, 'Dismiss');
    const p = { after: this.msgs[this.msgs.length - 1]?.id ?? '', el: h('div', { class: 'msg private' }, answer,
      h('div', { class: 'only-you' }, h('span', { innerHTML: ICON.eye }), 'Only you can see this · ', dismiss)) };
    dismiss.onclick = () => {
      this.privates = this.privates.filter((x) => x !== p);
      this.render();
    };
    this.privates.push(p);
    this.render();
    this.scrollToBottom();
  }

  seenUpTo() {
    if (document.hidden || !this.shown() || !this.msgs.length || !this.nearBottom()) return '';
    return this.msgs[this.msgs.length - 1].id;
  }

  render() {
    const box = this.items;
    if (!this.msgs.length) {
      this.nodes.clear();
      box.replaceChildren(h('div', { class: 'muted pad' }, `This is the start of ${chatTitle(this.channel, false)}.`), ...this.privates.map((p) => p.el));
      return;
    }
    // Work out what should be on screen, reusing any element whose content is unchanged.
    const want: HTMLElement[] = [];
    const next = new Map<string, HTMLElement>();
    const use = (key: string, make: () => HTMLElement) => {
      const el = this.nodes.get(key) ?? make();
      next.set(key, el);
      want.push(el);
    };
    let prev: Message | null = null;
    const firstNew = this.firstNew();
    for (const a of accounts) knownNames.add(a.name.toLowerCase());
    for (const m of this.msgs) knownNames.add(m.user.toLowerCase());
    for (const m of this.msgs) {
      const t = new Date(m.t);
      if (!prev || new Date(prev.t).toDateString() !== t.toDateString()) {
        const label = dayLabel(t);
        use(`day|${t.toDateString()}|${label}`, () => h('div', { class: 'day' }, label));
        prev = null;
      }
      // The NEW line (style guide 14), and the first new message gets its own header.
      if (m.id === firstNew) {
        use(`new|${m.id}`, () => h('div', { class: 'new-line' }, h('span', { class: 'new-tag' }, 'New')));
        prev = null;
      }
      // A reply always gets its own header, under the line it quotes.
      const grouped = !!prev && !m.reply_to && prev.user === m.user && prev.via === m.via && t.getTime() - Date.parse(prev.t) < GROUP_MS;
      // Everything the element shows: text, edit state, who's looking (their buttons), where
      // its links point now, reactions, pin, the quoted reply and any forward.
      // While you're editing it, only the edit box shows: a reaction or pin arriving mustn't
      // rebuild it and throw away what you've typed.
      const q = this.quote(m);
      const key = this.editing === m.id ? `editing|${m.id}|${grouped}` : [m.id, m.text, m.edited ?? '', grouped, user.name, isAdmin(m.user) ? tagOf(m.user) ?? '' : '',
        linkTargets(m.text + '\n' + (m.fwd?.text ?? '')), JSON.stringify(m.reactions ?? []), m.pinned?.by ?? '',
        q ? JSON.stringify(q) : '', m.fwd ? resolveChannel(m.fwd.channel) ?? '' : ''].join('|');
      use(key, () => this.renderMessage(m, grouped));
      prev = m;
      for (const p of this.privates) {
        if (p.after === m.id) {
          want.push(p.el);
          prev = null; // the next message gets its name again
        }
      }
    }
    // One whose message has gone (deleted) moves to the end.
    for (const p of this.privates) if (!want.includes(p.el)) want.push(p.el);
    this.nodes = next;
    // Patch the list: drop what's gone, then put each wanted element in place. Elements that
    // are already in place aren't touched (moving an iframe would reload it).
    const keep = new Set(want);
    for (const el of [...box.children]) if (!keep.has(el as HTMLElement)) el.remove();
    want.forEach((el, i) => {
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
    });
    queueMicrotask(() => this.showJump());
  }

  renderMessage(m: Message, grouped: boolean) {
    const t = new Date(m.t);
    const el = h('div', { class: 'msg' + (grouped ? ' grouped' : '') + (m.pinned ? ' pinned' : '') });
    el.dataset.id = m.id;
    const q = this.quote(m);
    if (q) el.append(this.quoteLine(m, q));
    // The time sits in a gutter left of the name; a grouped message shows its own there on hover.
    const when = h('span', { class: 'when', title: fullDate(t) }, time(t));
    if (!grouped) {
      el.append(h('div', { class: 'msg-head' }, when, h('span', { class: 'who' }, m.user),
        isAdmin(m.user) ? opTag(tagOf(m.user)) : '',
        m.via ? h('span', { class: 'tag via', title: `Said in game on ${SERVER_NAMES[m.via] ?? 'a server'}` }, m.via) : ''));
    } else {
      when.classList.add('side');
      el.append(when);
    }
    if (this.editing === m.id) {
      el.append(this.editBox(m));
      return el;
    }
    // Text, unless it was only links shown as previews below (then just "(edited)").
    const nodes = m.text ? renderBody(m.text) : [];
    const visible = nodes.some((n) => n.nodeType !== Node.TEXT_NODE || n.textContent!.trim());
    if (visible || m.edited) {
      const body = h('div', { class: 'msg-body' }, ...(visible ? nodes : []));
      if (m.edited) body.append(h('span', { class: 'edited', title: `Edited ${fullDate(m.edited)}` }, ' (edited)'));
      el.append(body);
    }
    if (m.fwd) el.append(forwardBox(m.fwd));
    const all = withoutCode(m.text + '\n' + (m.fwd?.text ?? ''));
    const refs = mediaPreviews(all, m);
    if (refs) el.append(refs);
    const links = previewLinks(all);
    if (links.length) el.append(this.embeds(links));
    if (m.reactions?.length) el.append(this.reactions(m));
    if (m.pinned) el.append(h('span', { class: 'pin-mark', title: `Pinned by ${m.pinned.by}`, innerHTML: ICON.pin }));
    el.append(this.tools(m));
    el.oncontextmenu = (e) => {
      // Selected text keeps the browser's own menu (to copy just that).
      const sel = getSelection();
      if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
      e.preventDefault();
      showMenu(e, this.menuItems(m, { x: e.clientX, y: e.clientY }));
    };
    return el;
  }

  // quote is what a reply quotes: the original as shown here (so edits and deletes show
  // at once), else as the server last described it.
  quote(m: Message): Quote | null {
    if (!m.reply_to) return null;
    if (this.gone.has(m.reply_to)) return { deleted: true };
    const o = this.msgs.find((x) => x.id === m.reply_to);
    if (o) return { user: o.user, text: snippet(plainText(o.text || o.fwd?.text || '')) };
    return m.reply ? { ...m.reply, text: m.reply.text && plainText(m.reply.text) } : { deleted: true };
  }

  quoteLine(m: Message, q: Quote) {
    const line = h('div', { class: 'reply-quote', title: 'Jump to the message' },
      ...(q.deleted ? [h('span', { class: 'gone' }, 'Original message was deleted')]
        : [h('span', { class: 'who' }, q.user ?? ''), h('span', { class: 'text' }, q.text ?? '')]));
    if (!q.deleted) line.onclick = () => this.jumpTo(m.reply_to!);
    return line;
  }

  // tools is the hover toolbar: react, reply, forward, edit (yours), copy, delete (yours, or
  // an admin), save to Files (files posted in chat) or open folder (pictures and videos in
  // Files), and ⋯ for the rest. Shift+click on delete skips the question.
  tools(m: Message) {
    const mine = m.user === user.name;
    const btn = (icon: keyof typeof ICON, title: string, fn: (b: HTMLElement, e: MouseEvent) => void, cls = '') => {
      const b = h('button', { class: 'tool ' + cls, title, innerHTML: ICON[icon] });
      b.dataset.tool = icon;
      b.onclick = (e) => {
        e.stopPropagation();
        if (pressedOn(box, e)) fn(b, e);
      };
      return b;
    };
    const box = h('div', { class: 'msg-tools' },
      btn('react', 'Add reaction', (b) => emojiPicker(b.getBoundingClientRect(), (e) => react(m, e, true))),
      btn('reply', 'Reply', () => this.startReply(m)),
      btn('forward', 'Forward', () => forwardDialog(m)));
    if (mine && m.text) box.append(btn('edit', 'Edit', () => this.startEdit(m.id)));
    box.append(btn('copy', 'Copy text', () => copyText(m.text || m.fwd?.text || '')));
    if (mine || canModerate(m.channel)) box.append(btn('trash', 'Delete (Shift+click: no question)', (_, e) => deleteMessage(m, e.shiftKey), 'danger'));
    const { posted, inFiles } = linkedFiles(m);
    if (posted.length) box.append(btn('save', 'Save to Files…', () => saveToFiles(posted)));
    else if (inFiles.length) box.append(btn('folder', 'Open folder', () => hooks.revealMedia(inFiles[0])));
    box.append(btn('more', 'More', (b) => {
      const r = b.getBoundingClientRect();
      showMenu({ clientX: r.left, clientY: r.bottom + 2 } as MouseEvent, this.menuItems(m, { x: r.left, y: r.bottom }), b);
    }));
    return box;
  }

  // menuItems is a message's full menu (right-click, and ⋯).
  menuItems(m: Message, at: { x: number; y: number }): MenuItem[] {
    const mine = m.user === user.name;
    const items: MenuItem[] = [
      ['Add Reaction…', () => emojiPicker(new DOMRect(at.x, at.y, 0, 0), (e) => react(m, e, true))],
      ['Reply', () => this.startReply(m)],
      ['Forward…', () => forwardDialog(m)],
    ];
    if (mine && m.text) items.push(['Edit', () => this.startEdit(m.id)]);
    const { posted, inFiles } = linkedFiles(m);
    if (posted.length) items.push(['Save to Files…', () => saveToFiles(posted)]);
    if (inFiles.length) items.push(['Open Folder', () => hooks.revealMedia(inFiles[0])]);
    items.push(null, ['Copy Text', () => copyText(m.text || m.fwd?.text || '')],
      ['Copy Link', () => copyText(`${location.origin}/#chan=${m.channel}&msg=${m.id}`)]);
    if (canPin(m.channel)) items.push(m.pinned ? ['Unpin Message', () => setPinned(m, false)] : ['Pin Message', () => setPinned(m, true)]);
    if (mine || canModerate(m.channel)) items.push(null, ['Delete', () => deleteMessage(m, false)]);
    return items;
  }

  // reactions is the row of emoji chips: click one to add or take back yours.
  reactions(m: Message) {
    const box = h('div', { class: 'reactions' });
    for (const r of m.reactions ?? []) {
      const mine = r.users.includes(user.name);
      const b = h('button', { class: 'reaction' + (mine ? ' mine' : ''), title: `${r.users.join(', ')} reacted with ${r.emoji}` },
        emojiImg(r.emoji), h('span', { class: 'count' }, String(r.users.length)));
      b.onclick = () => react(m, r.emoji, !mine);
      box.append(b);
    }
    const add = h('button', { class: 'reaction add', title: 'Add reaction', innerHTML: ICON.react });
    add.onclick = (e) => {
      if (pressedOn(add, e)) emojiPicker(add.getBoundingClientRect(), (em) => react(m, em, true));
    };
    box.append(add);
    return box;
  }

  startReply(m: Message) {
    this.replyTo = m;
    const x = h('button', { class: 'tool', title: 'Cancel reply (Esc)', innerHTML: ICON.close });
    x.onclick = () => this.cancelReply();
    this.replyBar.replaceChildren(h('span', {}, 'Replying to ', h('b', {}, m.user)), x);
    this.replyBar.hidden = false;
    this.compose.focus();
  }

  cancelReply() {
    this.replyTo = null;
    this.replyBar.hidden = true;
  }

  // jumpTo scrolls to a message, loading older ones until it's there, and flashes it.
  async jumpTo(id: string) {
    for (let i = 0; i < 100 && this.hasOlder && !this.msgs.some((m) => m.id === id); i++) await this.loadOlder();
    const el = this.list.querySelector<HTMLElement>(`.msg[data-id="${id}"]`);
    if (!el) {
      toast('That message is gone');
      return;
    }
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }

  // embeds is the preview cards under a message, filled in as the server answers. A card
  // arriving while the pane is at the bottom keeps it at the bottom.
  embeds(links: string[]) {
    const box = h('div', { class: 'embeds' });
    for (const url of links) {
      const slot = h('div', { class: 'embed-slot' });
      box.append(slot);
      const p = previews.get(url);
      if (p && !(p instanceof Promise)) {
        if (p.kind !== 'none') slot.replaceWith(card(p));
        continue;
      }
      getPreview(url).then((got) => {
        if (!got || got.kind === 'none' || !slot.isConnected) return;
        slot.replaceWith(card(got)); // at the bottom, keep() keeps it there
      });
    }
    return box;
  }

  startEdit(id: string) {
    this.editing = id;
    this.render();
    const box = this.list.querySelector<HTMLTextAreaElement>('.msg textarea');
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.scrollIntoView({ block: 'nearest' });
    }
  }

  editBox(m: Message) {
    const box = h('textarea', { value: m.text, rows: 1, maxLength: 4000 });
    const done = () => {
      this.editing = null;
      this.render();
      this.compose.focus();
    };
    const save = async () => {
      const text = box.value.trim();
      if (text === m.text) return done();
      const r = await req('PATCH', `/api/channels/${m.channel}/messages/${m.id}`, JSON.stringify({ text }));
      if (!r.ok) {
        toastError(`Couldn’t save it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
        return;
      }
      done();
    };
    const ac = autocomplete(box, mentionNames);
    box.onkeydown = (e) => {
      if (ac.key(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        done();
      }
    };
    box.oninput = () => grow(box);
    queueMicrotask(() => grow(box));
    const saveBtn = h('button', { class: 'primary' }, 'Save');
    saveBtn.onclick = save;
    const cancel = h('button', {}, 'Cancel');
    cancel.onclick = done;
    // Desktop shows the keys (Enter and Esc in blurple, clickable like Discord's); phones,
    // with no keyboard to speak of, get Save and Cancel instead (the CSS picks).
    const enterKey = h('button', { class: 'key', type: 'button', title: 'Save' }, 'Enter');
    enterKey.onclick = save;
    const escKey = h('button', { class: 'key', type: 'button', title: 'Cancel' }, 'Esc');
    escKey.onclick = done;
    return h('div', { class: 'msg-edit' }, box,
      h('div', { class: 'hint' }, enterKey, ' to save · ', escKey, ' to cancel'),
      saveBtn, cancel);
  }

  nearBottom() {
    const b = this.list;
    return b.scrollHeight - b.scrollTop - b.clientHeight < 60;
  }

  scrollToBottom() {
    this.stuck = true;
    this.anchor = null;
    this.setTop(this.list.scrollHeight);
  }

  private setTop(top: number) {
    this.list.scrollTop = top;
    this.ownTop = this.list.scrollTop; // as clamped
  }

  // bottomEdge is the message on the bottom edge of the view and how far its bottom is
  // above the view's bottom.
  private bottomEdge() {
    const view = this.list.getBoundingClientRect();
    let best: HTMLElement | null = null;
    for (const el of this.items.children as HTMLCollectionOf<HTMLElement>) {
      if (el.getBoundingClientRect().top >= view.bottom) break;
      best = el;
    }
    return best && { el: best, fromBottom: view.bottom - best.getBoundingClientRect().bottom };
  }

  // keep holds the view in place after the list changed size (see stuck).
  keep() {
    if (!this.list.clientHeight) return; // hidden
    if (this.stuck) return this.setTop(this.list.scrollHeight);
    const a = this.anchor;
    if (!a?.el.isConnected) return;
    const now = this.list.getBoundingClientRect().bottom - a.el.getBoundingClientRect().bottom;
    if (now !== a.fromBottom) this.setTop(this.list.scrollTop + a.fromBottom - now);
  }
}

// ---- setup and shared state ----

export function setupChat(events: Live, h_: Hooks) {
  hooks = h_;
  side = new ChatView($('chat-body'), 'mt-chat-side', 'general');
  main = new ChatView($('main-chat-body'), 'mt-chat-main', 'general');
  // Each pane's header gets buttons for its chat's files and pinned messages (pins rightmost).
  for (const [v, place] of [[main, (b: HTMLElement) => $('main-chat-title').parentElement!.append(b)], [side, (b: HTMLElement) => $('chat-hide').before(b)]] as const) {
    const b = h('button', { class: 'tool pins-btn', title: 'Pinned messages', innerHTML: ICON.pin });
    b.onclick = (e) => {
      e.stopPropagation();
      showPins(v, b);
    };
    const f = h('button', { class: 'tool files-btn', title: 'Files in this chat', innerHTML: ICON.files });
    f.onclick = (e) => {
      e.stopPropagation();
      showFiles(v, f);
    };
    place(f);
    place(b);
  }
  // Popovers (emoji picker, pins) close on a click elsewhere or Esc.
  document.addEventListener('mousedown', (e) => {
    if (pop && !pop.contains(e.target as Node) && !popAnchor?.contains(e.target as Node)) closePop();
  });
  document.addEventListener('keydown', (e) => {
    if (pop && e.key === 'Escape') {
      e.stopPropagation();
      closePop();
    }
  }, true);

  const select = $('chat-select') as HTMLSelectElement;
  select.onchange = () => {
    side.setChannel(select.value);
    renderChannels();
  };
  // + : a new chat (admins: also a private one), a direct message, a voice chat or sharing
  // your screen (VOICE and LIVE only show while in use, so they start here too).
  $('new-channel').onclick = (e) => {
    showMenu(e, [['New Chat', newChannel], ...(isAdmin(user.name) ? [['New Private Chat…', newPrivateChat]] as MenuItem[] : []),
      ['New Direct Message…', newDM], ...voiceMenuItems(), ...streamMenuItems()], $('new-channel'));
  };

  const views = () => [side, main];
  events.addEventListener('message', (e) => {
    const m: Message = JSON.parse((e as MessageEvent).data);
    const c = channels.find((x) => x.name === m.channel);
    if (c) c.last_id = m.id;
    else loadChannels(); // a DM that was hidden, or just started
    views().forEach((v) => v.onMessage(m));
    markRead();
    renderChannels();
    dingFor(m.channel, m.user);
  });
  setupDing(() => views().filter((v) => v.shown()).map((v) => v.channel));
  events.addEventListener('edit', (e) => views().forEach((v) => v.onEdit(JSON.parse((e as MessageEvent).data))));
  events.addEventListener('delete', (e) => views().forEach((v) => v.onDelete(JSON.parse((e as MessageEvent).data))));
  // A chat was added, renamed or deleted. Panes on a renamed chat follow it (and keep
  // its unread marker); panes on a deleted one fall back to the first (loadChannels).
  events.addEventListener('channel', (e) => {
    const { renamed, name } = JSON.parse((e as MessageEvent).data);
    if (renamed) {
      // Known at once, so links to files posted under the old name still resolve while the
      // panes reload (loadChannels below fetches the real list).
      renames.push({ from: renamed, to: name });
      const c = channels.find((x) => x.name === renamed);
      if (c) c.name = name;
      if (lastRead[renamed]) {
        lastRead[name] = lastRead[renamed];
        delete lastRead[renamed];
        store('mt-read', JSON.stringify(lastRead));
      }
      if (drafts[renamed]) {
        setDraft(name, drafts[renamed]);
        setDraft(renamed, '');
      }
      if (side.channel === renamed) side.setChannel(name);
      if (main.channel === renamed) {
        main.setChannel(name);
        setMainTitle();
        if (hooks.mainShowsChat()) history.replaceState(null, '', '#chan=' + name);
      }
    }
    loadChannels();
  });
  // (Re)connected: catch up on anything missed while the stream was down.
  events.addEventListener('open', async () => {
    await loadChannels();
    side.refresh();
    if (hooks.mainShowsChat()) main.refresh();
  });
  window.addEventListener('focus', markRead);
  document.addEventListener('visibilitychange', markRead);
}

// resolveChannel is where a chat is now: itself if it exists, else followed through its
// renames (an old link or bookmark); null if it's gone.
function resolveChannel(name: string): string | null {
  const exists = (n: string) => channels.some((c) => c.name === n);
  if (exists(name)) return name;
  let cur = name;
  for (const r of renames) if (r.from === cur) cur = r.to;
  return exists(cur) ? cur : null;
}

// openInMain shows a channel in the main panel (picked in the left list, or from a link),
// and scrolls to one message if msg is given. An old name follows its renames.
export function openInMain(name: string, msg = '') {
  name = resolveChannel(name) ?? name; // before the list loads, loadChannels fixes it up
  const loaded = main.setChannel(name);
  setMainTitle();
  hooks.showMainChat();
  grow(main.compose); // now it's on screen: fit its draft
  renderChannels();
  if (msg) loaded.then(() => main.jumpTo(msg));
}

export function mainChannel() {
  return main.channel;
}

// layoutChanged is called when a pane is shown or hidden: what's on screen counts as read.
export function layoutChanged() {
  for (const v of [side, main]) if (v) grow(v.compose);
  markRead();
  renderChannels();
}

// onUsersChanged: accounts changed (an admin's tag colour, or who's an admin).
export function onUsersChanged() {
  side?.render();
  main?.render();
}

export function onFilesChanged() {
  side?.render(); // #path links may have appeared or gone
  main?.render();
}

async function loadChannels() {
  const [list, rn] = await Promise.all([req('GET', '/api/channels'), req('GET', '/api/channel-renames')]);
  channels = await json<ChannelInfo[]>(list);
  if (rn.ok) renames = await rn.json();
  // A pane on a chat that's no longer there follows its renames, or falls back to the first.
  for (const v of [side, main]) {
    if (channels.some((c) => c.name === v.channel) || !channels.length) continue;
    v.setChannel(resolveChannel(v.channel) ?? channels[0].name);
    if (v === main) {
      setMainTitle();
      if (hooks.mainShowsChat()) history.replaceState(null, '', '#chan=' + main.channel);
    }
  }
  for (const v of [side, main]) v.labels(); // a chat may have become private or public
  // Drafts of chats that are gone (deleted, or no longer yours) go too; a renamed one's
  // moves to the new name.
  if (channels.length) {
    for (const name of Object.keys(drafts)) {
      const now = resolveChannel(name);
      if (now === name) continue;
      if (now && !drafts[now]) setDraft(now, drafts[name]);
      setDraft(name, '');
    }
  }
  setMainTitle();
  renderChannels();
}

// ---- kinds of chat: public, private, DM ----

const info = (name: string) => channels.find((c) => c.name === name);

// dmPeople is who a DM is with: everyone in it but you.
function dmPeople(c: ChannelInfo) {
  const others = (c.members ?? []).filter((m) => m !== user.name);
  return (others.length ? others : [user.name]).join(', ');
}

// chatTitle is how a chat is named on screen: "#name" ("# name" with space), or "@" and
// the people for a DM.
export function chatTitle(name: string, space = true) {
  const c = info(name);
  if (c?.kind === 'dm') return '@' + (space ? ' ' : '') + dmPeople(c);
  return '#' + (space ? ' ' : '') + name;
}
labels.chat = chatTitle;

function setMainTitle() {
  if (!main) return;
  const c = info(main.channel);
  $('main-chat-title').replaceChildren(chatTitle(main.channel), ...(c?.kind === 'private' ? [h('span', { class: 'lock', title: 'Private chat', innerHTML: ICON.lock })] : []));
}

// In a DM its people are equals: admins have no extra powers there (they can't see DMs).
const canModerate = (name: string) => isAdmin(user.name) && info(name)?.kind !== 'dm';
const canPin = (name: string) => isAdmin(user.name) || info(name)?.kind === 'dm';

// MAX_POSTED is the biggest file chat takes (bigger ones go in Files, in large/).
const MAX_POSTED = 50 << 20;

// postFiles posts files in a chat, kept with it (not in Files). A pasted picture (always
// image.png) is named after the time and who posted it. Returns the paths to link.
async function postFiles(files: File[], name: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const file = /^image\.\w+$/.test(f.name) ? hooks.stampName(f) : f.name;
    let r;
    try {
      r = await hooks.send(`/api/channels/${enc(name)}/media?name=${encodeURIComponent(file)}`, f,
        (x) => toast(`Uploading ${file}: ${Math.floor(x * 100)}% of ${bytes(f.size)}`, 0));
    } catch (e) {
      toastError(`Couldn’t upload ${file}: ${(e as Error).message}.`);
      break;
    }
    if (r.status !== 200) {
      toastError(`Couldn’t upload ${file}: ${r.body?.error ?? r.status}.`);
      break;
    }
    out.push(r.body.path);
  }
  if (out.length) toast(`Uploaded ${out.length} file${out.length > 1 ? 's' : ''}`);
  return out;
}

// attachment: a link to a file posted in a chat (media/<chat>/<file>, following renames),
// with the chat as it's named now and the file. null for anything else.
function attachment(path: string): { chat: string; file: string } | null {
  const m = /^media\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m) return null;
  const chat = resolveChannel(m[1]);
  return chat ? { chat, file: m[2] } : null;
}

// attachURL is where a file posted in a chat is fetched from.
const attachURL = (a: { chat: string; file: string }, download = false) =>
  `/api/channels/${enc(a.chat)}/media/${encodeURIComponent(a.file)}${download ? '?download=1' : ''}`;

// resolveRef is where a #path link points: a file posted in a chat, under the chat's name
// now, else the file in Files where it is now (null if it's gone).
const resolveRef = (written: string) => {
  const a = attachment(written);
  return a ? `media/${a.chat}/${a.file}` : hooks.resolvePath(written);
};

// mediaURL is where a picture's, video's or sound's file is fetched from.
const mediaURL = (path: string) => { const a = attachment(path); return a ? attachURL(a) : `/api/file/${enc(path)}`; };

// saveToFiles copies files posted in chat into a Files folder the person picks.
function saveToFiles(paths: string[]) {
  const what = paths.length === 1 ? paths[0].slice(paths[0].lastIndexOf('/') + 1) : `${paths.length} files`;
  folderPicker({
    heading: `Save ${what} to Files?`,
    body: `${paths.length === 1 ? 'A copy goes' : 'Copies go'} in the folder you pick; the chat keeps its own.`,
    confirm: 'Save',
    priv: paths.some((p) => !!info(attachment(p)?.chat ?? '')?.kind),
    done: async (dir) => {
      const saved: string[] = [];
      for (const p of paths) {
        const a = attachment(p);
        if (!a) continue;
        const r = await req('POST', `/api/channels/${enc(a.chat)}/media/${encodeURIComponent(a.file)}/save`, JSON.stringify({ dir }));
        if (!r.ok) {
          toastError(`Couldn’t save ${a.file}: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
          break;
        }
        saved.push((await json<{ path: string }>(r)).path);
      }
      if (saved.length === 1) toast(`Saved to ${saved[0]}`);
      else if (saved.length) toast(`Saved ${saved.length} files`);
      if (saved.length === 1) hooks.openPath(saved[0]);
    },
  });
}

// memberPicker is the dialog for picking people (style guide 14): a search box, a tick
// list of accounts, then the confirm button. Used to start a DM ("Message") and, for
// admins, to make a private chat or change its members. name (optional) asks for a new
// chat's name too.
export function memberPicker(o: { heading: string; confirm: string; picked?: string[]; max?: number; askName?: boolean; note?: string;
  done: (members: string[], name: string) => Promise<string | null> }) {
  const picked = new Set(o.picked ?? []);
  const search = h('input', { type: 'text', placeholder: 'Find people…', autocomplete: 'off', spellcheck: false });
  const nameBox = h('input', { type: 'text', placeholder: 'chat-name', autocomplete: 'off', spellcheck: false });
  const list = h('div', { class: 'member-pick' });
  const err = h('div', { class: 'error' });
  const ok = h('button', { class: 'primary' }, o.confirm);
  const cancel = h('button', {}, 'Cancel');
  const people = accounts.map((a) => a.name).filter((n) => n !== user.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const show = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren(...people.filter((n) => n.toLowerCase().includes(q)).map((n) => {
      const box = h('input', { type: 'checkbox', checked: picked.has(n) });
      box.onchange = () => {
        if (box.checked) picked.add(n);
        else picked.delete(n);
        check();
      };
      return h('label', { class: 'check member' }, box, h('span', {}, n));
    }));
    if (!list.children.length) list.append(h('div', { class: 'muted pad' }, 'Nobody by that name.'));
  };
  const check = () => {
    const tooMany = o.max !== undefined && picked.size > o.max;
    err.textContent = tooMany ? `At most ${o.max} people, plus you.` : '';
    ok.disabled = tooMany || (o.max !== undefined && picked.size === 0) || (!!o.askName && !nameBox.value.trim());
  };
  ok.onclick = async () => {
    ok.disabled = true;
    const e = await o.done([...picked], nameBox.value.trim());
    if (e) {
      err.textContent = e;
      ok.disabled = false;
    } else closeDialog();
  };
  cancel.onclick = closeDialog;
  search.oninput = show;
  nameBox.oninput = check;
  dialog(h('h2', {}, o.heading), ...(o.askName ? [nameBox] : []), search, list,
    o.note ? h('p', { class: 'muted' }, o.note) : '', err, h('div', { class: 'actions' }, cancel, ok));
  show();
  check();
  (o.askName ? nameBox : search).focus();
}

// messageUser opens your direct message with one person (made if it's new).
export async function messageUser(name: string) {
  const r = await req('POST', '/api/dms', JSON.stringify({ members: [name] }));
  const b = await r.json().catch(() => ({}));
  if (!r.ok) return toastError(b.error ?? 'Couldn’t open the direct message');
  await loadChannels();
  openInMain(b.name);
}

function newDM() {
  memberPicker({
    heading: 'New direct message', confirm: 'Message', max: 9,
    note: 'Only the people in it can see it, not even admins.',
    done: async (members) => {
      const r = await req('POST', '/api/dms', JSON.stringify({ members }));
      const b = await r.json().catch(() => ({}));
      if (!r.ok) return b.error ?? 'Couldn’t start it';
      await loadChannels();
      openInMain(b.name);
      return null;
    },
  });
}

function newPrivateChat() {
  memberPicker({
    heading: 'New private chat', confirm: 'Create', askName: true,
    note: 'Its members and the admins can see it.',
    done: async (members, name) => {
      const r = await req('POST', '/api/channels', JSON.stringify({ name, kind: 'private', members }));
      if (!r.ok) return (await r.json().catch(() => ({}))).error ?? 'Couldn’t make it';
      await loadChannels();
      openInMain(name);
      return null;
    },
  });
}

// setKind makes a chat private (with members), changes its members, or makes it public.
function editMembers(name: string) {
  const c = info(name);
  memberPicker({
    heading: c?.kind === 'private' ? `Members of #${name}` : `Make #${name} private`,
    confirm: c?.kind === 'private' ? 'Save' : 'Make Private',
    picked: (c?.members ?? []).filter((m) => m !== user.name),
    note: c?.kind === 'private' ? 'Admins can always see it.'
      : 'Only the people ticked (and the admins) will see it. Pictures already posted stay in Files, where everyone can see them.',
    done: async (members) => {
      const r = await req('PUT', `/api/channels/${name}/kind`, JSON.stringify({ kind: 'private', members: [...members, user.name] }));
      if (!r.ok) return (await r.json().catch(() => ({}))).error ?? 'Couldn’t change it';
      await loadChannels();
      return null;
    },
  });
}

async function makePublic(name: string) {
  const r = await req('PUT', `/api/channels/${name}/kind`, JSON.stringify({ kind: '' }));
  if (!r.ok) toastError(`Couldn’t make it public: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
  else await loadChannels();
}

async function hideDM(name: string) {
  const r = await req('POST', `/api/channels/${name}/hide`);
  if (!r.ok) return toastError('Couldn’t hide it.');
  await loadChannels(); // a pane showing it moves on to another chat
}

function markRead() {
  let changed = false;
  for (const v of [side, main]) {
    const id = v?.seenUpTo();
    if (id && (lastRead[v.channel] ?? '') < id) {
      lastRead[v.channel] = id;
      changed = true;
    }
  }
  if (changed) {
    store('mt-read', JSON.stringify(lastRead));
    renderChannels();
  }
}

export function renderChannels() {
  const list = $('channels');
  const select = $('chat-select') as HTMLSelectElement;
  list.replaceChildren();
  select.replaceChildren();
  let count = 0;
  // One list (Paul, S44): chats in the shared order admins set by dragging (the server's
  // order), then DMs ("@" and who they're with), the most recent message first.
  const newest = (a: ChannelInfo, b: ChannelInfo) => (b.last_id > a.last_id ? 1 : b.last_id < a.last_id ? -1 : chatTitle(a.name).localeCompare(chatTitle(b.name)));
  const sorted = [...channels.filter((c) => c.kind !== 'dm'), ...channels.filter((c) => c.kind === 'dm').sort(newest)];
  for (const c of sorted) {
    const unread = c.last_id !== '' && c.last_id > (lastRead[c.name] ?? '');
    if (unread) count++;
    const active = hooks.mainShowsChat() && c.name === main.channel;
    const renaming = chanEdit?.kind === 'rename' && chanEdit.name === c.name;
    const dm = c.kind === 'dm';
    const row = h('div', { class: 'row channel' + (active ? ' active' : '') + (unread ? ' unread' : '') + (dm ? ' dm' : '') },
      h('span', { class: 'hash' }, dm ? '@' : '#'),
      renaming ? renameBox(c.name) : h('span', { class: 'name' }, dm ? dmPeople(c) : c.name),
      ...(c.kind === 'private' ? [h('span', { class: 'lock', title: 'Private chat', innerHTML: ICON.lock })] : []));
    row.onclick = () => openInMain(c.name);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      chanMenu(e, c.name, unread);
    };
    if (!dm && !renaming && isAdmin(user.name)) draggableChat(row, c.name);
    list.append(row);
    if (renaming && chanError) list.append(h('div', { class: 'chan-error' }, chanError));
    select.append(h('option', { value: c.name, selected: c.name === side.channel },
      `${chatTitle(c.name)}${c.kind === 'private' ? ' (private)' : ''}${unread ? '  •' : ''}`));
  }
  document.title = count ? `(${count}) MacroTech` : 'MacroTech';
  if (chanEdit?.kind === 'new') {
    const row = h('div', { class: 'row channel editing' }, h('span', { class: 'hash' }, '#'), newChatBox());
    list.prepend(...(chanError ? [row, h('div', { class: 'chan-error' }, chanError)] : [row]));
  }
  const box = list.querySelector<HTMLInputElement>('input.rename');
  if (box && chanFocus) {
    chanFocus = false;
    box.focus();
    if (chanDraft === null) box.select();
  }
  if (box) chanDraft = box.value;
}

// chanMenu is a chat's right-click menu. Rename and delete are for admins (the server
// checks too).
function chanMenu(e: MouseEvent, name: string, unread: boolean) {
  const items: MenuItem[] = [
    ['Open', () => openInMain(name)],
    ['Open in Side Panel', () => {
      side.setChannel(name);
      hooks.showSidePanel();
      renderChannels();
    }],
  ];
  if (unread) {
    items.push(['Mark as Read', () => {
      const c = channels.find((x) => x.name === name);
      if (c) lastRead[name] = c.last_id;
      store('mt-read', JSON.stringify(lastRead));
      renderChannels();
    }]);
  }
  items.push(null, ['Copy Link', () => copyText(`${location.origin}/#chan=${name}`)]);
  const kind = info(name)?.kind;
  if (kind === 'dm') items.push(null, ['Hide', () => hideDM(name)]);
  else if (isAdmin(user.name)) {
    const chats = chatOrder();
    const at = chats.indexOf(name);
    items.push(null, ...(at > 0 ? [['Move Up', () => moveChat(name, at - 1)]] as MenuItem[] : []),
      ...(at < chats.length - 1 ? [['Move Down', () => moveChat(name, at + 1)]] as MenuItem[] : []));
    items.push(null, ...(kind === 'private'
      ? [['Members…', () => editMembers(name)], ['Make Public', () => makePublic(name)]] as MenuItem[]
      : [['Make Private…', () => editMembers(name)]] as MenuItem[]),
    null, ['Rename…', () => openChanEdit({ kind: 'rename', name })], ['Delete', () => deleteChannel(name)]);
  }
  showMenu(e, items);
}

// ---- the chat list's order (admins, shared by everyone, as on Discord) ----

const chatOrder = () => channels.filter((c) => c.kind !== 'dm').map((c) => c.name);

// moveChat puts a chat at a place in the list (counting chats only) and saves the order for
// everyone. The list moves at once; if the server says no, it's reloaded.
async function moveChat(name: string, to: number) {
  const order = chatOrder().filter((n) => n !== name);
  order.splice(to, 0, name);
  const rank = new Map(order.map((n, i) => [n, i]));
  channels.sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity));
  renderChannels();
  const r = await req('PUT', '/api/channel-order', JSON.stringify({ names: order }));
  if (!r.ok) {
    toastError(`Couldn’t reorder the chats: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
    loadChannels();
  }
}

// draggableChat lets an admin drag a chat row up or down the list: a line shows where it
// lands (above or below the row under the pointer).
let dragged: string | null = null;
function draggableChat(row: HTMLElement, name: string) {
  row.draggable = true;
  row.ondragstart = (e) => {
    dragged = name;
    e.dataTransfer!.setData('text/x-mt-chat', name);
    e.dataTransfer!.effectAllowed = 'move';
    row.classList.add('dragging');
  };
  row.ondragend = () => {
    dragged = null;
    row.classList.remove('dragging');
    for (const x of $('channels').querySelectorAll('.drop-above, .drop-below')) x.classList.remove('drop-above', 'drop-below');
  };
  const below = (e: DragEvent) => {
    const r = row.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  row.ondragover = (e) => {
    if (!dragged || dragged === name) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    row.classList.toggle('drop-below', below(e));
    row.classList.toggle('drop-above', !below(e));
  };
  row.ondragleave = () => row.classList.remove('drop-above', 'drop-below');
  row.ondrop = (e) => {
    if (!dragged || dragged === name) return;
    e.preventDefault();
    const from = dragged;
    const order = chatOrder().filter((n) => n !== from);
    moveChat(from, order.indexOf(name) + (below(e) ? 1 : 0));
  };
}

function openChanEdit(edit: NonNullable<typeof chanEdit>) {
  chanEdit = edit;
  chanDraft = null;
  chanError = '';
  chanFocus = true;
  renderChannels();
}

// chatName tidies a chat name as it's typed, the Discord way: lowercase, spaces become -,
// anything but letters, digits and - is dropped.
const chatName = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');

// chanNameBox is the inline name editor behind New chat and Rename. Enter or clicking away
// saves (an empty or unchanged name just closes it), Esc cancels. save returns an error to
// show under the box, which then stays open; null closes it.
function chanNameBox(initial: string, save: (name: string) => Promise<string | null>) {
  const mine = chanEdit;
  const box = h('input', { class: 'rename', value: chanDraft ?? initial, spellcheck: false, maxLength: 32 });
  box.oninput = () => {
    const at = chatName(box.value.slice(0, box.selectionStart ?? box.value.length)).length;
    box.value = chatName(box.value);
    box.setSelectionRange(at, at);
    chanDraft = box.value;
    if (chanError) {
      chanError = '';
      box.closest('.row')?.parentElement?.querySelector('.chan-error')?.remove();
    }
  };
  let busy = false;
  const finish = async (submit: boolean, refocus: boolean) => {
    if (chanEdit !== mine || busy) return;
    const name = box.value.replace(/^-+|-+$/g, '');
    if (!submit || !name || name === initial) {
      chanEdit = chanDraft = null;
      chanError = '';
      return renderChannels();
    }
    busy = true;
    const err = await save(name);
    busy = false;
    if (chanEdit !== mine) return;
    if (err) {
      chanError = err;
      chanDraft = box.value;
      chanFocus = refocus;
    } else {
      chanEdit = chanDraft = null;
      chanError = '';
    }
    renderChannels();
  };
  box.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true, true);
    if (e.key === 'Escape') finish(false, false);
  };
  box.onclick = (e) => e.stopPropagation();
  box.onblur = () => setTimeout(() => {
    if (!(document.activeElement as HTMLElement | null)?.closest('#channels input.rename')) finish(true, false);
  });
  return box;
}

const chanFail = async (r: Response, name: string) =>
  r.status === 409 ? `#${name} already exists` : (await r.json().catch(() => ({}))).error ?? 'Something went wrong';

function newChatBox() {
  return chanNameBox('', async (name) => {
    const r = await req('POST', '/api/channels', JSON.stringify({ name }));
    if (!r.ok) return chanFail(r, name);
    await loadChannels();
    openInMain(name);
    return null;
  });
}

function renameBox(from: string) {
  return chanNameBox(from, async (to) => {
    const r = await req('PATCH', `/api/channels/${encodeURIComponent(from)}`, JSON.stringify({ name: to }));
    return r.ok ? null : chanFail(r, to);
  });
}

// deleteChannel deletes a chat (admins).
async function deleteChannel(name: string) {
  if (!await ask({ title: `Delete #${name}?`, body: 'It disappears for everyone. Its messages and files are kept on the server (chat/.deleted).', confirm: 'Delete', danger: true })) return;
  const r = await req('DELETE', `/api/channels/${encodeURIComponent(name)}`);
  if (!r.ok) toastError(`Couldn’t delete #${name}: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
}

// addToLarge is the question for files too big for chat (over 50 MB): put them in large/ in
// Files and link them. From a private chat or DM (priv), it warns that Files is everyone's.
async function addToLarge(files: File[], add: () => void, priv = false) {
  const one = files.length === 1;
  const ok = await ask({
    title: `Add ${one ? files[0].name : `${files.length} files`} to Files?`,
    body: h('div', {},
      h('p', {}, `Chat takes files up to 50 MB, so ${one ? 'this one goes' : 'these go'} in large/ in Files (which keeps no version history), with a link in your message.`),
      priv ? h('p', { class: 'warn-line' }, 'This is a private conversation, but Files is visible to everyone in the hub.') : ''),
    confirm: 'Add and link',
  });
  if (ok) add();
}

// folderPicker asks for a Files folder (style guide 14): a box and every folder, starting at
// the tree's selected one; typing narrows the list, or names a new folder. Then Cancel and
// the confirm button; Esc cancels. priv warns that Files is everyone's.
function folderPicker(o: { heading: string; body: string; confirm: string; priv: boolean; done: (dir: string) => void }) {
  const all = ['', ...hooks.folders().sort((a, b) => a.localeCompare(b))];
  const box = h('input', { type: 'text', value: hooks.currentFolder(), placeholder: 'Folder…', autocomplete: 'off', spellcheck: false });
  const list = h('div', { class: 'folder-pick' });
  const ok = h('button', { class: 'primary' }, o.confirm);
  const cancel = h('button', {}, 'Cancel');
  const dir = () => box.value.trim().replace(/^\/+|\/+$/g, '');
  let typed = false; // the list narrows to what's typed; until then (or after a click) it's every folder
  const show = () => {
    const want = dir().toLowerCase();
    const shown = typed ? all.filter((d) => d.toLowerCase().includes(want)) : all;
    list.replaceChildren(...shown.slice(0, 200).map((d) => {
      const b = h('button', { class: 'folder-row' + (d === dir() ? ' picked' : '') }, d ? d + '/' : 'Top level');
      b.onclick = () => {
        box.value = d;
        typed = false;
        show();
        box.focus();
      };
      return b;
    }));
    list.querySelector('.picked')?.scrollIntoView({ block: 'nearest' });
    const isNew = dir() !== '' && !all.includes(dir());
    note.textContent = isNew ? `${dir()}/ is a new folder; it’s made for you.` : '';
  };
  const note = h('div', { class: 'muted folder-note' });
  const go = () => {
    closeDialog();
    o.done(dir());
  };
  ok.onclick = go;
  cancel.onclick = closeDialog;
  box.oninput = () => {
    typed = true;
    show();
  };
  box.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  };
  dialog(h('h2', {}, o.heading), h('p', {}, o.body), box, list, note,
    o.priv ? h('p', { class: 'warn-line' }, 'This is a private conversation, but Files is visible to everyone in the hub.') : '',
    h('div', { class: 'actions' }, cancel, ok));
  show();
  box.select();
}

// newChannel opens the inline name box at the top of the chat list.
function newChannel() {
  openChanEdit({ kind: 'new' });
}

// ---- message actions ----

function react(m: Message, emoji: string, on: boolean) {
  req(on ? 'PUT' : 'DELETE', `/api/channels/${m.channel}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`)
    .then(async (r) => r.ok || toastError(`Couldn’t react: ${(await r.json().catch(() => ({}))).error ?? r.status}.`));
}

function setPinned(m: Message, on: boolean) {
  req(on ? 'PUT' : 'DELETE', `/api/channels/${m.channel}/messages/${m.id}/pin`)
    .then(async (r) => (r.ok ? toast(on ? 'Pinned' : 'Unpinned') : toastError(`Couldn’t pin it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`)));
}

// deleteMessage deletes a message. When it's the last link to files posted in chat (nothing
// else in any chat links them), the question offers to delete those too, ticked; it shows
// even on Shift+click, since they have no history. Files still linked elsewhere stay.
async function deleteMessage(m: Message, noQuestion: boolean) {
  const o = await req('GET', `/api/channels/${m.channel}/messages/${m.id}/orphans`);
  const files = o.ok ? (await json<{ paths: string[] }>(o)).paths : [];
  const one = files.length === 1;
  const check = files.length ? {
    label: h('span', {}, `Also delete ${one ? 'its file' : `its ${files.length} files`}: `, h('b', {}, files.map((p) => p.slice(p.lastIndexOf('/') + 1)).join(', ')),
      `. No other message links ${one ? 'it' : 'them'}, and files posted in chat have no history: this can’t be undone.`),
    value: true,
  } : undefined;
  if ((!noQuestion || check) && !await ask({ title: 'Delete this message?', confirm: 'Delete', danger: true, check })) return;
  const r = await req('DELETE', `/api/channels/${m.channel}/messages/${m.id}${check?.value ? '?files=1' : ''}`);
  if (!r.ok) toastError(`Couldn’t delete it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
}

// forwardDialog picks a chat to forward a message to, with an optional note. The target
// gets a copy, so it survives the original changing.
function forwardDialog(m: Message) {
  const src = m.text ? m : { ...m, user: m.fwd?.user ?? m.user, text: m.fwd?.text ?? '' };
  chatPicker('Forward to', h('div', { class: 'fwd-preview' }, h('b', {}, src.user), ' ', snippet(plainText(src.text))),
    (target, note) => ({ text: note, forward: { channel: m.channel, id: m.id } }), 'Forwarded');
}

// shareLink posts a link (to a picture, file, screenshot…) in a chat picked from a list,
// with an optional note: the viewer's Forward when it wasn't opened from a message.
export function shareLink(link: string) {
  chatPicker('Forward to', h('div', { class: 'fwd-preview' }, plainText(link)),
    (target, note) => ({ text: note.trim() ? `${note.trim()}\n${link}` : link }), 'Sent');
}

// chatPicker is the dialog behind both: a preview, the chats to pick from, a note, Send.
// body makes the message to post.
function chatPicker(heading: string, preview: HTMLElement, body: (target: string, note: string) => object, done: string) {
  let target = '';
  const send = h('button', { class: 'primary', disabled: true }, 'Forward');
  const list = h('div', { class: 'fwd-list' });
  for (const c of channels) {
    const b = h('button', { class: 'fwd-chan' }, h('span', { class: 'hash' }, c.kind === 'dm' ? '@' : '#'), c.kind === 'dm' ? dmPeople(c) : c.name);
    b.onclick = () => {
      target = c.name;
      for (const x of list.children) x.classList.toggle('picked', x === b);
      send.disabled = false;
    };
    list.append(b);
  }
  const note = h('textarea', { placeholder: 'Add a message (optional)', rows: 2, maxLength: 4000 });
  send.onclick = async () => {
    send.disabled = true;
    const r = await req('POST', `/api/channels/${target}/messages`, JSON.stringify(body(target, note.value)));
    if (!r.ok) {
      send.disabled = false;
      toastError(`Couldn’t forward it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
      return;
    }
    closeDialog();
    toast(`${done} to ${chatTitle(target, false)}`);
  };
  const cancel = h('button', {}, 'Cancel');
  cancel.onclick = closeDialog;
  dialog(h('h2', {}, heading), preview, list, note, h('div', { class: 'actions' }, cancel, send));
}

// forwardBox shows a forwarded copy: the text, and where it came from (click to go there).
function forwardBox(f: Forward) {
  const now = resolveChannel(f.channel);
  const from = h('a', { class: 'fwd-src', href: '#' },
    `#${now ?? f.channel} · ${f.user} · ${dateTime(f.t)}`);
  from.onclick = (e) => {
    e.preventDefault();
    if (now) openInMain(now, f.id);
    else toast('That chat is gone');
  };
  return h('div', { class: 'fwd' }, h('div', { class: 'fwd-label', innerHTML: ICON.forward + '<span>Forwarded</span>' }),
    h('div', { class: 'msg-body' }, ...renderBody(f.text)), from);
}

// ---- popovers: emoji picker, pinned messages ----

let pop: HTMLElement | null = null;
let popAnchor: HTMLElement | null = null; // the button that opened pop; clicking it again closes pop

function closePop() {
  pop?.remove();
  pop = null;
  popAnchor = null;
}

// popover shows content next to a rectangle (a button, or the pointer), kept on screen.
function popover(at: DOMRect, content: HTMLElement, cls: string) {
  closePop();
  pop = h('div', { class: 'popover ' + cls }, content);
  document.body.append(pop);
  const { innerWidth: W, innerHeight: H } = window;
  const w = pop.offsetWidth;
  const ht = pop.offsetHeight;
  pop.style.left = `${Math.max(4, Math.min(at.right - w, W - w - 4))}px`;
  pop.style.top = `${at.bottom + 4 + ht < H ? at.bottom + 4 : Math.max(4, at.top - ht - 4)}px`;
}

// emojiPicker opens the emoji picker (emoji.ts) next to a rectangle. anchor is the button
// that opened it, if any (clicking it again closes the picker).
function emojiPicker(at: DOMRect, pick: (emoji: string) => void, anchor?: HTMLElement) {
  popover(at, pickerContent(pick, closePop), 'emoji-pop');
  popAnchor = anchor ?? null;
}

// showPins lists a pane's pinned messages, most recently pinned first. Click one to jump
// to it; admins can unpin from here.
async function showPins(v: ChatView, anchor: HTMLElement) {
  if (pop && popAnchor === anchor) return closePop();
  const r = await req('GET', `/api/channels/${v.channel}/pins`);
  if (!r.ok) return;
  const pins = await json<Message[]>(r);
  const list = h('div', { class: 'pins-list' });
  for (const m of pins) {
    const item = h('div', { class: 'pin-item', title: 'Jump to the message' },
      h('div', { class: 'msg-head' }, h('span', { class: 'who' }, m.user),
        h('span', { class: 'when' }, dateTime(m.t))),
      h('div', { class: 'msg-body' }, ...renderBody(m.text || m.fwd?.text || '')));
    item.onclick = () => {
      closePop();
      v.jumpTo(m.id);
    };
    if (canPin(v.channel)) {
      const x = h('button', { class: 'tool unpin', title: 'Unpin', innerHTML: ICON.close });
      x.onclick = (e) => {
        e.stopPropagation();
        setPinned(m, false);
        item.remove();
      };
      item.append(x);
    }
    list.append(item);
  }
  if (!pins.length) list.append(h('div', { class: 'muted pad' }, `No pinned messages in ${chatTitle(v.channel, false)} yet.`));
  popover(anchor.getBoundingClientRect(), h('div', {}, h('div', { class: 'pop-head' }, 'Pinned Messages'), list), 'pins-pop');
  popAnchor = anchor;
}

// showFiles lists the files posted in a pane's chat, newest first: a thumbnail or icon, the
// name, who and when, size; click one to jump to its message, or Download / Save to Files.
async function showFiles(v: ChatView, anchor: HTMLElement) {
  if (pop && popAnchor === anchor) return closePop();
  const r = await req('GET', `/api/channels/${enc(v.channel)}/files`);
  if (!r.ok) return;
  const files = await json<{ path: string; size: number; id: string; user: string; t: string }[]>(r);
  const list = h('div', { class: 'pins-list' });
  for (const f of files) {
    const a = attachment(f.path);
    if (!a) continue;
    const pic = IMAGE_EXT.test(a.file)
      ? h('img', { class: 'file-thumb', src: /\.gif$/i.test(a.file) ? attachURL(a) : `/api/channels/${enc(a.chat)}/thumb/${encodeURIComponent(a.file)}`, alt: '', loading: 'lazy' })
      : h('img', { class: 'icon', src: iconURL(a.file, false, false), alt: '' });
    const tool = (icon: keyof typeof ICON, title: string, fn: () => void) => {
      const b = h('button', { class: 'tool', title, innerHTML: ICON[icon] });
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
      return b;
    };
    const dl = h('a', { class: 'tool', href: attachURL(a, true), download: a.file, title: 'Download', innerHTML: ICON.download });
    dl.onclick = (e) => e.stopPropagation();
    const item = h('div', { class: 'file-item', title: 'Jump to the message' }, pic,
      h('div', { class: 'file-text' }, h('div', { class: 'file-name' }, a.file),
        h('div', { class: 'muted file-size' }, `${f.user} · ${dateTime(f.t)} · ${bytes(f.size)}`)),
      h('div', { class: 'file-tools' }, dl, tool('save', 'Save to Files…', () => {
        closePop();
        saveToFiles([f.path]);
      })));
    item.onclick = () => {
      closePop();
      v.jumpTo(f.id);
    };
    list.append(item);
  }
  if (!list.children.length) list.append(h('div', { class: 'muted pad' }, `No files posted in ${chatTitle(v.channel, false)} yet.`));
  popover(anchor.getBoundingClientRect(), h('div', {}, h('div', { class: 'pop-head' }, 'Files'), list), 'pins-pop');
  popAnchor = anchor;
}

// ---- previews: chat media, schematics ----

const MAX_PREVIEWS_MEDIA = 10; // pictures, videos and cards under one message, like Discord
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|flac)$/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|mp4|webm|mov|m4v|mp3|ogg|wav|m4a|flac)$/i;

// isMedia: a linked picture, video or sound chat shows as a preview instead of a link: one in
// Files that's there, or one posted in a chat.
const isMedia = (path: string) => MEDIA_EXT.test(path) && (hooks.fileMod(path) !== null || !!attachment(path));

// shownBelow: a link chat shows under the message instead of in the text: any file posted in
// a chat (a preview, or a file card), a picture, video or sound in Files, a schematic post.
const shownBelow = (path: string) => !!attachment(path) || isMedia(path) || !!hooks.schemPost(path);

// mediaPreviews is what a message's links show underneath, in order: pictures (a thumbnail,
// or the GIF itself so it moves), videos and sounds (players), schematic cards, and a card
// for any other file posted in chat (name, size, Download). They
// stand in for the links, which aren't shown in the text. Clicking a picture or card opens
// it. As pictures arrive the list grows; ChatView.keep holds the view.
function mediaPreviews(text: string, msg?: Message) {
  const seen = new Set<string>();
  const box = h('div', { class: 'refs' });
  // The message's pictures, for the viewer: clicking one opens it on all of them, with
  // Forward (the message) and Open folder (where the picture lives).
  const shown: ViewItem[] = [];
  const view = (item: ViewItem) => {
    shown.push(item);
    const i = shown.length - 1;
    return () => openViewer(shown, i);
  };
  const forward = msg && (() => forwardDialog(msg));
  const pic = (src: string, full: string, title: string, href: string, open: () => void) => {
    const img = thumbOr(h('img', { src, alt: title, loading: 'lazy', draggable: false }), full, () => h('span', { class: 'ref-file' }, title));
    const a = h('a', { class: 'ref-pic', href, title }, img);
    a.onclick = (e) => {
      e.preventDefault();
      open();
    };
    return a;
  };
  for (const m of text.matchAll(TOKEN)) {
    if (seen.size === MAX_PREVIEWS_MEDIA) break;
    const [, , bracketed, bare] = m;
    const written = bracketed ?? bare;
    const path = written === undefined ? null : resolveRef(written);
    if (!path || seen.has(path)) continue;
    // A schematic post (its folder): a card.
    const post = hooks.schemPost(path);
    if (post) {
      seen.add(path);
      const c = h('div', { class: 'ref-card', title: 'Open the post' },
        h('div', { class: 'ref-title' }, post.title),
        h('div', { class: 'ref-file' }, post.file), h('div', { class: 'muted' }, post.credit ? `Design by ${post.credit}` : 'Schematic'));
      c.onclick = () => hooks.openPath(path);
      box.append(c);
      continue;
    }
    const att = attachment(path);
    if (!att && !isMedia(path)) continue;
    seen.add(path);
    const url = mediaURL(path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (att && !MEDIA_EXT.test(path)) {
      box.append(fileCard(att));
    } else if (IMAGE_EXT.test(path)) {
      const src = /\.gif$/i.test(path) ? url : att ? `/api/channels/${enc(att.chat)}/thumb/${encodeURIComponent(att.file)}` : `/api/thumb/${enc(path)}?v=${hooks.fileMod(path)}`;
      box.append(pic(src, url, name, '#' + path, view({ src: url, name, who: msg?.user, when: msg?.t ?? hooks.fileMod(path) ?? undefined,
        forward: forward ?? (() => shareLink(pathRef(path))),
        reveal: att ? undefined : () => hooks.revealMedia(path), save: att ? () => saveToFiles([path]) : undefined })));
    } else if (VIDEO_EXT.test(path)) {
      const v = h('video', { src: url, controls: true, preload: 'metadata', title: name });
      box.append(h('div', { class: 'ref-video' }, v));
    } else if (AUDIO_EXT.test(path)) {
      box.append(h('div', { class: 'ref-audio' }, h('div', { class: 'ref-file' }, name), h('audio', { src: url, controls: true, preload: 'none' })));
    }
  }
  return seen.size ? box : null;
}

// fileCard is a file posted in chat that isn't a picture, video or sound, Discord style: its
// icon, name and size, and Download. Its size is asked for once it's drawn.
function fileCard(a: { chat: string; file: string }) {
  const size = h('div', { class: 'muted file-size' });
  const dl = h('a', { class: 'tool', href: attachURL(a, true), download: a.file, title: 'Download', innerHTML: ICON.download });
  const name = h('a', { class: 'file-name', href: attachURL(a, true), download: a.file, title: `Download ${a.file}` }, a.file);
  req('HEAD', attachURL(a)).then((r) => {
    const n = Number(r.headers.get('Content-Length'));
    if (r.ok && n >= 0) size.textContent = bytes(n);
  }).catch(() => {});
  return h('div', { class: 'file-card' }, h('img', { class: 'icon', src: iconURL(a.file, false, false), alt: '' }),
    h('div', { class: 'file-text' }, name, size), dl);
}

// plainText is message text for one-line snippets (reply quotes, the forward dialog): no
// formatting marks (style guide 8), and links to media and schematic posts become their
// names, so no raw paths show.
function plainText(text: string) {
  return stripMarkdown(text).replace(TOKEN, (whole, url, bracketed, bare) => {
    const path = (bracketed ?? bare) !== undefined ? resolveRef(bracketed ?? bare) : null;
    const post = path && hooks.schemPost(path);
    if (post) return `[${post.title}]`;
    if (path && (isMedia(path) || attachment(path))) return `[${path.slice(path.lastIndexOf('/') + 1)}]`;
    return whole;
  });
}

// ---- release cards ----

// A mod release post (Paul, S60; the MacroTech release account posts them) is plain Markdown,
// so it reads fine anywhere, and is drawn as a card when it has this shape:
//   ## <mod> <version>
//   -# Client · Required          (Client, Server or Client + Server; Required or Optional)
//   #mods/client/<file>.jar       (optional: the file to download)
//   - what changed …
//   **Note:** …                   (only for a special step or need-to-know; the last line)
const SIDES = ['Client', 'Server', 'Client + Server'];
const NEEDS = ['Required', 'Optional'];
type Release = { name: string; version: string; tags: string[]; ref: string | null; changes: string; note: string | null };

function parseRelease(text: string): Release | null {
  const lines = text.trim().split('\n');
  const title = /^## +(.+?)\s*$/.exec(lines[0] ?? '');
  const sub = /^-# +(.+?)\s*$/.exec(lines[1] ?? '');
  if (!title || !sub) return null;
  const tags = sub[1].split('·').map((t) => t.trim());
  if (!tags.every((t) => SIDES.includes(t) || NEEDS.includes(t))) return null;
  const [, name, version] = /^(.*?)(?:\s+(v?\d\S*))?$/.exec(title[1])!;
  let rest = lines.slice(2);
  let ref: string | null = null;
  const link = /^#(?:\[([^\]\n]+)\]|([\w./-]*[\w/-]))\s*$/.exec(rest[0] ?? '');
  if (link) { ref = link[1] ?? link[2]; rest = rest.slice(1); }
  let note: string | null = null;
  const last = /^\*\*Note:\*\*\s*(.*)$/.exec(rest[rest.length - 1] ?? '');
  if (last) { note = last[1]; rest = rest.slice(0, -1); }
  return { name, version: version ?? '', tags, ref, changes: rest.join('\n').trim(), note };
}

// renderBody is a message's text as shown: a release card, or formatted text.
function renderBody(text: string): Node[] {
  const r = parseRelease(text);
  return r ? [releaseCard(r)] : renderText(text);
}

function releaseCard(r: Release) {
  const tags = r.tags.map((t) => h('span', { class: 'rel-tag' + (t === 'Required' ? ' required' : '') }, t));
  const card = h('div', { class: 'rel-card' },
    h('div', { class: 'rel-label' }, 'Mod release'),
    h('div', { class: 'rel-title' }, h('span', { class: 'rel-name' }, r.name), r.version ? h('span', { class: 'rel-version' }, r.version) : ''),
    h('div', { class: 'rel-tags' }, ...tags));
  if (r.changes) card.append(h('div', { class: 'rel-changes' }, ...renderText(r.changes)));
  const foot = h('div', { class: 'rel-foot' });
  if (r.note !== null) foot.append(h('div', { class: 'rel-note' }, h('strong', {}, 'Note: '), ...renderText(r.note)));
  const readme = releaseReadme(r.name);
  if (r.ref || readme) foot.append(releaseFile(r.ref, readme));
  if (foot.childElementCount) card.append(foot);
  return card;
}

// releaseReadme is a Readme button for the mod's page in mods/mod info/ (found by the mod's
// name, so older cards get it too), or null if there's no page.
const MOD_INFO = 'mods/mod info';
function releaseReadme(mod: string) {
  const path = hooks.resolvePath(`${MOD_INFO}/${mod}.md`);
  if (!path) return null;
  const a = h('a', { class: 'rel-btn', href: '#' + path, title: `Open ${path}`, innerHTML: ICON.readme + '<span>Readme</span>' });
  a.onclick = (e) => { e.preventDefault(); hooks.openPath(path); };
  return a;
}

// releaseFile is the card's last row: the jar's name and size, then Readme and Download. A
// jar that has left Files (a newer version replaced it) is a muted line instead, and a
// server-only card has only Readme.
function releaseFile(written: string | null, readme: HTMLElement | null) {
  const buttons = h('span', { class: 'rel-buttons' }, readme ?? '');
  if (!written) return h('div', { class: 'rel-file' }, h('span', { class: 'rel-file-name' }), buttons);
  const path = resolveRef(written);
  const name = written.slice(written.lastIndexOf('/') + 1);
  if (!path) return h('div', { class: 'rel-file' }, h('span', { class: 'rel-file-name muted' }, `${name} is no longer in Files`), buttons);
  const a = attachment(path);
  const url = a ? attachURL(a, true) : `/api/file/${enc(path)}?download=1`;
  const size = h('span', { class: 'rel-size' });
  req('HEAD', a ? attachURL(a) : `/api/file/${enc(path)}`).then((res) => {
    const n = Number(res.headers.get('Content-Length'));
    if (res.ok && n >= 0) size.textContent = ' · ' + bytes(n);
  }).catch(() => {});
  buttons.append(h('a', { class: 'rel-btn rel-download', href: url, download: name, title: `Download ${name}`, innerHTML: ICON.download + '<span>Download</span>' }));
  return h('div', { class: 'rel-file' }, h('span', { class: 'rel-file-name', title: path }, name, size), buttons);
}

// ---- link previews ----

type Preview = {
  url: string; kind: 'page' | 'image' | 'youtube' | 'none'; site?: string; title?: string; desc?: string;
  color?: string; image?: string; w?: number; h?: number; large?: boolean; video?: string;
};
const MAX_PREVIEWS = 3; // per message, like Discord's few
const previews = new Map<string, Preview | Promise<Preview | null>>();

// previewLinks are the web links in a message that get a card: not ones written <like
// this> (Discord's way to post a link without a preview), at most a few, no repeats.
function previewLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const url = m[1];
    if (!url || text[m.index! - 1] === '<' || out.includes(url)) continue;
    out.push(url);
    if (out.length === MAX_PREVIEWS) break;
  }
  return out;
}

function getPreview(url: string): Promise<Preview | null> {
  const have = previews.get(url);
  if (have) return Promise.resolve(have);
  const p = req('GET', `/api/preview?url=${encodeURIComponent(url)}`)
    .then((r) => (r.ok ? (r.json() as Promise<Preview>) : null))
    .catch(() => null)
    .then((got) => {
      if (got) previews.set(url, got);
      else previews.delete(url); // try again next time
      return got;
    });
  previews.set(url, p);
  return p;
}

const previewImg = (p: Preview) => `/api/preview/img/${p.image}`;

// card draws a preview, Discord style: a dark card with the site's colour down its left
// edge; site, linked title, description, and the image big underneath or small beside.
// A linked image is just the image; YouTube plays in place when clicked.
function card(p: Preview): HTMLElement {
  // Sized up front from what the server measured (at most 400×300), so the chat doesn't
  // jump when the image arrives. Thumbnails are a fixed 80×80 (CSS).
  const img = (cls: string) => {
    const i = h('img', { class: cls, src: previewImg(p), alt: '', loading: 'lazy' });
    if (p.w && p.h && !cls) {
      const k = Math.min(1, 400 / p.w, 300 / p.h);
      i.style.width = `${Math.round(p.w * k)}px`;
      i.style.height = `${Math.round(p.h * k)}px`;
    }
    return i;
  };
  if (p.kind === 'image') {
    return h('a', { class: 'embed-image', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, img(''));
  }
  const el = h('div', { class: 'embed' + (p.large ? '' : ' small') });
  if (p.color) el.style.borderLeftColor = p.color;
  const text = h('div', { class: 'embed-text' });
  if (p.site) text.append(h('div', { class: 'embed-site' }, p.site));
  if (p.title) text.append(h('a', { class: 'embed-title', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, p.title));
  if (p.desc) text.append(h('div', { class: 'embed-desc' }, p.desc));
  el.append(text);
  if (!p.image) return el;
  if (p.kind === 'youtube' && p.video) {
    const play = h('button', { class: 'embed-media embed-play', title: 'Play here' }, img(''), h('span', { class: 'play', innerHTML: GLYPH.play }));
    play.onclick = () => {
      const frame = h('iframe', {
        src: `https://www.youtube-nocookie.com/embed/${p.video}?autoplay=1`,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowFullscreen: true,
        referrerPolicy: 'strict-origin-when-cross-origin', title: p.title ?? 'YouTube video',
      });
      frame.className = 'embed-media embed-video';
      play.replaceWith(frame);
    };
    el.append(play);
  } else if (p.large) {
    el.append(h('a', { class: 'embed-media', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, img('')));
  } else {
    el.append(img('embed-thumb'));
  }
  return el;
}

// linkedFiles is what a message links, its forward included, in order: the files posted in
// chat (Save to Files) and the pictures and videos in Files (Open folder goes to the first).
function linkedFiles(m: Message): { posted: string[]; inFiles: string[] } {
  const posted: string[] = [];
  const inFiles: string[] = [];
  for (const t of withoutCode(m.text + '\n' + (m.fwd?.text ?? '')).matchAll(TOKEN)) {
    const [, , bracketed, bare] = t;
    if ((bracketed ?? bare) === undefined) continue;
    const path = resolveRef(bracketed ?? bare);
    if (!path) continue;
    const to = attachment(path) ? posted : isMedia(path) ? inFiles : null;
    if (to && !to.includes(path)) to.push(path);
  }
  return { posted, inFiles };
}

// linkTargets is where a message's #path links point right now, and the titles of the
// schematic posts it links (part of its render key).
function linkTargets(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const [, , bracketed, bare] = m;
    if ((bracketed ?? bare) === undefined) continue;
    const path = resolveRef(bracketed ?? bare) ?? '';
    out.push(path, hooks.schemPost(path)?.title ?? '');
  }
  return out.join(',');
}

// ---- text ----

// renderText draws message text: Discord's formatting (markdown.ts), with renderLinks for the
// plain runs in between.
const renderText = (text: string) => renderMarkdown(text, renderLinks, emojify);

// renderLinks turns plain text into nodes: text, web links, #path links to files in the tree
// (a schematic post's folder shows as its card). Paths with spaces are written #[like this].
const TOKEN = /(https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"])|#\[([^\]\n]+)\]|#([\w./-]*[\w/-])/g;

function renderLinks(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const [whole, url, bracketed, bare] = m;
    const written = bracketed ?? bare;
    const path = written === undefined ? null : resolveRef(written);
    if (written !== undefined && !path) continue; // just text, e.g. #1
    if (path && shownBelow(path)) { // a preview under the message instead
      out.push(...emojify(text.slice(last, m.index!)));
      last = m.index! + whole.length;
      continue;
    }
    // <https://…> is a link without a preview; the brackets aren't shown.
    const quiet = !!url && text[m.index! - 1] === '<' && text[m.index! + whole.length] === '>';
    out.push(...emojify(text.slice(last, m.index! - (quiet ? 1 : 0))));
    if (url) {
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
      if (quiet) {
        last = m.index! + whole.length + 1;
        continue;
      }
    } else {
      // A file that has moved since shows its name now; the tooltip keeps the original.
      const title = path === written ? `Open ${path}` : `Was ${written} · Open ${path}`;
      const a = h('a', { href: '#' + path, class: 'file-link', title }, path!);
      a.onclick = (e) => {
        e.preventDefault();
        hooks.openPath(path!);
      };
      out.push(a);
    }
    last = m.index! + whole.length;
  }
  out.push(...emojify(text.slice(last)));
  return out;
}

// emojify is plain text with mentions of people highlighted (@name, for anyone who has
// posted, and @everyone/@here) and emoji drawn as images. There are no notifications: the
// highlight just makes them stand out, as in Discord.
function emojify(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(/(^|[^\w@])@(everyone|here|[A-Za-z0-9_-]{1,32})\b/g)) {
    const name = m[2];
    if (name !== 'everyone' && name !== 'here' && !knownNames.has(name.toLowerCase())) continue;
    const at = m.index! + m[1].length;
    out.push(...emojiOnly(text.slice(last, at)), h('span', { class: 'mention' }, '@' + name));
    last = at + 1 + name.length;
  }
  out.push(...emojiOnly(text.slice(last)));
  return out;
}

// mentionNames is who @ suggests: every account, then anyone else who has posted in a chat
// shown here (as they wrote their name).
const mentionNames = () => [...accounts.map((a) => a.name), ...[side, main].flatMap((v) => v?.msgs.map((m) => m.user) ?? [])];

// knownNames are everyone who has posted in a chat shown here, plus every account
// (lowercase), for mention highlights.
const knownNames = new Set<string>();

function emojiOnly(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const e of findEmoji(text)) {
    if (e.text === '\ufe0f') continue; // a stray selector the parser sometimes matches alone
    out.push(document.createTextNode(text.slice(last, e.indices[0])), emojiImg(e.text));
    last = e.indices[1];
  }
  out.push(document.createTextNode(text.slice(last)));
  return out;
}

const pathRef = (p: string) => (/[^\w./-]/.test(p) ? `#[${p}]` : `#${p}`);

function dayLabel(t: Date) {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (t.toDateString() === today.toDateString()) return 'Today';
  if (t.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return t.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// snippet is the start of a message on one line, for quotes and lists.
function snippet(t: string, n = 200) {
  t = t.split(/\s+/).join(' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Toolbar icons (Lucide, ISC licence), drawn in the text colour.
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ICON = {
  plus: svg('<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>'),
  react: svg('<path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/><path d="M16 5h6"/><path d="M19 2v6"/>'),
  reply: svg('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>'),
  forward: svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'),
  edit: svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  copy: svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2"/>'),
  save: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="m15 13-3 3-3-3"/>'),
  readme: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  files: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  pin: svg('<line x1="12" x2="12" y1="17" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  eye: svg('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>'),
  down: svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  lock: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  smile: svg('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>'),
};

// drafts: what's typed and not sent, per chat, kept in this browser (also across reloads),
// as in Discord. Switching chats swaps the box's text, so a half-written message never
// follows you into another chat.
const drafts: Record<string, string> = (() => {
  try {
    return JSON.parse(load('mt-drafts') ?? '{}');
  } catch {
    return {};
  }
})();

function setDraft(name: string, text: string) {
  if (text.trim()) drafts[name] = text;
  else delete drafts[name];
  store('mt-drafts', JSON.stringify(drafts));
}

// grow fits a message box to its text (up to 200 px). A box that isn't on screen can't be
// measured: it's left at its natural height, and layoutChanged fits it once it shows.
function grow(t: HTMLTextAreaElement) {
  t.style.height = 'auto';
  if (!t.offsetParent) {
    t.style.height = '';
    return;
  }
  const border = t.offsetHeight - t.clientHeight; // scrollHeight leaves it out
  t.style.height = Math.min(t.scrollHeight + border, 200) + 'px';
}

function insert(t: HTMLTextAreaElement, s: string) {
  const at = t.selectionStart ?? t.value.length;
  t.value = t.value.slice(0, at) + s + t.value.slice(t.selectionEnd ?? at);
  t.selectionStart = t.selectionEnd = at + s.length;
  t.focus();
  grow(t);
}
