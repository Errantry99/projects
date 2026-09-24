// `llm` step: calls the injected LlmClient and builds the `llm_calls` TraceRow (03 §3.3,
// 07 §4.5) with every contract column the kernel can fill. The row is journaled in the step's
// output and emitted when the downstream step completes, with `effect` and `branch_taken`
// filled from that step (the kernel runs it, so it knows). The exact input sent and the raw
// text go to `content` (content-addressed refs; duplicates are expected, export with ignore).
//
// Template slot syntax (kernel-defined, CONTRACT §10): `{{name}}`. `template_hash` is over the
// static text with every slot emptied to `{{}}`; `rendered_hash` is over the rendered text.

import {
  assertPinned,
  canonicalize,
  decisionPointId,
  type Json,
  type JsonObject,
  jsonHash,
  type LlmReq,
  type LlmRes,
  type OutboxEntry,
  sha256Hex,
  type TraceRow,
  toolSetHash,
} from "@dcx/core";
import { asJson, type Effect, type LlmClient, type StepDone, type StepEnv } from "../types.js";

const SLOT = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function templateHash(text: string): string {
  return jsonHash({ scheme: "dcx/template@1", text: text.replace(SLOT, "{{}}") });
}

export function renderTemplate(text: string, slots: LlmReq["slots"]): string {
  return text.replace(SLOT, (m, n: string) => {
    const s = slots[n];
    if (!s) return m;
    return typeof s.value === "string" ? s.value : canonicalize(s.value);
  });
}

/** Deterministic per (run, step, tag): a fork (new run id) gets new ids. */
export function llmCallId(runId: string, stepNo: number, tag = ""): string {
  return jsonHash(["dcx/llm-call@1", runId, stepNo, tag]).slice(0, 32);
}

export function needLlm(env: StepEnv): LlmClient {
  if (!env.deps.llm) throw new Error("no LlmClient configured");
  return env.deps.llm;
}

/** Call the model and build its trace row (effect unset) plus its content/tool-schema rows. */
export async function callLlm<T extends Json>(
  env: StepEnv,
  stepName: string,
  req: LlmReq<T>,
  tag = "",
): Promise<{ res: LlmRes<T>; trace: TraceRow; outbox: OutboxEntry[] }> {
  assertPinned(req.model);
  const client = needLlm(env);
  const callId = llmCallId(env.runId, env.stepNo, tag);
  const rendered = renderTemplate(req.template.text, req.slots);
  const values: JsonObject = {};
  for (const [k, s] of Object.entries(req.slots)) values[k] = s.value;
  const input = asJson<JsonObject>({
    system: req.system ?? null,
    prompt: rendered,
    slots: values,
    tools: req.tools ?? null,
    schema: req.schema ?? null,
  });
  const inputHash = jsonHash(input);
  const inputRef = `sha256:${inputHash}`;
  const outbox: OutboxEntry[] = [
    { target_table: "content", row: { ref: inputRef, body: input } },
  ];
  for (const t of req.tools ?? []) {
    const schema = asJson<Json>(t);
    outbox.push({
      target_table: "tool_schemas",
      row: { hash: jsonHash(schema), name: t.name, schema },
    });
  }
  const r = await client.complete(req, { callId });
  const res: LlmRes<T> = { ...r, callId };
  let rawRef: string | null = null;
  if (res.text !== undefined) {
    rawRef = `sha256:${sha256Hex(res.text)}`;
    outbox.push({ target_table: "content", row: { ref: rawRef, body: res.text } });
  }
  const slots: Record<string, { path: string; field_hash: string }> = {};
  for (const [k, s] of Object.entries(req.slots)) {
    slots[k] = { path: s.path, field_hash: jsonHash(s.value) };
  }
  const trace: TraceRow = {
    call_id: callId,
    source: "kernel",
    mode: env.mode,
    run_id: env.runId,
    step_no: env.stepNo,
    workflow: env.workflow,
    workflow_v: env.workflowV,
    record_ids: req.recordIds ?? [],
    decision_point_id: decisionPointId(env.workflow, req.decisionPoint ?? stepName),
    system_hash: req.system === undefined ? null : sha256Hex(req.system),
    template_id: req.template.id,
    template_v: req.template.version,
    template_hash: templateHash(req.template.text),
    slots,
    rendered_hash: sha256Hex(rendered),
    input_projection_ref: inputRef,
    input_hash: inputHash,
    tool_set_hash: req.tools?.length
      ? toolSetHash(req.tools.map((t) => asJson<Json>(t)))
      : null,
    provider: client.provider,
    model_requested: req.model,
    model_returned: res.modelReturned,
    temperature: req.temperature ?? null,
    reasoning_level: req.reasoningLevel ?? null,
    seed: req.seed ?? null,
    output_kind: res.outputKind,
    parsed: res.value,
    normalised_answer: res.normalisedAnswer ?? null,
    alternatives: res.alternatives ?? null,
    raw_ref: rawRef,
    effect: null,
    branch_taken: null,
    input_tokens: res.usage.inputTokens ?? null,
    output_tokens: res.usage.outputTokens ?? null,
    cache_tokens: res.usage.cacheTokens ?? null,
    reasoning_tokens: res.usage.reasoningTokens ?? null,
    cost_usd: res.costUsd,
    cost_basis: res.costBasis,
    latency_ms: res.latencyMs,
    retries: res.retries,
    label_source: `llm:${res.modelReturned}`,
    is_jev_output: false,
    teacher_blind: req.teacherBlind ?? null,
  };
  return { res, trace, outbox };
}

/** The `llm_calls` outbox row, with the downstream step's effect filled in. */
export function settleTrace(trace: JsonObject | TraceRow, e: Effect): OutboxEntry {
  return {
    target_table: "llm_calls",
    row: asJson<JsonObject>({ ...trace, effect: e.effect, branch_taken: e.branch }),
  };
}

export async function execLlm<T extends Json>(
  env: StepEnv,
  name: string,
  req: LlmReq<T>,
): Promise<StepDone> {
  const { res, trace, outbox } = await callLlm(env, name, req);
  return {
    output: asJson({ res, trace }),
    outbox,
    recordId: req.recordIds?.[0] ?? null,
    activity: `llm:${req.template.id}`,
  };
}
