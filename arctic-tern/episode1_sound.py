"""Soundtrack for Episode 1: The Stowaway. Every event is read from episode1_timeline.py.
No samples, no words, no borrowed melody.  python episode1_sound.py -> build/episode1/sound.wav"""
import os
import sys

import numpy as np
from pedalboard import Compressor, Limiter, Pedalboard, Reverb

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import episode1_timeline as T  # noqa: E402
import synth  # noqa: E402

synth.init(T.DURATION)
from synth import *  # noqa: E402,F401,F403  SR, N, buses, add, note, instruments and effects

# The Tern's theme (original): (eighth-note offset, note, length in eighths), two-second bars at 120 BPM.
THEME = [(0, "D4", 2), (2, "F4", 1), (3, "A4", 1), (4, "G4", 1), (5, "F4", 1), (6, "E4", 2),
         (8, "F4", 2), (10, "A4", 1), (11, "D5", 1), (12, "C5", 1), (13, "A4", 3),
         (16, "Bb4", 2), (18, "A4", 1), (19, "G4", 1), (20, "F4", 1), (21, "E4", 1), (22, "D4", 2),
         (24, "E4", 1), (25, "F4", 1), (26, "G4", 1), (27, "A4", 1), (28, "D4", 4)]
MAJOR = {"F": "F#", "C": "C#", "Bb": "B"}


def major(n):
    return MAJOR.get(n[:-1], n[:-1]) + n[-1]


def lead(f, dur, vib=0.008):
    """A bowed lead: detuned saws with delayed vibrato."""
    t = tl(dur)
    fr = f * (1 + vib * np.sin(2 * np.pi * 5.5 * t) * np.clip(t / 0.25, 0, 1))
    ph = np.cumsum(fr) / SR
    y = (2 * (ph % 1) - 1) + 0.6 * (2 * ((ph * 1.003) % 1) - 1)
    return lp(y, 2600) * env(len(t), 0.04, min(0.12, dur / 3)) * 0.22


def play(melody, t0, inst, step=0.25, up=0, conv=lambda n: n, bars=None, pan=0.0, gain=1.0):
    for off, nm, ln in melody:
        if bars is not None and off >= bars * 8:
            break
        n = conv(nm)
        f = note(n) * 2 ** up
        add(inst(f, ln * step), t0 + off * step, pan, gain)


def tremolo(sig, rate=12):
    return sig * (0.6 + 0.4 * np.sin(2 * np.pi * rate * tl(len(sig) / SR)))


def wind(dur):
    t = tl(dur)
    n = noise(dur)
    y = bp(n, 300, 1400) * (0.6 + 0.4 * np.sin(2 * np.pi * t / 4.3)) + bp(n, 1500, 3500) * 0.25 * (0.5 + 0.5 * np.sin(2 * np.pi * t / 2.9))
    return y * env(len(t), dur * 0.4, dur * 0.3) * 0.25


def knock():
    t = tl(0.12)
    return (bp(noise(0.12), 800, 2500) * np.exp(-t * 60) + np.sin(2 * np.pi * 210 * t) * np.exp(-t * 45)) * 0.7


def flaps(t0, n, rate=0.13, pan=0.0, gain=0.5):
    for k in range(n):
        add(lp(noise(0.08), 900) * env(int(0.08 * SR), 0.02, 0.05) * 0.4, t0 + k * rate, pan, gain, "fx")


def chord_bed(t0, chords, step=1.0):
    """120 BPM pizzicato bed: root on the beat, chord tones on the off-beats, a shaker in between."""
    for k, (root, tones) in enumerate(chords):
        tc = t0 + k * step
        for e in range(int(step / 0.25)):
            te = tc + e * 0.25
            if e % 2 == 0:
                add(pluck(note(root), 0.35, 0.4), te, -0.15, 0.8)
            else:
                add(pluck(note(tones[e % len(tones)]), 0.3, 0.5), te, 0.15, 0.4)
            add(shaker(), te + 0.125, 0.4, 0.8)


# ---------------------------------------------------------------- 1. left behind
add(sea(T.DURATION), 0, 0.0, 0.25, "amb")
for tc, f in [(1.5, 90), (6.0, 110), (17.0, 85), (19.5, 100), (33.0, 80), (45.5, 120), (47.5, 95), (49.0, 105), (53.0, 90)]:
    add(creak(0.7, f), tc, 0.3, 0.6, "fx")
add(strings([note(n) for n in ("D3", "F3", "A3")], 4.2, 0.8, 0.5, 1800), 0.0, 0.0, 0.4)
add(strings([note(n) for n in ("Bb2", "D3", "F3")], 3.2, 0.5, 0.6, 1800), 4.0, 0.0, 0.4)
play(THEME, 0.8, lambda f, d: celesta(f * 2, 1.0), step=0.5, bars=1, pan=0.1, gain=0.6)
for tc in (2.2, 4.6):
    add(squawk(2600, 0.2), tc, -0.5, 0.25, "fx")
add(celesta(note("A5"), 0.6), T.UH_OH[0] + 0.1, 0.0, 0.7)
add(celesta(note("F5"), 1.0), T.UH_OH[0] + 0.4, 0.0, 0.7)
add(lp(glide(note("A2"), note("F2"), 0.5, "saw"), 900) * env(int(0.5 * SR), 0.02, 0.2) * 0.4, T.UH_OH[0] + 0.4, 0.0, 0.6)
for k, nm in enumerate(["D3", "A2", "D3"]):  # pickup into the chase
    add(pluck(note(nm), 0.4), 7.25 + k * 0.42, 0.0, 0.8)

# ---------------------------------------------------------------- 2. the chase
chase = [("D2", ["D4", "F4", "A4"]), ("Bb1", ["Bb3", "D4", "F4"]), ("C2", ["C4", "E4", "G4"]), ("A1", ["A3", "C#4", "E4"])]
chord_bed(8.5, chase + chase[:2], 1.0)
play(THEME, 8.5, lead, bars=2, pan=-0.1, gain=1.0)
for k, (tland, nm) in enumerate(zip(T.CHASE_LANDINGS, ["D5", "E5", "F5", "G5", "A5"])):
    add(bloop(note(nm) / 2), tland, 0.3 - 0.12 * k, 0.9, "fx")
    add(celesta(note(nm), 0.5), tland, 0.3 - 0.12 * k, 0.5)
for k, tr in enumerate(np.arange(T.LEAP[0] - 0.5, T.LEAP[0], 1 / 16)):
    add(snare(0.1), tr, 0.0, 0.2 + 0.08 * k)
add(glide(500, 1500, 0.6) * env(int(0.6 * SR), 0.02, 0.05) * 0.3, T.LEAP[0], 0.0, 0.8, "fx")  # slide whistle up
add(glide(1500, 900, 0.4) * env(int(0.4 * SR), 0.02, 0.1) * 0.3, T.LEAP[0] + 0.6, 0.0, 0.8, "fx")
add(clunk(), T.LEAP[1], 0.0, 1.2, "fx")
add(glide(180, 420, 0.25) * np.exp(-tl(0.25) * 8) * 0.5, T.LEAP[1] + 0.02, 0.0, 0.8, "fx")  # boing
add(glide(1200, 400, 0.6) * env(int(0.6 * SR), 0.02, 0.1) * 0.25, T.INTO_BARREL[0], 0.0, 0.8, "fx")
add(clunk(), T.LID_SLAM, 0.0, 1.4, "fx")
add(crash(0.6) * 0.3, T.LID_SLAM, 0.0, 0.5)

# ---------------------------------------------------------------- 3. discovered
add(lp(noise(1.0), 1200) * env(SR, 0.4, 0.4) * 0.3, T.TERN_TO_DECK[0], -0.3, 0.6, "fx")  # glide whoosh
flaps(T.TERN_TO_DECK[1] - 0.4, 4, 0.1, -0.2)
for k, tp in enumerate(T.PECKS):
    add(knock(), tp, -0.2, 1.0, "fx")
    add(pluck(note(["A4", "Bb4", "B4"][k]), 0.3, 0.7), tp, 0.0, 0.5)
add(creak(0.5, 160), T.PEEK[0], 0.0, 0.8, "fx")
add(tremolo(strings([note("D3"), note("Ab3")], 1.2, 0.3, 0.3, 1500), 14), T.PEEK[0], 0.0, 0.5)
for k in range(8):  # a little glowing-eyes trill
    add(celesta(note("D6" if k % 2 == 0 else "Eb6"), 0.3), T.PEEK[0] + 0.3 + k * 0.08, 0.0, 0.3)
add(squawk(2800, 0.35), T.STARTLE, -0.2, 1.3, "fx")
add(brass([note(n) for n in ("D3", "F3", "Ab3")], 0.7), T.STARTLE, 0.0, 0.9)
flaps(T.STARTLE, 8, 0.11, -0.1, 0.7)
add(tremolo(strings([note("D2"), note("A2")], T.TO_DECK[1] - T.TERN_ON_YARD, 0.4, 0.5, 900), 10), T.TERN_ON_YARD, 0.0, 0.5)
add(squawk(2000, 0.45, grumpy=True), 26.0, 0.3, 1.0, "fx")
add(creak(0.3, 170), T.POP_OUT[0] - 0.1, 0.0, 0.7, "fx")
add(glide(200, 600, 0.3) * np.exp(-tl(0.3) * 6) * 0.5, T.POP_OUT[0], 0.0, 0.9, "fx")
add(squawk(1900, 0.5, grumpy=True), 27.6, 0.3, 1.0, "fx")
for k, nm in enumerate(["D4", "F4", "E4", "D4", "A3", "D4"]):  # tiptoe
    add(pluck(note(nm), 0.25, 0.3), 27.0 + 0.33 * k, 0.0, 0.5)

# ---------------------------------------------------------------- 4. fog and ice
add(wind(T.FOG_OUT[0] - T.FOG_IN[0] + 2), T.FOG_IN[0], 0.0, 1.0, "amb")
add(strings([note(n) for n in ("D2", "A2", "D3")], T.REVEAL - T.FOG_IN[0], 2.0, 0.3, 700), T.FOG_IN[0], 0.0, 0.6)
add(sputter(0.5), T.LANTERN_FLICKER[0], -0.2, 0.7, "fx")
add(sputter(0.4), T.LANTERN_FLICKER[0] + 1.2, -0.2, 0.6, "fx")
flaps(T.TERN_SCOUT[0], 7, 0.13, 0.0, 0.5)
for tc, g in [(33.6, 0.25), (35.0, 0.18), (36.6, 0.4), (37.3, 0.5)]:
    add(squawk(2300, 0.22), tc, -0.4, g, "fx")
add(timpani(note("D2"), 2.5), T.REVEAL, 0.0, 0.8)
add(brass([note(n) for n in ("D2", "F2", "A2", "D3")], 1.6), T.REVEAL, 0.0, 1.0)
add(crash(2.0) * 0.6, T.REVEAL, 0.0, 0.6)
flaps(T.REVEAL + 0.2, 20, 0.08, 0.2, 0.4)
for k, (tl_, nm) in enumerate(zip(T.CLIMB_LANDINGS, ["D4", "F4", "A4", "D5"])):
    add(pluck(note(nm), 0.5, 0.7), tl_, -0.3 + 0.2 * k, 0.9)
    add(squeak(700 + 150 * k, 500 + 150 * k, 0.15), tl_ + 0.03, -0.3 + 0.2 * k, 0.5, "fx")
add(whoom(0.7), T.BEAMS_ON - 0.5, 0.0, 1.0, "fx")
add(hum(T.BEAMS_OFF - T.BEAMS_ON), T.BEAMS_ON, 0.0, 1.0, "fx")
add(strings([note(n) for n in ("D3", "A3", "D4", "F4")], T.BEAM_FIND[0] - T.BEAMS_ON + 0.4, 1.5, 0.4, 2600), T.BEAMS_ON, 0.0, 0.6)
for k, nm in enumerate(["D5", "F5", "A5", "D6", "E6"]):  # found it
    add(celesta(note(nm), 1.0), T.BEAM_FIND[0] + 0.12 * k, 0.2, 0.6)
add(strings([note(n) for n in ("Bb2", "F3", "D4")], 2.0, 0.3, 0.4, 2600), T.BEAM_FIND[1], 0.0, 0.6)
roll = np.arange(T.BEAM_FIND[1] + 0.5, T.FOG_OUT[0] + 1.0, 1 / 16)
for k, tr in enumerate(roll):
    add(snare(0.1), tr, 0.0, 0.1 + 0.5 * k / len(roll))
add(crash(T.FOG_OUT[0] + 1.0 - T.BEAM_FIND[1] - 0.5)[::-1] * 0.6, T.BEAM_FIND[1] + 0.5, 0.0, 0.6)

# ---------------------------------------------------------------- 5. dawn: the theme in D major
DAWN_HIT = T.FOG_OUT[0] + 1.0
add(timpani(note("D2"), 2.5), DAWN_HIT, 0.0, 0.7)
add(crash(3.0), DAWN_HIT, 0.1, 0.7)
dawn_chords = [("D2", ["D3", "F#3", "A3"]), ("G2", ["G3", "B3", "D4"]), ("A2", ["A3", "C#4", "E4"]), ("D2", ["D3", "F#3", "A3"])]
for k, (root, tones) in enumerate(dawn_chords):
    add(strings([note(n) for n in tones] + [note(root)], 2.1, 0.15, 0.4, 3200), DAWN_HIT + 2 * k, 0.0, 0.55)
    add(pluck(note(root), 0.8, 0.3), DAWN_HIT + 2 * k, -0.1, 0.8)
play(THEME, DAWN_HIT, lead, conv=major, bars=4, gain=1.1)
play(THEME, DAWN_HIT, lambda f, d: brass([f / 2], max(d + 0.1, 0.7)), conv=major, bars=2, gain=0.5)
flaps(T.TERN_TO_NEST[1] - 0.5, 5, 0.1, 0.2, 0.5)
for k, tn in enumerate(T.NODS):
    add(celesta(note(["A5", "F#5"][k]), 0.6), tn, 0.2, 0.6)
for k, nm in enumerate(["D6", "F#6", "A6", "D7"]):
    add(celesta(note(nm), 1.6), T.HAPPY + 0.09 * k, -0.3 + 0.2 * k, 0.6)
add(strings([note(n) for n in ("D3", "F#3", "A3", "D4", "F#4")], T.DURATION - T.HAPPY, 0.3, 2.0, 3600), T.HAPPY, 0.0, 0.6)
add(brass([note(n) for n in ("D3", "A3", "F#4")], 2.2), T.HAPPY, 0.0, 0.5)

# ---------------------------------------------------------------- mix and master
t_axis = np.arange(N) / SR
mix = buses["music"] * 0.75 + buses["fx"] + buses["amb"]
mix = Pedalboard([Reverb(room_size=0.5, wet_level=0.18, dry_level=1.0, damping=0.6)])(mix.astype(np.float32), SR)
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
out = os.path.join(HERE, "build", "episode1", "sound.wav")
os.makedirs(os.path.dirname(out), exist_ok=True)
wavfile.write(out, SR, mix.T.astype(np.float32))
print("wrote", out)
