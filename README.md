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
