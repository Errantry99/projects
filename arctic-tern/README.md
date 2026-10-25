# The Voyage of the Arctic Tern

A 12-second looping character film: the *Prompt Pack: Pixar to Clawd* formula rewritten for a
polar voyage. The prompt is in [PROMPT.md](PROMPT.md); the film is `arctic_tern.mp4`.

**Episode 1: The Stowaway** (60 s) is the next part: see [EPISODE1.md](EPISODE1.md).
**Episode 2: The Whale** (60 s) follows: see [EPISODE2.md](EPISODE2.md).
The intro and the episodes share `world.py` (models, materials, lights), `synth.py` (instruments,
effects and the series theme) and `episode_post.py` (titles, fades, encode).

## Run it

Needs Python 3.11 with `bpy` (Blender 5 as a module), numpy, scipy, pedalboard, pyloudnorm, pillow, and ffmpeg.

```sh
python scene.py                 # build/arctic_tern.blend, prints the fastest hop speed
python render.py stills 50 12   # 24 preview stills + contact sheets in build/stills
python render.py all 1 16       # full film, build/frames (≈10 s/frame on 4 CPU cores)
python sound.py                 # build/sound.wav, normalized to -14 LUFS
python post.py                  # title card, flash bloom, fades -> arctic_tern.mp4
```

`timeline.py` holds every event in seconds; the scene, the sound and the post step all read it.
