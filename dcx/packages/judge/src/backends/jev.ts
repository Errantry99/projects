// Jev over @typesafe-ai/sdk 0.6.0 (07 §3 item 9: direct and pinned). The SDK's own retries are
// disabled (retry.maxRetries = 0) so every attempt is counted and billed by our loop; the
// returned `model` becomes `modelVersion`; `dangerouslyAllowBrowser` is never set.

import { assertPinned, type BackendCaps, type Json, type RawDecision } from "@dcx/core";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
  type RequestOptions,
  type SystemOneRequest,
  TypeSafeClient,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";
import {
  AbortedError,
  errorForStatus,
  type JudgeError,
  TransientBackendError,
} from "../errors.js";
import type { JudgeBackend } from "../types.js";
import {
  buildRequest,
  checkStateCap,
  estimateTokens,
  mapResponse,
  toRawDecision,
  withRetries,
} from "./systemone.js";

/** The slice of TypeSafeClient the backend uses; tests pass a mock. */
export interface SystemOneClient {
  systemOne(
    request: SystemOneRequest,
    options?: RequestOptions,
  ): { withResponse(): Promise<{ data: unknown; requestId: string | undefined }> };
}

export interface JevBackendOpts {
  /** The pinned model, e.g. `jev-1.13.0`. `jev-latest` and other aliases are rejected. */
  model: string;
  /** Pre-built client (tests). Otherwise one is built lazily from apiKey / baseURL. */
  client?: SystemOneClient;
  apiKey?: string;
  baseURL?: string;
  name?: string;
  caps?: Partial<BackendCaps>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Jev caps. maxStateTokens (~32k) and maxQuestions are unverified (02 §2.1); 255 options is
 *  partly verified. Questions are isolated per the audit. */
export const JEV_CAPS: BackendCaps = {
  primitives: new Set(["choice", "score", "noul"]),
  maxOptions: 255,
  maxQuestions: 64,
  maxStateTokens: 32_000,
  isolatesQuestions: true,
  dataResidency: "offshore",
};

/** The client config we build: pinned default model, SDK retries off, no browser override. */
export function jevClientConfig(o: Pick<JevBackendOpts, "model" | "apiKey" | "baseURL">) {
  const cfg: TypeSafeClientConfig = { defaultModel: o.model, retry: { maxRetries: 0 } };
  if (o.apiKey !== undefined) cfg.apiKey = o.apiKey;
  if (o.baseURL !== undefined) cfg.baseURL = o.baseURL;
  return cfg;
}

/** Map an SDK error (or anything thrown by the client) to a typed JudgeError. */
export function mapSdkError(e: unknown): JudgeError | unknown {
  if (e instanceof APIUserAbortError) return new AbortedError(e.message, { cause: e });
  if (e instanceof RateLimitError) return errorForStatus(429, e.message, e.retryAfterMs, e);
  if (e instanceof APIError) return errorForStatus(e.status, e.message, undefined, e);
  if (e instanceof APITimeoutError || e instanceof APIConnectionError) {
    return new TransientBackendError(e.message, undefined, { cause: e });
  }
  return e;
}

export function jevBackend(o: JevBackendOpts): JudgeBackend {
  assertPinned(o.model);
  const name = o.name ?? "jev";
  const caps: BackendCaps = { ...JEV_CAPS, ...o.caps };
  const now = o.now ?? Date.now;
  let client = o.client;
  const getClient = (): SystemOneClient => {
    client ??= new TypeSafeClient(jevClientConfig(o)) as unknown as SystemOneClient;
    return client;
  };

  return {
    name,
    caps: () => caps,
    countTokens: (state: Json) => estimateTokens(state),
    modelVFor: (pin: string) => pin,
    async ask(state, qs, opts): Promise<RawDecision> {
      const model = opts.model ?? o.model;
      assertPinned(model);
      checkStateCap(state, caps.maxStateTokens);
      const { body, keys } = buildRequest(state, qs, model);
      const t0 = now();
      const { value, retries, billedRetries } = await withRetries(
        async () => {
          const ro: RequestOptions = { timeout: opts.timeoutMs, retry: { maxRetries: 0 } };
          if (opts.signal) ro.signal = opts.signal;
          try {
            return await getClient()
              .systemOne(body as unknown as SystemOneRequest, ro)
              .withResponse();
          } catch (e) {
            throw mapSdkError(e);
          }
        },
        {
          maxRetries: opts.maxRetries,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(o.sleep ? { sleep: o.sleep } : {}),
        },
      );
      const mapped = mapResponse(value.data, qs, keys);
      return toRawDecision({
        backend: name,
        requested: model,
        mapped,
        modelVersion: mapped.model,
        requestId: value.requestId,
        retries,
        billedRetries,
        basis: "token-price",
        latencyMs: now() - t0,
      });
    },
  };
}
