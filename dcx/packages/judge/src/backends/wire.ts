// Jev-wire-compatible servers (jeff, Kev, tev-local): the same `POST {baseURL}/v1/systemone`
// request and response mapping as backends/jev.ts, over plain fetch. Server-side settings
// (temperature, isolation, LoRA revision) go into a digest on `modelVersion` (02 §3.2).

import {
  assertPinned,
  type BackendCaps,
  type Json,
  type JsonObject,
  modelVersionWithSettings,
  type RawDecision,
} from "@dcx/core";
import {
  AbortedError,
  BackendProtocolError,
  errorForStatus,
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

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface WireBackendOpts {
  /** Backend name in the cache key, e.g. `kev`, `jeff`, `tev-local`. */
  name: string;
  /** Server root; `/v1/systemone` is appended. */
  baseURL: string;
  /** Pinned model (or checkpoint) id. */
  model: string;
  apiKey?: string;
  /** Server settings that change answers; digested into modelVersion. */
  settings?: JsonObject;
  caps: BackendCaps;
  /** Per-call cost basis: `gpu-amortised` for Kev/jeff pools, `zero` for local. */
  costBasis?: RawDecision["usage"]["basis"];
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function retryAfterMs(h: Headers): number | undefined {
  const ms = Number(h.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(h.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
}

export function wireBackend(o: WireBackendOpts): JudgeBackend {
  assertPinned(o.model);
  const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  const url = `${o.baseURL.replace(/\/+$/, "")}/v1/systemone`;
  const now = o.now ?? Date.now;
  const mv = (m: string) => modelVersionWithSettings(m, o.settings ?? null);

  return {
    name: o.name,
    caps: () => o.caps,
    countTokens: (state: Json) => estimateTokens(state),
    modelVFor: mv,
    async ask(state, qs, opts): Promise<RawDecision> {
      const model = opts.model ?? o.model;
      assertPinned(model);
      checkStateCap(state, o.caps.maxStateTokens);
      const { body, keys } = buildRequest(state, qs, model);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
      const t0 = now();
      const { value, retries, billedRetries } = await withRetries(
        async () => {
          const signals = [AbortSignal.timeout(opts.timeoutMs)];
          if (opts.signal) signals.push(opts.signal);
          let res: Response;
          try {
            res = await f(url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: AbortSignal.any(signals),
            });
          } catch (e) {
            if (opts.signal?.aborted) throw new AbortedError(undefined, { cause: e });
            throw new TransientBackendError(`connection failed: ${String(e)}`, undefined, {
              cause: e,
            });
          }
          const text = await res.text();
          if (!res.ok)
            throw errorForStatus(
              res.status,
              `${res.status} ${text.slice(0, 200)}`,
              retryAfterMs(res.headers),
            );
          try {
            return {
              data: JSON.parse(text) as unknown,
              requestId:
                res.headers.get("x-request-id") ?? res.headers.get("x-typesafe-request-id"),
            };
          } catch (e) {
            throw new BackendProtocolError("response is not JSON", { cause: e });
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
        backend: o.name,
        requested: model,
        mapped,
        modelVersion: mv(mapped.model),
        requestId: value.requestId,
        retries,
        billedRetries,
        basis: o.costBasis ?? "gpu-amortised",
        latencyMs: now() - t0,
      });
    },
  };
}
