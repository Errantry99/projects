"""Composite the title card and the flash bloom over the rendered frames, fade through black,
then encode with the soundtrack.  python post.py -> arctic_tern.mp4"""
import json
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timeline as T  # noqa: E402

B = os.path.join(HERE, "build")
SRC, DST = os.path.join(B, "frames"), os.path.join(B, "post")
os.makedirs(DST, exist_ok=True)
W, H = Image.open(os.path.join(SRC, "0001.png")).size
SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def title_card():
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    small = ImageFont.truetype(SERIF, int(H * 0.042))
    big = ImageFont.truetype(SERIF, int(H * 0.115))
    lines = [("THE VOYAGE OF THE", small, H * 0.085), ("ARCTIC TERN", big, H * 0.165)]
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ds = ImageDraw.Draw(shadow)
    for text, font, y in lines:
        tw = d.textlength(text, font=font)
        ds.text(((W - tw) / 2 + 2, y + 3), text, font=font, fill=(0, 6, 20, 200))
        d.text(((W - tw) / 2, y), text, font=font, fill=(244, 240, 228, 255))
    shadow = shadow.filter(ImageFilter.GaussianBlur(H * 0.008))
    # a thin rule with a tern-red dot between the lines
    y = int(H * 0.15)
    d.line([(W * 0.38, y), (W * 0.62, y)], fill=(244, 240, 228, 160), width=max(1, H // 400))
    r = H * 0.006
    d.ellipse([W / 2 - r, y - r, W / 2 + r, y + r], fill=(205, 30, 20, 255))
    return Image.alpha_composite(shadow, card)


card = title_card()
track = {int(k): v for k, v in json.load(open(os.path.join(B, "flash_track.json"))).items()}
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

for f in range(1, T.FRAMES + 1):
    t = (f - 1) / T.FPS
    im = Image.open(os.path.join(SRC, f"{f:04d}.png")).convert("RGB")
    a = np.asarray(im).astype(np.float32) / 255

    # flash: headlight bloom at the eyes plus a brief lift of the whole frame
    k = math.exp(-((t - T.FLASH) / 0.07) ** 2) + 0.35 * math.exp(-max(0.0, t - T.FLASH) * 6) * (t >= T.FLASH)
    if k > 0.01 and f in track:
        glow = np.zeros((H, W), np.float32)
        for (ex, ey) in track[f]:
            d2 = ((xx - ex * W) ** 2 + (yy - ey * H) ** 2) / (H * 0.09) ** 2
            glow += np.exp(-d2) + 0.35 * np.exp(-d2 / 12)
        col = np.array([1.0, 0.86, 0.66], np.float32)
        a = 1 - (1 - a) * (1 - np.clip(glow[..., None] * col * k, 0, 1))
        a = 1 - (1 - a) * (1 - 0.35 * k * col)

    # title card fades in on the flash and stays
    ca = smooth((t - T.CARD_IN) / 0.5)
    if ca > 0:
        c = np.asarray(card).astype(np.float32) / 255
        al = c[..., 3:4] * ca
        a = a * (1 - al) + c[..., :3] * al

    fade = min(smooth((t - T.FADE_IN[0]) / (T.FADE_IN[1] - T.FADE_IN[0])),
               smooth((T.DURATION - t) / (T.FADE_OUT[1] - T.FADE_OUT[0])))
    a *= fade
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(DST, f"{f:04d}.png"))

out = os.path.join(HERE, "arctic_tern.mp4")
subprocess.run([
    "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(T.FPS), "-i", os.path.join(DST, "%04d.png"),
    "-i", os.path.join(B, "sound.wav"),
    "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p",
    "-c:v", "libx264", "-profile:v", "high", "-crf", "18", "-preset", "slow",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", out,
], check=True)
print("wrote", out)
