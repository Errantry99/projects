// Judge-local names for core types. `modelVFor` was promoted onto core's `Backend`.

import type { Backend } from "@dcx/core";

/** A judge backend. Kept as a name for existing callers; `modelVFor` now lives on `Backend`. */
export type JudgeBackend = Backend;

/** The `model_v` a backend writes for a pin (see `Backend.modelVFor`). */
export function modelVFor(be: Backend, pin: string): string {
  return be.modelVFor?.(pin) ?? pin;
}
