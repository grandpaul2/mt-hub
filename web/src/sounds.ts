// Sound settings (the menu on your name): a group per sound, with its switch, then its
// volume (cubic, like the system's; letting go plays it; a tick marks the default, 70%) and
// a Test button. The Volume row dims while the sound is off; Test still plays it. Kept per
// browser. New sounds get a group here.
import { messageSounds } from './ding';
import { voiceSounds } from './voice';
import { group, h, readout, row, settingsDialog, toggle } from './util';

type Sound = { get: () => { on: boolean; volume: number }; set: (on: boolean, volume: number) => void; test: () => void };

function sound(title: string, what: string, about: string, s: Sound) {
  const cur = s.get();
  const vol = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(cur.volume) });
  vol.setAttribute('aria-label', `${title} volume`);
  const pct = readout();
  const show = () => (pct.textContent = `${vol.value}%`);
  show();
  let on = cur.on;
  const test = h('button', { type: 'button' }, 'Test');
  test.onclick = () => s.test();
  const volume = row('Volume', null, [h('div', { class: 'slider' }, vol, h('span', { class: 'tick', title: 'Default (70%)' })), pct, test]);
  const dim = () => volume.classList.toggle('off', !on);
  dim();
  const save = () => s.set(on, Number(vol.value));
  vol.oninput = () => {
    show();
    save();
  };
  vol.onchange = () => s.test();
  return group(title,
    row(what, about, [toggle(on, what, (now) => {
      on = now;
      save();
      dim();
    })]),
    volume);
}

export function openSoundSettings() {
  settingsDialog('Sound settings', [
    sound('Message sound', 'Play for new messages', 'In a chat you’re not looking at.', messageSounds),
    sound('Voice chat sounds', 'Play for voice chat events', 'Joining, leaving, mute and deafen.', voiceSounds),
  ]);
}
