// Text channels. A ChatView is one chat pane (message list + composer); there are two:
// the side panel on the right, and the main panel when a channel is picked in the left
// list. They can show different channels at once. Channel list, unread markers and the
// live event stream are shared.
import { parse as findEmoji } from '@twemoji/parser';
import { openViewer, type ViewItem } from './viewer';
import { maskCode, renderMarkdown, stripMarkdown, withoutCode } from './markdown';
import { emojiImg, emojiPicker as pickerContent } from './emoji';
import { autocomplete } from './autocomplete';
import { commandIn, type Command } from './commands';
import { dingFor, setupDing } from './ding';
import { $, accounts, ask, bytes, opTag, tagOf, dateTime, fullDate, GLYPH, time, closeDialog, copyText, dialog, enc, h, isAdmin, json, labels, load, req, showMenu, store, toast, toastError, user, type MenuItem, type Live, thumbOr, dragData, draggedPaths } from './util';
import { iconURL } from './icons';

type Message = {
  id: string; channel: string; t: string; user: string; text: string; edited?: string;
  reply_to?: string; reply?: Quote; fwd?: Forward; reactions?: Reaction[]; pinned?: { by: string; t: string };
  nonce?: string; // ours, on a message we sent and are waiting to see (see unsent)
  via?: string; // said in game on this server (SMP, CMP): the server link
  notice?: boolean; // that server reported it by itself (a bot died); it's from MacroTech
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
  entry(path: string): { dir: boolean; size: number } | null; // a file or folder in Files, or null
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
// Unread markers are per browser, not on the account: last message ID seen per channel.
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
const LINK_CHAT = 'text-link';
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
  readonly tray = h('div', { class: 'pend-tray', hidden: true }); // files waiting to go with the message
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
    root.append(this.note, h('div', { class: 'messages-wrap' }, this.list, this.jump), h('div', { class: 'composer' }, this.replyBar, this.tray, h('div', { class: 'compose-row' }, attach, this.compose, smile), this.picker));
    this.compose.value = drafts[this.channel] ?? '';
    this.drawTray();

    const c = this.compose;
    const ac = autocomplete(c, mentionNames, true);
    c.onkeydown = (e) => {
      if (ac.key(e) || formatKey(e, c)) return;
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
    // Anything dropped anywhere on the pane is a card in the tray (see take): files from the
    // computer, files and folders from the tree or a folder view, a Schematic Manager card,
    // a picture or file from a message.
    root.ondragover = (e) => {
      if (!carriesFiles(e) || accidental(e, this)) return;
      e.preventDefault();
      root.classList.add('drop');
    };
    root.ondragleave = (e) => {
      if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove('drop');
    };
    root.ondrop = (e) => {
      root.classList.remove('drop');
      const paths = draggedPaths(e); // a selection: a card for every one of them
      const files = [...(e.dataTransfer?.files ?? [])];
      if ((!paths.length && !files.length) || accidental(e, this)) return;
      e.preventDefault();
      this.take(paths, files);
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

  // attach puts files in the box's tray, to be posted in this chat (kept with it, any kind)
  // when the message is sent. Chat takes up to 50 MB a file; one question offers to put
  // bigger ones in Files instead, linked in the text.
  async attach(files: File[]) {
    // A "]" would end the #[...] link early (and line breaks aren't allowed in names).
    files = files.map((f) => (/[\]\p{Cc}]/u.test(f.name) ? new File([f], f.name.replace(/[\]\p{Cc}]/gu, '_'), { type: f.type }) : f));
    const fits = files.filter((f) => f.size <= MAX_POSTED);
    const big = files.filter((f) => f.size > MAX_POSTED);
    const priv = !!info(this.channel)?.kind;
    if (fits.length) addPending(this.channel, fits);
    this.compose.focus();
    if (big.length) addToLarge(big, async () => this.link(await hooks.uploadInto(big, 'large')), priv);
  }

  // take puts what was dropped in the tray: files from the computer to be posted (attach),
  // and a card for each thing already on the hub, linked where it is; a file from a private
  // chat or DM dropped in another chat is copied instead (its readers may not see the first).
  take(paths: string[], files: File[]) {
    const { links, copies } = sortDropped(paths, this.channel);
    if (links.length) addLinks(this.channel, links);
    if (files.length) this.attach(files);
    for (const p of copies) void copyOf(p).then((f) => f && this.attach([f]));
    this.compose.focus();
  }

  // link puts cards for files in Files in the tray (the big files attach put there).
  link(paths: string[]) {
    if (paths.length) addLinks(this.channel, paths);
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
    this.drawTray();
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

  // drawTray shows this chat's waiting files above the box (see pending). While they upload
  // the box is locked and the cards can't be removed.
  drawTray() {
    const list = pending[this.channel] ?? [];
    const busy = sending.has(this.channel);
    this.tray.hidden = !list.length;
    this.tray.replaceChildren(...list.map((p) => pendCard(p, busy ? null : () => removePending(this.channel, p), busy ? null : () => this.send())));
    this.compose.readOnly = busy;
  }

  // send posts the box's text and its waiting files as one message. The files go up first,
  // each showing its progress; if one fails nothing is posted, and the text and files stay.
  async send() {
    const name = this.channel;
    if (sending.has(name)) return;
    const typed = this.compose.value.trim();
    const files = pending[name] ?? [];
    if (!typed && !files.length) return;
    const cmd = files.length ? null : commandIn(typed);
    if (cmd) {
      this.compose.value = '';
      setDraft(name, '');
      grow(this.compose);
      return this.run(cmd);
    }
    if (files.length && !await uploadPending(name, files)) return;
    const text = joinFiles(typed, files.map((p) => p.path!));
    const reply = this.replyTo;
    // Empty the box at once, so a second Enter before the answer can't send it again.
    const here = () => this.channel === name; // the pane may have moved on during the upload
    if (here()) {
      this.compose.value = '';
      this.cancelReply();
      grow(this.compose);
    }
    setDraft(name, '');
    delete pending[name];
    drawTrays();
    for (const p of files) if (p.url) URL.revokeObjectURL(p.url);
    // It shows at once, greyed, until the hub has it (see unsent).
    const u: Unsent = { nonce: Date.now().toString(36) + Math.random().toString(36).slice(2), text, reply, t: new Date(), state: 'sending' };
    (unsent[name] ??= []).push(u);
    for (const v of [side, main]) {
      if (v.channel !== name || !v.loaded) continue;
      v.newAfter = null;
      v.render();
      v.scrollToBottom();
    }
    await deliver(name, u);
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
    const waiting = this.loaded ? unsent[this.channel] ?? [] : [];
    if (!this.msgs.length && !waiting.length) {
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
    if (!this.msgs.length) use('start', () => h('div', { class: 'muted pad' }, `This is the start of ${chatTitle(this.channel, false)}.`));
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
    // Your messages the hub hasn't confirmed yet (or refused) come last, after everything.
    for (const u of waiting) {
      if (!prev || new Date(prev.t).toDateString() !== u.t.toDateString()) {
        const label = dayLabel(u.t);
        use(`day|${u.t.toDateString()}|${label}`, () => h('div', { class: 'day' }, label));
        prev = null;
      }
      const grouped = !!prev && !u.reply && prev.user === user.name && !prev.via && u.t.getTime() - Date.parse(prev.t) < GROUP_MS;
      const m: Message = { id: 'unsent-' + u.nonce, channel: this.channel, t: u.t.toISOString(), user: user.name, text: u.text, reply_to: u.reply?.id };
      use(['unsent', u.nonce, u.state, u.error ?? '', grouped, linkTargets(u.text)].join('|'), () => this.renderUnsent(u, m, grouped));
      prev = m;
    }
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

  // renderUnsent is a message of yours on its way: drawn like any other but greyed, with no
  // toolbar or menu. One the hub refused, or that couldn't reach it, turns red and gets a
  // line under it to try again or drop it (Discord).
  renderUnsent(u: Unsent, m: Message, grouped: boolean) {
    const el = this.renderMessage(m, grouped, true);
    el.classList.add('unsent');
    if (u.state === 'failed') {
      el.classList.add('failed');
      const retry = h('button', { class: 'key', type: 'button' }, 'Retry');
      retry.onclick = () => void deliver(this.channel, u);
      const drop = h('button', { class: 'key', type: 'button' }, 'Delete');
      drop.onclick = () => dropUnsent(this.channel, u.nonce);
      el.append(h('div', { class: 'send-failed' }, `Couldn’t send it: ${u.error}. `, retry, ' · ', drop));
    }
    return el;
  }

  // bare: just the message (one that isn't on the hub yet has nothing to react to or edit).
  renderMessage(m: Message, grouped: boolean, bare = false) {
    const t = new Date(m.t);
    const q = this.quote(m);
    const el = h('div', { class: 'msg' + (grouped ? ' grouped' : '') + (m.pinned ? ' pinned' : '') + (mentionsMe(m, q) ? ' mentions-me' : '') });
    el.dataset.id = m.id;
    if (q) el.append(this.quoteLine(m, q));
    // The time sits in a gutter left of the name; a grouped message shows its own there on hover.
    const when = h('span', { class: 'when', title: fullDate(t) }, time(t));
    if (!grouped) {
      el.append(h('div', { class: 'msg-head' }, when, h('span', { class: 'who' }, m.user),
        isAdmin(m.user) ? opTag(tagOf(m.user)) : '',
        m.via ? h('span', { class: 'tag via', title: `${m.notice ? 'Reported by' : 'Said in game on'} ${SERVER_NAMES[m.via] ?? 'a server'}` }, m.via) : ''));
    } else {
      when.classList.add('side');
      el.append(when);
    }
    if (this.editing === m.id) {
      el.append(this.editBox(m));
      return el;
    }
    // Text, unless it was only links shown as previews below (then just "(edited)").
    const cards = ownCards(m);
    const nodes = m.text ? renderBody(m.text, cards) : [];
    const visible = nodes.some((n) => n.nodeType !== Node.TEXT_NODE || n.textContent!.trim());
    if (visible || m.edited) {
      const body = h('div', { class: 'msg-body' }, ...(visible ? nodes : []));
      if (m.edited) body.append(h('span', { class: 'edited', title: `Edited ${fullDate(m.edited)}` }, ' (edited)'));
      el.append(body);
    }
    if (m.fwd) el.append(forwardBox(m.fwd));
    const all = withoutCode(m.text + '\n' + (m.fwd?.text ?? ''));
    const refs = mediaPreviews(cards, m);
    if (refs) el.append(refs);
    const links = previewLinks(all);
    if (links.length) el.append(this.embeds(links));
    if (bare) return el;
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
    const words = splitFiles(m.text).words || m.fwd?.text || '';
    if (words) box.append(btn('copy', 'Copy text', () => copyText(words)));
    if (mine || canModerate(m.channel)) box.append(btn('trash', 'Delete (Shift+click: no question)', (_, e) => deleteMessage(this, m, e.shiftKey), 'danger'));
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
    const words = splitFiles(m.text).words || m.fwd?.text || '';
    items.push(null);
    if (words) items.push(['Copy Text', () => copyText(words)]);
    items.push(['Copy Link', () => copyText(`${location.origin}/#chan=${m.channel}&msg=${m.id}`)]);
    if (canPin(m.channel)) items.push(m.pinned ? ['Unpin Message', () => setPinned(m, false)] : ['Pin Message', () => setPinned(m, true)]);
    if (mine || canModerate(m.channel)) items.push(null, ['Delete', () => deleteMessage(this, m, false)]);
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

  // editBox edits a message's words. Its files aren't text here (as in Discord): they're
  // cards under the box, each with an x that takes it out of the message on Save. What is
  // dropped or pasted on it becomes a card too, as in the message box (files from the
  // computer are posted on Save).
  editBox(m: Message) {
    const { words, files } = splitFiles(m.text);
    const kept = new Set(files);
    const extra: Pend[] = [];
    const box = h('textarea', { value: words, rows: 1, maxLength: 4000 });
    const done = () => {
      this.editing = null;
      this.render();
      this.compose.focus();
    };
    const save = async () => {
      const typed = box.value.trim();
      const keep = [...kept];
      if (typed === words && !extra.length && keep.join('\n') === files.join('\n')) return done();
      if (!typed && !keep.length && !extra.length && !m.fwd) { // nothing left: Discord asks to delete it instead
        done();
        return deleteMessage(this, m, false);
      }
      if (extra.length && !await uploadPending(m.channel, extra)) return showCards();
      const text = joinFiles(typed, [...keep, ...extra.map((p) => p.path!)]);
      const r = await req('PATCH', `/api/channels/${m.channel}/messages/${m.id}`, JSON.stringify({ text }));
      if (!r.ok) {
        toastError(`Couldn’t save it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
        return;
      }
      done();
    };
    const ac = autocomplete(box, mentionNames);
    box.onkeydown = (e) => {
      if (ac.key(e) || formatKey(e, box)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        done();
      }
    };
    // The whole box and the line under it stay in view as it opens and as it gets taller.
    const fit = () => {
      grow(box);
      box.parentElement?.scrollIntoView({ block: 'nearest' });
    };
    box.oninput = fit;
    queueMicrotask(fit);
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
    const cards = h('div', { class: 'pend-tray edit-files' });
    function showCards() {
      cards.replaceChildren(...[...kept].map((f) => sentCard(f, () => {
        kept.delete(f);
        showCards();
        box.focus();
      })), ...extra.map((p) => pendCard(p, () => {
        extra.splice(extra.indexOf(p), 1);
        if (p.url) URL.revokeObjectURL(p.url);
        showCards();
      }, null)));
      cards.hidden = !cards.children.length;
    }
    showCards();
    const full = () => kept.size + extra.length >= MAX_FILES;
    const addFiles = (fs: File[]) => {
      const big = fs.filter((f) => f.size > MAX_POSTED);
      if (big.length) toastError('Files posted in chat are at most 50 MB.');
      for (const f of fs.filter((x) => x.size <= MAX_POSTED)) {
        if (full()) {
          toastError(`A message takes up to ${MAX_FILES} files.`);
          break;
        }
        extra.push(newPend(f));
      }
      showCards();
    };
    const take = (paths: string[], dropped: File[]) => {
      const { links, copies } = sortDropped(paths, m.channel);
      for (const p of links) {
        if (kept.has(p)) continue;
        if (full()) {
          toastError(`A message takes up to ${MAX_FILES} files.`);
          break;
        }
        kept.add(p);
      }
      addFiles(dropped);
      for (const p of copies) void copyOf(p).then((f) => f && addFiles([f]));
      box.focus();
    };
    box.onpaste = (e) => {
      const fs = [...(e.clipboardData?.files ?? [])];
      if (!fs.length) return;
      e.preventDefault();
      take([], fs);
    };
    const el = h('div', { class: 'msg-edit' }, box, cards,
      h('div', { class: 'hint' }, enterKey, ' to save · ', escKey, ' to cancel'),
      saveBtn, cancel);
    el.ondragover = (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.ondrop = (e) => {
      const paths = draggedPaths(e);
      const fs = [...(e.dataTransfer?.files ?? [])];
      if (!paths.length && !fs.length) return;
      e.preventDefault();
      e.stopPropagation();
      take(paths, fs);
    };
    return el;
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

// catchStrayDrops: files (or things on the hub) dropped where nothing takes them go to the
// chat that's showing, as in Discord, and the page never opens a dropped file in the tab.
// Files' own places (the tree, a folder, the Trash, the Schematic Manager) keep their drops
// and take nothing more; neither does an open dialog. Text drags are left to the browser.
const OWN_DROPS = '#tree, #main-folder, #main-trash, #main-schems';
function catchStrayDrops() {
  let lit: ChatView | null = null;
  let unlight = 0;
  const light = (v: ChatView | null) => {
    if (lit && lit !== v) lit.root.classList.remove('drop');
    lit = v;
    v?.root.classList.add('drop');
    clearTimeout(unlight);
    if (v) unlight = window.setTimeout(() => light(null), 200); // dragover repeats while it's there
  };
  const own = (e: DragEvent) => !!(e.target as Element).closest?.(OWN_DROPS);
  const target = (e: DragEvent) => {
    if (!$('overlay').hidden || own(e)) return null;
    return main.shown() ? main : side.shown() ? side : null;
  };
  // (In Files' places a drag of things on the hub is theirs alone to take or refuse; a
  // computer file they refuse is still kept from opening in the tab.)
  const leave = (e: DragEvent) => !carriesFiles(e) || e.defaultPrevented || (own(e) && !e.dataTransfer!.types.includes('Files'));
  // A drag starting anywhere isn't one out of a message until draggable says so.
  document.addEventListener('dragstart', () => (fromMessage = null), { capture: true });
  document.addEventListener('dragend', () => (fromMessage = null));
  document.addEventListener('dragover', (e) => {
    if (leave(e)) return;
    e.preventDefault();
    const v = fromMessage ? null : target(e);
    e.dataTransfer!.dropEffect = v ? 'copy' : 'none';
    light(v);
  });
  document.addEventListener('drop', (e) => {
    if (leave(e)) return;
    e.preventDefault();
    light(null);
    if (!fromMessage) target(e)?.take(draggedPaths(e), [...(e.dataTransfer?.files ?? [])]);
  });
}

export function setupChat(events: Live, h_: Hooks) {
  hooks = h_;
  side = new ChatView($('chat-body'), 'mt-chat-side', 'general');
  main = new ChatView($('main-chat-body'), 'mt-chat-main', 'general');
  catchStrayDrops();
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
      ['New Direct Message…', newDM]], $('new-channel'));
  };

  const views = () => [side, main];
  events.addEventListener('message', (e) => {
    const m: Message = JSON.parse((e as MessageEvent).data);
    const c = channels.find((x) => x.name === m.channel);
    if (c) c.last_id = m.id;
    else loadChannels(); // a DM that was hidden, or just started
    if (m.nonce && m.user === user.name) dropUnsent(m.channel, m.nonce, false); // ours, confirmed
    views().forEach((v) => v.onMessage(m));
    views().forEach((v) => v.channel === m.channel && v.loaded && v.render());
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
  // (#text-link, shared with game chat, has a link where the # is, like voice-link in VOICE.)
  const name = main.channel === LINK_CHAT && !c?.kind ? [h('span', { class: 'link-mark', innerHTML: ICON.link }), main.channel] : [chatTitle(main.channel)];
  $('main-chat-title').replaceChildren(...name, ...(c?.kind === 'private' ? [h('span', { class: 'lock', title: 'Private chat', innerHTML: ICON.lock })] : []));
}

// In a DM its people are equals: admins have no extra powers there (they can't see DMs).
const canModerate = (name: string) => isAdmin(user.name) && info(name)?.kind !== 'dm';
const canPin = (name: string) => isAdmin(user.name) || info(name)?.kind === 'dm';

// MAX_POSTED is the biggest file chat takes (bigger ones go in Files, in large/).
const MAX_POSTED = 50 << 20;

// ---- messages on their way ----

// unsent is your messages the hub hasn't confirmed, per chat: a message shows in the feed the
// moment you send it (greyed), as in Discord, and is replaced by the real one when the hub
// answers. Each carries a nonce, which the hub echoes on the message it stores, so the copy
// arriving over the event stream is known to be this one. One that fails stays, in red,
// until it's sent again or dropped. They live in the page only: a reload forgets them.
type Unsent = { nonce: string; text: string; reply: Message | null; t: Date; state: 'sending' | 'failed'; error?: string };
const unsent: Record<string, Unsent[]> = {};

const redrawChat = (name: string) => { for (const v of [side, main]) if (v?.channel === name && v.loaded) v.render(); };

function dropUnsent(name: string, nonce: string, redraw = true) {
  const list = (unsent[name] ?? []).filter((u) => u.nonce !== nonce);
  if (list.length) unsent[name] = list;
  else delete unsent[name];
  if (redraw) redrawChat(name);
}

// deliver posts a waiting message. The hub's answer (or the live event, whichever is first)
// takes it off the waiting list; a failure marks it.
async function deliver(name: string, u: Unsent) {
  u.state = 'sending';
  delete u.error;
  redrawChat(name);
  const r = await req('POST', `/api/channels/${name}/messages`, JSON.stringify({ text: u.text, reply_to: u.reply?.id ?? '', nonce: u.nonce }));
  if (r.ok) {
    const m = await json<Message>(r);
    dropUnsent(name, u.nonce, false);
    for (const v of [side, main]) v?.onMessage(m);
    redrawChat(name);
    return;
  }
  if (!(unsent[name] ?? []).includes(u)) return; // confirmed or dropped meanwhile
  u.state = 'failed';
  u.error = String((await r.json().catch(() => ({}))).error ?? r.status);
  redrawChat(name);
  for (const v of [side, main]) if (v?.channel === name && v.stuck) v.scrollToBottom();
}

// ---- files in the message box ----

// pending is the cards waiting in each chat's message box: added by paste, drop or the +
// button, shown above the text. A file from the computer is posted in the chat (kept with it,
// not in Files) only when the message is sent; until then it is just the browser's handle on
// it, so nothing is on the hub to clean up if it's removed, and a reload forgets it (as in
// Discord). A card for something already on the hub (a file or folder in Files, a schematic
// post, a file posted in a chat) is a link to it: done from the start, nothing to upload.
type Pend = {
  id: number; file?: File; name: string; link?: boolean;
  url: string | null; // the browser's own preview of a picture or video
  state: 'ready' | 'up' | 'done' | 'failed'; frac: number;
  path?: string; // once it's up: the path to link
  error?: string;
};
const pending: Record<string, Pend[]> = {};
const sending = new Set<string>(); // chats whose files are going up now
const MAX_FILES = 10; // a message's files, as in Discord
let pendIds = 0;

const drawTrays = () => { for (const v of [side, main]) v?.drawTray(); };

// addPending puts files in a chat's tray. A pasted picture (always image.png) is named after
// the time and who posted it.
function addPending(name: string, files: File[]) {
  const list = pending[name] ??= [];
  const room = MAX_FILES - list.length;
  if (files.length > room) toastError(`A message takes up to ${MAX_FILES} files.`);
  for (const f of files.slice(0, Math.max(0, room))) list.push(newPend(f));
  if (!list.length) delete pending[name];
  drawTrays();
}

// addLinks puts cards for things already on the hub in a chat's tray; one already there isn't
// added again.
function addLinks(name: string, paths: string[]) {
  const list = pending[name] ??= [];
  const fresh = [...new Set(paths)].filter((p) => !list.some((x) => x.path === p));
  const room = MAX_FILES - list.length;
  if (fresh.length > room) toastError(`A message takes up to ${MAX_FILES} files.`);
  for (const p of fresh.slice(0, Math.max(0, room))) list.push({ id: ++pendIds, name: linkName(p), link: true, url: null, state: 'done', frac: 1, path: p });
  if (!list.length) delete pending[name];
  drawTrays();
}

// newPend is a card for a file from the computer. A pasted picture (always image.png) is
// named after the time and who posted it.
function newPend(f: File): Pend {
  const name = /^image\.\w+$/.test(f.name) ? hooks.stampName(f) : f.name;
  return { id: ++pendIds, file: f, name, state: 'ready', frac: 0, url: IMAGE_EXT.test(name) || VIDEO_EXT.test(name) ? URL.createObjectURL(f) : null };
}

function removePending(name: string, p: Pend) {
  const list = (pending[name] ?? []).filter((x) => x !== p);
  if (list.length) pending[name] = list;
  else delete pending[name];
  if (p.url) URL.revokeObjectURL(p.url);
  drawTrays();
}

// uploadPending posts a chat's waiting files in it, one after another, each card showing how
// far it is. False if any failed: those turn red, and nothing should be sent yet.
async function uploadPending(name: string, files: Pend[]): Promise<boolean> {
  sending.add(name);
  for (const p of files) {
    if (p.state === 'done') continue;
    p.state = 'up';
    p.frac = 0;
    delete p.error;
    drawTrays();
    try {
      const r = await hooks.send(`/api/channels/${enc(name)}/media?name=${encodeURIComponent(p.name)}`, p.file!, (x) => {
        p.frac = x;
        for (const el of document.querySelectorAll<HTMLElement>(`.pend[data-pend="${p.id}"]`)) {
          el.querySelector<HTMLElement>('.pend-bar i')!.style.width = `${Math.floor(x * 100)}%`;
          el.querySelector('.pend-note')!.textContent = pendNote(p);
        }
      });
      if (r.status === 200) {
        p.state = 'done';
        p.path = r.body.path;
      } else {
        p.state = 'failed';
        p.error = String(r.body?.error ?? r.status);
      }
    } catch (e) {
      p.state = 'failed';
      p.error = (e as Error).message;
    }
  }
  sending.delete(name);
  drawTrays();
  return files.every((p) => p.state === 'done');
}

const pendNote = (p: Pend) => p.link ? linkNote(p.path!) : p.state === 'up' ? `Uploading ${Math.floor(p.frac * 100)}%`
  : p.state === 'failed' ? `Couldn’t upload: ${p.error}` : bytes(p.file!.size);

// fileChip is one file's card in a tray: its picture (or icon), its name, a line under it,
// and its buttons in the top right corner.
function fileChip(cls: string, media: HTMLElement, name: string, note: string, tools: HTMLElement[]) {
  return h('div', { class: 'pend ' + cls, title: name }, h('div', { class: 'pend-thumb' }, media),
    h('div', { class: 'pend-name' }, name), h('div', { class: 'pend-note' }, note),
    h('div', { class: 'pend-bar' }, h('i')), h('div', { class: 'pend-tools' }, ...tools));
}

const fileIcon = (name: string) => h('img', { class: 'icon', src: iconURL(name, false, false), alt: '', draggable: false });

// pendCard is a waiting file's card. remove and retry are null while files are going up.
function pendCard(p: Pend, remove: (() => void) | null, retry: (() => void) | null) {
  const media = p.link ? linkThumb(p.path!) : p.url && IMAGE_EXT.test(p.name) ? h('img', { src: p.url, alt: '', draggable: false })
    : p.url ? h('video', { src: p.url + '#t=0.1', preload: 'metadata', muted: true })
    : fileIcon(p.name);
  const tools: HTMLElement[] = [];
  if (retry && p.state === 'failed') {
    const again = h('button', { class: 'tool', title: 'Try again', innerHTML: ICON.retry });
    again.onclick = retry;
    tools.push(again);
  }
  if (remove) {
    const x = h('button', { class: 'tool danger', title: 'Remove file', innerHTML: ICON.close });
    x.onclick = remove;
    tools.push(x);
  }
  const el = fileChip(p.state, media, p.name, pendNote(p), tools);
  el.dataset.pend = String(p.id);
  el.querySelector<HTMLElement>('.pend-bar i')!.style.width = `${Math.floor(p.frac * 100)}%`;
  return el;
}

// linkThumb, linkName and linkNote are a card's picture, name and line for something on the
// hub: a file posted in a chat, a file or folder in Files, a schematic post.
function linkThumb(path: string): HTMLElement {
  const a = attachment(path);
  if (IMAGE_EXT.test(path) && (a || hooks.fileMod(path) !== null)) {
    const src = a ? (/\.gif$/i.test(a.file) ? attachURL(a) : `/api/channels/${enc(a.chat)}/thumb/${encodeURIComponent(a.file)}`) : `/api/thumb/${enc(path)}?v=${hooks.fileMod(path)}`;
    return thumbOr(h('img', { src, alt: '', draggable: false }), mediaURL(path), () => fileIcon(path));
  }
  const post = hooks.schemPost(path);
  if (post) return fileIcon(post.file);
  return hooks.entry(path)?.dir ? h('img', { class: 'icon', src: iconURL(path, true, false), alt: '', draggable: false }) : fileIcon(path);
}
const linkName = (path: string) => hooks.schemPost(path)?.title ?? baseName(path);
function linkNote(path: string) {
  if (hooks.schemPost(path)) return 'Schematic';
  const e = hooks.entry(path);
  return e?.dir ? 'Folder' : e ? bytes(e.size) : '';
}

// sentCard is the card of something a message already has (its link path), for the edit box.
function sentCard(path: string, remove: () => void) {
  const x = h('button', { class: 'tool danger', title: 'Remove file', innerHTML: ICON.close });
  x.onclick = remove;
  return fileChip('done', linkThumb(path), linkName(path), linkNote(path), [x]);
}

// A message is stored as text, and its files are #path links in that text: files posted in
// the chat (#media/<chat>/<file>), files and folders in Files, schematic posts. splitFiles takes
// a message apart into its words and its files: the links that stand alone (aloneLinks), as
// cards, as they are now. joinFiles puts one together. A link inside a sentence stays in the
// words; links inside code are left as text.
function splitFiles(text: string): { words: string; files: string[] } {
  const alone = aloneLinks(text, cardPaths(text));
  return { words: hideAlone(text, alone).trim(), files: [...new Set(alone.map((l) => l.path))] };
}

const joinFiles = (words: string, files: string[]) => [words, files.map(pathRef).join(' ')].filter(Boolean).join(' ');

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

// sortDropped splits what was dragged into a chat: links to things on the hub, and files
// posted in a private chat or DM that are copied when dropped in another chat.
function sortDropped(paths: string[], into: string) {
  const links: string[] = [];
  const copies: string[] = [];
  for (const p of paths) {
    const a = attachment(p);
    (a && a.chat !== resolveChannel(into) && info(a.chat)?.kind ? copies : links).push(p);
  }
  return { links, copies };
}

// copyOf fetches a file posted in a chat, to post a copy of it elsewhere.
async function copyOf(path: string): Promise<File | null> {
  const a = attachment(path)!;
  const r = await req('GET', attachURL(a));
  if (!r.ok) {
    toastError(`Couldn’t copy ${a.file}: ${r.status}.`);
    return null;
  }
  const b = await r.blob();
  return new File([b], a.file, { type: b.type });
}

// carriesFiles: a drag of files from the computer, or of things on the hub (their paths).
const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.some((t) => t === 'text/x-mt-path' || t === 'Files');

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
  // One list: chats in the shared order admins set by dragging (the server's
  // order), then DMs ("@" and who they're with), the most recent message first.
  const newest = (a: ChannelInfo, b: ChannelInfo) => (b.last_id > a.last_id ? 1 : b.last_id < a.last_id ? -1 : chatTitle(a.name).localeCompare(chatTitle(b.name)));
  const sorted = [...channels.filter((c) => c.kind !== 'dm'), ...channels.filter((c) => c.kind === 'dm').sort(newest)];
  for (const c of sorted) {
    const unread = c.last_id !== '' && c.last_id > (lastRead[c.name] ?? '');
    if (unread) count++;
    const active = hooks.mainShowsChat() && c.name === main.channel;
    const renaming = chanEdit?.kind === 'rename' && chanEdit.name === c.name;
    const dm = c.kind === 'dm';
    const linked = c.name === LINK_CHAT && !c.kind;
    const row = h('div', { class: 'row channel' + (active ? ' active' : '') + (unread ? ' unread' : '') + (dm ? ' dm' : '') + (linked ? ' link' : '') },
      linked ? h('span', { class: 'hash', innerHTML: ICON.link }) : h('span', { class: 'hash' }, dm ? '@' : '#'),
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
    // (The chat linked to game chat is always there: no Rename or Delete.)
    ...(name === LINK_CHAT ? [] : [null, ['Rename…', () => openChanEdit({ kind: 'rename', name })], ['Delete', () => deleteChannel(name)]] as MenuItem[]));
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
export function folderPicker(o: { heading: string; body: string; confirm: string; priv: boolean; done: (dir: string) => void }) {
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
// even on Shift+click, so files never go unasked. Files still linked elsewhere stay.
// The question shows the message as the chat draws it (Discord), to look at and not to use.
async function deleteMessage(v: ChatView, m: Message, noQuestion: boolean) {
  const o = await req('GET', `/api/channels/${m.channel}/messages/${m.id}/orphans`);
  const files = o.ok ? (await json<{ paths: string[] }>(o)).paths : [];
  const one = files.length === 1;
  // Its files go to the Trash. From a chat everyone can read they show there, to be restored
  // into Files; from a private chat or a DM they are kept but shown to nobody.
  const priv = info(m.channel)?.kind === 'private' || info(m.channel)?.kind === 'dm';
  const check = files.length ? {
    label: h('span', {}, `Also move ${one ? 'its file' : `its ${files.length} files`} to Trash: `, h('b', {}, files.map((p) => p.slice(p.lastIndexOf('/') + 1)).join(', ')),
      `. No other message links ${one ? 'it' : 'them'}.` + (priv ? ` ${one ? 'It is' : 'They are'} kept 30 days, and only an admin can get ${one ? 'it' : 'them'} back.` : '')),
    value: true,
  } : undefined;
  const shown = v.renderMessage(m, false, true);
  shown.inert = true;
  const body = h('div', { class: 'del-preview' }, shown);
  if ((!noQuestion || check) && !await ask({ title: 'Delete this message?', body, confirm: 'Delete', danger: true, check })) return;
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

// isMedia: a picture, video or sound in Files that's there, or one posted in a chat.
const isMedia = (path: string) => MEDIA_EXT.test(path) && (hooks.fileMod(path) !== null || !!attachment(path));

// carded: a link chat shows as a card under the message: a file posted in a chat, a file or
// folder in Files, a schematic post. Any of them, however the link got into the text.
const carded = (path: string) => !!attachment(path) || !!hooks.schemPost(path) || !!hooks.entry(path);

// fileLinks is a text's links to things with a card, where they are in it (code left out).
type FileLink = { from: number; to: number; path: string };
function fileLinks(text: string): FileLink[] {
  const out: FileLink[] = [];
  for (const m of maskCode(text).matchAll(TOKEN)) {
    const written = m[2] ?? m[3];
    const path = written === undefined ? null : resolveRef(written);
    if (path && carded(path)) out.push({ from: m.index!, to: m.index! + m[0].length, path });
  }
  return out;
}

// cardPaths is what gets a card under a message: the first ten things its links point to.
function cardPaths(text: string): string[] {
  const out: string[] = [];
  for (const l of fileLinks(text)) if (out.length < MAX_PREVIEWS_MEDIA && !out.includes(l.path)) out.push(l.path);
  return out;
}

// A line that starts a Markdown block: a quote, a list item, a heading, small text.
const BLOCK = /^\s*(?:>|[-*] |\d{1,3}\. |#{1,3} |-# )/;

// aloneLinks is the links (to cards) whose text isn't shown: one on a line of its own (with
// other such links at most), or after the message's last words. One inside a sentence stays
// a link, its card below as well (as in Discord, which hides a link only when it stands alone).
function aloneLinks(text: string, cards: string[]): FileLink[] {
  const links = fileLinks(text).filter((l) => cards.includes(l.path));
  if (!links.length) return [];
  const blank = text.split('');
  for (const l of links) blank.fill(' ', l.from, l.to);
  const rest = blank.join('');
  const words = rest.trimEnd().length; // links from here on come after the last words
  return links.filter((l) => {
    const end = rest.indexOf('\n', l.from);
    const line = rest.slice(rest.lastIndexOf('\n', l.from) + 1, end < 0 ? undefined : end);
    if (BLOCK.test(line)) return false; // in a quote, a list or a heading: part of it
    return l.from >= words || !line.trim();
  });
}

// hideAlone is the text without those links (and a space beside each). A line they leave
// empty goes with its line break, so no gap shows where a link was.
function hideAlone(text: string, alone: FileLink[]): string {
  if (!alone.length) return text;
  const gone = new Uint8Array(text.length);
  for (let { from, to } of alone) {
    if (from > 0 && /[ \t]/.test(text[from - 1])) from--;
    else if (/[ \t]/.test(text[to] ?? '')) to++;
    gone.fill(1, from, to);
  }
  const out: string[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    let kept = '';
    for (let i = 0; i < line.length; i++) if (!gone[at + i]) kept += line[i];
    if (!line.trim() || kept.trim()) out.push(kept);
    at += line.length + 1;
  }
  return out.join('\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
}

// mediaPreviews is the cards under a message, for its links (cardPaths), in order: pictures
// (a thumbnail, or the GIF itself so it moves), videos and sounds (players), schematic cards,
// a card for any other file posted in chat (name, size, Download), and for a file or folder
// in Files (name, size; opens it). Clicking a picture or card opens it; each drags as its
// path (a card in another chat's box). As pictures arrive the list grows; ChatView.keep
// holds the view.
function mediaPreviews(paths: string[], msg?: Message) {
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
  for (const path of paths) {
    box.append(draggable(previewOf(path), path));
  }
  return paths.length ? box : null;

  function previewOf(path: string): HTMLElement {
    // A schematic post (its folder): a card.
    const post = hooks.schemPost(path);
    if (post) {
      const c = h('div', { class: 'ref-card', title: 'Open the post' },
        h('div', { class: 'ref-title' }, post.title),
        h('div', { class: 'ref-file' }, post.file), h('div', { class: 'muted' }, post.credit ? `Design by ${post.credit}` : 'Schematic'));
      c.onclick = () => hooks.openPath(path);
      return c;
    }
    const att = attachment(path);
    const url = mediaURL(path);
    const name = baseName(path);
    if (!MEDIA_EXT.test(path)) return att ? fileCard(att) : filesCard(path);
    if (IMAGE_EXT.test(path)) {
      const src = /\.gif$/i.test(path) ? url : att ? `/api/channels/${enc(att.chat)}/thumb/${encodeURIComponent(att.file)}` : `/api/thumb/${enc(path)}?v=${hooks.fileMod(path)}`;
      return pic(src, url, name, '#' + path, view({ src: url, name, who: msg?.user, when: msg?.t ?? hooks.fileMod(path) ?? undefined,
        forward: forward ?? (() => shareLink(pathRef(path))),
        reveal: att ? undefined : () => hooks.revealMedia(path), save: att ? () => saveToFiles([path]) : undefined }));
    }
    if (VIDEO_EXT.test(path)) return h('div', { class: 'ref-video' }, h('video', { src: url, controls: true, preload: 'metadata', title: name }));
    return h('div', { class: 'ref-audio' }, h('div', { class: 'ref-file' }, name), h('audio', { src: url, controls: true, preload: 'none' }));
  }
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// draggable makes a card under a message (or a link in its text) drag as the hub's path to
// it, so dropping it in a chat makes a card there, never the page's URL as text. fromMessage
// is where such a drag began: dropped back in that same chat it counts only on the message
// box, so a picture pressed too long and let go goes nowhere (see accidental).
let fromMessage: { view: ChatView | null; chat: string } | null = null;
function draggable(el: HTMLElement, path: string) {
  el.draggable = true;
  el.ondragstart = (e) => {
    e.stopPropagation();
    dragData(e, path, [path]);
    const view = [main, side].find((v) => v.root.contains(el)) ?? null;
    fromMessage = { view, chat: view?.channel ?? '' };
  };
  return el;
}

// accidental: a drag out of a message let go anywhere but a message box (its own chat's, or
// an edit box) or another chat's pane. It's taken nowhere.
function accidental(e: DragEvent, into: ChatView | null) {
  if (!fromMessage) return false;
  if (!into) return true;
  const same = fromMessage.view === into && fromMessage.chat === into.channel;
  return same && !(e.target as Element).closest?.('.composer, .msg-edit');
}

// filesCard is a file or folder in Files under a message: its icon, name and size (a
// folder's line says Folder). Clicking it opens it.
function filesCard(path: string) {
  const e = hooks.entry(path);
  const dir = !!e?.dir;
  const c = h('div', { class: dir ? 'folder-card' : 'file-card', title: `Open ${path}` }, h('img', { class: 'icon', src: iconURL(path, dir, false), alt: '' }),
    h('div', { class: 'file-text' }, h('div', { class: 'file-name' }, baseName(path)), h('div', { class: 'muted file-size' }, dir ? 'Folder' : e ? bytes(e.size) : '')));
  c.onclick = () => hooks.openPath(path);
  return c;
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
// formatting marks (style guide 8), and links to what has a card become their names, so no
// raw paths show.
function plainText(text: string) {
  return stripMarkdown(text).replace(TOKEN, (whole, url, bracketed, bare) => {
    const path = (bracketed ?? bare) !== undefined ? resolveRef(bracketed ?? bare) : null;
    const post = path && hooks.schemPost(path);
    if (post) return `[${post.title}]`;
    if (path && carded(path)) return `[${baseName(path)}]`;
    return whole;
  });
}

// ---- release cards ----

// A mod release post (the MacroTech release account posts them) is plain Markdown,
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

// renderBody is a message's text as shown: a release card, or formatted text without the
// links that stand alone (their cards, cards, are under the message).
function renderBody(text: string, cards = cardPaths(text)): Node[] {
  const r = parseRelease(text);
  return r ? [releaseCard(r)] : renderText(hideAlone(text, aloneLinks(text, cards)));
}

// ownCards is what gets a card under a message: its links, then its forward's. A release
// card's file is in the card already.
function ownCards(m: Message): string[] {
  const r = m.text ? parseRelease(m.text) : null;
  return cardPaths((r ? `${r.changes}\n${r.note ?? ''}` : m.text) + '\n' + (m.fwd?.text ?? ''));
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
    // <https://…> is a link without a preview; the brackets aren't shown.
    const quiet = !!url && text[m.index! - 1] === '<' && text[m.index! + whole.length] === '>';
    out.push(...emojify(text.slice(last, m.index! - (quiet ? 1 : 0))));
    if (url) {
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
      if (quiet) {
        last = m.index! + whole.length + 1;
        continue;
      }
    } else if (attachment(path!)) {
      // A file posted in a chat, inside a sentence: its name (its card is under the message).
      const a = attachment(path!)!;
      out.push(draggable(h('a', { href: attachURL(a), target: '_blank', rel: 'noopener', class: 'file-link', title: `Open ${a.file}` }, a.file), path!));
    } else {
      // A file that has moved since shows its name now; the tooltip keeps the original.
      const title = path === written ? `Open ${path}` : `Was ${written} · Open ${path}`;
      const a = h('a', { href: '#' + path, class: 'file-link', title }, path!);
      a.onclick = (e) => {
        e.preventDefault();
        hooks.openPath(path!);
      };
      out.push(draggable(a, path!));
    }
    last = m.index! + whole.length;
  }
  out.push(...emojify(text.slice(last)));
  return out;
}

const MENTION = /(^|[^\w@])@(everyone|here|[A-Za-z0-9_-]{1,32})\b/g;

// emojify is plain text with mentions of people highlighted (@name, for anyone who has
// posted, and @everyone/@here) and emoji drawn as images. There are no notifications: the
// highlight just makes them stand out, as in Discord.
function emojify(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const name = m[2];
    if (name !== 'everyone' && name !== 'here' && !knownNames.has(name.toLowerCase())) continue;
    const at = m.index! + m[1].length;
    out.push(...emojiOnly(text.slice(last, at)), h('span', { class: 'mention' }, '@' + name));
    last = at + 1 + name.length;
  }
  out.push(...emojiOnly(text.slice(last)));
  return out;
}

// mentionsMe: someone else's message that names you (@you, @everyone, @here; not in code) or
// answers one of yours. Its whole row is tinted, as in Discord; there are no notifications,
// so the tint is how you see it was meant for you.
function mentionsMe(m: Message, q: Quote | null): boolean {
  if (m.user === user.name) return false;
  if (q?.user === user.name) return true;
  const me = user.name.toLowerCase();
  for (const x of withoutCode(m.text).matchAll(MENTION)) {
    const name = x[2].toLowerCase();
    if (name === me || name === 'everyone' || name === 'here') return true;
  }
  return false;
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
  retry: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  eye: svg('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>'),
  down: svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  lock: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  lockOpen: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
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

// grow fits a message box to its text, up to half its chat's height (then it scrolls inside,
// as Discord's does). A box that isn't on screen can't be measured: it's left at its natural
// height, and layoutChanged fits it once it shows.
// Measuring takes the box down to one line for a moment. An edit box is inside the feed, which
// is shorter for that moment and, near its bottom, scrolls up to fit: put it back after.
function grow(t: HTMLTextAreaElement) {
  const feed = t.closest('.messages');
  const top = feed?.scrollTop;
  t.style.height = 'auto';
  if (!t.offsetParent) {
    t.style.height = '';
    return;
  }
  const pane = t.closest('.composer, .messages-wrap')?.parentElement;
  const most = Math.max(200, Math.floor((pane?.clientHeight ?? 0) / 2));
  const border = t.offsetHeight - t.clientHeight; // scrollHeight leaves it out
  t.style.height = Math.min(t.scrollHeight + border, most) + 'px';
  if (feed && feed.scrollTop !== top) feed.scrollTop = top!;
}

// formatKey handles Discord's formatting keys in a message box: Ctrl+B, Ctrl+I and Ctrl+U put
// **bold**, *italic* or __underline__ marks around the selected text, or take them off if
// they're there; with nothing selected, an empty pair with the cursor inside. True if it was
// one of them (the browser's own use of the key is then skipped).
const FORMAT_KEYS: Record<string, string> = { b: '**', i: '*', u: '__' };
function formatKey(e: KeyboardEvent, t: HTMLTextAreaElement): boolean {
  const mark = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey ? FORMAT_KEYS[e.key.toLowerCase()] : undefined;
  if (!mark) return false;
  e.preventDefault();
  if (t.readOnly) return true;
  const v = t.value;
  const from = t.selectionStart;
  const to = t.selectionEnd;
  // How many of the mark's character sit right against the selection on each side: * and **
  // share one, so italic is on when that's 1 or 3 and bold when it's 2 or more.
  const ch = mark[0];
  let before = 0;
  while (v[from - 1 - before] === ch) before++;
  let after = 0;
  while (v[to + after] === ch) after++;
  const n = Math.min(before, after);
  const on = mark === '*' ? n === 1 || n === 3 : n >= 2;
  const inner = v.slice(from, to);
  // One replacement the browser can undo (Ctrl+Z), then the same text selected again.
  const put = (a: number, b: number, text: string, selFrom: number) => {
    t.setSelectionRange(a, b);
    if (!document.execCommand('insertText', false, text)) {
      t.setRangeText(text, a, b, 'end');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
    t.setSelectionRange(selFrom, selFrom + inner.length);
  };
  if (on) put(from - mark.length, to + mark.length, inner, from - mark.length);
  else put(from, to, mark + inner + mark, from + mark.length);
  return true;
}

function insert(t: HTMLTextAreaElement, s: string) {
  const at = t.selectionStart ?? t.value.length;
  t.value = t.value.slice(0, at) + s + t.value.slice(t.selectionEnd ?? at);
  t.selectionStart = t.selectionEnd = at + s.length;
  t.focus();
  grow(t);
}
