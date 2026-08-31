import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import { DepthModel, type State } from "../src/core/depth.js";

const cfg = (over: Partial<typeof CONFIG> = {}) => ({ ...CONFIG, ...over });
const BUILD_PER_MS = 1 / (CONFIG.buildMinutes * 60 * 1000);

/** Type continuously for `ms`, one keystroke every `everyMs`, in `stepMs` frames. */
function typeFor(m: DepthModel, ms: number, everyMs = 100, stepMs = 16) {
  let t = 0;
  let nextKey = 0;
  while (t < ms) {
    if (t >= nextKey) {
      m.keystroke(t);
      nextKey += everyMs;
    }
    const step = Math.min(stepMs, nextKey - t, ms - t);
    m.advance(step);
    t += step;
  }
}

describe("state machine", () => {
  it("holds WRITING inside the 2 s threshold and crosses at it", () => {
    const m = new DepthModel();
    m.keystroke(0);
    m.advance(1999);
    expect(m.state).toBe<State>("WRITING");
    m.advance(2);
    expect(m.state).toBe<State>("THINKING");
  });

  it("crosses to STOPPED at 30 s of silence", () => {
    const m = new DepthModel();
    m.keystroke(0);
    m.advance(29_999);
    expect(m.state).toBe<State>("THINKING");
    m.advance(2);
    expect(m.state).toBe<State>("STOPPED");
  });

  it("freezes depth in THINKING", () => {
    const m = new DepthModel();
    m.keystroke(0);
    m.advance(2_000);
    const held = m.depth;
    m.advance(20_000);
    expect(m.state).toBe<State>("THINKING");
    expect(m.depth).toBe(held);
  });

  it("reports transitions to listeners", () => {
    const m = new DepthModel();
    const seen: string[] = [];
    m.onTransition((from, to) => seen.push(`${from}->${to}`));
    m.keystroke(0);
    m.advance(2_001);
    m.advance(28_001);
    expect(seen).toEqual(["IDLE->WRITING", "WRITING->THINKING", "THINKING->STOPPED"]);
  });
});

describe("depth accumulator", () => {
  it("reaches exactly 1.0 after 20 minutes of unbroken writing", () => {
    const m = new DepthModel();
    typeFor(m, CONFIG.buildMinutes * 60 * 1000);
    expect(m.depth).toBeCloseTo(1, 6);
    expect(m.highWater).toBeCloseTo(1, 6);
  });

  it("builds at 1x above the high-water mark", () => {
    const m = new DepthModel();
    m.depth = 0.6;
    m.highWater = 0.5;
    m.keystroke(0);
    const before = m.depth;
    m.advance(1_000);
    expect((m.depth - before) / (BUILD_PER_MS * 1_000)).toBeCloseTo(1, 6);
  });

  it("recovers at 2x below the high-water mark", () => {
    const m = new DepthModel();
    m.depth = 0.2;
    m.highWater = 0.5;
    m.keystroke(0);
    const before = m.depth;
    m.advance(1_000);
    expect((m.depth - before) / (BUILD_PER_MS * 1_000)).toBeCloseTo(2, 6);
  });

  it("decays at one third speed in STOPPED", () => {
    const m = new DepthModel();
    m.depth = 0.6;
    m.keystroke(0);
    m.advance(30_001); // into STOPPED
    const before = m.depth;
    m.advance(10_000);
    expect((before - m.depth) / (BUILD_PER_MS * 10_000)).toBeCloseTo(1 / 3, 6);
  });

  it("never exceeds 1 or falls below 0", () => {
    const m = new DepthModel();
    typeFor(m, 40 * 60 * 1000);
    expect(m.depth).toBe(1);
    // `maxFrameMs` caps how much one frame may credit, so a long absence
    // decays over several frames rather than all at once.
    for (let i = 0; i < 200; i++) m.advance(CONFIG.maxFrameMs);
    expect(m.depth).toBe(0);
  });

  it("caps how much a single enormous frame may credit", () => {
    const m = new DepthModel();
    m.depth = 1;
    m.keystroke(0);
    m.advance(10 * 60 * 60 * 1000); // a lid closed for ten hours, one frame
    const decayed = 1 - m.depth;
    const most = CONFIG.maxFrameMs * BUILD_PER_MS * CONFIG.decayRate;
    expect(decayed).toBeLessThanOrEqual(most + 1e-9);
  });
});

describe("sliced integration", () => {
  // The regression this guards: a single slow frame used to charge its whole
  // duration as silence, discarding the writing time before the threshold.
  it("credits the writing time inside a frame that overshoots the threshold", () => {
    const m = new DepthModel(cfg({ timeScale: 20 }));
    m.keystroke(0);
    m.advance(250); // 5 000 scaled ms — well past the 2 000 ms threshold
    expect(m.state).toBe<State>("THINKING");
    expect(m.depth).toBeCloseTo(BUILD_PER_MS * CONFIG.thinkingMs, 9);
  });

  it("gives the same depth for one big frame as for many small ones", () => {
    const coarse = new DepthModel();
    const fine = new DepthModel();
    coarse.keystroke(0);
    fine.keystroke(0);
    coarse.advance(45_000);
    for (let i = 0; i < 45_000 / 15; i++) fine.advance(15);
    expect(coarse.depth).toBeCloseTo(fine.depth, 9);
    expect(coarse.state).toBe(fine.state);
  });

  it("reaches depth 1.0 at timeScale 20 in one twentieth of the time", () => {
    const m = new DepthModel(cfg({ timeScale: 20 }));
    typeFor(m, (CONFIG.buildMinutes * 60 * 1000) / 20, 50, 16);
    expect(m.depth).toBeCloseTo(1, 4);
  });
});

describe("runs and phrases", () => {
  it("measures the longest unbroken run and resets it on a pause", () => {
    const m = new DepthModel();
    for (let t = 0; t <= 3_000; t += 100) {
      m.keystroke(t);
      m.advance(100);
    }
    expect(m.longestRunMs).toBeCloseTo(3_000, 0);
    m.advance(5_000); // a pause longer than the threshold
    m.keystroke(8_100);
    expect(m.longestRunMs).toBeCloseTo(3_000, 0); // preserved, not extended
  });

  it("names the depth band", () => {
    const m = new DepthModel();
    expect(m.phrase(0.1)).toBe("surface");
    expect(m.phrase(0.4)).toBe("descending");
    expect(m.phrase(0.7)).toBe("deep");
    expect(m.phrase(0.95)).toBe("channel");
  });
});
