# 04 — Dynamic discovery of reusable processes

_Workstream D, 24 Sep 2026. Web search worked; arxiv.org, typesafe.ai and huggingface.co were blocked, while GitHub and PyPI were read directly. Tags: **[opened]**, **[search]** (snippet only), **unverified**, and **own analysis** (my arithmetic, or SQL run on DuckDB 1.5.5 over synthetic data). All numbers in the worked example (§3.12) are illustrative._

## 1. Summary

The loop is buildable, mostly as SQL and plain statistics over the store. The hard parts are turning a free-text LLM decision into a closed output space, and validating a replacement when the teacher (the LLM) is itself noisy. Four challenges to the plan:

- **Promote decision points, not processes.** A promoted unit is one question, a threshold and an LLM fallback for the abstain band. A "process" is the versioned DAG those units compose into.
- **Code before model.** First test each decision point as a SQL rule (decision trees on code features, as in PM4Py's decision mining). It becomes a Jev question only if no rule fits.
- **A compiled process still needs an LLM** for the abstain band and a permanent 5% audit sample. That sample is also the only legally clean, fresh label stream after promotion.
- **Discovery is an offline job, not a runtime layer.** The orchestrator needs only shadow execution and check-sampling.

| Hypothesis | Verdict |
|---|---|
| **H1** | **Supported for record-processing, conditional in general.** TraceCompiler names "residual LLM decisions" as a binding class [search]. A tool-using Jev/LLM case study avoided the LLM on only 2 of 22 steps [opened: typesafe-ai/skills#11]. The §3.11 metric settles H1 per project, by count *and* by cost. |
| **H2** | **Half true.** Proposal from traces works with 20–50 examples per branch. Validation without humans does not: LLM agreement measures parity, not accuracy. Budget about 100–150 human labels per question, aimed at disagreements. |
| **H3** | **Supported here.** DFGs, variants, entropy, κ and threshold sweeps are about 10 lines of DuckDB SQL each (**own analysis**). |
| **H4** | **Plausible, untested.** Savings ≈ coverage − audit rate − judge cost, so the judge must cover about 85–90% of traffic. On Inbox Reflex, long draft generation caps whole-agent savings near 43% (§3.12). |
| **H5** | **Supported, with one trap.** After promotion, the only live labels are Jev's; retraining on them is distillation by accident (§2.3). |

## 2. Findings

### 2.1 Process mining is the right foundation, but agent traces are not event logs

Classical process mining works on (case, activity, timestamp) logs. It builds **directly-follows graphs (DFGs)**, counts **variants** (distinct sequences), discovers Petri nets or BPMN (Alpha, Inductive, Heuristics, ILP, POWL) and checks conformance. PM4Py 2.7.23.8 ships all of these, plus object-centric DFGs [opened wheel: `discover_dfg`, `discover_petri_net_inductive`, `get_variants`, `discover_ocdfg`]. Three of its modules map straight onto our loop [opened]:

- **decision mining** fits decision trees at Petri-net decision points;
- **contextual label-splitting** (van Zelst et al., BPM 2023) separates the meanings of one activity label;
- **concept-drift detection** (Bose et al., CAiSE 2011) runs permutation tests over windows of sub-logs.

PM4Py is **AGPL-3.0-or-later**, with a commercial licence on offer [opened]. Don't embed it; the pieces we need are short SQL (§3.3). Agent-specific work is recent: DFGs for boundary-testing agents (2607.06873) and red-team traces (2606.07833), and 7–43-state automata from trace corpora, with fitness ≥0.99 by 240 traces (2608.23670) [all search].

**Where agent traces differ from event logs:**

| Difference | Remedy |
|---|---|
| No activity labels: every LLM call is "llm", so the DFG collapses | Label by **prompt-template fingerprint** (a hash of the prompt with record fields masked) plus tool name; cluster unhashed prompts by embedding. This is label-splitting. |
| Ambiguous case notion: runs span records and records span runs | **Record id** is the case. Run and thread are objects, OCEL 2.0 style [search]. |
| The decision's information is in input text, not attributes | Compute code features first; the text becomes the judge's state. |
| Non-determinism: the same input can take different paths | Measure LLM self-agreement. It sets the ceiling in §3.6. |
| Retries and exploration make adjacency ≠ dependency | **Data-flow provenance**. TraceCompiler gets 0.928 precision / 0.943 recall on dependencies, against 0.712 F1 for a thresholded DFG [search]. |
| Prompt or model changes are built-in drift | Segment the log by (template hash, model version). |
| Outcomes arrive late | Join behavioural outcomes into `labels` with source `behaviour`. |
| Personal data | Store hashes and redacted state; only the drafting step sends examples out. |

### 2.2 The skill and procedural-memory literature: what transfers

§4 lists the papers. Four families matter:

- **Prompt-level memory keeps the LLM.** Agent Workflow Memory (2409.07429: +8.9 to +14.0 points as the train–test gap widens), ExpeL (2308.10144), Reflexion (2303.11366) and Memp (2508.06433) induce, update and *deprecate* natural-language procedures [search]. They improve the LLM; they do not remove it. What transfers is the **lifecycle vocabulary**.
- **Program skills move work into code.** Voyager (2305.16291), CodeAct (2402.01030), ASI (2504.06821) and SkillWeaver (2504.07079: +25–38% relative on WebArena; skills from strong agents lift weak ones by up to 54.3%) verify skills by execution [search]. "Better, Faster, Stronger" (2608.11338) finds programmatic skills cut agent cost most [search]. **The representation transfers**: a compiled process is a program with typed slots. **The verification does not**: they check *action sequences* by execution success, while our *judgments* need statistical estimates of correctness.
- **Compile-and-replay is closest to our goal.** Agentic Plan Caching (2506.14852) reuses plan templates [search]. SkillDroid (2604.14872) replays compiled GUI skills with no LLM calls and **recompiles when reliability degrades**: 87%→91% success, while a stateless baseline falls 80%→44% [search]. That is our demotion. TraceCompiler's "residual LLM decision" binding class (2608.02680) is exactly our decision point [search]. Workflow-to-Skill (2606.06893) warns that traces "may miss rare but safety-critical behaviors" [search]. SkillOps and SkillGuard (2605.13716, 2605.10990) treat library decay as typed-contract violation [search]; so should our question registry.
- **TRACER is the direct precedent for the gate** (2604.14531; `adrida/tracer`, MIT) [opened]. It trains logistic-regression, SGD or small-MLP surrogates on an LLM's classification traces. A learned acceptor defers uncertain inputs. A **parity gate** blocks deployment unless held-out teacher agreement clears α. On Banking77 it reached 92.2% coverage at 96.1% agreement, and it correctly refused an NLI task. It "needs about 1,000 traces and works best around 5,000".

Copy its gate. But **a zero-shot typed question needs far less data than a trained surrogate**: we fit a threshold, not a model, so hundreds of examples suffice instead of thousands. That is the case for Jev-style backends here. TRACER's recipe itself is legal only with an LLM or human teacher (§2.3).

### 2.3 The legal boundary

**The clause.** A fuller snippet of the TypeSafe MCA now reads: customers will not "use the Services or any Output to perform model distillation, train a model to imitate the output of the Services, or develop (or to facilitate the development of) a similar or competing product or service" [search: typesafe.ai/legal/mca; page blocked, so the full text is **unverified**].

**Anthropic's side.** Its help centre says Outputs may train models that do not compete with Anthropic's own [search].

**What the loop may and may not do:**

| Activity | Allowed? |
|---|---|
| Mine our own LLM traces and have an LLM draft questions from them | **Yes.** No TypeSafe output is involved; mind privacy, since trace content leaves the store. |
| Run Jev in shadow and compare it with the LLM and humans | **Yes.** Evaluation, not training; confirm (doc 15 open question). |
| Fit thresholds, temperature or isotonic maps on Jev probabilities against LLM or human labels | **Very likely yes.** A 1–2-parameter map to P(correct against *our* labels); the target is never Jev's output. Confirm. |
| Feed Jev probabilities as features into a classical model trained on human, LLM or behavioural labels | **Yes.** TypeSafe's own Autoresearch cookbook does this with CatBoost [search]. |
| Train a local surrogate on the LLM's decisions (TRACER, Kev/tev1 LoRA, an open-jev student) | **Allowed by TypeSafe.** Check the LLM provider's terms. |
| Train *any* model whose targets are Jev answers or probabilities | **No.** |
| Train on post-promotion traffic where only Jev answered | **No.** This is the accidental version of the row above. |
| Use Jev to pick which items get labelled or trained on | **Grey.** Don't, until the clause is read (doc 16 raises the same point). |
| Publish the framework as open source | **Probably fine**, since it consumes Jev; "facilitate the development of a similar … service" warrants a legal read if we ship local backends. |

**Enforce it in data, not policy.** `labels.source` takes only `human | llm:<model> | behaviour`, so Jev never writes labels. A `training_labels` view excludes every Jev decision, and a CI test fails if any trainer reads `decisions WHERE backend LIKE 'jev%'`.

## 3. Design proposal

### 3.1 The loop and the status machine

```
MINE ─► CHARACTERISE ─► PROPOSE ─► SHADOW ─► GATE ─► HUMAN ─► CANARY ─► ACTIVE ─► (drift) ─► DEMOTED ─► retire | re-propose
 SQL     SQL + tree fit    LLM draft,   judge beside  stats    approve   10–50%     audit 5%     auto        human
                           harness      the LLM
                           validates
```

- **Statuses:** `candidate → shadow → canary → active → demoted → retired`. Demotion is automatic and returns to shadow, with the LLM resuming. Re-promotion needs a human.
- **Schema additions:**
  - `decision_points` (id, template_fp, branch_def, n, k, entropy, class ∈ {rule, question, generation, open});
  - `promotions` (process_id, version, card_hash, approver, decision, ts);
  - `decisions.mode` ∈ {live, shadow, audit}, replacing a separate shadow table;
  - a `shadow_pairs` view joining shadow decisions to the LLM step and to `labels`.

### 3.2 Stage 0: the trace contract (a requirement on workstream C)

Every LLM step logs `record_id`, `template_id` and `template_hash`, the slot names with hashes of the record fields they drew on, the raw and parsed output, the model and version, and the **effect**: the next tool call with its argument class, or the label or route chosen. Outcomes are joined later. Without `effect`, the output space cannot be recovered.

### 3.3 Stage 1: mining (DuckDB)

```sql
-- Directly-follows graph; activity = kind:template (tested on DuckDB 1.5.5)
WITH nx AS (SELECT kind||':'||template_id AS act,
                   lead(kind||':'||template_id) OVER (PARTITION BY record_id ORDER BY step_no) AS nxt
            FROM traces)
SELECT act, coalesce(nxt,'END') AS nxt, count(*) AS n FROM nx GROUP BY ALL ORDER BY n DESC;

-- Decision-point candidates: branch set, entropy, and output length per LLM template
WITH b AS (SELECT template_id, effect, count(*) n, median(output_tokens) med_out
           FROM traces WHERE kind='llm' GROUP BY ALL),
     p AS (SELECT *, n / sum(n) OVER (PARTITION BY template_id) AS p FROM b)
SELECT template_id, sum(n) AS n_total, count(*) AS k, -sum(p*ln(p)) AS entropy, max(med_out) AS med_out
FROM p GROUP BY template_id;
```

Variants are `string_agg(act, ' > ' ORDER BY step_no)` per record. **A decision point** is an LLM activity with DFG out-degree ≥ 2, or ≤ 255 distinct parsed outputs (≤ 24 for small backends). Where affordable, confirm with a provenance check that the output flows into the effect.

### 3.4 Stage 2: characterise each decision point

**Define the branch by its effect, not the LLM's words.** The branch set is the set of observed downstream effects (tool, label, route or enum field), with branches under 2% merged into `other`. Then classify:

| Class | Signal | Target |
|---|---|---|
| **rule** | A depth-≤3 tree on code features (headers, sender history, regex hits) reproduces the branch at ≥99% on holdout, as in PM4Py-style decision mining | `rule` node, read by a human |
| **question** | Closed branch set, median output ≤ ~30 tokens, and the branch depends on text | Typed question (§3.5) |
| **generation** | One effect whose argument is long text used verbatim (a draft body) | Stays LLM; counts against H1 |
| **open** | k > 255, or the branch set keeps growing (free-form queries) | Stays LLM; try to decompose |

**Pick the type:**

- k = 2 → **Noul**.
- An ordered branch set (numeric parsed field, or option names that form a scale) → **Score**.
- Otherwise → **Choice**, always with `other`.
- **Split composite outputs.** "Label X and archive" becomes a Choice plus a rule: one judgment per question.

### 3.5 Stage 3: propose the typed question (the LLM drafts, the harness validates)

The drafting LLM gets the static prompt template, 20–50 (masked state, output, effect) examples per branch, the Part 2 rules and the available state fields. It returns question JSON: type, a literal instruction, one neighbour-distinguishing description per option, and a `state_projection`. The harness then runs, in order:

1. **Lint:**
   - `other`/`not_stated` present;
   - one judgment per question;
   - no counting, dates or arithmetic;
   - negations and scope spelled out;
   - projected fields exist;
   - nothing relies on the question id.
2. **Dev run** on 100–200 LLM-labelled rows.
3. **Confusion-driven rewrite:** only the descriptions of the top-3 confused pairs, with contrasting cases. Neighbour-distinguishing descriptions were worth about 5 points in S1LV3RJ1NX/openjev's ablation (doc 15).
4. **Projection ablation:** keep the smallest state within 1 point of the best, which also counters context rot.
5. **Freeze and hash** after at most 3 rounds. Drafting never sees the shadow split.

### 3.6 Stage 4: shadow validation statistics

The judge runs off the critical path on every new record (`mode='shadow'`). Every statistic below is a DuckDB query over `shadow_pairs`; κ and the τ sweep with a `wilson_lb` macro were tested (**own analysis**).

| Statistic | How |
|---|---|
| **Parity** | Raw agreement, Cohen's κ, per-class confusion, and recall of each *costly* class against the LLM. |
| **Ceiling** | Re-run the LLM at production settings on 50–100 records to get κ(LLM, LLM′). Re-run the judge 3× on the same records; one audit saw 50 identical Jev requests return 15 distinct answers [opened: jujumilk3/jev-calibration-audit]. **The bar is relative:** κ(judge, LLM) ≥ κ(LLM, LLM′) − 0.05, and never below 0.8. |
| **Correctness** | Humans label **every disagreement** (cap about 80) plus 50 random agreements. Then Acc_judge ≈ P(agree)·P(right \| agree) + P(disagree)·P(judge right \| disagree), and likewise for the LLM. Labelling effort goes where it carries information; this is why H2 holds only in part. Behavioural outcomes ("replied within 72 h", doc 01) are a third label source that is neither LLM nor Jev. |
| **Calibration** | 5-bin ECE against human labels, else LLM labels (marked "parity calibration"), always reported with its **simulated noise floor**. For a perfectly calibrated, high-skewed model the floor is 0.057 at n = 60, 0.032 at 200, 0.022 at 400 and 0.019 at 600 (**own analysis**, 2,000 simulations). The audits report ≈0.045 at n = 60, and Jev at 2.1–2.5× the floor [opened: SamuelSacco/jev-exploration]. Gate: after recalibration, ECE ≤ 2× floor with a monotone reliability curve. Removing the `unknown` option took accuracy on unanswerable items from 0.950 to 0.000 [opened]; `other` is mandatory. |
| **Selective accuracy** | Test τ from strict to loose, taking coverage and the Wilson lower bound of agreement on the covered set at each step. Keep the loosest τ that passes before the first failure. This fixed-sequence test is the Learn-then-Test idea (2110.01052) [search], and it stops cherry-picking. Irreversible actions also need a zero-failure bound (§3.7). |
| **Downstream effect** | **Counterfactual replay**: substitute the judge's answer into the stored trace, re-execute the deterministic downstream nodes, and compare task-level outcomes (e.g. "hid a message that needed a reply") against a non-inferiority margin. Sample downstream LLM steps rather than re-running them all. |

### 3.7 How much data, and when to stop

All figures are **own analysis**, using Wilson and Clopper–Pearson bounds at 95%.

| Purpose | Count |
|---|---|
| Drafting / dev | 20–50 examples per branch / 100–200 LLM-labelled rows |
| κ precision | n = 200 gives κ 0.84 ± 0.075 (p_o 0.92, p_e 0.5); n = 400 gives ± 0.053 |
| Selective agreement ≥ 95% (lower bound) | ≈260 covered rows at an observed 97.5%; ≈415 at 97% |
| Per-class recall | ≥ 30 rows per branch (Wilson half-width ≈ ± 0.11 at 0.9) |
| Irreversible action at ≥ 99.5% precision | **598 covered rows with zero errors** (rule of three); 299 for 99%, 149 for 98% |
| Human audit | ≈ 100–150 labels per question |
| Time | ≥ 14 days, to cover weekly cycles |

**Stopping rule:**

- Pre-register n_min = max(300, 30·k) and the gate.
- Check for futility once, at n = 100: if the upper bound on agreement is below the bar, stop and rewrite.
- Otherwise evaluate once at n_min. Peeking repeatedly needs anytime-valid confidence sequences.
- After three failed question versions, mark the decision point `keep-LLM` and re-mine in 90 days.

### 3.8 Stage 5: promotion, with human approval

**The gate.** All of the following must hold:

| # | Criterion |
|---|---|
| G1 | Volume, per §3.7. |
| G2 | Relative κ bar (§3.6). |
| G3 | Selective lower bound ≥ the action's target at τ, plus zero-failure bounds for irreversible actions. |
| G4 | On disagreements, the judge's right-share ≥ the LLM's − 10 points, and Acc_judge ≥ Acc_LLM − ε. |
| G5 | Calibration within 2× the noise floor. |
| G6 | Replay shows the task-level outcome is non-inferior. |
| G7 | Option-shuffle flips < 5%, judge self-agreement ≥ 0.95, injection-subset Δp within bound. |
| G8 | Projected savings are positive after audit and fallback. |

**The promotion card.** The harness renders one card and the owner approves or rejects it; the decision is logged in `promotions`. The card shows the question text and its diff from the LLM prompt, the confusion matrix, 10 disagreements with the human verdicts, τ and coverage, the cost delta, the fallback and the demotion triggers. After approval, the compiled path serves 10–50% of traffic as a canary for a week, then goes active.

### 3.9 Stage 6: drift and demotion

| Monitor | Signal | Action |
|---|---|---|
| Audit agreement (5% check-sample, LLM still runs) | CUSUM on disagreement against the shadow baseline | **Demote** |
| Output distribution | PSI or Jensen–Shannon on the judge's probability histogram and class mix against the shadow window; set the baseline from the reference window's split-half PSI, because Jev is non-deterministic | PSI > 0.2 alert; > 0.25 demote (conventional cut-offs, **unverified** here) |
| Label shift | BBSE (Lipton et al., 1802.03916) [search]: the shadow confusion matrix estimates the new class prior without labels | Re-fit τ; demote if the costly class grows |
| Coverage | The share above τ falls by more than 10 points | Alert, then demote |
| Model version | `response.model` ≠ pinned | **Immediate demote** |
| User corrections | Correction rate doubles over 7 days | Demote |
| A severe error on an irreversible action | Any one | Immediate demote |

A demoted process runs the LLM again, with the judge still in shadow. Fixing it means a new question version and a new card.

### 3.10 The compiled process representation

This is a DAG spec in `processes.spec`. The orchestrator runs it without an LLM except at `llm` nodes, which are marked as fallback, audit or generation.

```json
{"id":"inbox.triage","version":4,"status":"canary","derived_from":{"template":"T1@7","decision_point":"dp_17"},
 "nodes":[
  {"id":"feat","kind":"sql","sql":"SELECT * FROM inbox_features WHERE record_id=$record_id"},
  {"id":"short","kind":"rule","when":"feat.is_calendar OR feat.is_vip","emit":"surface"},
  {"id":"q","kind":"judge","backend":"jev-1.13.0","questions":["inbox.category@3","inbox.needs_reply@2"],
   "state":"feat.jev_state"},
  {"id":"route","kind":"rule","cases":[
     {"if":"q.category.confidence >= thr('inbox.category','label')","emit":"label(q.category.choice)"},
     {"else":"fallback"}]},
  {"id":"archive","kind":"rule","when":"q.category.choice IN ('newsletter','marketing') AND feat.bulk_headers",
   "emit":"archive","status":"shadow"},
  {"id":"fallback","kind":"llm","template":"T1@7","role":"abstain"},
  {"id":"audit","kind":"llm","template":"T1@7","role":"audit","sample":0.05,"mode":"audit"}],
 "edges":[["feat","short"],["short","q"],["q","route"],["route","archive"],["route","fallback"]],
 "gates":{"card":"sha256:…","approved_by":"james","ts":"2026-10-12"}}
```

Each node can carry its own status. That lets one process mix active and shadow nodes, which is how partial promotion works.

### 3.11 Metrics for H1–H4

| Hypothesis | Metric (all SQL over the store) |
|---|---|
| **H1** | Decision share: the share of LLM calls, and separately of LLM **cost**, in rule- or question-class decision points. Generation calls are long, so report both. Support: ≥ 60% of calls. |
| **H2** | Share of question-class decision points passing the gate within 3 versions; human labels per promoted question; card-rejection rate; dev→shadow agreement drop. |
| **H3** | Mining and gating queries finish in under 10 s at 1M trace rows on a laptop. Workstream A owns the benchmark. |
| **H4** | Cost per record, all-LLM vs compiled = c_judge + (1 − coverage + audit)·c_LLM, and task accuracy of both on one human-labelled holdout. Coverage 0.9 with a 5% audit gives ≈85% off. |

### 3.12 Worked example: Inbox Reflex (illustrative numbers, not measured)

**Agent v0 (all LLM).** Template **T1** ("Triage James's email: decide the label, whether he must reply, whether to archive; call tools") may call `apply_label`, `archive`, `star` or `create_draft`. Template **T2** writes drafts.

```
rec 8841 step0 tool:fetch_features → {from_domain:"substack.com", bulk_headers:true, in_contacts:false}
         step1 llm:T1  out:"A newsletter … label it Newsletters and archive; no reply needed."  effect: apply_label(Newsletters)
         step2 tool:archive                                                                     effect: archive
```

**Mining** (2,400 records over 30 days):

- **T1** has 9 label effects and a median output of 25 tokens → class **question**.
- **T2** has one effect and a median of 180 tokens → class **generation**.
- **Archive** follows a depth-2 tree, label ∈ {Newsletters, Marketing} ∧ bulk_headers, at 99.4% on holdout → a **rule**, not a question.
- **Decision share:** T1 is 86% of LLM calls but only about 55% of LLM cost. H1 holds on count and is weaker on cost.

**Proposed questions:**

- `inbox.category`: a Choice over the 9 labels plus `other`, with descriptions that set neighbours apart (e.g. "receipt: confirms a purchase already made; not a request to pay").
- `inbox.needs_reply`: a Noul using doc 01's instruction; the harness added "Answer no if it only asks the recipient to click a link".
- State: `latest.{subject, body≤1500, recipient_position}` plus `known_facts`.

**Shadow** (n = 620 over 16 days):

- **`category`:**
  - agreement 0.91, κ 0.88 against a ceiling κ(LLM, LLM′) of 0.93;
  - of the 56 disagreements, the judge was right on 22, the LLM on 27, and both wrong on 7;
  - 49 of 50 audited agreements were right, giving Acc_judge ≈ 0.927 and Acc_LLM ≈ 0.935;
  - at τ = 0.85, coverage is 0.83 with selective agreement 0.975 on 515 rows (Wilson lower bound 0.957);
  - ECE is 0.036 against a floor of ≈0.019.
- **`needs_reply`:** recall against the LLM is 0.93, below the 0.95 target. The dominant confusion is "please review the attached doc".

**The promotion card, as approved:**

1. **`inbox.category`: promoted to canary, for labelling only.** G1–G8 pass. κ is within 0.05 of the ceiling, and on disagreements the judge's right-share (39%) is within 10 points of the LLM's (48%).
2. **Archive rule: stays in shadow.** It has 310 zero-error covered rows; 99.5% precision needs 598.
3. **`needs_reply`: not promoted.** It goes to version 3 with a rewritten scope clause, and the LLM keeps the decision.

**Cost.** T1 cost falls by about 78% (1 − (0.17 + 0.05)). The whole agent falls only about 43%, because T2 drafts are about 45% of spend. On this project, H4 depends on whether drafting is in scope.

## 4. Prior art and alternatives

| Work | What it discovers | Representation | Validation | What we take |
|---|---|---|---|---|
| PM4Py [opened] | Process models, decision rules, drift | Petri net, DFG, decision tree | Conformance, permutation tests | Decision mining → `rule` nodes; drift test design. AGPL, so offline only. |
| Voyager, ASI, SkillWeaver, CodeAct [search] | Action skills | Code | Execution feedback | Skill as program; honing loop |
| AWM, ExpeL, Reflexion, Memp [search] | Workflows and insights | Natural language in the prompt | Task success | Lifecycle operations; induce only from successful runs |
| APC, SkillDroid [search] | Plan and GUI templates | Parameterised templates | Replay success; recompile | Demote on reliability loss; matching cascade |
| TraceCompiler [search] | Deterministic workflows with residual decisions | Workflow plus bindings | Provenance evidence | Data-flow dependencies over DFG adjacency |
| TRACER [opened] | Classifier surrogates | Embeddings + logistic regression/MLP + acceptor | Parity gate at α | The gate; coverage/agreement reporting. LLM teacher only. |
| Workflow-to-Skill, Trace2Skill, Trace2Tower [search] | Skills from traces | RWSA and skill directories | Mixed | Spec layout; warning about rare branches |
| SkillOps, SkillGuard [search] | Library defects | Typed contracts | Rule-based checks | Registry governance; drift as contract violation |

## 5. Constraints and prerequisites

| Item | Type | Why needed | How to get it | Blocking? | Status |
|---|---|---|---|---|---|
| Trace contract (§3.2) | engineering (C) | No `effect`, no output space | Specify in doc 03 | Yes | proposed |
| Shadow and audit modes; `decisions.mode` | engineering (A, C) | Shadow, check-sampling | Schema column, step option | Yes | proposed |
| Full MCA text: distillation, "facilitate", evaluation use | legal-ToS | H5; local backends | Read typesafe.ai/legal/mca | Yes, for any training | snippet only |
| LLM provider terms on training with outputs | legal-ToS | TRACER-style surrogates | Provider terms pages | For the surrogate path only | snippet (Anthropic) |
| Reviewer time: ≈100–150 labels and one card per question (1–2 h) | people | G4, approval | The owner | Yes | open |
| Pinned judge version, repeat-call and shuffle harness | engineering (B) | Ceiling, G7, drift | Doc 15 harness | Yes | open |
| Privacy of trace examples sent to the drafting LLM | legal (APP 8) | Traces hold others' data | Redact, or draft locally | Email projects | open |
| PM4Py licence (AGPL-3.0) | licence | Embedding | SQL instead; PM4Py in notebooks | No | known |
| ≥ 2,000 all-LLM trace records for one project | data | Mining, shadow | Run Inbox Reflex v0 for ~30 days | Yes, for H4 | open |

## 6. Risks and open questions

- **Goodhart on agreement.** A question tuned to the LLM inherits the LLM's errors. The counterweights are the disagreement audit (G4) and behavioural outcomes.
- **The label ratchet.** After promotion, fresh LLM labels exist only in the audit sample. Size it to detect a 5-point agreement drop within about two weeks.
- **Rare, critical branches** (credential lures, legal threats) are thin in traces. Never promote with fewer than 30 shadow rows in a costly class; seed adversarial sets from docs 01 and 08.
- **Overfitting question text to dev.** Watch the dev→shadow drop.
- **Non-determinism** (15 answers from 50 identical calls) weakens state-hash caching and inflates PSI.
- **Rubber-stamp approvals.** Keep cards short and require a reason. Prune questions with no traffic for 60 days, to avoid "skill technical debt".
- **Open questions:**
  - Can promoted questions from different decision points share one Jev call? One audit saw 16-vs-1 questions flip 0.4% of answers [opened].
  - Does the MCA's "facilitate" wording cover Jev-selected audit items?

## 7. Sources

**Opened:**
- https://pypi.org/project/pm4py/ and the pm4py 2.7.23.8 wheel (decision_mining, label_splitting, concept_drift, discovery.py, stats.py, ocel.py)
- https://github.com/process-intelligence-solutions/pm4py (AGPL-3.0 README)
- https://github.com/adrida/tracer and https://pypi.org/project/tracer-llm/
- https://github.com/jujumilk3/jev-calibration-audit
- https://github.com/SamuelSacco/jev-exploration
- https://github.com/typesafe-ai/skills/issues/11

**Search snippets:**
- arXiv (each at https://arxiv.org/abs/<id>): 2305.16291 (Voyager), 2409.07429 (AWM), 2308.10144 (ExpeL), 2303.11366 (Reflexion), 2402.01030 (CodeAct), 2504.06821 (ASI), 2504.07079 (SkillWeaver), 2508.06433 (Memp), 2506.14852 (Agentic Plan Caching), 2604.14872 (SkillDroid), 2608.02680 (TraceCompiler), 2604.14531 (TRACER), 2606.06893 (Workflow-to-Skill), 2603.25158 (Trace2Skill), 2609.05261 (Trace2Tower), 2608.11338 (programmatic skills and cost), 2605.13716 (SkillOps), 2605.10990 (SkillGuard), 2607.10113 (Dynamic Agent Skills survey), 2607.06873, 2606.07833, 2608.23670 (agents and process mining), 2403.01975 (OCEL 2.0), 2110.01052 (Learn then Test), 1802.03916 (BBSE)
- https://typesafe.ai/legal/mca (distillation clause)
- https://support.claude.com/en/articles/12326764-can-i-use-my-outputs-to-train-an-ai-model

**Internal:** `../jev-system-one/` docs 00 (§4–7), 01, 08, 15, 16.
