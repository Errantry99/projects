"""Render "The Derwent Runs Dark": an ominous sea shanty over a photo.

Vocals: a shantyman calls each verse and the crew chants the chorus, voiced by
Kokoro neural TTS with natural speech rhythm, slowed and deepened with Praat's
PSOLA; a synthesized wordless choir hums the melody beneath. Accompaniment
(drone, drum, sea, wind, thunder) is synthesized.
Video: the photo dissolves into a moving pencil sketch and back again, so the
first and last frames match and it loops.

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
#
# Stretching speech onto a melody always ends up sounding like a robot, so
# the voices here are never forced to sing. The shantyman and crew *chant*
# the words with their natural speech rhythm and intonation (lowered and
# slowed with Praat's PSOLA, which keeps the voice quality intact), while a
# wordless humming choir carries the tune underneath.

_tts = None


def tts():
    global _tts
    if _tts is None:
        from kokoro_onnx import Kokoro
        d = os.environ.get("KOKORO_DIR", "models")
        _tts = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"))
    return _tts


def line_text(line):
    return " ".join(w for w, _, _ in line)


def chant(text, voice, median_hz, slot, formant=0.9, pitch_range=1.0, speed=0.74):
    """Speak `text` slowly and darkly, fitted to at most `slot` seconds."""
    from parselmouth import Sound
    from parselmouth.praat import call
    lang = "en-gb" if voice.startswith("b") else "en-us"
    x, sr = tts().create(text, voice=voice, speed=speed, lang=lang)
    assert sr == VSR
    snd = Sound(x.astype(np.float64), sr)
    stretch = float(np.clip(slot / snd.duration, 0.9, 1.18))
    y = call(snd, "Change gender", 60, 400, formant, median_hz, pitch_range, stretch).values[0]
    env = np.convolve(np.abs(y), np.ones(240) / 240, mode="same")
    keep = np.nonzero(env > env.max() * 0.02)[0]
    y = y[max(keep[0] - 240, 0): keep[-1] + 480]
    return y / (np.sqrt(np.mean(y ** 2)) + 1e-9) * 0.1


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


CREW = [  # (voice, median Hz, formant, pitch range, timing offset s, gain, pan)
    ("bm_george", 92, 0.88, 0.7, 0.0, 1.0, 0.0),
    ("am_onyx", 74, 0.95, 0.6, 0.045, 0.8, -0.5),
    ("bm_lewis", 82, 0.92, 0.6, -0.03, 0.75, 0.45),
    ("am_michael", 98, 0.9, 0.6, 0.07, 0.6, -0.25),
    ("bm_daniel", 110, 0.93, 0.6, 0.02, 0.55, 0.3),
    ("am_adam", 87, 0.9, 0.6, -0.05, 0.5, 0.65),
]


def render_voices(lines, n):
    """The shantyman calls the verses; the whole crew chants the chorus."""
    left, right = np.zeros(n), np.zeros(n)
    for start, mode, line in lines:
        slot = sum(b for _, _, b in line) * BEAT * 0.92
        singers = CREW[:1] if mode == "solo" else CREW
        for voice, hz, formant, prange, dt, gain, pan in singers:
            if mode == "solo":
                prange = 1.0
            y = to_sr(chant(line_text(line), voice, hz, slot, formant, prange))
            mono = np.zeros(n)
            place(mono, y * gain, start + dt)
            left += mono * np.sqrt((1 - pan) / 2)
            right += mono * np.sqrt((1 + pan) / 2)
        print(f"  chanted: {line_text(line)}", flush=True)
    return left, right


# vowel formants (Hz, bandwidth Hz, gain) for the humming choir
VOWELS = {
    "oo": [(320, 80, 1.0), (800, 100, 0.35), (2400, 160, 0.06)],
    "ah": [(650, 90, 1.0), (1080, 110, 0.6), (2550, 170, 0.15)],
}


def hum(lines, n):
    """A wordless choir carrying the melody: 'oo' under verses, 'ah' under choruses."""
    ctl = 200  # control rate, Hz
    m = n * ctl // SR + 1
    note = np.full(m, np.nan)
    vowel = np.zeros(m)  # 0 = oo, 1 = ah
    gate = np.zeros(m)
    for start, mode, line in lines:
        t = start
        for _, notes, beats in line:
            d = beats * BEAT
            for j, nt in enumerate(notes):
                a = int((t + j * d / len(notes)) * ctl)
                b = int((t + (j + 1) * d / len(notes)) * ctl)
                note[a:b] = nt
            t += d
        a, b = int(start * ctl), int(t * ctl)
        gate[a:b] = 1
        vowel[a:b] = mode == "crew"
    # hold the last note through rests, glide ~120 ms between notes
    idx = np.where(~np.isnan(note), np.arange(m), 0)
    note = note[np.maximum.accumulate(idx)]
    note[np.isnan(note)] = D3
    k = np.hanning(49) / np.hanning(49).sum()
    note = np.convolve(np.pad(note, 24, mode="edge"), k, "valid")
    k2 = np.hanning(161) / np.hanning(161).sum()  # soft swells in and out of phrases
    gate = np.convolve(np.pad(gate, 80, mode="edge"), k2, "valid")
    vowel = np.convolve(np.pad(vowel, 80, mode="edge"), k2, "valid")
    tc = np.arange(m) / ctl
    ts = np.arange(n) / SR

    out_l, out_r = np.zeros(n), np.zeros(n)
    voices = [(0, -9), (0, 7), (0, -3), (0, 12), (-12, -5), (-12, 6), (7 - 12, 4), (-12, 0)]
    for vi, (octave, cents) in enumerate(voices):
        rng = np.random.default_rng(100 + vi)
        drift = np.convolve(rng.standard_normal(m + 200), np.hanning(201) / np.hanning(201).sum(), "valid")[:m]
        drift = drift / (drift.std() + 1e-9) * 6
        vib = 0.18 * np.sin(2 * np.pi * (4.8 + 0.6 * rng.random()) * tc + rng.uniform(0, 6))
        f0c = 440 * 2 ** ((note + octave - 69 + (cents + drift) / 100 + vib / 12) / 12)
        f0 = np.interp(ts, tc, f0c)
        phase = 2 * np.pi * np.cumsum(f0) / SR
        sig = np.zeros(n)
        for h in range(1, 40):  # additive voice: each harmonic weighted by the vowel's formants
            fh = f0c * h
            amp = np.zeros(m)
            for name, w in (("oo", 1 - vowel), ("ah", vowel)):
                for fc, bw, g in VOWELS[name]:
                    amp += w * g / (1 + ((fh - fc) / bw) ** 2)
            amp *= h ** -0.7 * (fh < 5000)
            sig += np.interp(ts, tc, amp) * np.sin(h * phase)
        breath = bp(rng.standard_normal(n), 400, 2600) * 0.04
        sig = (sig + breath) * np.interp(ts, tc, gate)
        pan = (vi / (len(voices) - 1)) * 1.4 - 0.7
        out_l += sig * np.sqrt((1 - pan) / 2)
        out_r += sig * np.sqrt((1 + pan) / 2)
    norm = 0.3 / (np.abs(out_l).max() + 1e-9)
    return out_l * norm, out_r * norm


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
#
# The photo dissolves into a charcoal pencil sketch, which then lives: its
# lines boil at 8 fps like hand-drawn animation, the water rolls, the clouds
# drift and the sails breathe. At the end the sketch dissolves back into the
# photo and the camera returns to where it began, so the video loops.

def smooth_noise(shape, sigma, seed):
    import cv2
    n = np.random.default_rng(seed).standard_normal(shape).astype(np.float32)
    n = cv2.GaussianBlur(n, (0, 0), sigma)
    return (n - n.min()) / (n.max() - n.min() + 1e-9)


def soft_box(h, w, x0, x1, y0, y1, feather):
    """1 inside a box given in image fractions, fading out over `feather` px."""
    import cv2
    m = np.zeros((h, w), np.float32)
    m[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)] = 1
    return cv2.GaussianBlur(m, (0, 0), feather)


def make_sketch(rgb):
    """Charcoal-on-grey-paper rendering of an RGB float image, plus an edge map."""
    import cv2
    h, w = rgb.shape[:2]
    gray = cv2.cvtColor((rgb * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    blur = cv2.GaussianBlur(1 - gray, (0, 0), 9)
    pencil = np.clip(gray / np.maximum(1 - blur, 1e-3), 0, 1)  # colour-dodge pencil shading
    g8 = (cv2.GaussianBlur(gray, (0, 0), 1.6) * 255).astype(np.uint8)
    edges = cv2.Canny(g8, 30, 90).astype(np.float32) / 255
    edges = cv2.GaussianBlur(cv2.dilate(edges, np.ones((2, 2), np.uint8)), (0, 0), 0.9)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    wob = 2.5 * smooth_noise((h, w), 30, 11) * 6
    hatch1 = (np.sin((xx + yy + wob) / 2.6) > 0.55) * np.clip((0.42 - gray) / 0.15, 0, 1)
    hatch2 = (np.sin((xx - yy + wob) / 2.9) > 0.6) * np.clip((0.24 - gray) / 0.12, 0, 1)
    tone = pencil ** 2.2
    s = tone * (1 - 0.8 * np.clip(edges * 1.6, 0, 1)) * (1 - 0.45 * hatch1) * (1 - 0.5 * hatch2)
    paper = 0.9 + 0.1 * smooth_noise((h, w), 1.2, 12) - 0.05 * smooth_noise((h, w), 40, 13)
    s = s * paper
    # storm: darken the edges and bruise the sky
    r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h * 0.55) / (h / 2)) ** 2)
    s = s * np.clip(1.12 - 0.5 * r ** 2, 0.2, 1) * (1 - 0.35 * np.clip(1 - yy / (h * 0.45), 0, 1) ** 2)
    sketch = s[..., None] * np.array([0.86, 0.88, 0.92], np.float32)  # cold grey paper
    return sketch.astype(np.float32), edges


def render_video(photo, wav_path, out_path, caps, total_s, flashes, sketch_span):
    import cv2
    W, H, FPS = 1080, 1440, 24
    src = Image.open(photo).convert("RGB")
    sw, sh = src.size
    scale = max(W / sw, H / sh) * 1.3
    big = np.asarray(src.resize((int(sw * scale), int(sh * scale)), Image.LANCZOS), np.float32) / 255
    bh, bw = big.shape[:2]
    sketch, edges = make_sketch(big)
    # where the sketch appears first: along the strong lines, in drifting blotches
    edge_density = cv2.GaussianBlur(edges, (0, 0), 14)
    reveal = 0.6 * smooth_noise((bh, bw), 28, 14) + 0.4 * (1 - edge_density / (edge_density.max() + 1e-9))
    reveal = (reveal - reveal.min()) / (reveal.max() - reveal.min())

    # regions that move differently (fractions of the photo)
    water = np.clip((np.mgrid[0:bh, 0:bw][0] / bh - 0.52) / 0.12, 0, 1).astype(np.float32)
    hull = soft_box(bh, bw, 0.2, 0.92, 0.5, 0.71, 18)
    sails = soft_box(bh, bw, 0.38, 1.0, 0.0, 0.64, 22)
    water = water * (1 - hull)
    sky = np.clip(1 - np.mgrid[0:bh, 0:bw][0] / (bh * 0.47), 0, 1).astype(np.float32) * (1 - sails)
    boil = [(smooth_noise((bh, bw), 6, 20 + i) - 0.5, smooth_noise((bh, bw), 6, 30 + i) - 0.5) for i in range(3)]
    yy, xx = np.mgrid[0:bh, 0:bw].astype(np.float32)

    font = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf", 50)
    title_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", 56)
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-i", wav_path, "-c:v", "libx264", "-preset", "slow", "-crf", "24",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
         out_path], stdin=subprocess.PIPE)
    (in0, in1), (out0, out1) = sketch_span
    n_frames = int(round(total_s * FPS))
    for f in range(n_frames):
        t = f / FPS
        # camera: in towards the boat and back, ending exactly where it began
        e = (1 - np.cos(2 * np.pi * t / total_s)) / 2
        c = 1.28 - 0.22 * e
        cw, ch = W * c, H * c
        cx = bw * (0.5 + 0.06 * e) + 5 * np.sin(2 * np.pi * 7 * t / total_s)
        cy = bh * (0.5 + 0.08 * e) + 8 * np.sin(2 * np.pi * 11 * t / total_s)
        x0, y0 = np.clip(cx - cw / 2, 0, bw - cw), np.clip(cy - ch / 2, 0, bh - ch)
        cam = np.float32([[cw / W, 0, x0], [0, ch / H, y0]])
        photo_f = cv2.warpAffine(big, cam, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)

        # how much of the frame is sketch
        if t < in0 or t > out1:
            amount = 0.0
        elif t < in1:
            amount = (t - in0) / (in1 - in0)
        elif t > out0:
            amount = 1 - (t - out0) / (out1 - out0)
        else:
            amount = 1.0
        frame = photo_f
        if amount > 0:
            # displacement in photo pixels: boiling lines, rolling water, drifting sky, breathing sails
            bx, by = boil[(f // 3) % 3]
            dx = 2.2 * bx * 2
            dy = 2.2 * by * 2
            persp = water * (0.4 + 1.6 * (yy / bh - 0.52) / 0.48)
            dx = dx + persp * 5 * np.sin(2 * np.pi * (yy / 38 - t / 3.1))
            dy = dy + persp * 4 * np.sin(2 * np.pi * (xx / 210 + yy / 70 - t / 2.4))
            dx = dx + sky * 14 * np.sin(2 * np.pi * (t / 13 + yy / 400))
            dy = dy + sky * 3 * np.sin(2 * np.pi * (t / 7 + xx / 500))
            dx = dx + sails * 1.6 * np.sin(2 * np.pi * (t / 1.7 + yy / 160))
            mx, my = (xx + dx).astype(np.float32), (yy + dy).astype(np.float32)
            moving = cv2.remap(sketch, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
            sk = cv2.warpAffine(moving, cam, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
            if amount < 1:
                rv = cv2.warpAffine(reveal, cam, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
                mask = np.clip((amount * 1.25 - rv) / 0.25, 0, 1)[..., None]
                frame = photo_f * (1 - mask) + sk * mask
            else:
                frame = sk
            # lightning turns the drawing to a negative for an instant
            flash = sum(np.exp(-(t - ft) / 0.12) for ft in flashes if 0 <= t - ft < 0.9)
            if flash > 0.01:
                neg = (1 - frame) * np.array([0.85, 0.92, 1.0], np.float32)
                frame = frame + (neg - frame) * min(flash * 1.6, 1) * amount
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
    """Return (stereo float array, captions, total seconds, lightning times, last sung second)."""
    lines, caps, total_beats = build_timeline()
    total_s = total_beats * BEAT
    n = int(total_s * SR)
    print(f"song length {total_s:.1f}s")

    vl, vr = render_voices(lines, n)
    vl, vr = reverb(vl, 2.6, 0.26, seed=1), reverb(vr, 2.6, 0.26, seed=2)
    print("humming")
    hl, hr = hum(lines, n)
    vl += reverb(hl, 4.0, 0.5, seed=6)
    vr += reverb(hr, 4.0, 0.5, seed=7)

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
    stereo[:int(SR * 0.5)] *= np.linspace(0, 1, int(SR * 0.5))[:, None]
    return stereo, caps, total_s, flashes, last_line_end


def main(photo, out_path):
    stereo, caps, total_s, flashes, last_line_end = make_audio()
    wav_path = os.path.splitext(out_path)[0] + ".wav"
    with wave.open(wav_path, "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((stereo * 32767).astype(np.int16).tobytes())
    print("audio done; rendering video")
    span = ((2.0, 6.5), (last_line_end + 1.0, last_line_end + 5.5))
    render_video(photo, wav_path, out_path, caps, total_s, flashes, span)
    os.remove(wav_path)
    print("wrote", out_path)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
