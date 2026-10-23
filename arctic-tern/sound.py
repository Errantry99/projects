"""Synthesized soundtrack for The Voyage of the Arctic Tern. Every event is read from timeline.py.
No samples, no words, no borrowed melody.  python sound.py -> build/sound.wav"""
import os
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile
from pedalboard import Compressor, Limiter, Pedalboard, Reverb

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timeline as T  # noqa: E402

SR = 48000
N = int(T.DURATION * SR)
rng = np.random.default_rng(7)
buses = {k: np.zeros((2, N)) for k in ("music", "fx", "amb")}


def note(name):
    names = {"C": 0, "C#": 1, "D": 2, "Eb": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "Ab": 8, "A": 9, "Bb": 10, "B": 11}
    return 440.0 * 2 ** ((names[name[:-1]] + 12 * (int(name[-1]) + 1) - 69) / 12)


def tl(dur):
    return np.arange(int(dur * SR)) / SR


def add(sig, t, pan=0.0, gain=1.0, bus="music"):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    l, r = np.sqrt((1 - pan) / 2), np.sqrt((1 + pan) / 2)
    buses[bus][0, i:i + len(sig)] += sig * l
    buses[bus][1, i:i + len(sig)] += sig * r


def env(n, a=0.005, r=0.1, dur=None):
    e = np.ones(n)
    na, nr = max(1, int(a * SR)), max(1, int(r * SR))
    e[:na] = np.linspace(0, 1, na)
    e[-nr:] *= np.linspace(1, 0, nr)
    return e


def lp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(signal.butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def noise(dur):
    return rng.standard_normal(int(dur * SR))


def saw(f, dur, detune=0.0):
    t = tl(dur)
    ph = np.cumsum(np.broadcast_to(f, t.shape) * (1 + detune) / SR) if np.ndim(f) else t * f * (1 + detune)
    return 2 * (ph % 1.0) - 1


# ---------------------------------------------------------------- instruments
def pluck(f, dur=0.6, bright=0.5):
    p = int(SR / f)
    n = int(dur * SR)
    exc = np.zeros(n)
    exc[:p] = lp(rng.uniform(-1, 1, p), 1500 + 6000 * bright)
    a = np.zeros(p + 2)
    a[0], a[p], a[p + 1] = 1, -0.497, -0.497
    y = signal.lfilter([1.0], a, exc)
    return y * env(n, 0.001, 0.05) * 0.8


def celesta(f, dur=1.2):
    t = tl(dur)
    y = np.sin(2 * np.pi * f * t) * np.exp(-t * 3) + 0.35 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t * 9)
    y += 0.12 * np.sin(2 * np.pi * f * 9.8 * t) * np.exp(-t * 20)
    return y * env(len(t), 0.002, 0.05) * 0.5


def strings(freqs, dur, attack=0.25, release=0.4, cutoff=2400):
    y = sum(saw(f, dur, d) for f in freqs for d in (-0.004, 0.0, 0.005))
    y = lp(y, cutoff) / (3 * len(freqs))
    t = tl(dur)
    y *= 1 + 0.08 * np.sin(2 * np.pi * 5.2 * t)
    return y * env(len(y), attack, release)


def brass(freqs, dur):
    t = tl(dur)
    y = sum(saw(f, dur, d) for f in freqs for d in (0.0, 0.003))
    cut = 600 + 3000 * np.exp(-t * 2.5)
    out = np.zeros_like(y)
    # time-varying low-pass in blocks
    blk = 1024
    zi = None
    for s in range(0, len(y), blk):
        sos = signal.butter(2, cut[s], "low", fs=SR, output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], 2))
        out[s:s + blk], zi = signal.sosfilt(sos, y[s:s + blk], zi=zi)
    return out / (2 * len(freqs)) * env(len(y), 0.03, 0.6)


def timpani(f, dur=2.0):
    t = tl(dur)
    fr = f * (1 + 0.25 * np.exp(-t * 30))
    y = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t * 2.2)
    y += lp(noise(dur), 300) * np.exp(-t * 25) * 0.4
    return y


def crash(dur=2.5):
    t = tl(dur)
    return hp(noise(dur), 4000) * np.exp(-t * 1.8) * 0.5


def snare(dur=0.18):
    t = tl(dur)
    return (bp(noise(dur), 900, 6000) * np.exp(-t * 28) + np.sin(2 * np.pi * 190 * t) * np.exp(-t * 40) * 0.5) * 0.6


def shaker(dur=0.07):
    return hp(noise(dur), 6000) * env(int(dur * SR), 0.01, 0.05) * 0.25


def glide(f0, f1, dur, shape="sine", curve=1.0):
    t = tl(dur)
    fr = f0 * (f1 / f0) ** ((t / dur) ** curve)
    ph = np.cumsum(fr) / SR
    return np.sin(2 * np.pi * ph) if shape == "sine" else 2 * (ph % 1) - 1


# ---------------------------------------------------------------- effects
def sea(dur):
    t = tl(dur)
    brown = np.cumsum(noise(dur))
    brown = hp(brown, 30) / np.abs(brown).max()
    swell = 0.55 + 0.45 * np.sin(2 * np.pi * t / 3.1) ** 2
    hiss = bp(noise(dur), 1500, 5000) * 0.02 * (0.5 + 0.5 * np.sin(2 * np.pi * t / 3.1 + 1) ** 2)
    return lp(brown, 500) * swell * 2.0 + hiss


def creak(dur=0.5, f=95):
    t = tl(dur)
    jitter = 1 + 0.15 * np.sin(2 * np.pi * 7 * t) + 0.05 * lp(noise(dur), 30)
    y = signal.sawtooth(2 * np.pi * np.cumsum(f * jitter) / SR, 0.2)
    y = bp(y, 300, 2200) * np.sin(np.pi * t / dur) ** 2
    return y * 0.4


def squeak(f0=1800, f1=2600, dur=0.18):
    return glide(f0, f1, dur) * np.sin(np.pi * tl(dur) / dur) * 0.25


def fizz(dur=0.35):
    t = tl(dur)
    return bp(noise(dur), 2000, 9000) * np.exp(-t * 6) * (rng.random(len(t)) < 0.35) * 0.6


def clunk():
    t = tl(0.3)
    return (np.sin(2 * np.pi * 120 * t) * np.exp(-t * 22) + lp(noise(0.3), 1200) * np.exp(-t * 35) * 0.5) * 0.8


def snore(dur=0.9):
    t = tl(dur)
    buzz = signal.sawtooth(2 * np.pi * (70 + 15 * t / dur) * t)
    y = lp(buzz, 500) * 0.5 + lp(noise(dur), 800) * 0.6
    return y * np.sin(np.pi * t / dur) ** 1.5 * 0.35


def bloop(f):
    t = tl(0.35)
    y = glide(f * 0.5, f * 1.2, 0.35, curve=0.5) * np.exp(-t * 10) * 0.5
    y += bp(noise(0.35), 800, 5000) * np.exp(-t * 20) * 0.4  # splash
    return y


def whoom(dur=0.8):
    t = tl(dur)
    y = np.zeros(len(t))
    blk = 2048
    n = noise(dur)
    for s in range(0, len(t), blk):
        fc = 200 + 3000 * (s / len(t)) ** 2
        y[s:s + blk] = lp(n[s:s + blk], fc)
    y += glide(80, 320, dur) * 0.4
    return y * np.sin(np.pi * t / dur * 0.5) ** 2 * 0.6


def hum(dur):
    t = tl(dur)
    y = sum(np.sin(2 * np.pi * 110 * k * t) / k for k in (1, 2, 3, 5))
    return y * (0.8 + 0.2 * np.sin(2 * np.pi * 6 * t)) * env(len(t), 0.1, 0.15) * 0.12


def sputter(dur=0.45):
    t = tl(dur)
    gate = (rng.random(len(t)) < 0.02).astype(float)
    gate = lp(gate, 2000) * 30
    return bp(noise(dur), 500, 7000) * np.clip(gate, 0, 1) * 0.6 + hum(dur) * (t / dur)


def squawk(f=2400, dur=0.35, grumpy=False):
    t = tl(dur)
    fr = f * (1.0 - 0.3 * (t / dur)) * (1 + 0.04 * np.sin(2 * np.pi * 38 * t))
    if grumpy:
        fr *= 0.6
    car = np.sin(2 * np.pi * np.cumsum(fr) / SR + 2.5 * np.sin(2 * np.pi * np.cumsum(fr * 0.5) / SR))
    y = bp(car, 600, 6000) * env(len(t), 0.01, 0.12)
    return y * 0.35


def fiddle(names, step=0.3):
    out = []
    for k, nme in enumerate(names):
        last = k == len(names) - 1
        dur = step * (2.2 if last else 1)
        t = tl(dur)
        f = note(nme) * (1 + (0.025 if last else 0.008) * np.sin(2 * np.pi * (5 if last else 6) * t))
        if last:
            f *= 1 - 0.04 * t / dur
        y = lp(signal.sawtooth(2 * np.pi * np.cumsum(f) / SR), 3000) * env(len(t), 0.03, 0.12)
        out.append(y)
    return np.concatenate(out) * 0.28


# ---------------------------------------------------------------- score
CLAWD_PAN = lambda x: float(np.clip((x + 1.9) / 2.6, -0.8, 0.8))  # noqa: E731  wide-shot screen x
SHIP_PAN = 0.35

add(sea(T.DURATION), 0, 0.0, 0.25, "amb")
for tc, f in [(0.3, 90), (1.9, 110), (5.6, 85), (9.8, 100), (11.0, 95)]:
    add(creak(0.6, f), tc, SHIP_PAN, 0.6, "fx")

# intro: D minor shanty lilt, stops dead on the lantern
intro = [(0.0, ["D3", "F3", "A3"], "D2"), (1.0, ["D3", "F3", "A3"], "A1"), (2.0, ["Bb2", "D3", "F3"], "Bb1")]
for t0, ch, bass in intro:
    add(strings([note(n) for n in ch], 1.0 if t0 < 2 else T.LANTERN_OUT - t0, 0.3, 0.05), t0, 0.0, 0.5)
    add(pluck(note(bass), 0.5), t0, -0.1, 0.9)
    for k in range(1, 4):  # lilting plucked chord tones
        add(pluck(note(ch[k % 3].replace("2", "4").replace("3", "4")), 0.3, 0.6), t0 + k * 0.25 + 0.05 * (k == 2), 0.2, 0.35)
for tc, nm in zip(T.CELESTA_PASSES, ["A5", "F5"]):
    add(celesta(note(nm)), tc, 0.2, 0.6)
add(squeak(), T.TERN_LAND, 0.0, 1.0, "fx")
add(creak(0.4, 140), T.TERN_LAND + 0.05, 0.0, 0.5, "fx")
add(fizz(), T.LANTERN_OUT - 0.2, 0.0, 1.0, "fx")

# the quiet: snores, the lid, one ding
for ts in T.SNORES:
    add(snore(), ts, 0.0, 1.0, "fx")
add(clunk(), T.LID_UP, 0.0, 1.0, "fx")
add(squeak(900, 600, 0.25), T.LID_UP + 0.05, 0.0, 0.6, "fx")
add(celesta(note("D6"), 1.5), T.DING, 0.0, 0.7)

# 120 BPM pizzicato bed on Dm Bb F A7 from the launch
bed = [(4.5, ["D", "F", "A"], "D2"), (5.5, ["Bb", "D", "F"], "Bb1"), (6.5, ["F", "A", "C"], "F2"), (7.5, ["A", "C#", "E"], "A1")]
for t0, ch, bass in bed:
    for k in range(4):  # 8th notes
        tk = t0 + k * 0.25
        add(pluck(note(bass) if k % 2 == 0 else note(ch[k % 3] + "4"), 0.35, 0.4), tk, -0.15 if k % 2 == 0 else 0.15, 0.8 if k % 2 == 0 else 0.45)
        add(shaker(), tk + 0.125, 0.4, 1.0)
add(strings([note(n) for n in ("D3", "A3")], 4.0, 0.6, 0.2, 1500), 4.5, 0.0, 0.25)
for i, (tl_, nm) in enumerate(zip(T.FLOE_LANDINGS, ["D5", "E5", "F5", "G5", "A5"])):
    pan = CLAWD_PAN(T.FLOES[i][0])
    add(celesta(note(nm), 0.8), tl_, pan, 0.8)
    add(pluck(note(nm), 0.5, 0.8), tl_, pan, 0.5)
    add(bloop(note(nm) / 2), tl_, pan, 0.9, "fx")
add(squeak(1200, 2400, 0.15), T.LAUNCH, 0.0, 0.5, "fx")

# the beams
bpan = CLAWD_PAN(T.FLOES[-1][0])
add(whoom(0.6), T.BEAMS_ON - 0.4, bpan, 1.0, "fx")
add(hum(T.FLASH - T.BEAMS_ON), T.BEAMS_ON, bpan, 1.0, "fx")
roll_t = np.arange(T.BEAMS_ON, T.FLASH - 0.02, 1 / 16)
for k, tr in enumerate(roll_t):
    add(snare(0.12), tr, 0.0, 0.15 + 0.6 * k / len(roll_t))
swell = crash(T.FLASH - T.BEAMS_ON)[::-1]
add(swell, T.BEAMS_ON, 0.0, 0.6)

# the flash: the full hit, then the card
add(timpani(note("D2")), T.FLASH, 0.0, 0.7)
add(crash(3.0), T.FLASH, 0.1, 0.9)
add(strings([note(n) for n in ("D3", "F#3", "A3", "D4", "F#4")], 2.6, 0.02, 1.2, 4000), T.FLASH, 0.0, 0.8)
add(brass([note(n) for n in ("D3", "A3", "F#4")], 1.6), T.FLASH, 0.0, 0.7)
for k, nm in enumerate(["D6", "F#6", "A6", "D7"]):
    add(celesta(note(nm), 1.4), T.CARD_IN + k * 0.09, -0.3 + 0.2 * k, 0.6)

# the tern wakes, glares and goes
add(sputter(), T.LANTERN_ON, SHIP_PAN, 1.0, "fx")
add(squawk(2600, 0.25), T.TERN_WAKE, SHIP_PAN, 1.0, "fx")
add(squawk(2000, 0.45, grumpy=True), T.GLARE_SQUAWK, SHIP_PAN, 1.1, "fx")
add(fiddle(["D5", "C5", "Bb4", "A4"], 0.28), T.TERN_TAKEOFF, 0.0, 1.0)
for k in range(9):
    tf = T.TERN_TAKEOFF + k * 0.13
    add(lp(noise(0.08), 900) * env(int(0.08 * SR), 0.02, 0.05) * 0.4, tf, SHIP_PAN - 0.12 * k, 0.6, "fx")

# ---------------------------------------------------------------- mix and master
music = buses["music"] * 0.75
fx = buses["fx"]
amb = buses["amb"]
t_axis = np.arange(N) / SR
mix = music + fx + amb
board_rev = Pedalboard([Reverb(room_size=0.45, wet_level=0.18, dry_level=1.0, damping=0.6)])
mix = board_rev(mix.astype(np.float32), SR)
mix = lp(mix, 15000)
fade = np.clip(np.minimum((t_axis - T.FADE_IN[0]) / 0.3, (T.DURATION - t_axis) / (T.DURATION - T.FADE_OUT[0])), 0, 1)
mix = mix * fade
mix = mix / np.abs(mix).max() * 10 ** (-4.4 / 20)  # headroom first
master = Pedalboard([Compressor(threshold_db=-18, ratio=2.5, attack_ms=10, release_ms=150), Limiter(threshold_db=-3.0)])
mix = master(mix.astype(np.float32), SR)
import pyloudnorm as pyln  # noqa: E402

meter = pyln.Meter(SR)
mix = mix * 10 ** ((-14.0 - meter.integrated_loudness(mix.T)) / 20)
mix = np.clip(mix, -10 ** (-1.5 / 20), 10 ** (-1.5 / 20))  # safety ceiling at -1.5 dBFS
print(f"integrated loudness: {meter.integrated_loudness(mix.T):.1f} LUFS")
print(f"peak: {20 * np.log10(np.abs(mix).max()):.1f} dBFS")
os.makedirs(os.path.join(HERE, "build"), exist_ok=True)
wavfile.write(os.path.join(HERE, "build", "sound.wav"), SR, mix.T.astype(np.float32))
print("wrote build/sound.wav")
