// The review protocol (trusted project config): topic, criteria and the reducer policy.
import { readFileSync } from "node:fs";

export interface ScreenCriteria {
  review: string;
  synthetic: boolean;
  topic: string;
  criteria: Array<{ id: string; aspect: string; text: string }>;
  inclusion_rule: string;
  /** Reducer and router settings; data, not code constants. */
  policy: {
    exclude_min_p: number;
    injection_max_p: number;
    audit_rate: number;
    exclude_threshold_ref: string;
  };
  baseline_model: string;
}

export const PROJECT_ROOT = new URL("../", import.meta.url);

export function loadCriteria(
  path: URL = new URL("criteria.json", PROJECT_ROOT),
): ScreenCriteria {
  return JSON.parse(readFileSync(path, "utf8")) as ScreenCriteria;
}

export const CRITERIA: ScreenCriteria = loadCriteria();
