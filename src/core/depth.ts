import { CONFIG, type Config } from "../config.js";
import { clamp01 } from "./math.js";

export type State = "IDLE" | "WRITING" | "THINKING" | "STOPPED" | "SURFACING" | "SUMMARY";

export interface SessionSnapshot {
  readonly state: State;
  readonly depth: number;
  readonly highWater: number;
  readonly writingMs: number;
  readonly sinceKeyMs: number;
  readonly keystrokes: number;
  readonly longestRunMs: number;
}

export type TransitionListener = (from: State, to: State, session: SessionSnapshot) => void;

/**
 * The depth model: five states and one accumulator.
 *
 * This is the single source of truth for `depth` and `state` — the visuals,
 * audio and chrome are pure functions of it. Plugins read this and never
 * write it (architecture record, D4), which is why nothing here takes a
 * mutation from outside beyond `keystroke()` and the clock.
 */
export class DepthModel {
  state: State = "IDLE";
  depth = 0;
  highWater = 0;
  sinceKeyMs = 0;
  writingMs = 0;
  keystrokes = 0;
  surfacingMs = 0;
  runMs = 0;
  longestRunMs = 0;

  private lastKeyRealAt: number | null = null;
  private readonly listeners = new Set<TransitionListener>();

  constructor(private readonly config: Config = CONFIG) {}

  private get buildPerMs(): number {
    return 1 / (this.config.buildMinutes * 60 * 1000);
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      depth: this.depth,
      highWater: this.highWater,
      writingMs: this.writingMs,
      sinceKeyMs: this.sinceKeyMs,
      keystrokes: this.keystrokes,
      longestRunMs: this.longestRunMs,
    };
  }

  onTransition(listener: TransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(next: State): void {
    if (this.state === next) return;
    const from = this.state;
    this.state = next;
    if (this.config.debug) {
      console.log(`[channel] ${from} -> ${next} @ depth ${this.depth.toFixed(4)}`);
    }
    for (const listener of this.listeners) listener(from, next, this.snapshot());
  }

  /** Every printable keystroke and backspace. `nowMs` is real time. */
  keystroke(nowMs: number): void {
    const realGap = this.lastKeyRealAt === null ? 0 : Math.max(0, nowMs - this.lastKeyRealAt);
    if (this.state === "WRITING" && this.sinceKeyMs <= this.config.thinkingMs) {
      this.runMs += realGap; // an unbroken run, measured in real time
      if (this.runMs > this.longestRunMs) this.longestRunMs = this.runMs;
    } else {
      this.runMs = 0;
    }
    this.lastKeyRealAt = nowMs;
    this.sinceKeyMs = 0;
    this.keystrokes++;
    this.setState("WRITING");
  }

  /**
   * Advance the clock.
   *
   * Integrated in slices bounded by each threshold, so a slow frame — or a
   * large `timeScale` — can never overshoot a boundary and silently discard
   * the writing time that preceded it. Without this, one 250 ms frame at
   * timeScale 20 charges 5 scaled seconds of silence against writing that
   * had already happened.
   */
  advance(dtMs: number): void {
    if (this.state === "IDLE" || this.state === "SUMMARY") return;

    if (this.state === "SURFACING") {
      this.surfacingMs += dtMs;
      return;
    }

    const { thinkingMs, stoppedMs, decayRate, recoveryRate, maxFrameMs, timeScale } =
      this.config;
    let remaining = Math.min(dtMs, maxFrameMs) * timeScale;
    let guard = 0;

    while (remaining > 0 && guard++ < 8) {
      let step = remaining;

      if (this.state === "WRITING") {
        step = Math.min(step, Math.max(0, thinkingMs - this.sinceKeyMs));
        if (step <= 0) {
          this.setState("THINKING");
          continue;
        }
      } else if (this.state === "THINKING") {
        step = Math.min(step, Math.max(0, stoppedMs - this.sinceKeyMs));
        if (step <= 0) {
          this.setState("STOPPED");
          continue;
        }
      }

      if (this.state === "WRITING") {
        this.writingMs += step;
        const rate = this.buildPerMs * (this.depth < this.highWater ? recoveryRate : 1);
        this.depth = clamp01(this.depth + rate * step);
        if (this.depth > this.highWater) this.highWater = this.depth;
      } else if (this.state === "STOPPED") {
        this.depth = clamp01(this.depth - this.buildPerMs * decayRate * step);
      }
      // THINKING holds: depth is untouched, visuals freeze.

      this.sinceKeyMs += step;
      remaining -= step;
    }
  }

  begin(): void {
    this.setState("WRITING");
  }

  surface(): void {
    if (this.state === "IDLE" || this.state === "SURFACING" || this.state === "SUMMARY") return;
    this.surfacingMs = 0;
    this.setState("SURFACING");
  }

  /** The depth the visuals and audio render; cooling folds it back to zero. */
  renderDepth(): number {
    if (this.state !== "SURFACING") return this.depth;
    const t = clamp01(this.surfacingMs / this.config.surfacingMs);
    return this.depth * (1 - -(Math.cos(Math.PI * t) - 1) / 2);
  }

  phrase(depth = this.highWater): string {
    const { depthStops, depthPhrases } = this.config;
    for (let i = 0; i < depthStops.length; i++) {
      if (depth < (depthStops[i] as number)) return depthPhrases[i] as string;
    }
    return depthPhrases[depthStops.length] as string;
  }
}
