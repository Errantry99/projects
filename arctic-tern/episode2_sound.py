"""Soundtrack for Episode 2: The Whale. Every event is read from episode2_timeline.py.
No samples, no words, no borrowed melody.  python episode2_sound.py -> build/episode2/sound.wav"""
import os
import sys

import numpy as np
from pedalboard import Compressor, Limiter, Pedalboard, Reverb

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import episode2_timeline as T  # noqa: E402
import synth  # noqa: E402

synth.init(T.DURATION)
from synth import *  # noqa: E402,F401,F403  SR, N, buses, add, note, instruments, effects, THEME, play, ...

G_UP = 5 / 12  # the series theme, moved from D up to G for a sunny morning
rng2 = np.random.default_rng(23)


def whistle(f, dur):
    """A breathy pennywhistle: sine with vibrato and a little noise."""
    t = tl(dur)
    fr = f * (1 + 0.012 * np.sin(2 * np.pi * 5.8 * t) * np.clip(t / 0.2, 0, 1))
    y = np.sin(2 * np.pi * np.cumsum(fr) / SR) + 0.15 * bp(noise(dur), f * 0.8, min(f * 3, 20000))
    return y * env(len(t), 0.03, min(0.1, dur / 3)) * 0.25


def splash(size=1.0, dur=0.6):
    t = tl(dur)
    body = bp(noise(dur), 300, 6000) * np.exp(-t * (8 / size))
    thump = np.sin(2 * np.pi * (90 / size) * t) * np.exp(-t * 18) * size
    y = body + thump * 0.8
    for _ in range(int(6 * size)):  # droplet bloops
        k = int(rng2.uniform(0.05, dur * 0.8) * SR)
        f = rng2.uniform(600, 1800)
        d = tl(0.06)
        blp = np.sin(2 * np.pi * f * (1 + 2 * d) * d) * np.exp(-d * 60) * 0.3
        y[k:k + len(blp)] += blp[: len(y) - k]
    return y * 0.6


def whale_song(dur, f0=170, f1=290, f2=210):
    t = tl(dur)
    half = len(t) // 2
    fr = np.concatenate([f0 * (f1 / f0) ** (t[:half] / t[half]), f1 * (f2 / f1) ** ((t[half:] - t[half]) / (t[-1] - t[half]))])
    ph = np.cumsum(fr) / SR
    y = sum(np.sin(2 * np.pi * k * ph) / k ** 1.3 for k in (1, 2, 3, 4))
    y *= 1 + 0.3 * np.sin(2 * np.pi * 4 * t)
    return lp(y, 1500) * env(len(t), dur * 0.25, dur * 0.35) * 0.35


def rumble(dur):
    t = tl(dur)
    return (np.sin(2 * np.pi * (38 + 18 * t / dur) * t) + lp(noise(dur), 180) * 0.8) * env(len(t), dur * 0.5, 0.3) * 0.5


def bubbles(dur, rate=14):
    y = np.zeros(int(dur * SR))
    for _ in range(int(dur * rate)):
        k = int(rng2.uniform(0, dur - 0.08) * SR)
        f = rng2.uniform(250, 700)
        d = tl(0.08)
        b = np.sin(2 * np.pi * f * (1 + 3 * d) * d) * np.exp(-d * 40) * 0.25
        y[k:k + len(b)] += b
    return lp(y, 2000)


def spout_whoosh(dur=1.2, size=1.0):
    t = tl(dur)
    n = noise(dur)
    y = np.zeros(len(t))
    blk = 2048
    for s in range(0, len(t), blk):
        fc = 400 + 6000 * (s / len(t)) ** 0.6
        y[s:s + blk] = bp(n[s:s + blk], fc * 0.5, min(fc * 1.5, 20000))
    return y * np.sin(np.pi * t / dur) ** 0.7 * 0.7 * size


def rain(dur, count=60):
    y = np.zeros(int(dur * SR))
    for _ in range(count):
        k = int(rng2.uniform(0, dur - 0.05) * SR)
        d = tl(0.04)
        y[k:k + len(d)] += bp(noise(0.04), 2000, 9000) * np.exp(-d * 120) * rng2.uniform(0.2, 0.6)
    return y


def gulp():
    return glide(320, 110, 0.22) * env(int(0.22 * SR), 0.01, 0.08) * 0.5


def flop(n=4):
    y = np.zeros(int(0.6 * SR))
    for k in range(n):
        s = int(k * 0.13 * SR)
        d = tl(0.06)
        y[s:s + len(d)] += bp(noise(0.06), 700, 4000) * np.exp(-d * 70) * 0.6
    return y


def laugh():
    return np.concatenate([squawk(3000, 0.09) for _ in range(3)]) * 1.2


def boing(f0=180, f1=420, dur=0.3):
    return glide(f0, f1, dur) * np.exp(-tl(dur) * 7) * 0.5


# ---------------------------------------------------------------- 1. morning
add(sea(T.DURATION), 0, 0.0, 0.3, "amb")
for tc, f in [(2.0, 100), (11.5, 90), (24.5, 80), (36.0, 110), (44.0, 95), (51.0, 100)]:
    add(creak(0.6, f), tc, 0.3, 0.5, "fx")
morning = [("G2", ["G4", "B4", "D5"]), ("C3", ["C4", "E4", "G4"]), ("D3", ["D4", "F#4", "A4"]), ("G2", ["G4", "B4", "D5"])]
chord_bed(0.5, morning, 1.5)
play(THEME, 0.5, whistle, up=G_UP, conv=major, bars=2, pan=0.1, gain=1.0)
flaps(T.TERN_TAKEOFF, 6, 0.12, 0.2, 0.5)
add(glide(1800, 600, 0.7) * env(int(0.7 * SR), 0.05, 0.1) * 0.25, T.TERN_DIVE - 0.7, 0.4, 0.8, "fx")
add(splash(0.7), T.TERN_DIVE, 0.4, 1.0, "fx")
add(splash(0.4, 0.4), T.TERN_SURFACE, 0.4, 0.8, "fx")
for k, nm in enumerate(["G5", "B5", "D6"]):
    add(celesta(note(nm), 0.6), T.TERN_SURFACE + 0.1 + 0.08 * k, 0.3, 0.5)
add(gulp(), T.GULP, 0.0, 1.0, "fx")
add(celesta(note("G6"), 0.8), T.GULP + 0.2, 0.0, 0.5)

# ---------------------------------------------------------------- 2. Clawd's turn
for (t0, t1), nm in zip(T.BOW_HOPS, ["B4", "D5", "G5"]):
    add(pluck(note(nm), 0.5, 0.7), t1, -0.1, 0.9)
    add(squeak(900, 1200, 0.1), t1 + 0.02, -0.1, 0.4, "fx")
add(strings([note(n) for n in ("G3", "B3", "D4")], T.LOOK_DOWN[0] - T.BOW_HOPS[0][0] + 0.3, 0.5, 0.3, 2200), T.BOW_HOPS[0][0], 0.0, 0.35)
add(strings([note("D3"), note("A3")], 1.6, 0.4, 0.4, 1500), T.LOOK_DOWN[0], 0.0, 0.5)
for k in range(10):  # the wiggle
    add(pluck(note("D4" if k % 2 == 0 else "E4"), 0.15, 0.5), T.WIGGLE[0] + k * 0.12, -0.1 + 0.02 * k, 0.5)
for k, tr in enumerate(np.arange(T.DIVE[0] - 0.3, T.DIVE[0], 1 / 16)):
    add(snare(0.1), tr, 0.0, 0.3 + 0.1 * k)
add(glide(600, 1600, 0.35) * env(int(0.35 * SR), 0.02, 0.05) * 0.3, T.DIVE[0], 0.0, 0.8, "fx")
add(glide(1600, 500, 0.5) * env(int(0.5 * SR), 0.02, 0.1) * 0.3, T.DIVE[0] + 0.35, -0.2, 0.8, "fx")
add(splash(1.3, 0.9), T.DIVE[1], -0.3, 1.2, "fx")
add(lp(bubbles(T.UNDER[1] - T.UNDER[0], 20), 900), T.UNDER[0] + 0.1, -0.3, 1.0, "fx")
add(boing(220, 500), T.BOB_UP, -0.3, 0.8, "fx")
add(bp(noise(0.15), 500, 5000) * env(int(0.15 * SR), 0.005, 0.1) * 0.5, T.SPIT, -0.3, 0.8, "fx")
for tl_ in T.TERN_LAUGH:
    add(squawk(3000, 0.12), tl_, 0.3, 0.9, "fx")
add(celesta(note("A5"), 0.5), T.TERN_LAUGH[-1] + 0.3, 0.0, 0.4)
add(celesta(note("F5"), 0.9), T.TERN_LAUGH[-1] + 0.55, 0.0, 0.4)

# ---------------------------------------------------------------- 3. the whale
add(rumble(T.BULGE[1] - T.BULGE[0] + 0.6), T.BULGE[0], -0.2, 1.0, "fx")
add(bubbles(T.BULGE[1] - T.BULGE[0] + 0.5, 25), T.BULGE[0], -0.2, 1.0, "fx")
add(splash(1.6, 1.2), T.WHALE_RISE[0] + 0.3, -0.2, 0.8, "fx")
add(whale_song(3.0), T.WHALE_RISE[0] + 0.4, -0.2, 1.0, "fx")
add(strings([note(n) for n in ("G2", "D3", "Bb3")], T.REVEAL[0] - T.WHALE_RISE[0], 1.2, 0.3, 1400), T.WHALE_RISE[0], 0.0, 0.5)
add(celesta(note("A5"), 0.6), T.UH_OH[0] + 0.1, 0.0, 0.7)
add(celesta(note("F5"), 1.0), T.UH_OH[0] + 0.4, 0.0, 0.7)
add(timpani(note("G2"), 2.5), T.REVEAL[0], 0.0, 0.6)
add(brass([note(n) for n in ("G2", "D3", "B3")], 2.4), T.REVEAL[0], 0.0, 0.8)
add(strings([note(n) for n in ("G3", "B3", "D4", "G4")], 2.6, 0.2, 0.6, 3000), T.REVEAL[0], 0.0, 0.5)
add(spout_whoosh(0.5, 0.4), T.PUFF, -0.1, 0.8, "fx")
add(boing(260, 520, 0.2), T.PUFF + 0.05, -0.1, 0.6, "fx")
for k, tr in enumerate(np.arange(T.PUFF + 0.6, T.SPOUT, 1 / 16)):
    add(snare(0.1), tr, 0.0, 0.1 + 0.025 * k)

# ---------------------------------------------------------------- 4. flight and landing
add(spout_whoosh(1.6, 1.3), T.SPOUT - 0.1, -0.1, 1.2, "fx")
add(crash(2.0), T.SPOUT, 0.0, 0.7)
add(glide(500, 2400, 0.9) * env(int(0.9 * SR), 0.02, 0.05) * 0.3, T.SPOUT, 0.0, 0.9, "fx")
add(glide(2400, 700, 1.5) * env(int(1.5 * SR), 0.05, 0.2) * 0.3, T.SPOUT + 0.9, 0.2, 0.8, "fx")
for k, nm in enumerate(["G6", "E6", "D6", "B5", "A5", "G5", "E5", "D5"]):
    add(celesta(note(nm), 0.5), T.SPOUT + 0.9 + 0.18 * k, 0.2, 0.45)
add(rain(T.RAIN[1] - T.RAIN[0], 90), T.RAIN[0], 0.0, 0.8, "fx")
add(clunk(), T.FLIGHT[1], 0.3, 1.3, "fx")
add(boing(160, 380, 0.35), T.FLIGHT[1] + 0.03, 0.3, 0.9, "fx")
add(whale_song(2.6, 150, 260, 120), T.FLUKE_UP[0], -0.3, 1.0, "fx")
add(strings([note(n) for n in ("C3", "G3", "E4")], T.TAIL_SLAP - T.FLUKE_UP[0], 1.0, 0.1, 2400), T.FLUKE_UP[0], 0.0, 0.5)
add(splash(2.2, 1.4), T.TAIL_SLAP, -0.4, 1.4, "fx")
add(timpani(note("D2"), 2.0), T.TAIL_SLAP, 0.0, 0.7)
add(crash(2.2), T.TAIL_SLAP, -0.2, 0.6)
add(rain(1.5, 50), T.TAIL_SLAP + 0.3, -0.4, 0.6, "fx")
flaps(T.TERN_TO_BARREL[1] - 0.5, 5, 0.1, 0.1, 0.5)
for k in range(6):
    add(celesta(note("D6" if k % 2 == 0 else "E6"), 0.3), T.PEEK + 0.2 + 0.08 * k, 0.0, 0.3)
add(flop(4), T.PEEK + 0.3, 0.0, 0.9, "fx")
for k, nm in enumerate(["G5", "B5", "D6", "G6"]):  # ta-da
    add(celesta(note(nm), 1.0), T.OFFER[0] + 0.1 * k, 0.0, 0.55)
add(glide(800, 1600, 0.3) * env(int(0.3 * SR), 0.02, 0.05) * 0.2, T.TOSS, 0.1, 0.7, "fx")
add(gulp(), T.TOSS + 0.5, 0.1, 1.0, "fx")

# ---------------------------------------------------------------- 5. friends: the theme in G major, full band
TUTTI = T.HAPPY
tutti = [("G2", ["G3", "B3", "D4"]), ("C3", ["C4", "E4", "G4"]), ("D3", ["D4", "F#4", "A4"]), ("G2", ["G3", "B3", "D4"])]
for k, (root, tones) in enumerate(tutti):
    add(strings([note(n) for n in tones] + [note(root)], 2.1, 0.1, 0.4, 3400), TUTTI + 2 * k, 0.0, 0.55)
chord_bed(TUTTI, [c for c in tutti for _ in (0, 1)], 1.0)
play(THEME, TUTTI, lead, up=G_UP, conv=major, bars=4, gain=0.9)
play(THEME, TUTTI, whistle, up=G_UP + 1, conv=major, bars=4, gain=0.5)
play(THEME, TUTTI + 4.0, lambda f, d: brass([f / 2], max(d + 0.1, 0.7)), up=G_UP, conv=major, bars=2, gain=0.45)
add(timpani(note("G2"), 2.0), TUTTI, 0.0, 0.5)
add(spout_whoosh(0.9, 0.6), T.LAST_SPOUT, -0.3, 0.8, "fx")
add(whale_song(2.2, 200, 330, 250), T.LAST_SPOUT + 0.6, -0.3, 0.7, "fx")
add(boing(300, 600, 0.2), 55.9, 0.0, 0.6, "fx")
for k, nm in enumerate(["G5", "B5", "D6", "G6"]):
    add(celesta(note(nm), 1.6), T.CARD_IN + 0.09 * k, -0.3 + 0.2 * k, 0.6)
add(strings([note(n) for n in ("G2", "D3", "G3", "B3", "D4")], T.DURATION - 57.0, 0.2, 2.0, 3600), 57.0, 0.0, 0.6)
add(brass([note(n) for n in ("G2", "D3", "B3")], 2.4), 57.0, 0.0, 0.5)

# ---------------------------------------------------------------- mix and master
t_axis = np.arange(N) / SR
mix = buses["music"] * 0.75 + buses["fx"] + buses["amb"]
mix = Pedalboard([Reverb(room_size=0.5, wet_level=0.16, dry_level=1.0, damping=0.6)])(mix.astype(np.float32), SR)
mix = lp(mix, 15000)
fade = np.clip(np.minimum(t_axis / T.FADE_IN[1], (T.DURATION - t_axis) / (T.FADE_OUT[1] - T.FADE_OUT[0])), 0, 1)
mix = mix * fade
mix = mix / np.abs(mix).max() * 10 ** (-4.4 / 20)  # headroom first
mix = Pedalboard([Compressor(threshold_db=-18, ratio=2.5, attack_ms=10, release_ms=150), Limiter(threshold_db=-3.0)])(mix.astype(np.float32), SR)
import pyloudnorm as pyln  # noqa: E402

meter = pyln.Meter(SR)
mix = mix * 10 ** ((-14.0 - meter.integrated_loudness(mix.T)) / 20)
mix = np.clip(mix, -10 ** (-1.5 / 20), 10 ** (-1.5 / 20))  # safety ceiling at -1.5 dBFS
print(f"integrated loudness: {meter.integrated_loudness(mix.T):.1f} LUFS")
print(f"peak: {20 * np.log10(np.abs(mix).max()):.1f} dBFS")
out = os.path.join(HERE, "build", "episode2", "sound.wav")
os.makedirs(os.path.dirname(out), exist_ok=True)
wavfile.write(out, SR, mix.T.astype(np.float32))
print("wrote", out)
