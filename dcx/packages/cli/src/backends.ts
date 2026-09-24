// Judge backends by name (07 §3 item 9). Every pin goes through core's `assertPinned`, so
// `jev-latest` (or any alias) is refused before a backend is built. Jev refuses to start
// without an API key: there is no silent fallback to fixtures.

import { type Backend, isUnpinnedModel } from "@dcx/core";
import { fixtureBackend, JEV_CAPS, jevBackend, wireBackend } from "@dcx/judge";
import { CliError } from "./context.js";

export const BACKENDS = ["fixture", "jev", "wire", "laya"] as const;
export type BackendName = (typeof BACKENDS)[number];

export interface BackendOpts {
  backend: string;
  pin: string;
  env: NodeJS.ProcessEnv;
  fixtureDir: string;
  wire?: { name?: string; url?: string };
}

/** Refuse an unpinned model with a clear message. */
export function checkPin(pin: string | undefined): string {
  if (!pin) throw new CliError("no --pin given: pin a model version, e.g. --pin jev-1.13.0");
  if (isUnpinnedModel(pin)) {
    throw new CliError(
      `refusing unpinned model "${pin}": pin an exact version (e.g. jev-1.13.0). ` +
        "Every judgment is cached under the returned model version, so an alias would mix models.",
    );
  }
  return pin;
}

export function makeBackend(o: BackendOpts): Backend {
  const pin = checkPin(o.pin);
  switch (o.backend) {
    case "fixture":
      return fixtureBackend({ dir: o.fixtureDir, name: "fixture", model: pin });
    case "jev": {
      const apiKey = o.env.TYPESAFE_API_KEY;
      if (!apiKey) {
        throw new CliError(
          "judge --backend jev needs an API key: set TYPESAFE_API_KEY. No key is configured, " +
            "so nothing was sent. For offline runs use --backend fixture (recorded responses).",
        );
      }
      return jevBackend({ model: pin, apiKey });
    }
    case "wire": {
      const url = o.wire?.url ?? o.env.DCX_WIRE_URL;
      if (!url) {
        throw new CliError("judge --backend wire needs a server URL (--url or DCX_WIRE_URL)");
      }
      const apiKey = o.env.DCX_WIRE_API_KEY;
      return wireBackend({
        name: o.wire?.name ?? "kev",
        baseURL: url,
        model: pin,
        caps: { ...JEV_CAPS, dataResidency: "local" },
        costBasis: "gpu-amortised",
        ...(apiKey ? { apiKey } : {}),
      });
    }
    case "laya":
      throw new CliError(
        "the laya backend (in-process, nightly CI) is not in this build yet (spec §5 weeks 2–3); " +
          "use --backend fixture",
      );
    default:
      throw new CliError(`unknown backend "${o.backend}" (one of ${BACKENDS.join(", ")})`);
  }
}
