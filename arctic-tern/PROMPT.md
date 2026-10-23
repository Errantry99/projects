# Prompt Pack: The Voyage of the Arctic Tern

Character film / 12 s / 16:9 / 24 fps / loop. Rewritten from *Prompt Pack: Pixar to Clawd*: same formula, new scene.

> A little ship sails a polar night sea, guided by its namesake bird. The tern gets tired,
> lands on the bow lantern and puts it out. Clawd climbs out of a barrel, crosses the ice
> one floe per beat, finds the passage with his eye beams and sets the sky alight. The
> tern wakes up to find it's been replaced as navigator and flies off in a huff.

## The prompt (copy-ready)

Paste into Claude Code with Blender 5 (or `pip install bpy` on Python 3.11), Python (numpy, scipy, pedalboard, pillow) and ffmpeg.

```
BRAND
HERO: Clawd, the Claude Code mascot as one smooth toy: body 12x8x6 units, two side nubs,
four short legs, two black eye slits, soft rounded bevels, terracotta D97757, 0.26 m wide
BAND: a storybook polar voyage: a little single-masted wooden ship, the Arctic Tern, with a
square sail that carries a tern silhouette, a carved bow and a hanging bow lantern that is the
only warm light; a dark swelling sea, flat ice floes, one tall iceberg, an aurora curtain and
stars; a real arctic tern (white body, black cap, red bill, forked tail) circling the mast as
the ship's guide. Our own models, no book art, no borrowed text
RESULT: the tern falls asleep on the job, Clawd takes over the navigating, the aurora answers
him; the tern wakes, sees it's been replaced and flies off ahead in a huff
SET: ship 2 m long, mast 2.2 m; five floes in a line ahead of the bow, 0.6 m apart; the
iceberg 2 m tall beyond them; no visible horizon line, sea fades into the night

FORMAT: Blender 5 Python, Cycles, 12.0 s = 288 frames at 24 fps, 120 BPM (one beat = 12
frames), loops through black. One timeline.py holds every hop, landing and sound event in
seconds; the scene and the sound both read it.

BEATS (seconds):
0-2.5 the voyage, played straight: the ship glides left through the swell under the aurora,
the lantern swings, the tern circles the mast twice
2.5-3 the tern, tired, glides down onto the lantern hook: the lantern swings, gutters, goes out
3.0-4.5 dark and quiet; the tern tucks its head under and sleeps (it snores); a barrel lid
lifts, Clawd climbs out, looks at the bird, then a slow head turn to the lens
4.5-7 he hops off the bow onto the floes, one per beat; each landing sinks the floe, it bobs
back up glowing, and one band of aurora lights; the bob launches him to the next; a front
flip onto the fifth
7.3-8.5 on the last floe his eyes light into two beams, they sweep the iceberg right to left
to find the passage, then turn into the lens: a flash, the whole aurora flares
8.5-9.3 the title card: THE VOYAGE OF THE ARCTIC TERN fades in, happy eyes
9.4-11.5 the tern startles awake, the lantern sputters back on, it glares at Clawd out on the
ice, squawks, and flies off ahead of the ship in a huff; Clawd watches it go
11.5-12 fade to black; frame 1 starts the voyage again

CAMERA: low (0.9 m), three-quarter front, 35 mm, a slow dolly with the ship; push in on the
head turn; pull wide so the ship and all five floes stay in frame during the hops; hold on
the card.

LOOK: storybook night: cool moon rim from behind, the lantern as warm key until it dies,
then a soft cool fill; Clawd still measures D97757 on the lit body; filmic AgX; ice white
with a blue core; aurora teal to green, never white; hops under 2.6 m/s.

CHECKS: a contact sheet of 24 half-res stills first, measure exposure (p99, clipped %) and
the orange on Clawd, then two full frames timed, then the full render.
```

## Sound (copy-ready)

```
Add sound. Synthesize everything in Python with numpy, scipy and pedalboard: no samples, no
words, no borrowed melody. 48 kHz stereo, 12.0 s, read every event from timeline.py, land
each hit on its frame and pan it by where it happens.

Music, D minor, a sea-shanty lilt: low strings and a plucked bass (Karplus-Strong), a celesta
note each time the tern passes the mast. Everything stops dead when the lantern goes out:
1.4 s of sea and one snore, one celesta ding on the head turn. Then a bouncy 120 BPM pizzicato
bed on Dm Bb F A7, each floe landing plays the next note of D E F G A, a snare roll and a
cymbal swell under the beams, the full hit on the flash (timpani, crash, D major strings and
brass), a celesta arpeggio on the card. A descending fiddle as the tern flies off.

Effects: sea swell and hull creaks throughout, a lantern-swing squeak and a fizz as it dies,
a wooden barrel-lid clunk, splashy bloops on every floe, a power-up whoom and hum for the
beams, a sputter as the lantern relights, an indignant tern squawk.

Master: headroom first, gentle compressor, limiter at -1.5 dBFS; aim for about -14 LUFS.
```

## Every hit on its frame

Frame = time x 24 + 1. At 120 BPM every landing sits on a beat.

| Time | Frame | Picture | Sound |
|---|---|---|---|
| 0.0-2.5 s | f1-f61 | ship glides in, tern circles the mast | sea, shanty strings, celesta on each pass |
| 2.75 s | f67 | tern lands on the lantern hook | squeak, creak |
| 3.00 s | f73 | lantern goes out | fizz, music stops |
| 3.2-3.8 s | f78-f92 | barrel lid lifts, Clawd climbs out | clunk, snore |
| 3.85-4.45 s | f93-f108 | slow head turn to the lens | one celesta ding |
| 5.0 / 5.5 / 6.0 / 6.5 / 7.0 s | f121 / 133 / 145 / 157 / 169 | five floe landings, aurora bands light | bloop + D E F G A |
| 7.5-8.25 s | f181-f199 | eye beams sweep the iceberg | whoom, hum, snare roll |
| 8.50 s | f205 | beams hit the lens: flash, aurora flares | timpani, crash, D major |
| 8.55 s | f206 | title card fades in | celesta arpeggio |
| 9.45 s | f228 | tern startles awake, lantern sputters on | sputter, squawk |
| 10.0-10.3 s | f241-f248 | it glares at Clawd | grumpy squawk |
| 10.4-11.6 s | f250-f279 | it flies off ahead in a huff | descending fiddle |
| 11.55-12.0 s | f278-f288 | fade to black, loop | fade |
