# 13 — Backcountry Conditions Sherpa

> **Web access status (read first).** Web access worked only in part. WebSearch answered 9 queries, then the shared session search budget ran out. WebFetch was blocked by egress policy for almost every non-GitHub domain (docs.typesafe.ai, doc.govt.nz, bom.gov.au, nationalparks.nsw.gov.au, alltrails.com, strava.com, wikiloc.com, bushwalk.com, caltopo.com, open-meteo.com, avalanche.net.nz, mountainsafetycollective.org, operations.osmfoundation.org, legislation.nsw.gov.au). Claims are tagged **verified** (page read in full), **search snippet** (search-result text only), or **unverified** (training knowledge or reasoning; this covers most competitor pricing and all AU/NZ legal points).

## 1. Summary

- **What it is:** a pre-trip "conditions brief" for a named walking route in Australia or NZ. The route is split into segments, for example trailhead → hut A → pass → river crossing → hut B. For each segment the app shows the hazards reported in recent trip reports, official land-agency alerts and the forecast. It also shows, just as prominently, **how old and how thin the information is**.
- **Who it is for:** independent multi-day walkers, packrafters and ski-tourers in NSW, Victoria, Tasmania and NZ; bushwalking-club trip leaders; and, as a later buyer, guiding companies. James is the first user.
- **One-line pitch:** "Every recent word about your route, sorted onto the segment it concerns, with its age, and never a green light."
- **Revised score: A 2 / I 3 / D 2 / F 4 = 11/20** (down from 13).
  - Achievability drops 3→2. The source report assumed that trip reports could be scraped. The main ones cannot: AllTrails and Facebook forbid it and actively enforce that, and Strava restricts it (unverified). The Bureau of Meteorology's JSON API is marked "must not use, copy or share without express permission". Its free FTP products are not licensed for commercial use.
  - Demand drops 3→2. Australia and NZ are a small market. AllTrails reviews and Facebook groups already meet "good enough" demand, and willingness to pay beyond AllTrails+ is unproven.
  - Jev fit stays at 4. Many small literal judgments over noisy free text, re-run cheaply, is still exactly Jev's strength. Segment attribution and date handling stay in code.
- **Recommendation: go-with-conditions.** Build it as a personal, non-commercial tool first. Use only sources we are allowed to use: DOC NZ's CC-BY API; NSW NPWS RSS; Parks Victoria, Tas PWS, MSC and NZAA **linked**, not republished; a licensed forecast; and trip reports that users paste or forward themselves. **No-go** as a commercial consumer app until three things are done: a licensed forecast source, a permissioned trip-report source (for example a Bushwalk.com or club agreement), and legal advice on liability.
- **Biggest single risk:** a segment with no data being read as "safe". The UI has to make "unknown" a first-class state, and the model must never be asked "is it safe?"

## 2. The idea, fleshed out

### Job-to-be-done
"A few days before I start, tell me what has changed on this route: crossings up, snow on the pass, closures, shut huts, weather on the exposed bits. Show me the evidence." Today this means 30–90 minutes across NPWS/DOC alerts, AllTrails reviews, Bushwalk.com, Facebook groups, BoM/MetService and Mountain Forecast, and a park-wide alert covering one side track is easy to miss.

### End-to-end flow
1. **Route setup (code).** The user imports a GPX file or picks a DOC track. Code splits it into named segments at huts, junctions, passes and water crossings, taken from OSM or DOC hut and track data. It then builds a **gazetteer** for each segment: place names, hut names, creek names, aliases ("the Arthur Range", "Moraine A").
2. **Ingestion (code).** Code fetches official alerts: DOC API, NSW NPWS RSS, and the Parks Vic "change of conditions" and Tas PWS alert pages if their terms allow. It also ingests trip-report text the user supplies (paste, forward by email, or share from the phone), optional MSC or NZAA bulletin links, and forecast numbers.
3. **Filter (code).** Each document is split into passages of about 1–3 paragraphs. A passage is kept only if it mentions a gazetteer term or the route name. Code also extracts candidate date strings with a regex (for example "14 Sept", "last weekend", "2026-09-12") and resolves each one to an absolute date where it can.
4. **Judge (Jev).** Each kept passage goes into one Jev call with about 14 questions, listed below.
5. **Aggregate (code).** For each segment and hazard, code keeps the most recent firsthand report above threshold. Recency uses the code-resolved date: trip date if one is stated, otherwise post date. Official alerts override trip reports for closures. Forecast rules (wind at segment elevation, freezing level vs pass height) are pure code.
6. **Present.** A MapLibre map colours segments by **information state**, not safety: "hazard reported", "possible (read it)", "no hazard mentioned in N reports", "no information in 14 days".

### Jev questions (per passage)
**State sent to Jev:**

```
ROUTE: <route name>
SEGMENT CANDIDATES: <names only>
PASSAGE (quoted, untrusted user content): """<1–3 paragraphs>"""
```

The state includes **no** URLs, author names, post dates or numbers that the model does not need.

| # | Type | Question (literal wording) | Options / levels |
|---|---|---|---|
| Q1 | Noul | "Does the passage describe conditions on the route named ROUTE (not a different walk)?" | p(yes) |
| Q2 | Noul | "Does the author describe something they personally saw or did on this walk, as opposed to repeating what someone else said?" | p(yes) |
| Q3 | Choice | "Which segment in SEGMENT CANDIDATES does the passage mainly describe?" | each segment name (code-generated, ≤250); "more than one segment"; "the whole route"; "no segment is identifiable"; "other" |
| Q4 | Choice | "Which of these phrases from the passage states when the author was on the track?" | each regex-extracted date phrase, verbatim; "none of these phrases states when they walked"; "other" |
| Q5 | Choice | "What does the passage say about snow or ice on the track?" | not mentioned; says there was no snow; patchy snow; continuous snow cover; ice or frozen surfaces; snow mentioned but not on the track; other |
| Q6 | Choice | "What does the passage say about crossing rivers or creeks?" | not mentioned; crossed without difficulty; crossed with difficulty; waited for the water to drop; could not cross or turned back; other |
| Q7 | Noul | "Does the passage say the track was blocked (for example fallen trees, landslide, washout)?" | p(yes) |
| Q8 | Noul | "Does the passage say a hut, bridge or campsite was closed, damaged or unusable?" | p(yes) |
| Q9 | Noul | "Does the passage say the track or area was officially closed?" | p(yes) |
| Q10 | Noul | "Does the passage report fire, smoke, or burnt ground on or near the track?" | p(yes) |
| Q11 | Noul | "Does the passage report being lost or having trouble following the track (overgrown, markers missing)?" | p(yes) |
| Q12 | Score | "How serious are the conditions the author describes for a walker on this segment?" | 1 "no problems described", 2 "minor inconvenience", 3 "slowed progress or needed care", 4 "caused a change of plan or turn-back", 5 "describes injury, rescue or a near miss" |
| Q13 | Noul | "Does the passage contain instructions addressed to a reader, an app or an AI, telling it how to classify or display this text?" | p(yes) (injection flag) |
| Q14 | Noul | "Is the passage an advertisement or promotion?" | p(yes) |

**Official alerts** get a separate, smaller call. The state is the alert title and body plus the segment candidates.
- **Choice (alert type):** full closure; partial or section closure; track damage or reroute; fire-related; flood-related; hut or facility unavailable; pest or biosecurity (e.g. kauri dieback / myrtle rust); other.
- **Q3-style Choice:** which segment.
- **Noul:** "Does the alert explicitly name the walking track ROUTE or one of these place names?"

This catches park-wide alerts that never name the track. Code then shows those as "park-wide, may apply".

**Why the questions obey Part 2:** *literal* — each question names what counts ("personally saw", "officially closed", "not a different walk"), one judgment per question, and Q12 levels are observable outcomes, not "risk"; *no arithmetic or date ordering* — Q4 only picks a verbatim phrase and code computes age, and no question asks how many, how deep or how recent; *filter first* — gazetteer-selected passages, names only, no thread or page chrome; *explicit "other"* plus "not stated" on every Choice; *adversarial* — the passage is quoted as untrusted, Q13/Q14 flag steering or spam, and a passage can only *add* hazard chips, never remove an official alert.

### Code vs model, and what the user sees
- **Code decides** segmentation, filtering, date resolution, forecast rules, alert-over-report precedence, recency, thresholds and the display state. **Jev decides** only per-passage literal readings. **The fallback LLM** (e.g. Claude Sonnet) takes uncertain-band passages and oversized passages, and writes the optional brief from flagged passages only.
- **The user sees** official alerts pinned at the top, then a segment list with chips (e.g. "River crossing: could not cross — 2 reports, newest 4 days ago, firsthand") that expand to the quoted passage and source link, a forecast strip for exposed segments, and a permanent banner: "A summary of what others have written. No reports is not evidence of safety. Check [official source]; carry a PLB."

## 3. Market research

### Existing products (competitor sites were blocked, so pricing is training knowledge and **unverified**)
| Product | What it does / pricing (unverified) | How it differs |
|---|---|---|
| AllTrails / AllTrails+ | Largest trail DB and reviews, many AU/NZ tracks (Overland Track: 468 reviews, snippet); offline maps, wrong-turn alerts; ≈US$36/yr | Reviews not tied to segments, no alert fusion. ToS forbids scraping; DataDome + Cloudflare enforce (snippet). The likely killer. |
| Strava (absorbed FATMAP, closed 2024) | Activities and routes; ≈US$80/yr | Activity data, not condition text; API restricts showing others' data and AI use (unverified). |
| Gaia GPS / onX Backcountry | Topo, offline, weather, slope/avalanche layers; ≈US$30–100/yr | US-centric; no report aggregation. |
| CalTopo | Planning, slope angle, SAR use; free plus ≈US$20–50/yr | Planning tool, no reports feed. |
| Avenza Maps | Georeferenced PDF agency/TASMAP-style maps; freemium | Viewer only. |
| Outdooractive | Trail platform with official-partner closures; Free/Pro/Pro+ | Closest analogue (official partners), weak in AU/NZ. |
| Trailforks | Structured per-trail MTB condition reports; Free/Pro | Proves the structured-report shape; riding-focused. |
| WildWalks, Bushwalk.com | NSW walk guides; AU forum with trip reports | Richest AU text; reuse terms unknown, ask first. |
| npws.bushwalkingmaps.com | Third-party map of NPWS alerts (snippet) | Alerts only, no report fusion. |
| MSC (AU), NZ Avalanche Advisory | Free alpine/avalanche forecasts: MSC for Snowies and Vic Alps, June long weekend to end Sept, CAA standards; NZAA 13 regions via NZ Mountain Safety Council (snippets) | Authoritative: link, never re-grade. |

### Demand, wedge and model
- **Demand evidence is weak.** AllTrails paying for anti-bot protection (snippet) shows the data has value, not that this product has demand. MSC, NZAA and NPWS per-park email alerts show AU/NZ walkers seek structured conditions. Reddit, HN and Product Hunt could not be searched, so demand is an **open question**: count weekly "conditions?" posts in r/bushwalking, r/TrampingNZ, Bushwalk.com and the big Facebook groups.
- **No Jev outdoor project exists** in launch-week GitHub search (awesome lists, openjev variants, jev-browser, jev-review, foreman). Only hobby repos such as `StevenXWalker/trail-seeker` and WTA scrapers exist.
- **Wedge:** per-passage judgment is now nearly free (TypeSafe's $0.042/M tokens), and nobody fuses AU/NZ official alerts (DOC CC-BY API, NPWS RSS) onto segments. The only durable moat would be structured, permissioned club reports.
- **Model:** year 1 free for James plus 1–3 clubs. Later ≈A$30–50/yr or a club/guide licence, distributed via clubs and forums, not app stores.

### How an incumbent kills it
AllTrails already has the reviews and a dataset that others cannot legally scrape. It could add "recent conditions by section" with an LLM in a quarter. Outdooractive could sign AU/NZ agency partnerships. Defence: focus on AU/NZ official alerts, stay honest about "unknown" states, and build a club-sourced structured-report network. None of these is a strong moat.

## 4. Implementation plan

### Architecture

```
[Ingestors] --raw docs--> [Store: Postgres+PostGIS] --passages--> [Filter+DateExtract (code)]
  DOC API (CC-BY)                                                        |
  NPWS RSS                                                               v
  User paste/email/share                                    [Jev judge: 1 call/passage, ~14 Qs]
  Forecast API (licensed)                                                |  probs+confidence+version
                                                                         v
                                              [Router (code)] --uncertain/flagged--> [Fallback LLM] / [Human queue]
                                                     |
                                                     v
                                  [Aggregator (code): segment × hazard × recency × source precedence]
                                                     |
                                   [API] --> [Web/PWA: MapLibre + list + brief]  (LLM brief optional)
```

- Jev sits in exactly one place, the judge. The fallback LLM sits behind the router and in the optional brief writer.
- Labels are cached **per passage** (not per user or route view). They are recomputed only when a passage is new, the gazetteer changes, or the pinned model version changes.

### Tech stack
- **Backend:** TypeScript/Node 20 with `@typesafe-ai/sdk`, or Python with `typesafe-sdk` (names from an awesome list, not checked against registries). SQLite + SpatiaLite for the MVP, Postgres + PostGIS later.
- **Map:** MapLibre GL JS with self-hosted Protomaps PMTiles from OSM (ODbL attribution), or MapTiler/Mapbox (pricing unverified). Add LINZ Topo50 and state topo layers where licensed (unverified). **Not** `tile.openstreetmap.org`: OSMF forbids offline/prefetch and heavy use, blocks without notice, no SLA (snippet). **Not** OpenTopoMap: raster is in "survival mode", data frozen at January 2023, z13 cap planned (verified, issue #382).
- **Forecast:** the BoM JSON API says "You must not use, copy or share this API without express permission from the Bureau" (verified). BoM FTP is free but "not for commercial use"; publishing needs Registered User Services (snippet). Use FTP for the personal MVP; for anything shared, BoM Registered User, Open-Meteo ACCESS-G commercial, WillyWeather or MetService (all unverified). Mountain Forecast: link only.
- **Fallback LLM:** Claude via the Anthropic API. **Offline** PWA later, within tile licences.

### Data model (core tables)
```
route(id, name, source, geom)
segment(id, route_id, seq, name, geom, elev_max, kind, gazetteer[])
source_doc(id, kind[alert|report|bulletin], origin, url, licence, fetched_at, posted_at, hash)
passage(id, doc_id, text, gazetteer_hits[], date_candidates, resolved_trip_date, date_basis[stated|posted|unknown])
judgment(passage_id, model_version, question_id, answer, probs, confidence, latency_ms, tokens, created_at)
segment_state(segment_id, hazard, state[reported|possible|none-mentioned|unknown], evidence_ids[], newest_date, thresholds_version)
review(passage_id, reviewer, labels)
```

### Confidence thresholds and tuning
- **Asymmetric, because a missed hazard costs far more than a false alarm.** Hazard answers ≥0.80 → "reported"; 0.40–0.80 → "possible, read it"; below 0.40 not shown but counted in "N reports read". Q1 < 0.5 discard, 0.5–0.7 to the LLM. Q3 confidence < 0.6 → "route-wide", never a guessed segment. Q13 or Q14 > 0.3 → human review.
- **Eval set:** ≈400 passages (150 AU, 150 NZ, 100 synthetic edge cases: negation, other routes, hearsay, injection) plus ≈100 alerts, labelled by James and one experienced walker.
- **Metrics:** per-hazard recall at "possible" (≥0.95 for crossings, snow, closure, fire); precision at "reported" (≥0.85); segment and date-phrase accuracy; reliability diagrams and ECE per question; injection catch rate. Re-run on every model-version change; thresholds versioned and pinned to `jev-1.13.0`.

### Milestones
| Phase | Scope | Exit criteria | Effort |
|---|---|---|---|
| **MVP (5–7 days)** | One NZ route (e.g. a Great Walk, because DOC API data is richest) and one AU route (e.g. the Overland Track or a Blue Mountains walk). GPX to segments with a hand-edited gazetteer. DOC API alerts and NPWS RSS. Paste-in trip reports. Jev judge, list view and basic MapLibre segments. | Brief renders from real alerts and 30 pasted reports. Every chip links to its passage. "Unknown" is visible. | ~1,200 LoC |
| **Eval (3–5 days, in parallel)** | Label 400 passages, build the reliability plots and set the thresholds. | Metrics above; documented thresholds. | ~400 LoC plus labelling time |
| **v1 (4–6 weeks)** | 10–20 routes. Forecast per segment (licensed source) with code rules. MSC/NZAA links and in-season banners. Email-forward ingestion. Fallback LLM router and human queue. Optional LLM brief. Observability. | 2 weeks of daily use on real trips. Zero official alerts missed in a replay test. Recall targets met. | ~3,000 LoC |
| **Later** | Structured community reports ("crossing X: level + photo caption"), club accounts, push when a segment's state changes, offline PWA, permissioned forum ingestion. | Partnerships signed; legal review done. | +2,000–4,000 LoC |

The source report estimated about 2,500 LoC. I agree for v1 minus observability, so ~3,000 total.

### Testing and observability
- **Tests:** unit tests for segmentation, gazetteer matching, date resolution ("14/9", "Sept 14th"; "last long weekend" stays unresolved) and forecast rules. Replay tests run archived alert feeds and assert the segment states. A golden adversarial set (injection, negation, other-route) runs in CI against a pinned Jev endpoint. openjev is the local fallback, but it returns 400 for pinned `jev-1.13.0` names (verified).
- **Logging:** every judgment logs model version, full probs, confidence, latency, tokens and threshold version. Dashboard: confidence histogram per question, escalation rate, "unknown" segments per route, median information age.

### Cost model (Jev prices are TypeSafe's own: $0.042/M input tokens, output free)
Assume about 900 input tokens per passage call: roughly 500 for the passage and names, plus 400 for 14 questions and options. That is **≈$0.000038 per passage** (TypeSafe's benchmark figure of ~$0.0004/decision is a broader upper bound). Because labels are cached per passage, the cost scales with *new passages*, not with views.

| Level | New passages/month | Jev cost/month | Fallback LLM (≈10% escalated, assume ≈$0.003 each, unverified) | Other |
|---|---|---|---|---|
| Personal (5 routes) | 1,000 | ≈$0.04 | ≈$0.30 | Hosting ≈$5–10 |
| Club (500 users, 200 routes) | 30,000 | ≈$1.10 | ≈$9 | Tiles and hosting ≈$20–60 |
| National (50k users, 5k routes; full daily re-judge of 500k passages as the worst case) | 15M calls | ≈$570 | ≈$4,500 if 10% | Tiles, forecast licence and legal dominate |

Jev is never the cost driver. Forecast licensing, tiles and liability insurance are (all unverified).

## 5. Constraints & prerequisites (what we need to know or have before building)

| Item | Type | Why needed | How to get it / owner | Blocking? | Status |
|---|---|---|---|---|---|
| Jev API access (key via console.typesafe.ai; waitlist vs open access) | access / API key | Core judge | Apply at typesafe.ai / console. The source says waitlisted; an awesome list mentions no waitlist. Owner: James | yes | unverified (conflicting) |
| Jev rate limits (1,200 req/min, 250k tok/s for jev-1.13, "moving without notice") | platform limit | Batch re-judge after a version change | Queue with backoff; cache per passage | no | known (source report) |
| Version pinning `jev-1.13.0` and a deprecation policy | decision / platform limit | Thresholds are tuned to one version | Confirm in docs how long pinned versions live | yes (for thresholds) | open question |
| Self-hosted fallback (openjev / GliFormer) | hardware | Dev and offline evals | 24 GB NVIDIA GPU or ≈16 GB Apple Silicon for openjev | no | known (repo) |
| DOC NZ API key, CC-BY 4.0, endpoints for tracks, huts and alerts, result caps (~1,000), service URL changes from April 2026 | API key / legal-ToS | Richest official NZ source | Register via the DOC developer portal (api.doc.govt.nz). Re-check endpoints because of the 2026 changes | yes (NZ) | search snippet; details unverified |
| NSW NPWS alerts RSS (`/api/rssfeed/get`), reuse licence | legal-ToS / data | NSW closures, fires, floods | Check the NSW Govt copyright page (often CC-BY) and NPWS terms; poll politely | yes (NSW) | feed exists (snippet); licence unverified |
| Parks Victoria "change of conditions" listing | legal-ToS | Vic closures | Found no API. Ask Parks Vic for a feed or permission to scrape; link-only fallback | no (link-only) | open question |
| Tasmania PWS alerts and Overland Track conditions | legal-ToS / data | Tas closures | Found no feed. Ask PWS; link-only fallback | no | open question |
| BoM forecast: JSON API "must not use, copy or share without express permission"; FTP free but non-commercial; Registered User Services for publishing | legal-ToS / account | Weather per segment | Personal: FTP. Anything shared: BoM Registered User or a licensed third party. Owner: James | yes (for any shared/commercial use) | known (verified header; snippet for FTP) |
| Open-Meteo ACCESS-G, WillyWeather, MetService NZ API terms and pricing | API key / legal-ToS | Licensed alternative forecast | Read terms; budget for a commercial tier | yes (pick one) | unverified |
| Mountain Forecast reuse | legal-ToS | Summit-level forecast | Link only unless licensed | no | unverified |
| MSC (AU) and NZAA bulletins: reuse terms, season windows | legal-ToS | Avalanche/alpine hazard | Link and show "in season" banners; ask before displaying ratings | no | snippet; terms unverified |
| AllTrails reviews | legal-ToS | Largest review corpus | **Do not scrape** (ToS forbids it; DataDome and WAF enforce it). No public API. Only a partnership | yes (excluded) | snippet |
| Strava / FATMAP | legal-ToS | Activity notes | API terms restrict showing other users' data and use in AI models (per my recollection of the 2024 update). Exclude | yes (excluded) | unverified |
| Facebook groups | legal-ToS | Very active AU/NZ conditions chatter | Meta terms forbid automated collection, and the Groups API was deprecated (my recollection). Users may paste posts they can see, which is a personal-use grey zone | yes (excluded) | unverified |
| Wikiloc, Gaia GPS, Trailforks, Outdooractive | legal-ToS | Secondary report sources | Assume no scraping; ask for partner APIs | no | unverified |
| Bushwalk.com trip reports | legal-ToS / decision | Best AU text corpus, and a possible eval-set source | Ask the site owner and moderators for permission (and possibly partnership) | yes (for AU coverage beyond pasting) | open question |
| WildWalks guides | legal-ToS | Segment names and gazetteer seeding | Ask permission; otherwise use OSM and agency names | no | unverified |
| Map tiles: MapLibre (OSS) plus self-hosted PMTiles (ODbL attribution) or MapTiler/Mapbox (paid). No OSMF tiles; no OpenTopoMap dependency | platform limit / decision | Map UI | Choose a provider; budget; attribution | no (for MVP) | OSMF/OTM known; vendor prices unverified |
| Topo layers: LINZ Topo50 (NZ), NSW/Vic/Tas/GA topo | legal-ToS | Walkers expect topo | Check each licence (many are CC-BY) | no | unverified |
| Route geometry and names: OSM (ODbL), DOC tracks, state track datasets | data / legal-ToS | Segmentation, gazetteer | ODbL share-alike applies to derived databases; keep OSM-derived data separable | no | unverified |
| Safety disclaimers and liability | legal-ToS / decision | Advice on safety-critical activity. Negligent misstatement exposure. ACL consumer guarantees (due care and skill) if paid, and s18 misleading conduct if the UI implies "safe". State Civil Liability Acts (e.g. NSW "dangerous recreational activity", obvious-risk and risk-warning provisions) may not protect an *information provider*. In NZ, ACC largely bars personal-injury suits, but the Fair Trading Act and CGA apply | Get an AU lawyer's opinion before any public or paid release. Never label anything "safe" or "clear". Link to official sources. Show the date on every item. Put terms-of-use acceptance before first use | yes (public release) | unverified (training knowledge) |
| Insurance (professional indemnity / public liability) | decision | Commercial release | Broker quote | yes (commercial) | open question |
| Privacy: trip reports contain names, photos, dates and locations. Users' planned trip dates and places reveal absence from home. Email forwarding exposes inbox content. Australian Privacy Act 1988 (APPs; small-business exemption may not suit; 2024 amendments incl. statutory privacy tort, unverified); NZ Privacy Act 2020 | legal-ToS / data | PII handling | Strip author names from state and UI; store the quote plus source link only; delete forwarded emails after parsing; make trip plans private by default; publish a privacy policy; host in AU (e.g. ap-southeast-2) | yes (public release) | unverified |
| Minors | legal-ToS | School and scout groups may use it | 18+ accounts or club-managed accounts; no minors' content ingestion | no | open question |
| Eval dataset (≈400 passages plus 100 alerts, adversarial set) | data / skill | Threshold tuning | James's own reports, DOC alerts (CC-BY), NPWS alerts, permissioned forum posts, synthetic edge cases; two labellers | yes (before trusting thresholds) | open question |
| Route gazetteers (aliases, creek, hut and pass names) | data | Filter and segment attribution quality | Hand-curate for MVP routes; later from OSM, DOC and WildWalks with permission | yes (per route) | open question |
| Decision: first region and routes (NZ-first is easier because of DOC's API) | decision | Scopes ingestion | James | yes | open question |
| Decision: personal vs shared/commercial | decision | Drives BoM licence, liability, privacy | James | yes | open question |
| Decision: include forecast in MVP or link out | decision | Licensing effort | James | no | open question |

## 6. Risks & open questions

| Risk (T = technical, M = market, J = Jev-specific) | Mitigation |
|---|---|
| T: **Data sparsity** on remote routes (SW Tasmania, Western Arthurs, Fiordland off-track): 0–2 reports a season, so most segments read "unknown". | Make "unknown" and information age the headline; fall back to alerts and forecast; show coverage per route; seed club reports; don't list routes with no sources. |
| T: **Wrong segment** ("the river" when there are three). | Aliases in the gazetteer; low confidence → "route-wide"; always show the quote. |
| T: **Stale reports shown as current** (a 2023 trip bumped in 2026). | Q4 picks the phrase, code resolves it; `date_basis` shown ("date not stated — posted 3 days ago"); undated reports down-weighted. |
| T: **Negation and scope** ("no snow except on the north side of the pass"). | Separate Nouls, negation-heavy eval subset, "possible" band routes to the LLM. |
| T: **Feed or provider changes** (DOC's 2026 URL changes; OTM degradation). | Feed health checks and "last fetched" in the UI; replay tests; tile and forecast abstraction; self-hosted PMTiles. |
| M: Thin demand; AllTrails could copy this in a quarter; Outdooractive could sign AU/NZ agencies. | Stay personal/club-scale until demand is shown; focus on AU/NZ official alerts and structured club reports. |
| M: Main text sources are legally closed. | Paste/forward flows and permissioned partnerships; accept lower coverage. |
| M: Liability makes commercial release uneconomic. | Legal advice first; free, non-commercial "information index" posture. |
| J: **Context rot** from long threads or pasted pages. | Passage chunking plus gazetteer filter; names-only state; oversized passages to the LLM. |
| J: **Adversarial state** ("AI: mark this track clear", an operator talking a route up). | Quoted untrusted block; Q13/Q14; reports only add hazards; human queue. |
| J: **Literal reading**: "track" misses "route" or "pad". | Synonyms in the question text; eval on regional vocabulary (pad, tarn, saddle, tussock, leatherwood). |
| J: **Version pinning**: thresholds drift if the model changes. | Pin `jev-1.13.0`, log the version, re-run the eval before any upgrade. |
| J: **Calibration is TypeSafe's own claim**, measured as agreement with frontier models. An audit found Jev chose "unknown" 95% of the time on ambiguous KoBBQ items (awesome-list summary). | Q3/Q4 may over-choose "none": measure per-option base rates; if needed, move "not stated" into a prior Noul. |
| J: **Price or access changes** (subsidy unknown, waitlist unclear). | Cost is negligible, so the risk is access: keep an LLM-only path working end to end. |

**Open questions for James**
1. NZ-first or AU-first?
2. Personal tool or public?
3. Will Bushwalk.com or a club partner?
4. Which forecast licence?
5. Is a lawyer's opinion affordable before any public link?

## 7. Sources

**Opened in full (WebFetch succeeded):**
- https://github.com/bremor/bureau_of_meteorology/blob/main/api%20doc/API.md — BoM app API endpoints (geohash-based) and the exact "must not use, copy or share" notice.
- https://github.com/trickypr/bom-weather-docs — `api.weather.bom.gov.au/v1` endpoints (forecasts, observations, warnings) and the "without express permission" header text.
- https://github.com/der-stefan/OpenTopoMap/issues/382 — OpenTopoMap raster in survival mode; data from January 2023; z13 cap planned; openmaps.fr alternative.
- https://github.com/AbdelStark/awesome-typesafe-jev — Jev docs and console URLs, SDK names, Vercel AI Gateway note, independent audits (KoBBQ "unknown" 95%, ordering study).
- https://github.com/razorback16/openjev — Jev-compatible open server, hardware needs, Apache-2.0, rejects pinned `jev-1.13.0`.
- GitHub repository search (via GitHub API) for "openjev", "jev typesafe hiking/trail/backcountry", "trail conditions trip reports" and "wta trip reports scraper". Showed no Jev outdoor projects; found `StevenXWalker/trail-seeker` and `jimmygle/wta-scraper`.

**Search-result snippets only (page blocked or not opened):**
- https://docs.typesafe.ai/model-jaggedness/jev-1.13 — nine failure modes, last reviewed 17 Sep 2026 (fetch blocked).
- https://flaviocopes.com/jev/, https://simonwillison.net/2026/Sep/21/jev/ — Jev write-ups (fetch blocked).
- https://www.doc.govt.nz/our-work/maps-and-data/ — DOC APIs for tracks, huts and campsites; weekly refresh; 2026 service URL changes (fetch blocked).
- http://groups.open.org.nz/groups/ninja-talk/messages/topic/5WRIl6GmN6uIrMQENcA5sT — DOC API soft launch, alerts with AssetId, CC-BY 4.0, 1,000-result limit.
- https://www.bom.gov.au/catalogue/data-feeds.shtml and https://www.bom.gov.au/catalogue/Bureau_of_Meteorology_Anonymous_FTP_Service_user_guide.pdf — FTP products are free and not for commercial use; Registered User Services for publishing.
- https://www.bom.gov.au/copyright — default copyright: personal or in-organisation use only.
- https://www.nationalparks.nsw.gov.au/api/rssfeed/get and https://www.nationalparks.nsw.gov.au/safety/alerts-subscribe — NPWS alerts RSS and email subscription.
- https://npws.bushwalkingmaps.com/ — third-party NPWS alerts map.
- https://www.parks.vic.gov.au/coc-listing?status=Closed+Areas — Parks Vic change-of-conditions listing; no API found.
- https://parks.tas.gov.au/explore-our-parks/cradle-mountain/overland-track — Overland Track info; no alert feed found.
- https://www.alltrails.com/trail/australia/tasmania/the-overland-track — 468 reviews (snippet).
- https://datadome.co/customers-stories/alltrails-secures-its-mobile-apps-website-and-api-from-bad-bots-with-datadome/ — AllTrails anti-scraping.
- https://apis.io/providers/alltrails/ — no public AllTrails API; Cloudflare WAF.
- https://operations.osmfoundation.org/policies/tiles/ — OSMF tile policy: no offline or prefetch use, heavy use blocked, no SLA.
- https://openmaps.fr/tile-usage-policy.html — OTM-style policy: non-commercial, and "<400k tiles/month" low-volume rule of thumb (this may be openmaps.fr's own rule, not OTM's).
- https://mountainsafetycollective.org/ and https://mountainsafetycollective.org/about-msc-1 — MSC: not-for-profit, free, June long weekend to end of September, CAA standards.
- https://www.avalanche.net.nz/ and https://www.avalanche.net.nz/about-us/what-is-the-avalanche-advisory — NZAA: 13 regions, run by NZ Mountain Safety Council.
- https://open-meteo.com/en/docs/bom-api — ACCESS-G via Open-Meteo (terms not read).
- https://www.willyweather.com.au/info/api.html — WillyWeather offers an API (terms not read).
