# Turning small language models into Jev-style classifiers

_Research note, 23 Sep 2026. Question from the owner: "Look up TypeSafe tutorials for converting small
language models into similar classifiers." Verification limits: web search worked; page fetches were
blocked for typesafe.ai, docs.typesafe.ai, huggingface.co, dev.to and most blogs, and worked for
github.com. Claims are tagged **[opened]** (page read), **[search]** (search-result snippet only) or
**unverified**._

## 1. Summary

- **TypeSafe publishes no tutorial for this.** Its docs say Jev is not fine-tuned or LoRA-adapted with
  customer data; you customise through the state field, and its "Autoresearch feature discovery"
  cookbook goes the other way (use Jev's probabilities as features for a CatBoost model you own)
  [search]. The nearest official thing is `typesafe-ai/system-one-adapter-python`, which wraps
  OpenAI, Anthropic or Gemini models behind Jev's API using JSON structured output, with no
  logit-level probabilities [opened].
- **The community has produced the tutorials instead.** Within eight days of launch there are four
  distinct, documented recipes with code, released weights and benchmarks. They differ in whether
  they train anything, and how they get probabilities.
- **Recipe ranking for the owner's purposes** (see §3 for detail):
  1. **Read logits from a frozen small model** (SemIf, openjev-sglang): zero training, one afternoon,
     accuracy ~0.81 on authored tasks vs ~0.88 for Jev, then temperature-scale.
  2. **LoRA-tune a 0.8–9B decoder on typed decisions** (Kev, S1LV3RJ1NX/openjev): the closest
     reproduction of Jev's inferred architecture; Kev-9B trails Jev by ~3.5 points on held-out data;
     a 395-example fine-tune beat Jev on a narrow router (0.979 vs 0.941).
  3. **Distil an open teacher into a ~150M encoder** (Shalimov04/open-jev, Verdict 2.0): 5–25 ms
     per decision on a 6 GB GPU or in-browser; calibrated ECE under 0.02 on the confidence head;
     the "500 gold labels buy more as calibration bias than as training signal" finding matters.
  4. **Use a pre-trained open decision model as-is** (Laya 421M, Bosun 0.6/1.7B, GliFormer via jeff,
     Mapika decider-2b): install and go, accuracy 5–15 points under Jev depending on task.
- **The one legal constraint that changes the plan:** TypeSafe's acceptable-use terms, as seen in
  snippets, ban using Jev's output to "perform model distillation, train a model to imitate the
  output of the Services, or develop a similar service" [search; clause text unverified]. So the
  teacher for any distillation must be an open model or human labels, never Jev. Every recipe
  below already complies; only "label with Jev, train a student" would not.
- **Recommendation:** start with recipe 1 (SemIf-style logit readout on Qwen3.5-4B) as the local
  fallback and CI stand-in for all 13 projects, because it needs no labels. Move to recipe 2 or 3
  for any project where a 300–1,000 example labelled set exists anyway (Inbox Reflex, Community
  Moderator, Tessera), since that set is already required for threshold tuning.

## 2. What Jev is believed to do, and why it matters for reproduction

Archer Hume's "Jev's Architecture Unmasked" (17 Sep, ~10,000 probing calls) is the reference the
open re-implementations cite [search; page blocked]. The inferred design:

- the state is encoded once, and its representation is retained at every transformer layer;
- each question is a separate "grid" that attends to the shared state but not to other questions
  (which is why a tenth question costs tokens but no latency, and why questions cannot leak into
  each other);
- outcome-trained readout heads map each grid's final representation straight to answer
  probabilities, with no token generation.

Two practical consequences. First, any decoder LLM can imitate the *interface* by reading the
next-token distribution over answer labels after a prefill, which is what the zero-training recipes
do. Second, imitating the *calibration* needs training against outcomes (TypeSafe calls its version
RLCD, Reinforcement Learning for Calibrated Decisions [search]); the open projects approximate this
with cross-entropy or KL training plus post-hoc temperature or isotonic scaling, and one (Verdict)
with a separate confidence head.

## 3. The recipes, with sources

### Recipe 1: logit readout from a frozen model (no training)

| Project | Model | Method | Numbers | Hardware | Licence |
|---|---|---|---|---|---|
| `TheoLeeCJ/SemIf-OpenJev` (4.1k stars) [opened] | Qwen3.5-4B frozen; optional Qwen3.8-27B EXL3 | Single forward pass; read logits for declared option tokens; suffix reuse for parallel questions; per-workload temperature scaling | Authored decisions 0.813, WANLI 0.637, agreement with a Jev subset 0.845 vs Jev's published 0.883; ECE 0.208 → 0.069 after temperature; 21 binary decisions in 1.0 s on an RTX 3090, 5.2× faster than JSON generation | 3090 class, or CPU via llama.cpp, or Apple MLX/MPS; also a WebGPU browser demo | MIT |
| `ekzhang/openjev-sglang` (300 stars) [opened] | Qwen3.6-35B-A3B on SGLang | Prefill-only, `max_new_tokens=1`, label logprobs renormalised by softmax; single-token letter labels verified at startup for up to 64 options; radix cache warmed with the shared prefix | Confidence defined as 1 − H(p)/log K; the README says probabilities are *not* calibrated correctness estimates | One B200 on Modal | Not stated |
| `razorback16/openjev` (369 stars) [opened] | DiffusionGemma 26B-A4B | Discrete diffusion: mask one answer slot per question, denoise once; slot distribution *is* the answer; re-reads 3× if entropy > 0.1 | 27–32 ms p50 single request, 760 ms p50 at 64 concurrent on an RTX PRO 6000 | ≥24 GB NVIDIA, or ~16 GB Apple silicon via MLX | Apache-2.0 |
| `SiliconLabAI/OpenJev` (112 stars) [opened] | Any OpenAI-compatible model | "Parallel" mode: one tiny per-option call returning a probability, softmax across options; or one-shot JSON | No benchmarks in README | API only | MIT |

**Tutorial value.** SemIf's repo is the closest thing to a tutorial: install, `semif-score --mode
direct --model Qwen/Qwen3.5-4B --input decisions.jsonl`, with documented calibration methodology and
reproduction commands. Its accuracy numbers are the only ones measured against a Jev subset.

**How Choice / Score / Noul map.** Noul = P(yes-token). Choice = softmax over option-label tokens,
argmax plus the distribution. Score = expected value Σ i·pᵢ over ordered level labels (both
openjev-sglang and razorback16 do this). Confidence = normalised entropy in most projects, which is a
*sharpness* measure, not a calibrated accuracy estimate; `stillmarcus24/jev-verify` reports that a
normalised-entropy implementation reorders ~10% of pairs relative to Jev [opened via robustness list].

### Recipe 2: LoRA-tune a small decoder on typed decisions

| Project | Model | Method | Numbers | Hardware | Licence |
|---|---|---|---|---|---|
| `jaredpalmer/kev` [opened] | Qwen3.5 0.8B / 4B / 9B | Rank-16 LoRA, cross-entropy over answer labels, 2 epochs; trained on "decision-v7" (10k public-dataset rows + 896 generated policy examples + 1,680 from 60 rule structures); temperature fitted on dev; API-compatible with TypeSafe; explicitly built from Hume's inferred architecture | Held-out accuracy 68.4% (0.8B), 83.7% (4B), 85.2% (9B); Kev-9B 0.822 vs Jev 0.857 on new-source dev; Brier 0.237 vs Jev 0.211 | L40S ~50 ms for 6 questions (4B); H100 ~30 ms; Apple M5 via MLX 721 ms cold / 136 ms cached | Apache-2.0 |
| `S1LV3RJ1NX/openjev` (9 stars) [opened] | Qwen3-1.7B + rank-16 LoRA, or ModernBERT encoder | `make_task.py` builds a task from a CSV (text column, label column); `train.py` fits LoRA and saves calibration temperatures with the checkpoint; `compare_to_jev.py` | Zero-shot Banking77 (77 options): 0.605 decoder vs 0.863 Jev. Fine-tuned healthcare router on 395 examples in 258 s on an H100: intent 0.979 vs Jev 0.941; scope gate 0.978 vs 0.880. Option descriptions that distinguish neighbours add +5 points; restating label names adds nothing. Train from base weights, not the general adapter, for narrow tasks (0.979 vs 0.953) | H100 tested; decoder 56 ms p95 / 3.4 GB, encoder 20 ms p95 / 0.6 GB | Apache-2.0 |

**Tutorial value.** Kev's README plus `PLAN.md` (a full research log) and `/docs` is the most
complete "train your own" guide found, including `kev.train --init_from jaredpalmer/kev-4b` for
continued fine-tuning at a lower learning rate (~2e-5). S1LV3RJ1NX/openjev is the shortest path from
"I have a CSV" to a served Choice question, and its ablations are directly useful design rules.

### Recipe 3: distil an open teacher into a ~150M encoder

| Project | Model | Method | Numbers | Hardware | Licence |
|---|---|---|---|---|---|
| `Shalimov04/open-jev` [opened] | Teacher: local Qwen3.8-27B via vLLM with logprobs; student: mmBERT-small ~140M | Teacher soft labels = softmax over logprobs of one constrained letter token; KL-divergence distillation; calibration `logits / T + b` fitted on 500 held-out rows; `openjev run tasks/mytask.yaml` runs label → train → calibrate → evaluate → serve at `/v1/systemone` | 27 tasks (EN/RU): accuracy 0.617–0.944; ECE raw 0.017–0.252 → calibrated 0.004–0.129; 5–7 ms per example, up to 2,644/s; students match or beat the teacher on ~50% of tasks after bias correction; "500 gold labels buy more as a per-class calibration bias than as training signal" | Single GPU, 5.5 GB at 256 tokens / 8.9 GB at 512 | MIT |
| `Heman10x-NGU/openJev-verdict-2.0` (279 stars) [opened] | ModernBERT-base, 149.6M | Two heads: a distribution head trained to match expert-panel soft labels, and a separate out-of-fold confidence head for routing; "Symmetric Permutation-KL" penalty to cut option-order bias (flip rate 4.76% vs 7.41% for Kev); fine-tuned on `LocalLLaMA/typed-decisions` | 2,000 held-out enterprise decisions: Verdict 77.10% / Brier 0.064; Laya 76.60% / 0.066; Jev 72.70% / 0.148. Confidence head ECE 0.0144, AUROC 0.766. Selective accuracy 83.4% at 80% coverage, 95.2% at 30% | Trained in 8.8 h on a GTX 1660 Ti (6 GB); inference in-browser via WebGPU (<600 MB) | Apache-2.0; weights `heman10x/rlcd-modernbert-151m` on Hugging Face (blocked) |

**Tutorial value.** open-jev ships `docs/task-spec.md`, `docs/pipeline.md`, `docs/findings.md` and
`docs/serving.md`; it is a complete, documented distillation pipeline. Verdict's `RUNBOOK.md` exists
but the README does not describe training on custom data. Note Verdict's benchmark is one where Jev
does unusually badly; treat the ranking as task-specific.

### Recipe 4: use a pre-trained open decision model as-is

| Project | Backbone | Notes | Numbers | Licence |
|---|---|---|---|---|
| Laya (Convai Innovations) [search; HF and site blocked] | ModernBERT-large, ~421M, multilingual (100+ languages), non-autoregressive | `pip install laya`; Node client `receptron/laya` via ONNX Runtime; ~1.7 GB weights | ~33 ms per call; 76.6% on Verdict's benchmark; 50–65 on JevBench tiers | Apache-2.0 (weights); MIT (Node client) |
| Bosun v3.1 (Hanno-Labs) [search; HF blocked] | Qwen3 0.6B and 1.7B | Ships choice/score/noul inference; also publishes DecisionBench | Not seen | Apache-2.0 |
| jeff (GliFormer-large 400M) [opened] | GLiFormer encoder, no training | `uv run jeff`; point `TYPESAFE_BASE_URL` at it; sigmoids temperature-scaled at 3.2 | AG News 75.5% vs Jev 90.5%; JevBench 66.9 (#9) vs Jev 75.3 (#2) in an earlier version; ~$2.6 per million requests on Modal L4 vs ~$15.6 for Jev | MIT |
| Mapika/decider-2b [search; HF blocked] | Qwen3.5 fine-tune, "calibration-aware RL on v10" | Used as SiliconLabAI/OpenJev's "decider" backend; ~4 GB VRAM | Not seen | Unknown |

### Where they stand against each other

`fstandhartinger/jevbench` v1.4.0 (534 frozen decisions, six task families, held-out hard tier)
[opened]: Jev 1.13.0 leads at 63.29, then JevK5 62.04, Hopper 59.43, Winnow-12B 55.58, reflex-4B
53.99; open-jev variants sit in the mid-50s; Laya and GLiNER2 checkpoints 50–65; Kev-0.6B was #9 in
an earlier version. Reading: the best open reproductions are within a few points of Jev on general
decisions; on a narrow task with a few hundred labels, a fine-tuned small model can beat it.

Calibration audits worth reading before trusting any confidence number, Jev's included
(`Yifan-Lan/awesome-jev-robustness` [opened]): `jujumilk3/jev-calibration-audit` (400 items, ECE
against noise floor), `SamuelSacco/jev-exploration` (published ECE is 2.1–2.5× the floor at every
tier), `AnthusAI/Jev-Calibration` (isotonic regression takes ECE 0.117 → 0.008 on 8,801 sentiment
rows), `Adilmp/does-jev-confidence-mean-anything` (two-parameter recalibration removes 96% of error).
The same post-hoc recalibration applies to every recipe above and is cheap.

## 4. Suggested plan for us

1. **Day 1: local stand-in with no labels.** Run SemIf on Qwen3.5-4B (CPU via llama.cpp is fine for
   CI; a 3090-class GPU for interactive use). Expose it on the Jev wire format so the shared wrapper
   from the platform document §7 can switch `baseURL` between TypeSafe, jeff, openjev and this.
   Exit criterion: the eval harness runs end to end without a paid key.
2. **Week 1: measure, don't assume.** For each project's ~200-example labelled set, run Jev, SemIf,
   Laya and jeff through the harness; plot confidence vs accuracy; fit a temperature (or isotonic)
   map per model per question. Record which questions each model gets wrong; expect the small models
   to fail on negation and scoping (the source report's Part 2 rules bite harder here).
3. **Week 2–3, only where a 300–1,000 label set exists:** fine-tune. Narrow single-question tasks
   (Tessera misconception Choice, Community Moderator Nouls, Inbox Reflex intent): Kev-4B or
   S1LV3RJ1NX/openjev LoRA, from base weights, with neighbour-distinguishing option descriptions.
   Latency-critical or offline targets (NPC Director, Home Intent Layer): open-jev distillation into
   mmBERT-small, teacher = a local Qwen, never Jev.
4. **Keep the model version and calibration parameters in the per-decision log** exactly as for
   Jev; a re-trained student is a new "model version" for threshold purposes.

## 5. Constraints and prerequisites

| Item | Type | Why needed | How to get it | Blocking? | Status |
|---|---|---|---|---|---|
| TypeSafe AUP clause on distillation and imitation | legal-ToS | Decides whether Jev may ever be the teacher or the label source for a student model. Snippets say no. | Read `typesafe.ai/legal/*` directly (blocked here) | Yes, for any Jev-labelled training | unverified clause text |
| GPU for training: ≥6 GB for 150M encoders (Verdict trained on a 1660 Ti), ~24 GB for LoRA on 4B, H100 class for 9B or the 27B teacher | hardware | Recipes 2 and 3 | Local GPU, or Modal / RunPod hours | No (cloud hours are cheap) | known |
| Inference hardware for the fallback: CPU is enough for SemIf via llama.cpp; Apple silicon for MLX paths; a 3090-class GPU for sub-second interactive use | hardware | Recipe 1 and serving | Existing machines | No | known |
| Labelled sets per project (300–1,000 rows, double-labelled where judgment is subjective) | data | Fine-tuning and, above all, calibration; "500 gold labels buy more as calibration than as training" | Same labelling effort already required for Jev thresholds | Yes, for recipes 2–3 | open |
| Open teacher model access (Qwen3.5/3.8 weights) and vLLM with `logprobs` + `structured_outputs` | access | Recipe 3 | Hugging Face (blocked from this sandbox, fine elsewhere) | No | known |
| Licences: Qwen (Apache-2.0), DiffusionGemma (Apache-2.0), GliFormer, ModernBERT (Apache-2.0), Laya (Apache-2.0), Bosun (Apache-2.0); dataset rows keep upstream licences (`LocalLLaMA/typed-decisions`, Banking77 etc.) | legal | Shipping a student model inside a product (NPC Director) | Check each model card | No | mostly known; Mapika decider unknown |
| A benchmark the whole team trusts | decision | JevBench and DecisionBench disagree with Verdict's benchmark on who wins | Adopt JevBench for general comparison plus our own per-project sets | No | decision needed |
| Decision: which recipe is the default fallback | decision | Determines the wrapper's second backend | Proposed: SemIf on Qwen3.5-4B | No | proposed |

## 6. Risks and open questions

- **Calibration is the part that does not transfer.** Every recipe reports accuracy near Jev but
  confidence semantics differ (entropy vs outcome-trained). Mitigation: post-hoc temperature or
  isotonic fit per question on our own labels, re-fit on every model change.
- **Option-order and label-letter bias** in logit readouts (Verdict measured 4.8–7.4% flip rates).
  Mitigation: permute options and average, or use Verdict's permutation-KL training.
- **Small models read even more literally** and have less world knowledge; the Part 2 rules
  (explicit "other", filter state first, no arithmetic) become mandatory rather than advisable.
- **Benchmark noise.** Several audits find ECE close to its noise floor at 400 items. Do not compare
  models on fewer than ~500 labelled rows per question.
- **Open question:** whether the TypeSafe clause also forbids using Jev to *evaluate* a student
  (as `compare_to_jev.py` does). Evaluation is not training, but get the clause text.

## 7. Sources

Opened (GitHub):
- https://github.com/TheoLeeCJ/SemIf-OpenJev — logit readout from frozen Qwen; accuracy, calibration and latency numbers; commands.
- https://github.com/ekzhang/openjev-sglang — prefill-only single-token readout; Score as expected value; entropy confidence.
- https://github.com/razorback16/openjev — DiffusionGemma slot-denoising method and latency.
- https://github.com/SiliconLabAI/OpenJev — per-option micro-scorer softmax; Mapika decider backend.
- https://github.com/jaredpalmer/kev — LoRA recipe, decision-v7 data, results vs Jev, fine-tune command.
- https://github.com/S1LV3RJ1NX/openjev — CSV-to-task pipeline, ablations, fine-tuned router beating Jev.
- https://github.com/Shalimov04/open-jev — teacher–student distillation into mmBERT-small; calibration findings; docs.
- https://github.com/Heman10x-NGU/openJev-verdict-2.0 — dual-head 150M encoder; benchmark vs Laya and Jev; 1660 Ti training.
- https://github.com/jarihu/jeff — GliFormer drop-in; AG News and JevBench numbers; cost per million.
- https://github.com/typesafe-ai/system-one-adapter-python — official adapter over OpenAI/Anthropic/Gemini via structured output.
- https://github.com/harshithsunku/learn-jev-end-to-end — 12 notebooks; calibration in notebook 02; no local-model notebook.
- https://github.com/fstandhartinger/jevbench — 534-decision benchmark and v1.4.0 leaderboard.
- https://github.com/Anil-matcha/awesome-jev-by-typesafe and https://github.com/AbdelStark/awesome-typesafe-jev — index entries for Bosun, Laya, PlayJev, Kev, jevcal, Janus, Autoresearch cookbook.
- https://github.com/Yifan-Lan/awesome-jev-robustness — calibration audits and re-implementation comparisons.
- GitHub repository search for "openjev" and "awesome-typesafe" — star counts.

Search snippets only (page blocked):
- https://docs.typesafe.ai/models — "not fine-tuned or LoRA-adapted with customer data"; customise via state.
- https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery — Jev questions as features for CatBoost; 18 → 38 questions, 67 columns.
- https://archerhume.com/posts/jevs-architecture-unmasked/ — inferred architecture from ~10,000 probes.
- https://huggingface.co/convaiinnovations/laya, https://huggingface.co/Hanno-Labs/bosun-v3.1-1.7b, https://huggingface.co/Mapika/decider-2b — model cards.
- https://www.distillabs.ai/blog/jev-or-a-fine-tuned-small-model-we-built-a-pipeline-with-both-to-see-the-real-difference/ — a few dozen examples suffice for a narrow small-model fine-tune.
- https://sebastianraschka.com/blog/2026/jev-classification-generalization.html and https://stacktoheap.com/blog/2026/09/22/jev-attack-of-the-classifiers/ — commentary on Jev as a classifier.
- https://jevaiguide.com/faq/can-you-fine-tune-jev/ — "no; customise instead".
