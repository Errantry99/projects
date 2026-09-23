# 06 — NPC Director SDK

_Research date: 23 September 2026. Owner project #6 from `00-source-report.md`._

> **Web access note.** Web access was **partial**. GitHub pages opened fine, and those are the basis for most of the verified claims below. The egress proxy blocked docs.typesafe.ai, huggingface.co, dev.to, inworld.ai, assetstore.unity.com, docs.godotengine.org, the Godot asset store, laya.convaiinnovations.com and several blogs. The shared WebSearch budget ran out after 11 searches. When a claim rests only on a search-result snippet (page not opened), it is marked _(snippet)_. When I could not check it at all, it is marked **unverified**.

---

## 1. Summary

- **What it is:** a Godot 4 / Unity plugin that serialises a filtered, pre-digested slice of game state and asks a System One model typed questions. Examples: a Choice over legal manoeuvres or encounter beats, a Score for threat or player stress, and Nouls for "is the player fleeing / stuck". Engine code keeps pathing, physics, legality, cooldowns and a reflex override. If the network or the model fails, it falls back to a local model or to the existing behaviour tree.
- **Who it is for:** indie and small-studio developers on Godot and Unity who want NPCs or encounter pacing that feel adaptive without hand-tuning big utility curves. It fits best in server-authoritative or online games that already need a backend.
- **One-line pitch:** "A behaviour-tree node that asks 'what now?' and gets a calibrated answer in ~100–400 ms, never an invalid one."
- **Key finding 1: the per-NPC framing does not survive TypeSafe's published limits.** At 1,200 req/min, one account serves about 20 requests per second in total. Per-NPC decisions at 2 Hz for 6 NPCs use about 720 req/min for **one player**. At roughly 2k tokens per call they also cost about **$3.60 per player-hour**. A director framing (one call per player every ~5 s) costs about **$0.06 per player-hour** and still hits the account-wide limit at around 100 concurrent players (see §4 cost model).
- **Key finding 2: every launch-week game demo is a *player agent*, not an NPC** (Mario, StarCraft, Snake, Pokémon, Minecraft, the drone). The one real NPC demo, HEIST//ONE, runs guards on an authoritative server and uses a scripted fallback. All of them show the same lesson: code must compute the facts (timing, reachability, visibility), because "the state has to contain the answer" (jev-drone).
- **Revised score:** Achievability **3** (unchanged: the cloud MVP takes days, but a shippable local fallback is hard), Impact **3** (down from 4: shipped titles cannot depend on a waitlisted US API for core NPC behaviour), Demand **3** (down from 4: interest is strong among builders but I found no evidence that anyone pays for this, and indie developers want offline and free), Jev fit **4** (down from 5: the judgment fits, but the offline requirement means the shipped path often runs a *non-Jev* model). **Total 13/20** (was 16).
- **Recommendation: go-with-conditions.** Lead with the **Director** (pacing and encounter) framing plus a squad-level tactical node, not per-NPC-per-tick. Make it backend-agnostic from day one: Jev in the cloud through a studio relay, a Laya/jeff-class local model, or scripted. Start with Godot as a GDScript add-on that plugs into LimboAI. Do not build the Unity port or native local inference until the Godot director demo passes the exit criteria in §4.

---

## 2. The idea, fleshed out

### Job-to-be-done
"When my players hit a lull or get overwhelmed, I want the game to notice and respond the way a human dungeon master would, without me writing and tuning dozens of utility curves, and without my game breaking when the network drops."

The secondary job is squad tactics: "When the enemy squad sees the player, pick a sensible manoeuvre from the ones my code says are legal."

### End-to-end flow
1. **Tick scheduler (code).** Each entity is scheduled by event or timer: every 3–10 s for the Director, 0.5–2 Hz for a squad node, and never per frame. It is event-driven, like HEIST//ONE's "bounded refresh rates".
2. **Fact builder (code, written by the developer against an SDK interface).** It gathers raw state and converts every number into a band or a boolean. Examples: `distance_to_player: "near"`, `health: "low"`, `jump_must_start_this_decision: true` (the Mario pattern), `reachable_cover: ["cover_A","cover_C"]` (the Snake flood-fill pattern). It filters to entities within a radius and drops anything player-authored.
3. **Legal-option builder (code).** It lists only the actions that are currently legal, each with a one-line description, plus `no_change` and `other`.
4. **Backend call (SDK).** The request goes asynchronously to (a) the studio relay, then Jev; (b) a local model (Laya-class ONNX); or (c) nothing, in which case the BT default runs. The NPC carries on with its current intent until an answer arrives. Snake does the same: "the snake just keeps going straight" on a missed deadline.
5. **Gate (code).** The answer is applied only if confidence is at least the per-action threshold, the answer is still legal (the world moved), and the reflex layer does not veto. jev-drone's 50 Hz safety layer "can refuse a climb" in the same way.
6. **Act (engine).** A BT branch, animation or navmesh move runs the choice.
7. **Log (SDK).** Every decision is written to a JSONL or telemetry sink.

### The exact Jev questions

**A. Director (primary wedge): one call per player per beat window**

State (≈1–2k tokens): `area_type` (enum), `objective_progress` (enum: `not_started/early/mid/late/complete`), `player_health_band`, `player_ammo_band`, `seconds_since_last_combat_band` (`<15s/15-60s/1-3min/>3min`), `recent_events` (the last 8, **already ordered by code**, newest first, each a fixed-vocabulary string such as `"player_took_heavy_damage"`, `"player_died_and_respawned"`, `"player_cleared_wave"`), `current_intensity_band` (computed in code from damage taken and kills), `same_position_for_band` (computed), and `available_beats` (only the legal ones).

| # | Type | Key | Options / levels |
|---|---|---|---|
| D1 | Choice | `next_beat` | `quiet_period`, `light_wave`, `heavy_wave`, `flank_ambush`, `resupply_drop`, `setpiece_<id>` (only if legal), `escalate_patrols`, `hold_current`, `other_none_fit` |
| D2 | Score (5) | `player_pressure` | 1 relaxed · 2 engaged · 3 pressured · 4 overwhelmed · 5 desperate |
| D3 | Score (5) | `pacing_need` | 1 needs relief · 2 slight relief · 3 keep as is · 4 slight escalation · 5 needs escalation |
| D4 | Noul | `player_stuck` | "The recent events show no progress toward the objective and the player is not in combat." |
| D5 | Noul | `player_disengaged` | "The recent events contain no player-initiated actions." |
| D6 | Choice | `spawn_zone` | code-filtered list of out-of-sight zones by id and description, plus `other_none_suitable` |

Code decides: whether D1 is applied (confidence and cooldown), the spawn counts (a designer table keyed on D1 and D2, never model arithmetic), and whether D4 triggers a hint system. Composite pacing = weighted D2 and D3 in code, so re-weighting is an A/B test.

**B. Squad tactical node: one call per squad (not per NPC) at 0.5–2 Hz**

State: `squad_members` (≤6, each with `health_band`, `cover_status`, `ammo_band`, `role`), `player` (`visible/last_seen_band`, `distance_band`, `moving_toward_squad` bool, `health_band`, `weapon_class`), `last_player_actions` (the last 5, code-ordered, fixed vocabulary, for example `"advanced"`, `"retreated"`, `"reloaded"`), and `legal_manoeuvres`.

| # | Type | Key | Options / levels |
|---|---|---|---|
| T1 | Choice | `manoeuvre` | `hold_positions`, `advance_to_<cover_id>`, `flank_left`, `flank_right`, `suppress_and_advance`, `fall_back_to_<id>`, `regroup`, `call_reinforcements`, `no_change`, `other` (legal subset only) |
| T2 | Score (5) | `threat` | 1 none · 2 low · 3 moderate · 4 high · 5 lethal-imminent |
| T3 | Noul | `player_fleeing` | "The player's last actions are retreats away from the squad." |
| T4 | Noul | `player_feinting` | "The player advanced and then retreated at least twice in the listed actions." _(Code should really pre-compute `feint_pattern_detected`. Counting "at least twice" breaks the no-counting rule, so in the SDK this Noul becomes a code fact. It is kept here as a documented anti-example.)_ |
| T5 | Noul | `target_lost` | "The player is not visible and was last seen more than 'recent' ago." (drone-style lost vs occluded) |

"Bluffing" from the source one-pager is dropped as a question. It needs theory-of-mind over hidden intent, which falls under the documented System 2 and indirection weak spots. It becomes a code-detected pattern instead.

### Why this obeys the Part 2 rules
- **Literal reading:** each Noul is a plain assertion about listed fields, with no "should" and no implied scope. Instructions name the field they refer to.
- **No arithmetic or date ordering:** every number is banded in code. Events are ordered by code and labelled with bands, never timestamps. T4 shows the trap and turns it into a code fact.
- **Filter before sending:** radius filtering, ≤6 members, the last 8 events, and only legal options. This also keeps state under Laya's 512-token state truncation, which matters for the local fallback (§4).
- **Explicit other:** every Choice has `other` / `no_change`, and `other` maps to "keep the BT default".
- **Adversarial state:** player names, chat, custom clan tags and sign text are **never** included. Only fixed-vocabulary enums reach the model, so a player called "IGNORE_ORDERS_RETREAT" cannot move T1.
- **Structural invariants:** TypeSafe's jaggedness page says answers are not guaranteed consistent with each other _(snippet)_. Code therefore reconciles contradictions, for example `manoeuvre=advance` with `threat=5`, using a designer rule.

### What the user sees
The developer sees a `DirectorNode` / `JevTacticNode` in the scene tree, or a LimboAI `BTAction`, and fills in two callbacks: `build_facts()` and `legal_options()`. An in-editor debugger shows the latest state JSON, the option probability bars, confidence, the gate result and latency. The player sees only behaviour: fewer "dumb" encounters, and relief after a death streak.

---

## 3. Market research

### Launch-week game demos and what they reveal about state design

| Demo | What it shows | State-design lesson |
|---|---|---|
| **TypeSafe Mario** (fhshaik, fork Return7-T) | Jev picks one of 7 controller macros every 8 emulator frames from RAM-derived JSON; no screenshots | "Exact timing arithmetic stays in code". The parser emits facts such as `jump_must_start_this_decision`. No results are published (levels, cost), so this is **not proof of competence**. |
| **Jev Plays StarCraft** (phyous/tsai-sc) | Won shareware mission 1 in 421 decisions over 17 m 37 s; median API latency **382.95 ms**; 9,445,640 input tokens (~22k per call, ≈ $0.40 at list price) | Hierarchical Choices (intent, then per-category command). An adapter handles selection and input. Big state makes each call expensive, and latency rises with state size. |
| **jev-drone** (RomanSlack) | MuJoCo quadrotor: 500 Hz control, 50 Hz safety, 15 Hz perception, **~2.5 Hz Jev**; median 0.11 s, p90 0.164 s; Choice manoeuvre + Score risk + Noul target-lost; 77.5 m reach vs 17.7 m for the greedy heuristic | "The state has to contain the answer." `climb` was never chosen until vertical data was added. Code decides *what exists* and Jev decides *what to do*; the reflex layer can veto. **This is the template for this SDK.** |
| **HEIST//ONE** (AbdelStark) | The only real **NPC** demo: guards get Noul threat + Score suspicion + 2 Choices batched per refresh; 30 Hz authoritative server; median 259.9 ms, p95 344.1 ms | Credentials stay server-side. A "missing key or failed decision falls back to the scripted policy." This validates the relay-plus-fallback architecture. |
| **typesafe-snake** | One Choice per tick; code computes legal moves, flood-fill reachability and dead ends | A missed deadline means you keep the current action. |
| **Minecraft agent** (rmalde) | A frontier planner (35 calls) sets goals; Jev makes 131 bounded action picks in 8 m 43 s | Evidence for a **two-tier** split: slow planner/director above, fast chooser below. |

Takeaway: the demos prove the *shape* (typed choice over legal options with code-computed facts). They do **not** show NPCs at scale, many concurrent players, offline play or cost per player-hour. None of them runs above ~2.5 Hz on the cloud path.

### Competitors and adjacent tech

| Product / project | What it does | Pricing | How it differs |
|---|---|---|---|
| **Inworld AI** | Voice and character dialogue for games; Unity SDK, Unreal "AI Runtime"; listed in Unity's AI Marketplace _(snippet)_ | ~$0.004–0.01 per interaction _(snippet, third-party)_ | Dialogue and voice first. Decision-making is a side effect of LLM chat, not calibrated typed choice. |
| **Convai** | Conversational NPCs with voice, vision and "actions" for Unity/Unreal; Unity Asset Store listing _(snippet)_ | Free (~4k interactions/mo), Indie ~$29, Pro ~$99, Scale ~$499, Business ~$1,199/mo _(snippet)_ | Same: dialogue-led, and latency is a common complaint _(snippet)_. No Godot support found. |
| **Laya** (by "Convai Innovations") | Open, Jev-compatible System One model: ModernBERT encoder, ~421M params _(snippet)_, Apache-2.0 weights, ~1.7 GB fp32, ~140 ms/3 questions on an Apple CPU through ONNX; state truncated to **512 tokens**, <~20 options recommended | $0 self-hosted | **The most important adjacent item.** It is a ready local fallback, and if it comes from Convai the NPC company, that company is one step from bundling it. Whether "Convai Innovations" is the same company as Convai (convai.com) is an **open question**. Reportedly "near random" before fine-tuning _(snippet)_. |
| **jeff** (GLiFormer 400M) | Self-hosted Jev-compatible server; MIT code; AG News 75.5% vs Jev 90.5% | $0 | Python server, not embeddable in a game client. Weight licence (knowledgator) **unverified**. |
| **Open-Jev-9B**, **OpenSourceJev**, **Bosun v3.1 (0.6B/1.7B)** | Open re-implementations built on LLM logits | Free (Apache-2.0 adapter / MIT code per snippets) | Too large for 9B to run in a game client; Bosun licence **unverified** (HF blocked). |
| **Unity Inference Engine / Sentis** | Unity's on-device ONNX runtime (opset 7–25) _(snippet)_ | Included with Unity | This is the *runtime* for a Unity local fallback, not a competitor. Whether it supports ModernBERT ops is **unverified**. |
| **Unity Behavior / Muse Behavior** | Unity folded Muse and Sentis into "Unity AI" _(snippet)_; there is a behaviour-graph authoring package | Included | Current status of Muse Behavior (deprecated vs merged) is **unverified**. Unity could add an "AI decision" node to its own graph. |
| **LimboAI** (Godot) | BT + HSM, C++ module or GDExtension; MIT; 3.0k stars; Godot 4.6+; custom `BTAction` in GDScript | Free | **Distribution channel, not a competitor.** A Jev/Laya `BTAction` slots straight in. |
| **Beehave, Godot GOAP/utility add-ons** | GDScript BT/GOAP | Free | Not checked (search budget exhausted). |
| **crashkonijn/GOAP** (Unity) | Multithreaded GOAP, ~2,000 agents shown, Apache-2.0, 1.8k stars, free plus a paid "Support Edition" on the Asset Store | Free / paid tier | Deterministic and fast with zero network use. This is the bar: at 10 Hz per NPC, a Jev node must beat hand-authored GOAP or utility AI on *feel*. |
| **LLMUnity** (undreamai) | Local llama.cpp LLMs in Unity; GBNF grammar-constrained output, function calling; Apache-2.0; 1.7k stars; on the Asset Store | Free | The "Ollama-in-game" route: constrained generation from 1–2B GGUF models. Slower and uncalibrated, but already on the store. |
| **NobodyWho** | llama.cpp for Godot (AssetLib, Godot 4.5+), grammar-based "type-safe tool calling"; EUPL-1.2; 1.2k stars; no web export yet | Free | Godot-native local LLM. Competes directly with the local-fallback half of this SDK. |
| **Left 4 Dead "AI Director"** (Valve, 2008) | The canonical pacing director: reads player stress and schedules build-up, peak and relax phases | n/a | Background knowledge, not opened. It gives developers the mental model the Director framing borrows. |

### Evidence of demand
- **Builder interest is real.** The awesome-typesafe-jev list has 12 game/robotics entries eight days after launch, which is more than most categories. Stars on adjacent tools (LimboAI 3.0k, GOAP 1.8k, LLMUnity 1.7k, NobodyWho 1.2k) show a steady indie appetite for game-AI tooling.
- **Evidence of payment is weak.** Adjacent paid products (Convai, Inworld) sell *dialogue*, not tactics. crashkonijn's GOAP shows that tactical-AI tooling usually monetises as free plus optional support.
- **Not checked:** search-interest trends, Reddit (r/gamedev, r/godot) sentiment, and itch.io jam usage. The search budget ran out, so demand stays **unverified**. My prior (**unverified**) is that much of the indie community is hostile to "AI in games". A non-generative decision model may avoid some of that, but the claim is untested.

### Wedge / why now
- **Why now:** typed, bounded, always-valid output with calibrated confidence is new. LLM tool-calling in games has suffered from invalid actions and 1–3 s latency. Jev's ~110–380 ms and zero schema errors fit a *tactical* tick. Open Jev-compatible models (Laya, jeff) appeared within a week, so a **backend-agnostic** SDK can offer a free offline path on day one.
- **Wedge: Director beats per-NPC.** (1) One call per player, not per NPC, cuts cost and request volume 10–100×. (2) Pacing tolerates seconds of latency, including trans-Pacific round trips from Australia. (3) The failure mode is graceful: if a call fails, default pacing runs and no NPC stands frozen. (4) Pacing judgments ("is the player overwhelmed?") are fuzzy and calibration-hungry, which is exactly what Scores are for, whereas per-NPC movement is well served by BT, GOAP or utility AI. (5) Designers keep authorship: the model only picks among beats they wrote. The downside is that a director is less visceral to demo than "smart enemies", so the demo should show both, with the squad node as the showpiece.
- **Alternative wedge worth testing:** a **playtest-bot mode**. All the launch demos are player agents, and studios would pay for automated QA and pacing telemetry with no shipped network dependency and no per-player cost. It reuses 80% of the SDK.

### Target users and distribution
- **Primary:** Godot 4.6+ indies (the free-tools culture), shipped as MIT on the Godot Asset Library and GitHub. **Secondary:** Unity indies and small studios through UPM/OpenUPM, then the Unity Asset Store.
- **Monetisation (realistic):** the SDK is free and open. Revenue options: (a) a paid "Pro" edition with the editor debugger, replay/eval tooling and threshold tuner ($30–60 one-off on the Unity Asset Store; figure **unverified**, based on comparable tools); (b) a hosted relay with per-studio keys, quotas and analytics (usage-based, above TypeSafe cost); (c) consulting on state design. Expect hobby revenue, not venture scale.

### What would kill it
- **TypeSafe** releases an official C#/GDScript SDK and a "games" cookbook. That takes a week of their time and removes the thin cloud-client layer.
- **Convai / Laya's authors** (if they are the same company) ship Laya inside the Convai Unity plugin as an "actions brain". They already have the Asset Store presence and the model.
- **Unity** adds an "Inference Engine decision node" to Unity Behavior with a bundled small classifier.
- **LimboAI or NobodyWho** add a "choose-from-options" node backed by a local model.

Defence: be the best *state-design toolkit* (fact builders, banding helpers, a legal-option validator, an eval/replay harness, a debugger). That is the hard part, and it outlasts any one backend.

---

## 4. Implementation plan

### Architecture
```
[Game client]
  Scheduler -> FactBuilder(dev) -> LegalOptions(dev) -> Backend interface
                                                   |-- CloudBackend --HTTPS--> [Studio relay] --> TypeSafe Jev (jev-1.13.0 pinned)
                                                   |-- LocalBackend (Laya ONNX via onnxruntime / Unity Inference Engine)
                                                   '-- ScriptedBackend (existing BT default)
  Gate (thresholds, legality re-check, reflex veto) -> BT/engine action
  DecisionLogger -> JSONL / telemetry
[Studio relay] (holds API key, per-player quotas, batching, caching by state hash, logging)
```
- **The API key never ships in the client.** Anything in a build can be extracted. HEIST//ONE keeps its key on the server for the same reason.
- **The fallback LLM sits client-side** (LocalBackend) or on the relay (jeff/Laya server for dev and CI). No generative LLM is involved anywhere, except an optional frontier "planner" tier (the Minecraft pattern), which is out of scope.
- **Cache:** fingerprint the state (hash of the banded facts) and reuse the prior answer when it matches. jev-drone does this ("scene fingerprinting"). Because banding makes states repeat, the cache also cuts cost.

### Tech stack
- **Godot first:** a pure GDScript add-on using `HTTPRequest`/`HTTPClient`, which needs **no GDExtension** for the cloud path and works on every export target, including web. LimboAI `BTAction` subclasses come as an optional integration. The local backend comes later as a GDExtension wrapping the ONNX Runtime C API. Web export excluded at first because GDExtension on web is constrained; this is **unverified** for 4.6.
- **Unity second:** a C# UPM package using `UnityWebRequest`. No official C# TypeSafe SDK exists (the awesome list has Go, Java, Kotlin, PHP, Rust, Swift and Scala, but no C#), so write a thin client against the wire format. For the local backend, try Unity Inference Engine first (bundled, cross-platform) and use ONNX Runtime native plugins if ModernBERT ops are unsupported.
- **Relay:** TypeScript on a small serverless host, using the official JS SDK (MIT). Put it in an AU region where possible and measure the added RTT.
- **Local model:** Laya (Apache-2.0 weights, MIT JS runner). Its 512-token state and <20-option limits line up with a *filtered* game state. Its 1.7 GB fp32 size is too large to ship, so int8 quantisation is needed (size and accuracy after quantisation **unverified**). Laya needs fine-tuning to be useful. Later, a per-game distilled classifier trained on logged Jev decisions (licence permitting) is the most realistic shipped-offline path.

### Data model
`DecisionRecord { id, session_id (random, per run), game_build, sdk_version, backend ("jev-1.13.0" | "laya-<rev>" | "scripted"), question_set_id+version, state_hash, state_json (sampled 1–5%), options[], probabilities{}, confidence, chosen, threshold, gated_result (applied | below_threshold | illegal_now | vetoed | timeout), latency_ms, tick, cache_hit }`. The config file holds `thresholds[question][option]`, `cadence`, `timeouts` and `backend_order`.

### Confidence thresholds and tuning
- **Eval set:** per game, 300–500 state snapshots captured from playtests (200 minimum, following the source report). Stratify across calm, combat, death-streak and stuck situations.
- **Labelling:** 2 designers label the "acceptable" set per snapshot (multi-label, since several beats may be fine). Score agreement with Cohen's kappa; drop items with kappa < 0.4 as ambiguous.
- **Metrics:** acceptable-choice rate per confidence decile (a reliability plot), coverage vs acceptable-rate curve, and Score MAE against designer bands. In-game: the gate-rate breakdown, player-death spacing, time-in-intensity-band vs designer target, and blind A/B playtests ("which run felt better paced?").
- **Thresholds:** start at 0.5 across the board (below 0.5, keep the BT default). Raise per option in proportion to the cost of being wrong: `heavy_wave` and `flank_ambush` start at 0.7, `quiet_period` at 0.4. Re-tune whenever the backend or version changes. Thresholds are stored per backend, because Laya's calibration differs from Jev's.

### Milestones

| Phase | Scope | Exit criteria | Effort |
|---|---|---|---|
| **MVP (5–8 days)** | Godot GDScript add-on: `DirectorNode`, fact/banding helpers, legal-option validator, CloudBackend through a dev relay (TS, ~150 LoC), ScriptedBackend fallback, JSONL logger; demo: a small wave-survival scene with the Director plus one squad node | A 30-minute playtest with zero stalls attributable to the SDK; p50/p95 end-to-end latency **measured from Australia**; ≥95% of calls answered within the 3 s director budget; every decision logged with version and probabilities | ~1,200–1,500 LoC |
| **v1 (4–6 weeks)** | LimboAI `BTAction`s; in-editor debugger panel; replay/eval harness (feed captured snapshots to any backend, emit reliability plot); LocalBackend (Laya ONNX via GDExtension); Unity C# UPM port; relay with per-player quotas, state-hash cache and batching | Eval set of ≥300 labelled snapshots; Jev acceptable-rate at chosen coverage ≥ designer-agreement baseline; Laya local run p95 < 150 ms on a mid-range desktop CPU; offline session indistinguishable from scripted-only (no errors) | ~3,500–4,500 LoC |
| **Later (quarter)** | Distil Jev decisions into a tiny per-game classifier; playtest-bot mode; Unity Asset Store and Godot Asset Store listings; hosted relay product | A shipped jam game or partner title; ≥3 external studios using it; store approval | +2,000–3,000 LoC |

### Testing and observability
- Unit tests for banding (boundary values), the legal-option validator, and the gate, including the stale-answer case where the option is no longer legal.
- Contract tests against the Jev wire format and the Laya/jeff "compatible" backends. The StarCraft harness found jev-1.13.0 percentages that do not sum to 100, so normalise probabilities before use.
- A chaos mode that injects latency, timeouts and 429s to prove the fallback.
- Adversarial tests: fuzz any free-text field and assert it never reaches state.
- Log the model version, probabilities, confidence, backend and latency for every decision. Show a live overlay in the debugger.

### Cost model (TypeSafe's own list price: $0.042 per M input tokens, output free; assumes ~2k tokens per call)

| Usage level | Calls | Tokens | Cost | Rate-limit check (1,200 req/min, 250k tok/s) |
|---|---|---|---|---|
| **Dev/prototyping:** 1 dev, 20 h/week playtesting, Director every 5 s | 720/h → ~62k/month | ~124M/month | **≈ $5/month** | 12 req/min: fine |
| **Small shipped game, Director only:** 1,000 DAU × 1 h/day, every 5 s | 720k/day | 1.44B/day | **≈ $60/day (~$1,800/month); ≈ $0.06/player-hour** | Hits 1,200 req/min at **~100 concurrent players**. Needs a raised limit, caching, or event-driven beats (~1 call/30 s gives ~600 concurrent) |
| **Per-NPC tactics at 2 Hz, 6 NPCs, same 1,000 DAU** | 43,200 per player-hour | 86.4M per player-hour | **≈ $3.63/player-hour (~$3,600/day)** | 720 req/min per player: **one account serves ~1–2 concurrent players.** Batching all NPCs into one call per tick gives 120 req/min per player, i.e. ~10 players. Not viable without enterprise terms |

These costs are TypeSafe's list prices and "may move; TypeSafe cannot show it is not subsidised" (source report). Local Laya inference costs $0 per call but adds build size and CPU load.

---

## 5. Constraints & prerequisites (what we need to know or have before building)

| Item | Type | Why needed | How to get it / owner | Blocking? | Status |
|---|---|---|---|---|---|
| Jev API access (off the waitlist) or an OpenRouter/Vercel AI Gateway route | access / API key | The cloud backend needs it; the Mario fork mentions OpenRouter support | typesafe.ai waitlist; OpenRouter as an alternative; owner: James | yes (for the cloud path) | open question |
| Whether rate limits apply per key, per org or per model, and whether raised limits are available | platform limit | The whole shipped-game viability case rests on it (see cost table) | Email TypeSafe sales; read docs.typesafe.ai/models (blocked here) | **yes** | unverified (1,200 req/min, 250k tok/s per snippet; "change without notice") |
| TypeSafe ToS: may a game relay player-generated requests? Is redistribution or embedding allowed? Is there an SLA? | legal-ToS | Shipping a commercial game on top of an API that has no SLA | Read the ToS and ask TypeSafe | yes (before any commercial title) | open question |
| TypeSafe ToS on **using Jev outputs to train or distil** a local model | legal-ToS | The "later" distillation plan | ToS / ask TypeSafe | no (MVP) / yes (distil) | open question |
| Model version pinning (`jev-1.13.0`) and deprecation policy | platform limit | Thresholds are tuned per version; games live for years | Docs / TypeSafe | yes | known (pin advised), deprecation window unverified |
| Relay hosting plus AU-region latency measurement to TypeSafe | hardware / decision | The latency budget from Australia; TypeSafe region(s) are unknown | Deploy a test relay and measure p50/p95 | yes (for the latency claims) | open question |
| Laya weight licence, provenance, and whether "Convai Innovations" = Convai | legal-ToS / data | Local fallback licence; competitive threat | HF model card (blocked here); ask the authors | yes (for the local path) | Apache-2.0 per the receptron README; identity unverified |
| jeff / GLiFormer weights licence (knowledgator) | legal-ToS | Dev and CI fallback | HF model card | no | unverified |
| Laya quantised size, accuracy and ONNX op support in Unity Inference Engine and in ONNX Runtime from a GDExtension | platform limit / skill | A local fallback that ships | Spike: export, quantise, benchmark | yes (for v1 local) | open question |
| Godot Asset Library rules: FOSS licence only (MIT/GPL/BSD/Boost), manual review "up to a few days" | platform limit | Distribution | godot-docs `submitting_to_assetlib.rst` (opened) | no | known |
| Godot Asset Store (paid, beta) terms | platform limit | Paid Pro edition on Godot | store-beta.godotengine.org (blocked) | no | unverified |
| Unity Asset Store submission rules: external-service disclosure, no bundled keys, native-plugin and third-party-notice rules, AI disclosure, price and revenue share | platform limit / legal-ToS | Unity listing | assetstore.unity.com guidelines (blocked here) | no (UPM/OpenUPM first) | unverified |
| Steam AI-content disclosure for games using AI at runtime | legal-ToS | Partner titles on Steam; a non-generative model may still need a "live AI" disclosure | Steamworks docs | no (SDK) / yes (a shipped game) | unverified |
| Console certification rules for online dependencies and offline behaviour | platform limit | Console ports need graceful offline play | Platform-holder NDAs | no | unverified |
| Privacy: session IDs, sampled state logs; exclude player names, chat and anything else that could identify a player; games may have minors | legal / data | Australian Privacy Act; the OAIC Children's Online Privacy Code (due late 2026, **unverified** timing); GDPR for EU players; COPPA for US | Design the data minimisation; publish a privacy note for relay operators | yes (for the hosted relay) | open question |
| Data retention by TypeSafe (not used for training; ZDR for enterprise per snippet) | legal-ToS | Studio due diligence | Docs / contract | no | unverified |
| Eval dataset: ≥300 labelled snapshots from a real game | data | Threshold tuning | Capture from the MVP demo; 2 labellers | yes (for v1) | open question |
| Decisions: Godot-first? Director vs squad as the headline? Open-source licence (MIT)? Pro edition or hosted relay as the business? | decision | Scope | James | **yes** | open question |
| Skills: GDScript, C#, ONNX/GDExtension C++ | skill | Local backend | James / contractor | no (MVP) | known |

---

## 6. Risks & open questions

| Risk | Kind | Mitigation |
|---|---|---|
| Rate limits and per-player cost make shipped per-NPC use impossible | market / Jev | Director framing, event-driven cadence, state-hash cache, batching per squad; negotiate enterprise limits; local backend as the default for shipped builds |
| Network dependency: outages, offline play, console certification, and waitlisted access in a shipped game | technical | The scripted fallback is always wired in; the cloud backend is optional; answers are only *advisory* over the BT |
| Latency from Australia plus model time (~110–380 ms) overshoots a 2 Hz tick | technical | Asynchronous "keep current intent" pattern; 10 Hz only on the local backend; measure in the MVP |
| **State design is the product.** Developers will dump raw state and get bad answers (context rot; "the state has to contain the answer") | Jev / technical | Ship banding helpers, a legal-option builder, a token-budget warning, and a debugger that shows exactly what the model saw |
| Literal reading: vaguely worded Nouls ("is the player aggressive?") drift | Jev | A question library with reviewed wording; instructions reference field names; eval before trusting |
| Arithmetic and counting slip into questions (T4 anti-example) | Jev | A linter that flags "at least", "more than", numbers or timestamps in instructions or state |
| Adversarial state: player-authored text (names, chat, signs) steering NPCs | Jev / security | An enum-only state schema; free-text fields rejected by the SDK validator |
| Answer inconsistency between questions (advance while threat=5) | Jev | Designer reconciliation rules in code; log contradictions as an eval signal |
| Version drift silently changes behaviour after a game ships | Jev | Pin `jev-1.13.0`; per-version thresholds; replay harness regression before any bump |
| Local model quality is far below Jev (jeff 75.5% vs 90.5% on AG News; Laya "near random" before fine-tuning per snippet) | technical | Fine-tune or distil per game; accept that offline behaviour equals the scripted baseline plus a small uplift |
| Build size (Laya 1.7 GB fp32) | technical | int8 quantisation; optional DLC download (LLMUnity has a "download on first launch" pattern) |
| Player and developer anti-AI sentiment | market | Market it as non-generative, deterministic-bounded, designer-authored options; offline-capable |
| Incumbent copies it (TypeSafe SDK, Convai + Laya, Unity Behavior node) | market | Compete on state-design tooling and the eval/replay harness; stay backend-agnostic |
| Demand unproven; demos are player agents, not NPCs | market | Validate with 5 Godot devs and 1 jam before v1; test the playtest-bot wedge in parallel |
| Probabilities not summing to 100 (StarCraft harness observation) | Jev | Normalise in the client; log the raw values |

**Open questions for TypeSafe:** Do rate limits apply per org? Is there a games/consumer-app tier? Can a studio relay end-user traffic? Are there regions? Is distillation allowed? What is the deprecation window?

---

## 7. Sources

Opened (fetched successfully):
- https://github.com/Return7-T/typesafe-mario — Mario state schema, 7-action space, 8-frame cadence, code-vs-model split.
- https://github.com/fhshaik/typesafe-mario — the original Mario repo; "exact timing arithmetic stays in code"; no published results.
- https://github.com/phyous/tsai-sc — StarCraft: 421 decisions, 382.95 ms median, 9.4M tokens, hierarchical Choices, probability rounding quirk, MIT.
- https://github.com/RomanSlack/jev-drone — layered 500/50/15/2.5 Hz stack, 0.11 s median latency, "state has to contain the answer", reflex veto, heuristic comparison, MIT.
- https://github.com/AbdelStark/heist-one — the only NPC demo: batched guard judgments, server-held key, scripted fallback, 259.9/344.1 ms latency.
- https://github.com/sorrycc/typesafe-snake — per-tick Choice, code-computed legal moves and flood fill, keep-going-on-timeout fallback.
- https://github.com/rmalde/minecraft-agent — planner plus Jev two-tier split (35 planner calls vs 131 Jev calls).
- https://github.com/AbdelStark/awesome-typesafe-jev — ecosystem index: game demos, local models (Laya, jeff, Bosun), SDK list (no C#, no Godot/Unity).
- https://github.com/logan-markewich/jeff — GLiFormer 400M self-hosted server, MIT, accuracy vs Jev, latency.
- https://github.com/receptron/laya — Laya specs: Apache-2.0 weights, ModernBERT, 1.7 GB fp32, ~140 ms CPU, 512-token state, <20 options.
- https://github.com/typesafe-ai/typesafe-sdk-python — official SDK, MIT, `TYPESAFE_API_KEY` auth.
- https://github.com/limbonaut/limboai — Godot BT/HSM plugin, MIT, 3.0k stars, custom BTAction extension point.
- https://github.com/crashkonijn/GOAP — Unity GOAP, Apache-2.0, 1.8k stars, free plus paid support edition.
- https://github.com/undreamai/LLMUnity — local LLMs in Unity with grammar-constrained output, Apache-2.0, Asset Store.
- https://github.com/nobodywho-ooo/nobodywho — local LLMs in Godot, EUPL-1.2, AssetLib, no web export yet.
- https://github.com/godotengine/godot-docs/blob/master/community/asset_library/submitting_to_assetlib.rst — Godot Asset Library licence and review rules.
- https://github.com/alp82/goodwatch-monorepo/issues/112 and https://github.com/korallis/KorWF-Pi/issues/9 — opened; research templates only, no facts.

Search-result snippets only (page not opened; treat as unverified):
- https://docs.typesafe.ai/model-jaggedness/jev-1.13 — nine failure modes, incl. structural invariants and indirection.
- https://docs.typesafe.ai/models and https://opentweet.io/jev/limits — 1,200 req/min, 250k tok/s, 64k/32k budgets, limits change without notice, no training on customer data.
- https://inworld.ai/gaming-media, https://techshark.io/tools/inworld/, https://inworld.ai/blog/unity-inworld-ai-marketplace — Inworld's focus and per-interaction pricing.
- https://convai.com/pricing, https://assetstore.unity.com/packages/tools/behavior-ai/npc-ai-engine-dialog-actions-voice-and-lipsync-convai-235621, https://scribehow.com/page/Convai_Review_2026_The_Most_Technically_Impressive_AI_Character_Platform__Held_Back_by_a_Latency_Problem_That_Wont_Go_Away__QJHPcZlvRkOQFemjqtlo4g — Convai tiers, Unity listing, latency complaints.
- https://www.eesel.ai/blog/laya-ai, https://laya.convaiinnovations.com/, https://flowtivity.ai/blog/laya-open-source-jev-alternative/ — Laya 421M, 33 ms claim, near-random before fine-tuning.
- https://huggingface.co/ZefanCai/Open-Jev-9B, https://github.com/sabeel111/OpenSourceJev — open re-implementation licences.
- https://www.aicerts.ai/news/unity-6-expands-game-development-ai-suite/, https://unity.com/blog/engine-platform/introducing-unity-muse-and-unity-sentis-ai — Unity AI suite and Sentis ONNX opset support.
