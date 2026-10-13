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
//
// Relay streams (agreed design: docs/stream/relay-streams-spec.md) are in LIVE too: a stream
// someone sends to the stream relay with OBS, the kind a video screen in the game plays. They
// have sound, open at #stream=<name>, and come straight from the relay over WebRTC; the hub
// only passes the offer on (internal/server/relay.go). No LiveKit for those.
import type * as LK from 'livekit-client';
import { $, h, isAdmin, load, loadBundle, req, showMenu, store, toast, toastError, user, volumeCurve, type Live, type MenuItem } from './util';
import { messageUser } from './chat';

type Stream = { id: string; name: string; started: string; viewers: string[] };
type Relay = { name: string; started: string; viewers: string[] };

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
// Lucide icons (ISC licence).
const ICON = {
  screen: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
  radio: svg('<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>'),
  sound: svg('<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>'),
  silent: svg('<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>'),
  exitFull: svg('<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>'),
  fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
};

// 1080p at 30 frames a second (720p looked too soft), 5 Mbit/s: enough for a game
// in motion.
const MAX_BITRATE = 5_000_000;

let info: { enabled: boolean; max: number; full: boolean; streams: Stream[]; relay?: Relay[]; relayDelay?: number } = { enabled: false, max: 3, full: false, streams: [] };
const relays = () => info.relay ?? []; // (an older hub's answer has none)
let sharing: { id: string; room: LK.Room; media: MediaStreamTrack } | null = null;
let starting = false;
// What you're watching, if anything.
type Watch = {
  name: string;
  relay: boolean; // a relay stream, not a screen share
  id: string; room: LK.Room | null; // a screen share: the hub's id for it, its LiveKit room
  pc: RTCPeerConnection | null; session: string; // a relay stream: its connection, the hub's id for it (to end it)
  shown: boolean; // a picture has come at least once
  live: boolean; // the connection there is now is showing one
  over: boolean; // ended or failed: the panel says why, nothing is connected or will be
  tries: number; again: number; // reconnecting: tries so far, the timer for the next
  wait: number; // the wait for a connection's first picture
  away: number; // the stream left the list: the timer until that counts as stopped
};
let watching: Watch | null = null;
let cameByClick = false; // the next watch was opened from a row or the strip
let backByHistory = false; // this one was, so Stop watching goes Back

// Phones can't share (no getDisplayMedia), only watch.
const canShare = () => !!navigator.mediaDevices?.getDisplayMedia;

let hooks: { leave: () => void; show: () => void } = { leave: () => {}, show: () => {} };

// ---- the list ---------------------------------------------------------------------------

async function loadStreams() {
  const r = await req('GET', '/api/streams');
  if (!r.ok) return;
  info = await r.json();
  followList();
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
      class: 'row channel live' + (mine ? ' here' : '') + (watching && !watching.relay && watching.name === s.name ? ' active' : ''),
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
  for (const s of relays()) {
    const mine = s.name === user.name;
    const row = h('div', {
      class: 'row channel live relay' + (mine ? ' here' : '') + (watching?.relay && watching.name === s.name ? ' active' : ''),
      title: mine ? 'You’re streaming' : `Watch ${s.name}’s stream`,
    }, h('span', { class: 'hash', innerHTML: ICON.radio }), h('span', { class: 'name' }, s.name));
    row.dataset.who = s.name;
    row.onclick = () => openWatch(s.name, true);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e, [['Watch', () => openWatch(s.name, true)], ...stopItem(s.name, true), ...(mine ? [] : [null, ['Message', () => void messageUser(s.name)]] as MenuItem[])]);
    };
    rows.push(row);
  }
  $('live-list').replaceChildren(...rows);
  $('live-section').hidden = !rows.length;
  const strip = $('live-strip');
  const item = (icon: string, text: string, open: () => void) => {
    const b = h('button', { class: 'live-strip-item', innerHTML: icon }, h('span', {}, text), h('span', { class: 'watch' }, 'Watch'));
    b.onclick = open;
    return b;
  };
  strip.replaceChildren(
    ...info.streams.filter((s) => s.name !== user.name).map((s) => item(ICON.screen, `${s.name} is sharing their screen`, () => openWatch(s.name))),
    ...relays().filter((s) => s.name !== user.name).map((s) => item(ICON.radio, `${s.name} is streaming`, () => openWatch(s.name, true))));
  strip.hidden = !strip.children.length;
}

function rowMenu(s: Stream): MenuItem[] {
  const mine = s.name === user.name;
  const items: MenuItem[] = [['Watch', () => openWatch(s.name)], ...stopItem(s.name, false)];
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

// Stop Watching, on the row of what you're watching.
const stopItem = (name: string, relay: boolean): MenuItem[] =>
  watching && !watching.over && watching.name === name && watching.relay === relay ? [['Stop Watching', stop]] : [];

function openWatch(name: string, relay = false) {
  cameByClick = true;
  const hash = (relay ? '#stream=' : '#live=') + encodeURIComponent(name);
  if (location.hash !== hash) return void (location.hash = hash);
  // Already the address (a stream that dropped or ended, clicked again): no change to follow.
  hooks.show();
  void (relay ? watchRelay(name) : watchStream(name));
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
//
// One stream or screen at a time, and it keeps playing when you open something else: the panel
// is put out of sight (CSS .behind), not hidden, so the sound goes on and so does the browser's
// own pop-out player. It ends on Stop watching, when the stream ends, or with another stream.

const video = h('video', { autoplay: true, playsInline: true, muted: true });
const note = h('div', { class: 'live-note' });
const title = h('span', { class: 'live-title' });
const count = h('span', { class: 'muted live-count' });
const body = h('div', { class: 'live-body' });
let shown = false; // the stream panel is the main panel right now

function setNote(text: string, back = false) {
  note.replaceChildren(text, ...(back ? [(() => {
    const b = h('button', {}, 'Back');
    b.onclick = stop;
    return b;
  })()] : []));
  note.hidden = !text;
}

const what = (w: Watch) => {
  const mine = w.name === user.name;
  return w.relay ? (mine ? 'Your stream' : `${w.name}’s stream`) : mine ? 'Your screen' : `${w.name}’s screen`;
};
const stopped = (w: Watch) => {
  const did = w.relay ? 'streaming' : 'sharing';
  return w.name === user.name ? `You stopped ${did}.` : `${w.name} stopped ${did}.`;
};

function renderPanelHead() {
  const w = watching;
  if (!w) return;
  const s = w.relay ? relays().find((x) => x.name === w.name) : info.streams.find((x) => x.id === w.id);
  title.textContent = what(w);
  count.textContent = s && !w.over ? `${s.viewers.length} watching` : '';
  if (s) count.title = s.viewers.join(', ');
  for (const box of soundBoxes) box.hidden = !w.relay;
  for (const row of document.querySelectorAll<HTMLElement>('#live-list .row.live')) {
    row.classList.toggle('active', row.dataset.who === w.name && row.classList.contains('relay') === w.relay);
  }
}

// streamPanel says whether the stream panel is the main panel (main.ts calls it on every
// change of panel). Leaving it keeps a stream playing; a panel that only says why one ended
// has nothing to keep.
export function streamPanel(on: boolean) {
  shown = on;
  if (!on && watching?.over) stopWatching();
  place();
  renderWatchBar();
}

function place() {
  const behind = !shown && !!watching;
  $('main-live').classList.toggle('behind', behind);
  $('main-live').hidden = !shown && !behind;
}

// The bar at the bottom of the sidebar while a stream plays behind something else: back to
// the picture, mute (a relay stream), Stop.
const watchBar = h('div', { id: 'watch-bar', hidden: true });
const barMute = h('button', { class: 'tool' });

function renderWatchBar() {
  const w = watching;
  watchBar.hidden = !w || shown;
  if (!w || shown) return watchBar.replaceChildren();
  const state = w.live ? 'Watching' : w.away ? 'Waiting…' : w.shown ? 'Reconnecting…' : 'Connecting…';
  const where = h('button', { class: 'share-where', title: 'Back to the picture' },
    h('span', { class: w.live ? 'share-ok' : 'muted' }, state), h('span', { class: 'muted' }, what(w)));
  where.onclick = () => openWatch(w.name, w.relay);
  const end = h('button', { class: 'tool', title: 'Stop watching' }, 'Stop');
  end.onclick = stop;
  watchBar.replaceChildren(where, ...(w.relay ? [barMute] : []), end);
}

function newWatch(name: string, relay: boolean): Watch {
  backByHistory = cameByClick;
  cameByClick = false;
  stopWatching();
  const w: Watch = { name, relay, id: '', room: null, pc: null, session: '', shown: false, live: false, over: false, tries: 0, again: 0, wait: 0, away: 0 };
  watching = w;
  video.srcObject = null;
  video.muted = true; // a screen share has no sound; a relay stream's is set by applySound
  soundOn.hidden = true;
  setNote('Connecting…');
  renderPanelHead();
  place();
  renderWatchBar();
  return w;
}

// hangUp closes the connection there is; the watch itself goes on (or is ended by the caller).
function hangUp(w: Watch) {
  clearTimeout(w.wait);
  const room = w.room;
  w.room = null;
  void room?.disconnect();
  w.pc?.close();
  w.pc = null;
  if (w.session) void fetch('/api/relay/sessions/' + w.session, { method: 'DELETE', keepalive: true }).catch(() => {});
  w.session = '';
  w.live = false;
}

// finish ends a watch for a reason. In the panel the reason stays, with Back; behind something
// else it is a toast and the watch is gone.
function finish(w: Watch, text: string, bad = false) {
  if (watching !== w) return;
  clearTimeout(w.again);
  clearTimeout(w.away);
  w.again = w.away = 0;
  hangUp(w);
  w.over = true;
  video.srcObject = null;
  soundOn.hidden = true;
  count.textContent = '';
  if (shown) return setNote(text, true);
  stopWatching();
  if (bad) toastError(text);
  else toast(text, 5000);
}

// again reconnects a watch that has shown a picture: after 1, 2 and 4 seconds, then every 5,
// for as long as the stream is listed. The last frame stays under the note.
const RETRY = [1000, 2000, 4000];
function again(w: Watch) {
  if (watching !== w || w.over) return;
  hangUp(w);
  setNote('Reconnecting…');
  clearTimeout(w.again);
  w.again = window.setTimeout(() => {
    w.again = 0;
    if (watching === w) void (w.relay ? connectRelay(w) : connectShare(w));
  }, RETRY[w.tries++] ?? 5000);
  renderWatchBar();
}

// A relay stream that leaves the list may be the streamer's own connection blinking: it gets
// a minute to come back, and plays again by itself if it does.
const AWAY = 60000;
function gone(w: Watch) {
  clearTimeout(w.again);
  w.again = 0;
  hangUp(w);
  setNote(`${what(w)} stopped. Waiting for it to come back…`);
  w.away = window.setTimeout(() => {
    w.away = 0;
    finish(w, stopped(w));
  }, AWAY);
  renderWatchBar();
}

function cameBack(w: Watch) {
  clearTimeout(w.away);
  w.away = 0;
  w.tries = 0;
  setNote('Reconnecting…');
  void connectRelay(w);
}

// followList is the list's say on what you're watching, each time it is read.
function followList() {
  const w = watching;
  if (!w || w.over) return;
  if (!w.relay) {
    if (w.id && !info.streams.some((s) => s.id === w.id)) finish(w, stopped(w));
    return;
  }
  const on = relays().some((s) => s.name === w.name);
  if (!on && !w.away && (w.pc || w.again)) gone(w);
  else if (on && w.away) cameBack(w);
}

// watchStream opens #live=<name> (main.ts calls it, having shown the panel).
export async function watchStream(name: string) {
  if (watching && !watching.relay && watching.name === name && !watching.over) {
    backByHistory = cameByClick;
    cameByClick = false;
    return;
  }
  const w = newWatch(name, false);
  await loadStreams();
  if (watching !== w) return;
  const s = info.streams.find((x) => x.name === name);
  if (!s) return finish(w, name === user.name ? 'You aren’t sharing your screen right now.' : `${name} isn’t sharing their screen right now.`);
  w.id = s.id;
  renderPanelHead();
  await connectShare(w);
}

async function connectShare(w: Watch) {
  try {
    const r = await req('POST', `/api/streams/${w.id}/watch`);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error ?? 'the hub said no');
    const { Room, RoomEvent, Track } = await loadBundle<typeof LK>('livekit');
    if (watching !== w || w.over || w.room) return;
    // Not adaptiveStream: it stops the picture when the page can't see the video, and the
    // page can't see Firefox's pop-out player.
    const room = new Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: true });
    w.room = room;
    room.on(RoomEvent.TrackSubscribed, (track: LK.RemoteTrack) => {
      if (track.kind !== Track.Kind.Video || w.room !== room) return;
      if (!w.shown) setNote('Waiting for the picture…');
      track.attach(video);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: LK.RemoteTrack) => {
      track.detach(video);
    });
    // LiveKit tries by itself first; Disconnected is when it has given up.
    room.on(RoomEvent.Reconnecting, () => {
      if (w.room === room) setNote('Reconnecting…');
    });
    room.on(RoomEvent.Reconnected, () => {
      if (w.room === room && w.live) setNote('');
    });
    room.on(RoomEvent.Disconnected, () => {
      if (w.room !== room) return;
      w.room = null;
      w.live = false;
      void loadStreams().then(() => again(w)); // (the list has ended it if they stopped sharing)
    });
    await room.connect(b.url, b.token);
    if (w.room !== room) void room.disconnect();
  } catch (e) {
    if (watching !== w || w.over) return;
    if (w.shown) again(w);
    else finish(w, `Couldn’t connect: ${(e as Error).message}`, true);
  }
}

// ---- watching a relay stream --------------------------------------------------------------

// Your volume for relay streams, kept per browser. Screen shares have no sound.
const vol: { level: number; muted: boolean } = { level: 100, muted: false, ...JSON.parse(load('mt-stream-sound') ?? '{}') };
const soundOn = h('button', { class: 'live-sound-on', hidden: true }, 'Turn sound on');
// Mute and a volume bar, twice: in the panel's head and on the bar over a full-screen picture.
const soundBoxes: HTMLElement[] = [];
const muteBtns: HTMLButtonElement[] = [barMute];
const volBars: HTMLInputElement[] = [];

function applySound() {
  video.volume = volumeCurve(vol.level);
  if (watching?.relay && soundOn.hidden) video.muted = vol.muted || !vol.level;
  const off = vol.muted || !vol.level;
  for (const b of volBars) b.value = String(vol.muted ? 0 : vol.level);
  for (const b of muteBtns) {
    b.innerHTML = off ? ICON.silent : ICON.sound;
    b.title = off ? 'Unmute' : 'Mute';
  }
}

function keepSound() {
  store('mt-stream-sound', JSON.stringify(vol));
  soundOn.hidden = true; // touching the sound is the click the browser wanted
  applySound();
}

function toggleMute() {
  vol.muted = !(vol.muted || !vol.level);
  if (!vol.muted && !vol.level) vol.level = 50;
  keepSound();
}

function soundBox() {
  const btn = h('button', { class: 'tool' });
  const bar = h('input', { type: 'range', min: '0', max: '100', step: '5', title: 'Volume' });
  btn.onclick = toggleMute;
  bar.oninput = () => {
    vol.level = Number(bar.value);
    vol.muted = false;
    keepSound();
  };
  const box = h('span', { class: 'live-sound', hidden: true }, btn, bar);
  soundBoxes.push(box);
  muteBtns.push(btn);
  volBars.push(bar);
  return box;
}

// play starts the picture. A browser that won't play sound without a click (the address
// opened directly) gets it muted, with a button over the picture.
function play() {
  video.play().catch((e: DOMException) => {
    if (e.name !== 'NotAllowedError' || !watching?.relay || video.muted) return;
    video.muted = true;
    soundOn.hidden = false;
    void video.play().catch(() => {});
  });
}

// watchRelay opens #stream=<name> (main.ts calls it, having shown the panel).
export async function watchRelay(name: string) {
  if (watching?.relay && watching.name === name && !watching.over) {
    backByHistory = cameByClick;
    cameByClick = false;
    return;
  }
  const w = newWatch(name, true);
  applySound();
  // The speaker chosen in Voice Settings (voice.ts keeps it), where the browser can pick one.
  const speaker = JSON.parse(load('mt-voice') ?? '{}').speaker;
  if (speaker) void (video as { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(speaker).catch(() => {});
  await loadStreams();
  if (watching !== w) return;
  if (!relays().some((x) => x.name === name)) return finish(w, name === user.name ? 'You aren’t streaming right now.' : `${name} isn’t streaming right now.`);
  await connectRelay(w);
}

async function connectRelay(w: Watch) {
  if (watching !== w || w.over || w.pc) return;
  const name = w.name;
  const pc = new RTCPeerConnection();
  w.pc = pc;
  w.live = false;
  // Before any picture has come, a connection the relay ends, or that stays dark, is a stream
  // it can't send to browsers: one with B-frames, which OBS's x264 makes unless told not to.
  // After one has, it is a drop, and the watch reconnects.
  const failed = (text?: string) => {
    if (watching !== w || w.pc !== pc) return;
    if (w.shown) return again(w);
    finish(w, text ?? `${name === user.name ? 'Your' : `${name}’s`} stream can’t be shown in the hub: it needs the OBS setting bframes=0.`, !!text);
  };
  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const media = new MediaStream();
    pc.ontrack = (e) => {
      if (watching !== w || w.pc !== pc) return;
      media.addTrack(e.track);
      if (video.srcObject === media) return; // the second track: already playing
      video.srcObject = media;
      if (!w.shown) setNote('Waiting for the picture…');
      play();
    };
    pc.onconnectionstatechange = () => {
      if (w.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') failed();
      else if (s === 'connected' && w.live) setNote('');
      else if (s === 'disconnected') {
        // It can pass by itself; give it a few seconds before starting over.
        if (w.live) setNote('Reconnecting…');
        setTimeout(() => { if (w.pc === pc && pc.connectionState !== 'connected') failed(); }, 6000);
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    // The relay takes the offer whole, so wait for this side's addresses (two seconds at most).
    await new Promise<void>((ok) => {
      if (pc.iceGatheringState === 'complete') return ok();
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && ok());
      setTimeout(ok, 2000);
    });
    const res = await req('POST', `/api/relay/${encodeURIComponent(name)}/watch`, JSON.stringify({ sdp: pc.localDescription!.sdp }));
    const b = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(b.error ?? 'the hub said no');
    if (watching !== w || w.pc !== pc) { // stopped meanwhile: end what the hub just started
      pc.close();
      return void fetch('/api/relay/sessions/' + b.id, { method: 'DELETE', keepalive: true }).catch(() => {});
    }
    w.session = b.id;
    await pc.setRemoteDescription({ type: 'answer', sdp: b.sdp });
    // Held back so the hub shows the same moment as the game's screens, whose player is
    // about 0.7 s slower than WebRTC (measured; the hub says how long).
    for (const rc of pc.getReceivers()) {
      try { (rc as { jitterBufferTarget?: number }).jitterBufferTarget = info.relayDelay ?? 700; } catch { /* a browser without it plays at once */ }
    }
    w.wait = window.setTimeout(() => { if (w.pc === pc && !w.live) failed(); }, 10000);
  } catch (e) {
    failed(`Couldn’t connect: ${(e as Error).message}`);
  }
}

// stopWatching hangs up and forgets the watch.
function stopWatching() {
  const w = watching;
  if (!w) return;
  watching = null;
  clearTimeout(w.again);
  clearTimeout(w.away);
  hangUp(w);
  soundOn.hidden = true;
  video.srcObject = null;
  if (document.fullscreenElement === body) void document.exitFullscreen().catch(() => {});
  for (const row of document.querySelectorAll('#live-list .row.live.active')) row.classList.remove('active');
  place();
  renderWatchBar();
}

// stop is Stop watching. From the panel it also leaves it: back to where you were if a click
// brought you here, else Files. From anywhere else you stay where you are.
function stop() {
  const here = shown;
  stopWatching();
  if (!here) return;
  if (backByHistory && history.length > 1) history.back();
  else hooks.leave();
}

function buildPanel() {
  const full = h('button', { class: 'tool', title: 'Full screen (double-click the picture)', innerHTML: ICON.fullscreen });
  // The picture's box goes full screen, not the video alone, so the bar below goes with it.
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void (body.requestFullscreen?.() ?? Promise.resolve()).catch(() => {});
  };
  full.onclick = toggleFull;
  video.ondblclick = toggleFull;
  const end = h('button', { class: 'tool' }, 'Stop watching');
  end.onclick = stop;
  // A relay stream's sound can start without its picture (a stream the relay then refuses to
  // send), and Chrome calls that "playing" at a size of 2x2. Those wait for a real frame.
  const showing = () => {
    const w = watching;
    if (!w || w.over || !(w.relay ? w.pc : w.room)) return;
    if (w.relay && video.videoWidth <= 2) return;
    clearTimeout(w.wait);
    w.shown = w.live = true;
    w.tries = 0;
    setNote('');
    renderWatchBar();
  };
  video.addEventListener('playing', showing);
  video.addEventListener('resize', showing);
  soundOn.onclick = () => {
    vol.muted = false;
    if (!vol.level) vol.level = 50;
    keepSound();
  };
  barMute.onclick = toggleMute;
  // Full screen: a bar over the bottom of the picture with the sound and a way out. It shows
  // when the mouse moves and goes after three seconds of stillness, with the pointer.
  const exit = h('button', { class: 'tool', title: 'Exit full screen (Esc)', innerHTML: ICON.exitFull }, h('span', {}, 'Exit full screen'));
  exit.onclick = toggleFull;
  const over = h('div', { class: 'live-over' }, soundBox(), h('span', { class: 'spacer' }), exit);
  let idle = 0;
  const wake = () => {
    body.classList.remove('idle');
    clearTimeout(idle);
    idle = window.setTimeout(() => (over.matches(':hover') ? wake() : body.classList.add('idle')), 3000);
  };
  body.addEventListener('mousemove', wake);
  body.addEventListener('touchstart', wake, { passive: true });
  body.addEventListener('fullscreenchange', wake);
  const headSound = soundBox();
  applySound();
  body.replaceChildren(video, note, soundOn, over);
  $('main-live').replaceChildren(
    h('div', { class: 'chat-head live-head' }, title, count, h('span', { class: 'spacer' }), headSound, full, end),
    body);
}

// ---- setup ------------------------------------------------------------------------------

export function setupStreams(events: Live, h_: { leave: () => void; show: () => void }) {
  hooks = h_;
  buildPanel();
  $('side-foot').prepend(watchBar, bar);
  $('new-share').onclick = () => void share();
  $('new-share').hidden = !canShare();
  events.addEventListener('stream', () => void loadStreams());
  events.addEventListener('open', () => void loadStreams());
  void loadStreams();
}
