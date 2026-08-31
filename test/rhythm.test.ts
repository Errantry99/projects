import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import { RhythmEngine } from "../src/core/rhythm.js";

function play(r: RhythmEngine, intervals: number[], startAt = 0): number {
  let t = startAt;
  r.push(t);
  for (const gap of intervals) {
    t += gap;
    r.push(t);
    r.update(t, gap);
  }
  return t;
}

describe("rhythm gain", () => {
  it("gives full gain for a metronomic hand", () => {
    const r = new RhythmEngine();
    play(r, Array(40).fill(150));
    expect(r.cv).toBeLessThan(0.01);
    expect(r.gain).toBeGreaterThan(0.97);
  });

  it("degrades smoothly as timing scatters", () => {
    const steady = new RhythmEngine();
    play(steady, Array(40).fill(150));

    const wobbly = new RhythmEngine();
    play(
      wobbly,
      Array.from({ length: 40 }, (_, i) => 150 + (i % 2 ? 60 : -60)),
    );

    const chaotic = new RhythmEngine();
    play(
      chaotic,
      Array.from({ length: 40 }, (_, i) => 60 + ((i * 137) % 700)),
    );

    expect(wobbly.cv).toBeGreaterThan(steady.cv);
    expect(chaotic.cv).toBeGreaterThan(wobbly.cv);
    expect(wobbly.gain).toBeLessThan(steady.gain);
    expect(chaotic.gain).toBeLessThan(wobbly.gain);
  });

  it("ramps in rather than popping in on the first few keystrokes", () => {
    const r = new RhythmEngine();
    play(r, Array(3).fill(150));
    expect(r.gain).toBeLessThan(1);
  });

  it("bleeds gain away during silence", () => {
    const r = new RhythmEngine();
    const t = play(r, Array(30).fill(150));
    expect(r.gain).toBeGreaterThan(0.9);
    for (let i = 1; i <= 20; i++) r.update(t + i * 500, 500);
    expect(r.gain).toBeLessThan(0.05);
  });
});

describe("the buffer", () => {
  it("never admits an interval longer than the pause threshold", () => {
    const r = new RhythmEngine();
    play(r, [120, 120, 120, 5_000, 120, 120]);
    expect(Math.max(...r.buffer)).toBeLessThanOrEqual(CONFIG.ikiMaxMs);
    expect(r.buffer).not.toContain(5_000);
  });

  it("stays capped at the configured length", () => {
    const r = new RhythmEngine();
    play(r, Array(200).fill(100));
    expect(r.buffer.length).toBe(CONFIG.ikiBufferSize);
  });

  it("forgets everything on reset", () => {
    const r = new RhythmEngine();
    play(r, Array(20).fill(150));
    r.reset();
    expect(r.buffer.length).toBe(0);
    expect(r.gain).toBe(0);
    expect(r.regularityScore()).toBe(0);
  });
});

describe("derived tempo", () => {
  it("folds any typing speed into the musical range and snaps it", () => {
    for (const iki of [80, 120, 150, 200, 340, 600, 1_200]) {
      const r = new RhythmEngine();
      play(r, Array(30).fill(iki));
      expect(r.tempoTarget).toBeGreaterThanOrEqual(CONFIG.bpmMin);
      expect(r.tempoTarget).toBeLessThanOrEqual(CONFIG.bpmMax);
      expect(r.tempoTarget % CONFIG.bpmSnap).toBe(0);
    }
  });

  it("holds a steady tempo under steady input", () => {
    const r = new RhythmEngine();
    const t = play(r, Array(30).fill(150));
    const first = r.tempoTarget;
    play(r, Array(30).fill(150), t);
    expect(r.tempoTarget).toBe(first);
  });

  it("glides to a new tempo rather than jumping", () => {
    const r = new RhythmEngine();
    let t = play(r, Array(30).fill(150));
    const from = r.bpm;
    t = play(r, Array(30).fill(300), t);
    if (r.tempoTarget !== from) {
      expect(r.bpm).not.toBe(r.tempoTarget); // still travelling
      for (let i = 1; i <= 60; i++) r.update(t + i * 100, 100);
      expect(r.bpm).toBe(r.tempoTarget); // arrived
    }
  });
});

describe("regularity", () => {
  it("scores a steady session near 100 and a scattered one low", () => {
    const steady = new RhythmEngine();
    play(steady, Array(40).fill(150));
    const scattered = new RhythmEngine();
    play(
      scattered,
      Array.from({ length: 40 }, (_, i) => 60 + ((i * 137) % 700)),
    );

    // The score has to discriminate; the exact number is a tuning choice,
    // so assert the gap rather than a magic threshold.
    expect(steady.regularityScore()).toBeGreaterThan(95);
    expect(scattered.regularityScore()).toBeLessThan(steady.regularityScore() - 25);
    for (const r of [steady, scattered]) {
      expect(r.regularityScore()).toBeGreaterThanOrEqual(0);
      expect(r.regularityScore()).toBeLessThanOrEqual(100);
    }
  });
});
