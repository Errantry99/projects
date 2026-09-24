import {
  APIError,
  APITimeoutError,
  BadRequestError,
  type RequestOptions,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { jevBackend, jevClientConfig, type SystemOneClient } from "../src/backends/jev.js";
import { buildLlmPrompt, llmBackend } from "../src/backends/llm.js";
import { buildRequest } from "../src/backends/systemone.js";
import { wireBackend } from "../src/backends/wire.js";
import { PermanentBackendError, RateLimitedError, StateTooLargeError } from "../src/errors.js";
import { parseQuestion } from "../src/registry.js";
import { crit1, onTopic } from "./helpers/fakes.js";

const severity = parseQuestion({
  id: "t.severity",
  version: 1,
  qtype: "score",
  instructions: "How severe is the problem described in `ticket.body`?",
  options: [
    { label: "cosmetic", description: "A visual defect with no loss of function." },
    { label: "degraded", description: "A feature works but slowly or partially." },
    { label: "blocking", description: "A feature cannot be used at all." },
  ],
  fields: ["ticket.body"],
});
const QS = [crit1, onTopic, severity];
const STATE = { untrusted_record: { title: "t", abstract: "a" } };
const OPTS = { timeoutMs: 1000, maxRetries: 2 };
const noSleep = async () => {};

const response = (model = "jev-1.13.0") => ({
  model,
  answers: {
    q0: {
      type: "choice",
      choice: "meets",
      confidence: 0.9,
      probabilities: { meets: 0.93, fails: 0.03, not_stated: 0.03, other: 0.01 },
    },
    q1: { type: "noul", noul: 0.82 },
    q2: {
      type: "score",
      score: 1.4,
      confidence: 0.7,
      legend: {},
      probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
    },
  },
  usage: { input_tokens: 412, output_tokens: 0 },
});

function mockClient(script: Array<() => unknown>) {
  const seen: Array<{ req: SystemOneRequest; opts?: RequestOptions }> = [];
  const client: SystemOneClient = {
    systemOne(req, opts) {
      seen.push(opts ? { req, opts } : { req });
      const step = script.shift() ?? script[script.length - 1];
      return {
        withResponse: async () => ({ data: (step as () => unknown)(), requestId: "req-1" }),
      };
    },
  };
  return { client, seen };
}
const rateLimit = () => {
  throw APIError.fromResponse(
    429,
    { error: "slow down" },
    new Headers({ "retry-after-ms": "5" }),
  );
};

describe("jev backend (mocked SDK client)", () => {
  it("requires a pinned model and never sets dangerouslyAllowBrowser", () => {
    expect(() => jevBackend({ model: "jev-latest" })).toThrow(/alias/);
    const cfg = jevClientConfig({ model: "jev-1.13.0", apiKey: "k" });
    expect(cfg).not.toHaveProperty("dangerouslyAllowBrowser");
    expect(cfg.defaultModel).toBe("jev-1.13.0");
    expect(cfg.retry?.maxRetries).toBe(0);
  });

  it("sends the SDK request shape and maps Choice / Noul / Score", async () => {
    const { client, seen } = mockClient([() => response()]);
    const be = jevBackend({ model: "jev-1.13.0", client });
    const raw = await be.ask(STATE, QS, OPTS);
    const req = seen[0]?.req as unknown as ReturnType<typeof buildRequest>["body"];
    expect(req.model).toBe("jev-1.13.0");
    expect(req.state).toEqual(STATE);
    expect(req.questions.q0).toEqual({
      type: "choice",
      instructions: crit1.instructions,
      criteria: Object.fromEntries(crit1.options.map((o) => [o.label, o.description])),
    });
    expect(Object.keys((req.questions.q0 as { criteria: object }).criteria)).toEqual(
      crit1.options.map((o) => o.label),
    );
    expect(req.questions.q1).toMatchObject({
      type: "noul",
      criteria: { true: onTopic.options[0]?.description },
    });
    expect(req.questions.q2).toMatchObject({
      type: "score",
      criteria: severity.options.map((o) => o.description),
    });
    expect(seen[0]?.opts?.retry?.maxRetries).toBe(0);
    const [c, n, s] = raw.answers;
    expect(c).toMatchObject({ answer: "meets", pAnswer: 0.93, backendConfidence: 0.9 });
    expect(n).toMatchObject({ answer: "true", pAnswer: 0.82 });
    expect(n?.probs.false).toBeCloseTo(0.18);
    expect(s).toMatchObject({
      answer: "blocking",
      pAnswer: 0.5,
      score: 1.4,
      probs: { cosmetic: 0.1, degraded: 0.4, blocking: 0.5 },
    });
    expect(raw).toMatchObject({
      backend: "jev",
      modelVersion: "jev-1.13.0",
      requestId: "req-1",
      retries: 0,
      degraded: false,
    });
    expect(raw.usage).toEqual({ inputTokens: 412, outputTokens: 0, basis: "token-price" });
  });

  it("returns the RETURNED model version and flags drift", async () => {
    const { client } = mockClient([() => response("jev-1.14.0")]);
    const raw = await jevBackend({ model: "jev-1.13.0", client }).ask(STATE, QS, OPTS);
    expect(raw.modelVersion).toBe("jev-1.14.0");
    expect(raw.modelRequested).toBe("jev-1.13.0");
    expect(raw.degraded).toBe(true);
    const { client: c2 } = mockClient([() => response("jev-latest")]);
    await expect(
      jevBackend({ model: "jev-1.13.0", client: c2 }).ask(STATE, QS, OPTS),
    ).rejects.toThrow(/alias/);
  });

  it("maps 429 to RateLimitedError, retries it, and bills timeouts per attempt", async () => {
    const { client } = mockClient([rateLimit, rateLimit, rateLimit]);
    const be = jevBackend({ model: "jev-1.13.0", client, sleep: noSleep });
    const err = await be.ask(STATE, QS, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(5);
    expect(err.attempts).toBe(3);
    const timeout = () => {
      throw new APITimeoutError(1000);
    };
    const { client: c2 } = mockClient([timeout, () => response()]);
    const raw = await jevBackend({ model: "jev-1.13.0", client: c2, sleep: noSleep }).ask(
      STATE,
      QS,
      OPTS,
    );
    expect(raw.retries).toBe(1);
    expect(raw.usage.inputTokens).toBe(824); // two billed attempts
    const { client: c3 } = mockClient([rateLimit, () => response()]);
    const r3 = await jevBackend({ model: "jev-1.13.0", client: c3, sleep: noSleep }).ask(
      STATE,
      QS,
      OPTS,
    );
    expect(r3.usage.inputTokens).toBe(412); // a 429 is not billed
  });

  it("maps 4xx to a permanent error without retrying", async () => {
    let calls = 0;
    const { client } = mockClient([
      () => {
        calls++;
        throw new BadRequestError(400, { error: "bad" }, new Headers());
      },
    ]);
    const err = await jevBackend({ model: "jev-1.13.0", client, sleep: noSleep })
      .ask(STATE, QS, OPTS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(PermanentBackendError);
    expect(err.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("refuses an oversized state instead of truncating", async () => {
    const { client, seen } = mockClient([() => response()]);
    const be = jevBackend({ model: "jev-1.13.0", client, caps: { maxStateTokens: 10 } });
    await expect(be.ask({ text: "x".repeat(100) }, QS, OPTS)).rejects.toBeInstanceOf(
      StateTooLargeError,
    );
    expect(seen).toHaveLength(0);
  });
});

describe("wire backend (mocked fetch)", () => {
  const caps = {
    primitives: new Set(["choice", "noul", "score"] as const),
    maxOptions: 64,
    maxQuestions: 64,
    maxStateTokens: 5000,
    isolatesQuestions: false,
    dataResidency: "local" as const,
  };
  it("posts the same body to {baseURL}/v1/systemone and digests settings into modelVersion", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(response("kev-4b-r3")), {
        headers: { "x-request-id": "w1" },
      });
    };
    const be = wireBackend({
      name: "kev",
      baseURL: "http://localhost:8000/",
      model: "kev-4b-r3",
      settings: { temperature: 2.2 },
      caps,
      fetch,
    });
    const raw = await be.ask(STATE, QS, OPTS);
    expect(seen[0]?.url).toBe("http://localhost:8000/v1/systemone");
    expect(seen[0]?.body).toEqual(buildRequest(STATE, QS, "kev-4b-r3").body);
    expect(raw.modelVersion).toMatch(/^kev-4b-r3\+[0-9a-f]{12}$/);
    expect(be.modelVFor?.("kev-4b-r3")).toBe(raw.modelVersion);
    expect(raw.degraded).toBe(false);
    expect(raw.answers[0]?.answer).toBe("meets");
    expect(raw.requestId).toBe("w1");
  });

  it("maps 429 and 5xx to typed errors", async () => {
    let n = 0;
    const fetch = async () => {
      n++;
      return n === 1
        ? new Response("busy", { status: 503 })
        : new Response("slow", { status: 429, headers: { "retry-after": "1" } });
    };
    const be = wireBackend({
      name: "jeff",
      baseURL: "http://x",
      model: "jeff-400m",
      caps,
      fetch,
      sleep: noSleep,
    });
    const err = await be.ask(STATE, QS, { timeoutMs: 1000, maxRetries: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(1000);
    expect(n).toBe(2);
  });
});

describe("llm adapter", () => {
  it("builds a structured-output prompt and returns discrete, uncalibrated probabilities", async () => {
    const seen: unknown[] = [];
    const be = llmBackend({
      model: "claude-haiku-4-5-20251001",
      complete: async (messages, schema) => {
        seen.push({ messages, schema });
        return {
          output: {
            q0: { answer: "fails" },
            q1: { answer: "false" },
            q2: { answer: "degraded" },
          },
          usage: { inputTokens: 900, outputTokens: 40 },
        };
      },
    });
    const raw = await be.ask(STATE, QS, OPTS);
    const { messages, schema } = buildLlmPrompt(STATE, QS, "discrete");
    expect(seen[0]).toEqual({ messages, schema });
    expect(messages[1]?.content).toContain(crit1.instructions);
    expect(messages[1]?.content).not.toContain(crit1.id);
    expect(
      (schema.properties as Record<string, { properties: { answer: { enum: string[] } } }>).q0
        ?.properties.answer.enum,
    ).toEqual(crit1.options.map((o) => o.label));
    expect(raw.answers[0]).toMatchObject({
      answer: "fails",
      pAnswer: 1,
      probs: { fails: 1, meets: 0 },
      backendConfidence: null,
    });
    expect(raw.answers[1]).toMatchObject({ answer: "false", pAnswer: 0 }); // noul pAnswer = P(true)
    expect(raw.modelVersion).toMatch(/^claude-haiku-4-5-20251001\+[0-9a-f]{12}$/);
    expect(be.calibrated).toBe(false);
    expect(raw.usage).toMatchObject({
      inputTokens: 900,
      outputTokens: 40,
      basis: "token-price",
    });
  });

  it("uses client-supplied probabilities when present", async () => {
    const be = llmBackend({
      model: "gpt-5-mini-2026-01-01",
      probabilities: "verbalised",
      complete: async () => ({
        q0: { answer: "meets", probabilities: { meets: 6, fails: 2, not_stated: 1, other: 1 } },
      }),
    });
    const raw = await be.ask(STATE, [crit1], OPTS);
    expect(raw.answers[0]?.pAnswer).toBeCloseTo(0.6);
    expect(raw.answers[0]?.probs.fails).toBeCloseTo(0.2);
    expect(be.modelVFor?.("gpt-5-mini-2026-01-01")).not.toBe(
      llmBackend({ model: "gpt-5-mini-2026-01-01", complete: async () => ({}) }).modelVFor?.(
        "gpt-5-mini-2026-01-01",
      ),
    );
  });
});
