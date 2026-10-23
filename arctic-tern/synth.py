"""Synth toolkit for The Voyage of the Arctic Tern: buses, instruments and effects, all
synthesized with numpy, scipy and pedalboard. No samples. Call init(duration) first."""
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
N = 0
rng = np.random.default_rng(7)
buses = {}


def init(duration):
    """Allocate the stereo buses for a piece this many seconds long."""
    global N
    N = int(duration * SR)
    for k in ("music", "fx", "amb"):
        buses[k] = np.zeros((2, N))


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


