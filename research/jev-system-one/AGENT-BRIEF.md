# Research agent brief (shared by all per-project agents)

You are one of 13 parallel research agents. Each agent owns ONE project idea from
`research/jev-system-one/00-source-report.md` (read the whole file first: Parts 1, 2 and
6 describe the Jev model, its design rules, failure modes and prerequisites; Part 5 has
your project's one-pager). Today is 23 September 2026. Jev launched publicly on
15 September 2026, so your training data will not cover it: use WebSearch / WebFetch to
verify, and clearly label anything you could not verify as **unverified**. Never invent
URLs, prices, company names or statistics. If web access fails, say so at the top of your
document and proceed from reasoning alone, marking every external claim as unverified.

## Deliverable

Write ONE markdown file at the path you are given. Target 2,000–4,000 words. Use exactly
these top-level sections, in this order:

1. **Summary** — 5–8 bullets: what it is, who it is for, the one-line pitch, your revised
   score (Achievability / Impact / Demand / Jev fit, 1–5 each, with a sentence on any
   change from the source report), and a go / no-go / go-with-conditions recommendation.
2. **The idea, fleshed out** — the user's job-to-be-done; the end-to-end flow; the exact
   Jev questions (list every Choice / Score / Noul with its options or levels, the state
   you would send, and why it obeys the Part 2 design rules: literal reading, no
   arithmetic or date ordering in the model, filter before sending, explicit "other",
   adversarial state); what code decides vs what the model decides; what the user sees.
3. **Market research** — existing products and open-source projects doing this or
   adjacent (name, what it does, pricing if public, how it differs); evidence of demand
   (search interest, communities, complaints, launch traction, willingness to pay);
   the wedge / why now; target users and a realistic pricing or distribution model;
   what an incumbent could do to kill it. Cite sources with URLs you actually opened.
4. **Implementation plan** — architecture (components, data flow, where Jev sits,
   where the fallback LLM sits); tech stack recommendation with reasoning; data model;
   the confidence thresholds and how they will be tuned (eval set size, labelling
   approach, metrics); milestones as a phased plan (MVP in days, v1 in weeks, later),
   each with scope, exit criteria and a rough LoC / effort estimate; testing and
   observability (log model version, probabilities, confidence per decision);
   cost model at 3 usage levels using the report's pricing (mark as TypeSafe's own).
5. **Constraints & prerequisites (what we need to know or have before building)** —
   this is the most important section. A checklist table with columns:
   Item | Type (access / account / API key / legal-ToS / platform limit / data / hardware / skill / decision) |
   Why needed | How to get it / owner | Blocking? (yes/no) | Status (known / unverified / open question).
   Cover: Jev access and rate limits; every third-party API or platform (auth model,
   ToS restrictions on automation/scraping/bots, review or verification processes,
   quotas, pricing); privacy / data-handling (PII, transcripts, email content, minors,
   GDPR/Australian Privacy Act where relevant; the user appears to be based in
   Australia); safety-critical caveats; datasets needed for the eval set; decisions
   the owner must make before code is written (e.g. which sources, which platform first).
6. **Risks & open questions** — technical, market, and Jev-specific (context rot,
   adversarial state, literal reading, version pinning); each with a mitigation.
7. **Sources** — every URL you opened, with one line on what it contributed.

## Working rules

- Read `00-source-report.md` in full before searching.
- Do 8–20 targeted web searches / fetches. Prioritise: TypeSafe / Jev official docs
  (typesafe.ai and whatever the current docs domain is), competitor products, platform
  API docs and ToS pages, and community demand signals (HN, Reddit, Product Hunt, GitHub).
- Do not modify any other file. Do not run git commands. Do not create extra files.
- When finished, reply with a ≤150-word summary: recommendation, revised score, the
  three most important blocking constraints, and whether web access worked.
