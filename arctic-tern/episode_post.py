"""Shared episode post step: an opening caption, the end card, fades through black, then the encode
with the soundtrack. Each episodeN_post.py calls run()."""
import os
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
INK, SHADE, TERN_RED = (244, 240, 228, 255), (0, 6, 20, 200), (205, 30, 20, 255)


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def card(size, lines, rule_y=None):
    """Centred lines of (text, size as a fraction of height, y as a fraction of height) with a soft shadow."""
    W, H = size
    ink = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d, ds = ImageDraw.Draw(ink), ImageDraw.Draw(shadow)
    for text, fs, y in lines:
        font = ImageFont.truetype(SERIF, int(H * fs))
        tw = d.textlength(text, font=font)
        ds.text(((W - tw) / 2 + 2, H * y + 3), text, font=font, fill=SHADE)
        d.text(((W - tw) / 2, H * y), text, font=font, fill=INK)
    if rule_y is not None:
        y, r = int(H * rule_y), H * 0.006
        d.line([(W * 0.4, y), (W * 0.6, y)], fill=INK[:3] + (160,), width=max(1, H // 400))
        d.ellipse([W / 2 - r, y - r, W / 2 + r, y + r], fill=TERN_RED)
    return np.asarray(Image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(H * 0.008)), ink)).astype(np.float32) / 255


def over(a, c, alpha):
    al = c[..., 3:4] * alpha
    return a * (1 - al) + c[..., :3] * al


def run(T, stem, opening_lines, ending_lines, out_name, frames=None):
    """Composite build/<stem>/frames into build/<stem>/post and encode <out_name> (skipped when frames is given)."""
    B = os.path.join(HERE, "build", stem)
    src, dst = os.path.join(B, "frames"), os.path.join(B, "post")
    os.makedirs(dst, exist_ok=True)
    size = Image.open(os.path.join(src, "0001.png")).size
    opening = card(size, opening_lines)
    ending = card(size, ending_lines, rule_y=ending_lines[0][2] + 0.055)
    for f in frames or range(1, T.FRAMES + 1):
        t = (f - 1) / T.FPS
        a = np.asarray(Image.open(os.path.join(src, f"{f:04d}.png")).convert("RGB")).astype(np.float32) / 255
        oa = smooth((t - T.OPEN_TITLE[0]) / 0.5) * (1 - smooth((t - T.OPEN_TITLE[1] + 0.5) / 0.5))
        if oa > 0:
            a = over(a, opening, oa)
        ca = smooth((t - T.CARD_IN) / 0.6)
        if ca > 0:
            a = over(a, ending, ca)
        fade = min(smooth(t / T.FADE_IN[1]), smooth((T.DURATION - t) / (T.FADE_OUT[1] - T.FADE_OUT[0])))
        Image.fromarray((np.clip(a * fade, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(dst, f"{f:04d}.png"))
    if frames:
        return
    out = os.path.join(HERE, out_name)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(T.FPS), "-i", os.path.join(dst, "%04d.png"),
        "-i", os.path.join(B, "sound.wav"),
        "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p",
        "-c:v", "libx264", "-profile:v", "high", "-crf", "20", "-preset", "slow",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", out,
    ], check=True)
    print("wrote", out)
