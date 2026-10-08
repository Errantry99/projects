"""Render "The Derwent Runs Dark": an ominous sea shanty sung over a photo.

Vocals: Kokoro neural TTS, sung by re-pitching and time-stretching each line
onto the melody with the WORLD vocoder: vowels are held, consonants keep their
spoken length and lead into the beat, and pitch glides with delayed vibrato. Accompaniment (drone, drum, sea, wind) is synthesized.
Video: slow push-in on the photo, storm grade, lightning, burned-in lyrics.

usage: KOKORO_DIR=<dir with kokoro-v1.0.onnx, voices-v1.0.bin> \
       python3 make_shanty.py <photo.jpg> <out.mp4>
"""

import os
import subprocess
import sys
import wave

import numpy as np
import pyworld as pw
from PIL import Image, ImageDraw, ImageFont
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

SR = 44100
VSR = 24000  # Kokoro output rate
BPM = 74
BEAT = 60.0 / BPM
INTRO_BEATS = 8
RNG = np.random.default_rng(7)

# MIDI notes, D minor (C#3=49 is the harmonic-minor leading tone)
A2, C3, Cs3, D3, E3, F3, G3, A3, Bb3, C4, D4 = 45, 48, 49, 50, 52, 53, 55, 57, 58, 60, 62

# Each line: list of (word, notes, beats). One espeak word per entry; several
# notes split the word's voiced part evenly.
VERSE_1 = [
    [("Oh,", [A2], 1), ("the", [D3], .5), ("Derwent", [D3, F3], 1), ("runs", [A3], 1), ("dark", [A3], 1.5),
     ("and", [G3], .5), ("the", [F3], .5), ("mountain", [E3, F3], 1), ("looms", [E3], 1), ("grey,", [D3], 2)],
    [("Five", [A2], 1), ("souls", [D3], 1), ("on", [D3], .5), ("the", [F3], .5), ("timber", [A3, Bb3], 1),
     ("that", [A3], .5), ("sailed", [G3], 1), ("away", [E3, Cs3], 2.5)],
]
VERSE_2 = [
    [("She", [A2], 1), ("was", [D3], .5), ("built", [D3], 1), ("of", [F3], .5), ("Huon", [A3, A3], 1), ("pine", [A3], 1.5),
     ("and", [G3], .5), ("she", [F3], .5), ("gleams", [E3], 1), ("like", [F3], 1), ("gold,", [D3], 2)],
    [("But", [A2], 1), ("the", [D3], .5), ("wind", [D3], 1), ("has", [F3], .5), ("a", [A3], .5), ("hunger", [Bb3, A3], 1),
     ("and", [G3], .5), ("the", [G3], .5), ("water", [E3, E3], 1), ("is", [Cs3], .5), ("cold.", [D3], 2.5)],
]
VERSE_3 = [
    [("So", [A2], 1), ("wave", [D3], 1.5), ("to", [F3], .5), ("the", [A3], .5), ("harbour,", [A3, A3, G3], 1.5),
     ("lads,", [F3], .5), ("wave", [E3], 1), ("while", [F3], 1), ("you", [E3], .5), ("may,", [D3], 2)],
    [("For", [A2], 1), ("the", [D3], .5), ("mountain", [D3, F3], 1), ("is", [A3], .5), ("watching,", [Bb3, A3], 1.5),
     ("and", [G3], .5), ("it", [F3], .5), ("won't", [E3], 1), ("look", [E3], .5), ("away.", [Cs3, A2], 3)],
]
CHORUS = [
    [("Haul", [A3], 1.5), ("away,", [G3, F3], 1.5), ("haul", [G3], 1.5), ("away,", [F3, E3], 1.5),
     ("to", [D3], .5), ("the", [D3], .5), ("deep", [Bb3], 1.5), ("we", [A3], .5), ("go,", [D3], 2)],
    [("For", [A2], .5), ("the", [D3], .5), ("sea", [F3], 1), ("keeps", [G3], 1), ("her", [A3], .5), ("own,", [Bb3], 1.5),
     ("and", [A3], .5), ("the", [G3], .5), ("dead", [F3], 1), ("men", [E3], 1), ("know.", [D3], 3)],
]
SONG = [("solo", VERSE_1), ("crew", CHORUS), ("solo", VERSE_2), ("crew", CHORUS),
        ("solo", VERSE_3), ("crew", CHORUS)]
LINE_GAP = 1.0  # beats of breath between lines


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# ---------------------------------------------------------------- vocals

FP = 5.0  # WORLD frame period, ms
FS = FP / 1000
_tts = None
_cache = {}


def tts():
    global _tts
    if _tts is None:
        from kokoro_onnx import Kokoro
        d = os.environ.get("KOKORO_DIR", "models")
        _tts = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"))
    return _tts


def runs(mask):
    """[(start, end)] of the True runs in a boolean array."""
    d = np.diff(np.concatenate([[0], mask.astype(int), [0]]))
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))


def analyse(word, voice):
    """Speak one word and split it into WORLD frames plus a vowel-nucleus mask."""
    key = (word, voice)
    if key in _cache:
        return _cache[key]
    lang = "en-gb" if voice.startswith("b") else "en-us"
    x, sr = tts().create(word.strip(",."), voice=voice, speed=0.85, lang=lang)
    assert sr == VSR
    x = x.astype(np.float64)
    env = np.convolve(np.abs(x), np.ones(240) / 240, mode="same")
    keep = np.nonzero(env > env.max() * 0.02)[0]
    x = x[max(keep[0] - 120, 0): keep[-1] + 240]
    f0, t = pw.harvest(x, VSR, f0_floor=60, f0_ceil=400, frame_period=FP)
    sp = pw.cheaptrick(x, f0, t, VSR)
    ap = pw.d4c(x, f0, t, VSR)

    voiced = f0 > 0
    for a, b in runs(~voiced):  # close short unvoiced holes (pitch-tracker dropouts)
        if a > 0 and b < len(voiced) and b - a < 7:
            voiced[a:b] = True
    for a, b in runs(voiced):   # drop tiny voiced specks
        if b - a < 4:
            voiced[a:b] = False
    if not voiced.any():
        voiced[:] = True

    # vowel nuclei: loud, voiced frames. These are what get held; consonants
    # and glides keep their spoken length.
    energy = np.log(sp.sum(1) + 1e-12)
    energy = np.convolve(energy, np.ones(5) / 5, mode="same")
    loud = voiced & (energy > energy[voiced].max() - 1.6)
    nuclei = [(a, b) for a, b in runs(loud) if b - a >= 3] or [max(runs(voiced), key=lambda r: r[1] - r[0])]
    _cache[key] = (sp, ap, voiced, nuclei)
    return _cache[key]


def plan_word(word, notes, voice):
    """Frame weights for stretching, plus the note each frame belongs to."""
    sp, ap, voiced, nuclei = analyse(word, voice)
    n = len(voiced)
    # assign notes to nuclei: one each if counts match, else spread evenly
    if len(nuclei) > len(notes):  # merge extra nuclei into the nearest one
        nuclei = [(nuclei[0][0], nuclei[-1][1])] if len(notes) == 1 else nuclei[: len(notes) - 1] + [(nuclei[len(notes) - 1][0], nuclei[-1][1])]
    stretch = np.zeros(n, bool)
    for a, b in nuclei:
        stretch[a:b] = True
    note_of = np.zeros(n, int)
    if len(nuclei) == len(notes):
        for i, (a, _) in enumerate(nuclei):
            note_of[a:] = i
    else:  # fewer vowels than notes: a melisma across the held vowel(s)
        idx = np.nonzero(stretch)[0]
        note_of[idx] = np.minimum((np.arange(len(idx)) * len(notes)) // len(idx), len(notes) - 1)
        note_of = np.maximum.accumulate(note_of)
    onset = nuclei[0][0]  # frames of consonant before the first vowel
    return sp, ap, voiced, stretch, note_of, onset


def sing_line(line, voice, transpose, cents, seed, tempo_jitter=0.0):
    """Sing a whole line as one continuous phrase. Returns (signal at VSR, offset s)."""
    rng = np.random.default_rng(seed)
    plans = [plan_word(w, notes, voice) for w, notes, _ in line]
    beats = np.cumsum([0] + [b for _, _, b in line])
    vowel_t = beats[:-1] * BEAT + rng.normal(0, tempo_jitter, len(line))
    vowel_t[0] = max(vowel_t[0], 0)
    lead = plans[0][5] * FS  # first consonant starts before the line's first beat
    end_t = beats[-1] * BEAT - 0.25 * BEAT  # breath before the next line

    sps, aps, vs, f0s = [], [], [], []
    cur = 0  # frames written so far; frame 0 is at time -lead
    for i, ((word, notes, b), (sp, ap, voiced, stretch, note_of, onset)) in enumerate(zip(line, plans)):
        start_f = int(round((vowel_t[i] + lead) / FS)) - onset
        if start_f > cur:  # rest: silent frames
            gap = start_f - cur
            sps.append(np.full((gap, sp.shape[1]), 1e-10)); aps.append(np.ones((gap, ap.shape[1])))
            vs.append(np.zeros(gap, bool)); f0s.append(np.full(gap, np.nan))
            cur = start_f
        if i + 1 < len(line):
            stop = vowel_t[i + 1] + lead - plans[i + 1][5] * FS
        else:
            stop = end_t + lead
        n_out = max(int(round(stop / FS)) - cur, 6)
        n_src = len(voiced)
        n_fixed = (~stretch).sum()
        k = max((n_out - n_fixed) / max(stretch.sum(), 1), 0.5)
        w = np.where(stretch, k, 1.0 if k >= 1 else k)
        cum = np.concatenate([[0], np.cumsum(w)])
        n_out = int(cum[-1])
        pos = np.clip(np.interp(np.arange(n_out) + 0.5, cum, np.arange(n_src + 1)) - 0.5, 0, n_src - 1)
        i0 = np.floor(pos).astype(int)
        i1 = np.minimum(i0 + 1, n_src - 1)
        fr = (pos - i0)[:, None]
        sp_o = np.exp(np.log(sp[i0] + 1e-12) * (1 - fr) + np.log(sp[i1] + 1e-12) * fr)
        ap_o = ap[i0] * (1 - fr) + ap[i1] * fr
        near = np.rint(pos).astype(int)
        v_o = voiced[near]
        # a held vowel swells slightly then relaxes; the end of the word tapers
        held = stretch[near]
        tt = np.arange(n_out) * FS
        dyn = 1 + 0.25 * np.sin(np.pi * np.clip(tt / max(n_out * FS, 1e-3), 0, 1)) * held
        tail = np.clip((n_out - np.arange(n_out)) / 16, 0, 1) ** 2
        sp_o *= (dyn * np.maximum(tail, 0.02))[:, None] ** 2
        ap_o[held] = ap_o[held] * 0.75  # a sung vowel is a touch purer than a spoken one
        sps.append(sp_o); aps.append(ap_o); vs.append(v_o)
        f0s.append(np.array([midi_hz(notes[j] + transpose) for j in note_of[near]]))
        cur += n_out

    sp = np.concatenate(sps); ap = np.concatenate(aps); v = np.concatenate(vs)
    target = np.log2(np.concatenate(f0s)) + cents / 1200
    rest = np.isnan(target)  # in a rest, aim at the next note so the glide lands cleanly
    nxt = np.where(~rest, np.arange(len(target)), len(target) - 1)
    nxt = np.minimum.accumulate(nxt[::-1])[::-1]
    target[rest] = target[nxt[rest]]
    n = len(target)
    t = np.arange(n) * FS
    # glide between notes (~70 ms), like a voice rather than a keyboard
    pad = 7
    lf = np.convolve(np.pad(target, pad, mode="edge"), np.hanning(2 * pad + 1) / np.hanning(2 * pad + 1).sum(), "valid")
    # vibrato that blooms on held notes, with continuous phase across the line
    change = np.concatenate([[True], np.abs(np.diff(target)) > 1e-6])
    since = t - t[np.maximum.accumulate(np.where(change, np.arange(n), 0))]
    rate = 5.1 + 0.3 * np.sin(2 * np.pi * 0.23 * t + rng.uniform(0, 6))
    phase = 2 * np.pi * np.cumsum(rate) * FS + rng.uniform(0, 6)
    depth = 0.28 / 12 * np.clip((since - 0.3) / 0.45, 0, 1)
    # slow wander of a few cents, the way a real voice never sits dead on pitch
    drift = np.convolve(rng.standard_normal(n + 80), np.hanning(81) / np.hanning(81).sum(), "valid")[:n]
    drift = drift / (np.std(drift) + 1e-9) * 7 / 1200
    lf = lf + depth * np.sin(phase) + drift
    f0 = np.where(v, 2 ** lf, 0.0)
    y = pw.synthesize(f0, np.ascontiguousarray(sp), np.ascontiguousarray(ap), VSR, FP)
    return y, -lead


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
            beat += length + LINE_GAP
        beat += 2  # bar of breath between sections
    return lines, caps, beat + 10


CREW = [  # (voice, transpose, cents, timing offset s, gain)
    ("bm_george", 0, 0, 0.0, 1.0),
    ("bm_lewis", 0, 6, 0.018, 0.7),
    ("am_michael", 0, -5, -0.012, 0.6),
    ("am_onyx", -12, 3, 0.022, 0.5),   # the deep one
    ("bm_daniel", -5, -4, 0.01, 0.35),  # a fourth below, hollow harmony
]


def render_vocals(lines, n):
    left, right = np.zeros(n), np.zeros(n)
    for li, (start, mode, line) in enumerate(lines):
        singers = [CREW[0], CREW[3]] if mode == "solo" else CREW
        pans = [0.0, 0.3] if mode == "solo" else [0.0, -0.45, 0.45, -0.15, 0.25]
        for si, ((voice, tr, cents, dt, gain), pan) in enumerate(zip(singers, pans)):
            if mode == "solo" and tr == -12:
                gain = 0.28  # a low ghost under the solo
            y, off = sing_line(line, voice, tr, cents, seed=li * 10 + si, tempo_jitter=0.012 if si else 0.0)
            mono = np.zeros(n)
            place(mono, to_sr(y) * gain, start + dt + off)
            left += mono * np.sqrt((1 - pan) / 2)
            right += mono * np.sqrt((1 + pan) / 2)
        print(f"  sang: {' '.join(w for w, _, _ in line)}", flush=True)
    return left, right


# ---------------------------------------------------------------- band

def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def drone(n, total_s):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for m, g in [(D3 - 24, 1.0), (A2 - 12, 0.6), (D3 - 12, 0.5), (F3 - 12, 0.12)]:
        f = midi_hz(m)
        for det in (-0.15, 0.0, 0.17):  # detuned saws, cello-ish section
            ph = (f + det) * t + 0.002 * np.sin(2 * np.pi * 0.11 * t)
            out += g * (2 * (ph % 1) - 1) / 3
    out = lp(out, 420, 4)
    swell = 0.6 + 0.4 * np.sin(2 * np.pi * t / (BEAT * 8) - np.pi / 2)
    env = np.clip(t / 6, 0, 1) * np.clip((total_s - t) / 5, 0, 1)
    return out * swell * env * 0.22


def drum(n, start_beat, end_beat):
    """A deep stomp on beats 1 and 3, with a muffled half-beat pickup now and then."""
    out = np.zeros(n)
    hit_len = int(0.7 * SR)
    th = np.arange(hit_len) / SR
    body = np.sin(2 * np.pi * (48 * th + 40 * (1 - np.exp(-th / 0.04)) * 0.04)) * np.exp(-th / 0.22)
    click = lp(RNG.standard_normal(hit_len), 900) * np.exp(-th / 0.015) * 0.5
    hit = body + click
    b = start_beat
    hits = []
    while b < end_beat:
        hits.append((b, 1.0 if (b - start_beat) % 4 == 0 else 0.7))
        if (b - start_beat) % 8 == 6:
            hits.append((b + 1.5, 0.45))
        b += 2
    for beat, g in hits:
        place(out, hit * g, beat * BEAT)
    return out * 0.55, [h[0] * BEAT for h in hits if h[1] == 1.0]


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


def reverb(x, secs=3.2, wet=0.32, seed=0):
    m = int(secs * SR)
    t = np.arange(m) / SR
    ir = np.random.default_rng(seed).standard_normal(m) * np.exp(-t * 6.9 / secs)
    ir = lp(ir, 3500)
    ir /= np.sqrt(np.sum(ir ** 2))
    return x * (1 - wet) + fftconvolve(x, ir)[: len(x)] * wet * 1.6


# ---------------------------------------------------------------- video

def grade(img):
    """Cold, dark, desaturated storm grade with a vignette."""
    a = np.asarray(img).astype(np.float32) / 255
    lum = a @ np.array([0.299, 0.587, 0.114], np.float32)
    a = lum[..., None] * 0.7 + a * 0.3
    a = np.clip((a - 0.5) * 1.35 + 0.5, 0, 1) ** 1.5
    a *= np.array([0.78, 0.9, 1.0], np.float32)
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h * 0.55) / (h / 2)) ** 2)
    a *= np.clip(1.15 - 0.55 * r ** 2, 0.15, 1)[..., None]
    # bruise the sky
    sky = np.clip(1 - yy / (h * 0.5), 0, 1)[..., None] ** 1.5
    a = a * (1 - 0.45 * sky)
    return a


def render_video(photo, wav_path, out_path, caps, total_s, flashes):
    W, H, FPS = 1080, 1440, 24
    src = Image.open(photo).convert("RGB")
    sw, sh = src.size
    scale = max(W / sw, H / sh) * 1.3
    big = src.resize((int(sw * scale), int(sh * scale)), Image.LANCZOS)
    graded = grade(big)
    bh, bw = graded.shape[:2]
    font = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf", 50)
    title_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", 56)
    grain_bank = [RNG.normal(0, 0.018, (H // 4, W // 4)).astype(np.float32) for _ in range(8)]

    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-i", wav_path, "-vf", "hqdn3d=2:2:4:4", "-c:v", "libx264", "-preset", "slow", "-crf", "26",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
         out_path], stdin=subprocess.PIPE)
    n_frames = int(total_s * FPS)
    # push in slowly towards the boat (centre ~ 0.55, 0.62 of the frame)
    for f in range(n_frames):
        t = f / FPS
        p = t / total_s
        ease = p * p * (3 - 2 * p)
        c = 1.28 - 0.28 * ease  # crop size in output-frame units; 1.3 is the whole image
        cw, ch = int(W * c), int(H * c)
        cx = bw * (0.5 + (0.56 - 0.5) * ease) + 6 * np.sin(2 * np.pi * t / 5.1)
        cy = bh * (0.5 + (0.6 - 0.5) * ease) + 9 * np.sin(2 * np.pi * t / 7.3)  # swell
        x0 = int(np.clip(cx - cw / 2, 0, bw - cw))
        y0 = int(np.clip(cy - ch / 2, 0, bh - ch))
        crop = graded[y0:y0 + ch, x0:x0 + cw]
        frame = np.asarray(Image.fromarray((crop * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR),
                           np.float32) / 255

        light = 0.92 + 0.05 * np.sin(2 * np.pi * t / 6.3) + 0.03 * np.sin(2 * np.pi * t / 1.9)
        light *= min(1, t / 3) * min(1, (total_s - t) / 3)  # fade in / out of black
        flash = sum(np.exp(-(t - ft) / 0.12) * (0.8 + 0.2 * np.sin(90 * (t - ft)))
                    for ft in flashes if 0 <= t - ft < 0.9)
        frame = frame * light + flash * 0.55 * np.array([0.85, 0.9, 1.0], np.float32)
        g = grain_bank[f % 8]
        frame += np.repeat(np.repeat(g, 4, 0), 4, 1)[..., None]
        img = Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8))

        d = ImageDraw.Draw(img, "RGBA")
        if t < INTRO_BEATS * BEAT:
            a = int(255 * np.clip(min(t - 1.5, INTRO_BEATS * BEAT - 0.5 - t), 0, 1))
            for txt, y, fnt in [("THE DERWENT RUNS DARK", 150, title_font), ("a shanty", 235, font)]:
                tw = d.textlength(txt, font=fnt)
                d.text(((W - tw) / 2, y), txt, font=fnt, fill=(225, 230, 235, a),
                       stroke_width=3, stroke_fill=(0, 0, 0, a))
        for c0, c1, text, mode in caps:
            if c0 <= t <= c1:
                a = int(255 * np.clip(min((t - c0) / 0.4, (c1 - t) / 0.4), 0, 1))
                fill = (215, 225, 235, a) if mode == "solo" else (235, 205, 160, a)
                tw = d.textlength(text, font=font)
                if tw > W - 80:
                    words = text.split()
                    half = len(words) // 2
                    rows = [" ".join(words[:half]), " ".join(words[half:])]
                else:
                    rows = [text]
                for i, row in enumerate(rows):
                    rw = d.textlength(row, font=font)
                    d.text(((W - rw) / 2, H - 230 + i * 62 - (len(rows) - 1) * 31), row, font=font,
                           fill=fill, stroke_width=3, stroke_fill=(0, 0, 0, a))
        ff.stdin.write(img.tobytes())
        if f % 240 == 0:
            print(f"  frame {f}/{n_frames}", flush=True)
    ff.stdin.close()
    ff.wait()


# ---------------------------------------------------------------- main

def main(photo, out_path):
    lines, caps, total_beats = build_timeline()
    total_s = total_beats * BEAT
    n = int(total_s * SR)
    print(f"song length {total_s:.1f}s")

    vl, vr = render_vocals(lines, n)
    vl, vr = reverb(vl, seed=1), reverb(vr, seed=2)

    last_line_end = (lines[-1][0] + sum(b for _, _, b in lines[-1][2]) * BEAT)
    drm, downbeats = drum(n, INTRO_BEATS - 4, last_line_end / BEAT + 1)
    flashes = [3.2] + [downbeats[i] for i in (6, 19, 33, 48) if i < len(downbeats)]
    band = drone(n, total_s) + sea(n) + creaks(n, total_s) + thunder(n, [f + 0.6 for f in flashes])
    drm = reverb(drm, 2.0, 0.25, seed=3)
    band_l, band_r = reverb(band + drm, 3.5, 0.3, seed=4), reverb(band + drm * 0.9, 3.5, 0.3, seed=5)

    left = vl * 1.0 + band_l
    right = vr * 1.0 + band_r
    stereo = np.stack([left, right], 1)
    stereo = np.tanh(stereo / np.max(np.abs(stereo)) * 1.6) * 0.89  # glue + limit
    stereo[-int(SR * 3):] *= np.linspace(1, 0, int(SR * 3))[:, None]

    wav_path = os.path.splitext(out_path)[0] + ".wav"
    with wave.open(wav_path, "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((stereo * 32767).astype(np.int16).tobytes())
    print("audio done; rendering video")
    render_video(photo, wav_path, out_path, caps, total_s, flashes)
    os.remove(wav_path)
    print("wrote", out_path)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
