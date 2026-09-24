// OpenTelemetry-style span mapping (03 §3.7, 07 §3 decision 15). Plain objects, no OTel
// dependency, so a sink can export them over OTLP. One pinned semconv version lives here, so
// convention churn touches only this module. Content capture is OFF: spans carry hashes and
// refs into the store (the system of record), never prompts, outputs or state.

import {
  type Decided,
  type Json,
  type Routed,
  type RunRow,
  type StepRow,
  sha256Hex,
  type TraceRow,
} from "@dcx/core";

/** The GenAI semantic-conventions release these names follow (semantic-conventions-genai). */
export const SEMCONV_VERSION = "1.42.0";
export const SCHEMA_URL = `https://opentelemetry.io/schemas/${SEMCONV_VERSION}`;
/** Content attributes are never emitted (store refs instead). */
export const CAPTURE_CONTENT = false;

/** Custom span kinds for operations the GenAI conventions lack. */
export const DCX_SPAN_KINDS = { classify: "dcx.classify", route: "dcx.route" } as const;

export type AttrValue = string | number | boolean | string[];

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: "INTERNAL" | "CLIENT";
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AttrValue>;
  events: { name: string; attributes: Record<string, AttrValue> }[];
  status: { code: "OK" | "ERROR" | "UNSET"; message?: string };
  schemaUrl: string;
}

const ns = (ms: number | null | undefined) => `${ms ?? 0}000000`;
const traceIdOf = (runId: string) => sha256Hex(`trace:${runId}`).slice(0, 32);
const spanIdOf = (runId: string, stepNo: number) =>
  sha256Hex(`span:${runId}:${stepNo}`).slice(0, 16);

function attrs(o: Record<string, Json | undefined>): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
    else out[k] = JSON.stringify(v);
  }
  return out;
}

/** Map one journal step to a span (name, standard and `dcx.*` attributes, events). */
export function stepSpan(run: RunRow, s: StepRow): OtelSpan | null {
  if (s.kind === "rule" && s.name.startsWith("dcx.")) return null; // journaled now()/random()
  const out = (s.output ?? null) as Record<string, Json> | null;
  let name = `${s.kind} ${s.name}`;
  let kind: OtelSpan["kind"] = "INTERNAL";
  let a: Record<string, Json | undefined> = {};
  const events: OtelSpan["events"] = [];
  if (s.kind === "llm" && out?.trace) {
    const t = out.trace as unknown as TraceRow;
    kind = "CLIENT";
    name = `chat ${t.model_requested}`;
    a = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": t.provider,
      "gen_ai.request.model": t.model_requested,
      "gen_ai.response.model": t.model_returned,
      "gen_ai.usage.input_tokens": t.input_tokens,
      "gen_ai.usage.output_tokens": t.output_tokens,
      "gen_ai.prompt.name": t.template_id,
      "gen_ai.prompt.version":
        t.template_v === null || t.template_v === undefined ? null : String(t.template_v),
      "gen_ai.conversation.id": s.run_id,
      "dcx.template_hash": t.template_hash,
      "dcx.tool_set_hash": t.tool_set_hash,
      "dcx.decision_point": t.decision_point_id,
      "dcx.cost_usd": t.cost_usd,
      "dcx.content_ref": t.input_projection_ref,
      "openinference.span.kind": "LLM",
    };
  } else if (s.kind === "judge" && out?.decided) {
    const ds = out.decided as unknown as Decided[];
    kind = "CLIENT";
    name = `classify ${ds[0]?.backend ?? "judge"}`;
    a = {
      "gen_ai.operation.name": "classify",
      "gen_ai.provider.name": ds[0]?.backend,
      "gen_ai.response.model": ds[0]?.modelVersion,
      "dcx.span.kind": DCX_SPAN_KINDS.classify,
      "dcx.question_hash": ds.map((d) => d.questionHash),
      "dcx.cache_hit": ds.every((d) => d.cacheHit),
      "openinference.span.kind": "EVALUATOR",
    };
    for (const d of ds) {
      events.push({
        name: "gen_ai.evaluation.result",
        attributes: attrs({
          "gen_ai.evaluation.name": d.questionRef ?? d.questionHash,
          "gen_ai.evaluation.score.value": d.pCal,
          "gen_ai.evaluation.score.label": d.answer,
          "dcx.p_raw": d.pRaw,
          "dcx.threshold_id": d.thresholdId,
          "dcx.action": d.action,
        }),
      });
    }
  } else if (s.kind === "route" && out) {
    const r = out as unknown as Routed<string> & { decisionPointId?: string };
    name = `route ${s.name}`;
    a = {
      "gen_ai.operation.name": "route",
      "dcx.span.kind": DCX_SPAN_KINDS.route,
      "dcx.decision_point": r.decisionPointId,
      "dcx.branch": r.branch,
      "dcx.reason": r.reason,
      "dcx.tiers": r.tiers.map((t) => `${t.tier}:${t.kind}:${t.answer ?? ""}`),
      "dcx.cost_usd": r.costUsd,
      "dcx.audited": r.audited ?? false,
      "openinference.span.kind": "CHAIN",
    };
  } else if (s.kind === "tool") {
    name = `execute_tool ${s.name}`;
    a = {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": s.name,
      "gen_ai.tool.call.id": s.idempotency_key,
      "dcx.idempotency_key": s.idempotency_key,
      "openinference.span.kind": "TOOL",
    };
  } else if (s.kind === "sql") {
    a = {
      "db.system.name": "duckdb",
      "dcx.input_hash": s.input_ref,
      "db.response.returned_rows": Array.isArray(s.output) ? s.output.length : null,
      "openinference.span.kind": "CHAIN",
    };
  } else {
    a = { "openinference.span.kind": "CHAIN", "dcx.input_hash": s.input_ref };
  }
  return {
    traceId: traceIdOf(run.run_id),
    spanId: spanIdOf(run.run_id, s.step_no),
    parentSpanId: spanIdOf(run.run_id, 0),
    name,
    kind,
    startTimeUnixNano: ns(s.started_at),
    endTimeUnixNano: ns(s.ended_at ?? s.started_at),
    attributes: attrs({
      ...a,
      "dcx.step_no": s.step_no,
      "dcx.step.kind": s.kind,
      "dcx.mode": s.mode,
      "dcx.status": s.status,
    }),
    events,
    status:
      s.status === "failed"
        ? { code: "ERROR", message: s.error ?? "" }
        : { code: s.status === "completed" ? "OK" : "UNSET" },
    schemaUrl: SCHEMA_URL,
  };
}

/** The run's root `invoke_workflow` span followed by one span per step. */
export function runSpans(run: RunRow, steps: readonly StepRow[]): OtelSpan[] {
  const root: OtelSpan = {
    traceId: traceIdOf(run.run_id),
    spanId: spanIdOf(run.run_id, 0),
    parentSpanId: null,
    name: `invoke_workflow ${run.workflow}`,
    kind: "INTERNAL",
    startTimeUnixNano: ns(run.created_at),
    endTimeUnixNano: ns(run.ended_at ?? run.created_at),
    attributes: attrs({
      "gen_ai.operation.name": "invoke_workflow",
      "gen_ai.workflow.name": run.workflow,
      "gen_ai.conversation.id": run.run_id,
      "dcx.workflow.version": run.workflow_v,
      "dcx.mode": run.mode,
      "dcx.status": String(run.status),
      "openinference.span.kind": "CHAIN",
    }),
    events: [],
    status: {
      code: run.status === "failed" ? "ERROR" : run.status === "completed" ? "OK" : "UNSET",
    },
    schemaUrl: SCHEMA_URL,
  };
  const spans = [root];
  for (const s of steps) {
    const sp = stepSpan(run, s);
    if (sp) spans.push(sp);
  }
  return spans;
}
