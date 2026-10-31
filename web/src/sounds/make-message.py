"""Makes message.mp3, the new-message sound (picked by ear, 2026-10-30).

A snap and a lift: a soft analog-style tone, then a short one an octave up. Made from scratch
here, sines only, every setting tuned by ear:
- The snap, 683 Hz for 36 ms: a struck part dying away while a second part, in opposite
  phase, swells in. Where they cross the sound dips and turns over (about 10 ms in), which is
  what makes it sound natural rather than a beep.
- The lift, 62 ms after the snap starts: 11 ms that glide down from 1500 to 1330 Hz and die
  away quickly, so it doesn't ring.
- Both are near-pure sines with a trace of overtones and a slight random pitch wobble, like
  an analog oscillator, and come up over a few ms (3 and 2.2) so neither clicks.
120 ms of silence first, so a wireless headset waking up doesn't swallow the start. The level
was matched by ear to the old sound (three glass notes), whose level was picked as 70% in
paplay (cubic: 0.34). The file is at full strength; Sound Settings' default of 70% gives the
chosen level, with room above.

Needs numpy and lame:  python3 web/src/sounds/make-message.py
"""
import os, subprocess, tempfile, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(3)


def ms(m):
    return int(SR * m / 1000)


def osc(freq, partials):
    """freq: Hz per sample; partials: (harmonic, level) on the running phase."""
    phase = 2 * np.pi * np.cumsum(freq) / SR
    return sum(level * np.sin(n * phase) for n, level in partials)


def wobble(n, cents=6):
    """A slow random drift of the pitch, like an analog oscillator's."""
    k = rng.standard_normal(n // 200 + 2)
    return 2 ** (cents * np.interp(np.arange(n) / 200, np.arange(len(k)), k) / 1200)


def edges(n, rise, fall):
    """Fade in over rise ms and out over fall ms."""
    g = np.ones(n)
    a, r = ms(rise), ms(fall)
    g[:a] = np.sin(np.linspace(0, np.pi / 2, a)) ** 2
    g[n - r:] = np.cos(np.linspace(0, np.pi / 2, r)) ** 2
    return g


def snap():
    n = ms(36)
    t = np.arange(n) / SR * 1000
    env = np.exp(-t / 8.5) - 0.62 * (1 - np.exp(-t / 16))  # dies away; the swell in opposite phase
    return osc(683 * wobble(n), [(1, 1), (2, 0.01), (3, 0.02)]) * env * edges(n, 3, 4)


def lift():
    n = ms(11)
    t = np.arange(n) / SR * 1000
    freq = 1330 + (1500 - 1330) * np.exp(-t / 6)
    return osc(freq * wobble(n), [(1, 1), (2, 0.011), (3, 0.006)]) * np.exp(-t / 5) * edges(n, 2.2, 4)


a, b = snap(), lift()
x = np.zeros(ms(120 + 62) + len(b) + ms(30))
x[ms(120):ms(120) + len(a)] += a
x[ms(182):ms(182) + len(b)] += b * np.max(np.abs(a)) / np.max(np.abs(b))  # the lift peaks as loud as the snap
loudest = np.max(np.convolve(x ** 2, np.ones(ms(100)) / ms(100), 'valid'))
x *= 0.085 / np.sqrt(loudest)  # full strength: its loudest 100 ms, matched by ear to the old sound

here = os.path.dirname(os.path.abspath(__file__))
with tempfile.NamedTemporaryFile(suffix='.wav') as tmp:
    with wave.open(tmp.name, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())
    subprocess.run(['lame', '--quiet', '-m', 'm', '-b', '192', tmp.name, os.path.join(here, 'message.mp3')], check=True)
print(f'message.mp3: {len(x) / SR:.2f} s, peak {np.max(np.abs(x)):.3f}')
