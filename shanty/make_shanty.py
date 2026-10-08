"""Render "The Derwent Runs Dark": an ominous sea shanty sung over a photo.

Vocals: espeak-ng/MBROLA speech, re-pitched and time-stretched onto a melody
with the WORLD vocoder. Accompaniment (drone, drum, sea, wind) is synthesized.
Video: slow push-in on the photo, storm grade, lightning, burned-in lyrics.

usage: python3 make_shanty.py <photo.jpg> <out.mp4>
"""

import os
import subprocess
import sys
import tempfile
import wave

import numpy as np
import pyworld as pw
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

SR = 44100
VSR = 16000  # MBROLA output rate
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

_cache = {}


def speak(word, voice):
    key = (word, voice)
    if key not in _cache:
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:
            subprocess.run(["espeak-ng", "-v", voice, "-s", "95", "-w", f.name, word.strip(",.")],
                           check=True, capture_output=True)
            with wave.open(f.name) as w:
                assert w.getframerate() == VSR
                x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float64) / 32768
        nz = np.nonzero(np.abs(x) > 0.01)[0]
        x = x[max(nz[0] - 80, 0): nz[-1] + 80] if len(nz) else x
        f0, t = pw.harvest(x, VSR, f0_floor=60, frame_period=5.0)
        sp = pw.cheaptrick(x, f0, t, VSR)
        ap = pw.d4c(x, f0, t, VSR)
        _cache[key] = (f0, sp, ap)
    return _cache[key]


def sing(word, notes, dur, voice, transpose=0, cents=0.0, growl=0.0):
    """Return a mono VSR signal of `word` sung on `notes` lasting ~dur seconds."""
    f0, sp, ap = speak(word, voice)
    n_src = len(f0)
    voiced = f0 > 0
    if not voiced.any():
        voiced[:] = True
    n_out = max(int(dur * 0.92 / 0.005), 8)
    n_unv = (~voiced).sum()
    k = max((n_out - n_unv) / max(voiced.sum(), 1), 0.35)
    w = np.where(voiced, k, 1.0)
    cum = np.concatenate([[0], np.cumsum(w)])
    n_out = int(cum[-1])
    pos = np.interp(np.arange(n_out) + 0.5, cum, np.arange(n_src + 1)) - 0.5
    pos = np.clip(pos, 0, n_src - 1)
    i0 = np.floor(pos).astype(int)
    i1 = np.minimum(i0 + 1, n_src - 1)
    fr = (pos - i0)[:, None]
    sp_o = np.exp(np.log(sp[i0] + 1e-12) * (1 - fr) + np.log(sp[i1] + 1e-12) * fr)
    ap_o = ap[i0] * (1 - fr) + ap[i1] * fr
    v_o = voiced[np.rint(pos).astype(int)]

    # target pitch over the voiced span, with glide, vibrato and a little drift
    vi = np.nonzero(v_o)[0]
    lf = np.zeros(n_out)
    if len(vi):
        a, b = vi[0], vi[-1] + 1
        span = np.arange(n_out)
        frac = np.clip((span - a) / max(b - a, 1), 0, 0.999)
        idx = (frac * len(notes)).astype(int)
        lf = np.log2([midi_hz(notes[i] + transpose) for i in idx]) + cents / 1200
        lf = np.convolve(np.pad(lf, 6, mode="edge"), np.ones(13) / 13, mode="valid")
        t = np.arange(n_out) * 0.005
        vib = 0.35 / 12 * np.sin(2 * np.pi * 5.2 * t + RNG.uniform(0, 6)) * np.clip((t - 0.25) / 0.4, 0, 1)
        scoop = -0.6 / 12 * np.exp(-t / 0.06)  # sailors slide up into notes
        lf = lf + vib + scoop
    f0_o = np.where(v_o, 2 ** lf, 0.0)
    if growl:
        jitter = 1 + growl * RNG.standard_normal(n_out)
        f0_o = f0_o * np.clip(jitter, 0.9, 1.1)
        ap_o = np.clip(ap_o + growl * 2, 0, 1)
    y = pw.synthesize(f0_o, np.ascontiguousarray(sp_o), np.ascontiguousarray(ap_o), VSR, 5.0)
    fade = min(len(y) // 4, int(0.04 * VSR))
    if fade:
        y[-fade:] *= np.linspace(1, 0, fade)
    return y


def to_sr(y):
    return resample_poly(y, 441, 160)


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


CREW = [  # (voice, transpose, cents, timing offset s, gain, growl)
    ("mb-us2", 0, 0, 0.0, 1.0, 0.0),
    ("mb-us3", 0, 9, 0.025, 0.75, 0.01),
    ("mb-en1", 0, -8, -0.02, 0.7, 0.0),
    ("mb-us2", -12, 4, 0.035, 0.55, 0.015),   # the deep one
    ("mb-us3", -5, -6, 0.015, 0.35, 0.0),     # a fourth below, hollow harmony
]


def render_vocals(lines, n):
    left, right = np.zeros(n), np.zeros(n)
    for start, mode, line in lines:
        singers = CREW[:1] + [CREW[3]] if mode == "solo" else CREW
        pans = np.linspace(-0.6, 0.6, len(singers))
        for (voice, tr, cents, dt, gain, growl), pan in zip(singers, pans):
            if mode == "solo" and tr == -12:
                gain = 0.3  # a low ghost under the solo
            t = start + dt
            mono = np.zeros(n)
            for word, notes, beats in line:
                y = to_sr(sing(word, notes, beats * BEAT, voice, tr, cents, growl))
                place(mono, y * gain, t - 0.04)
                t += beats * BEAT
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
