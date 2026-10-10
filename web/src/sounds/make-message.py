"""Makes message.mp3, the new-message sound (S49, picked by ear with Paul over nine rounds).

Three soft glass notes, C#6 A5 E6, at 0, 70 and 200 ms: a quick pair, then the last after
a breath. Each note is a few inharmonic partials (a glass bar), struck over 18 ms with the
upper partials toned down, then "a hand on the bell": after 150 ms it dies away quickly,
so it doesn't hang like a clock chime. A small, dry room. 120 ms of silence first, so a
wireless headset waking up doesn't swallow the start. Paul picked the level as 70% in
paplay, whose scale is cubic (0.7^3 = 0.34, -9.3 dB). The file is at full strength and the
Sound Settings slider is cubic too, so its default of 70% is exactly that, with room above.

Needs numpy and lame:  python3 web/src/sounds/make-message.py
"""
import os, subprocess, tempfile, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(7)
RING = 0.18  # the fundamental's decay (s); the upper partials die faster


def t(dur):
    return np.arange(int(SR * dur)) / SR


def hz(name):
    semis = {'C': -9, 'C#': -8, 'D': -7, 'D#': -6, 'E': -5, 'F': -4, 'F#': -3, 'G': -2, 'G#': -1, 'A': 0, 'A#': 1, 'B': 2}
    return 440 * 2 ** ((semis[name[:-1]] + 12 * (int(name[-1]) - 4)) / 12)


def glass_note(freq, dur):
    x = t(dur)
    parts = [(1, 1, RING), (2.32, 0.5 * 0.35, RING * 0.6), (4.25, 0.3 * 0.35, RING * 0.36), (6.63, 0.15 * 0.35, RING * 0.2)]
    out = sum(level * np.sin(2 * np.pi * freq * ratio * x + rng.uniform(0, 6.28)) * np.exp(-x / decay) for ratio, level, decay in parts)
    out *= np.minimum(1, x / 0.018)                                        # the strike
    out *= np.where(x < 0.15, 1, np.exp(-(x - 0.15) / 0.09))               # the hand on the bell
    return out


def room(x, mix=0.05, size=0.6):
    """A small Schroeder room: four feedback combs into two allpasses."""
    xs = np.concatenate([x, np.zeros(SR)])
    wet = np.zeros_like(xs)
    for d, g in [(1557, 0.80), (1617, 0.79), (1491, 0.78), (1422, 0.77)]:
        d = int(d * size * SR / 44100)
        c = np.zeros_like(xs)
        for i in range(len(xs)):
            c[i] = xs[i] + (g * c[i - d] if i >= d else 0)
        wet += c
    for d, g in [(225, 0.5), (556, 0.5)]:
        a = np.zeros_like(wet)
        for i in range(len(wet)):
            a[i] = -g * wet[i] + (wet[i - d] + g * a[i - d] if i >= d else 0)
        wet = a
    return xs * (1 - mix) + wet / 4 * mix


dur = RING * 7 + 0.2
x = np.zeros(int(SR * (dur + 0.4)))
for i, (name, at) in enumerate([('C#6', 0), ('A5', 0.07), ('E6', 0.20)]):
    s = glass_note(hz(name), dur) * (0.8 if i < 2 else 1)
    j = int(at * SR)
    x[j:j + len(s)] += s[: len(x) - j]
x = room(x)
x = x / np.sqrt(np.mean(x[: int(SR * 0.4)] ** 2)) * 0.06  # full strength: Sound Settings' default 70% brings it to Paul's level
keep = np.nonzero(np.abs(x) > 1e-4)[0]
x = x[: keep[-1] + 1]
x[-int(SR * 0.03):] *= np.linspace(1, 0, int(SR * 0.03))
x = np.concatenate([np.zeros(int(SR * 0.12)), x])

here = os.path.dirname(os.path.abspath(__file__))
with tempfile.NamedTemporaryFile(suffix='.wav') as tmp:
    with wave.open(tmp.name, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())
    subprocess.run(['lame', '--quiet', '-m', 'm', '-b', '192', tmp.name, os.path.join(here, 'message.mp3')], check=True)
print(f'message.mp3: {len(x) / SR:.2f} s, peak {np.max(np.abs(x)):.3f}')
