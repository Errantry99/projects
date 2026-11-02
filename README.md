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
| `K` / `J` (`X` with arrows) | ding (pump) the wing, one stroke per press |
| `P` / `Esc`, `R`, `Q`, `M` | pause, restart, quit to title (from pause), sound on/off |

Phones get on-screen pads, and they work multi-touch, so you can hold a lean
while you pump. The menus work with Tab, Space and Enter.

- **Physics, abbreviated.** A 2D side view with a fixed 120 Hz step. The front
  wing's lift goes with speed² × angle of attack and stalls past ~14°. Sinking
  raises the angle of attack, which damps heave. The hull drags while it
  touches the water, and the mast and foil drag in proportion to how deep they
  sit. The nose rises as speed builds, so faster flight needs your weight
  forward. Roll is stable on the hull and an inverted pendulum on the foil.
- **Pumping.** Each press is one stroke with a force pulse. Strokes pressed
  faster than the stroke length come out weak (mashing doesn't work). A steady
  interval builds a rhythm bonus, and every stroke costs stamina.
- **Coaching.** One line at a time, picking whichever failure is coming
  soonest. Warnings look ahead (where height and roll are heading), so a roll
  warning comes about a second before the fall. They stay quiet while you are
  already correcting. Before takeoff the line coaches the basics: rhythm, and
  leaning back to lift off.
- **Sound.** Synthesised in the page. The wing whoosh rises with your rhythm
  streak, board pumps thump, and the water hiss and foil hum follow the board.
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
node wingding.qa.mjs                 # every check, W1–W8
SHOTS=shots node wingding.qa.mjs     # …and save screenshots
```

Every check sends real key presses (or taps). Keyed sequences run on the
paused fixed-step clock, so every run is deterministic. One closed-loop
keyboard rider plays a whole session and has to score. The suite also covers
warning lead time and noise, measured sound output, multi-touch, keyboard
navigation of the menus, and HUD layout on five screen sizes.

## derwent crossing

`derwent.html` — a 3D prototype of Wing Ding without the wing: cross the Derwent
at Hobart on a pump foil. One self-contained HTML file: WebGL 2, no network
requests, no external assets, nothing to install.

Lie on the board and paddle, pop up once you're fast enough, then pump to stay
on foil. Wind chop and the Bellerive ferry's wake are free energy. Fall off and
you're back on your belly, paddling.

| Keys | |
| --- | --- |
| `Space` | paddle (lying down) or pump (standing), one stroke per press |
| `E` / `Shift` | pop up: hold to get to your knees, release to stand |
| `W` `S` / `↑` `↓` | lean forward / back |
| `A` `D` / `←` `→` | weight left / right: steer, carve, balance |
| `C`, `P` / `Esc`, `R`, `Q`, `M` | camera (chase, underwater cutaway, drone), pause, restart, quit to title (from pause), sound |

Gamepads work too: left stick leans, either trigger strokes, A pops up, Y
changes camera, Start pauses, and the pad rumbles with each stroke and when a
wave lifts your tail.

- **Events.** The Crossing (Sandy Bay to Bellerive, against the clock), Ferry
  Wake (90 s to ride the ferry's wake as far as you can) and Paddle-up (3 min of
  pop-up and pumping practice). Each runs in Glassy dawn, Sea breeze or Westerly
  conditions, and the best result per event and condition is kept.
- **Prone.** Paddle strokes are force pulses that weaken as you speed up, so
  a steady 0.5–0.7 s rhythm tops out just past pop-up speed (2.4 m/s) on flat
  water. Mashing or lazy strokes never get there. Catching a bump does, easily.
- **The pop-up.** Hold, then release. Let go too soon and you slip off. Pop up
  too slowly and the board sinks. Hold too long and you stand up late.
- **Standing.** Wing Ding's foil (lift, stall, drag, pitch that follows your
  lean, roll as an inverted pendulum), on a bigger paddle-up foil with no wing.
  Banking the foil carves a turn, and the carve helps hold you up.
- **Waves.** The board measures its height against the actual surface, not
  flat water. Gravity along the face pushes you on, and rising water under the
  foil adds lift. Riding the ferry's wake with no pumping glides several times
  as far as on flat water. The chop swells in sets. The HUD calls sets and
  wakes before they reach you.
- **The river.** Stylised from the real shoreline, with distances shrunk to 45%
  (`CONFIG.mapScale`). It has kunanyi, the Tasman Bridge, Wrest Point, the
  ferry on a timetable between Brooke Street Pier and Bellerive, moored yachts,
  channel markers, a ship at the wharf and a shelving bottom near the shore.
  The landmarks are approximate.

The simulation lives in its own `<script id="derwent-sim">` block with no DOM in
it: the page drives it, and so can node. That block is what a C++ port (for an
Unreal version) would start from. Every tuning constant is in its `CONFIG`.
The water shader sums exactly the same waves as the physics. `window.derwent`
is a debug handle: set `derwent.manual = true` to stop the clock, then
`derwent.step(n)` advances it.

### Acceptance checks

```
node derwent.qa.mjs                  # every check, D0–D10
SHOTS=shots node derwent.qa.mjs      # …and save screenshots
```

D0 runs the simulation headless in node. The rest drive the page with real key
presses on the paused fixed-step clock: paddling rhythm, the pop-up, a
closed-loop keyboard rider that pumps onto the foil and stays up, breach
warnings, waves as free energy, carving, the ferry, the shallows, finishing a
crossing, determinism, and HUD layout on five screen sizes.
