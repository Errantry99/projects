import { describe, expect, it } from "vitest";
import {
  type ArmRecord,
  buildH4Report,
  type H4Input,
  mulberry32,
  renderH4Html,
  renderH4Text,
} from "../src/index.js";

// A fixed input shaped to reproduce spec 07 §4.8's illustrative table: holdout n=120 with 11
// inclusions; the baseline and compiled arms each miss one inclusion (recall 10/11); the
// compiled arm sends 19 abstains + 6 audits to the LLM at $0.005 and pays $0.00005 of judge per
// record. Totals: $0.60 vs 120·0.00005 + 25·0.005 = $0.131, saving 1 − 0.131/0.60 = 78%.
// Coverage needed for 80%: 1 + 6/120 − (0.2·0.005 − 0.00005)/0.005 = 1.05 − 0.19 = 0.86.
const ids = Array.from({ length: 120 }, (_, i) => `r${String(i).padStart(3, "0")}`);
const truth = Object.fromEntries(ids.map((id, i) => [id, i < 11 ? "include" : "exclude"]));
const decision = (i: number) => (i < 10 ? "include" : "exclude");

const baseline: ArmRecord[] = ids.map((recordId, i) => ({
  recordId,
  decision: decision(i),
  decidedBy: "llm",
  llmCalls: 1,
  costUsd: 0.005,
  latencyMs: 3100,
}));
const compiled: ArmRecord[] = ids.map((recordId, i) => {
  const llm = i < 25;
  const rec: ArmRecord = {
    recordId,
    decision: decision(i),
    decidedBy: i < 19 ? "llm" : "judge",
    llmCalls: llm ? 1 : 0,
    costUsd: 0.00005 + (llm ? 0.005 : 0),
    judgeCostUsd: 0.00005,
    latencyMs: llm ? 3500 : 450,
  };
  if (llm) rec.llmReason = i < 19 ? "abstain" : "audit";
  return rec;
});

const input: H4Input = {
  dataset: "synergy/<id>",
  split: "holdout",
  truth,
  baseline: { name: "all-LLM baseline", records: baseline },
  compiled: {
    name: "compiled (jev-1.13.0 + LLM fallback + 5% audit)",
    records: compiled,
    judgeRequests: { firstRun: 120, reRun: 0 },
  },
};

const SPEC_4_8 = `H4 report · synergy/<id> · holdout n=120 (11 inclusions) · ILLUSTRATIVE, too small for a claim
                    all-LLM baseline      compiled (jev-1.13.0 + LLM fallback + 5% audit)
recall              0.91 [0.62, 0.98]     0.91 [0.62, 0.98]
coverage w/o LLM    0%                    84%
LLM calls           120                   25  (19 abstain + 6 audit)
judge requests      –                     120 (first run) · 0 (re-run)
cost / record       $0.0050               $0.0011
total               $0.60                 $0.13          saving 78%  (H4 needs ≥80% → coverage ≥0.86)
p50 latency         3.1 s                 0.45 s`;

describe("H4 report", () => {
  it("renders spec §4.8's table exactly", () => {
    const r = buildH4Report(input);
    expect(renderH4Text(r)).toBe(SPEC_4_8);
    expect(r.saving).toBeCloseTo(1 - 0.131 / 0.6, 12);
    expect(r.coverageNeeded).toBeCloseTo(0.86, 12);
  });

  it("flags synthetic data and drops ILLUSTRATIVE only when large enough", () => {
    const syn = buildH4Report({ ...input, synthetic: true });
    expect(syn.header).toBe(
      "H4 report · synergy/<id> · holdout n=120 (11 inclusions) · SYNTHETIC DATA · ILLUSTRATIVE, too small for a claim",
    );
    const big = buildH4Report({ ...input, claimMin: { n: 100, positives: 10 } });
    expect(big.header).toBe("H4 report · synergy/<id> · holdout n=120 (11 inclusions)");
  });

  it("notes when the saving target is met and supports bootstrap CIs", () => {
    const cheap = compiled.map((r) => ({ ...r, costUsd: r.costUsd / 10, judgeCostUsd: 0 }));
    const r = buildH4Report({ ...input, compiled: { ...input.compiled, records: cheap } });
    expect(renderH4Text(r)).toMatch(/saving 98% {2}\(H4 ≥80% met\)$/m);
    const b = buildH4Report({ ...input, ci: "bootstrap" });
    expect(b.compiled.recall.value).toBeCloseTo(10 / 11, 12);
    expect(b.compiled.recall.hi).toBe(1);
  });

  it("writes a self-contained HTML page with inline SVG", () => {
    const rnd = mulberry32(5);
    const p = Array.from({ length: 200 }, () => rnd() ** (1 / 6));
    const y = p.map((x) => rnd() < x);
    const r = buildH4Report({
      ...input,
      synthetic: true,
      calibration: [{ title: "screen.crit_1 <fails>", p, y, pRaw: p.map((x) => x ** 0.5) }],
      riskCoverage: { conf: p, correct: y },
      reviewBand: [
        { recordId: "r007", question: "crit_1", pCal: 0.81, reason: "abstain_band" },
      ],
    });
    const html = renderH4Html(r);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("SYNTHETIC DATA");
    expect(html).toContain("ILLUSTRATIVE");
    expect(html.match(/<svg /g)?.length).toBe(2);
    expect(html).toContain("screen.crit_1 &#60;fails&#62;");
    expect(html).toMatch(/ECE 0\.\d{3} vs noise floor 0\.\d{3}/);
    expect(html).toContain("r007");
    // no external assets or scripts
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//);
    expect(r.calibration[0]?.floor).toBeGreaterThan(0.02);
    expect(r.riskCoverage?.at90?.coverage).toBeGreaterThanOrEqual(0.9);
  });
});
