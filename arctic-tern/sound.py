"""Synthesized soundtrack for The Voyage of the Arctic Tern. Every event is read from timeline.py.
No samples, no words, no borrowed melody.  python sound.py -> build/sound.wav"""
import os
import sys

import numpy as np
from pedalboard import Compressor, Limiter, Pedalboard, Reverb

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timeline as T  # noqa: E402
import synth  # noqa: E402

synth.init(T.DURATION)
from synth import *  # noqa: E402,F401,F403  SR, N, buses, add, note, instruments and effects

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
