# projects
learning projects

## channel

`channel.html` — a single self-contained HTML document (no network requests, no
external assets) implementing the Channel build plan v1: a writing surface whose
visuals and audio descend as you keep typing.

- **Depth model.** Twenty minutes of continuous writing carries depth 0 → 1.
  Two seconds of silence holds it (THINKING), thirty seconds starts a ⅓-speed
  decay (STOPPED), and typing again recovers at 2× up to the session's
  high-water mark.
- **Visuals.** Zoom eases from ~60 characters across to ~1.5 words, the
  background walks pastel → black on a perceptually even (Oklab) path, and the
  ink crossfades to a glowing ember once the page has gone dark.
- **Audio.** A 55 Hz drone that emerges with depth, plus an eighth-note pulse
  derived from your own typing rhythm — it appears only when you type evenly.
- **Ending.** Esc twice surfaces over a 4 s cooling ramp, then a summary screen.
  Nothing is saved; refreshing loses the text.

Every tuning constant lives in the single `CONFIG` object at the top of the
script, one per line. `CONFIG.timeScale` compresses session time for testing
and `CONFIG.debug` logs state transitions.

### Acceptance checks

```
npm i -g playwright        # or a local install
node channel.qa.mjs        # 72 checks across T1–T9
```

## wing ding

`wingding.html` — a browser game of light-wind wing foiling. One self-contained
HTML file: no network requests, no external assets, nothing to install.

Pump the wing and the board to get up on foil, then keep it flying.

| Keys | |
| --- | --- |
| `W` `S` / `↑` `↓` | lean forward / back (nose down / up) |
| `A` `D` / `←` `→` | shift weight left / right (roll balance) |
| `Space` | pump the board, one stroke per press |
| `K` / `Shift` | ding (pump) the wing, one stroke per press |
| `P` / `Esc`, `R`, `Q` | pause, restart, quit to title (from pause) |

Phones get on-screen pads.

- **Physics, abbreviated.** A 2D side view with a fixed 120 Hz step. The front
  wing's lift goes with speed² × angle of attack and stalls past ~14°. Sinking
  raises the angle of attack, which damps heave. The hull drags while it
  touches the water, and the mast and foil drag in proportion to how deep they
  sit. The nose rises as speed builds, so faster flight needs your weight
  forward. Roll is stable on the hull and an inverted pendulum on the foil.
- **Pumping.** Each press is one stroke with a force pulse. Strokes pressed
  faster than the stroke length come out weak (mashing doesn't work). A steady
  interval builds a rhythm bonus, and every stroke costs stamina.
- **Wipeouts.** The foil breaches (too high), you catch the nose (touch down
  nose-down at speed), or the board rolls over. Touching down gently just ends
  the flight.
- **Session.** Two minutes. Score is metres flown on foil, and the best score
  per condition (Chill / Normal / Gnarly) is kept in localStorage.

Every tuning constant is in the `CONFIG` object at the top of the script.
`window.wingding` is a debug handle: set `wingding.manual = true` to stop the
clock, then `wingding.step(n)` advances it.

### Acceptance checks

```
node wingding.qa.mjs                 # 87 checks across W1–W7
SHOTS=shots node wingding.qa.mjs     # …and save screenshots
```

Every check sends real key presses (or taps). Keyed sequences run on the
paused fixed-step clock, so every run is deterministic. One closed-loop
keyboard rider plays a whole session and has to score.
