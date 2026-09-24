// Local extensions of core types. TODO(core): promote.

import type { Backend } from "@dcx/core";

/**
 * A Backend that can say which `model_v` a pin produces. Backends that append a settings digest
 * (wire, llm) return `modelVersionWithSettings(pin, settings)`, so the worker's anti-join uses
 * the same `model_v` the judgments rows will carry. Absent → the pin itself.
 * TODO(core): promote `modelVFor` onto `Backend`.
 */
export interface JudgeBackend extends Backend {
  modelVFor?(pin: string): string;
}

/** The `model_v` a backend writes for a pin (see JudgeBackend). */
export function modelVFor(be: Backend, pin: string): string {
  return (be as JudgeBackend).modelVFor?.(pin) ?? pin;
}
