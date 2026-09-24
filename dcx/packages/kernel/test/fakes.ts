// Fake JudgeService and LlmClient, a deterministic clock and RNG, for kernel tests.

import { type Decided, type Json, jsonHash, type LlmReq, sha256Hex } from "@dcx/core";
import type { JudgeService, LiveJudgment, LlmClient } from "../src/index.js";

export const qHash = (ref: string) => sha256Hex(ref);
export const MODEL = "jev-1.13.0";

export interface FakeAnswer {
  answer: string;
  pCal: number;
  degraded?: boolean;
}

/** Answers keyed by `state.title`; a title of "err" throws. */
export class FakeJudge implements JudgeService {
  calls = 0;
  constructor(private readonly table: (title: string, question: string) => FakeAnswer) {}
  async askLive(req: { state: Json; questions: string[] }): Promise<LiveJudgment> {
    this.calls++;
    const title = String((req.state as { title?: string }).title);
    if (title === "err") throw new Error("judge backend down");
    const decided: Decided[] = req.questions.map((q) => {
      const a = this.table(title, q);
      return {
        questionHash: qHash(q),
        answer: a.answer,
        probs: { [a.answer]: a.pCal },
        pCal: a.pCal,
        action: "",
        thresholdId: null,
        calibratorId: "cal-1",
        backend: "fixture",
        modelVersion: MODEL,
        cacheHit: false,
        degraded: a.degraded ?? false,
      };
    });
    const uses = decided.map((d) => ({
      questionHash: d.questionHash,
      payloadHash: jsonHash(req.state),
      backend: "fixture",
      modelV: MODEL,
      cacheHit: false,
    }));
    return { decided, uses, costUsd: 0.00005 };
  }
}

/** Answers with `pick(req)`; records every call id. */
export class FakeLlm implements LlmClient {
  readonly provider = "fake";
  calls: string[] = [];
  constructor(private readonly pick: (req: LlmReq<Json>) => string = () => "include") {}
  async complete<T extends Json>(req: LlmReq<T>, o: { callId: string }) {
    this.calls.push(o.callId);
    const answer = this.pick(req as LlmReq<Json>);
    return {
      value: { answer } as unknown as T,
      text: `answer: ${answer}`,
      outputKind: "choice_like" as const,
      normalisedAnswer: answer,
      modelReturned: "claude-test-1-20260901",
      usage: { inputTokens: 120, outputTokens: 4 },
      costUsd: 0.005,
      costBasis: "token-price" as const,
      latencyMs: 12,
      retries: 0,
    };
  }
}

export function counterClock(start = 1_790_000_000_000): () => number {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
}

export function lcg(seed = 7): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
