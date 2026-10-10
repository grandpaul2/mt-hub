// Screen sharing (agreed design: docs/stream/screen-share-spec.md).
//
// Anyone can share a window or their screen, video only, from the "+" next to CHATS (or
// LIVE's). While someone shares, LIVE appears in the sidebar with their name; clicking it
// watches in the main panel (#live=<name>). It ends when they press Stop, close the shared
// window (the browser ends the capture), close the page or drop off.
//
// The hub keeps the list and hands out tokens (internal/server/stream.go); the picture goes
// through LiveKit on the relay VPS, the same one voice chats use, each stream its own room.
// LiveKit's client is loaded on first use, as for voice.
import type * as LK from 'livekit-client';
import { $, h, isAdmin, loadBundle, req, showMenu, toast, toastError, user, type Live, type MenuItem } from './util';
import { messageUser } from './chat';

type Stream = { id: string; name: string; started: string; viewers: string[] };

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
// Lucide icons (ISC licence).
const ICON = {
  screen: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
  fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
};

// 1080p at 30 frames a second (Paul, S55: 720p looked too soft), 5 Mbit/s: enough for a game
// in motion.
const MAX_BITRATE = 5_000_000;

let info: { enabled: boolean; max: number; full: boolean; streams: Stream[] } = { enabled: false, max: 3, full: false, streams: [] };
let sharing: { id: string; room: LK.Room; media: MediaStreamTrack } | null = null;
let starting = false;
let watching: { name: string; id: string; room: LK.Room | null } | null = null;
let cameByClick = false; // the next watch was opened from a row or the strip
let backByHistory = false; // this one was, so Stop watching goes Back

// Phones can't share (no getDisplayMedia), only watch.
const canShare = () => !!navigator.mediaDevices?.getDisplayMedia;

let hooks: { leave: () => void } = { leave: () => {} };

// ---- the list ---------------------------------------------------------------------------

async function loadStreams() {
  const r = await req('GET', '/api/streams');
  if (!r.ok) return;
  info = await r.json();
  if (watching && !info.streams.some((s) => s.id === watching!.id) && watching.room) endedWhileWatching();
  renderList();
  renderBar();
  renderPanelHead();
}

// renderList draws LIVE in the sidebar (there only while someone's sharing) and, on phones,
// the strip at the top of the chat.
function renderList() {
  const rows = info.streams.map((s) => {
    const mine = s.name === user.name;
    const row = h('div', {
      class: 'row channel live' + (mine ? ' here' : '') + (watching?.id === s.id ? ' active' : ''),
      title: mine ? 'You’re sharing your screen' : `Watch ${s.name}’s screen`,
    }, h('span', { class: 'hash', innerHTML: ICON.screen }), h('span', { class: 'name' }, s.name));
    row.dataset.who = s.name;
    row.onclick = () => openWatch(s.name);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e, rowMenu(s));
    };
    return row;
  });
  $('live-list').replaceChildren(...rows);
  $('live-section').hidden = !rows.length;
  const others = info.streams.filter((s) => s.name !== user.name);
  const strip = $('live-strip');
  strip.replaceChildren(...others.map((s) => {
    const b = h('button', { class: 'live-strip-item', innerHTML: ICON.screen }, h('span', {}, `${s.name} is sharing their screen`), h('span', { class: 'watch' }, 'Watch'));
    b.onclick = () => openWatch(s.name);
    return b;
  }));
  strip.hidden = !others.length;
}

function rowMenu(s: Stream): MenuItem[] {
  const mine = s.name === user.name;
  const items: MenuItem[] = [['Watch', () => openWatch(s.name)]];
  if (!mine) items.push(null, ['Message', () => void messageUser(s.name)]);
  if (mine) items.push(null, ['Stop Sharing', () => void stopShare(true), undefined, undefined, { danger: true }]);
  else if (user.owner || (user.admin && !isAdmin(s.name))) {
    items.push(null, ['Stop Stream', async () => {
      const r = await req('POST', `/api/streams/${s.id}/stop`);
      if (r.ok) toast(`Stopped ${s.name}’s stream`, 3000);
      else toastError(`Couldn’t: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
    }, undefined, undefined, { danger: true, confirm: 'Stop? Click again' }]);
  }
  return items;
}

function openWatch(name: string) {
  cameByClick = true;
  location.hash = '#live=' + encodeURIComponent(name);
}

// The "+" menus' entry (chat.ts adds it next to the voice chat ones).
export function streamMenuItems(): MenuItem[] {
  if (!info.enabled || !canShare()) return [];
  const full = info.full ? `${info.max} people are already sharing their screens.` : undefined;
  return [null, ['Share Your Screen…', () => void share(), undefined, full]];
}

// ---- sharing ----------------------------------------------------------------------------

// share asks the browser for a window or screen (straight from the click: browsers only
// show the picker for one), then starts the stream. Starting again while sharing replaces it.
async function share() {
  if (starting) return;
  let media: MediaStream;
  try {
    media = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions);
  } catch (e) {
    if ((e as DOMException).name === 'NotAllowedError' || (e as DOMException).name === 'AbortError') return; // cancelled the picker
    return toastError(`Couldn’t share your screen: ${(e as Error).message}`);
  }
  const track = media.getVideoTracks()[0];
  // A game moves: without this, browsers keep a screen share sharp by dropping to a few
  // frames a second, as for a document.
  track.contentHint = 'motion';
  starting = true;
  try {
    if (sharing) await stopShare(false, true);
    const lk = loadBundle<typeof LK>('livekit');
    const r = await req('POST', '/api/streams');
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error ?? 'the hub said no');
    const { Room, RoomEvent, Track, LocalVideoTrack, DisconnectReason } = await lk;
    const room = new Room({ disconnectOnPageLeave: true, adaptiveStream: false, dynacast: false });
    room.on(RoomEvent.Disconnected, (reason?: LK.DisconnectReason) => {
      if (sharing?.room !== room) return;
      const id = sharing.id;
      void stopShare(true, true).then(() => {
        // The hub closes the room when an admin stops the stream, or when you start sharing
        // again somewhere else (another tab), which replaces it.
        if (reason !== DisconnectReason.ROOM_DELETED) toastError('Screen sharing stopped: the connection dropped.');
        else if (info.streams.some((x) => x.name === user.name && x.id !== id)) toast('You’re now sharing from another tab.', 4000);
        else toast('An admin stopped your screen sharing.', 6000);
      });
    });
    await room.connect(b.url, b.token);
    if (track.readyState === 'ended') { // closed the window while connecting
      room.disconnect();
      throw new Error('the window was closed');
    }
    sharing = { id: b.id, room, media: track };
    track.addEventListener('ended', () => {
      if (sharing?.media === track) void stopShare(true);
    });
    await room.localParticipant.publishTrack(new LocalVideoTrack(track, undefined, true), {
      source: Track.Source.ScreenShare, videoCodec: 'vp8', simulcast: false,
      screenShareEncoding: { maxBitrate: MAX_BITRATE, maxFramerate: 30 }, degradationPreference: 'maintain-framerate',
    });
  } catch (e) {
    track.stop();
    if (sharing?.media === track) await stopShare(true, true);
    toastError(`Couldn’t share your screen: ${(e as Error).message}`);
  } finally {
    starting = false;
  }
  renderBar();
  await loadStreams();
}

// stopShare ends your stream; tell says the hub should hear now (not just from LiveKit).
async function stopShare(tell: boolean, quiet = false) {
  const s = sharing;
  if (!s) return;
  sharing = null;
  s.media.stop();
  await s.room.disconnect();
  if (tell) await req('POST', `/api/streams/${s.id}/stop`);
  if (!quiet) toast('You stopped sharing your screen.', 2500);
  renderBar();
  await loadStreams();
}

// ---- the bar at the bottom of the sidebar ------------------------------------------------

const bar = h('div', { id: 'share-bar', hidden: true });

function renderBar() {
  bar.hidden = !sharing;
  if (!sharing) return bar.replaceChildren();
  const mine = info.streams.find((s) => s.id === sharing!.id);
  const viewers = mine?.viewers ?? [];
  const who = h('span', { class: 'muted' }, viewers.length ? `${viewers.length} watching` : 'Nobody watching yet');
  if (viewers.length) who.title = viewers.join(', ');
  const stop = h('button', { class: 'tool danger', title: 'Stop sharing your screen' }, 'Stop');
  stop.onclick = () => void stopShare(true);
  bar.replaceChildren(h('div', { class: 'share-where' }, h('span', { class: 'share-ok' }, 'Sharing your screen'), who), stop);
}

// ---- watching ---------------------------------------------------------------------------

const video = h('video', { autoplay: true, playsInline: true, muted: true });
const note = h('div', { class: 'live-note' });
const title = h('span', { class: 'live-title' });
const count = h('span', { class: 'muted live-count' });

function setNote(text: string, back = false) {
  note.replaceChildren(text, ...(back ? [(() => {
    const b = h('button', {}, 'Back');
    b.onclick = leave;
    return b;
  })()] : []));
  note.hidden = !text;
}

function renderPanelHead() {
  if (!watching) return;
  const s = info.streams.find((x) => x.id === watching!.id);
  title.textContent = watching.name === user.name ? 'Your screen' : `${watching.name}’s screen`;
  count.textContent = s ? `${s.viewers.length} watching` : '';
  if (s) count.title = s.viewers.join(', ');
  for (const row of document.querySelectorAll<HTMLElement>('#live-list .row.live')) row.classList.toggle('active', row.dataset.who === watching.name);
}

// watchStream opens #live=<name> (main.ts calls it, having shown the panel).
export async function watchStream(name: string) {
  if (watching?.name === name && watching.room) return;
  stopWatching();
  backByHistory = cameByClick;
  cameByClick = false;
  watching = { name, id: '', room: null };
  video.srcObject = null;
  setNote('Connecting…');
  renderPanelHead();
  await loadStreams();
  if (watching?.name !== name) return;
  const s = info.streams.find((x) => x.name === name);
  if (!s) return setNote(name === user.name ? 'You aren’t sharing your screen right now.' : `${name} isn’t sharing their screen right now.`, true);
  watching.id = s.id;
  renderPanelHead();
  try {
    const r = await req('POST', `/api/streams/${s.id}/watch`);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error ?? 'the hub said no');
    const { Room, RoomEvent, Track } = await loadBundle<typeof LK>('livekit');
    if (watching?.id !== s.id) return;
    const room = new Room({ adaptiveStream: true, dynacast: false, disconnectOnPageLeave: true });
    watching.room = room;
    room.on(RoomEvent.TrackSubscribed, (track: LK.RemoteTrack) => {
      if (track.kind !== Track.Kind.Video || watching?.room !== room) return;
      setNote('Waiting for the picture…');
      track.attach(video);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: LK.RemoteTrack) => {
      track.detach(video);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (watching?.room !== room) return;
      watching.room = null;
      void loadStreams().then(() => {
        if (watching?.id === s.id && !note.textContent?.includes('stopped sharing')) {
          if (info.streams.some((x) => x.id === s.id)) setNote('The connection dropped.', true);
          else endedWhileWatching();
        }
      });
    });
    await room.connect(b.url, b.token);
    if (watching?.room !== room) room.disconnect();
  } catch (e) {
    if (watching?.id === s.id) setNote(`Couldn’t connect: ${(e as Error).message}`, true);
  }
}

function endedWhileWatching() {
  if (!watching) return;
  const room = watching.room;
  watching.room = null;
  room?.disconnect();
  video.srcObject = null;
  setNote(watching.name === user.name ? 'You stopped sharing.' : `${watching.name} stopped sharing.`, true);
  count.textContent = '';
}

// stopWatching hangs up (main.ts calls it whenever the panel goes).
export function stopWatching() {
  const w = watching;
  watching = null;
  w?.room?.disconnect();
  video.srcObject = null;
  for (const row of document.querySelectorAll('#live-list .row.live.active')) row.classList.remove('active');
}

// leave is Stop watching: back to where you were if a click brought you here, else Files.
function leave() {
  if (backByHistory && history.length > 1) history.back();
  else hooks.leave();
}

function buildPanel() {
  const full = h('button', { class: 'tool', title: 'Full screen (double-click the picture)', innerHTML: ICON.fullscreen });
  const goFull = () => void (video.requestFullscreen?.() ?? Promise.resolve()).catch(() => {});
  full.onclick = goFull;
  video.ondblclick = goFull;
  const stop = h('button', { class: 'tool' }, 'Stop watching');
  stop.onclick = leave;
  video.addEventListener('playing', () => setNote(''));
  $('main-live').replaceChildren(
    h('div', { class: 'chat-head live-head' }, title, count, h('span', { class: 'spacer' }), full, stop),
    h('div', { class: 'live-body' }, video, note));
}

// ---- setup ------------------------------------------------------------------------------

export function setupStreams(events: Live, h_: { leave: () => void }) {
  hooks = h_;
  buildPanel();
  $('side-foot').prepend(bar);
  $('new-share').onclick = () => void share();
  $('new-share').hidden = !canShare();
  events.addEventListener('stream', () => void loadStreams());
  events.addEventListener('open', () => void loadStreams());
  void loadStreams();
}
