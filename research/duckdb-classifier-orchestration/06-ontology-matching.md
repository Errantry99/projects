# 06 — Matching free text to an ontology with a System One classifier

_Workstream F, 24 Sep 2026. Web search worked. Fetches: github.com and raw.githubusercontent.com opened
(awesome-jev lists, jev-tree, jlink, Jev_Ontology, jev-cookbook, jevals-data, jev-search-rerank-eval,
typesafe-ai/skills, duckdb-web docs). docs.typesafe.ai, arxiv.org, lyonwj.com and vendor docs were
blocked. Tags: **[opened]** page or file read, **[search]** search snippet only, **unverified** my own
background knowledge. All Jev accuracy and price figures are TypeSafe's own or builders' self-reports
unless marked otherwise._

## 1. Summary

**The recipe is: retrieve in DuckDB, verify with the classifier, abstain to a human.** SQL proposes
20–50 candidate concepts per record or span (BM25, embeddings, trigram, synonyms). One Jev call
verifies them with a Choice over the candidates' definitions plus "none" and "broader" options, and
code turns the probabilities into auto / review / reject. Everyone who has scaled this lands on the
same shape: Databricks' 100k-label AI Classify recipe [search], "Select, Don't Train" (BM25 plus an
LLM selector, new ZELDA state of the art) [search], MILA in ontology matching [search], jlink in
record linkage [opened], and TypeSafe's entity-alignment and hierarchical cookbooks [search]. The
binding constraint is **retrieval recall, not the 255-option cap**: the classifier cannot pick a
concept it was not shown.

**Verdicts:**

- **H1: strongly yes here.** Mapping to a closed concept set is the most typed decision there is.
  Generation is needed only to propose *new* concepts (§2.5).
- **H3: yes, with caveats.** ESCO (17k concepts), OSCA (1,156 occupations), UNSPSC (~157k) and
  SNOMED CT-AU fit in memory with FTS and HNSW. But the FTS index does not update itself, HNSW
  persistence is experimental, and HNSW serves only constant-vector `ORDER BY … LIMIT` queries
  (`vss_join` is brute force) [opened]. Batch candidate generation needs a host-side loop or the
  `faiss` extension.
- **H4: yes on cost, conditional on accuracy.** On the same 77-way Choice, Jev costs $0.043 per
  1,000 decisions against $1.37 for Gemini 3.8 Flash (32×) [opened: Jevals]. Accuracy parity is
  plausible for business taxonomies (intents, clauses, occupations, UNSPSC). It is unproven for
  SNOMED or ICD, where frontier LLMs are poor too (GPT-4: 33.9% exact ICD-10-CM [search]) and
  specialised domains are a stated Jev weakness.
- **H5: yes, with one rule.** Only human-`confirmed` or `rejected` mappings ever train anything (a
  SapBERT fine-tune, a re-ranker). `auto` mappings never do.

**Three amendments to the architecture:**

1. Add a **`retrieve` step kind**; candidate generation is not part of `judge`.
2. Support **question templates with runtime-bound options** from the `candidates` table, and put a
   **candidate-set hash** in the decision cache key.
3. Let concept proposals reuse the `processes` lifecycle (proposed → shadow → active → retired).
   Ontology growth and process discovery are the same loop.

## 2. Findings

### 2.1 Problem shapes, and which verifier fits each

| Shape | Examples (ours in bold) | Size | Best verifier | Main difficulty |
|---|---|---|---|---|
| Flat single-label | Banking77; **Tessera misconception list per item**; **lease `clause_type` (46 options, doc 12)**; **alarm `root_cause_class` (13, doc 10)** | 10–255 | One Choice over everything, no retrieval | Neighbouring labels; "other" discipline |
| Flat, larger than the cap | Eedi misconception bank (2,587 [opened: doc 11]); Home Assistant entities (300–2,000, doc 07) | 255–5k | Retrieve top-k, then Choice | Recall@k |
| Hierarchical | **OSCA (8 / 53 / 111 / 421 / 1,156 [search])**, ANZSCO, ESCO (3,039 occupations, 13,939 skills in v1.2 [search]), O*NET-SOC (1,016 titles [search]), UNSPSC (4 levels, 157,116 items in v24 [search]), Google product taxonomy (>6,600 [search]) | 1k–160k | Retrieve leaves, group by parent, Choice; or level-by-level with beam | Error at the top level propagates down |
| Large medical ontologies | SNOMED CT-AU, ICD-10-AM/ACHI, MeSH, UMLS (MedMentions) | 30k–400k+ (unverified) | SapBERT-class retrieval, then Choice with definitions; roll up on low confidence | Synonyms, abbreviations, post-coordination, licences, privacy |
| Multi-label tagging | **ESCO skills in a listing**; **MeSH on a preprint**; lease red flags | 5–50 labels per item | One Noul per retrieved candidate in the same call | Independent thresholds per label |
| Span-level entity linking | Wikidata; company master data; **Brick point classes** | 10k–100M | Code proposes spans; one Choice per span, all in one call | Mention detection (the classifier cannot output offsets) |
| Schema / ontology alignment | CSV column → canonical field; ESCO ↔ OSCA; OAEI tracks | Pairs | Score (different / related / same) plus field Nouls (TypeSafe entity-alignment cookbook [search]) | Many-to-many; "related" is not "same" |

### 2.2 The three verification recipes compared

The limits that shape the recipes:

- Choice caps at 255 options (implied by openjev, not seen on TypeSafe pages).
- The request budget is 64k tokens, of which about 32k may be state (unverified).
- Questions run in parallel over one state, so extra questions cost tokens but little latency.

**(A) Choice over top-k with definitions, plus "none" and "broader".** Best when recall@k is high.
Probabilities are relative: they sum to 1 over the candidates shown, so they are conditional on the
candidate set, and "none" must win the competition (it works only if described literally). Summing
sibling probabilities gives a free parent-level probability, so the result can roll up without a
second call (TypeSafe's "classification using confidence" pattern [search]). Jev's option-order flip
rate on Banking77 was 10.3% [opened: Jevals], so run a second permutation in the review band.

**(B) One Noul per candidate ("Does the text refer to X as defined here?").** All k Nouls go in one
call with the state sent once, so the cost is about 1.5–2× (A), not k× (billing assumption; check
`usage`). Probabilities are absolute: "none" is simply every p being low, and multi-label is free.
But Nouls are not mutually exclusive, so near-synonym siblings can both score 0.9. Use (B) for
multi-label and as a tie-breaker. jlink shows Noul judgments rank well but are miscalibrated in the
middle: on firms, pairs scored 0.5–0.8 averaged 0.64 and were right 39% of the time [opened].

**(C) Hierarchical narrowing.** One Choice per level (jev-tree [opened]), or a beam keeping the best
K paths by the geometric mean of edge probabilities (TypeSafe cookbook [search]); beam branches can
be parallel questions in one call. It wins when the tree is well authored and retrieval would miss.
jev-tree scored 180/180 on a 320-leaf synthetic catalogue against 0/90 on the tail for "truncate to
255", with fewer tokens per call [opened], though its cues were planted. It loses on latency (L
sequential calls), and a wrong level-1 turn is unrecoverable without a beam. The jev-cookbook's
8 × 6 product tree scored 36/36 both flat and level by level [opened].

**Recommended hybrid.** Retrieve the top 50 leaves and run one Choice over the top 20–30. If "none"
or "broader" wins, or the top parents disagree, re-ask one level up over those parents' children.
Add a Noul pass only for multi-label items or a margin under about 0.15.

### 2.3 Worked cost model (TypeSafe's own pricing: $0.042 per 1M input tokens, output free)

Assumptions (unverified estimates): about 300 tokens of state per record, 60 of instruction and about
40 per option with a definition. As a check, Jev's Banking77 calls averaged 1,030 input tokens for 77
short options [opened: Jevals log]. The LLM row scales Jevals' measured Gemini 3.8 Flash cost on the
same Choice ($1.37 per 1,000) to recipe A's token count.

| Recipe | Tokens per record | Cost per record | S1 personal (110k/yr, e.g. Opportunity Matcher) | S2 team (1.2M/yr) | S3 backfill (10M records) | Calls per record | Latency (p50) |
|---|---:|---:|---:|---:|---:|---:|---:|
| A: Choice, k=20 | 1,240 | $0.000052 | $5.70 | $63 | $521 | 1 | ~0.5 s (Jevals Jev p50 467 ms) |
| A: Choice, k=50 | 2,440 | $0.000102 | $11 | $123 | $1,025 | 1 | ~0.5 s |
| B: 20 Nouls, one call | 2,300 | $0.000097 | $11 | $116 | $966 | 1 | ~0.5 s |
| C: 5-level OSCA walk | 3,800 | $0.00016 | $18 | $192 | $1,600 | 5 sequential | ~2.5 s |
| Frontier LLM on A's prompt | 1,240 | ~$0.00165 | $181 | $1,980 | $16,500 | 1 | 1.6–4 s |
| Embeddings for records (API at ~$0.02 per M tokens, unverified; local is $0) | 300 | $0.000006 | $0.66 | $7 | $60 | n/a | n/a |

What the table hides:

1. **At S3 the rate limit, not cost, sets the timeline.** At a reported 1,200 requests per minute, a
   10M backfill takes 5.8 days with A or B and 29 days with C. That needs enterprise limits or an
   open backend (DiffusionGemma came within 0.03 of Jev's F1 on four of jlink's five benchmarks at $0 [opened]).
2. **Human review dwarfs model spend.** Reviewing 10% of S2 at 30 s each is about 1,000 hours a year,
   so the coverage-vs-accuracy operating point is the real cost lever.
3. **Concept embeddings are a one-off.** About 370k SNOMED concepts × 30 tokens is about $0.22 by API
   (unverified).

### 2.4 What "good" looks like (published accuracy)

| Task | Best published | Source grade |
|---|---|---|
| Banking77 (77 intents), zero-shot | Jev 0.797 accuracy, ECE 0.098 (300 items × 5 runs); Gemini 3.8 Flash 0.846; another run reported Jev at 0.863 | [opened: Jevals]; [opened: doc 15] |
| Banking77, supervised | 10-shot CPFT 87.2% [search]; full-data fine-tuned about 93–94% | unverified |
| General entity linking | GENRE average micro-F1 88.8 (AIDA plus 5 out-of-domain sets); ReFinED 90.2 F1 on AIDA; BM25 plus LLM selector 86.3 in-KB micro-F1 on ZELDA (previous best 82.3) | [search] |
| Biomedical normalisation | SapBERT acc@1 on NCBI 92.0, BC5CDR-d 93.8, BC5CDR-c 96.5, MedMentions about 52–54; ArboEL on MedMentions st21pv R@1 0.747, R@5 0.890 | [search] |
| Medical code lookup by LLMs | GPT-4 33.9% exact ICD-10-CM | [search] |
| Ontology matching (OAEI bio-ML) | MILA best F1 on 4 of 5 unsupervised tasks, calling the LLM only for uncertain pairs; OLaLa few-shot comparable to the top-3 OAEI systems | [search] |
| Large label sets (35k–100k) | Vector shortlist of about 20 plus AI Classify: 0.81 average accuracy, against 0.76 for a direct frontier model, at about 1/100 of the cost | [search: Databricks] |
| Record linkage with Jev | jlink F1 of 0.66 to 0.996 across five benchmarks, 171k pairs for $2.95 | [opened] |
| Jev as a re-ranker | Alone it does not beat bge-m3 (+0.012 NDCG@10, CI crosses 0). Fused with RRF it adds +0.09. bge-m3 recall@10 0.708 against 0.497 for the keyword ranker | [opened: jev-search-rerank-eval] |
| Misconception retrieval (Eedi Kaggle, MAP@25) | Silver-medal solution about 0.50 | [search] |

**What to expect:** 80–90% top-1 on well-described business taxonomies, 90%+ on the auto-accepted
share at 50–70% coverage, and 50–75% on UMLS-scale linking. On MedMentions, dense retrieval beats
BM25 on recall@10 [search], which is where SapBERT-style encoders earn their keep.

### 2.5 The "none / other" bucket is the ontology-growth loop

**The loop:**

1. Mappings where "none", "broader" or low confidence wins become `hitl_queue` rows (reason
   `unmapped` or `ambiguous`).
2. Nightly, unmapped mentions are embedded and clustered in the host (HDBSCAN or leader clustering).
3. For each cluster above a size floor, an LLM drafts a proposal: label, definition, includes,
   excludes, parent, nearest sibling and the distinction from it.
4. The proposal enters `concepts` as `proposed`; a human approves it to `shadow`.
5. Affected records re-run in shadow. The proposal goes `active` only if it absorbs its cluster
   without stealing confident mappings from siblings.

Track the unmapped rate over time; Tessera's plan already uses the "other" rate per topic as its
taxonomy-gap signal (doc 11). The evidence is thin. In Jev_Ontology one LLM revision lifted three
hedged tickets from 0.56–0.68 to 1.00, but its held-out test found gains "do not transfer to unseen
tickets beyond run-to-run noise", and one revision opened a new gap [opened]. So judge proposals on
a held-out split, never on the items that generated them. `jev-align` does the same for
*definitions* (GEPA over uncertain rows plus an audit sample, with a diff a human accepts)
[opened]; use it to sharpen sibling descriptions.

**This mirrors Workstream D.** D clusters LLM decision points into proposed questions; F clusters
unmapped mentions into proposed concepts. Same lifecycle, shadow test and human gate: share one
`proposals` table and one promotion policy.

**The reverse also holds: discovered decision points form a task ontology.** Each promoted question
is a concept (instruction as definition, options as children). Before D registers a new question,
align it against the `questions` registry with a *same / related / different* Score (the
entity-alignment recipe). That dedupes questions, reuses thresholds, and exposes families such as
"urgency", which Inbox Reflex, Alarm Triage and Community Moderator each phrase differently.

## 3. Design proposal

### 3.1 Data model (DuckDB)

```sql
INSTALL fts; LOAD fts; INSTALL vss; LOAD vss;
CREATE TABLE ontologies (ontology VARCHAR, version VARCHAR, licence VARCHAR, source_url VARCHAR,
  loaded_at TIMESTAMP, embed_model VARCHAR, PRIMARY KEY (ontology, version));
CREATE TABLE concepts (ontology VARCHAR, version VARCHAR, concept_id VARCHAR, label VARCHAR,
  definition VARCHAR, includes VARCHAR[], excludes VARCHAR[], sibling_note VARCHAR,
  parents VARCHAR[], depth INT, is_leaf BOOLEAN,
  status VARCHAR,               -- proposed | shadow | active | deprecated
  replaced_by VARCHAR, embedding FLOAT[768],
  PRIMARY KEY (ontology, version, concept_id));
CREATE TABLE concept_terms (term_key BIGINT, ontology VARCHAR, version VARCHAR,
  concept_id VARCHAR, term VARCHAR, kind VARCHAR);   -- label | synonym | hidden | local_alias
CREATE TABLE mentions (record_id VARCHAR, span_id VARCHAR, start_char INT, end_char INT,
  text VARCHAR, context VARCHAR, detector VARCHAR, embedding FLOAT[768]);  -- span_id '*' = whole record
CREATE TABLE candidates (run_id VARCHAR, record_id VARCHAR, span_id VARCHAR, ontology VARCHAR,
  version VARCHAR, concept_id VARCHAR, via VARCHAR[],  -- bm25 | vss | trigram | synonym | parent_expand
  bm25 DOUBLE, cos DOUBLE, jw DOUBLE, rrf DOUBLE, rank INT, candidate_set_hash VARCHAR);
CREATE TABLE mappings (record_id VARCHAR, span_id VARCHAR, ontology VARCHAR, version VARCHAR,
  concept_id VARCHAR,           -- NULL = none
  level INT, rolled_up_from VARCHAR, method VARCHAR,  -- choice_topk | noul_each | tree | hybrid
  probs JSON, p_top DOUBLE, margin DOUBLE, p_none DOUBLE, p_calibrated DOUBLE,
  backend VARCHAR, model_v VARCHAR, question_id VARCHAR, question_v INT,
  candidate_set_hash VARCHAR, threshold_v INT,
  status VARCHAR,               -- auto | review | confirmed | rejected
  decided_by VARCHAR, ts TIMESTAMP);
PRAGMA create_fts_index('concept_terms', 'term_key', 'term');           -- rebuild on version load
CREATE INDEX concepts_hnsw ON concepts USING HNSW (embedding) WITH (metric = 'cosine');
```

`mappings` layers onto the plan's `decisions` table, with one decision per call. `labels` feeds
`confirmed` and `rejected`. Crosswalks, such as ANZSCO→OSCA or ESCO→ISCO published by the
classification owners, go into a `concept_maps (from, to, relation)` table and are used for
`parent_expand` and for evaluation against legacy-coded data.

### 3.2 Pipeline

1. **`sql` step: detect mentions.** Use a dictionary match via FTS over `concept_terms`, regexes
   (codes such as "ICD J45.9" or "UNSPSC 43211500" resolve deterministically, with no model), and
   optionally GLiNER-style span proposals. For record-level mapping, use `span_id='*'`.
2. **`retrieve` step: generate candidates.** The per-mention lexical leg:

   ```sql
   SELECT concept_id, max(s) AS bm25 FROM (
     SELECT concept_id, fts_main_concept_terms.match_bm25(term_key, $q) AS s
     FROM concept_terms WHERE ontology = $o AND version = $v) WHERE s IS NOT NULL
   GROUP BY 1 ORDER BY 2 DESC LIMIT 50;
   ```

   The dense leg is `ORDER BY array_cosine_distance(embedding, $qvec::FLOAT[768]) LIMIT 50`, which
   uses HNSW because the vector is a constant. Add `jaro_winkler_similarity` over labels and exact
   synonym hits. The host loops over mentions with prepared statements, the legs are merged by
   reciprocal-rank fusion (RRF), and `parent_expand` adds the siblings of the top 5.
3. **`judge` step: verify.** Build the Choice from the top k (20 by default) in RRF order,
   deduplicated and shuffled, using opaque option keys (`o0…`), a definition per option, plus
   `none` and `broader`. All spans of one record go as separate questions in one call, with the
   record as state.
4. **`sql` step: decide.** Apply the calibration map and thresholds per (ontology, level, question
   version). Roll up to the parent when leaf `p_calibrated` is below the leaf threshold but the
   summed sibling mass is above the parent threshold. Write `mappings`. Route `review` items to
   `hitl_queue`.
5. **`human` step: review.** Show the top 3 with definitions and the retrieval evidence. If the
   reviewer picks a concept that was not a candidate, log a **retrieval miss**, the most valuable
   label there is.

### 3.3 Instruction patterns for a literal reader

- **Question:**
  > "Which listed concept does the text in `mention` (with surrounding `context`) explicitly refer
  > to? Choose by the definitions, not by shared words. If the text describes something more general
  > than every option, choose *broader*. If none of the definitions fits, choose *none*."
- **Option text:**
  > "{label}: {definition}. Includes: {includes}. Excludes: {excludes}. Unlike {nearest sibling}:
  > {sibling_note}."

  One builder found that neighbour-distinguishing descriptions add about 5 points and restating
  label names adds nothing [opened: doc 15].
- **Fixed options:** `none`, "The text does not refer to any listed concept." `broader`, "The text
  refers to a more general concept than all listed options." For single-label questions over a
  compound text, add `several`, "The text clearly refers to two or more listed concepts." This
  triggers the Noul pass. The Jev_Ontology "floor" was compound tickets [opened].
- **Noul:**
  > "The text states or clearly describes «label», defined as «definition». Answer no if it only
  > mentions a related, broader or narrower concept."
- **Never:** put the ontology in the state, ask for a code string, or ask the model to count the
  labels that apply. Deterministic code lookups come first.

### 3.4 Calibration, thresholds and evaluation

**Calibration.** P(correct) = P(gold ∈ candidates) × P(correct | gold ∈ candidates). Measure
recall@k on its own (no model call needed), then fit isotonic or temperature scaling end to end per
(ontology, level, backend, model version). Thresholds live in `thresholds`, keyed by level: leaves
need a higher bar than parents (for example, auto-accept an OSCA 6-digit occupation at ≥0.85
calibrated, and roll up to the 4-digit unit group at ≥0.75; illustrative only). A **gold-absent
guard** sends the item to review whatever its confidence when `p_none` > ~0.2 or the top
candidate's `cos` is below a fitted floor.

**Evaluation.** Build 300–1,000 labelled items per ontology, stratified by top-level branch, with
about 20% NIL and 10% injection items; double-label the first 50. Get free labels, and Cohen's κ,
from data that is already coded: UNSPSC on AusTender contracts, MeSH in PubMed, and the ABS coding
index (the latter two partly unverified). Metrics:

- recall@k;
- acc@1 and **hierarchical F1** (precision and recall over ancestor sets, so a sibling error costs
  less than a cross-branch one; Kiritchenko et al., unverified citation);
- NIL precision and recall;
- 5-bin ECE;
- the coverage-vs-accuracy curve;
- order-flip rate;
- per-branch confusion.

Never grade Jev against Jev-assisted labels: jev-search-rerank-eval found that the judge's identity
moved the same comparison from +0.053 to −0.028 NDCG [opened].

### 3.5 TypeScript interface sketch

```ts
type OntologyRef = { ontology: string; version: string };
type CandidateSpec = { k: number; legs: Array<"bm25" | "vss" | "trigram" | "synonym">;
  fuse: "rrf"; expandParents?: number };
type Verifier =
  | { kind: "choice"; extra: Array<"none" | "broader" | "several">; permutations: 1 | 2 }
  | { kind: "noul_each"; multiLabel: true }
  | { kind: "tree"; beam: number; maxFanout: number; stopDepth?: number };
interface MatchRequest { recordId: string; spanId?: string; text: string; context?: string;
  ontology: OntologyRef; candidates: CandidateSpec; verifier: Verifier; policy: string }
interface Mapping { conceptId: string | null; level: number; rolledUpFrom?: string;
  probs: Record<string, number>; pTop: number; margin: number; pNone: number;
  pCalibrated: number; status: "auto" | "review"; candidateSetHash: string;
  backend: string; modelVersion: string; goldAbsentSuspected: boolean }
interface OntologyMatcher {
  load(o: OntologyRef, src: AsyncIterable<ConceptRow>): Promise<void>;  // builds FTS + HNSW
  match(reqs: MatchRequest[]): Promise<Mapping[]>;   // batches spans per record into one call
  review(id: string, verdict: { conceptId: string | null; wasCandidate: boolean }): Promise<void>;
  proposeConcepts(o: OntologyRef, opts: { minCluster: number }): Promise<ConceptProposal[]>;
  evaluate(o: OntologyRef, set: string): Promise<{ recallAtK: number[]; acc1: number;
    hF1: number; ece: number; coverageCurve: [number, number][] }>;
}
```

### 3.6 Spitball: what this enables

Scores are Achievability / Impact / Demand / classifier fit, each out of 5.

| # | Idea | Pitch | A/I/D/F |
|---|---|---|---|
| 1 | **Opportunity Matcher → OSCA + ESCO skills** | Code each job to an OSCA occupation (retrieve, Choice, roll up to unit group) and tag ESCO skills with Nouls over retrieved skills; store the user's profile as concepts too. Matching becomes weighted concept overlap, explainable per skill and immune to title wording. OSCA enters ABS statistics from Sep 2026 [search]; keep ANZSCO via the crosswalk for migration lists. | 4/4/3/5 |
| 2 | **Tenders → UNSPSC** | Map the capability statement to UNSPSC families once, filter AusTender notices by code in SQL, and ask Jev only where the code is missing or vague. Awarded contracts carry codes (unverified), which are free labels. | 4/3/3/4 |
| 3 | **Tessera → Eedi misconceptions** | Retrieve from Eedi's 2,587-entry bank, Choice over the top 15 plus "other". "Other" clusters become proposed misconceptions for a teacher to approve, so per-item lists grow into a shared bank. | 4/3/2/4 |
| 4 | **Lease clause → type → statute** | Two-level Choice (family, then one of 46 types), then a Noul per candidate section of the state's retail-leases act. Lawyers get a clause-to-provision map with confidence. | 3/4/2/3 |
| 5 | **Alarm points → Brick classes** | Point names such as "AHU3_SAT_SP" map to Brick classes via trigram and synonym retrieval, then hierarchical Choice, human-reviewed. This is doc 10's v2 tagging, and a prerequisite for the alarm product. | 3/4/2/4 |
| 6 | **Evidence Screener → MeSH for preprints** | arXiv, medRxiv and OpenAlex items lack MeSH; Nouls over the top 30 retrieved descriptors give PubMed-style filters. PubMed's own MeSH is a free eval set. | 4/3/3/4 |
| 7 | **Inbox master-data linker** | Link senders, companies, projects and sites in email to your own tables (spans, then Choice per span), so Inbox Reflex rules can say "anything about Project Kestrel". | 4/3/4/4 |
| 8 | **Question registry dedup** | Align each question Workstream D proposes against the registry (same / related / different); duplicates inherit thresholds and labels. This is the task ontology. | 4/4/2/5 |
| 9 | **Column mapper for ingest** | Map incoming CSV or JSON fields to the canonical `records` schema: a Choice over fields plus "none", with sample values as state. The jev-cookbook PII column scanner got 25/25 on type [opened]. | 5/3/3/4 |
| 10 | **Odd: chess openings → ECO** | Code proposes ECO codes (A00–E99) by book-prefix match; Jev picks among transpositions, with "none" for offbeat lines. A fully labelled benchmark, and a demo for doc 14's chess bots. | 5/1/2/3 |
| 11 | **Odd: CVE text → CWE** | Map vulnerability text to CWE (hierarchical, 900+ entries, unverified) as the Guardrail Sidecar's risk taxonomy; NVD's assignments are the eval set. | 4/3/2/4 |
| 12 | **Odd: trip-report places → GeoNames or Wikidata** | Link "the Razor-Viking saddle" to a place ID (FTS over labels, then Choice with "none"), so Backcountry Sherpa reports land on map segments without hand geocoding. | 3/3/2/3 |

## 4. Prior art and alternatives

| Name | What it does | Relevance / what to take |
|---|---|---|
| TypeSafe cookbooks: entity alignment, hierarchical classification, classification using confidence [search] | Score plus field Nouls on 450 beer-catalogue pairs; greedy or beam tree traversal; roll-up on low confidence | The official patterns behind recipes A and C |
| jev-tree [opened] | Recursive Choice, auto-partitioning siblings (fan-out 32 by default) | Recipe C; truncating to 255 fails silently on the tail |
| jlink [opened] | Local blocking, a Jev Noul per pair, audit sampling | Blocking recall (67%) bounded F1 on firms; a model calibration table |
| Jev_Ontology [opened] | LLM revises the ontology when Jev's confidence is low | Growth loop; held-out gains within noise |
| jev-cookbook; jev-align [opened] | Taxonomy, multi-label and PII-column recipes; GEPA-refined definitions | Sanity numbers; sharpening sibling text |
| BLINK, GENRE, ReFinED [search] | Bi- plus cross-encoder; autoregressive names; single-pass linking | ReFinED links to new Wikidata entities without retraining |
| "Select, Don't Train" (Aug 2026) [search] | BM25 plus an LLM multiple-choice selector with abstention | Closest academic analogue of recipe A |
| SapBERT, ArboEL, scispaCy [search]; spaCy EntityLinker (unverified) | Biomedical encoders and linkers; KB plus candidate generator | Medical candidate leg; KB API shape |
| OAEI; OLaLa; LLMs4OM; MILA [search] | Ontology matching: few-shot open LLMs; RAG over 20 datasets; LLM only for uncertain pairs | Alignment is retrieve, cheap verify, escalate |
| Databricks `ai_classify` v2 (2–500 labels) [search] | Vector shortlist of about 20, then classify | Same pattern, in SQL |
| Snowflake `AI_CLASSIFY` (≤500 labels, multi-label) [search] | SQL classification with label descriptions | No calibrated probabilities seen |
| Amazon Comprehend custom (2–1,000 classes; 100 multi-label); Cohere Classify [search] | Trained classifiers; Cohere's default-model classify deprecated 31 Jan 2025 | Need labels; no hierarchy |
| DuckDB FTS, VSS, rapidfuzz, faiss, infera [opened] | BM25, HNSW, fuzzy matching, FAISS, in-database ONNX inference | infera might host a small embedding model (untested) |

## 5. Constraints and prerequisites

| Item | Type | Why needed | How to get it | Blocking? | Status |
|---|---|---|---|---|---|
| SNOMED CT-AU (and AMT) | licence | Clinical ideas | Free to Australian implementers via the NCTS (ADHA) under a SNOMED CT / national terminology licence [search] | Yes, for clinical | Open: is sending descriptions to a US processor "distribution"? Ask the NCTS |
| ICD-10-AM/ACHI/ACS 13th ed. (from 1 Jul 2025) | licence | Hospital coding | Code lists need an ECL account and licence; sold via Lane Print for IHACPA [search] | Yes, for ICD | Fees not seen |
| UNSPSC | licence | Tenders | Free to use and embed; English codeset downloadable without membership [search], which corrects the brief | No | known |
| ESCO v1.2; O*NET 31.0 | licence | Skills, occupations | ESCO free; O*NET CC BY 4.0 [search] | No | Check ESCO's reuse terms |
| OSCA 2024 / ANZSCO 2022; MeSH; Wikidata; GeoNames | licence | Matcher, Screener, linking | Free downloads (ABS CC BY 4.0, NLM terms, CC0, CC BY: all unverified) | No | known |
| Clinical-text privacy (APP 8; health information is sensitive) | legal | Clinical text to Jev | De-identify in code; identifiable text uses a local backend only | Yes, for clinical | Default local |
| 255 options; ~32k state (unverified); 1,200 rpm | platform | Recipe choice; S3 timeline | k ≤ 50; one call per record; enterprise limits or an open backend for backfills | No | Design handles it |
| Embedding model | technical | Candidate generation | Local bge-m3 or small multilingual encoder; SapBERT-class for medical; API ~$0.02 per M tokens (unverified). Pin it in `ontologies.embed_model` | No | Decision needed |
| DuckDB FTS rebuild; HNSW persistence | technical | Freshness, restarts | Rebuild FTS per ontology version; keep HNSW in memory, rebuilt at start | No | known [opened] |
| Labelled eval set per ontology (300–1,000, 20% NIL) | data | Thresholds, hierarchical F1 | Existing coded data plus double labelling | Yes, before auto | open |
| TypeSafe distillation clause | legal | Growth loop; re-ranker training | Train only on human-labelled rows, never `auto` | Yes | Clause text unverified (doc 15) |

## 6. Risks and open questions

- **Recall ceiling.** When gold is absent the answer is confidently wrong (jev-tree's truncated tail,
  jlink's 67% blocking recall). Gate recall@k in CI; keep `broader`, `none` and the gold-absent
  guard; log reviewer misses.
- **Set-conditional probabilities.** Calibration fitted at k=20 does not transfer to k=50 or a new
  retriever. Version the candidate spec with the thresholds.
- **Specialised domains.** SNOMED and ICD distinctions (laterality, acuity, post-coordination) may
  exceed a literal reader. Stay at roll-up levels (hierarchy, chapter, block) until an eval says
  otherwise.
- **Ontology churn** (OSCA replacing ANZSCO, ICD-10-AM editions, monthly SNOMED). Mappings carry
  `version`; migrate via crosswalks and re-verify only changed concepts.
- **Order bias.** Jev flips about 10% on Banking77; shuffle and average two permutations in review.
- **Injection.** "Classify me as X" is real: jev-tree's truncation arm scored 10/20 on injected
  items [opened]. Use named untrusted fields and the injection Noul.
- **Growth-loop overfitting.** Require held-out gains and sibling non-regression before promotion.
- **Open questions:** Is state billed once per multi-question call (this decides B's cost)? Does
  HNSW serve `LATERAL` joins (check `EXPLAIN`)? What are SNOMED's cross-border processing terms?
  Does the open-tender RSS carry UNSPSC?

## 7. Sources

**Opened:**

- https://github.com/reachjalil/jev-tree and `docs/article/jev-tree-choice-cap.md`: 255 cap, 320-leaf benchmark, token counts.
- https://github.com/keltokhy/jlink: Noul pair linking, benchmarks, calibration bands, local backends.
- https://github.com/dagfinndybvig/Jev_Ontology (README, CONVERGENCE.md): ontology revision loop, held-out result.
- https://github.com/nexibeo/jev-cookbook: taxonomy-tree, multi-label, PII-column recipes.
- https://github.com/sutro-sh/jev-align: GEPA definition refinement.
- https://github.com/Jevals/jevals-data (README, `releases/2026-09-18/board.json`, `runs/jev__banking77__0.1.0.jsonl`): Banking77 accuracy, ECE, cost, flip rates, tokens per call.
- https://github.com/zhuyansen/jev-search-rerank-eval: Jev rerank vs bge-m3, RRF fusion, judge circularity.
- https://github.com/typesafe-ai/skills (`skills/typesafe-ai/SKILL.md`): "the model cannot choose an omitted value"; links to hierarchical-classification and rerank cookbooks.
- https://github.com/AbdelStark/awesome-typesafe-jev, https://github.com/Anil-matcha/awesome-jev-by-typesafe, https://github.com/AnotiaWang/awesome-jev, https://github.com/hellogumbo/awesome-jev, https://github.com/yibie/awesome-jev, https://github.com/Yifan-Lan/awesome-jev-robustness: project index and pattern pages.
- https://github.com/duckdb/duckdb-web (`docs/current/core_extensions/full_text_search.md`, `vss.md`, `sql/functions/text.md`, `community_extensions/extensions/{rapidfuzz,faiss,infera}.md`): FTS, HNSW limits, string similarity, extensions.
- Local: `../jev-system-one/00-platform-jev-typesafe.md`, `15-small-models-as-system-one-classifiers.md`, `00-source-report.md`, docs 04, 07, 08, 10, 11, 12, 16.

**Search snippets only:**

- https://docs.typesafe.ai/cookbooks/entity_alignment ; https://docs.typesafe.ai/cookbooks/hierarchical_classification ; https://docs.typesafe.ai/cookbooks/classification_using_confidence
- https://www.databricks.com/blog/scaling-document-classification-100k-labels ; https://docs.databricks.com/aws/en/large-language-models/classify-documents-labels-tutorial ; https://docs.databricks.com/aws/en/sql/language-manual/functions/ai_classify
- https://docs.snowflake.com/en/release-notes/2025/other/2025-06-02-ai-classify-label-increase ; https://docs.aws.amazon.com/comprehend/latest/dg/prep-classifier-data-multi-class.html ; https://docs.cohere.com/changelog/classify-default-model-deprecation
- https://arxiv.org/abs/2608.27470 (Select, Don't Train) ; https://arxiv.org/pdf/2010.00904 (GENRE) ; https://github.com/amazon-science/ReFinED ; https://arxiv.org/pdf/2407.06292 and https://pmc.ncbi.nlm.nih.gov/articles/PMC11097978/ (SapBERT, ArboEL numbers)
- https://arxiv.org/html/2501.11441v1 (MILA) ; https://arxiv.org/html/2404.10317v1 (LLMs4OM) ; https://arxiv.org/pdf/2311.03837 (OLaLa)
- https://ai.nejm.org/doi/full/10.1056/AIdbp2300040 (LLMs are poor medical coders)
- https://www.abs.gov.au/statistics/classifications/osca-occupation-standard-classification-australia/2024-version-1-0/osca-structure ; https://www.jobsandskills.gov.au/data/what-is-osca ; https://www.itnews.com.au/news/abs-extensively-tests-aws-based-occupation-autocoder-for-june-launch-617836
- https://esco.ec.europa.eu/en/about-esco/escopedia/escopedia/esco-v12 ; https://www.onetcenter.org/database.html
- https://www.unspsc.org/faqs ; https://www.unspsc.org/codeset-downloads ; https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt
- https://developer.digitalhealth.gov.au/products/clinical-terminology ; https://www.ihacpa.gov.au/health-care/classification/icd-10-amachiacs ; https://www.ihacpa.gov.au/health-care/products-and-licenses
- https://github.com/DaoyuanLi2816/Kaggle-Eedi-Mining-Misconceptions-in-Mathematics-Silver-Medal ; https://github.com/jianguoz/Few-Shot-Intent-Detection (CPFT 10-shot)

**Unverified (background):** Banking77 full-data SOTA, SNOMED CT and MeSH sizes, CWE count, embedding API
price, Kiritchenko hierarchical-F1 citation, spaCy EntityLinker details, ESCO, ABS and GeoNames reuse
terms, Wikidata CC0.
