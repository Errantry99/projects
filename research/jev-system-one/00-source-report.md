# Source brief: "Jev & the System One model class" (23 Sep 2026)

_Text extracted from the original PDF report prepared for James. Page headers removed; otherwise verbatim._

Jev & the System One model
class
Research consolidation and a shortlist of 13
projects worth building
Prepared for James — 23 September 2026
Sources: TypeSafe launch materials and docs, LangChain,
DataCamp, MindStudio, Requesty, Flavio Copes and Valyu/DEV
write-ups, plus launch-week GitHub projects. All performance
numbers are TypeSafe’s own or self-reported by builders; none
are independently reproduced yet.
Contents
 Part 1 — What Jev is and where it is strong
 Part 2 — Design rules and failure modes
 Part 3 — How the ideas were generated and scored
 Part 4 — Shortlist at a glance
 Part 5 — One page per project
 Part 6 — What I would build first

Part 1 — What Jev is
Jev is the first public model from TypeSafe AI (San
Francisco, out of stealth 15 Sep 2026, $40M seed led
by DCVC), built by Diogo Almeida, a co-creator of
RLHF and InstructGPT at OpenAI. TypeSafe calls it a
System One model, after Kahneman: it does not
generate text. You send a block of state (string, JSON
or list, text only, up to 64k tokens) plus a set of typed
questions; it evaluates all of them in parallel and
returns bounded answers with calibrated probabilities.
Three primitives
 Choice — one option from up to 255, each described
in words. Returns the pick, a probability per option,
and a confidence.
 Score — a position on 2–10 ordered levels; can land
between levels (e.g. 1.4).
 Noul — a yes/no as a probability from 0 to 1.
Numbers (TypeSafe’s own)
 Latency 70–500 ms end to end; most calls ~100 ms.
 Price $0.042 per million input tokens; output free.
Roughly $0.0004 per decision on their benchmark.
 Rate limits (jev-1.13): 250k tokens/s, 1,200 req/min,
moving without notice.
 Schema errors 0% by construction: it cannot return
an invalid value. It can return the wrong valid one.
 On TypeSafe’s 4-workflow eval: 67.8%, tied with
GPT-5.6 Terra and Claude Sonnet 5, below GPT-5.6
Sol (74.1%) and Opus 5 (73.1%) — at ~1/200th the
cost. Ground truth is consensus of GPT-6 Astra and
Claude Fable 5.1, so it measures agreement with

frontier models, not accuracy.
Training: RLCD
Reinforcement Learning for Calibrated Decisions
optimises the probability against outcomes rather than
human preference. The claim is that confidence is
meaningful in aggregate: higher confidence really does
mean higher accuracy, so thresholds can live in code
and be tuned per action.

Where it is strong
 Routing and triage — intent, department,
complexity, urgency.
 Moderation and guardrails — scoring or gating
LLM output and agent actions.
 Relevance filtering before an expensive context
window (RAG passage screening, citation checks).
 Tagging at volumes that were previously
uneconomic (1,018 papers for $0.08).
 Anything sub-second inside a request handler or
a control loop: browser agents (flight booked in 7.1 s
for $0.004), computer use at $0.0002/step, a drone’s
tactical layer at 2.5 Hz, a market-maker deciding
every 300 ms block.
Patterns that emerged in week one
 Speculative fan-out: questions run in parallel, so a
tenth question costs tokens but no time. Ask
everything, let code decide what mattered. TypeSafe
reports 12x cheaper, 10x faster batching 13
questions into one call.
 Confidence-gated routing: one threshold per
action, scaled to the cost of being wrong; a 0.5 floor
sends the genuinely unsure to a human.
 Composite scoring: break a fuzzy judgment into
atomic dimensions and weight them in code;
re-weighting becomes an A/B test, not a re-prompt.
 The cascade: Jev decides which requests deserve a
frontier model; many never touch a model at all. On a
million tickets, TypeSafe’s figures give ~$6.5k vs
~$30k.

 Retrieve, then judge: fetch precisely in code, send
only the fields the question needs.
Ecosystem after 8 days
Python and TS SDKs, one endpoint, Vercel AI
Gateway listing, a LangChain integration with
model-router middleware, a Claude Code skill, an
awesome-typesafe index, a self-hosted drop-in
(jeff/GliFormer) and an open logits-based
re-implementation (openjev). Access is still waitlisted.

Part 2 — Design rules and
failure modes
TypeSafe publishes a ‘jaggedness’ page for jev-1.13.
The ideas in this report are shaped around it.
 It reads literally. Negations, scoping words and
implied conditions are taken at face value. If you find
yourself explaining what you meant, that explanation
belongs in the instruction.
 Not a calculator. Counting, arithmetic and date
ordering are unreliable. Iterate in code; ask one Noul
per item.
 Dates are text. Extract with a Choice over
enumerated values plus ‘not stated’; compare in
code.
 Context rot. Accuracy falls as state fills with
irrelevant material. Filter first.
 State is not treated as hostile. User-controlled text
that argues for its own classification can move the
answer. Treat state as adversarial input.
 Text only. No images, audio or video; caption or
transcribe first.
 It does not generate. No prose, code or summaries,
and no written rationale for an auditor.
 Stated weak spots: System 2 reasoning,
specialised domains, open answer spaces.
Operational
 Pin the model version (jev-1.13.0) if you tune
thresholds; log version, probabilities and confidence
per decision.
 Add an explicit ‘other’ option to every Choice.

 Evaluate on your own traffic before trusting any
published number.
 Pricing may move; TypeSafe cannot show it is not
subsidised.
The meta-rule from the docs: don’t ask the model for
something code can compute exactly, and don’t hide
several judgments inside one question.

Part 3 — Method
Honest note: this run had no sub-agent orchestration
available, so the research pass and the ideation pass
were done by a single model rather than 10 Opus and
100 Sonnet agents. Ideation was a wide brainstorm
(~30 candidates across consumer, developer,
enterprise, games, robotics, science and your own
domains), then culled to 13.
Scoring (1–5 each)
 Achievability — can one competent builder ship an
MVP in days to a few weeks with public APIs?
 Impact — how much does it change the outcome for
whoever uses it?
 Consumer demand — breadth of people who would
want it (enterprise-only ideas score low here by
design).
 Jev fit — does the idea genuinely need fast, cheap,
calibrated judgment, or would an LLM do as well?
Estimates
 Lines of code are for a working MVP (app code +
glue, excluding tests and vendored SDKs), rounded
to the nearest hundred.
 Integrations count distinct external systems or APIs
you must wire up, TypeSafe SDK included.
 Both are gut estimates from the shape of comparable
launch-week repos; treat as ±50%.

Part 4 — Shortlist at a glance
Sorted by total score (out of 20). A = achievability, I = impact, D
= demand, F = Jev fit.
#
Project
A
I
D
F
Tot
LoC
Int
1
Inbox Reflex
4
4
5
5
18
1,500
4
2
Attention Firewall
4
4
5
5
18
1,800
3
3
Guardrail Sidecar
5
5
3
5
18
2,000
3
4
Opportunity Matcher
4
4
4
5
17
1,800
4
5
Community Moderator
5
3
4
5
17
900
2
6
NPC Director SDK
3
4
4
5
16
3,500
3
7
Home Intent Layer
4
3
4
5
16
1,000
3
8
Evidence Screener
4
4
3
5
16
1,400
3
9
Live Meeting Reflex
3
4
4
4
15
2,200
4
10
Digital Twin Alarm Triage
3
5
2
5
15
3,000
5
11
Tessera Answer Judge
5
3
3
4
15
700
2
12
Lease Abstraction Triage
3
5
2
4
14
2,800
4
13
Backcountry Conditions
Sherpa
3
3
3
4
13
2,500
5

1. Inbox Reflex
Sub-second email triage that only wakes an LLM when
a draft is needed
Achiev.
Impact
Demand
Jev fit
Total
4/5
4/5
5/5
5/5
18/20
What it is
Every incoming email is scored in one Jev call:
needs-reply, waiting-on-me, urgency, intent (invoice /
meeting / FYI / sales), and confidence. Code files,
labels and snoozes; a generative model is called only
for the small slice that needs a drafted reply.
Why Jev
Cascade pattern in its purest form. ~$0.0004 per email
vs cents per LLM call, and 100 ms latency means it can
run on every message as it lands rather than in
batches.
Estimate — ~1,500 lines of code, 4 integrations
 Gmail / Microsoft Graph API
 TypeSafe SDK
 LLM (drafts only)
 Slack or calendar for nudges
Main risk
Deliverability of labels vs user trust; user-controlled text
in state is adversarial (prompt-injection-style emails).

2. Attention Firewall
Browser extension that scores every feed post against
your own criteria
Achiev.
Impact
Demand
Jev fit
Total
4/5
4/5
5/5
5/5
18/20
What it is
A WebExtension reads each post/notification on X,
LinkedIn, Reddit, HN, YouTube and asks Jev:
informative? rage-bait? relevant to my stated goals?
Composite score with user-set weights collapses
low-value items in place. Same engine can gate
desktop notifications.
Why Jev
Composite-scoring pattern with weights in code, and
cheap enough to run on thousands of items a day.
Output is a number, so the UI is trivial.
Estimate — ~1,800 lines of code, 3 integrations
 WebExtension API (Chrome/Firefox)
 Per-site DOM adapters
 TypeSafe SDK
Main risk
Site DOM churn; Jev text-only so images/video need a
caption step; users may dislike an AI deciding what
they see.

3. Guardrail Sidecar
Drop-in judge for agent pipelines: score outputs and
tool calls before they act
Achiev.
Impact
Demand
Jev fit
Total
5/5
5/5
3/5
5/5
18/20
What it is
A LangGraph / LangChain middleware that, before
every tool call and after every model turn, asks Jev:
on-task? risk level of this action? PII present?
contradicts retrieved evidence? Per-action confidence
thresholds decide pass / confirm / block, with full
probability logging for audit.
Why Jev
Confidence-gated routing is exactly what RLCD is
trained for. Adds ~100 ms per step, negligible versus a
frontier-model turn, and can never emit malformed
output.
Estimate — ~2,000 lines of code, 3 integrations
 TypeSafe SDK
 LangGraph middleware hooks
 OTel / logging sink
Main risk
Enterprise buyer, not consumer; needs an eval harness
on your own traffic before thresholds are trusted.

4. Opportunity Matcher
Score every job, tender, grant or RFP on your
dimensions, with your weights
Achiev.
Impact
Demand
Jev fit
Total
4/5
4/5
4/5
5/5
17/20
What it is
Ingest listings from 2–3 sources, ask Jev 8–12
Score/Noul questions per listing (domain fit, seniority,
remote, AU-eligible, budget band, deadline realism),
and rank by a weighted composite you can edit. Daily
digest via email or Telegram.
Why Jev
Composite scoring + speculative fan-out: asking twelve
questions costs almost the same time as one.
Re-weighting is a code change, not a re-prompt.
Estimate — ~1,800 lines of code, 4 integrations
 2–3 listing sources (APIs / scrapers)
 TypeSafe SDK
 Email or Telegram digest
 SQLite store
Main risk
Source scraping fragility; date math must stay in code
(Jev is unreliable on date ordering).

5. Community Moderator
Real-time Discord / Minecraft-server moderation at
near-zero cost
Achiev.
Impact
Demand
Jev fit
Total
5/5
3/5
4/5
5/5
17/20
What it is
Every message is scored for harassment, spam,
off-topic, self-harm signals and age-inappropriateness
in one call, with a confidence floor that routes
ambiguous cases to a human mod queue instead of
auto-acting.
Why Jev
Classic moderation classifier, but with 255-option
Choice and calibrated confidence you can tune per
server. Cost makes 100% coverage affordable for
hobby servers.
Estimate — ~900 lines of code, 2 integrations
 Discord bot API
 TypeSafe SDK
Main risk
False positives erode trust; adversarial phrasing can
shift scores; needs a human-review loop.

6. NPC Director SDK
Godot / Unity plugin giving NPCs tactical judgment at
2–10 Hz from game state
Achiev.
Impact
Demand
Jev fit
Total
3/5
4/5
4/5
5/5
16/20
What it is
Serialise nearby game state to compact JSON, ask Jev
a Choice over manoeuvres, a Score for threat, and
Nouls for intent (fleeing? bluffing?). Engine code owns
pathing, physics and animation; Jev only picks what to
do next. Ships with a local fallback (openjev-style
logits) for offline play.
Why Jev
Launch-week demos (Mario, StarCraft, drone) prove
the shape. Output-free pricing makes wide action
spaces cheap; latency fits a tactical tick, not a frame
tick.
Estimate — ~3,500 lines of code, 3 integrations
 Godot GDExtension or Unity C# SDK
 TypeSafe SDK
 Local fallback model
Main risk
Network dependence in shipped games; state design is
the hard part (“every bit of reasoning must be rebuilt as
deterministic state”).

7. Home Intent Layer
Local-voice smart home that acts on confident intents
and confirms the rest
Achiev.
Impact
Demand
Jev fit
Total
4/5
3/5
4/5
5/5
16/20
What it is
Speech-to-text feeds Jev a Choice over Home
Assistant services/entities plus a confidence score.
High-confidence, low-stakes actions (lights) fire
instantly; high-stakes (unlock door, disarm alarm)
require a spoken confirmation below a threshold you
set.
Why Jev
Sub-second decision keeps voice interactions snappy
without a cloud LLM round-trip; per-action thresholds
map directly onto physical risk.
Estimate — ~1,000 lines of code, 3 integrations
 Home Assistant REST/WebSocket
 STT (Whisper / Deepgram)
 TypeSafe SDK
Main risk
Entity lists change; Choice options must be
regenerated from HA state each call; privacy of
transcripts.

8. Evidence Screener
Retrieve wide, judge cheap: literature and
due-diligence triage
Achiev.
Impact
Demand
Jev fit
Total
4/5
4/5
3/5
5/5
16/20
What it is
Pull 50–500 candidates (papers, filings, news, tenders)
via a search API, then screen each with 3–5
Nouls/Scores (relevance, evidence strength, primary
source, recency stated). Only survivors are
summarised by an LLM. Fits investment-thesis tracking
and market research.
Why Jev
The retrieve-then-judge pattern from TypeSafe’s own
cookbooks; 1,018 papers were classified for $0.08 in
launch week.
Estimate — ~1,400 lines of code, 3 integrations
 Search / retrieval API (Valyu, Exa, PubMed)
 TypeSafe SDK
 LLM summariser (optional)
Main risk
Garbage-in: Jev judges whatever state you hand it;
context rot if you pad state with full documents.

9. Live Meeting Reflex
Streaming transcript to action items, decisions and ‘you
were asked something’ alerts
Achiev.
Impact
Demand
Jev fit
Total
3/5
4/5
4/5
4/5
15/20
What it is
Chunk a live transcript every ~5 s and ask Jev:
decision made? action item assigned? question
directed at me? sentiment shift? Fire a discreet alert or
log the item. An LLM writes the end-of-meeting
summary from flagged segments only.
Why Jev
Latency finally low enough for in-meeting feedback;
per-chunk cost makes always-on practical.
Estimate — ~2,200 lines of code, 4 integrations
 STT streaming (Deepgram / Whisper)
 TypeSafe SDK
 LLM for summaries
 Slack / Notion output
Main risk
Meeting-platform capture is fiddly; speaker attribution
errors propagate into state.

10. Digital Twin Alarm Triage
Classify BMS / OT alarm floods into nuisance,
actionable and safety in real time
Achiev.
Impact
Demand
Jev fit
Total
3/5
5/5
2/5
5/5
15/20
What it is
Subscribe to alarm and sensor events, enrich with
asset context in code, and ask Jev: nuisance vs
actionable? likely root-cause class? safety-relevant?
Escalate through CMMS with confidence attached;
suppress chatter.
Why Jev
Alarm volumes are exactly the ‘judgment at scale’ case
where LLMs are too slow and costly; calibrated
confidence maps to escalation tiers.
Estimate — ~3,000 lines of code, 5 integrations
 MQTT / BACnet gateway
 Time-series DB
 TypeSafe SDK
 CMMS / ticketing
 Ops dashboard
Main risk
Safety systems must stay deterministic — Jev advisory
only; text-only so numeric trends need
pre-summarising in code.

11. Tessera Answer Judge
Add real-time answer-quality and misconception
tagging to your adaptive quiz app
Achiev.
Impact
Demand
Jev fit
Total
5/5
3/5
3/5
4/5
15/20
What it is
For free-text or explain-your-reasoning answers, Jev
scores correctness band, identifies misconception
class (Choice over a curated list per topic), and rates
confidence — all within the UI’s response budget.
Drives the adaptive difficulty loop without an LLM per
answer.
Why Jev
Cheap per-answer judgment makes the adaptive loop
viable at scale; Claude tutor is reserved for
explanations.
Estimate — ~700 lines of code, 2 integrations
 Existing quiz app
 TypeSafe SDK
Main risk
Misconception taxonomies need curation per topic; Jev
is not a grader for arithmetic-heavy answers.

12. Lease Abstraction Triage
Commercial-lease clause classification with
confidence-gated human review
Achiev.
Impact
Demand
Jev fit
Total
3/5
5/5
2/5
4/5
14/20
What it is
OCR/parse lease PDFs, split into clauses in code, and
ask Jev per clause: clause type (rent review, break,
assignment, make-good, outgoings),
unusual-for-market score, and needs-lawyer Noul. A
generative model extracts candidate values only for
clauses Jev flags.
Why Jev
Retrieve-then-judge over long documents; free output
and 255-option Choice fit large clause taxonomies.
Confidence tells reviewers where to look.
Estimate — ~2,800 lines of code, 4 integrations
 Document store / OCR
 TypeSafe SDK
 LLM extractor
 Review UI
Main risk
Specialised legal domain is a stated Jev weakness —
validate accuracy first; enterprise sales cycle.

13. Backcountry Conditions
Sherpa
Per-segment route risk from trip reports, alerts and
forecasts
Achiev.
Impact
Demand
Jev fit
Total
3/5
3/5
3/5
4/5
13/20
What it is
Scrape recent trip reports and land-agency alerts for a
route, ask Jev per report: snow on passes? unfordable
crossings? closures? wildlife activity? recency stated?
Aggregate in code onto route segments with a map
view.
Why Jev
Many small judgments over noisy free text is the sweet
spot; cost lets you re-run daily before a trip.
Estimate — ~2,500 lines of code, 5 integrations
 Trip-report scrapers
 Weather API
 Land-agency alert feeds
 TypeSafe SDK
 Map UI
Main risk
Data sparsity for remote routes; date handling must
stay in code; safety-critical advice needs strong
disclaimers.

Part 6 — What I would build
first
Guardrail Sidecar is the highest-leverage for you: it
slots into the LangGraph pipelines you already run, it is
the pattern TypeSafe and LangChain are both pushing,
and it doubles as the eval harness you need before
trusting Jev anywhere else. Two thousand lines, three
integrations.
Inbox Reflex is the fastest route to a daily-use product
with broad demand, and it exercises the cascade end
to end. Build it second, reuse the sidecar’s logging.
Tessera Answer Judge is the cheapest win — under a
thousand lines on top of the quiz app you have already
specced.
Before any of them
 Get off the waitlist (typesafe.ai) or use the Vercel AI
Gateway listing; keep a self-hosted fallback (jeff /
openjev) for local dev.
 Spend the first hour in the Playground with your own
state; plot confidence against accuracy on ~200
labelled examples before setting thresholds.
 Pin jev-1.13.0 and log model version, probabilities
and confidence on every call.
 Treat all user-supplied state as adversarial.
Ideas that did not make the cut: support-ticket cascade (too well
trodden), trading bots (regulatory and risk), receipt
categorisation (saturated), SMS phishing filter (platform-locked),
CI code reviewer (jev-review already exists), dating/roommate
matching (weak Jev fit).

