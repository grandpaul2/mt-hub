// Voice chats (agreed design: docs/voice/rooms-design.md).
//
// No permanent rooms: VOICE's "+" starts a voice chat (or a private one, for the people you
// invite), others click it to join, and it ends when the last person leaves. A voice chat has
// no name: it's shown under VOICE (always in the sidebar where voice chats are set up) as the
// people in it, in the order they joined. You're in one at
// a time; the bar at the bottom of the sidebar has mute, deafen, settings and leave.
//
// The hub keeps the list and hands out tokens (internal/server/voice.go); the audio goes
// through LiveKit on the relay VPS. Your microphone goes through the chain chosen in the voice
// lab, all in this page:
//   mic (the browser's automatic gain on, so a quiet microphone reaches the filter and the
//   gate at a level they work at; its echo cancelling and noise suppression off: Firefox's
//   echo cancelling chops up voices on headphones)
//   -> level (quiet mics) -> DeepFilterNet3 or RNNoise -> 150 ms hold-back -> speech gate
//   -> LiveKit (Opus mono, with FEC and DTX).
// The gate opens on speech only (Silero, in vad.worker.ts): typing alone never opens it. The
// hold-back lets the gate open before the first word reaches others.
import type * as LK from 'livekit-client';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import { DeepFilterNet3Core } from 'deepfilternet3-noise-filter';
import { $, group, h, isAdmin, load, loadBundle, readout, req, row, settingsDialog, showMenu, store, toast, toastError, toggle, user, volumeCurve, type MenuItem, type Live } from './util';
import { ICON } from './viewer';
import { ICON as CHAT_ICON, memberPicker, messageUser } from './chat';

const BASE = '/voice/'; // the filter files (build.mjs)
const RATE = 48000;
const HOLD_BACK = 0.15; // seconds; see docs/voice/README.md on the delay budget

// (show and via: a player in game, in #voice-link: their Minecraft name and server tag; name is
// then the bridge's identity for them, which is also who their sound comes from.)
type Person = { name: string; since: string; show?: string; via?: string };
// (link: #voice-link, always there; linked: the bridge to the game servers is in it.)
type VoiceChat = { id: string; private?: boolean; starter: string; invited?: string[]; people: Person[]; link?: boolean; linked?: boolean };
type Settings = { mic: string; level: number; speaker: string; outVol: number; filter: 'dfn3' | 'rnnoise' | 'off'; sensitivity: number; echo: boolean; gain: boolean; sfx: boolean; sfxVol: number };

let info: { enabled: boolean; url: string; max: number; full: boolean; chats: VoiceChat[] } = { enabled: false, url: '', max: 3, full: false, chats: [] };
let cur: { id: string; room: LK.Room; chain: Chain; track: LK.LocalAudioTrack } | null = null;
let joining = '';
let speaking = new Set<string>();
let muted = false;
let deafened = false;
const audioBox = h('div', { hidden: true }); // remote voices' <audio> elements (not Web Audio, so echo cancelling can hear them)

const defaults: Settings = { mic: '', level: 0, speaker: '', outVol: 100, filter: 'dfn3', sensitivity: 50, echo: false, gain: true, sfx: true, sfxVol: 70 };
let settings: Settings = { ...defaults, ...JSON.parse(load('mt-voice') ?? '{}') };
const saveSettings = () => store('mt-voice', JSON.stringify(settings));
// Mic level went back to +0 dB once, for everyone, when Automatic level arrived: a boost set
// for a quiet microphone before it would now be added on top of the browser's own.
if (load('mt-voice-level-reset') !== '1') {
  settings.level = 0;
  saveSettings();
  store('mt-voice-level-reset', '1');
}
// Sensitivity 0..100 is the speech gate's threshold 0.9..0.1 (higher: opens more easily).
const threshold = () => 0.9 - settings.sensitivity * 0.008;

// The speaker chosen in Voice Settings, for the voices, their boost, the voice chat sounds
// and the mic test. Browsers without setSinkId (Safari; Firefox for Web Audio) play them on
// the system's output.
type Sink = { setSinkId?: (id: string) => Promise<void> };
const canPickSpeaker = 'setSinkId' in HTMLMediaElement.prototype;
function toSpeaker(...targets: (object | null | undefined)[]) {
  for (const t of targets as (Sink | null | undefined)[]) void t?.setSinkId?.(settings.speaker).catch(() => {}); // (unplugged: it stays on the old one)
}

// ---- the list ---------------------------------------------------------------------------

async function loadVoice() {
  const r = await req('GET', '/api/voice');
  if (!r.ok) return;
  info = await r.json();
  // The server ended the voice chat we're in (it never noticed us, or we were removed).
  if (cur && !info.chats.some((c) => c.id === cur!.id) && !joining) void leave(false);
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
  const menu = (e: MouseEvent, more: MenuItem[] = []) => {
    e.preventDefault();
    showMenu(e, [here ? ['Leave', () => void leave(true)] : ['Join', () => void join(c.id)], ...more]);
  };
  const head = h('div', { class: 'row channel voice link' + (here ? ' here' : ''), title: here ? 'You’re in this voice chat' : 'Join: the hub and the voice-link group in game hear each other' },
    h('span', { class: 'hash', innerHTML: CHAT_ICON.link }), h('span', { class: 'name' }, 'voice-link'));
  head.dataset.voice = c.id;
  head.onclick = () => void join(c.id);
  head.oncontextmenu = (e) => menu(e);
  const rows = [head];
  if (!c.linked) rows.push(h('div', { class: 'voice-note' }, 'Not connected to the game servers'));
  const people = [...c.people];
  if ((here || joining === c.id) && !people.some((p) => p.name === user.name)) people.push({ name: user.name, since: '' });
  for (const p of people) {
    const row = h('div', {
      class: 'row channel voice voice-more person in-link' + (here ? ' here' : '') + (speaking.has(p.name) ? ' speaking' : ''),
      title: p.via ? `${p.show} is in the voice-link group in game` : here ? 'You’re in this voice chat' : 'Join this voice chat',
    },
    h('span', { class: 'hash' }), h('span', { class: 'name' }, p.show ?? p.name),
    ...(p.via ? [h('span', { class: 'tag via' }, p.via)] : []));
    row.dataset.voice = c.id;
    row.dataset.who = p.name;
    row.onclick = () => void join(c.id);
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

async function join(id: string) {
  if (cur?.id === id || joining) return;
  const r = await req('POST', `/api/voice/${id}/join`);
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
    chain = await buildChain();
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
    if (reason === DisconnectReason.PARTICIPANT_REMOVED) toast('An admin disconnected you from the voice chat.', 6000);
    else toastError('Voice chat disconnected.');
    void leave(true);
  });
  try {
    await room.connect(url, token);
    const track = new LocalAudioTrack(chain.out, undefined, true);
    await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: true, red: true, forceStereo: false, audioPreset: { maxBitrate: 32000 } });
    cur = { id, room, chain, track };
    if (muted) await track.mute();
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

// markSpeaking lights up the names of whoever is talking, without redrawing the list.
function markSpeaking() {
  for (const row of document.querySelectorAll<HTMLElement>('#voice-list .row.voice')) {
    row.classList.toggle('speaking', speaking.has(row.dataset.who ?? ''));
  }
}

// ---- the bar at the bottom of the sidebar ------------------------------------------------

const bar = h('div', { id: 'voice-bar', hidden: true });

function renderBar() {
  bar.hidden = !cur;
  if (!cur) return;
  const c = info.chats.find((x) => x.id === cur!.id);
  const top = c?.link ? 'voice-link' : c?.people[0]?.name ?? user.name;
  const btn = (title: string, icon: string, on: () => void, cls = '') => {
    const b = h('button', { class: 'tool ' + cls, title, innerHTML: icon });
    b.onclick = on;
    return b;
  };
  bar.replaceChildren(
    h('div', { class: 'voice-where' }, h('span', { class: 'voice-ok' }, 'Voice connected'), h('span', { class: 'muted' }, top + (c?.private ? ' (private)' : ''))),
    h('div', { class: 'voice-buttons' },
      btn(muted ? 'Unmute' : 'Mute', muted ? ICON.micOff : ICON.mic, () => void setMuted(!muted), muted ? 'off' : ''),
      btn(deafened ? 'Undeafen' : 'Deafen', deafened ? ICON.headphonesOff : ICON.headphones, () => void setDeafened(!deafened), deafened ? 'off' : ''),
      btn('Voice settings', ICON.settings, openSettings),
      btn('Leave the voice chat', ICON.hangUp, () => void leave(true), 'danger')));
}

let mutedBeforeDeafen = false;
async function setMuted(m: boolean, quiet = false) {
  if (!quiet && m !== muted) sfx(m ? 'mute' : 'unmute');
  muted = m;
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

type Chain = { out: MediaStreamTrack; level: GainNode; meter: (fn: ((peak: number) => void) | null) => void; stop: () => void };

// The filters' files load once, on first use.
let filesLoaded: Promise<{ rnnoise: ArrayBuffer; dfn: DeepFilterNet3Core }> | null = null;
const loadFiles = () => (filesLoaded ??= (async () => {
  const dfn = new DeepFilterNet3Core({ sampleRate: RATE, noiseReductionLevel: 100, assetConfig: { cdnUrl: BASE + 'dfn3' } });
  const [rnnoise] = await Promise.all([loadRnnoise({ url: BASE + 'rnnoise.wasm', simdUrl: BASE + 'rnnoise_simd.wasm' }), dfn.initialize()]);
  return { rnnoise, dfn };
})().catch((e) => {
  filesLoaded = null;
  throw e;
}));

// The gate's worklet: passes nothing on; downsamples to 16 kHz in 512-sample frames for the
// worker (over the port it's given), and reports the level for the settings meter.
const GATE_WORKLET = `
class VoiceTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(512); this.n = 0; this.acc = 0; this.k = 0; this.peak = 0; this.t = 0;
    this.port.onmessage = (e) => { this.out = e.data; };
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    for (let i = 0; i < x.length; i++) {
      this.peak = Math.max(this.peak, Math.abs(x[i]));
      this.acc += x[i];
      if (++this.k === 3) {
        this.frame[this.n++] = this.acc / 3; this.acc = 0; this.k = 0;
        if (this.n === 512) { if (this.out) this.out.postMessage(this.frame.slice()); this.n = 0; }
      }
    }
    if (currentTime - this.t > 0.05) { this.port.postMessage(this.peak); this.peak = 0; this.t = currentTime; }
    return true;
  }
}
registerProcessor('voice-tap', VoiceTap);
`;

async function buildChain(): Promise<Chain> {
  const files = await loadFiles();
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { ...(settings.mic ? { deviceId: { exact: settings.mic } } : {}), channelCount: 1, echoCancellation: settings.echo, noiseSuppression: false, autoGainControl: settings.gain },
  });
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  const stopAll = () => {
    for (const t of mic.getTracks()) t.stop();
    worker?.terminate();
    void ctx.close();
  };
  let worker: Worker | undefined;
  try {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([GATE_WORKLET], { type: 'text/javascript' })));
    const src = ctx.createMediaStreamSource(mic);
    const level = ctx.createGain();
    level.gain.value = 10 ** (settings.level / 20);
    src.connect(level);
    let filtered: AudioNode = level;
    if (settings.filter === 'dfn3') {
      filtered = await files.dfn.createAudioWorkletNode(ctx);
      level.connect(filtered);
    } else if (settings.filter === 'rnnoise') {
      await ctx.audioWorklet.addModule(BASE + 'rnnoise-worklet.js');
      filtered = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: files.rnnoise });
      level.connect(filtered);
    }
    const hold = ctx.createDelay(1);
    hold.delayTime.value = HOLD_BACK;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    // One channel from the start. (Made with two and set to one afterwards, its track now and
    // then still said two when it was published, and the voice went out as stereo Opus: seen
    // once in 38 runs of a lab that checks every packet.)
    const out = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
    filtered.connect(hold).connect(gate).connect(out);

    const tap = new AudioWorkletNode(ctx, 'voice-tap', { numberOfOutputs: 0 });
    filtered.connect(tap);
    worker = new Worker(BASE + 'vad.worker.js');
    const ch = new MessageChannel();
    tap.port.postMessage(ch.port1, [ch.port1]);
    let onLevel: ((peak: number) => void) | null = null;
    tap.port.onmessage = (e) => onLevel?.(e.data as number);
    await new Promise<void>((ok, fail) => {
      worker!.onmessage = (e) => {
        if (e.data.type === 'ready') ok();
        else if (e.data.type === 'gate') gate.gain.setTargetAtTime(e.data.open ? 1 : 0, ctx.currentTime, e.data.open ? 0.005 : 0.03);
        else if (e.data.type === 'error') console.error('speech gate:', e.data.message);
      };
      worker!.onerror = (e) => fail(new Error(`the speech gate didn't start (${e.message})`));
      worker!.postMessage({ type: 'init', base: new URL(BASE, location.href).href, port: ch.port2 }, [ch.port2]);
    });
    worker.postMessage({ type: 'threshold', value: threshold() });
    const w = worker;
    gateWorker = w;
    return {
      out: out.stream.getAudioTracks()[0],
      level,
      meter: (fn) => (onLevel = fn),
      stop: () => {
        if (gateWorker === w) gateWorker = null;
        stopAll();
      },
    };
  } catch (e) {
    stopAll();
    throw e;
  }
}
let gateWorker: Worker | null = null;

// ---- settings ---------------------------------------------------------------------------

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
  const level = h('input', { type: 'range', min: '0', max: '24', step: '1', value: String(settings.level) });
  const levelVal = readout();
  const meter = h('div', { class: 'voice-meter' }, h('div', {}));
  const filter = h('select', {},
    ...([['dfn3', 'DeepFilterNet3'], ['rnnoise', 'RNNoise'], ['off', 'Off']] as const)
      .map(([v, l]) => h('option', { value: v, selected: settings.filter === v }, l)));
  const sens = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(settings.sensitivity) });
  const sensVal = readout();
  const showSens = () => (sensVal.textContent = `${sens.value}%`);
  showSens();
  const echo = toggle(settings.echo, 'Echo cancelling', (on) => {
    settings.echo = on;
    void rebuild();
  });
  const gain = toggle(settings.gain, 'Automatic level', (on) => {
    settings.gain = on;
    void rebuild();
  });
  const show = () => (levelVal.textContent = `+${level.value} dB`);
  show();
  level.oninput = () => {
    settings.level = Number(level.value);
    show();
    const c = cur?.chain ?? test?.chain;
    if (c) c.level.gain.value = 10 ** (settings.level / 20);
    saveSettings();
  };
  sens.oninput = () => {
    settings.sensitivity = Number(sens.value);
    showSens();
    gateWorker?.postMessage({ type: 'threshold', value: threshold() });
    saveSettings();
  };
  // Mic test: hear yourself as the others would, after the level, the filter and the gate
  // (in a voice chat: your live microphone; otherwise one built just for the test).
  let test: { chain: Chain; own: boolean; el: HTMLAudioElement } | null = null;
  const testBtn = h('button', { type: 'button', class: 'mic-test' }, 'Test');
  const stopTest = () => {
    if (!test) return;
    test.el.pause();
    test.el.srcObject = null;
    if (test.own) test.chain.stop();
    else test.chain.meter(null);
    test = null;
    testBtn.textContent = 'Test';
    (meter.firstElementChild as HTMLElement).style.width = '0';
  };
  const startTest = async () => {
    testBtn.disabled = true;
    try {
      const own = !cur;
      const chain = cur ? cur.chain : await buildChain();
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
  // A new microphone, filter, echo or automatic level setting needs the chain built again.
  const rebuild = async () => {
    saveSettings();
    if (test?.own) {
      stopTest();
      await startTest();
      return;
    }
    if (!cur) return;
    try {
      const chain = await buildChain();
      await cur.track.replaceTrack(chain.out, true);
      cur.chain.stop();
      cur.chain = chain;
      chain.meter(setMeter);
      if (test) {
        test.chain = chain;
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
  filter.onchange = () => {
    settings.filter = filter.value as Settings['filter'];
    void rebuild();
  };
  const setMeter = (peak: number) => ((meter.firstElementChild as HTMLElement).style.width = `${Math.min(100, Math.sqrt(peak) * 100)}%`);
  cur?.chain.meter(setMeter);
  settingsDialog('Voice settings', [
    group('Input',
      row('Microphone', null, [mic]),
      row('Automatic level', 'Your browser keeps your voice at an even level, so a quiet microphone is heard.', [gain]),
      row('Mic level', 'Extra, on top. Raise it if others still say you’re quiet.', [level, levelVal]),
      row('Mic test', 'Hear yourself as others will. Use headphones.', [testBtn], meter)),
    group('Output',
      ...(canPickSpeaker ? [row('Speaker', null, [speaker])] : []),
      row('Output volume', 'Everyone’s voices. Each person’s own volume is in their right-click menu.', [h('div', { class: 'slider' }, outVol, outTick), outVal])),
    group('Processing',
      row('Noise filter', 'DeepFilterNet3 is best; RNNoise is lighter, for slow computers.', [filter]),
      row('Voice gate sensitivity', 'The gate opens only when you speak, so typing alone isn’t heard. Turn it up if your first words get cut off.', [sens, sensVal]),
      row('Echo cancelling', 'Only on speakers. On headphones it chops up your voice.', [echo])),
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
