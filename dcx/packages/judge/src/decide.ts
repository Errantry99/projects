// decide(): read-time calibration plus thresholds (02 §3.1, §3.4; 07 §4.3). Pure and cheap, so
// refitting a calibrator re-decides history with no model call. Mirrors the `decisions` and
// `decision_actions` views: the threshold must name the calibrator the decision used; the band
// is [abstain_band[0] ?? floor, min_p); `on_error` defaults to "human".

import {
  type CalibratorRow,
  calibrateAnswer,
  type Decided,
  type RawAnswer,
  type ThresholdRow,
  type ThresholdRule,
  type Warehouse,
} from "@dcx/core";

/** Action names decide() returns besides a threshold's own action. */
export const ACTION_HUMAN = "human";
/** Abstain band / fail-open: escalate to the next tier (the blind LLM). */
export const ACTION_ESCALATE = "escalate";
/** Fail-closed: take no action. */
export const ACTION_NONE = "";
/** The `thresholds.floor` column default, used only when a row object omits it. */
export const DEFAULT_FLOOR = 0.5;
export const DEFAULT_ON_ERROR: ThresholdRule["on_error"] = "human";

/** A raw answer plus the context decide() needs. `null` answer = the judge failed. */
export interface DecideInput {
  answer: RawAnswer | null;
  questionHash: string;
  backend?: string;
  modelVersion?: string;
  cacheHit?: boolean;
  degraded?: boolean;
  questionRef?: Decided["questionRef"];
}

export interface DecideOpts {
  /** Evaluate threshold validity at this time (default now). */
  at?: Date;
}

function onError(t: ThresholdRow | undefined): Pick<Decided, "action" | "reason"> {
  const mode = t?.rule.on_error ?? DEFAULT_ON_ERROR;
  const action =
    mode === "fail_open"
      ? ACTION_ESCALATE
      : mode === "fail_closed"
        ? ACTION_NONE
        : ACTION_HUMAN;
  return { action, reason: "judge_error" };
}

function valid(t: ThresholdRow, at: Date, cal: CalibratorRow | null): boolean {
  if (t.status !== "active") return false;
  if ((t.calibrator_id ?? null) !== (cal?.calibrator_id ?? null)) return false;
  if (t.valid_from && Date.parse(t.valid_from) > at.getTime()) return false;
  return !(t.valid_to && Date.parse(t.valid_to) <= at.getTime());
}

/**
 * Calibrate one raw answer and apply its threshold(s).
 * - drift / degraded → human (`model_drift`); judge error → `on_error` (default human);
 * - no applicable active threshold → human (`no_threshold`);
 * - p_cal ≥ min_p → the threshold's action (`above_threshold`); p_cal ≥ band_lo → escalate
 *   (`abstain_band`); else human (`below_floor`).
 * A calibrator for a different (question, backend, model) is ignored (identity) and the
 * decision is marked degraded. On a judge error pCal is 0 (never NaN, which JCS rejects).
 */
export function decide(
  input: DecideInput,
  calibrator: CalibratorRow | null,
  threshold: ThresholdRow | readonly ThresholdRow[] | null,
  opts: DecideOpts = {},
): Decided {
  const at = opts.at ?? new Date();
  const ts =
    threshold === null
      ? []
      : Array.isArray(threshold)
        ? [...threshold]
        : [threshold as ThresholdRow];
  const calOk =
    calibrator !== null &&
    calibrator.status === "active" &&
    calibrator.question_hash === input.questionHash &&
    (input.backend === undefined || calibrator.backend === input.backend) &&
    (input.modelVersion === undefined || calibrator.model_v === input.modelVersion);
  const cal = calOk ? calibrator : null;
  const base: Decided = {
    questionHash: input.questionHash,
    answer: input.answer?.answer ?? "",
    probs: input.answer?.probs ?? {},
    pCal: 0,
    action: ACTION_HUMAN,
    thresholdId: null,
    calibratorId: cal?.calibrator_id ?? null,
    cacheHit: input.cacheHit ?? false,
    degraded: Boolean(input.degraded) || (calibrator !== null && !calOk),
  };
  if (input.questionRef) base.questionRef = input.questionRef;
  if (input.backend) base.backend = input.backend;
  if (input.modelVersion) base.modelVersion = input.modelVersion;
  const a = input.answer;
  if (!a) return { ...base, ...onError(ts[0]), thresholdId: ts[0]?.threshold_id ?? null };
  base.qtype = a.qtype;
  base.pRaw = a.pAnswer;
  const { pCalAnswer } = calibrateAnswer(
    a.qtype,
    cal?.method,
    cal?.params,
    a.answer,
    a.pAnswer,
    a.probs,
  );
  if (pCalAnswer === null || !Number.isFinite(pCalAnswer)) {
    return { ...base, ...onError(ts[0]), thresholdId: ts[0]?.threshold_id ?? null };
  }
  base.pCal = pCalAnswer;
  if (input.degraded) return { ...base, action: ACTION_HUMAN, reason: "model_drift" };

  const live = ts.filter((t) => t.question_hash === input.questionHash && valid(t, at, cal));
  // A rule without a label applies to every answer (the SQL view reads a missing label as NULL).
  const applicable = live.filter(
    (t) => (t.rule.label ?? null) === null || t.rule.label === a.answer,
  );
  if (applicable.length === 0) return { ...base, action: ACTION_HUMAN, reason: "no_threshold" };

  // The strictest firing threshold wins; otherwise the best band outcome.
  const ranked = [...applicable].sort((x, y) => y.rule.min_p - x.rule.min_p);
  const fired = ranked.find((t) => pCalAnswer >= t.rule.min_p);
  if (fired)
    return {
      ...base,
      action: fired.action,
      reason: "above_threshold",
      thresholdId: fired.threshold_id,
    };
  const inBand = ranked.find(
    (t) => pCalAnswer >= (t.rule.abstain_band?.[0] ?? t.floor ?? DEFAULT_FLOOR),
  );
  if (inBand) {
    return {
      ...base,
      action: ACTION_ESCALATE,
      reason: "abstain_band",
      thresholdId: inBand.threshold_id,
    };
  }
  return {
    ...base,
    action: ACTION_HUMAN,
    reason: "below_floor",
    thresholdId: ranked[0]?.threshold_id ?? null,
  };
}

/** The active calibrator and thresholds for one (question, backend, model_v) — what decide()
 *  needs, as the kernel's `judge` step reads them. */
export async function loadDecisionPolicy(
  wh: Warehouse,
  k: { questionHash: string; backend: string; modelV: string },
): Promise<{ calibrator: CalibratorRow | null; thresholds: ThresholdRow[] }> {
  const params = [k.questionHash, k.backend, k.modelV];
  const cals = await wh.all<Record<string, unknown>>(
    `SELECT calibrator_id, question_hash, backend, model_v, candidate_spec, method,
            params::VARCHAR AS params, n_fit, ece, ece_floor, brier, status
     FROM calibrators WHERE status = 'active' AND question_hash = $1 AND backend = $2 AND model_v = $3`,
    params,
  );
  const ths = await wh.all<Record<string, unknown>>(
    `SELECT threshold_id, policy_id, question_hash, backend, model_v, candidate_spec, calibrator_id,
            action, rule::VARCHAR AS rule, floor::DOUBLE AS floor,
            epoch_ms(valid_from)::DOUBLE AS valid_from_ms, epoch_ms(valid_to)::DOUBLE AS valid_to_ms, status
     FROM thresholds WHERE status = 'active' AND question_hash = $1 AND backend = $2 AND model_v = $3`,
    params,
  );
  if (cals.length > 1) throw new Error(`more than one active calibrator for ${k.questionHash}`);
  const c = cals[0];
  const calibrator: CalibratorRow | null = c
    ? ({ ...c, params: JSON.parse(String(c.params)) } as unknown as CalibratorRow)
    : null;
  const thresholds = ths.map((t) => {
    const { valid_from_ms, valid_to_ms, ...rest } = t;
    const row: Record<string, unknown> = {
      ...rest,
      rule: JSON.parse(String(t.rule)),
      floor: Number(t.floor),
    };
    row.valid_from = new Date(Number(valid_from_ms)).toISOString();
    if (valid_to_ms !== null && valid_to_ms !== undefined)
      row.valid_to = new Date(Number(valid_to_ms)).toISOString();
    return row as unknown as ThresholdRow;
  });
  return { calibrator, thresholds };
}
