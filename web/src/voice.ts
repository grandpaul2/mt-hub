// Voice chats (agreed design: docs/voice/rooms-design.md).
//
// No permanent rooms: VOICE's "+" starts a voice chat (or a private one, for the people you
// invite), others click it to join, and it ends when the last person leaves. A voice chat has
// no name: it's shown under VOICE (always in the sidebar where voice chats are set up) as the
// people in it, in the order they joined. You're in one at
// a time; the bar at the bottom of the sidebar has mute, deafen, settings and leave.
//
// The hub keeps the list and hands out tokens (internal/server/voice.go); the audio goes
// through LiveKit on the relay VPS. Your microphone goes through the game's own chain, in this
// page, so you sound the same here as in game (docs/voice/svc-mic.md):
//   mic (the browser's processing all off: raw, as Simple Voice Chat reads a microphone)
//   -> Simple Voice Chat's RNNoise, gain and activation, then MT Utils' keyboard gate
//      (svcmic.ts, in the svc-mic worklet)
//   -> LiveKit (Opus mono, with FEC and DTX).
// Voice Settings are Simple Voice Chat's, with its defaults, and say so in red when a change
// would make you sound worse to others.
import type * as LK from 'livekit-client';
import { DEFAULT_SETTINGS, type MicSettings } from './svcmic';
import { $, footBar, group, h, isAdmin, load, loadBundle, readout, req, reveal, row, settingsDialog, showMenu, store, toast, toastError, toggle, user, volumeCurve, type MenuItem, type Live } from './util';
import { ICON } from './viewer';
import { ICON as CHAT_ICON, memberPicker, messageUser } from './chat';

const BASE = '/voice/'; // the microphone chain's files (build.mjs)
const RATE = 48000;

// (show and via: a player in game, in #voice-link: their Minecraft name and server tag; name is
// then the bridge's identity for them, which is also who their sound comes from.)
// (game: their Minecraft name, when show is the hub name it's linked to: on the hub, hub names.)
type Person = { name: string; since: string; show?: string; via?: string; game?: string };
// (link: #voice-link, always there; linked: the bridge to the game servers is in it.)
// (lock: #voice-link only, and only yours: you are locked in, see "the lock" below.)
// (handover: #voice-link only, and only yours: the hub just cut you from it because your player
// is going into the group in game.)
type VoiceChat = { id: string; private?: boolean; starter: string; invited?: string[]; people: Person[]; link?: boolean; linked?: boolean; lock?: boolean; handover?: boolean };
// (pttKey: KeyboardEvent.code, '' for none yet.) The rest of the microphone's are MicSettings.
type Settings = MicSettings & { mic: string; speaker: string; outVol: number; sfx: boolean; sfxVol: number; pttKey: string };

let info: { enabled: boolean; url: string; max: number; full: boolean; chats: VoiceChat[] } = { enabled: false, url: '', max: 3, full: false, chats: [] };
let cur: { id: string; room: LK.Room; chain: Chain; track: LK.LocalAudioTrack } | null = null;
let joining = '';
let speaking = new Set<string>();
let muted = false;
let deafened = false;
const audioBox = h('div', { hidden: true }); // remote voices' <audio> elements (not Web Audio, so echo cancelling can hear them)

const defaults: Settings = { ...DEFAULT_SETTINGS, mic: '', speaker: '', outVol: 100, sfx: true, sfxVol: 70, pttKey: '' };
let settings: Settings = { ...defaults, ...JSON.parse(load('mt-voice') ?? '{}') };
const saveSettings = () => store('mt-voice', JSON.stringify(settings));
// When the game's chain arrived, the old filter, gate, level and echo settings went, and
// everyone's microphone settings started again at the defaults; devices and volumes stayed.
if (load('mt-voice-svc') !== '1') {
  const { mic, speaker, outVol, sfx, sfxVol } = settings;
  settings = { ...defaults, mic, speaker, outVol, sfx, sfxVol };
  saveSettings();
  store('mt-voice-svc', '1');
}
const micSettings = (): MicSettings => {
  const { agc, gainDb, denoise, ptt, vad, thresholdDb, keyboardGate } = settings;
  return { agc, gainDb, denoise, ptt, vad, thresholdDb, keyboardGate };
};

// Every microphone chain running (a voice chat's, a mic test's) hears about settings and states.
const chains = new Set<Chain>();
const tell = (m: { settings?: MicSettings; muted?: boolean; pttDown?: boolean; testing?: boolean }) => {
  for (const c of chains) c.node.port.postMessage(m);
};

// Push to Talk: the key, while the hub's page has the keyboard (a browser sees no keys while
// you're in another window).
let pttDown = false;
const setPtt = (down: boolean) => {
  if (pttDown === down) return;
  pttDown = down;
  tell({ pttDown });
};
const pttKey = (e: KeyboardEvent, down: boolean) => {
  if (settings.ptt && settings.pttKey && e.code === settings.pttKey && !e.repeat) setPtt(down);
};
document.addEventListener('keydown', (e) => pttKey(e, true), true);
document.addEventListener('keyup', (e) => pttKey(e, false), true);
window.addEventListener('blur', () => setPtt(false));

// The speaker chosen in Voice Settings, for the voices, their boost, the voice chat sounds
// and the mic test. Browsers without setSinkId (Safari; Firefox for Web Audio) play them on
// the system's output.
type Sink = { setSinkId?: (id: string) => Promise<void> };
const canPickSpeaker = 'setSinkId' in HTMLMediaElement.prototype;
function toSpeaker(...targets: (object | null | undefined)[]) {
  for (const t of targets as (Sink | null | undefined)[]) void t?.setSinkId?.(settings.speaker).catch(() => {}); // (unplugged: it stays on the old one)
}

// ---- the list ---------------------------------------------------------------------------

let listSeq = 0;
async function loadVoice() {
  const mine = ++listSeq;
  const r = await req('GET', '/api/voice');
  if (!r.ok) return;
  const next = await r.json();
  if (mine !== listSeq) return; // a newer answer came first, or is coming
  info = next;
  // The server ended the voice chat we're in (it never noticed us, or we were removed).
  if (cur && !info.chats.some((c) => c.id === cur!.id) && !joining) void leave(false);
  lockStep();
  renderList();
  renderBar();
}

// renderList draws VOICE in the sidebar (its own section, always there on a hub with voice
// chats set up): each voice chat is its people, the first one with the speaker icon, the others
// under it.
function renderList() {
  const rows = voiceRows();
  $('voice-list').replaceChildren(...rows);
  $('voice-section').hidden = !info.enabled;
}

function voiceRows(): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const c of info.chats) {
    if (c.link) {
      rows.push(...linkRows(c));
      continue;
    }
    const people = c.people.map((p) => p.name);
    if (!people.length && !(cur?.id === c.id || joining === c.id)) continue; // started, nobody in yet
    if (!people.length) people.push(user.name);
    const here = cur?.id === c.id;
    people.forEach((name, i) => {
      const row = h('div', {
        class: 'row channel voice person' + (i ? ' voice-more' : '') + (here ? ' here' : '') + (speaking.has(name) ? ' speaking' : ''),
        title: here ? 'You’re in this voice chat' : 'Join this voice chat',
      },
      h('span', { class: 'hash', innerHTML: i ? '' : ICON.speaker }),
      h('span', { class: 'name' }, name),
      ...(i === 0 && c.private ? [h('span', { class: 'lock', title: 'Private voice chat', innerHTML: CHAT_ICON.lock })] : []));
      row.dataset.voice = c.id;
      row.dataset.who = name;
      row.onclick = () => void join(c.id);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        const items: MenuItem[] = [here ? ['Leave', () => void leave(true)] : ['Join', () => void join(c.id)]];
        if (c.private && c.starter === user.name) items.push(null, ['Invite People…', () => invite(c)]);
        if (name !== user.name) items.push(...personItems(c.id, name, here));
        showMenu(e, items);
      };
      rows.push(row);
    });
  }
  return rows;
}

// linkRows is #voice-link (docs/voice/svc/hub-link-spec.md): the one voice chat with a name,
// always listed. Under it, everyone in it: members, and the players in the group in game
// with their server's tag. They hear each other.
function linkRows(c: VoiceChat): HTMLElement[] {
  const here = cur?.id === c.id;
  // Your player in the group in game: you are in voice-link already, so there is nothing to
  // join here (the hub refuses it too), locked or not.
  const mine = myPlayer(c);
  const away = !!mine;
  const enter = away ? () => {} : () => void join(c.id);
  const menu = (e: MouseEvent, more: MenuItem[] = []) => {
    e.preventDefault();
    const items: MenuItem[] = away ? more.filter((m, i) => m || i) : [here ? ['Leave', () => void leave(true)] : ['Join', () => void join(c.id)], ...more];
    if (items.length) showMenu(e, items);
  };
  const head = h('div', { class: 'row channel voice link' + (here ? ' here' : ''), title: here ? 'You’re in this voice chat' : 'Join: the hub and the voice-link group in game hear each other' },
    h('span', { class: 'hash', innerHTML: CHAT_ICON.link }), h('span', { class: 'name' }, 'voice-link'));
  head.dataset.voice = c.id;
  head.onclick = enter;
  head.oncontextmenu = (e) => menu(e);
  const rows = [head];
  if (!c.linked) rows.push(h('div', { class: 'voice-note' }, 'Not connected to the game servers'));
  const people = [...c.people];
  if ((here || joining === c.id) && !people.some((p) => p.name === user.name)) people.push({ name: user.name, since: '' });
  for (const p of people) {
    const row = h('div', {
      class: 'row channel voice voice-more person in-link' + (here ? ' here' : '') + (speaking.has(p.name) ? ' speaking' : ''),
      title: p.via ? `${p.game ?? p.show} is in the voice-link group in game` : here ? 'You’re in this voice chat' : 'Join this voice chat',
    },
    h('span', { class: 'hash' }), h('span', { class: 'name' }, p.show ?? p.name),
    ...(p.via ? [h('span', { class: 'tag via' }, p.via)] : []));
    row.dataset.voice = c.id;
    row.dataset.who = p.name;
    row.onclick = enter;
    // Your own row (you here, or your player in game) has your lock, and nobody else's does.
    if (user.mc && (p.name === user.name || p === mine)) row.append(lockButton(c));
    // A player is not a hub account here: their volume for you, nothing else.
    row.oncontextmenu = (e) => menu(e, p.name === user.name ? [] : !p.via ? personItems(c.id, p.name, here)
      : here ? [null, volumeItem(p.name), [pref(p.name).muted ? 'Unmute' : 'Mute', () => setPref(p.name, { muted: !pref(p.name).muted })]] : []);
    rows.push(row);
  }
  return rows;
}

// personItems is what right-clicking someone else in a voice chat adds (Discord's): Message;
// in your voice chat, their User Volume and Mute (for you); for an admin, on someone below
// them, Mute for Everyone and Disconnect (it asks for a second click).
function personItems(id: string, name: string, here: boolean): MenuItem[] {
  const items: MenuItem[] = [null, ['Message', () => void messageUser(name)]];
  if (here) {
    const p = pref(name);
    items.push(null, volumeItem(name), [p.muted ? 'Unmute' : 'Mute', () => setPref(name, { muted: !p.muted })]);
  }
  const canModerate = user.owner || (user.admin && !isAdmin(name));
  if (canModerate) {
    const moderate = async (what: 'mute' | 'disconnect', done: string) => {
      const r = await req('POST', `/api/voice/${id}/${what}`, JSON.stringify({ name }));
      if (r.ok) toast(done, 3000);
      else toastError(`Couldn’t: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
    };
    items.push(null, ['Mute for Everyone', () => void moderate('mute', `Muted ${name} for everyone`)],
      ['Disconnect', () => void moderate('disconnect', `Disconnected ${name}`), undefined, undefined, { danger: true, confirm: 'Disconnect? Click again' }]);
  }
  return items;
}

// ---- each person's volume, for you -------------------------------------------------------
// Right-click someone in your voice chat: User Volume 0–200% and Mute, saved per browser by
// name and kept across calls. The slider is squared (50% is a quarter, about -12 dB; 200% is
// 4x, +12 dB), and Voice Settings' Output volume (squared too) multiplies it. Up to 100% their own <audio> plays them; above, the <audio> keeps playing at
// 0 (so the stream flows) and a Web Audio gain plays them louder. Echo cancelling can't
// hear that boosted part, which only matters on speakers.

type Pref = { vol: number; muted: boolean };
const prefs: Record<string, Partial<Pref>> = JSON.parse(load('mt-voice-people') ?? '{}');
const pref = (name: string): Pref => ({ vol: 100, muted: false, ...prefs[name] });
function setPref(name: string, change: Partial<Pref>) {
  prefs[name] = { ...pref(name), ...change };
  store('mt-voice-people', JSON.stringify(prefs));
  applyVolume(name);
}

type Player = { el: HTMLMediaElement; track: MediaStreamTrack; boost?: { src: MediaStreamAudioSourceNode; gain: GainNode } };
const players = new Map<string, Player>(); // by name, while in a voice chat
let boostCtx: AudioContext | null = null;
// (The browser tests read what's applied: each person's element volume and boost.)
(window as unknown as { __voiceLevels: () => object }).__voiceLevels = () =>
  Object.fromEntries([...players].map(([n, p]) => [n, { el: p.el.volume, muted: p.el.muted, boost: p.boost?.gain.gain.value ?? null }]));

function applyVolume(name: string) {
  const p = players.get(name);
  if (!p) return;
  const { vol, muted: off } = pref(name);
  const v = deafened || off ? 0 : (vol / 100) ** 2 * (settings.outVol / 100) ** 2;
  p.el.muted = deafened;
  if (v <= 1) {
    p.boost?.src.disconnect();
    p.boost = undefined;
    p.el.volume = v;
    return;
  }
  p.el.volume = 0;
  if (!boostCtx) toSpeaker(boostCtx = new AudioContext());
  void boostCtx.resume();
  if (!p.boost) {
    const src = boostCtx.createMediaStreamSource(new MediaStream([p.track]));
    const gain = boostCtx.createGain();
    src.connect(gain).connect(boostCtx.destination);
    p.boost = { src, gain };
  }
  p.boost.gain.gain.value = v;
}
const applyAll = () => players.forEach((_, name) => applyVolume(name));
function dropPlayer(name: string) {
  players.get(name)?.boost?.src.disconnect();
  players.delete(name);
}

// volumeItem is User Volume in the menu: a slider (a tick at 100%) and its readout.
function volumeItem(name: string) {
  const vol = h('input', { type: 'range', min: '0', max: '200', step: '5', value: String(pref(name).vol) });
  vol.setAttribute('aria-label', `${name}'s volume`);
  const out = h('span', { class: 'readout' }, `${vol.value}%`);
  vol.oninput = () => {
    out.textContent = `${vol.value}%`;
    setPref(name, { vol: Number(vol.value) });
  };
  const tick = h('span', { class: 'tick', title: 'Default (100%)' });
  tick.style.setProperty('--at', '.5');
  return h('div', { class: 'menu-volume' }, h('div', { class: 'label' }, 'User Volume'), h('div', { class: 'line' }, h('div', { class: 'slider' }, vol, tick), out));
}

// The entries of VOICE's "+" menu.
function voiceMenuItems(): MenuItem[] {
  if (!info.enabled) return [];
  const full = info.full ? `There are already ${info.max} voice chats.` : undefined;
  return [['New Voice Chat', () => void start(false, []), undefined, full],
    ['New Private Voice Chat…', () => startPrivate(), undefined, full]];
}

function startPrivate() {
  memberPicker({
    heading: 'New private voice chat', confirm: 'Start',
    note: 'Only the people you invite can see it, not even admins.',
    done: async (invite) => {
      void start(true, invite);
      return null;
    },
  });
}

function invite(c: VoiceChat) {
  memberPicker({
    heading: 'Invite to your voice chat', confirm: 'Invite', picked: (c.invited ?? []).filter((n) => n !== user.name),
    note: 'They’ll see it under VOICE and can join.',
    done: async (names) => {
      const r = await req('POST', `/api/voice/${c.id}/invite`, JSON.stringify({ invite: names }));
      return r.ok ? null : (await r.json().catch(() => ({}))).error ?? 'Couldn’t invite them';
    },
  });
}

// ---- joining and leaving ----------------------------------------------------------------

async function start(priv: boolean, invite: string[]) {
  const r = await req('POST', '/api/voice', JSON.stringify({ private: priv, invite }));
  const b = await r.json().catch(() => ({}));
  if (!r.ok) return toastError(b.error ?? 'Couldn’t start a voice chat.');
  await connect(b.id, b.url, b.token);
}

// join joins a voice chat. Joining #voice-link by hand turns the lock on (the hub does, once
// you're in); the page's own take-overs say lock false.
async function join(id: string, lock = true) {
  if (cur?.id === id || joining) return;
  const r = await req('POST', `/api/voice/${id}/join`, lock ? undefined : JSON.stringify({ lock: false }));
  const b = await r.json().catch(() => ({}));
  if (!r.ok) {
    toastError(b.error ?? 'Couldn’t join that voice chat.');
    return loadVoice();
  }
  await connect(id, b.url, b.token);
}

async function connect(id: string, url: string, token: string) {
  joining = id;
  renderList();
  if (cur) await leave(false, true);
  // LiveKit is its own file (livekit.ts), loaded on the first join, alongside the microphone.
  const lk = loadBundle<typeof LK>('livekit');
  let chain: Chain;
  try {
    chain = await buildChain(false, id === linkChat()?.id);
  } catch (e) {
    joining = '';
    renderList();
    return toastError(`Couldn’t use your microphone: ${(e as Error).message}`);
  }
  let Room, RoomEvent, Track, LocalAudioTrack, DisconnectReason;
  try {
    ({ Room, RoomEvent, Track, LocalAudioTrack, DisconnectReason } = await lk);
  } catch (e) {
    chain.stop();
    joining = '';
    renderList();
    return toastError(`Couldn’t join: ${(e as Error).message}`);
  }
  const room = new Room({ disconnectOnPageLeave: true, webAudioMix: false, adaptiveStream: false, dynacast: false });
  room.on(RoomEvent.TrackSubscribed, (track: LK.RemoteTrack, _pub: unknown, who: LK.RemoteParticipant) => {
    if (track.kind !== Track.Kind.Audio) return;
    // A reconnect stops the old tracks without unsubscribing them: drop their players.
    for (const a of audioBox.querySelectorAll('audio')) {
      if (!(a.srcObject as MediaStream | null)?.getAudioTracks().some((t) => t.readyState === 'live')) a.remove();
    }
    const el = track.attach();
    toSpeaker(el);
    audioBox.append(el);
    dropPlayer(who.identity);
    players.set(who.identity, { el, track: track.mediaStreamTrack });
    applyVolume(who.identity);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track: LK.RemoteTrack, _pub: unknown, who: LK.RemoteParticipant) => {
    track.detach().forEach((el) => el.remove());
    dropPlayer(who.identity);
  });
  // An admin muted you for everyone: show it, and you can unmute when ready.
  room.on(RoomEvent.TrackMuted, (_pub: unknown, who: LK.Participant) => {
    if (who !== room.localParticipant || muted) return; // (your own mute sets muted first)
    muted = true;
    renderBar();
    sfx('mute');
    toast('An admin muted you for everyone. Unmute when you’re ready.', 6000);
  });
  room.on(RoomEvent.ParticipantConnected, () => sfx('otherJoin'));
  room.on(RoomEvent.ParticipantDisconnected, () => sfx('otherLeave'));
  room.on(RoomEvent.ActiveSpeakersChanged, (who) => {
    speaking = new Set(who.map((p) => p.identity));
    markSpeaking();
  });
  room.on(RoomEvent.Disconnected, (reason?: LK.DisconnectReason) => {
    if (cur?.room !== room) return;
    // A page closed or reloaded hasn't left: the lock stays. (LiveKit's hang-up for it can come
    // after the page is known to be staying, a cancelled close: then it rejoins, see pageStays.)
    if (pageGoing || Date.now() - goingAt < 15000) {
      droppedGoing = id;
      void leave(false, true);
      if (!pageGoing) pageStays();
      return;
    }
    if (reason === DisconnectReason.DUPLICATE_IDENTITY) { // you joined from another tab or device: not Leave
      toast('You joined this voice chat somewhere else.', 6000);
      return void leave(false);
    }
    if (reason === DisconnectReason.PARTICIPANT_REMOVED) return void removed(id);
    toastError('Voice chat disconnected.');
    void leave(true);
  });
  // Sound blocked (Chromium, no click on the page since it loaded): the bar says so.
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => renderBar());
  try {
    await room.connect(url, token);
    const track = new LocalAudioTrack(chain.out, undefined, true);
    // 51 kbit/s: what Opus picks by itself for 20 ms mono at 48 kHz, as in Simple Voice Chat.
    await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: true, red: true, forceStereo: false, audioPreset: { maxBitrate: 51000 } });
    cur = { id, room, chain, track };
    joinedAt = Date.now();
    setTimeout(renderBar, BLOCKED_AFTER + 100);
    barNote = '';
    if (muted) await track.mute();
    // A page that hasn't had a click since it loaded (a take-over after a reload) may not play
    // or record in Chromium: try, without waiting (unanswered, resume() can stay pending).
    void chain.ctx.resume().catch(() => {});
    void room.startAudio().catch(() => {});
  } catch (e) {
    chain.stop();
    room.disconnect();
    joining = '';
    renderList();
    return toastError(`Couldn’t connect to the voice chat: ${(e as Error).message}`);
  }
  joining = '';
  sfx('join');
  await loadVoice();
}

// removed: LiveKit took this page out of a voice chat. In #voice-link that is usually the hub
// handing you over to the game (voice_lock.go: your player is going into the group in game):
// hang up quietly, without telling the hub (that would take your lock off), keeping the held
// microphone. Otherwise an admin disconnected you.
async function removed(id: string) {
  const r = id === linkChat()?.id ? await req('GET', '/api/voice') : null;
  const c = r?.ok ? ((await r.json()) as typeof info).chats.find((x) => x.id === id) : undefined;
  if (!c?.handover) {
    toast('An admin disconnected you from the voice chat.', 6000);
    return void leave(true);
  }
  await leave(false, true);
  handedOver(!!c.lock);
  await loadVoice();
}

// leave hangs up; tell says the hub should hear of it now (not just from LiveKit), and quiet
// skips the sound (moving to another voice chat plays that one's join sound instead).
async function leave(tell: boolean, quiet = false) {
  const c = cur;
  if (!c) return;
  cur = null;
  if (!quiet) sfx('leave');
  speaking = new Set();
  c.chain.stop();
  await c.room.disconnect();
  for (const name of [...players.keys()]) dropPlayer(name);
  audioBox.replaceChildren();
  if (tell) await req('POST', `/api/voice/${c.id}/leave`);
  renderList();
  renderBar();
}

// ---- the lock ------------------------------------------------------------------------------
// docs/voice/svc/lock-spec.md. Locked in #voice-link, you stay in voice-link between the hub and
// the game: when your player (your Minecraft name) appears in the group in game, this page
// hangs up without telling the hub; when it goes again, this page joins by itself. The hub
// keeps the lock; the game servers put a locked player in the group when they arrive.
//
// Firefox opens no new microphone for a page you aren't looking at (you're in the game), but
// one the page already holds comes back: so while you are locked the page holds it, disabled
// when it isn't in use, from the click on the lock (or as soon as a reloaded page may).

let held: MediaStreamTrack | null = null;
let heldInUse = false; // #voice-link's chain (in the call, or joining) is using the held microphone
let holdFailed = false; // the last request for it was refused: asked again only on a click or a look
let pageGoing = false;
let droppedGoing = ''; // the voice chat LiveKit hung up on while the page seemed to be going
// (LiveKit hangs up on both, beforeunload first; ours were added before its own, so run first.)
// If the page stays after all (a cancelled beforeunload: unsaved work), the first input or
// focus after it, or 10 s, says so: see pageStays.
let goingTimer = 0;
let goingAt = 0;
for (const e of ['beforeunload', 'pagehide']) window.addEventListener(e, () => {
  pageGoing = true;
  goingAt = Date.now();
  clearTimeout(goingTimer);
  goingTimer = window.setTimeout(pageStays, 10000);
});
for (const e of ['pointerdown', 'keydown']) document.addEventListener(e, () => pageGoing && pageStays(), true);
window.addEventListener('focus', () => pageGoing && pageStays());
function pageStays() {
  clearTimeout(goingTimer);
  pageGoing = false;
  const id = droppedGoing;
  if (!id) return;
  droppedGoing = '';
  if (!id || cur || joining) return;
  const c = linkChat();
  if (c?.lock && c.id === id && held?.readyState === 'live') void takeOver(id);
  else toastError('You were disconnected from the voice chat.');
}
// A page you look at again may ask for the microphone again (after a refusal, or one it never
// asked for because it was in the background). Visible is enough: Firefox itself holds a
// request from a tab in a window without focus until you look at it, and document.hasFocus()
// is false whenever the browser's own toolbar has the keyboard (its reload button, say).
const looking = () => document.visibilityState === 'visible';
const lookedAgain = () => {
  if (!looking()) return;
  holdFailed = false;
  lockStep();
  renderList();
};
document.addEventListener('visibilitychange', lookedAgain);
window.addEventListener('focus', lookedAgain);
let asking = false;
let sawMeInGame = false; // this page has seen your player in game (and so may take over when it goes)

const linkChat = () => info.chats.find((c) => c.link);
const myPlayer = (c: VoiceChat) => (user.mc ? c.people.find((p) => p.via && (p.game ?? p.show)?.toLowerCase() === user.mc!.toLowerCase()) : undefined);

// lockStep acts on each new list: hold or let go of the microphone, step back when your player
// appears in game, take over when it goes.
function lockStep() {
  const c = linkChat();
  if (held?.readyState === 'ended') dropHeld(); // (unplugged)
  if (!c?.lock && held) dropHeld(); // (in use: #voice-link's chain has it, and ends it when it ends)
  if (!c?.lock && barNote) {
    barNote = '';
    renderBar();
  }
  if (!c) return;
  // By itself only on a page in view (Firefox would hold the request till you look anyway),
  // not after a refusal, and not while joining.
  if (c.lock && !held && !asking && !holdFailed && !joining && cur?.id !== c.id && looking()) void holdMic(false);
  // Not connected to the game servers: players vanish because the bridge or relay went, not
  // because you left the game. Forget having seen yours; no step back, no take-over.
  if (!c.linked) {
    sawMeInGame = false;
    return;
  }
  // Locked while in the call (a click, or joining by hand): the lock holds the call's microphone.
  if (c.lock && cur?.id === c.id && !held) setHeld(cur.chain.mic, true);
  if (myPlayer(c)) {
    sawMeInGame = true;
    clearTimeout(handoverTimer);
    if (c.lock && cur?.id === c.id) void leave(false, true); // the chain's stop keeps the held microphone
  } else if (sawMeInGame) {
    sawMeInGame = false;
    if (c.lock && !cur && !joining) {
      if (heldLive()) void takeOver(c.id);
      else cantRejoin();
    }
  }
}

// dropHeld lets the held microphone go: stopped, unless #voice-link's chain is using it (it
// stops it when it ends, now that it isn't held).
function dropHeld() {
  if (held && !heldInUse) held.stop();
  held = null;
  heldInUse = false;
}

// setHeld keeps a microphone for the lock; it going quiet or ending shows on the lock (red).
function setHeld(t: MediaStreamTrack, inUse: boolean) {
  held = t;
  heldInUse = inUse;
  holdFailed = false;
  t.addEventListener('mute', () => renderList());
  t.addEventListener('unmute', () => renderList());
  t.addEventListener('ended', () => {
    if (held === t && !heldInUse) held = null;
    renderList();
  });
}
const heldLive = () => held?.readyState === 'live' && !held.muted;

// cantRejoin: the take-over couldn't run, the microphone gone (refused, unplugged).
let barNote = '';
function cantRejoin() {
  barNote = 'Couldn’t rejoin voice-link: microphone unavailable';
  renderBar();
}

// handedOver: the hub cut this page for the game. Locked, the page waits for your player in
// game, as when it steps back; if your player hasn't come within handoverWait (the put
// failed, the game didn't get that far), it takes over once and the lock goes off, so a put
// that keeps failing can't send you back and forth. Not locked (you joined the group by hand
// in game): it says where you are.
const handoverWait = (window as unknown as { __handoverWait?: number }).__handoverWait ?? 15000;
let handoverTimer = 0;
function handedOver(locked: boolean) {
  clearTimeout(handoverTimer);
  if (!locked) return toast('You’re in voice-link in Minecraft.', 6000);
  handoverTimer = window.setTimeout(() => void handoverFallback(), handoverWait);
}
async function handoverFallback() {
  const c = linkChat();
  if (!c?.lock || cur || joining || sawMeInGame || myPlayer(c)) return;
  if (!heldLive()) return cantRejoin();
  await takeOver(c.id);
  if ((cur as { id: string } | null)?.id === c.id) { // (joined: cur was set meanwhile)
    await req('POST', `/api/voice/${c.id}/lock`, JSON.stringify({ on: false }));
    await loadVoice();
  }
}

// takeOver joins #voice-link on the held microphone, in one tab only: two hub tabs both see the
// player go, and the account can be in the room once.
async function takeOver(id: string) {
  const go = async () => {
    if (cur || joining) return;
    if (!heldLive()) return cantRejoin();
    const r = await req('GET', '/api/voice');
    const now = r.ok ? ((await r.json()) as typeof info).chats.find((c) => c.id === id) : undefined;
    if (!now?.lock || now.people.some((p) => p.name === user.name)) return; // the other tab did, or the lock went
    await join(id, false);
  };
  if (navigator.locks) await navigator.locks.request('mthub-voice-take-over', { ifAvailable: true }, async (l) => (l ? go() : undefined));
  else await go();
}

// holdMic asks for the microphone to hold, disabled. From a click (the lock), or by itself on a
// page loaded while you are locked: answered at once with a remembered Allow if the page is in
// front, else when you look at it.
async function holdMic(fromClick: boolean): Promise<boolean> {
  if (asking) return false;
  asking = true;
  try {
    const t = (await navigator.mediaDevices.getUserMedia(micConstraints())).getAudioTracks()[0];
    if (held && held !== t && !heldInUse) held.stop();
    t.enabled = false;
    setHeld(t, false);
    return true;
  } catch (e) {
    holdFailed = true;
    if (fromClick) toastError(`Couldn’t use your microphone: ${(e as Error).message}`);
    return false;
  } finally {
    asking = false;
    renderList();
  }
}

function lockButton(c: VoiceChat): HTMLElement {
  const lost = !!c.lock && !heldLive() && cur?.id !== c.id && joining !== c.id;
  const title = !c.lock ? 'Stay in voice-link when you leave the game'
    : lost ? 'Click here to stay in voice-link when you leave the game'
      : 'Staying in voice-link when you leave the game. Click to stop';
  const b = h('button', { type: 'button', class: 'voice-lock' + (c.lock ? ' on' : '') + (lost ? ' lost' : ''), title, innerHTML: c.lock ? CHAT_ICON.lock : CHAT_ICON.lockOpen });
  b.setAttribute('aria-label', title);
  b.onclick = (e) => {
    e.stopPropagation();
    void clickLock(c, lost);
  };
  return b;
}

async function clickLock(c: VoiceChat, lost: boolean) {
  if (lost) {
    await holdMic(true);
    return;
  }
  const on = !c.lock;
  let asked = false;
  if (on && cur?.id === c.id) setHeld(cur.chain.mic, true);
  else if (on && !held) {
    if (!(await holdMic(true))) return;
    asked = true;
  }
  const r = await req('POST', `/api/voice/${c.id}/lock`, JSON.stringify({ on }));
  if (!r.ok) {
    if (asked) held?.stop();
    if (on) {
      held = null;
      heldInUse = false;
    }
    toastError((await r.json().catch(() => ({}))).error ?? 'Couldn’t change the lock.');
    return renderList();
  }
  await loadVoice();
}

// markSpeaking lights up the names of whoever is talking, without redrawing the list.
function markSpeaking() {
  for (const row of document.querySelectorAll<HTMLElement>('#voice-list .row.voice')) {
    row.classList.toggle('speaking', speaking.has(row.dataset.who ?? ''));
  }
}

// ---- the bar at the bottom of the sidebar ------------------------------------------------

const bar = h('div', { id: 'voice-bar', hidden: true });
let joinedAt = 0;
const BLOCKED_AFTER = 1000; // ms

function renderBar() {
  footBar(bar, !!cur || !!barNote);
  if (!cur) {
    // Not in a call, with something to say (a take-over that couldn't run): a click clears it.
    if (barNote) {
      const note = h('div', { class: 'voice-where', title: 'Click to dismiss' }, h('span', { class: 'voice-bad' }, barNote));
      note.onclick = () => {
        barNote = '';
        renderBar();
      };
      bar.replaceChildren(note);
    }
    return;
  }
  const c = info.chats.find((x) => x.id === cur!.id);
  // Chromium: no click on this page since it loaded (a take-over after a reload), so it plays
  // nothing and sends silence until one. A click anywhere fixes it (unblock, below). (Only
  // once it is still so a moment after joining: a new context says "suspended" for a moment
  // before it starts, Firefox's on every join.)
  const blocked = (cur.chain.ctx.state !== 'running' || !cur.room.canPlaybackAudio) && Date.now() - joinedAt >= BLOCKED_AFTER;
  const top = c?.link ? 'voice-link' : c?.people[0]?.name ?? user.name;
  const btn = (title: string, icon: string, on: () => void, cls = '') => {
    const b = h('button', { class: 'tool ' + cls, title, innerHTML: icon });
    b.onclick = on;
    return b;
  };
  bar.replaceChildren(
    h('div', { class: 'voice-where' }, blocked ? h('span', { class: 'voice-blocked' }, 'Click to turn on sound and your mic') : h('span', { class: 'voice-ok' }, 'Voice connected'),
      h('span', { class: 'muted' }, top + (c?.private ? ' (private)' : ''))),
    h('div', { class: 'voice-buttons' },
      btn(muted ? 'Unmute' : 'Mute', muted ? ICON.micOff : ICON.mic, () => void setMuted(!muted), muted ? 'off' : ''),
      btn(deafened ? 'Undeafen' : 'Deafen', deafened ? ICON.headphonesOff : ICON.headphones, () => void setDeafened(!deafened), deafened ? 'off' : ''),
      btn('Voice settings', ICON.settings, openSettings),
      btn('Leave the voice chat', ICON.hangUp, () => void leave(true), 'danger')));
}

// unblock: the first click or key on a page whose sound was blocked starts it (a click is what
// Chromium waits for), the microphone's chain included.
function unblock() {
  if (!cur || (cur.chain.ctx.state === 'running' && cur.room.canPlaybackAudio)) return;
  void cur.chain.ctx.resume().catch(() => {});
  void cur.room.startAudio().catch(() => {});
  void sfxCtx?.resume().catch(() => {});
  void boostCtx?.resume().catch(() => {});
}
for (const e of ['pointerdown', 'keydown']) document.addEventListener(e, unblock, true);

let mutedBeforeDeafen = false;
async function setMuted(m: boolean, quiet = false) {
  if (!quiet && m !== muted) sfx(m ? 'mute' : 'unmute');
  muted = m;
  tell({ muted });
  if (!m && deafened) {
    deafened = false;
    applyAll();
  }
  if (cur) await (m ? cur.track.mute() : cur.track.unmute());
  renderBar();
}

// Deafen silences everyone else and mutes you too, as on Discord.
async function setDeafened(d: boolean) {
  sfx(d ? 'deafen' : 'undeafen');
  deafened = d;
  applyAll();
  if (d) {
    mutedBeforeDeafen = muted;
    await setMuted(true, true);
    deafened = true;
  } else await setMuted(mutedBeforeDeafen, true);
  renderBar();
}

// ---- sound effects ----------------------------------------------------------------------

// Short soft plucks made here (no sound files): two notes each, rising when you or someone
// joins, falling when they leave (someone else's quieter and a little higher), a lower pair
// for mute and unmute, and a deeper one for deafen. Only you hear them; Sound Settings has
// their switch and volume (voiceSounds). Chosen by ear on a wireless headset: pure tones and sliding pitches
// came through it buzzing, these plucks clean.
type Sfx = 'join' | 'leave' | 'otherJoin' | 'otherLeave' | 'mute' | 'unmute' | 'deafen' | 'undeafen';
// [first note Hz, second note Hz, when the second starts (s), loudness]
const SFX: Record<Sfx, [number, number, number, number]> = {
  join: [523, 784, 0.11, 0.072],
  leave: [784, 523, 0.11, 0.072],
  otherJoin: [587, 880, 0.1, 0.045],
  otherLeave: [880, 587, 0.1, 0.045],
  mute: [440, 330, 0.08, 0.063],
  unmute: [330, 440, 0.08, 0.063],
  deafen: [294, 220, 0.1, 0.081],
  undeafen: [220, 294, 0.1, 0.081],
};
let sfxCtx: AudioContext | null = null;
// The sounds played, newest last (the browser tests read it; nothing else does).
const sfxLog: Sfx[] = [];
(window as unknown as { __sfx: Sfx[] }).__sfx = sfxLog;
function sfx(name: Sfx, test = false) {
  if (!settings.sfx && !test) return;
  sfxLog.push(name);
  if (sfxLog.length > 20) sfxLog.shift();
  if (!sfxCtx) toSpeaker(sfxCtx = new AudioContext());
  const ctx = sfxCtx;
  void ctx.resume();
  const [first, second, at, loud] = SFX[name];
  // The loudness above is at Sound Settings' default of 70% (0.343 on the cubic curve).
  const gain = (loud / volumeCurve(70)) * volumeCurve(settings.sfxVol);
  const t0 = ctx.currentTime + 0.01;
  for (const [freq, start] of [[first, t0], [second, t0 + at]]) {
    // A pluck: a 4 ms start, then a quick die-away; a quiet 4th harmonic makes it wooden.
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.004);
    env.gain.setTargetAtTime(0, start + 0.004, 1 / 18);
    env.connect(ctx.destination);
    for (const [mult, level] of [[1, 1], [4, 0.15]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = freq * mult;
      g.gain.value = level;
      osc.connect(g).connect(env);
      osc.start(start);
      osc.stop(start + 0.3);
    }
  }
}

// voiceSounds is the voice chat sounds' part of Sound Settings (sounds.ts).
export const voiceSounds = {
  get: () => ({ on: settings.sfx, volume: settings.sfxVol }),
  set: (on: boolean, volume: number) => {
    settings.sfx = on;
    settings.sfxVol = volume;
    saveSettings();
  },
  test: () => sfx('join', true),
};

// ---- the microphone chain -------------------------------------------------------------

type Chain = { mic: MediaStreamTrack; out: MediaStreamTrack; ctx: AudioContext; node: AudioWorkletNode; meter: (fn: ((peak: number) => void) | null) => void; stop: () => void };

// The chain's wasm (svc-mic.wasm: RNNoise, Speex, Silero) loads once, on first use.
let wasmLoaded: Promise<ArrayBuffer> | null = null;
const loadWasm = () => (wasmLoaded ??= (async () => {
  const r = await fetch(BASE + 'svc-mic.wasm');
  if (!r.ok) throw new Error(`svc-mic.wasm: HTTP ${r.status}`);
  return r.arrayBuffer();
})().catch((e) => {
  wasmLoaded = null;
  throw e;
}));

// Raw, as Simple Voice Chat reads a microphone: the browser's own processing is all off.
const micConstraints = () => ({
  audio: { ...(settings.mic ? { deviceId: { exact: settings.mic } } : {}), channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
});

// buildChain is the microphone's way out: the game's chain in a worklet (svcmic.worklet.ts).
// For #voice-link (forLink) it runs on the held microphone when there is one (the lock),
// unless fresh (a new microphone), and one it asks for while you are locked becomes the held
// one. Any other voice chat, and the Mic test, get a microphone of their own. Stopping it lets
// a held microphone go quiet (disabled) instead of ending it.
async function buildChain(fresh = false, forLink = false): Promise<Chain> {
  const wasm = await loadWasm();
  let track: MediaStreamTrack;
  if (forLink && !fresh && held?.readyState === 'live') {
    track = held;
    track.enabled = true;
    heldInUse = true;
  } else {
    track = (await navigator.mediaDevices.getUserMedia(micConstraints())).getAudioTracks()[0];
    if (forLink && linkChat()?.lock) {
      if (held && !heldInUse) held.stop();
      setHeld(track, true);
    }
  }
  const mic = new MediaStream([track]);
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  ctx.onstatechange = () => renderBar();
  let chain: Chain | undefined;
  const stopAll = () => {
    if (chain) chains.delete(chain);
    if (track === held) {
      track.enabled = false;
      heldInUse = false;
    } else track.stop();
    void ctx.close();
  };
  try {
    await ctx.audioWorklet.addModule(BASE + 'svc-mic.worklet.js');
    const src = ctx.createMediaStreamSource(mic);
    const node = new AudioWorkletNode(ctx, 'svc-mic', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { wasm, settings: micSettings() },
    });
    node.onprocessorerror = () => toastError('Your microphone stopped in the hub. Reload the page to get it back.');
    node.port.postMessage({ muted, pttDown });
    // One channel from the start. (Made with two and set to one afterwards, its track now and
    // then still said two when it was published, and the voice went out as stereo Opus: seen
    // once in 38 runs of a lab that checks every packet.)
    const out = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
    src.connect(node).connect(out);
    const outTrack = out.stream.getAudioTracks()[0];
    outTrack.contentHint = 'speech';
    let onLevel: ((peak: number) => void) | null = null;
    // (The level is also left where the browser tests read it: what the chain lets out.)
    node.port.onmessage = (e) => {
      (window as unknown as { __micPeak: number }).__micPeak = e.data as number;
      onLevel?.(e.data as number);
    };
    chain = { mic: track, out: outTrack, ctx, node, meter: (fn) => (onLevel = fn), stop: stopAll };
    chains.add(chain);
    return chain;
  } catch (e) {
    stopAll();
    throw e;
  }
}

// ---- settings ---------------------------------------------------------------------------

// A setting moved off its default in a way that makes you sound worse to others is shown in red
// with a line saying why, as Simple Voice Chat does (Paul; style guide 3.3).
const GAIN_WARN = 10; // dB of Microphone Gain
const THRESHOLD_WARN = -10; // dB of Voice Activation Threshold

export async function openSettings() {
  // Before the page may use a microphone, browsers list devices without ids or names (and
  // Firefox no speakers). Then it asks for the microphone once, lets it go at once, and
  // lists again; refused, only Default is offered.
  const list = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.deviceId && d.deviceId !== 'default');
  let all = await list();
  if (!all.some((d) => d.kind === 'audioinput')) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      all = await list();
    } catch { /* refused or no microphone: Default only */ }
  }
  const pick = (kind: MediaDeviceKind, chosen: string, unnamed: string) => h('select', {}, h('option', { value: '' }, 'Default'),
    ...all.filter((d) => d.kind === kind).map((d) => h('option', { value: d.deviceId, selected: d.deviceId === chosen }, d.label.trim() || unnamed)));
  const choice = <T extends string>(now: T, opts: [T, string][]) =>
    h('select', {}, ...opts.map(([v, l]) => h('option', { value: v, selected: v === now }, l))) as HTMLSelectElement;
  const mic = pick('audioinput', settings.mic, 'Microphone');
  const speaker = pick('audiooutput', settings.speaker, 'Speaker');
  speaker.onchange = () => {
    settings.speaker = speaker.value;
    saveSettings();
    toSpeaker(...[...players.values()].map((p) => p.el), boostCtx, sfxCtx, test?.el);
  };
  // Output volume: everyone's voices, 0–200% squared like User Volume (a tick at 100%).
  const outVol = h('input', { type: 'range', min: '0', max: '200', step: '5', value: String(settings.outVol) });
  outVol.setAttribute('aria-label', 'Output volume');
  const outVal = readout();
  const showOut = () => (outVal.textContent = `${outVol.value}%`);
  showOut();
  outVol.oninput = () => {
    settings.outVol = Number(outVol.value);
    showOut();
    applyAll();
    saveSettings();
  };
  const outTick = h('span', { class: 'tick', title: 'Default (100%)' });
  outTick.style.setProperty('--at', '.5');
  const meter = h('div', { class: 'voice-meter' }, h('div', {}));

  // The microphone's settings apply at once, to every chain running.
  const changed = () => {
    saveSettings();
    tell({ settings: micSettings() });
    show();
  };
  const gain = choice(settings.agc ? 'auto' : 'manual', [['auto', 'Auto'], ['manual', 'Manual']]);
  gain.onchange = () => {
    settings.agc = gain.value === 'auto';
    changed();
  };
  const gainDb = h('input', { type: 'range', min: '-40', max: '24', step: '1', value: String(settings.gainDb) });
  gainDb.setAttribute('aria-label', 'Microphone gain');
  const gainVal = readout();
  gainDb.oninput = () => {
    settings.gainDb = Number(gainDb.value);
    changed();
  };
  const denoise = toggle(settings.denoise, 'Noise suppression', (on) => {
    settings.denoise = on;
    changed();
  });
  const method = choice(settings.ptt ? 'ptt' : 'voice', [['voice', 'Voice'], ['ptt', 'Push to Talk']]);
  // A new Activation method starts the chain afresh, as Simple Voice Chat makes a new
  // microphone processor for it (no tail carried over, the gain from its start).
  method.onchange = () => {
    settings.ptt = method.value === 'ptt';
    setPtt(false);
    changed();
    void rebuild();
    if (settings.ptt && !settings.pttKey) listenForKey();
  };
  const keyBtn = h('button', { type: 'button' }) as HTMLButtonElement;
  let listening = false;
  const keyName = (code: string) => code.replace(/^Key|^Digit/, '').replace(/^Arrow/, '') || code;
  const listenForKey = () => {
    listening = true;
    keyBtn.textContent = 'Press a key…';
    keyBtn.focus();
  };
  keyBtn.onclick = () => listenForKey();
  keyBtn.onkeydown = (e) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    listening = false;
    if (e.code !== 'Escape') settings.pttKey = e.code;
    changed();
  };
  keyBtn.onblur = () => {
    if (!listening) return;
    listening = false;
    show();
  };
  const vad = choice(settings.vad ? 'auto' : 'manual', [['auto', 'Auto'], ['manual', 'Manual']]);
  vad.onchange = () => {
    settings.vad = vad.value === 'auto';
    changed();
  };
  const threshold = h('input', { type: 'range', min: '-127', max: '0', step: '1', value: String(settings.thresholdDb) });
  threshold.setAttribute('aria-label', 'Voice activation threshold');
  const thresholdVal = readout();
  threshold.oninput = () => {
    settings.thresholdDb = Number(threshold.value);
    changed();
  };
  const keyboardGate = toggle(settings.keyboardGate, 'Keyboard noise gate', (on) => {
    settings.keyboardGate = on;
    changed();
  });

  const gainRow = row('Gain', null, [gain]);
  const gainDbRow = row('Microphone gain', null, [gainDb, gainVal]);
  const keyRow = row('Push to Talk key', 'Only while the hub is in front.', [keyBtn]);
  const vadRow = row('Voice activation', null, [vad]);
  const thresholdRow = row('Voice activation threshold', null, [threshold, thresholdVal]);
  const gateRow = row('Keyboard noise gate', 'Keeps typing and mouse clicks from opening your microphone. Others hear you 60 ms later.', [keyboardGate]);
  // warn marks a row's title red and slides the reason open under it (or shuts it, and takes
  // the red away).
  const warn = (r: HTMLElement, why: string | null, animate: boolean) => {
    r.querySelector('.set-title')!.classList.toggle('off-default', !!why);
    let sub = r.querySelector<HTMLElement>('.set-warn');
    if (!sub) {
      sub = h('div', { class: 'set-sub set-warn', hidden: true });
      r.querySelector('.set-text')!.append(sub);
    }
    if (why) sub.textContent = why;
    reveal(sub, !!why, { animate });
  };
  // show draws the rows for the settings as they are now; a change in the dialog slides rows
  // open and shut (style guide 5, Motion), the first drawing doesn't.
  const show = (animate = true) => {
    const s = settings;
    const slide = (r: HTMLElement, on: boolean) => reveal(r, on, { animate });
    warn(gainRow, s.agc ? null : 'Leave this on Auto so everyone hears you at a steady level.', animate);
    slide(gainDbRow, !s.agc);
    gainVal.textContent = `${s.gainDb > 0 ? '+' : ''}${s.gainDb} dB`;
    gainVal.classList.toggle('off-default', s.gainDb > GAIN_WARN);
    warn(gainDbRow, s.gainDb > GAIN_WARN ? `More than +${GAIN_WARN} dB can distort your voice.` : null, animate);
    slide(keyRow, s.ptt);
    if (!listening) keyBtn.textContent = s.pttKey ? keyName(s.pttKey) : 'Set a key';
    slide(vadRow, !s.ptt);
    slide(thresholdRow, !s.ptt && !s.vad);
    thresholdVal.textContent = `${s.thresholdDb} dB`;
    thresholdVal.classList.toggle('off-default', s.thresholdDb >= THRESHOLD_WARN);
    warn(thresholdRow, s.thresholdDb >= 0 ? 'At 0 dB your microphone never opens.' : null, animate);
    thresholdRow.querySelector('.set-title')!.classList.toggle('off-default', s.thresholdDb >= THRESHOLD_WARN);
    slide(gateRow, !s.ptt);
  };
  show(false);

  // Mic test: hear yourself as the others would, after the whole chain (in a voice chat: your
  // live microphone; otherwise one built just for the test). Push to Talk sends without the key
  // while it runs, as in the game.
  let test: { chain: Chain; own: boolean; el: HTMLAudioElement } | null = null;
  const testBtn = h('button', { type: 'button', class: 'mic-test' }, 'Test');
  const stopTest = () => {
    if (!test) return;
    test.el.pause();
    test.el.srcObject = null;
    if (test.own) test.chain.stop();
    else test.chain.meter(null);
    test.chain.node.port.postMessage({ testing: false });
    test = null;
    testBtn.textContent = 'Test';
    (meter.firstElementChild as HTMLElement).style.width = '0';
  };
  const startTest = async () => {
    testBtn.disabled = true;
    try {
      const own = !cur;
      const chain = cur ? cur.chain : await buildChain();
      chain.node.port.postMessage({ testing: true });
      const el = new Audio();
      toSpeaker(el);
      el.srcObject = new MediaStream([chain.out]);
      await el.play();
      test = { chain, own, el };
      chain.meter(setMeter);
      testBtn.textContent = 'Stop test';
    } catch (e) {
      toastError(`Couldn’t start the mic test: ${(e as Error).message}`);
    } finally {
      testBtn.disabled = false;
    }
  };
  testBtn.onclick = () => (test ? stopTest() : void startTest());
  // A new microphone, or Activation method, needs the chain built again.
  const rebuild = async () => {
    saveSettings();
    // Stepped back for the game, locked: hold a microphone on the new settings (the dialog is
    // in front, so Firefox gives it).
    if (!cur && held && !heldInUse && linkChat()?.lock) void holdMic(true);
    if (test?.own) {
      stopTest();
      await startTest();
      return;
    }
    if (!cur) return;
    try {
      const chain = await buildChain(true, cur.id === linkChat()?.id);
      await cur.track.replaceTrack(chain.out, true);
      cur.chain.stop();
      cur.chain = chain;
      chain.meter(setMeter);
      if (test) {
        test.chain = chain;
        chain.node.port.postMessage({ testing: true });
        test.el.srcObject = new MediaStream([chain.out]);
        void test.el.play();
      }
    } catch (e) {
      toastError(`Couldn’t switch: ${(e as Error).message}`);
    }
  };
  mic.onchange = () => {
    settings.mic = mic.value;
    void rebuild();
  };
  const setMeter = (peak: number) => ((meter.firstElementChild as HTMLElement).style.width = `${Math.min(100, Math.sqrt(peak) * 100)}%`);
  cur?.chain.meter(setMeter);
  settingsDialog('Voice settings', [
    group('Input',
      row('Microphone', null, [mic]),
      gainRow,
      gainDbRow,
      row('Noise suppression', null, [denoise]),
      row('Mic test', 'Hear yourself as others will. Use headphones.', [testBtn], meter)),
    group('Activation',
      row('Activation method', null, [method]),
      keyRow,
      vadRow,
      thresholdRow,
      gateRow),
    group('Output',
      ...(canPickSpeaker ? [row('Speaker', null, [speaker])] : []),
      row('Output volume', 'Everyone’s voices. Each person’s own volume is in their right-click menu.', [h('div', { class: 'slider' }, outVol, outTick), outVal])),
  ], () => {
    stopTest();
    cur?.chain.meter(null);
  });
}

// ---- setup ------------------------------------------------------------------------------

export function setupVoice(events: Live) {
  document.body.append(audioBox);
  $('side-foot').prepend(bar);
  $('new-voice').onclick = (e) => showMenu(e, voiceMenuItems(), $('new-voice'));
  events.addEventListener('voice', () => void loadVoice());
  events.addEventListener('open', () => void loadVoice());
  void loadVoice();
}
