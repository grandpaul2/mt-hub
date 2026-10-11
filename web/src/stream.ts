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
  fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
};

// 1080p at 30 frames a second (720p looked too soft), 5 Mbit/s: enough for a game
// in motion.
const MAX_BITRATE = 5_000_000;

let info: { enabled: boolean; max: number; full: boolean; streams: Stream[]; relay?: Relay[]; relayDelay?: number } = { enabled: false, max: 3, full: false, streams: [] };
const relays = () => info.relay ?? []; // (an older hub's answer has none)
let sharing: { id: string; room: LK.Room; media: MediaStreamTrack } | null = null;
let starting = false;
// What a relay stream being watched adds: its connection, the hub's id for it (to end it),
// whether a picture ever came, and the wait for one.
type RelayWatch = { pc: RTCPeerConnection | null; session: string; shown: boolean; timer: number };
let watching: { name: string; id: string; room: LK.Room | null; relay?: RelayWatch } | null = null;
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
  if (watching && !watching.relay && !info.streams.some((s) => s.id === watching!.id) && watching.room) endedWhileWatching();
  if (watching?.relay?.pc && !relays().some((s) => s.name === watching!.name)) endedWhileWatching();
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
      showMenu(e, [['Watch', () => openWatch(s.name, true)], ...(mine ? [] : [null, ['Message', () => void messageUser(s.name)]] as MenuItem[])]);
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

function openWatch(name: string, relay = false) {
  cameByClick = true;
  location.hash = (relay ? '#stream=' : '#live=') + encodeURIComponent(name);
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
  const relay = !!watching.relay;
  const s = relay ? relays().find((x) => x.name === watching!.name) : info.streams.find((x) => x.id === watching!.id);
  const mine = watching.name === user.name;
  title.textContent = relay ? (mine ? 'Your stream' : `${watching.name}’s stream`) : mine ? 'Your screen' : `${watching.name}’s screen`;
  count.textContent = s ? `${s.viewers.length} watching` : '';
  if (s) count.title = s.viewers.join(', ');
  sound.hidden = !relay;
  for (const row of document.querySelectorAll<HTMLElement>('#live-list .row.live')) {
    row.classList.toggle('active', row.dataset.who === watching.name && row.classList.contains('relay') === relay);
  }
}

// watchStream opens #live=<name> (main.ts calls it, having shown the panel).
export async function watchStream(name: string) {
  if (watching?.name === name && watching.room) return;
  stopWatching();
  backByHistory = cameByClick;
  cameByClick = false;
  watching = { name, id: '', room: null };
  video.srcObject = null;
  video.muted = true; // a screen share has no sound
  soundOn.hidden = true;
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
  if (watching.relay) endRelay(watching.relay);
  video.srcObject = null;
  soundOn.hidden = true;
  const did = watching.relay ? 'streaming' : 'sharing';
  setNote(watching.name === user.name ? `You stopped ${did}.` : `${watching.name} stopped ${did}.`, true);
  count.textContent = '';
}

// ---- watching a relay stream --------------------------------------------------------------

// Your volume for relay streams, kept per browser. Screen shares have no sound.
const vol: { level: number; muted: boolean } = { level: 100, muted: false, ...JSON.parse(load('mt-stream-sound') ?? '{}') };
const sound = h('span', { class: 'live-sound', hidden: true });
const soundOn = h('button', { class: 'live-sound-on', hidden: true }, 'Turn sound on');
const muteBtn = h('button', { class: 'tool' });
const volBar = h('input', { type: 'range', min: '0', max: '100', step: '5', title: 'Volume' });

function applySound() {
  video.volume = volumeCurve(vol.level);
  if (watching?.relay && soundOn.hidden) video.muted = vol.muted || !vol.level;
  volBar.value = String(vol.muted ? 0 : vol.level);
  const off = vol.muted || !vol.level;
  muteBtn.innerHTML = off ? ICON.silent : ICON.sound;
  muteBtn.title = off ? 'Unmute' : 'Mute';
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

function endRelay(r: RelayWatch) {
  clearTimeout(r.timer);
  r.pc?.close();
  r.pc = null;
  if (r.session) void fetch('/api/relay/sessions/' + r.session, { method: 'DELETE', keepalive: true }).catch(() => {});
  r.session = '';
}

// watchRelay opens #stream=<name> (main.ts calls it, having shown the panel).
export async function watchRelay(name: string) {
  if (watching?.relay?.pc && watching.name === name) return;
  stopWatching();
  backByHistory = cameByClick;
  cameByClick = false;
  const r: RelayWatch = { pc: null, session: '', shown: false, timer: 0 };
  const w = { name, id: '', room: null, relay: r };
  watching = w;
  video.srcObject = null;
  soundOn.hidden = true;
  applySound();
  // The speaker chosen in Voice Settings (voice.ts keeps it), where the browser can pick one.
  const speaker = JSON.parse(load('mt-voice') ?? '{}').speaker;
  if (speaker) void (video as { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(speaker).catch(() => {});
  setNote('Connecting…');
  renderPanelHead();
  await loadStreams();
  if (watching !== w) return;
  const mine = name === user.name;
  if (!relays().some((x) => x.name === name)) return setNote(mine ? 'You aren’t streaming right now.' : `${name} isn’t streaming right now.`, true);
  // The relay ends the connection, or never sends a picture, for a stream it can't send to
  // browsers: one with B-frames, which OBS's x264 makes unless told not to.
  const cantShow = () => {
    if (watching !== w) return;
    endRelay(r);
    setNote(`${mine ? 'Your' : `${name}’s`} stream can’t be shown in the hub: it needs the OBS setting bframes=0.`, true);
  };
  const dropped = () => {
    if (watching !== w || !r.pc) return;
    if (!r.shown) return cantShow();
    endRelay(r);
    void loadStreams().then(() => {
      if (watching !== w) return;
      if (relays().some((x) => x.name === name)) setNote('The connection dropped.', true);
      else endedWhileWatching();
    });
  };
  try {
    const pc = new RTCPeerConnection();
    r.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const media = new MediaStream();
    pc.ontrack = (e) => {
      if (watching !== w || r.pc !== pc) return;
      media.addTrack(e.track);
      if (video.srcObject === media) return; // the second track: already playing
      video.srcObject = media;
      setNote('Waiting for the picture…');
      play();
    };
    pc.onconnectionstatechange = () => {
      if (r.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropped();
      // "disconnected" can pass by itself; give it a few seconds.
      else if (pc.connectionState === 'disconnected') setTimeout(() => { if (r.pc === pc && pc.connectionState !== 'connected') dropped(); }, 4000);
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
    r.session = b.id;
    if (watching !== w || r.pc !== pc) return endRelay(r);
    await pc.setRemoteDescription({ type: 'answer', sdp: b.sdp });
    // Held back so the hub shows the same moment as the game's screens, whose player is
    // about 0.7 s slower than WebRTC (measured; the hub says how long).
    for (const rc of pc.getReceivers()) {
      try { (rc as { jitterBufferTarget?: number }).jitterBufferTarget = info.relayDelay ?? 700; } catch { /* a browser without it plays at once */ }
    }
    r.timer = window.setTimeout(() => { if (!r.shown) cantShow(); }, 10000);
  } catch (e) {
    if (watching !== w) return;
    endRelay(r);
    setNote(`Couldn’t connect: ${(e as Error).message}`, true);
  }
}

// stopWatching hangs up (main.ts calls it whenever the panel goes).
export function stopWatching() {
  const w = watching;
  watching = null;
  w?.room?.disconnect();
  if (w?.relay) endRelay(w.relay);
  soundOn.hidden = true;
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
  // A relay stream's sound can start without its picture (a stream the relay then refuses to
  // send), and Chrome calls that "playing" at a size of 2x2. Those wait for a real frame.
  const showing = () => {
    if (watching?.relay && video.videoWidth <= 2) return;
    if (watching?.relay) watching.relay.shown = true;
    setNote('');
  };
  video.addEventListener('playing', showing);
  video.addEventListener('resize', showing);
  // A relay stream's sound: mute and a volume bar in the head, remembered for next time.
  const keep = () => {
    store('mt-stream-sound', JSON.stringify(vol));
    soundOn.hidden = true; // touching the sound is the click the browser wanted
    applySound();
  };
  muteBtn.onclick = () => {
    vol.muted = !(vol.muted || !vol.level);
    if (!vol.muted && !vol.level) vol.level = 50;
    keep();
  };
  volBar.oninput = () => {
    vol.level = Number(volBar.value);
    vol.muted = false;
    keep();
  };
  soundOn.onclick = () => {
    vol.muted = false;
    if (!vol.level) vol.level = 50;
    keep();
  };
  sound.replaceChildren(muteBtn, volBar);
  applySound();
  $('main-live').replaceChildren(
    h('div', { class: 'chat-head live-head' }, title, count, h('span', { class: 'spacer' }), sound, full, stop),
    h('div', { class: 'live-body' }, video, note, soundOn));
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
