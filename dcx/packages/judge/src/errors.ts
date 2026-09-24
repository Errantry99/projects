// Typed judge errors. Backends map transport/SDK failures onto these so the worker, the kernel
// and the router can react without knowing the backend (02 §3.7 "failure fallback").

import type { CacheKeyColumns } from "@dcx/core";

export type JudgeErrorCode =
  | "rate_limited"
  | "transient"
  | "permanent"
  | "protocol"
  | "aborted"
  | "budget"
  | "state_too_large"
  | "fixture_miss";

export class JudgeError extends Error {
  override name = "JudgeError";
  /** Attempts made (1 + retries) when the error ended a call. */
  attempts = 1;
  constructor(
    readonly code: JudgeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** HTTP 429. `retryAfterMs` comes from Retry-After when the server sent one. */
export class RateLimitedError extends JudgeError {
  override name = "RateLimitedError";
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super("rate_limited", message, true, 429, options);
  }
}

/** 408, 5xx, timeouts and connection failures: worth retrying; each retry may be billed. */
export class TransientBackendError extends JudgeError {
  override name = "TransientBackendError";
  constructor(message: string, status?: number, options?: ErrorOptions) {
    super("transient", message, true, status, options);
  }
}

/** 400/401/403/404/422 and other non-retryable failures. */
export class PermanentBackendError extends JudgeError {
  override name = "PermanentBackendError";
  constructor(message: string, status?: number, options?: ErrorOptions) {
    super("permanent", message, false, status, options);
  }
}

/** The backend answered, but not in the shape we asked for (missing answer, unknown label). */
export class BackendProtocolError extends JudgeError {
  override name = "BackendProtocolError";
  constructor(message: string, options?: ErrorOptions) {
    super("protocol", message, false, undefined, options);
  }
}

export class AbortedError extends JudgeError {
  override name = "AbortedError";
  constructor(message = "request aborted", options?: ErrorOptions) {
    super("aborted", message, false, undefined, options);
  }
}

/** A budget cap would be exceeded. The call is refused before it is made. */
export class BudgetExceededError extends JudgeError {
  override name = "BudgetExceededError";
  constructor(
    message: string,
    readonly capUsd: number,
    readonly wouldSpendUsd: number,
  ) {
    super("budget", message, false);
  }
}

/** The projected state is over a question's or the backend's token cap. Never truncated. */
export class StateTooLargeError extends JudgeError {
  override name = "StateTooLargeError";
  constructor(
    message: string,
    readonly tokens: number,
    readonly cap: number,
  ) {
    super("state_too_large", message, false);
  }
}

/** The fixture backend has no recording for this full cache key. Tests fail loudly on it. */
export class FixtureMissError extends JudgeError {
  override name = "FixtureMissError";
  constructor(
    readonly key: CacheKeyColumns,
    readonly keyId: string,
  ) {
    super("fixture_miss", `no fixture for cache key ${keyId}: ${JSON.stringify(key)}`, false);
  }
}

/** Map an HTTP status to a typed error (shared by the jev and wire backends). */
export function errorForStatus(
  status: number,
  message: string,
  retryAfterMs?: number,
  cause?: unknown,
): JudgeError {
  const o = cause === undefined ? undefined : { cause };
  if (status === 429) return new RateLimitedError(message, retryAfterMs, o);
  if (status === 408 || status >= 500) return new TransientBackendError(message, status, o);
  return new PermanentBackendError(message, status, o);
}
