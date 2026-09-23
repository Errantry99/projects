# Jev / System One: research, market analysis and build plans

Fan-out of the "Jev & the System One model class" report (23 Sep 2026, 13-project shortlist)
into one research document per project, plus a cross-cutting document on the Jev platform
a 14th investigation ("can Jev play chess?"), and a note on turning small language models into Jev-style classifiers. Each project document was written by a
separate research agent following [`AGENT-BRIEF.md`](AGENT-BRIEF.md) and contains: the idea
fleshed out (exact Jev questions, what code decides vs the model), market research,
an implementation plan with phased milestones and a cost model, a **constraints and
prerequisites checklist**, risks, and sources.

## Read these first

1. [`00-platform-jev-typesafe.md`](00-platform-jev-typesafe.md): verifies the source report's
   claims, how to get access today, API surface, terms, fallbacks, and the shared engineering
   foundation every project should reuse (§7). Its "top 5 before building anything" and §8
   cross-cutting checklist apply to all 14 projects.
2. [`00-source-report.md`](00-source-report.md): the original report, for the one-pagers and
   the design rules (Part 2) the agents were asked to obey.

## Shortlist, re-scored

Scores are Achievability / Impact / Demand / Jev fit, each 1–5. "Source" is the original
report's total; "Revised" is the research agent's, after market research. Every project came
down; the agents found that Jev's cost advantage rarely matters at personal volumes and that
several ideas already exist as launch-week open-source projects.

| # | Project | Document | Source | Revised | Recommendation (one line) |
|---|---------|----------|-------:|--------:|---------------------------|
| 1 | Inbox Reflex | [01](01-inbox-reflex.md) | 18 | **16** (3/4/4/5) | Go-with-conditions: single-user, self-hosted on own Google Cloud project; labels only until ≥99.5% precision on auto-archive. |
| 2 | Attention Firewall | [02](02-attention-firewall.md) | 18 | **15** (4/3/3/5) | Go-with-conditions: personal, open-source, bring-your-own-key; fork `slop-filter`; X and HN first, LinkedIn out of store builds. |
| 3 | Guardrail Sidecar | [03](03-guardrail-sidecar.md) | 18 | **15** (5/4/2/4) | Go as internal infrastructure and the eval harness, not a product; LangChain's `AutoModeMiddleware` and Openlayer's jevals already cover the basics. |
| 4 | Opportunity Matcher | [04](04-opportunity-matcher.md) | 17 | **15** (4/3/4/4) | Go-with-conditions: personal tool over tenders, ATS boards and own alert emails; no scraping of Seek or LinkedIn. |
| 5 | Community Moderator | [05](05-community-moderator.md) | 17 | **14** (4/3/3/4) | Go-with-conditions: Minecraft-first shared mod queue or fork `jevmod`; no auto-actions before a 1,000+ message eval; never punish on self-harm signals. |
| 7 | Home Intent Layer | [07](07-home-intent-layer.md) | 16 | **14** (4/3/3/4) | Go-with-conditions: free HACS integration and Jev showcase; Home Assistant's own matcher makes Jev nearly redundant. |
| 6 | NPC Director SDK | [06](06-npc-director-sdk.md) | 16 | **13** (3/3/3/4) | Go-with-conditions: Director (pacing) node plus squad-level tactics, Godot add-on on LimboAI, backend-agnostic from day one. |
| 8 | Evidence Screener | [08](08-evidence-screener.md) | 16 | **13** (4/3/2/4) | Go-with-conditions: personal literature and thesis tracker; no accuracy claims until recall ≥0.95 on SYNERGY. |
| 9 | Live Meeting Reflex | [09](09-live-meeting-reflex.md) | 15 | **13** (3/3/3/4) | Go-with-conditions: personal, local-first macOS tool; one-day kill gate first because Jev tested weak at question and addressee detection. |
| 10 | Digital Twin Alarm Triage | [10](10-digital-twin-alarm-triage.md) | 15 | **13** (3/4/2/4) | Go-with-conditions: buildings only, advisory and read-only, shadow mode, partner app; needs a design partner with alarm history. |
| 11 | Tessera Answer Judge | [11](11-tessera-answer-judge.md) | 15 | **13** (4/3/2/4) | Go-with-conditions: one non-maths subject in shadow mode, 300+ double-labelled answers first; code grades maths, Jev tags the explanation. |
| 12 | Lease Abstraction Triage | [12](12-lease-abstraction-triage.md) | 14 | **12** (3/4/2/3) | Go-with-conditions: one-week accuracy spike on ~10 labelled Australian leases; sell to lawyers, not tenants (unauthorised-legal-practice risk). |
| 13 | Backcountry Conditions Sherpa | [13](13-backcountry-conditions-sherpa.md) | 13 | **11** (2/3/2/4) | Personal, non-commercial only; no-go commercial until forecast licence, trip-report permissions and legal advice are in place. |
| 14 | Can Jev play chess? | [14](14-can-jev-play-chess.md) | n/a | n/a | Yes, weakly (~950 Elo, builders' own numbers) when code lists legal moves and writes out tactical facts. No-go as an engine; go for a two-week test of Stockfish-proposes, Jev-picks-for-persona. |
| 15 | Small models as System One classifiers | [15](15-small-models-as-system-one-classifiers.md) | n/a | n/a | No TypeSafe tutorial exists; four community recipes (frozen-model logit readout, LoRA on a 0.8–9B decoder, distillation into a ~150M encoder, pre-trained open decision models). Start with SemIf on Qwen3.5-4B as the label-free local fallback. |

## What the agents found that changes the original report

- **Access is open.** The waitlist reportedly ended on 20 Sep 2026; sign-up is at the TypeSafe
  console with a small free credit. The report's "get off the waitlist" step is outdated.
  Details and caveats in the platform document §3.
- **Two numbers were off.** Cost per decision is roughly 20× lower than the report's figure
  (independent measurement, small states), and the state limit may be 32k tokens of the 64k
  request budget. Both are in the platform document §1 and §2.
- **Cost is rarely the wedge at personal scale.** For most projects a frontier LLM would cost
  cents more per day. Jev's real edge is sub-second latency and calibrated confidence for
  deciding what goes to a human. Several agents lowered "Jev fit" for this reason.
- **The rate limit is the real ceiling.** 1,200 requests per minute per account (reported,
  and "changing dynamically") caps anything hosted or multi-user: roughly 10–20 concurrent
  feed-scrollers, 1–2 players at per-NPC 2 Hz, ~150 simultaneous meetings, ~1.7M guardrail
  checks a day. Per-project numbers are in each cost model.
- **Launch-week open source already covers the obvious builds.** Named forks or prior art
  worth reading before writing code: `slop-filter` (feed filtering), `jevmod` (Discord
  moderation), `langchain-typesafe` `AutoModeMiddleware` and Openlayer `jevals` (guardrails),
  OpenWhisper (meetings, with the only human-labelled Jev benchmark), `1kpapers` (tagging),
  HEIST//ONE (NPCs), and at least six Jev chess bots.
- **Independent evidence on accuracy is thin and mixed.** OpenWhisper found Jev weak at
  question and addressee detection but strong at commitment and agreement detection. A
  reranking benchmark put it level with Cohere Rerank. Every project plan therefore starts
  with a labelled eval set (200–1,000 examples) and a shadow-mode gate before any automation.

## Cross-cutting constraints (what we need before building anything)

These appear in nearly every per-project checklist. Resolve them once.

| Item | Why it blocks | Where to look |
|------|---------------|---------------|
| TypeSafe console account, API key, and confirmation of current rate limits and version pinning (`jev-1.13.0`) | Every project; thresholds are meaningless without a pinned version | Platform doc §3–4 |
| TypeSafe legal terms: data retention, training on inputs, DPA, "no standalone resale", "no imitation training" | Email, voice, transcripts, leases, teen chat and leases all go to a US processor; the imitation ban constrains the NPC local fallback | Platform doc §5 (pages could not be opened; read them directly) |
| Australian Privacy Act position: APP 8 cross-border disclosure, no AU region found, zero-data-retention appears enterprise-only; Children's Online Privacy Code (due 10 Dec 2026) for Tessera and Community Moderator | Several projects handle other people's personal data | Platform doc §5, docs 01, 05, 07, 09, 11, 12 |
| API keys must stay server-side; the TS SDK blocks browsers by default | Browser extension, game clients and voice devices need a relay | Platform doc §7, docs 02, 06, 07 |
| Shared wrapper and eval harness: question schema, per-decision logging (version, probabilities, confidence), thresholds in config, confidence-vs-accuracy plotting | The report and every agent say thresholds cannot be trusted without it; Guardrail Sidecar doubles as this | Platform doc §7, doc 03 |
| Labelled eval sets per project (200–1,000 examples) and a labelling plan | Every recommendation is "shadow mode until the eval passes" | Each doc §4 |
| Platform access rules for the integrated system: Gmail restricted-scope verification and CASA, Discord data-access review, Chrome and Firefox data-collection disclosures, LinkedIn's ban on page-modifying extensions, BoM's no-reuse API terms, AllTrails and Strava anti-scraping, Lichess BOT rules | Decides whether each project can be anything more than a personal tool | Each doc §5 |
| Legal advice where the tool gives advice or records people: recording-consent law (all-party states), unauthorised legal practice (lease triage), financial-advice law (evidence screener ranking securities), negligent misstatement (backcountry) | Blocks any public release of those four | Docs 09, 12, 08, 13 |
| Owner decisions the agents could not make: which sources or platform first, safety tiers and PIN policy for the home, Tessera's stack, subjects and learner ages, design partner for alarm triage | Each doc lists these in its §5 table with "decision" type | Each doc §5 |

## Suggested order, revised

The original report said Guardrail Sidecar, then Inbox Reflex, then Tessera. The research
supports a similar order with a different framing:

1. **Shared foundation first** (platform doc §7): wrapper, logging, eval harness. A few
   hundred lines, and every other project needs it. Fold the Guardrail Sidecar into this
   rather than treating it as a product.
2. **Inbox Reflex** as a single-user tool on your own Google Cloud project: still the highest
   revised score, exercises the cascade end to end, and avoids the verification and CASA cost
   as long as it stays personal.
3. **Attention Firewall** or **Opportunity Matcher** as personal open-source tools: both are
   cheap, both have forkable prior art, and both stay clear of platform review while personal.
4. **Tessera Answer Judge** once the Tessera facts in doc 11 §5 are filled in and the
   children's-data position is settled.

Treat the rest as conditional on a design partner (alarm triage), a legal opinion (lease,
meetings, backcountry), or a positive eval spike (NPC director, home intent, evidence
screener, chess).

## How much to trust these documents

All agents had web search but page fetches were blocked for nearly every domain except
GitHub, npm and PyPI, including TypeSafe's own docs and legal pages. Each document tags
claims as opened, search-snippet, or unverified; competitor pricing and legal points are
mostly snippet-level. The platform agent verified the SDKs from their published packages.
Before acting on any legal, pricing or platform-policy statement here, open the primary
page listed in that document's Sources section. All Jev performance numbers are TypeSafe's
own or self-reported by builders, as the source report also warned.
