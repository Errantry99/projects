"""Render "The Derwent Runs Dark": a rollicking sea shanty with grim lyrics, over a photo.

Vocals: sung like a shanty band: a shantyman takes the verses with the crew
answering, and everyone sings the chorus in harmony. Each word is voiced by
Kokoro neural TTS and set on its beat and note with Praat's PSOLA.
Band (stomp, claps, squeezebox, fiddle, sea) is synthesized.
Video: the photo dissolves into a pencil sketch in which the boat sails through
drawn water and comes about twice, then bloops back to the photo, so the first
and last frames match and it loops.

usage: KOKORO_DIR=<dir with kokoro-v1.0.onnx, voices-v1.0.bin> \
       python3 make_shanty.py <photo.jpg> <out.mp4>
"""

import os
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

SR = 44100
VSR = 24000  # Kokoro output rate
BPM = 112
BEAT = 60.0 / BPM
INTRO_BEATS = 16
RNG = np.random.default_rng(7)

# MIDI notes, D major: a jolly tune for a grim tale
A2, B2, Cs3, D3, E3, Fs3, G3, A3, B3, Cs4, D4 = 45, 47, 49, 50, 52, 54, 55, 57, 59, 61, 62

# Each line: list of (word, notes, beats): the word, the note(s) it is sung on
# (several notes split it), and how many beats it lasts.
VERSE_1 = [
    [("Oh,", [A2], 1), ("the", [D3], .5), ("Derwent", [D3, Fs3], 1), ("runs", [A3], 1), ("dark", [A3], 1.5),
     ("and", [G3], .5), ("the", [Fs3], .5), ("mountain", [E3, Fs3], 1), ("looms", [E3], 1), ("grey,", [D3], 2)],
    [("Five", [A2], 1), ("souls", [D3], 1), ("on", [D3], .5), ("the", [Fs3], .5), ("timber", [A3, B3], 1),
     ("that", [A3], .5), ("sailed", [G3], 1), ("away", [E3, Cs3], 2.5)],
]
VERSE_2 = [
    [("She", [A2], 1), ("was", [D3], .5), ("built", [D3], 1), ("of", [Fs3], .5), ("Huon", [A3, A3], 1), ("pine", [A3], 1.5),
     ("and", [G3], .5), ("she", [Fs3], .5), ("gleams", [E3], 1), ("like", [Fs3], 1), ("gold,", [D3], 2)],
    [("But", [A2], 1), ("the", [D3], .5), ("wind", [D3], 1), ("has", [Fs3], .5), ("a", [A3], .5), ("hunger", [B3, A3], 1),
     ("and", [G3], .5), ("the", [G3], .5), ("water", [E3, E3], 1), ("is", [Cs3], .5), ("cold.", [D3], 2.5)],
]
VERSE_3 = [
    [("So", [A2], 1), ("wave", [D3], 1.5), ("to", [Fs3], .5), ("the", [A3], .5), ("harbour,", [A3, A3, G3], 1.5),
     ("lads,", [Fs3], .5), ("wave", [E3], 1), ("while", [Fs3], 1), ("you", [E3], .5), ("may,", [D3], 2)],
    [("For", [A2], 1), ("the", [D3], .5), ("mountain", [D3, Fs3], 1), ("is", [A3], .5), ("watching,", [B3, A3], 1.5),
     ("and", [G3], .5), ("it", [Fs3], .5), ("won't", [E3], 1), ("look", [E3], .5), ("away.", [Cs3, A2], 3)],
]
CHORUS = [
    [("Haul", [A3], 1.5), ("away,", [G3, Fs3], 1.5), ("haul", [G3], 1.5), ("away,", [Fs3, E3], 1.5),
     ("to", [D3], .5), ("the", [D3], .5), ("deep", [B3], 1.5), ("we", [A3], .5), ("go,", [D3], 2)],
    [("For", [A2], .5), ("the", [D3], .5), ("sea", [Fs3], 1), ("keeps", [G3], 1), ("her", [A3], .5), ("own,", [B3], 1.5),
     ("and", [A3], .5), ("the", [G3], .5), ("dead", [Fs3], 1), ("men", [E3], 1), ("know.", [D3], 3)],
]
SONG = [("solo", VERSE_1), ("crew", CHORUS), ("solo", VERSE_2), ("crew", CHORUS),
        ("solo", VERSE_3), ("crew", CHORUS)]
LINE_GAP = 1.0  # beats of breath between lines


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# ---------------------------------------------------------------- vocals
#
# Sung the way shanty bands do it: a shantyman takes each verse line and the
# crew roars back a response; on the chorus everyone sings, locked to the
# stomp, in harmony (tune, a third above, a third below, and a bass on the
# chord root). Every word is voiced by Kokoro neural TTS, then set on its
# beat and its note with Praat's PSOLA, which keeps the voice natural; a
# little of the spoken inflection is kept so it sounds sung by a person.

_tts = None
_words = {}


def tts():
    global _tts
    if _tts is None:
        from kokoro_onnx import Kokoro
        d = os.environ.get("KOKORO_DIR", "models")
        _tts = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"))
    return _tts


def line_text(line):
    return " ".join(w for w, _, _ in line)


def speak_word(word, voice):
    """A trimmed Praat Sound of one spoken word, plus its pitch track (cached)."""
    from parselmouth import Sound
    key = (word, voice)
    if key not in _words:
        lang = "en-gb" if voice.startswith("b") else "en-us"
        x, sr = tts().create(word.strip(",.!"), voice=voice, speed=1.0, lang=lang)
        assert sr == VSR
        snd = Sound(x.astype(np.float64), sr)
        env = np.convolve(np.abs(snd.values[0]), np.ones(240) / 240, "same")
        on = np.nonzero(env > env.max() * 0.03)[0]
        snd = snd.extract_part(on[0] / sr, min((on[-1] + 240) / sr, snd.duration))
        pitch = snd.to_pitch(0.01, 60, 400)
        _words[key] = (snd, pitch.xs(), pitch.selected_array["frequency"])
    return _words[key]


def sing_word(word, notes, dur, voice, keep=0.3, cents=0.0):
    """Sing one word on `notes` across ~`dur` s. Returns (signal, seconds before its vowel)."""
    from parselmouth.praat import call
    snd, ts, f = speak_word(word, voice)
    length = snd.duration
    voiced = f > 0
    if not voiced.any():
        return snd.values[0].copy(), 0.0
    tv, fv = ts[voiced], f[voiced]
    t_on, t_off = tv[0], tv[-1]
    factor = float(np.clip(dur * 0.92 / length, 0.7, 1.7))
    manip = call(snd, "To Manipulation", 0.01, 60, 400)
    tier = call(manip, "Extract pitch tier")
    call(tier, "Remove points between", 0, length)
    frac = np.clip((tv - t_on) / max(t_off - t_on, 1e-3), 0, 0.999)
    target = (np.log2([midi_hz(notes[int(q * len(notes))]) for q in frac])
              + keep * np.log2(fv / np.median(fv)) + cents / 1200)  # keep a bit of speech
    target = np.convolve(np.pad(target, 3, mode="edge"), np.ones(7) / 7, "valid")  # glide between notes
    target -= 0.5 / 12 * np.exp(-(tv - t_on) / 0.04)  # a small scoop into the note
    for ti, lf in zip(tv, target):
        call(tier, "Add point", float(ti), float(2 ** lf))
    call([tier, manip], "Replace pitch tier")
    dtier = call("Create DurationTier", "d", 0, length)
    call(dtier, "Add point", 0, factor)
    call([manip, dtier], "Replace duration tier")
    y = call(manip, "Get resynthesis (overlap-add)").values[0]
    return y / (np.sqrt(np.mean(y ** 2)) + 1e-9) * 0.1, t_on * factor


D_MAJOR = sorted(p + 12 * o for o in range(1, 7) for p in (2, 4, 6, 7, 9, 11, 13))  # MIDI 14-85


def diatonic(note, steps):
    """Move `note` by scale steps in D major (2 = a third)."""
    i = int(np.argmin([abs(p - note) for p in D_MAJOR]))
    return D_MAJOR[i + steps]


def to_sr(y):
    return resample_poly(y, 147, 80)  # 24 kHz -> 44.1 kHz


def place(buf, y, t):
    i = int(t * SR)
    if i < 0:
        y, i = y[-i:], 0
    j = min(i + len(y), len(buf))
    buf[i:j] += y[: j - i]


# ---------------------------------------------------------------- timeline

def build_timeline():
    """Return [(start_sec, mode, line)], caption list, total_beats."""
    beat = INTRO_BEATS
    lines, caps = [], []
    for mode, section in SONG:
        for line in section:
            start = beat * BEAT
            lines.append((start, mode, line))
            length = sum(b for _, _, b in line)
            caps.append((start - 0.3, (beat + length) * BEAT + 0.4,
                         " ".join(w for w, _, _ in line), mode))
            beat += int(np.ceil((length + LINE_GAP) / 4)) * 4  # every line starts on a downbeat
        beat += 4  # a bar for the band between sections
    return lines, caps, beat + 12


# The crew's parts: (voice, part, timing offset s, gain, pan)
CREW = [
    ("bm_george", "tune", 0.0, 1.0, 0.0),        # the shantyman
    ("bm_daniel", "tune", 0.014, 0.65, -0.35),
    ("am_michael", "above", -0.009, 0.42, 0.4),
    ("bm_lewis", "below", 0.011, 0.55, 0.3),
    ("am_onyx", "bass", 0.006, 0.7, -0.15),
]
# the crew's answers to each verse line, sung in the gap before the next one
RESPONSES = [
    [("Way,", [A3], 1), ("hey!", [Fs3], 1.5)],
    [("Heave", [A3], 1), ("ho!", [D3], 2)],
]


def part_notes(part, notes, bar_root):
    if part == "tune":
        return notes
    if part == "above":
        return [diatonic(m, 2) for m in notes]
    if part == "below":
        return [diatonic(m, -2) for m in notes]
    return [bar_root]  # bass: the chord's root, low


def sing_line(line, start, singers, roots, n, left, right, rng):
    t = start
    for word, notes, beats in line:
        d = beats * BEAT
        root = roots[min(int((t / BEAT + 1e-6) // 4), len(roots) - 1)]
        b = t / BEAT
        accent = 1.0 if abs(b - 2 * round(b / 2)) < 1e-6 else 0.85  # lean on the stomps
        for voice, part, dt, gain, pan in singers:
            y, lead = sing_word(word, part_notes(part, notes, root), d, voice,
                                keep=0.3 if part == "tune" else 0.15, cents=rng.normal(0, 4))
            mono = to_sr(y) * gain * accent
            at = t - lead + dt + rng.normal(0, 0.006)
            i = int(max(at, 0) * SR)
            j = min(i + len(mono), n)
            left[i:j] += mono[: j - i] * np.sqrt((1 - pan) / 2)
            right[i:j] += mono[: j - i] * np.sqrt((1 + pan) / 2)
        t += d


def render_voices(lines, n):
    """Call and response on the verses; the whole crew in harmony on the chorus."""
    left, right = np.zeros(n), np.zeros(n)
    rng = np.random.default_rng(3)
    bars = chord_bars(lines, int(n / SR / BEAT // 4) + 2)
    roots = []
    for b in bars:
        r = CHORDS[b][0]
        while r > 47:
            r -= 12
        roots.append(r)
    for k, (start, mode, line) in enumerate(lines):
        singers = CREW if mode == "crew" else CREW[:1]
        sing_line(line, start, singers, roots, n, left, right, rng)
        if mode == "solo":
            end_beat = start / BEAT + sum(b for _, _, b in line)
            next_start = lines[k + 1][0] / BEAT if k + 1 < len(lines) else end_beat + 8
            resp = RESPONSES[k % 2]
            at = np.ceil(end_beat + 0.5)
            if at + sum(b for _, _, b in resp) <= next_start:
                sing_line(resp, at * BEAT, CREW[1:], roots, n, left, right, rng)
        print(f"  sang: {line_text(line)}", flush=True)
    return left, right


# ---------------------------------------------------------------- band

def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


CHORDS = {"D": (50, [50, 54, 57]), "G": (43, [55, 59, 62]), "A": (45, [57, 61, 64]), "Bm": (47, [59, 62, 66])}


def chord_bars(lines, n_bars):
    """Pick a chord for each bar from the melody notes sounding in it."""
    weight = np.zeros((n_bars, 12))
    for start, _, line in lines:
        beat = start / BEAT
        for _, notes, beats in line:
            for nt in notes:
                bar = int((beat + 1e-6) // 4)
                if bar < n_bars:
                    weight[bar, nt % 12] += beats / len(notes)
                beat += beats / len(notes)
    bars, last = [], "D"
    for wb in weight:
        if wb.sum() == 0:
            bars.append(last)
            continue
        score = {name: sum(wb[m % 12] for m in tones) + (0.3 if name == "D" else 0)
                 for name, (_, tones) in CHORDS.items()}
        last = max(score, key=score.get)
        bars.append(last)
    return bars


def reed(freqs, dur):
    """A squeezebox stab: detuned reed pairs, a little tremolo, a quick decay."""
    m = int(dur * SR)
    t = np.arange(m) / SR
    y = np.zeros(m)
    for f in freqs:
        for det in (0.997, 1.003):
            ph = f * det * t
            y += (2 * (ph % 1) - 1) * 0.6 + np.sign(np.sin(2 * np.pi * ph)) * 0.4
    env = np.clip(t / 0.01, 0, 1) * np.exp(-t / (dur * 0.6))
    return lp(y * env * (1 + 0.15 * np.sin(2 * np.pi * 6 * t)), 2600, 2) / len(freqs)


def band(n, lines, start_beat, end_beat):
    """Stomp on 1 and 3, claps on 2 and 4, an oom-pah squeezebox following the tune."""
    stomp_l, clap_l, box = np.zeros(n), np.zeros(n), np.zeros(n)
    hl = int(0.4 * SR)
    th = np.arange(hl) / SR
    stomp = np.sin(2 * np.pi * (60 * th + 50 * 0.03 * (1 - np.exp(-th / 0.03)))) * np.exp(-th / 0.12)
    stomp += lp(RNG.standard_normal(hl), 1200) * np.exp(-th / 0.02) * 0.6  # boots on deck
    bars = chord_bars(lines, int(end_beat // 4) + 2)
    b = start_beat
    while b < end_beat:
        beat_in_bar = int(b) % 4
        bar = bars[int(b // 4)]
        root, tones = CHORDS[bar]
        t0 = b * BEAT
        if beat_in_bar in (0, 2):
            place(stomp_l, stomp * (1.0 if beat_in_bar == 0 else 0.8), t0)
            bass = root if beat_in_bar == 0 else root + 7  # oom: root, then the fifth
            place(box, reed([midi_hz(bass - 12), midi_hz(bass)], BEAT * 0.8) * 0.9, t0)
        else:
            for k in range(4):  # a few crew members clapping, never quite together
                clap = bp(RNG.standard_normal(int(0.12 * SR)), 900, 3500) * np.exp(-np.arange(int(0.12 * SR)) / SR / 0.025)
                place(clap_l, clap * RNG.uniform(0.5, 1.0), t0 + RNG.normal(0, 0.008))
            place(box, reed([midi_hz(m) for m in tones], BEAT * 0.45) * 0.75, t0)  # pah
        place(box, reed([midi_hz(m) for m in tones], BEAT * 0.25) * 0.35, t0 + BEAT / 2)  # off-beat lift
        b += 1
    # a final chord to land on
    place(box, reed([midi_hz(m) for m in [38, 50, 54, 57, 62]], BEAT * 4) * 1.2, end_beat * BEAT)
    place(stomp_l, stomp * 1.2, end_beat * BEAT)
    return stomp_l * 0.32, clap_l * 0.4, box * 0.75


def fiddle(lines, n):
    """A fiddle doubling the tune an octave up on the choruses."""
    ctl = 400
    m = n * ctl // SR + 1
    note = np.full(m, np.nan)
    gate = np.zeros(m)
    for start, mode, line in lines:
        if mode != "crew":
            continue
        t = start
        for _, notes, beats in line:
            d = beats * BEAT
            for j, nt in enumerate(notes):
                a, b = int((t + j * d / len(notes)) * ctl), int((t + (j + 1) * d / len(notes)) * ctl)
                note[a:b] = nt + 12
                gate[a:b - 6] = 1  # a tiny gap: each note gets its own bow stroke
            t += d
    idx = np.where(~np.isnan(note), np.arange(m), 0)
    note = note[np.maximum.accumulate(idx)]
    note[np.isnan(note)] = D4
    note = np.convolve(np.pad(note, 8, mode="edge"), np.hanning(17) / np.hanning(17).sum(), "valid")
    gate = np.convolve(np.pad(gate, 10, mode="edge"), np.hanning(21) / np.hanning(21).sum(), "valid")
    tc = np.arange(m) / ctl
    ts = np.arange(n) / SR
    vib = 0.15 * np.sin(2 * np.pi * 5.8 * tc)
    f0 = np.interp(ts, tc, 440 * 2 ** ((note - 69 + vib) / 12))
    ph = np.cumsum(f0) / SR
    saw = 2 * (ph % 1) - 1
    y = bp(saw, 400, 5000) + 0.5 * bp(saw, 2500, 3500)  # bright body resonance
    return y * np.interp(ts, tc, gate) * 0.09


def sea(n):
    t = np.arange(n) / SR
    noise = RNG.standard_normal(n)
    swell = lp(noise, 500) * (0.5 + 0.5 * np.sin(2 * np.pi * t / 7.3) ** 2)
    hiss = bp(RNG.standard_normal(n), 1500, 6000) * np.clip(np.sin(2 * np.pi * t / 7.3 + 1.2), 0, 1) ** 3
    wind = bp(RNG.standard_normal(n), 300, 900, 1)
    wind *= 0.4 + 0.3 * np.sin(2 * np.pi * t / 11) + 0.2 * np.sin(2 * np.pi * t / 3.7)
    return swell * 0.16 + hiss * 0.05 + wind * 0.05


def creaks(n, total_s):
    out = np.zeros(n)
    for t0 in np.arange(3, total_s - 4, 9.5) + RNG.uniform(-2, 2, len(np.arange(3, total_s - 4, 9.5))):
        d = RNG.uniform(0.5, 1.1)
        m = int(d * SR)
        tt = np.arange(m) / SR
        rate = 28 + 18 * np.sin(np.pi * tt / d)  # a slow stick-slip of timber
        pulses = (np.sin(2 * np.pi * np.cumsum(rate) / SR) > 0.97).astype(float)
        c = bp(pulses * RNG.uniform(0.5, 1, m), 350, 2400) * np.sin(np.pi * tt / d)
        place(out, c * 0.6, t0)
    return out


def thunder(n, times):
    out = np.zeros(n)
    for t0 in times:
        m = int(5 * SR)
        tt = np.arange(m) / SR
        env = (np.exp(-tt / 1.4) * (1 - np.exp(-tt / 0.05))
               * (1 + 0.6 * np.sin(2 * np.pi * 1.7 * tt) * np.exp(-tt / 0.8)))
        out_m = lp(RNG.standard_normal(m), 160, 4) * env
        place(out, out_m * 2.2, t0)
    return out


def flap(n, t_center, length=3.6):
    """Sails flogging while she comes about, then the whump as they fill."""
    out = np.zeros(n)
    m = int(length * SR)
    t = np.arange(m) / SR
    env = np.sin(np.pi * np.clip((t / length - 0.12) / 0.7, 0, 1)) ** 2
    rate = 7 + 4 * np.sin(2 * np.pi * 0.7 * t)
    flutter = np.abs(np.sin(np.pi * np.cumsum(rate) / SR)) ** 6
    y = bp(RNG.standard_normal(m), 150, 1800) * env * (0.3 + flutter)
    place(out, y * 0.25, t_center - length / 2)
    k = int(0.35 * SR)
    tk = np.arange(k) / SR
    whump = lp(RNG.standard_normal(k), 300, 3) * np.exp(-tk / 0.08) * (1 - np.exp(-tk / 0.01))
    place(out, whump * 1.2, t_center + length * 0.42)
    return out


def bloop(n, t0, f0=170.0, f1=820.0, gain=1.0):
    """A bubble popping: a quick upward pitch sweep."""
    out = np.zeros(n)
    m = int(0.25 * SR)
    t = np.arange(m) / SR
    f = f0 * (f1 / f0) ** np.clip(t / 0.07, 0, 1)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.clip(t / 0.004, 0, 1) * np.exp(-t / 0.06)
    place(out, y * 0.5 * gain, t0)
    return out


def reverb(x, secs=3.2, wet=0.32, seed=0):
    m = int(secs * SR)
    t = np.arange(m) / SR
    ir = np.random.default_rng(seed).standard_normal(m) * np.exp(-t * 6.9 / secs)
    ir = lp(ir, 3500)
    ir /= np.sqrt(np.sum(ir ** 2))
    return x * (1 - wet) + fftconvolve(x, ir)[: len(x)] * wet * 1.6


# ---------------------------------------------------------------- video
#
# The photo dissolves into a pencil sketch, and in the sketch the boat sails:
# it is cut into layers (hull and crew, mast, mainsail, jib) set in a drawn
# world of rushing waves, a sliding far shore and drifting clouds. Twice it
# comes about: it slows into the wind, the sails luff and swing across, it
# heels the other way and the world streams past in the other direction.
# Two tacks bring it back to its starting heading, and on the last chord the
# photo bloops back in through a bubble, matching the first frame so it loops.

W, H, FPS = 1080, 1440, 24

# Outlines in the original photo's pixels (1298 x 1719)
HULL = [(250, 1030), (345, 1015), (350, 1050), (415, 958), (470, 938), (560, 932), (610, 945), (705, 948),
        (725, 1068), (1160, 1086), (1298, 1090), (1298, 1108), (1160, 1112), (1150, 1185), (1100, 1235),
        (600, 1215), (330, 1140), (300, 1092), (250, 1062)]
MAST = [(770, 15), (786, 15), (788, 1085), (768, 1085)]
FLAGS = [(740, 845), (800, 845), (812, 945), (740, 945)]
MAIN = [(784, 20), (806, 60), (802, 420), (796, 965), (772, 972), (515, 853), (560, 700), (625, 520),
        (700, 330), (765, 110)]
JIB = [(886, 420), (1298, 1000), (1298, 1060), (930, 962), (965, 880), (992, 760), (988, 640), (952, 520)]
MAST_X, WATERLINE_Y, HORIZON_Y = 777, 1100, 878
SHORE_TOP_Y, SHORE_X_MAX = 690, 505
BOW_X, STERN_X = 1170, 300


def smooth_noise(shape, sigma, seed):
    import cv2
    n = np.random.default_rng(seed).standard_normal(shape).astype(np.float32)
    n = cv2.GaussianBlur(n, (0, 0), sigma)
    return (n - n.min()) / (n.max() - n.min() + 1e-9)


def periodic_noise(h, w, sx, sy, seed):
    """Smooth noise in [0, 1] that wraps around horizontally (so it can scroll forever)."""
    rng = np.random.default_rng(seed)
    f = np.fft.fft2(rng.standard_normal((h, w)))
    ky = np.fft.fftfreq(h)[:, None]
    kx = np.fft.fftfreq(w)[None, :]
    f *= np.exp(-2 * np.pi ** 2 * ((kx * sx) ** 2 + (ky * sy) ** 2))
    n = np.real(np.fft.ifft2(f)).astype(np.float32)
    return (n - n.min()) / (n.max() - n.min() + 1e-9)


def ink(rgb):
    """Pencil rendering of an RGB float image, as grey ink tone in [0, 1] (1 = bare paper)."""
    import cv2
    h, w = rgb.shape[:2]
    gray = cv2.cvtColor((rgb * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    blur = cv2.GaussianBlur(1 - gray, (0, 0), 7)
    pencil = np.clip(gray / np.maximum(1 - blur, 1e-3), 0, 1)  # colour-dodge pencil shading
    g8 = (cv2.GaussianBlur(gray, (0, 0), 1.2) * 255).astype(np.uint8)
    edges = cv2.Canny(g8, 30, 90).astype(np.float32) / 255
    edges = cv2.GaussianBlur(edges, (0, 0), 0.7)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    wob = 15 * smooth_noise((h, w), 25, 11)
    hatch1 = (np.sin((xx + yy + wob) / 2.0) > 0.55) * np.clip((0.42 - gray) / 0.15, 0, 1)
    hatch2 = (np.sin((xx - yy + wob) / 2.2) > 0.6) * np.clip((0.24 - gray) / 0.12, 0, 1)
    s = pencil ** 2.2 * (1 - 0.8 * np.clip(edges * 1.6, 0, 1)) * (1 - 0.45 * hatch1) * (1 - 0.5 * hatch2)
    return s.astype(np.float32)


def finish(s, paper, shade):
    """Ink tone -> warm old paper, with a little weather at the edges."""
    return (s * paper * shade)[..., None] * np.array([0.98, 0.91, 0.79], np.float32)


def poly_mask(points, to_out, feather=1.2):
    import cv2
    m = np.zeros((H, W), np.float32)
    cv2.fillPoly(m, [np.int32([to_out(x, y) for x, y in points])], 1.0)
    return cv2.GaussianBlur(m, (0, 0), feather)


class World:
    """The drawn world the boat sails through; it scrolls forever."""

    def __init__(self, ink_img, photo_gray, to_out):
        import cv2
        self.hy = int(to_out(0, HORIZON_Y)[1])
        hy = self.hy
        # clouds: soft masses shaded in pencil, with broken strokes along their edges
        self.cw = 2048
        n = 0.7 * periodic_noise(hy, self.cw, 150, 40, 40) + 0.3 * periodic_noise(hy, self.cw, 40, 14, 41)
        n = (n - n.min()) / (n.max() - n.min())
        detail = periodic_noise(hy, self.cw, 10, 5, 42)
        cloud = smoothstep((n - 0.45) / 0.3)
        line = np.exp(-((n - 0.47) / 0.007) ** 2) * 0.16 * (detail > 0.45)
        yy, xx = np.mgrid[0:hy, 0:self.cw].astype(np.float32)
        hatch = (np.sin((xx + yy) / 2.0) > 0.75) * np.clip(cloud * n - 0.4, 0, 1) * 0.35
        self.sky = (0.97 - 0.16 * cloud - 0.08 * cloud * detail - line - hatch).astype(np.float32)

        # far shore: the real mountains and town from the left of the photo, mirror-tiled
        top = int(to_out(0, SHORE_TOP_Y)[1])
        xm = int(to_out(SHORE_X_MAX, 0)[0])
        strip = ink_img[top:hy + 8, :xm]
        g = photo_gray[top:hy + 8, :xm]
        dark = cv2.GaussianBlur((g < 0.62).astype(np.float32), (0, 0), 2) > 0.5
        ridge = np.argmax(dark, axis=0)
        ridge = np.convolve(np.pad(ridge, 4, mode="edge"), np.ones(9) / 9, "valid")
        rows = np.arange(strip.shape[0])[:, None]
        alpha = np.clip((rows - ridge[None, :] + 2) / 3, 0, 1)
        alpha[-8:] *= np.linspace(1, 0, 8)[:, None]
        self.shore = np.concatenate([strip, strip[:, ::-1]], 1)
        self.shore_a = np.concatenate([alpha, alpha[:, ::-1]], 1).astype(np.float32)
        self.shore_top = top

        # water: pencil wave strokes whose size grows towards the viewer
        self.ww = 2048
        hw = H - hy
        z = (np.arange(hw) / hw)[:, None]
        lam = 9 + 150 * z ** 1.4
        lam = self.ww / np.round(self.ww / lam)  # whole waves per period, so it wraps cleanly
        warp = periodic_noise(hw, self.ww, 60, 8, 42)
        x = np.arange(self.ww)[None, :]
        phase = 2 * np.pi * x / lam + 9 * warp + 3 * periodic_noise(hw, self.ww, 20, 4, 43)
        waves = np.sin(phase)
        broken = periodic_noise(hw, self.ww, 25, 4, 44)
        stroke = np.clip((waves - 0.8) / 0.1, 0, 1) * np.clip((broken - 0.3) / 0.2, 0, 1)
        glint = np.clip((-waves - 0.94) / 0.04, 0, 1) * (1 - z) * periodic_noise(hw, self.ww, 15, 3, 45)
        yy, xx = np.mgrid[0:hw, 0:self.ww].astype(np.float32)
        hatch = (np.sin(yy / 1.6 + 4 * warp) > 0.7) * 0.07  # faint level strokes across the water
        base = 0.8 - 0.2 * z - 0.12 * periodic_noise(hw, self.ww, 120, 30, 46)
        self.water = np.clip(base - (0.3 + 0.15 * z) * stroke + 0.25 * glint - hatch, 0, 1).astype(np.float32)
        self.depth = z[:, 0].astype(np.float32)

    def render(self, dist, t):
        """Ink tone for the whole frame after the boat has travelled `dist` pixels."""
        import cv2
        hy = self.hy
        out = np.empty((H, W), np.float32)
        xs = np.arange(W, dtype=np.float32)[None, :]
        # sky: slowest
        mx = np.repeat((xs + dist * 0.04 + t * 4) % self.cw, hy, 0)
        my = np.repeat(np.arange(hy, dtype=np.float32)[:, None], W, 1)
        out[:hy] = cv2.remap(self.sky, np.float32(mx), np.float32(my), cv2.INTER_LINEAR)
        # water: rows nearer the viewer stream past faster (parallax), and heave a little
        hw = H - hy
        speed = (0.25 + 2.2 * self.depth)[:, None]
        mx = ((xs + dist * speed) % self.ww).astype(np.float32)
        rows = np.arange(hw, dtype=np.float32)[:, None]
        my = np.clip(rows + (1 + 4 * self.depth[:, None]) * np.sin(2 * np.pi * (xs / 260 - t / 1.6)), 0, hw - 1)
        out[hy:] = cv2.remap(self.water, np.float32(mx), np.float32(my), cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_WRAP)
        # far shore, sliding gently
        sh, sw = self.shore.shape
        mx = np.repeat((xs + dist * 0.12) % sw, sh, 0).astype(np.float32)
        my = np.repeat(np.arange(sh, dtype=np.float32)[:, None], W, 1)
        strip = cv2.remap(self.shore, np.float32(mx), np.float32(my), cv2.INTER_LINEAR)
        a = cv2.remap(self.shore_a, np.float32(mx), np.float32(my), cv2.INTER_LINEAR)
        top = self.shore_top
        out[top:top + sh] = out[top:top + sh] * (1 - a) + strip * a
        return out


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def sailing(t, tacks, tack_len=3.6):
    """Boat state at time t: hull heading (+1 right, -1 left), sail swing, luffing, speed."""
    heading, sails, luff = 1.0, 1.0, 0.0
    for tc in tacks:
        p = (t - (tc - tack_len / 2)) / tack_len
        if p <= 0:
            continue
        sign = heading
        h = np.cos(np.pi * smoothstep(p))                # the bow swings through the wind
        s = np.cos(np.pi * smoothstep((p - 0.1) / 0.9))   # the boom follows a beat later
        heading, sails = sign * h, sign * s
        if 0 < p < 1:
            luff = max(luff, np.sin(np.pi * np.clip((p - 0.12) / 0.7, 0, 1)) ** 2)
    speed = heading * (0.25 + 0.75 * abs(heading))     # head to wind, she slows almost to a stop
    return heading, sails, luff, speed


def render_video(photo, wav_path, out_path, caps, total_s, flashes, sketch_in, bloop_t, tacks):
    import cv2
    src = Image.open(photo).convert("RGB")
    sw, sh = src.size
    scale = max(W / sw, H / sh) * 1.3
    bw, bh = int(sw * scale), int(sh * scale)
    c = 1.28
    x0, y0 = (bw - W * c) / 2, (bh - H * c) / 2

    def to_out(x, y):
        return ((x * scale - x0) / c, (y * scale - y0) / c)

    big = np.asarray(src.resize((bw, bh), Image.LANCZOS), np.float32) / 255
    cam = np.float32([[c, 0, x0], [0, c, y0]])
    photo_f = cv2.warpAffine(big, cam, (W, H), flags=cv2.INTER_AREA | cv2.WARP_INVERSE_MAP)
    photo_gray = cv2.cvtColor((photo_f * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    sketch = ink(photo_f)
    world = World(sketch, photo_gray, to_out)

    paper = (0.9 + 0.1 * smooth_noise((H, W), 1.2, 12) - 0.05 * smooth_noise((H, W), 40, 13)).astype(np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H * 0.55) / (H / 2)) ** 2)
    shade = (np.clip(1.15 - 0.35 * r ** 2, 0.35, 1) * (1 - 0.15 * np.clip(1 - yy / (H * 0.45), 0, 1) ** 2)).astype(np.float32)
    reveal = 0.6 * smooth_noise((H, W), 20, 14) + 0.4 * (1 - cv2.GaussianBlur(1 - sketch, (0, 0), 10))
    reveal = ((reveal - reveal.min()) / (reveal.max() - reveal.min())).astype(np.float32)

    # boat layers: (ink, alpha), drawn back to front
    hull_a = np.maximum(poly_mask(HULL, to_out), 0)
    layers = {
        "main": poly_mask(MAIN, to_out) * (1 - hull_a),
        "jib": poly_mask(JIB, to_out) * (1 - hull_a),
        "hull": hull_a,
        "mast": np.maximum(poly_mask(MAST, to_out), poly_mask(FLAGS, to_out)),
    }
    px, py = to_out(MAST_X, WATERLINE_Y)
    bow_x, stern_x = to_out(BOW_X, 0)[0], to_out(STERN_X, 0)[0]
    main_top = to_out(0, 20)[1]
    foam_tex = periodic_noise(256, 2048, 6, 3, 50)

    def place_layer(name, sx, heel, bob, extra=None):
        """Mirror/foreshorten about the mast, heel about the waterline, then bob."""
        ca, sa = np.cos(heel), np.sin(heel)
        # x' = px + ca*sx*(x-px) - sa*(y-py);  y' = py + sa*sx*(x-px) + ca*(y-py) + bob
        A = np.float32([[ca * sx, -sa, px - ca * sx * px + sa * py],
                        [sa * sx, ca, py - sa * sx * px - ca * py + bob]])
        img, a = sketch, layers[name]
        if extra is not None:
            img, a = extra
        warped = cv2.warpAffine(np.dstack([img, a]), A, (W, H), flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_CONSTANT, borderValue=(1, 0))
        return warped[..., 0], warped[..., 1]

    font = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf", 50)
    title_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", 56)
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-i", wav_path, "-c:v", "libx264", "-preset", "slow", "-crf", "24",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
         out_path], stdin=subprocess.PIPE)
    boil = [(smooth_noise((H, W), 5, 20 + i) - 0.5, smooth_noise((H, W), 5, 30 + i) - 0.5) for i in range(3)]
    in0, in1 = sketch_in
    bloop_len = 0.55
    bc = to_out(760, 640)
    r_max = np.hypot(max(bc[0], W - bc[0]), max(bc[1], H - bc[1])) * 1.05
    ang = np.arctan2(yy - bc[1], xx - bc[0])
    rad = np.hypot(xx - bc[0], yy - bc[1])

    n_frames = int(round(total_s * FPS))
    dist = 0.0
    for f in range(n_frames):
        t = f / FPS
        heading, sails, luff, speed = sailing(t, tacks)
        ramp = smoothstep((t - in0) / 4)  # get under way as the drawing appears
        dist += speed * ramp * 95 / FPS

        if t >= in0 and t < bloop_t + bloop_len:
            s_ink = world.render(dist, t)
            # waves the hull pushes aside: a wake streaming astern and spray at the bow
            hw = abs(speed) * ramp
            stern, bow = (stern_x, bow_x) if heading > 0 else (2 * px - stern_x, 2 * px - bow_x)
            back = (stern - xx) * np.sign(heading)  # distance astern of the transom
            wake = np.clip(1 - np.abs(yy - py - 18) / (6 + 0.1 * np.maximum(back, 0)), 0, 1) * (back > 0)
            wake *= np.exp(-np.maximum(back, 0) / 420)
            fx = ((xx + dist * 2.4) % 2048).astype(np.float32)
            fy = (np.abs(yy - py) % 256).astype(np.float32)
            foam = cv2.remap(foam_tex, np.float32(fx), np.float32(fy), cv2.INTER_LINEAR) > 0.55
            spray = np.exp(-(((xx - bow) / 45) ** 2 + ((yy - py - 10) / 16) ** 2)) * (0.6 + 0.4 * np.sin(t * 17))
            s_ink = np.maximum(s_ink, np.clip((wake * foam + spray * foam) * hw * 1.4, 0, 1) * 0.97)

            heel = np.radians(2.5) * heading * abs(heading) - np.radians(1.2) * np.sin(2 * np.pi * t / (BEAT * 4))
            bob = 5 * np.sin(2 * np.pi * t / (BEAT * 2))
            sx_h = np.sign(heading) * max(abs(heading), 0.22)
            sx_s = np.sign(sails) * max(abs(sails), 0.12)
            for name in ("main", "jib", "hull", "mast"):
                extra = None
                if name in ("main", "jib"):
                    # sails: a gentle breathing, and real flogging while they luff
                    d_mast = np.abs(xx - px) / 400
                    up = np.clip((py - yy) / (py - main_top), 0, 1)
                    amp = 1.5 + 22 * luff * d_mast
                    dx = amp * np.sin(2 * np.pi * (yy / (70 + 60 * up) - t * (1.5 + 5 * luff)))
                    dy = 0.3 * amp * np.sin(2 * np.pi * (xx / 90 - t * (1.2 + 4 * luff)))
                    shrink = 1 - 0.25 * luff * d_mast  # a luffing sail loses its belly
                    mx = (px + (xx - px) * shrink + dx).astype(np.float32)
                    my = (yy + dy).astype(np.float32)
                    img = cv2.remap(sketch, np.float32(mx), np.float32(my), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
                    a = cv2.remap(layers[name], np.float32(mx), np.float32(my), cv2.INTER_LINEAR)
                    extra = (img, a)
                    sx = sx_s
                else:
                    sx = sx_h
                li, la = place_layer(name, sx, heel, bob, extra)
                s_ink = s_ink * (1 - la) + li * la
            # hand-drawn boil
            bx, by = boil[(f // 2) % 3]
            s_ink = cv2.remap(s_ink, np.float32(xx + 2.5 * bx * 2), np.float32(yy + 2.5 * by * 2), cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_REFLECT)
            sk = finish(s_ink, paper, shade)
            flash = sum(np.exp(-(t - ft) / 0.12) for ft in flashes if 0 <= t - ft < 0.9)
            if flash > 0.01:
                neg = (1 - sk) * np.array([0.85, 0.92, 1.0], np.float32)
                sk = sk + (neg - sk) * min(flash * 1.6, 1)
        else:
            sk = None

        if sk is None:
            frame = photo_f
        elif t < in1:  # the photo dissolves into the drawing
            mask = np.clip(((t - in0) / (in1 - in0) * 1.25 - reveal) / 0.25, 0, 1)[..., None]
            frame = photo_f * (1 - mask) + sk * mask
        elif t >= bloop_t:  # bloop: the photo returns through a wobbling bubble
            tau = (t - bloop_t) / bloop_len
            back_ease = 1 + 2.7 * (tau - 1) ** 3 + 1.7 * (tau - 1) ** 2  # ease-out with overshoot
            rr = r_max * back_ease * (1 + 0.07 * (1 - tau) * np.sin(6 * ang + 14 * tau))
            edge = rr - rad
            inside = np.clip(edge / 3, 0, 1)[..., None]
            ring = np.exp(-(edge / 28) ** 2)
            push = ring * 22 * (1 - tau)  # the bubble's rim bends the picture
            mx = (xx - (xx - bc[0]) / (rad + 1e-3) * push).astype(np.float32)
            my = (yy - (yy - bc[1]) / (rad + 1e-3) * push).astype(np.float32)
            bent = cv2.remap(photo_f, np.float32(mx), np.float32(my), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
            frame = sk * (1 - inside) + bent * inside
            frame = frame + (ring * 0.5 * (1 - tau))[..., None] * (edge > -6)[..., None]
        elif t >= bloop_t - 0.2:  # a little bubble wells up first
            tau = (t - (bloop_t - 0.2)) / 0.2
            rr = 60 * smoothstep(tau) * (1 + 0.15 * np.sin(5 * ang + 30 * tau))
            inside = np.clip((rr - rad) / 3, 0, 1)[..., None]
            frame = sk * (1 - inside) + photo_f * inside
            frame = frame + (np.exp(-((rr - rad) / 6) ** 2) * 0.6)[..., None]
        else:
            frame = sk
        img = Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8))

        d = ImageDraw.Draw(img, "RGBA")
        if t < INTRO_BEATS * BEAT:
            a = int(255 * np.clip(min(t - 1.0, INTRO_BEATS * BEAT - 0.5 - t), 0, 1))
            for txt, y, fnt in [("THE DERWENT RUNS DARK", 150, title_font), ("a shanty", 230, font)]:
                tw = d.textlength(txt, font=fnt)
                d.text(((W - tw) / 2, y), txt, font=fnt, fill=(235, 235, 235, a),
                       stroke_width=3, stroke_fill=(0, 0, 0, a))
        for c0, c1, text, mode in caps:
            if c0 <= t <= c1:
                a = int(255 * np.clip(min((t - c0) / 0.4, (c1 - t) / 0.4), 0, 1))
                fill = (235, 238, 242, a) if mode == "solo" else (240, 210, 160, a)
                words = text.split()
                rows = [text] if d.textlength(text, font=font) <= W - 80 else \
                    [" ".join(words[:len(words) // 2]), " ".join(words[len(words) // 2:])]
                for i, row in enumerate(rows):
                    rw = d.textlength(row, font=font)
                    d.text(((W - rw) / 2, H - 230 + i * 62 - (len(rows) - 1) * 31), row, font=font,
                           fill=fill, stroke_width=4, stroke_fill=(0, 0, 0, a))
        ff.stdin.write(img.tobytes())
        if f % 240 == 0:
            print(f"  frame {f}/{n_frames}", flush=True)
    ff.stdin.close()
    ff.wait()


# ---------------------------------------------------------------- main

def make_audio():
    """Return (stereo, captions, total seconds, lightning times, tack times, bloop time)."""
    lines, caps, total_beats = build_timeline()
    total_s = total_beats * BEAT
    n = int(total_s * SR)
    print(f"song length {total_s:.1f}s")

    vl, vr = render_voices(lines, n)
    vl, vr = reverb(vl, 1.4, 0.18, seed=1), reverb(vr, 1.4, 0.18, seed=2)  # a small room, a pub

    last_line_end = (lines[-1][0] + sum(b for _, _, b in lines[-1][2]) * BEAT)
    end_beat = int(np.ceil(last_line_end / BEAT / 4)) * 4 + 4
    stomp, claps, box = band(n, lines, INTRO_BEATS - 8, end_beat)
    fid = fiddle(lines, n)
    # one flash of lightning on each "dead men know": the tune is merry, the tale is not
    flashes = [start + (sum(b for _, _, b in line) - 3) * BEAT for start, mode, line in lines
               if mode == "crew" and line[-1][0].startswith("know")]
    # she comes about in the band's bar before verses 2 and 3, and bloops home on the last chord
    tacks = [start - 2 * BEAT for (start, mode, _), (_, prev, _) in zip(lines[1:], lines[:-1])
             if mode == "solo" and prev == "crew"]
    bloop_t = end_beat * BEAT
    ambience = sea(n) * 0.6 + creaks(n, total_s) + thunder(n, [f + 0.4 for f in flashes]) * 0.6
    ambience += sum(flap(n, tc) for tc in tacks)
    ambience += bloop(n, bloop_t - 0.2, 300, 900, 0.5) + bloop(n, bloop_t)
    band_l = reverb(stomp + claps * 1.1 + box * 0.8 + fid * 0.6 + ambience, 1.8, 0.22, seed=4)
    band_r = reverb(stomp + claps * 0.9 + box * 1.0 + fid * 1.2 + ambience, 1.8, 0.22, seed=5)

    left = vl * 1.0 + band_l
    right = vr * 1.0 + band_r
    stereo = np.stack([left, right], 1)
    stereo = np.tanh(stereo / np.max(np.abs(stereo)) * 1.6) * 0.89  # glue + limit
    stereo[-int(SR * 3):] *= np.linspace(1, 0, int(SR * 3))[:, None]
    stereo[:int(SR * 0.5)] *= np.linspace(0, 1, int(SR * 0.5))[:, None]
    return stereo, caps, total_s, flashes, tacks, bloop_t


def main(photo, out_path):
    stereo, caps, total_s, flashes, tacks, bloop_t = make_audio()
    wav_path = os.path.splitext(out_path)[0] + ".wav"
    with wave.open(wav_path, "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((stereo * 32767).astype(np.int16).tobytes())
    print("audio done; rendering video")
    render_video(photo, wav_path, out_path, caps, total_s, flashes, (1.5, 5.5), bloop_t, tacks)
    os.remove(wav_path)
    print("wrote", out_path)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
