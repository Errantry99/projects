import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Decided,
  HitlTask,
  Json,
  LlmReq,
  LlmRes,
  Routed,
  RouteSpec,
  RunCtx,
  StepKind,
} from "@dcx/core";
import { hashUnit } from "@dcx/core";
import { parseSynergyJsonl, synergyRows } from "@dcx/importers";
import { describe, expect, it } from "vitest";
import {
  CRITERIA,
  FIXTURES_ROOT,
  type JudgeFixtureEntry,
  type LlmFixture,
  QUESTION_REFS,
  type Reduced,
  SCREEN_RULES,
  SCREEN_TEMPLATE,
  type ScreenInput,
  type ScreenOutput,
  screenBaseline,
  screenCompiled,
  screenReduce,
} from "../src/index.js";

const root = fileURLToPath(FIXTURES_ROOT);
const review = CRITERIA.review;
const sources = parseSynergyJsonl(
  readFileSync(`${root}synergy-synthetic/${review}.jsonl`, "utf8"),
);
const rows = synergyRows(sources, { review, synthetic: true });
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const judgeFx = new Map(
  readdirSync(`${root}judge/${review}`).map((f) => [
    f.replace(/\.json$/, ""),
    readJson<JudgeFixtureEntry[]>(`${root}judge/${review}/${f}`),
  ]),
);
const llmFx = new Map(
  readdirSync(`${root}llm/screen.baseline@1`).map((f) => [
    f.replace(/\.json$/, ""),
    readJson<LlmFixture>(`${root}llm/screen.baseline@1/${f}`),
  ]),
);
const truth = new Map(
  rows.labels.filter((l) => l.target_kind === "decision").map((l) => [l.record_id, l.label]),
);
const rules = new Map(SCREEN_RULES.map((r) => [r.ref, r.fn]));

/** Identity calibration: pCal is the chosen side's probability. */
function decide(e: JudgeFixtureEntry): Decided {
  const p =
    e.answer.qtype === "noul" && e.answer.answer === "false"
      ? 1 - e.answer.pAnswer
      : e.answer.pAnswer;
  return {
    questionHash: e.answer.questionHash,
    questionRef: e.questionRef as `${string}@${number}`,
    answer: e.answer.answer,
    probs: e.answer.probs,
    pCal: p,
    action: "",
    thresholdId: null,
    calibratorId: null,
    cacheHit: true,
    degraded: false,
  };
}

/** A recording RunCtx over the fixtures; the route mimics the router's tiers (03 §3.4). */
class FixtureCtx implements RunCtx {
  readonly runId = "run-test";
  readonly mode = "active" as const;
  steps: Array<{ kind: StepKind; name: string; req: unknown }> = [];
  decided: Decided[] = [];
  constructor(readonly recordId: string) {}
  private log(kind: StepKind, name: string, req: unknown) {
    this.steps.push({ kind, name, req });
  }
  async sql<T>(): Promise<T[]> {
    throw new Error("unused");
  }
  async rule<T extends Json>(
    name: string,
    ref: `${string}@${number}`,
    inputs: Json,
  ): Promise<T> {
    this.log("rule", name, { ref, inputs });
    const fn = rules.get(ref);
    if (!fn) throw new Error(`no rule ${ref}`);
    return fn(inputs) as T;
  }
  async retrieve(): Promise<never> {
    throw new Error("unused");
  }
  async judge(name: string, req: { state: Json; questions: string[] }): Promise<Decided[]> {
    this.log("judge", name, req);
    const es = judgeFx.get(this.recordId) ?? [];
    this.decided = req.questions.map((ref) => {
      const e = es.find((x) => x.questionRef === ref);
      if (!e) throw new Error(`fixture miss ${this.recordId} ${ref}`);
      return decide(e);
    });
    return this.decided;
  }
  async llm<T extends Json>(name: string, req: LlmReq<T>): Promise<LlmRes<T>> {
    this.log("llm", name, req);
    const fx = llmFx.get(req.recordIds?.[0] ?? "");
    if (!fx) throw new Error("llm fixture miss");
    return { ...fx.response, callId: `call-${this.steps.length}` } as unknown as LlmRes<T>;
  }
  async tool<T extends Json>(): Promise<T> {
    throw new Error("unused");
  }
  async human<T extends Json>(name: string, task: HitlTask): Promise<T> {
    this.log("human", name, task);
    return { decision: truth.get(this.recordId) } as unknown as T;
  }
  async route<K extends string>(name: string, spec: RouteSpec<K>): Promise<Routed<K>> {
    this.log("route", name, spec);
    const d = this.decided.find((x) => x.questionRef === spec.question);
    const audited = hashUnit(`audit:${spec.recordId}`) < (spec.auditRate ?? 0);
    const llmTier = async () => {
      const r = await this.llm("route.tier2", spec.fallback.llm as LlmReq<{ answer: K }>);
      return r.value.answer;
    };
    if (d && (d.answer === "fails" || d.answer === "false") && d.pCal >= 0.99) {
      if (audited) await llmTier();
      return {
        branch: "exclude" as K,
        reason: "above_threshold",
        tiers: [],
        costUsd: 0,
        audited,
      };
    }
    if (d && d.pCal >= 0.5) {
      const a = await llmTier();
      return {
        branch: a,
        reason: "abstain_band",
        tiers: [{ tier: 2, kind: "llm", answer: a, p: null, costUsd: 0 }],
        costUsd: 0,
      };
    }
    return { branch: "human", reason: "below_floor", tiers: [], costUsd: 0 };
  }
  now() {
    return new Date(0);
  }
  random() {
    return 0.5;
  }
}

const input = (i: number): ScreenInput => {
  const r = rows.records[i];
  if (!r) throw new Error("no record");
  return { record_id: r.record_id, state: r.state as ScreenInput["state"] };
};

describe("screen-baseline@1", () => {
  it("is one llm step then a rule step recording the effect", async () => {
    const ctx = new FixtureCtx(input(0).record_id);
    const out = await screenBaseline.run(ctx, input(0));
    expect(ctx.steps.map((s) => s.kind)).toEqual(["llm", "rule"]);
    const req = ctx.steps[0]?.req as LlmReq;
    expect(req.template.id).toBe(SCREEN_TEMPLATE.id);
    expect(req.model).toBe(CRITERIA.baseline_model);
    expect(req.temperature).toBe(0);
    expect(req.teacherBlind).toBe(false);
    expect(req.slots.abstract?.path).toBe("untrusted_record.abstract");
    for (const k of ["topic", "criteria", "title", "abstract"])
      expect(SCREEN_TEMPLATE.text).toContain(`{{${k}}}`);
    expect(out.decision).toBe(llmFx.get(out.record_id)?.response.value.answer);
    expect(ctx.steps[1]?.req).toMatchObject({ ref: "screen.effect@1" });
  });
});

describe("screen-compiled@1", () => {
  it("runs judge → reduce → route → effect, with a blind LLM fallback and 5% audit", async () => {
    const i = rows.records.findIndex((r) => truth.get(r.record_id) === "include");
    const ctx = new FixtureCtx(input(i).record_id);
    await screenCompiled.run(ctx, input(i));
    expect(ctx.steps.slice(0, 3).map((s) => s.kind)).toEqual(["judge", "rule", "route"]);
    expect((ctx.steps[0]?.req as { questions?: string[] } | undefined)?.questions).toEqual(
      QUESTION_REFS,
    );
    const spec = ctx.steps[2]?.req as RouteSpec<string>;
    expect(spec.auditRate).toBe(0.05);
    expect(spec.fallback.llm?.teacherBlind).toBe(true);
    expect(spec.actions).toEqual({ exclude: { thresholdRef: "screen.auto_exclude@1" } });
    expect(ctx.steps.at(-1)?.req).toMatchObject({ ref: "screen.effect@1" });
  });

  it("forces human review on an injection hit", async () => {
    const i = sources.findIndex((s) => s.synthetic?.truth["screen.injection"] === "true");
    const ctx = new FixtureCtx(input(i).record_id);
    const out = await screenCompiled.run(ctx, input(i));
    expect(ctx.steps.map((s) => s.kind)).toContain("human");
    expect(out.decided_by).toBe("human");
  });

  it("over the whole review: never auto-excludes an inclusion; most exclusions skip the LLM", async () => {
    const outs: ScreenOutput[] = [];
    let llmCalls = 0;
    for (let i = 0; i < rows.records.length; i++) {
      const ctx = new FixtureCtx(input(i).record_id);
      outs.push(await screenCompiled.run(ctx, input(i)));
      llmCalls += ctx.steps.filter((s) => s.kind === "llm").length;
    }
    const autoExcluded = outs.filter(
      (o) => o.decided_by === "judge" && o.decision === "exclude",
    );
    expect(autoExcluded.filter((o) => truth.get(o.record_id) === "include")).toEqual([]);
    expect(autoExcluded.length / 270).toBeGreaterThan(0.4);
    expect(llmCalls).toBeLessThan(rows.records.length * 0.6);
    const inc = outs.filter((o) => truth.get(o.record_id) === "include");
    expect(inc.filter((o) => o.decision !== "exclude").length / inc.length).toBeGreaterThan(
      0.85,
    );
  });
});

describe("screen.reduce@1", () => {
  const d = (ref: string, answer: string, pCal: number) => ({ questionRef: ref, answer, pCal });
  const run = (decided: object[]) =>
    screenReduce({ decided: decided as Json, refs: [], policy: CRITERIA.policy }) as Reduced;
  const clean = [
    d("screen.on_topic@1", "true", 1),
    d("screen.crit_1@1", "meets", 0.97),
    d("screen.crit_2@1", "not_stated", 0.9),
    d("screen.injection@1", "false", 0.99),
  ];

  it("auto-excludes only on a calibrated fails or off-topic at ≥ 0.99", () => {
    expect(run([...clean, d("screen.crit_4@1", "fails", 0.995)])).toMatchObject({
      verdict: "exclude",
      question: "screen.crit_4@1",
    });
    expect(run([...clean, d("screen.crit_4@1", "fails", 0.95)]).verdict).toBe("route");
    expect(run([d("screen.on_topic@1", "false", 0.99), ...clean.slice(1)])).toMatchObject({
      verdict: "exclude",
      reason: "off_topic",
    });
    expect(run(clean)).toMatchObject({ verdict: "route", question: "screen.crit_2@1" });
  });

  it("sends injection p(true) ≥ 0.2 to a human", () => {
    const inj = [...clean.slice(0, 3), d("screen.injection@1", "false", 0.75)];
    expect(run(inj).verdict).toBe("human");
  });

  it("names questions by position when the judge omits questionRef", () => {
    const r = screenReduce({
      decided: [{ answer: "fails", pCal: 1 }] as Json,
      refs: ["screen.crit_3@1"],
      policy: CRITERIA.policy,
    }) as Reduced;
    expect(r).toMatchObject({ verdict: "exclude", question: "screen.crit_3@1" });
  });
});
