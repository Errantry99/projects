"""Render frames from the built .blend.
    python render.py all [start] [spp]    -> build/frames/####.png (full film)
    python render.py stills 50 16         -> 24 stills at 50% res, 16 samples, plus a contact sheet
    python render.py frames 121,205 100   -> chosen frames, timed"""
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timeline as T  # noqa: E402

bpy.ops.wm.open_mainfile(filepath=os.path.join(HERE, "build", "arctic_tern.blend"))
scene = bpy.context.scene
scene.render.threads_mode = 'AUTO'
mode = sys.argv[1]

if mode == "all":
    scene.render.filepath = os.path.join(HERE, "build", "frames", "")
    start = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    scene.cycles.samples = int(sys.argv[3]) if len(sys.argv) > 3 else 16
    scene.frame_start = start
    bpy.ops.render.render(animation=True)
    sys.exit(0)

pct = int(sys.argv[3] if mode == "frames" else sys.argv[2])
scene.render.resolution_percentage = pct
if mode == "stills":
    scene.cycles.samples = int(sys.argv[3])
    frames = [1 + round(i * (T.FRAMES - 1) / 23) for i in range(24)]
else:
    frames = [int(x) for x in sys.argv[2].split(",")]

outdir = os.path.join(HERE, "build", mode)
os.makedirs(outdir, exist_ok=True)
paths = []
for f in frames:
    scene.frame_set(f)
    scene.render.filepath = os.path.join(outdir, f"{f:04d}.png")
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"frame {f}: {time.time() - t0:.1f} s", flush=True)
    paths.append((f, scene.render.filepath))

if mode == "stills":
    from PIL import Image, ImageDraw

    ims = [(f, Image.open(p)) for f, p in paths]
    w, h = ims[0][1].size
    for half in (0, 1):
        sheet = Image.new("RGB", (w * 4, h * 3), "black")
        for k, (f, im) in enumerate(ims[half * 12:(half + 1) * 12]):
            x, y = (k % 4) * w, (k // 4) * h
            sheet.paste(im.convert("RGB"), (x, y))
            ImageDraw.Draw(sheet).text((x + 6, y + 4), f"f{f} {(f - 1) / T.FPS:.2f}s", fill="yellow")
        sheet.save(os.path.join(outdir, f"sheet{half + 1}.png"))
