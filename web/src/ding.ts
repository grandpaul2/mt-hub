// The new-message sound (S49): three soft glass notes, picked by ear with Paul
// (sounds/make-message.py makes the file). Rules, Paul's:
//   - a new message from someone else, in a chat you can see (the server only sends those);
//   - not if you're looking at that chat: a hub tab that's focused and showing it, in this
//     tab or another (each focused tab notes what it shows in localStorage, every second);
//   - at most once every DING_GAP, across all tabs (a lock and a shared time), so a burst of
//     messages or a second tab is one sound;
//   - Sound Settings (the menu on your name) has its switch and volume, for this browser.
// Browsers play sound only after you've clicked or typed in the page, so the first press
// anywhere readies it.
import { load, store, user, volumeCurve } from './util';

const DING_GAP = 3000;
const SEEN_FOR = 2500; // a tab's note of what it shows counts for this long

let ctx: AudioContext | null = null;
let sound: Promise<AudioBuffer> | null = null;

// The sounds decided on, newest last (the browser tests read it; nothing else does).
const log: string[] = [];
(window as unknown as { __ding: string[] }).__ding = log;

export const dingOn = () => load('mt-ding') !== 'off';
// 70% by default: the level Paul picked, with room to turn it up (the file is at full strength).
const dingVolume = () => Number(load('mt-ding-vol') ?? 70);

function ready() {
  ctx ??= new AudioContext();
  void ctx.resume();
  sound ??= fetch('/sounds/message.mp3').then((r) => r.arrayBuffer()).then((b) => ctx!.decodeAudioData(b));
  sound.catch(() => (sound = null)); // try again next time
}

async function play() {
  try {
    ready();
    const src = ctx!.createBufferSource();
    src.buffer = await sound!;
    const vol = ctx!.createGain();
    vol.gain.value = volumeCurve(dingVolume());
    src.connect(vol).connect(ctx!.destination);
    src.start();
  } catch { /* no sound this time; nothing to tell anyone */ }
}

// setup readies the sound on the first press and keeps this tab's "what I'm showing" note
// fresh while it's focused. showing is the chats on screen in this tab.
export function setupDing(showing: () => string[]) {
  const first = () => {
    ready();
    document.removeEventListener('pointerdown', first, true);
    document.removeEventListener('keydown', first, true);
  };
  document.addEventListener('pointerdown', first, true);
  document.addEventListener('keydown', first, true);
  const note = () => {
    if (looking()) store('mt-looking', JSON.stringify({ chats: showing(), t: Date.now() }));
  };
  setInterval(note, 1000);
  for (const ev of ['focus', 'visibilitychange']) window.addEventListener(ev, note);
  lookingAt = showing;
}

let lookingAt: () => string[] = () => [];
const looking = () => !document.hidden && document.hasFocus();

// dingFor decides whether a new message gets the sound.
export function dingFor(chat: string, from: string) {
  if (!dingOn() || from === user.name) return;
  if (looking() && lookingAt().includes(chat)) return;
  try {
    const other = JSON.parse(load('mt-looking') ?? 'null');
    if (other && Date.now() - other.t < SEEN_FOR && other.chats.includes(chat)) return;
  } catch { /* a bad note: ignore it */ }
  const go = () => {
    if (Date.now() - Number(load('mt-ding-at') ?? 0) < DING_GAP) return;
    store('mt-ding-at', String(Date.now()));
    log.push(chat);
    if (log.length > 20) log.shift();
    void play();
  };
  if (navigator.locks) void navigator.locks.request('mt-ding', go);
  else go();
}

// messageSounds is the message sound's part of Sound Settings (sounds.ts).
export const messageSounds = {
  get: () => ({ on: dingOn(), volume: dingVolume() }),
  set: (on: boolean, volume: number) => {
    store('mt-ding', on ? 'on' : 'off');
    store('mt-ding-vol', String(volume));
  },
  test: () => {
    log.push('test');
    void play();
  },
};
