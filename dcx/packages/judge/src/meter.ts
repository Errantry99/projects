// Cost metering and budget caps (02 §3.8). Prices come from the `prices` table (effective
// dates); cost is summed across retries because the SDK has no idempotency; the budget
// pre-flight refuses a call over the cap and never truncates state.

import type { CostBasis, PriceRow, RawDecision, Warehouse } from "@dcx/core";
import { BudgetExceededError } from "./errors.js";

/** Read every `prices` row. */
export async function loadPrices(wh: Warehouse): Promise<PriceRow[]> {
  const rows = await wh.all<Record<string, unknown>>(
    `SELECT backend, model, input_per_m::DOUBLE AS input_per_m,
            output_per_m::DOUBLE AS output_per_m, epoch_ms(effective_from)::DOUBLE AS effective_ms
     FROM prices`,
  );
  return rows.map((r) => ({
    backend: String(r.backend),
    model: String(r.model),
    input_per_m: Number(r.input_per_m),
    output_per_m: Number(r.output_per_m),
    effective_from: new Date(Number(r.effective_ms)).toISOString(),
  }));
}

/** Strip a settings digest (`jev-1.13.0+abc123def456` → `jev-1.13.0`). */
export function baseModel(modelV: string): string {
  const i = modelV.indexOf("+");
  return i < 0 ? modelV : modelV.slice(0, i);
}

/** The price in force at `at` for (backend, model). Matches the model exactly, then without
 *  its settings digest. Null when none applies. */
export function priceFor(
  prices: readonly PriceRow[],
  backend: string,
  model: string,
  at: Date = new Date(),
): PriceRow | null {
  const t = at.getTime();
  for (const m of [model, baseModel(model)]) {
    const hit = prices
      .filter(
        (p) => p.backend === backend && p.model === m && Date.parse(p.effective_from) <= t,
      )
      .sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from))[0];
    if (hit) return hit;
  }
  return null;
}

/** Token cost at a price. */
export function tokenCost(inputTokens: number, outputTokens: number, price: PriceRow): number {
  return (inputTokens * price.input_per_m + outputTokens * price.output_per_m) / 1e6;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** Sum the usage of every billed attempt of one call (02 §3.8: each retry is billed). */
export function sumUsage(attempts: readonly Usage[]): Usage {
  const out: Usage = {};
  for (const a of attempts) {
    if (a.inputTokens !== undefined) out.inputTokens = (out.inputTokens ?? 0) + a.inputTokens;
    if (a.outputTokens !== undefined)
      out.outputTokens = (out.outputTokens ?? 0) + a.outputTokens;
    if (a.costUsd !== undefined) out.costUsd = (out.costUsd ?? 0) + a.costUsd;
  }
  return out;
}

/**
 * Cost of one backend call. A provider-reported cost wins; otherwise tokens × the `prices` row
 * for (backend, returned model); `zero` for cache hits and zero-cost backends; null cost when
 * tokens or a price are missing. `raw.usage` already sums every billed attempt.
 */
export function callCost(
  raw: RawDecision,
  prices: readonly PriceRow[],
  at?: Date,
): { costUsd: number | null; basis: CostBasis } {
  if (raw.cacheHit || raw.usage.basis === "zero") return { costUsd: 0, basis: "zero" };
  if (raw.usage.costUsd !== undefined)
    return { costUsd: raw.usage.costUsd, basis: raw.usage.basis };
  const price = priceFor(prices, raw.backend, raw.modelVersion, at);
  if (!price || raw.usage.inputTokens === undefined)
    return { costUsd: null, basis: raw.usage.basis };
  return {
    costUsd: tokenCost(raw.usage.inputTokens, raw.usage.outputTokens ?? 0, price),
    basis: "token-price",
  };
}

/**
 * A spend cap. `preflight(estimate)` reserves the estimate or throws BudgetExceededError;
 * `commit(reservation, actual)` replaces the reservation with the actual cost. Concurrent
 * callers see each other's reservations, so a pool never overshoots by more than one estimate
 * error.
 */
export class Budget {
  spentUsd = 0;
  private reservedUsd = 0;
  constructor(readonly capUsd: number = Number.POSITIVE_INFINITY) {}

  get remainingUsd(): number {
    return this.capUsd - this.spentUsd - this.reservedUsd;
  }

  preflight(estimateUsd: number): number {
    const would = this.spentUsd + this.reservedUsd + estimateUsd;
    if (would > this.capUsd + 1e-12) {
      throw new BudgetExceededError(
        `budget $${this.capUsd} would be exceeded ($${would.toFixed(6)})`,
        this.capUsd,
        would,
      );
    }
    this.reservedUsd += estimateUsd;
    return estimateUsd;
  }

  commit(reservation: number, actualUsd: number | null): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation);
    this.spentUsd += actualUsd ?? reservation;
  }
}
