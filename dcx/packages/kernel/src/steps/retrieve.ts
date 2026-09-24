// `retrieve` step: STUB. Candidate generation (F §3.5: bm25/vss/trigram legs fused by RRF)
// lands with the ontology tables; until then it journals an empty candidate set whose hash is
// core's `candidateSetHash([])` (""), so runtime-options questions see no candidates.

import { candidateSetHash } from "@dcx/core";
import type { StepDone } from "../types.js";

export function execRetrieve(): StepDone {
  return { output: { candidates: [], candidateSetHash: candidateSetHash([]) } };
}
