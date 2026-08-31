import { CONFIG, type Config } from "../config.js";
import { clamp, clamp01, easeInOutSine, lerp, median, smoothstep } from "./math.js";

/**
 * The rhythm engine.
 *
 * Reads nothing but keystroke timing — no characters, no content. That is
 * what makes a `"text": "none"` plugin possible (architecture record, D5):
 * everything here can be exposed without disclosing a single word.
 */
export class RhythmEngine {
  readonly buffer: number[] = [];
  cv = 1;
  gain = 0;
  bpm: number;

  private gainTarget = 0;
  private lastKeyAt = 0;
  private bpmTarget: number;
  private bpmFrom: number;
  private glideStart = -1;
  private regularitySum = 0;
  private regularityCount = 0;

  constructor(private readonly config: Config = CONFIG) {
    this.bpm = config.bpmDefault;
    this.bpmTarget = config.bpmDefault;
    this.bpmFrom = config.bpmDefault;
  }

  reset(): void {
    this.buffer.length = 0;
    this.cv = 1;
    this.gain = 0;
    this.gainTarget = 0;
    this.lastKeyAt = 0;
    this.bpm = this.config.bpmDefault;
    this.bpmTarget = this.config.bpmDefault;
    this.bpmFrom = this.config.bpmDefault;
    this.glideStart = -1;
    this.regularitySum = 0;
    this.regularityCount = 0;
  }

  push(nowMs: number): void {
    if (this.lastKeyAt) {
      const iki = nowMs - this.lastKeyAt;
      // A pause is not a rhythm. Intervals past the threshold never enter
      // the buffer, so thinking time cannot masquerade as a slow tempo.
      if (iki > 0 && iki <= this.config.ikiMaxMs) {
        this.buffer.push(iki);
        if (this.buffer.length > this.config.ikiBufferSize) this.buffer.shift();
      }
    }
    this.lastKeyAt = nowMs;
    this.recompute(nowMs);
  }

  private recompute(nowMs: number): void {
    const n = this.buffer.length;
    if (n < 2) {
      this.gainTarget = 0;
      return;
    }

    const mean = this.buffer.reduce((a, b) => a + b, 0) / n;
    const variance = this.buffer.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    this.cv = mean > 0 ? Math.sqrt(variance) / mean : 1;

    const { cvLow, cvHigh, gainAtLowCV, gainAtHighCV, ikiMinSamples } = this.config;
    let g = lerp(gainAtLowCV, gainAtHighCV, smoothstep(cvLow, cvHigh, this.cv));
    if (n < ikiMinSamples) g *= n / ikiMinSamples; // ramp in, never pop in
    this.gainTarget = clamp01(g);

    this.regularitySum += clamp01(1 - smoothstep(cvLow, cvHigh, this.cv));
    this.regularityCount++;

    const med = median(this.buffer);
    if (med > 0) {
      const { bpmMin, bpmMax, bpmSnap, tempoGlideMs } = this.config;
      let bpm = 60_000 / med;
      while (bpm > bpmMax) bpm /= 2;
      while (bpm < bpmMin) bpm *= 2;
      bpm = clamp(bpm, bpmMin, bpmMax);
      const snapped = clamp(Math.round(bpm / bpmSnap) * bpmSnap, bpmMin, bpmMax);
      if (snapped !== this.bpmTarget) {
        this.bpmFrom = this.bpm;
        this.bpmTarget = snapped;
        this.glideStart = nowMs;
      }
      void tempoGlideMs;
    }
  }

  update(nowMs: number, dtMs: number): void {
    const idleMs = this.lastKeyAt ? nowMs - this.lastKeyAt : Number.POSITIVE_INFINITY;
    const silent = idleMs > this.config.ikiMaxMs;
    const target = silent ? 0 : this.gainTarget;
    const tau = silent ? this.config.gainSilenceDecayMs : this.config.gainSmoothingMs;
    this.gain += (target - this.gain) * (1 - Math.exp(-dtMs / tau));
    if (this.gain < 1e-4) this.gain = 0;

    if (this.glideStart >= 0) {
      const t = clamp01((nowMs - this.glideStart) / this.config.tempoGlideMs);
      this.bpm = lerp(this.bpmFrom, this.bpmTarget, easeInOutSine(t));
      if (t >= 1) {
        this.bpm = this.bpmTarget;
        this.glideStart = -1;
      }
    }
  }

  get tempoTarget(): number {
    return this.bpmTarget;
  }

  regularityScore(): number {
    if (!this.regularityCount) return 0;
    return Math.round((this.regularitySum / this.regularityCount) * 100);
  }
}
