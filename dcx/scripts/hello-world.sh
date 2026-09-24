#!/usr/bin/env bash
# The week-1 hello-world demo (07 §4.8) on the fixture backend: no network, no API key.
# Every judge answer and LLM response is a recorded fixture over a SYNTHETIC review.
#
#   scripts/hello-world.sh [demo-dir]      (default: a fresh temp directory)
#   npm run demo
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="${1:-$(mktemp -d "${TMPDIR:-/tmp}/dcx-demo-XXXXXX")}"
BASELINE="${BASELINE:-frontier-llm@2026-09-01}"   # the model the LLM fixtures were recorded for
dcx() { node "$ROOT/packages/cli/bin/dcx.js" "$@"; }
step() { printf '\n$ dcx %s\n' "$*"; dcx "$@"; }

step init "$DEMO"
cd "$DEMO"
step import synergy --review synthetic_exercise_depression --sample 300 --seed 7
step questions add "$ROOT"/projects/evidence-screener/questions/*.json
step run screen-baseline@1 --model "$BASELINE"
step judge --backend fixture --pin jev-1.13.0
step judge --backend fixture --pin jev-1.13.0   # → "0 requests: 300/300 payloads cached"
step fit screen --split tune
step run screen-compiled@1 --split holdout --model "$BASELINE"
step report h4 --html out/report.html
printf '\ndemo directory: %s\n' "$DEMO"
