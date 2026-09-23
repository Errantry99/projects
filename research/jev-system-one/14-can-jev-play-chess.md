# 14. Can Jev play chess?

_Investigation 14, 23 September 2026. **Web access was partial.** WebSearch worked, and GitHub READMEs could be fetched. These sites were blocked by the egress proxy: typesafe.ai, docs.typesafe.ai, dev.to, arxiv.org, kaggle.com, nicholas.carlini.com, maxim-saplin.github.io, lichess.org / database.lichess.org and huggingface.co. Claims from those rely on search snippets or on GitHub pages quoting them, and are labelled. Every Jev chess number is **self-reported by launch-week builders**; I ran nothing._

## 1. Summary

- **Direct answer: yes, but only in one narrow setup, and only weakly.** Jev plays complete, legal games when code lists the legal moves as a Choice and writes out the tactical facts in words (material after recaptures, hanging pieces, mate threats). The best measured result for a single Jev call per move is **about 950 Elo on a ladder of bots anchored to Stockfish** (plausible range roughly 700–1150; from wondertwins/jev-benchmark, 11 games). That is a club beginner who "never hangs a piece outright but has no plan". **Given only a FEN string, Jev plays worse than choosing a random legal move** (533 vs 403 mean centipawn loss).
- **So Jev is not a chess engine.** Code does the calculating. Jev contributes a calibrated **policy**, a probability for every candidate move, usable as a search prior, for sampling moves in a style, or for matching loose language to an exact move.
- **Confidence:** high that Jev cannot play strong chess on its own, since four independent builders and the documented weak spots all agree. Medium on the exact Elo: the samples are small and the rating scales do not match each other.
- **Best framing:** (d), a **hybrid in which Stockfish proposes and Jev chooses in a given style**. Stockfish supplies sound moves and Jev picks among them to fit a plain-text persona ("play like Tal", "a nervous 1200 who trades when in doubt"). The engine sets the floor; Jev adds only judgment. Second best is (c), Jev as one component of a coach.
- **Go / no-go:**
  - **No-go** on "Jev as a chess engine" as a product. It is weak, and at least six launch-week projects already do it.
  - **Go** on a **two-week evaluation plus demo** of framing (d), puzzles first. Under $10 of Jev tokens at TypeSafe's pricing, and the state-design lessons carry over to NPC Director (#6) and Tessera (#11).
  - **Go-with-conditions** on a product, only if the persona opponent shows measurable style control and is competitive with Maia on human-likeness.

## 2. The question, examined

### Chess against Jev's documented profile

| Jev property (Part 1/2 of source report) | What it means for chess |
|---|---|
| Choice with up to 255 options | Fits: the maximum in any legal position is 218 (well known, not re-verified), typically 30–40. Illegal moves are impossible by construction. Go (up to 361) does **not** fit. |
| 64k-token state | Plenty: about 2,100–3,000 tokens per move with rich facts. |
| Reads literally | Fact wording is the main lever on strength. |
| Not a calculator | Material, attack maps, exchanges and FEN parsing all go in code. |
| Weak at System 2 | No lookahead; anything beyond one ply comes from code or a search. |
| Text only / no generation | Chess is symbolic, so text is fine; but Jev cannot explain moves or write commentary. |
| 70–500 ms; 1,200 req/min | Turn-based, so irrelevant: about 175 ms per move measured, fast enough for bullet. |
| Calibrated probabilities | The real asset, but confidence predicted blunders only weakly (Spearman −0.24), so an engine must still verify. |

The meta-rule, "don't ask the model for something code can compute exactly", settles most of the design: chess is almost entirely computable, and the framings below differ in how much they leave to Jev.

### (a) Choice over all legal moves (Jev plays alone)

**State.** Compact JSON from python-chess: side to move, computed material, piece lists, the last 6–10 SAN moves (long PGN invites context rot), a style line. Do **not** rely on FEN or ASCII for understanding. Each **option** is one legal move with code-written facts, for example:

> `Bxd5 -> bishop b3 to d5, captures pawn; LOSES 2 point(s) of material: the moved piece gets captured on d5`

Facts: capture value, exchange result after forced recaptures, check, "allows mate in one", pieces newly hung or rescued, new threats, repetition.

**Question.** `Choice: "Which move should White play? Priorities: never allow mate, do not give pieces away, take free material, develop and castle."` The options are the legal moves only. The report's "explicit other" rule does not apply to this Choice, because the legal-move set is complete by construction and an "other" option would be a way to pick nothing. It should be added to every *classification* Choice in (c).

**Rule compliance.** *Arithmetic:* compliant only if code does all the counting; FEN-only breaks the rule and does worse than random. *Literal reading:* wondertwins' first tactical wording scored **241 cp**; reporting only the *changes* a move causes, leading with the material verdict and removing constant-noise notes brought the same facts to **90 cp**. *Adversarial state:* none, since code writes the state.

**Measured strength (self-reported, wondertwins, 30 middlegame positions, Stockfish depth 12–14 as reference):**

| State given to Jev | Mean cp loss | Best move | Top-3 | Blunders ≥200 cp |
|---|---|---|---|---|
| Random legal move | 403 | — | — | — |
| FEN only | 533 | 13% | 17% | 73% |
| ASCII + history | 409 | 20% | 27% | 57% |
| ASCII + code facts | 144 | 27% | 50% | 20% |
| + one-ply tactical facts | **90** | **37%** | **57%** | **13%** |

- In full games, loss rose to 200+ cp: with no endgame plan, Jev shuffles and repeats. It beat every bot rated 650 or below and lost both games to Stockfish skill 0 depth 1 (fitted at 1166), for a performance rating of about 968. With a code filter (play mate, drop moves that hang pieces) it went 1–1 against the 1166 bot.
- choxos/jevchess reports 115 cp per move over six games against Stockfish 1320.
- Other ways of asking did worse: one Score per move with argmax gave 197 cp, and piece-then-square gave 217 cp. A two-stage Choice to get round 255 options (as Go would need) probably costs strength the same way.

**Measure** with puzzle first-move accuracy by rating band, cp loss against a Stockfish reference, and a bot ladder fitted by maximum likelihood (Stockfish's `UCI_Elo` floor of 1320 sits above Jev). **Expected ceiling:** about 900–1100.

### (b) Score / Noul as an evaluator inside a search in code

**State and questions.** The position JSON per tree node; a Choice over legal moves as the **policy prior**, a 7-level Score ("Black is winning" to "White is winning") as the **value**, and optional Nouls ("piece hanging?", "tactic?").

**Evidence against the evaluator part.** wondertwins found Nouls over an ASCII board ("in check?", "mate in one?", "piece hanging?") scored near the majority-class baseline, and the 7-level Score correlated 0.64 with Stockfish, "probably material recognition". TholeG's first PUCT search *lost* to the single-call player: Jev's absolute Score says "clearly better" for every child once one side is ahead on material, so the tree had nothing to rank on. Blending Jev's value with material change and mate-in-one computed in code, plus "opponent forcing replies" facts at the root, cut average loss on 20 tactical positions from 168–190 cp to **25 cp** (median 9, best move 9/20). That took 16 calls, about 47k tokens and about 3 s per move. It was tuned on the same 20 positions, has no published Elo, and a 2–0 match proves nothing.

**Rule compliance.** Using Jev as a *policy* obeys the rules. Using it as a *value* breaks "don't hide several judgments inside one question": "who is better" is really material + king safety + activity + tempo. A relative, side-to-move Score, or a value computed in code, is better. **Expected strength:** unknown. It is plausibly above (a), but it is a slow, weak copy of an engine search at 16× the tokens. **Measure:** a held-out cp-loss sweep plus a ladder.

### (c) Coach / tutor

Split the tutor's jobs between code and Jev.

| Job | Who decides | Why |
|---|---|---|
| Blunder detection | **Stockfish** (cp drop ≥ threshold) | Jev's Nouls perform at baseline. This is computation. |
| Opening recognition | **Code** (ECO lookup on the move sequence) | Exact lookup; never ask the model. |
| Difficulty adaptation | **Code** (Elo/Glicko update) | Arithmetic. |
| Move-intent / theme classification ("prophylaxis, pawn break, development, attack, trade, other") | **Jev Choice** over code facts + engine best line | Taxonomy judgment over text, which suits Jev. hemanth/jev-chess ships this. |
| "Which explanation template fits this mistake?" (missed fork / left piece undefended / ignored threat / other) | **Jev Choice** over the facts Stockfish supplies for the played move vs the best move | Choosing a label is the Tessera-style misconception pattern (#11). Prose then comes from templates or an LLM. |
| Natural-language or voice move entry ("put my knight on f3", "night takes") | **Jev Choice** over legal moves | Strong fit. choxos ships it, and hemanth gates it at confidence > 0.6. |

**Why it fits:** every judgment is made over code-written facts about positions the engine has already solved, and adversarial state arises only if user text enters it. Caveat: coaching must be **post-game only**, because help during a game is engine assistance under fair-play rules (not verified per site). **Measure:** agreement on about 300 hand-labelled mistake-to-template pairs, and move-entry accuracy on messy utterances.

### (d) Hybrid: Stockfish proposes, Jev chooses for style or human-likeness

**Flow.**
1. Stockfish MultiPV returns the top N moves (N = 3–8), keeping those within a cp window of the best. The window sets strength, for example ≤50 cp for "strong" and ≤200 cp for "club".
2. Code annotates each move with facts and a coarse engine verdict band.
3. Jev gets one Choice over those N moves, plus a Score for "how in-character is this position for the persona", which can be used to pick lines.

**Questions:** `Choice: "Which move would <persona> most likely play here?"` Options are the N engine moves. The persona is plain text in the state.

**Rule compliance:** few options with exact computed facts, one judgment (style, not calculation), and an engine floor, so no blunder can fall outside the window.

**Comparison with Maia.** Maia is trained on human Lichess games with no search, and is reported at over 52% move-matching against 41% for Stockfish and 46% for Leela (KDD 2020; search snippet). Maia-2 (NeurIPS 2024) and Maia-3 (ICML 2026) are newer. Jev will almost certainly **not** beat Maia at matching the average human at a rating level. Its advantage is **style described in words, with no retraining**: a persona, preferred openings, "trades when nervous", "tilts after losing material".

**Measure:** move-matching against Maia-2 by band; persona statistics computed in code (sacrifice, trade and check rates for "Tal" vs "Petrosian"); a blind "human or bot?" test; Elo against the target. **Expected strength:** controllable from about 1200 to over 2000, set by Stockfish's window, not by Jev.

## 3. Evidence

### Launch-week Jev chess projects (all self-reported)

- **wondertwins/jev-benchmark**: the most rigorous; source of the tables above (`jev-1.13.0`, 16 Sep). Median latency 166 ms (p90 256) over 425 moves, median 32 options, about 2,100 tokens per move. "Chess is calculation and search wearing a judgment costume."
- **TholeG/typesafe-chess**: Jev against Jev with a PUCT search (Choice as policy, Score as value). Fast mode about 350 ms and 2.6k tokens per move; "each MCTS game costs about 2M tokens".
- **choxos/jevchess** (jevchess.xera.ac): Jev against OpenRouter LLMs and Stockfish 19 WASM (1320+), plus voice move entry. About 3,000 tokens and 300 ms per move; "a game only costs Jev about $0.004". Long vs short fact wording: 115 vs 125 cp over six games each (within noise). Notes that "TypeSafe's API does not accept calls from web pages" and that Jev is on OpenRouter as `typesafe/jev-1.13` ("Decisions API").
- **hemanth/jev-chess**: npm library for language-to-move, move evaluation (sharpness Score, theme Choice, king-risk Noul) and persona opponents as weight vectors in code. No strength numbers. malDuffin/typesafe-3d-chess and h3manth.com/fun/jev-chess also appeared in search (not opened).
- **Saplin's LLM Chess leaderboard**: a dev.to post titled "TypeSafe Jev Played Chess — And Landed Next to Reasoning Models" exists, but dev.to and the leaderboard site were blocked. A snippet puts `jev-latest` at about #59, about 243 Elo (**unverified**). That leaderboard anchors to Dragon levels (Elo = 125 × (level + 1), per the repo README), and its chat-style harness probably lacks code-computed tactical facts (unverified), which would explain the gap from 968. **The Elo scales across these sources are not comparable.**
- **Go and other board games:** my searches found no Jev Go project. I did not search exhaustively.

### Other game demos, and what they say about game-state design

- **phyous/tsai-sc (StarCraft):** Jev completed the first combat mission of the 1998 shareware (Strongarm) in 421 decisions, 9,445,640 input tokens (about $0.40 at the report's pricing) and a median latency of 383 ms. The game was **paused during state reads and inference**, and the README warns that one successful run "does not establish a win rate". It was inspired by TypeSafe's own Doom demo.
- **VBS2004/jev-plays-super-mario-bros:** clears 1-1 to 1-4 and 2-1 for about $0.022 from RAM turned into "decision-shaped facts", with all arithmetic in Python. A **rollback search in the emulator verifies** every move. Two lessons carry over: "Every failure in this project was **the state lying to the model**" and "**ask for outcomes, not actions**". The typesafe-mario forks and shantanugoel/mario-jev use the same object-centric JSON.

**Inference for chess.** Every working demo has three parts: code turns raw state into named, pre-computed facts; Jev chooses among bounded options; something deterministic verifies (rollback, search, filter). In chess Stockfish is the natural verifier, which makes (d) the chess version of the pattern that works, and "pause during inference" is free.

### Prior work on LLMs and chess

- **gpt-3.5-turbo-instruct:** about **1750 ± 50 Elo** in Carlini's 2023 PGN-continuation experiments (search snippet). Karvonen's `chess_gpt_eval` (opened) reports an illegal-move rate "under 0.1% over 8205 moves". That strength comes from *generating* the continuation of a PGN record, learned from game records in pretraining. Jev cannot continue text, so there is no reason to expect it to transfer.
- **Maia** (CSSLab, opened): human-like engines per rating band from 1100 to 1900, run with `go nodes 1` (no search), with Lichess bots maia1/5/9. Human-likeness without search comes from chess-specific training on millions of games, and Jev has none.
- **LLM Chess leaderboard** (Saplin, opened): a random opponent plus Dragon levels 1–7 (250–1000 Elo). Reasoning models "saturated random-based evaluations" in 2025.
- **Kaggle Game Arena:** a Chess Text leaderboard of frontier LLMs, with Gemini 3 Pro and Flash reported at the top (snippets; **unverified**). DeepMind's 2024 "Grandmaster-level chess without search" (a 270M-parameter transformer distilled from Stockfish) is cited from memory (**unverified**).

**Implication:** strong play without search needs chess-specific training, and Jev is a general-purpose judge. Its contribution is a calibrated distribution over options that code has vetted, useful for style, for sampling, and as a search prior, not as playing strength. Its one clear edge over chat LLMs is that it never produces an illegal move and never breaks format, and on the LLM Chess leaderboard those failures cost chat models many games.

## 4. Implementation plan (framing d, with (a) as the ablation baseline)

### Architecture

```
Lichess BOT stream / local match runner
        │ position
        ▼
python-chess board ──► Stockfish (UCI, MultiPV N, depth/time) ──► candidate filter (cp window)
        │                                                              │
        └──► facts.py (SEE, hanging, mate-in-1, threats, repetition) ──┤
                                                                       ▼
                               state.json (persona text, last 8 SAN, material, candidates+facts)
                                                                       ▼
                               Jev: Choice(move) + Score(in-character) + Noul(sharp)  [one call]
                                                                       ▼
                        gate: p_top < τ → play engine-best of window; else play Jev's choice
                                                                       ▼
                        log: model version, full distribution, confidence, SF evals, latency
```

**Stack:** Python 3.11 with python-chess; a native Stockfish 17+ binary; the TypeSafe Python SDK (signature unverified; OpenRouter as fallback); the `lichess-bot` homemade-engine hook; SQLite logs; lc0 with Maia weights as the human-likeness baseline. Python rather than chess.js because the evaluation tooling is all Python.

### Experiment plan

1. **Reproduce baseline (a)** on 30 middlegame positions at four state levels. Exit: tactical level ≤150 cp; otherwise the harness or model has drifted.
2. **Puzzles:** 1,000 from the Lichess CC0 CSV, stratified by 6 rating bands (600–2100) and themes (mateIn1, hangingPiece, fork, pin, endgame). Metrics: first-move accuracy, full-line solve rate, and the band where accuracy crosses 50%. Ablate the facts and show `#` as `+` so facts do not leak answers. For (d), check the solution is in the top-N set and whether personas pull Jev off it.
3. **Games:** a ladder of random, greedy-capture, Stockfish skill 0 depth 1 with 0–50% random moves, `UCI_Elo` 1320/1500/1800 and Maia-1100/1500/1900. At least 20 games per rung, alternating colours, maximum-likelihood fit with 95% CI. For (d), sweep cp windows {50, 100, 200}.
4. **Style:** about 5k held-out Lichess positions per band; move-matching of Jev-hybrid ("a typical 1500 player") against Maia-2; persona statistics computed in code.

### Thresholds (to be tuned, not trusted)

- **τ (confidence gate).** Start at 0.5, per the report's floor. Sweep 0.3–0.8 on the puzzle set and plot blunder rate against τ. Expect weak separation, given Spearman −0.24.
- **Product go criteria for (d):**
  - move-matching within 3 percentage points of Maia-2 in at least one band, **or** persona statistics that differ at p < 0.01 between two personas;
  - fitted Elo within ±150 of the target set by the window.
- **Kill criterion:** below both of those lines after milestone M3.

### Milestones

| Phase | Scope | Exit criterion | LoC (±50%) |
|---|---|---|---|
| M0, day 1 | Access, playground, pin `jev-1.13.0`, logging | First logged call with the full distribution | 100 |
| M1, days 2–4 | facts.py, state builder, player (a), puzzle harness | Step-1 reproduction plus a report of 1,000 puzzles | 900 |
| M2, week 2 | Stockfish MultiPV hybrid (d), bot ladder, Elo fit | 20+ games per rung, Elo with CI for (a) and (d) | +500 |
| M3, week 3 | Maia comparison, persona metrics, τ sweep | Go/kill decision against the thresholds | +400 |
| M4, week 4+ | lichess-bot homemade engine, casual challenges, web board with probability arrows | Bot live, 100 casual games logged | +400 |
| Later | Coach layer (c): mistake-template Choice, voice move entry | ≥85% agreement on 300 labelled mistakes | +800 |

MVP (M0–M2) is about 1,500 LoC. The full plan comes to about 3,100 LoC.

### Cost (TypeSafe's own pricing: $0.042 per million input tokens, output free; may be subsidised)

| Usage | Tokens | Cost |
|---|---|---|
| One fast move (a), about 2.1–3k tokens | ~2.5k | ~$0.0001 |
| One game, 40 Jev moves, framing (a) | ~100–120k | ~$0.005 (choxos reports ~$0.004) |
| One game, framing (d) with N=5 (shorter option list) | ~60–80k | ~$0.003 |
| One MCTS-16 game (b) | ~2M (TholeG) | ~$0.08 |
| 1,000-puzzle evaluation, about 2.5 Jev moves per puzzle | ~7.5M | ~$0.32 |
| Full M1–M3 campaign (≈600 games + puzzles + 5k style positions) | ~80M | ~$3.40 |
| Public bot, 1,000 games a month | ~100M | ~$4.20 a month |

Stockfish and Maia run locally, so their only cost is CPU.

## 5. Constraints & prerequisites

| Item | Type | Why needed | How to get it / owner | Blocking? | Status |
|---|---|---|---|---|---|
| Jev API key | access | Every experiment | typesafe.ai waitlist; alternatives are OpenRouter `typesafe/jev-1.13` (per the choxos README) or Vercel AI Gateway (per the report) | yes | known (waitlist); OpenRouter route unverified by me |
| Rate limits: 1,200 req/min (20/s), 250k tokens/s, "moving without notice" | platform limit | Fast mode is 1 request per move, so dozens of parallel games fit; MCTS-16 is about 5 req/s per game (about 4 at once). A 2 Hz loop is irrelevant for chess. | Report / TypeSafe docs | no for (a)/(d); yes for (b) at scale | known (report); current values unverified |
| Browser calls refused (no CORS) | platform limit | A web demo needs a server relay | Owner builds a relay | no | per choxos README, unverified |
| Model version pin `jev-1.13.0` | decision | wondertwins saw `jev-preview` vs `jev-latest` differ (129 vs 144 cp) | Pin in config; log the version on every call | yes, before tuning τ | known |
| Stockfish licence (GPL v3) | legal-ToS | Reference evaluator and the proposer in (d) | Running it as a separate UCI process is fine. Distributing it bundled means shipping the licence and source. Server-side SaaS is not "distribution" under GPL (not AGPL). Not legal advice. | no | known (Stockfish README) |
| Lichess puzzle DB, CC0, about 5.8M puzzles, monthly CSV | data | Puzzle evaluation | database.lichess.org/lichess_db_puzzle.csv.zst | no | known via search snippets (site blocked) |
| Lichess games DB (for the Maia comparison) | data | Style / human-likeness evaluation | database.lichess.org monthly PGNs; CC0 from memory | no | unverified |
| Maia weights (Maia-1/2/3) and their licences | data / legal | Human-likeness baseline | CSSLab GitHub / HuggingFace | no | licence unverified |
| Lichess BOT account | account | Public play | New account with **no games played**, OAuth token with bot scope, upgrade is **irreversible** | yes for M4 | known (lichess-bot wiki, search) |
| Lichess bot conduct rules (no rating manipulation or farming, challenge-only, rate limits on the Bot API) | legal-ToS | Avoid bans | Read lichess.org/api Bot section and the ToS; play casual games only at first | yes for M4 | **unverified** (lichess.org blocked) |
| Fair-play rules (Lichess, Chess.com) | legal-ToS | A coach used during live games is engine assistance | Restrict coach (c) to post-game analysis | yes for (c) | unverified per site |
| Privacy (Australian Privacy Act; minors) | legal | A coach importing a user's game history ties public games to an identity. Many chess players are children. | Store usernames only, no chat, age gate for a consumer app | no for eval; yes for product | open question |
| Hardware, and the skill to write exchange evaluation and fact wording | hardware / skill | Stockfish MultiPV plus lc0/Maia; wording is the main lever on strength | Any CPU (a GPU helps Maia-2/3); reuse ideas from tactics.js and wondertwins | no | known |
| Owner decisions | decision | Purpose (learning demo vs product); framing (d) vs (c); Python vs JS; whether to run a public bot; which persona set | James | yes | open |

## 6. Risks & open questions

| Risk | Mitigation |
|---|---|
| **The harness does the playing.** Richer facts blur the line with a one-ply engine, and "allows mate" or `#` flags give answers away. | Ablate the facts per level. Hide mate markers in puzzles. Report the random-choice and code-filter-only baselines next to Jev. |
| **Literal reading and overfitted wording.** Noisy notes derail it (241 vs 90 cp), and TholeG's 25 cp came from 20 positions reused in tuning. | Report only changes a move causes; separate tuning and test sets; freeze wording before the ladder; A/B every wording change. |
| **Score saturation** in search or evaluation. | Relative question (side to move, compared between siblings) and a value computed in code. |
| **Weak calibration for blunders** (Spearman −0.24). | Engine window or filter as the verifier. Tune τ on puzzles. Do not trust confidence alone. |
| **Endgame and planning collapse** (repetition, shuffling). | Syzygy tablebases in code, repetition facts, draw or resign logic. |
| **Elo scales conflict** (243 Dragon-anchored vs 968 bot ladder vs a 1320 `UCI_Elo` floor). | Publish your own ladder with anchors and a CI. Never compare across scales. |
| **Market saturation.** At least six Jev chess projects in week one, and Maia-3 dominates human-likeness. | Build only if persona control is measurably distinct. Otherwise treat this as a learning exercise. |
| **Version drift, pricing, rate limits moving** | Pin the version, log everything, keep a local fallback (openjev) for development. |
| **Adversarial state** (low risk here). | Never put Lichess chat or user-typed persona text into state unescaped. Cap persona length. |
| **Open question:** is Jev's distribution over N engine moves more human-like than Stockfish's own MultiPV softmax? That is the cheap baseline to beat. | Include the softmax-over-cp baseline in M3. |

## 7. Sources

Opened (fetched successfully):
- https://github.com/TholeG/typesafe-chess — Jev policy/value MCTS, the Score-saturation lesson, the sweep table, token and latency per move.
- https://raw.githubusercontent.com/choxos/jevchess/HEAD/README.md (repo https://github.com/choxos/jevchess) — fact-described options, about 3k tokens and 300 ms per move, about $0.004 per game, wording A/B, OpenRouter route, no-CORS note.
- https://raw.githubusercontent.com/hemanth/jev-chess/HEAD/README.md — intent-to-move, evaluation dimensions, persona weight vectors.
- https://raw.githubusercontent.com/wondertwins/jev-benchmark/HEAD/README.md — state-ablation table, puzzles, ladder Elo of about 968, latency, calibration.
- https://github.com/hellogumbo/awesome-jev — list of game and simulation projects.
- https://raw.githubusercontent.com/phyous/tsai-sc/HEAD/README.md — StarCraft run statistics, paused inference, reference to the Doom demo.
- https://raw.githubusercontent.com/VBS2004/jev-plays-super-mario-bros/HEAD/README.md — Mario costs, rollback verification, "state lying to the model", "outcomes not actions".
- https://raw.githubusercontent.com/maxim-saplin/llm_chess/HEAD/README.md and `docs/notes.md` — Dragon-anchored Elo method.
- https://raw.githubusercontent.com/adamkarvonen/chess_gpt_eval/master/README.md — gpt-3.5-turbo-instruct illegal-move rate.
- https://raw.githubusercontent.com/CSSLab/maia-chess/master/README.md — Maia 1/2/3, Lichess bots, `nodes 1`.
- https://raw.githubusercontent.com/lichess-bot-devs/lichess-bot/master/README.md and the wiki page "Upgrade-to-a-BOT-account" — bot bridge, irreversible upgrade.
- https://raw.githubusercontent.com/official-stockfish/Stockfish/master/README.md — GPL v3 terms.

Search results only (page blocked or not opened; claims from these are snippet-level):
- https://dev.to/maximsaplin/typesafe-jev-played-chess-and-landed-next-to-reasoning-models-28ga and https://maxim-saplin.github.io/llm_chess/ — Jev at about #59, about 243 Elo (**unverified**).
- https://nicholas.carlini.com/writing/2023/chess-llm.html — gpt-3.5-turbo-instruct at 1750 ± 50 Elo.
- https://www.kaggle.com/blog/chess-text-leaderboard — Game Arena chess leaderboard.
- https://database.lichess.org/ and https://huggingface.co/datasets/Lichess/chess-puzzles — puzzle CC0 licence and count.
- http://csslab.cs.toronto.edu/blog/2020/08/24/maia_chess_kdd/ — Maia move-matching figures.
- https://typesafe.ai/blog/introducing-system-one-models-and-jev and https://docs.typesafe.ai — blocked. Jev limits and pricing are taken from the source report (TypeSafe's own numbers).
