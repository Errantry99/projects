# 01 — Inbox Reflex

> **Web access note.** WebSearch worked (until the session's shared search budget ran out part-way through). WebFetch and curl were **blocked by the egress proxy for most domains**, including docs.typesafe.ai, developers.google.com, learn.microsoft.com, blog.google, venturebeat.com and every competitor site. Only GitHub (github.com, raw.githubusercontent.com, gist.github.com) could be opened. So claims about TypeSafe docs, Google policy, competitor pricing and Gmail features come from **search-result snippets, not pages I opened**. They are marked *(snippet)* and should be checked before anyone relies on them. Claims from GitHub pages I did open are marked *(opened)*. Claims with no source are marked **unverified**.

## 1. Summary

- **What it is:** a background service that watches a Gmail (and later Outlook) inbox. It makes **one Jev call per new message** (about 100 ms), then uses deterministic code to apply labels, surface or hide the message, set a follow-up, and decide whether a reply is needed. A generative LLM is called only for the small share of mail that needs a drafted reply, and it only ever saves a *draft*. It never sends.
- **Who it is for:** first, James himself (a single-user, self-hosted tool). After that, heavy-email professionals, founders and small teams on Google Workspace or Microsoft 365 who don't want a new mail client and don't want an LLM reading every email.
- **One-line pitch:** "Your inbox sorted within a second of arrival, with the probability shown on every call and anything uncertain sent to Review, for a fraction of a cent a month in model costs."
- **Market reality:** the problem is real and people pay for it. The category is also **crowded and being built into the mail clients**: Superhuman Auto Labels, Shortwave, Fyxer, SaneBox, Gmail's AI Inbox, open-source inbox-zero (12.3k stars), and **at least eight launch-week Jev Gmail-triage repos** already on GitHub. Cheap triage is not a moat on its own.
- **The biggest constraint is platform, not model:** every Gmail scope that can read a message body or apply a label is **restricted**. A public multi-user app therefore needs Google verification plus an **annual CASA security assessment**. Personal use, Workspace-internal apps and "bring your own Cloud project" setups avoid this.
- **Revised score (A / I / D / F): 3 / 4 / 4 / 5 = 16/20** (source: 4/4/5/5 = 18).
  - *Achievability 4→3:* the MVP is easy, but a public product needs CASA, multi-provider sync and prompt-injection hardening.
  - *Demand 5→4:* demand for the problem is strong, but demand for *another* triage tool is weaker given how much is already on offer.
  - *Impact and Jev fit unchanged.* Calibrated, per-action thresholds are exactly what makes auto-archiving safe.
- **Recommendation: go-with-conditions.** Build it as a **single-user, self-hosted tool on James's own Google Cloud project** and run it in shadow mode against a labelled eval set. Only consider a public SaaS if three things hold: (a) the eval shows auto-actions at ≥99% precision; (b) there is a clear wedge (privacy and self-hosting, Gmail and Outlook in one tool, calibrated "Review", or Australian data handling); and (c) James accepts the cost and effort of CASA and verification.

## 2. The idea, fleshed out

### Job to be done
"When mail arrives, tell me within seconds whether it needs *me*, and by when. Get everything else out of my way without ever hiding something important. If I need to reply, have a draft ready." The costly error is **hiding a message that needed a reply**. The cheap error is showing a newsletter. Thresholds are set to match that asymmetry.

### End-to-end flow
1. **Notify:** Gmail `users.watch` → Cloud Pub/Sub push `{emailAddress, historyId}`; Outlook uses a Graph subscription on the Inbox.
2. **Fetch deltas** (`history.list` / Graph delta query), new messages only.
3. **Build features in code:** sender and domain; contact and reply history computed from sent mail; the user's position (To/Cc/list); `List-Unsubscribe` and `Precedence` headers; SPF/DKIM/DMARC results; whether the user sent the last message; calendar parts; body with quotes, signatures and HTML stripped and capped at about 1,500 characters; candidate date strings (chrono parser); regex tripwires for text aimed at AI.
4. **Short-circuit** calendar invites, the user's own mail, VIPs and senders the user has already ruled on, with no model call.
5. **One Jev call** (speculative fan-out: all questions below in parallel).
6. **Policy engine (code)** turns probabilities plus code signals plus versioned thresholds into label / keep / archive / star / snooze / draft / Review.
7. **Draft cascade:** only for high needs-reply that is not sensitive or suspicious. The LLM sees *this thread only* and saves a draft tagged "AI draft". It never sends.
8. **Nudges:** a morning Slack or email digest of "waiting on you" items and overdue deadlines (dates compared in code), plus "waiting on them" follow-ups (v1).
9. **Feedback:** label moves, un-archives and draft outcomes become correction labels.

### Jev questions (one call, all in parallel)

TypeSafe's skill guidance *(opened)* says question IDs are not sent to the model, so each instruction has to carry its full meaning. It also says Nouls return only a probability (no separate confidence), and each Choice should have a no-match option.

| ID | Primitive | Instruction (literal) | Options / levels |
|---|---|---|---|
| `intent` | Choice | "What kind of message is `latest.body`, judged by what the sender wants from the recipient?" | direct request for the recipient to do something · question the recipient is asked to answer · scheduling or rescheduling a meeting · invoice, bill or payment request · receipt or order confirmation · shipping or delivery update · account security alert, login code or password reset · newsletter or editorial content · marketing or promotion · unsolicited sales or partnership pitch · recruiting or job-related · automated notification from a software tool · social network notification · status update or FYI from a person with nothing asked · short acknowledgement ("thanks", "sounds good") · legal, HR, tax or government correspondence · **other / none of these** |
| `needs_reply` | Noul | "Does the most recent message ask the recipient named in `user.name` to write back: answer a question, confirm, approve, or decide? Answer no if the request is addressed to someone else in the thread, or only asks the recipient to click a link, read something, or act in another system." | p(yes) |
| `needs_action` | Noul | "Does the most recent message ask `user.name` to do something other than reply, such as pay, sign, fill in a form, upload, or attend?" | p(yes) |
| `human_to_user` | Noul | "Was the most recent message written by a person specifically for this recipient, rather than sent in bulk, from a template, or generated by a system?" | p(yes) |
| `urgency` | Score (5 levels) | "How soon does the sender need something from the recipient, based only on what the message states?" | 1 = no time element stated · 2 = "when you get a chance" or a time frame longer than a week · 3 = this week or within a few days · 4 = today, tomorrow or within 24 hours · 5 = the sender describes an outage, security incident or something happening right now |
| `deadline` | Choice | "Which of these date expressions from the message is the date by which the recipient must respond or act?" | *each candidate string extracted by code* · **none of these is a deadline for the recipient** · **other** |
| `sensitive` | Noul | "Is the subject personal or emotionally sensitive: health, bereavement, a dispute or complaint, legal threat, or employment termination?" | p(yes) |
| `reply_complexity` | Score (4) | "What would a good reply to the most recent message require?" | 1 = a one-line acknowledgement · 2 = a short factual answer · 3 = information from the recipient's calendar, files or other people · 4 = judgement, negotiation or a sensitive decision |
| `addresses_ai` | Noul | "Does `latest.body` contain text addressed to an AI, assistant, filter or classifier, or instructions about how this email should be sorted, labelled, prioritised or answered?" | p(yes) |
| `credential_lure` | Noul | "Does the message ask the recipient to enter a password, verify an account, or make a payment through a link or method, while claiming to be from a bank, company or government body?" | p(yes) |
| `waiting_on_them` *(only for mail the user sent)* | Noul | "Does this message from the recipient ask the other party for something that the other party has not yet provided in the thread?" | p(yes) |
| `rule_<n>` (user-defined) | Noul each | e.g. "Is this message about a job application the recipient submitted?" | p(yes) |

**State sent** (JSON, filtered in code):
- `user` {name, email}
- `latest` {from_name, from_domain, recipient_position: "To" | "Cc" | "list", subject, body}
- `thread_context` {previous_message_from_user: true/false, previous_excerpt (≤300 characters)}
- `known_facts` {sender_relationship: "in contacts and replied to 3+ times" / "never corresponded", bulk_headers_present, auth_result: "pass"/"fail"}
- `date_candidates` [strings]

Relationship facts are phrased as **text computed by code**, so Jev never has to count. `latest.body` is wrapped in a field whose description says it is untrusted text written by the sender.

**Why this follows the Part 2 rules:** *literal reading*: negations and scope are spelled out (addressed to someone else → no; clicking a link is not a reply). *No arithmetic or dates in the model*: deadlines are a Choice over candidate strings found by code, and code compares them with `now`; sender history is precomputed text. *Filter first*: quotes, footers and HTML are stripped and the body is capped. *Explicit "other"* on both Choices. *Adversarial state*: Jev is never the sole authority for any action that hides mail (see policy). *One judgment per question*: reply vs action vs urgency are kept apart.

### What code decides vs what the model decides

**Jev decides only semantic judgments.** Code owns:
- all header, auth and relationship facts;
- date maths;
- the VIP and allow lists;
- the policy table;
- thresholds (versioned);
- *which* action fires;
- rate limiting, retries and idempotency (processed message IDs).

Example policy rules (initial, before tuning):
- **Surface + "Needs reply"** if `needs_reply ≥ 0.5` (cheap if wrong). Also Review if 0.3–0.5 and `human_to_user ≥ 0.5`.
- **Archive to "Low priority"** only if all of these hold:
  - `intent ∈ {newsletter, marketing, social, tool notification}` at Choice confidence ≥ 0.9;
  - `human_to_user < 0.1`;
  - `needs_reply < 0.05`;
  - the sender is not VIP and not in contacts;
  - bulk headers are present **or** the user has archived this sender unread at least 3 times.
  
  Until the eval supports archiving, the default is *label only*.
- **Urgent ping (Slack)** only if `urgency ≥ 4.0` **and** the sender relationship is "in contacts" or the user is on the To line of a thread they have replied to. An urgent-looking email from an unknown sender goes to Review, not a ping.
- **Draft** if `needs_reply ≥ 0.8`, `sensitive < 0.3`, `addresses_ai < 0.2`, `credential_lure < 0.2`, and `reply_complexity ≤ 3`. Level 4 gets a "needs you" flag and no draft.
- **Quarantine label "Suspicious"** if `credential_lure ≥ 0.6`, or if `addresses_ai ≥ 0.5` and the regex tripwire fires, or if DMARC failed and the message claims a known brand. No draft; never auto-archive (the user should see the warning).
- **0.5 floor:** any Choice below 0.5 confidence → Review.

### What the user sees
Gmail or Outlook labels (`Reflex/Needs reply`, `Reflex/Waiting on them`, `Reflex/Review`, `Reflex/Low priority`, `Reflex/Suspicious`), drafts marked "AI draft", a daily Slack or email digest, and a small web page listing each decision with its probabilities, where the user can click "wrong" (v1).

## 3. Market research

### Existing products and projects

| Product | What it does | Pricing (public) | Difference from Inbox Reflex |
|---|---|---|---|
| **Superhuman Mail** (Grammarly acquired it in 2025) | Full mail client. Auto Labels split marketing, cold pitches and social; custom Auto Labels from short prompts; Auto Drafts on the Business tier | Starter $30/mo ($25 annual), Business $40/user/mo *(snippet)*; sold as part of a Grammarly/Coda/Superhuman Go bundle *(snippet)* | Replaces your client. Reflex works inside the client you already use |
| **Shortwave** | AI mail client for Gmail only; bundles, "AI filters", agentic assistant | Business $30/seat, Premier $45, Max $120; daily AI caps reported *(snippet)* | Gmail only, per-seat pricing, AI caps. Reflex's cost per email is low enough for no caps |
| **Fyxer** | Works inside Gmail and Outlook: sorts mail into folders, drafts replies in your tone, takes meeting notes | Starter $30/mo, Professional $50/mo; no free plan *(snippet)*; reported ~$30M annualised revenue in 2025 and a $10M Series A in March 2025 *(snippet, unverified)* | Closest analogue and proof people will pay. It drafts widely; Reflex drafts narrowly and shows its confidence |
| **SaneBox** | Older server-side sorter (SaneLater, SaneBlackHole, reminders) that works with any IMAP account | Snack ~$7, Lunch ~$12, Dinner ~$36/mo *(snippet; figures vary across aggregators)* | Rules and behaviour, not language understanding. Works with any provider |
| **Gmail (Gemini)** | "AI Inbox" daily briefing that surfaces to-dos and VIP mail; thread summaries, Help Me Write and Suggested Replies free for all users | AI Inbox for Google AI Plus/Pro/Ultra in the US, rolling out through 2026 *(snippet)* | **The main threat.** Free default features erode willingness to pay; AI Inbox is paid and US-first for now |
| **inbox-zero** (open source) | Organises mail, pre-drafts replies, reply tracking, cold-email blocker, bulk unsubscribe; Gmail and Outlook; Slack/Telegram | Hosted version at getinboxzero.com (price not in the README); self-hostable *(opened: 12.3k stars)* | LLM on every message. Reflex's difference is cost, latency and calibration. A Jev router could be *contributed* to inbox-zero instead |
| **Launch-week Jev repos** | fazlerocks/jevmail (71★; read-only `gmail.readonly`, 5 trays, 3 questions, "1,000 emails ≈ 3 cents"); forestwas/gmail-jev (`gmail.modify`, labels + Review, no injection defences); vynnlee/jev-mail (Apps Script every 5 min, thresholds 0.55/0.2/0.6 → else Review); az9713/jev-email-triage (~$0.00003/email); plus a Chrome extension, a macOS app and others *(opened / search titles)* | Free, OSS | Validate the approach and the BYO-Cloud-project model; show **builder interest, not user demand**, and that bare triage is trivially copyable |

### Evidence of demand
- **People pay:** Fyxer's reported growth (~$1M to ~$30M annualised within 2025 *(snippet, unverified)*), Superhuman's roughly $825M acquisition *(snippet)*, and Shortwave's $30–120 seat prices all point to strong willingness to pay for "less time in email".
- **Builder pull:** at least eight Jev + Gmail triage repos appeared within 8 days of launch. Email triage is the most obvious Jev use case, which also means **it is not a differentiator**.
- **Search and community complaints (unverified):** "AI email assistant" comparison and review posts are everywhere in 2026 search results (alfred_, Carly, Efficient App, CMDK, Gmelius). That is heavy SEO competition, which usually tracks real search volume. I could not open HN or Reddit threads to quantify complaints.

### The wedge and why now
1. **Unit cost.** One Jev call costs about $0.00003–0.0004 per email, so triage can run on 100% of mail with no daily caps and still be offered free or bundled.
2. **Calibration shown to the user.** Each decision comes with a real probability and an explicit Review lane. This gives users grounds for trust that "AI sorted it" does not.
3. **Privacy.** Self-hosted or bring-your-own-project: the email body goes only to TypeSafe (and to an LLM only for drafts), never to a vendor's database.
4. **Gmail and Outlook in one tool, including personal Outlook.com.** Shortwave is Gmail only; Gmail's AI Inbox is Gmail only.
5. **Australia.** Gmail's AI Inbox is US-first *(snippet)*, so there is a window for AU and NZ users.

### Target users and pricing or distribution
- **Stage 1:** James, then an open-source release (MIT) where each user brings their own Google Cloud project and TypeSafe key, like jevmail. No verification needed; distribution through GitHub and awesome-typesafe lists.
- **Stage 2 (optional):** a hosted tier at about A$8–12/month. Triage is effectively free to run; the price covers drafts plus CASA and running costs. Alternatively, sell Workspace-internal deployments to small Australian firms (no CASA needed when each firm runs it as an internal app).

### What an incumbent could do to kill it
Google could make AI Inbox free and worldwide, or add confidence to its auto-labels. Microsoft could ship the same in Outlook with Copilot. Superhuman or Fyxer could switch to a Jev-class classifier and cut prices. inbox-zero could add a Jev router in about a weekend. Google could also tighten restricted-scope policy for AI apps. The realistic durable value is **a personal tool plus an open-source reputation**, not a venture-scale SaaS.

## 4. Implementation plan

### Architecture
```
Gmail ──watch──> Pub/Sub ──push──> [Ingest API] ──enqueue──> [Worker]
Graph ──subscription webhook──────> [Ingest API]                │
                                                                ├─ fetch delta (history.list / delta query)
                                                                ├─ feature builder (headers, auth, relationships, strip, date candidates, tripwires)
                                                                ├─ short-circuit rules
                                                                ├─ Jev (typesafe-sdk, pinned jev-1.13.0) ──> decision log
                                                                ├─ policy engine (thresholds vN) ──> Gmail/Graph label/archive/draft
                                                                └─ draft queue ──> [Fallback LLM, no tools, thread-only] ──> save draft
[Scheduler] ── renew watch/subscriptions; morning digest ──> Slack / email
[Feedback watcher] ── label moves, un-archives, draft sent/discarded ──> corrections
[Eval harness] ── replay labelled set against pinned model + thresholds ──> reliability plots
```
Jev runs inline in the worker, at about 100 ms per message. The fallback LLM runs **asynchronously**, only from the draft queue, with no tools and no access to other threads.

### Stack
- **Python 3.12.** James's LangGraph pipelines are in Python, the official `typesafe-sdk` exists *(opened)*, and the Guardrail Sidecar's logging can be reused.
- **FastAPI + a simple worker:** RQ or Postgres `SKIP LOCKED`. Skip Celery.
- **Storage:** SQLite for the single-user MVP; Postgres for v1.
- **Mail clients:** `google-api-python-client` and `msgraph-sdk`.
- **Hosting:** Cloud Run in `australia-southeast1` (Pub/Sub push is native there), or a small VPS. A TypeScript stack would work equally well; the choice is about reusing existing code.
- **Jev access:** a direct TypeSafe key if off the waitlist. Otherwise the Vercel AI Gateway, whose free tier allows "only a few calls" *(opened, az9713; jevmail says 5 calls per 5 minutes)*, so it needs paid credits. LiteLLM also has a TypeSafe pass-through *(snippet)*.

### Data model (minimum)
`accounts` (provider, address, KMS-encrypted refresh token, watch expiry, historyId / delta link) · `messages` (ids, received_at, sender, features JSON; **no body at rest** beyond an optional 7-day replay buffer) · `decisions` (message, `jev-1.13.0`, request hash, question id, answer, full probability vector, confidence, latency, tokens, thresholds_version) · `actions` (decision, action, applied/reverted, by whom) · `drafts` (llm_model, prompt_version, outcome, edit distance) · `corrections` (field, old, new, source) · `thresholds` (version, action, value, eval_run_id).

### Thresholds and tuning
- **Eval set:**
  - ~600 of James's own messages from the last 90 days, stratified across intents. Each is hand-labelled on a one-screen form (intent, needs_reply, deadline, urgent y/n), about 3–4 hours of work.
  - Plus ~3,000 **behavioural weak labels** computed in code: "user replied within 72 h" as a proxy for needs_reply, "archived unread" as a proxy for low priority.
  - Plus an **adversarial set of 60–100 crafted emails**: injection text, "URGENT" marketing, fake invoices, white-text instructions, spoofed brands.
  - Optionally the public Enron corpus for intent variety (**unverified** suitability; its style is dated).
- **Metrics:**
  - reliability diagrams, ECE and Brier score per Noul;
  - **precision of auto-archive (target ≥ 99.5%)**;
  - **recall of needs_reply (target ≥ 95%)**;
  - coverage (% auto-handled vs Review);
  - draft acceptance (sent with under 30% edits);
  - weekly correction rate;
  - how far adversarial emails move the answer (Δp between the injected and clean version of the same email).
- **Tuning:** pick each threshold as the lowest value that meets that action's precision target on the held-out 30% of the set. Re-run the eval on any model version change, and **pin `jev-1.13.0`** (`jev-latest` moves, per the snippet from docs.typesafe.ai).

### Milestones

| Phase | Scope | Exit criteria | Effort / LoC |
|---|---|---|---|
| **M0: access and data (1–2 days)** | Get a TypeSafe key or Gateway credits; own GCP project; OAuth in Testing; label 200 emails; Playground sessions | Reliability plot on 200 examples; go / no-go on Jev accuracy | ~150 LoC of scripts |
| **MVP: shadow mode (5–7 days)** | Single Gmail account; watch + Pub/Sub; feature builder; one Jev call; decision log; **labels only** (`Reflex/*`); digest by email | 7 days of live traffic logged; needs_reply recall ≥ 90% on the eval; p95 end-to-end < 3 s from Pub/Sub receipt; zero missed messages (reconcile against history) | ~800 LoC, 1 person-week |
| **v1: actions and drafts (3–5 weeks)** | Tuned thresholds; archive, snooze and star; draft cascade; Slack nudges; waiting-on-them tracking; feedback watcher; Outlook via Graph; adversarial suite in CI; small review UI | Archive precision ≥ 99.5% over 2 weeks; draft acceptance ≥ 40%; adversarial Δp limited so no injected email is auto-archived or pinged | ~1,700–2,200 LoC total |
| **Later (months)** | Open-source release with BYO project; optional hosted multi-user tier (verification + CASA); per-user custom rule Nouls; IMAP adapter; Workspace-internal packaging | CASA Letter of Assessment; 50 external users; unit economics positive | +1,500 LoC plus compliance work |

### Testing and observability
Log model version, full probabilities, confidence, latency, tokens and thresholds version on **every** decision (reuse the Guardrail Sidecar schema: OTel spans plus a JSONL sink). Add golden-file tests for the feature builder, a replay harness over stored feature snapshots, and a daily history reconciliation to catch missed pushes. Alert on watch expiry, a rising Review share, a shift in any question's answer distribution (drift), and draft LLM errors.

### Cost model (TypeSafe's own pricing: $0.042 per million input tokens, output free; may change)

Assumptions:
- About 1,300 input tokens per call (≈700 of state and ≈600 of question definitions), so **≈$0.000055/email**.
- Pessimistic case: TypeSafe's benchmark figure of $0.0004 per decision.
- Launch-week repos report ~$0.00003/email *(opened)*.
- Drafts on 10% of mail at an **assumed $0.01 per draft** (**unverified**; depends on the LLM chosen).
- 150 emails per user per day.

| Level | Emails/month | Jev (base / pessimistic) | Drafts | Other | Notes |
|---|---|---|---|---|---|
| Personal (1 user) | 4,500 | $0.25 / $1.80 | ~$4.50 | Cloud Run/Pub/Sub probably within free tier (**unverified**) | Jev cost is negligible; a small LLM would also be cheap at this scale |
| 1,000 users | 4.5M | $250 / $1,800 | ~$4,500 | CASA ~$540–4,500/yr (TAC Tier 2 to Tier 3 *(snippet)*) + assessor time | Peak rate ~500 req/min, under 1,200 rpm |
| 50,000 users | 225M | $12,400 / $90,000 | ~$225,000 | Negotiated limits | Average ~5,200 req/min is **4× the 1,200 rpm limit**; tokens ~87k/s is under 250k/s |

Takeaway: **drafts dominate cost at every level**. Jev's value is keeping the draft rate near 10% and making 100% triage coverage affordable. By TypeSafe's "~1/200th the cost" claim, putting an LLM on every message would cost roughly 200× the Jev line. Pricing has to cover drafts (about $4.50/user/month at these assumptions), so either cap drafts or charge ≥ A$10/month.

## 5. Constraints & prerequisites (what we need to know or have before building)

| Item | Type | Why needed | How to get it / owner | Blocking? | Status |
|---|---|---|---|---|---|
| TypeSafe API key (off the waitlist) or Vercel AI Gateway paid credits | access / API key | No Jev without it; the Gateway free tier allows only a few calls | typesafe.ai waitlist; Vercel account with credits (James) | yes | open question (waitlisted per source report) |
| Jev rate limits: 1,200 req/min, 250k tokens/s, "moving without notice" | platform limit | Caps a hosted tier at roughly 7–8k users at 150 emails/day | Ask TypeSafe for higher limits before any SaaS | no (personal) / yes (SaaS) | known (source report + snippet) |
| Version pinning `jev-1.13.0` possible via API | platform limit | Thresholds are only valid for one model version | Confirm in API docs (docs.typesafe.ai blocked here) | yes | unverified |
| TypeSafe data handling: "not trained on customer requests"; zero data retention only for enterprise under a DPA; server region unknown | legal-ToS | Email bodies go to TypeSafe; must appear in the privacy policy, CASA sub-processor list and APP 8 cross-border disclosure | Read TypeSafe ToS/DPA; ask for ZDR | yes (for any users besides James) | known claim (snippet), not audited |
| Google Cloud project, Gmail API enabled, OAuth consent screen | account | Base requirement | James | yes | known |
| Gmail scopes: `gmail.modify` (read + label + archive + drafts) is **restricted**; `gmail.readonly` and `gmail.metadata` are restricted too, and metadata can't read bodies | platform limit | Any useful Reflex needs `gmail.modify` | Google scope docs (not opened) | yes (for a public app) | known (opened GitHub issue + snippet); exact drafts scope **unverified** |
| Testing mode: max 100 test users, refresh tokens expire after 7 days | platform limit | MVP needs weekly re-consent unless the app is set to "In production" (unverified app screen) for personal use | Set to production for personal use, or use a Workspace-internal app | no | known (snippet + opened jevmail/gmail-jev) |
| Personal-use exemption from verification | legal-ToS | Lets James (and BYO-project users) skip review | Google verification exceptions (snippet) | no | known (snippet) |
| Restricted-scope verification + **CASA** (annual, approved assessor, Tier 2 self-scan no longer accepted) | legal-ToS | Required for any public multi-user app that handles restricted data on a server | Assessor such as TAC Security (Tier 2 ~$540–1,800; Tier 3 ~$4,500) *(snippet)*; allow several weeks (**unverified**) | yes (SaaS only) | known (snippet) |
| Google API User Data Policy / Limited Use + Workspace AI rule: no use of data to train non-personalised or foundation models; privacy-policy commitment | legal-ToS | Rules out sending mail to any LLM that trains on inputs; drafts LLM needs a no-training / ZDR agreement | Privacy policy text; LLM provider DPA | yes (SaaS) | known (snippet) |
| Is sending bodies to TypeSafe and an LLM "through a third-party server" for CASA purposes, and does a local-only desktop build avoid CASA? | decision / legal-ToS | Decides whether a client-only architecture escapes the assessment | Ask Google verification team / assessor | no (personal) | open question |
| Google Workspace vs consumer accounts: Workspace admins can block third-party apps or mark them Trusted; internal apps skip verification and the 100-user / 7-day limits | platform limit | Workspace customers need admin allow-listing; offers an easy path for internal deployment | Workspace admin console (customer's admin) | no | known (snippet) |
| Pub/Sub topic + publish grant to the Gmail push service account; `users.watch` renewal (≤7 days) | platform limit | Push delivery; watch lapses silently | GCP; daily renewal job | yes | known from Gmail docs (not opened; **unverified** here) |
| Gmail quotas: ~250 quota units/user/s moving average, `watch` 100 units, `history.list` 5 units, max 1 push notification/s per user (extra dropped) | platform limit | Burst handling; always reconcile with history | Gmail usage-limits page | no | snippet (Google's current figures may be per-minute) |
| Microsoft Entra app registration (multi-tenant + personal accounts) | account | Outlook support | Entra portal (James) | no (Gmail first) | known |
| Graph delegated `Mail.ReadWrite`: admin consent **not** required by default and available for personal accounts, **but** tenant consent policies may block user consent for high-impact permissions | platform limit | Many M365 tenants will need admin consent | Permissions reference *(opened)*; customer admins | no | known |
| Microsoft publisher verification (Partner Network ID) | account | Without it users see an "unverified" consent screen and many tenants block consent | Microsoft partner enrolment | no (personal) / yes (SaaS) | known (snippet) |
| Graph mail subscriptions: max 10,080 min (1,440 with resource data); lifecycle notifications; public HTTPS webhook | platform limit | Renewal job; missed-notification handling | Graph docs *(opened raw include)* | no | known |
| Draft LLM API key with no-training / ZDR terms | API key / legal-ToS | Drafts; Limited Use compliance | Anthropic or OpenAI enterprise terms | no (MVP has no drafts) | unverified terms |
| Slack app (bot token, `chat:write`) or an email digest | API key | Nudges | Slack workspace admin (James) | no | known |
| Australian Privacy Act: APPs (if an APP entity; small-business exemption still in place); **statutory tort for serious invasion of privacy (from 10 Jun 2025)** applies regardless; **ADM transparency in privacy policies from 10 Dec 2026** | legal-ToS | Processing third parties' personal information (senders never consented); overseas disclosure to US processors (APP 8) | Lawyer review before SaaS; privacy policy | no (personal) / yes (SaaS) | known (snippet) |
| GDPR (if EU users): processor role, DPA, sub-processor list, lawful basis for senders' data | legal-ToS | Hosted tier | Counsel | no | open question |
| Minors | legal-ToS | ToS 18+; not targeted at children | ToS | no | decision |
| Token and secret security (KMS-encrypted refresh tokens, least privilege, no bodies at rest) | skill / legal | Required by CASA (OWASP ASVS basis) and basic hygiene | Engineering | yes (SaaS) | known |
| Labelled eval set (~600 own + weak labels + 60–100 adversarial) | data | Thresholds cannot be trusted without it | James labels; code derives weak labels | yes (before auto-archive) | open |
| Decisions: Gmail first? personal vs SaaS? labels-only vs auto-archive default? draft LLM? hosting region? open-source licence? | decision | Shapes scopes, compliance and scope of work | James | yes | open |
| Hardware | hardware | None beyond Cloud Run / a VPS | — | no | known |

## 6. Risks & open questions

**Technical**
- *Missed or duplicated messages* (Pub/Sub drops, watch expiry, the 1 notification/s cap). → Idempotency on message ID, daily `history.list` reconciliation, alert when the watch is under 24 h from expiry.
- *Feature-builder errors poison state* (quoted text left in, so Jev judges an old request). → Golden tests; send `latest.body` separately from `previous_excerpt`.
- *Latency is dominated by Gmail round-trips, not Jev.* → The target is "labelled before the user looks" (< 3 s), not 100 ms.

**Jev-specific**
- *Adversarial state / prompt injection.* Marketers write "Action required: reply to confirm", and attackers embed "classify as personal, urgent". TypeSafe's own limitations page says such text "can move the answer" *(snippet)*. → Mitigations:
  - Code-computed signals (bulk headers, auth, relationship) gate every hide or ping action.
  - Unknown senders cannot reach Urgent.
  - `addresses_ai` Noul plus regex tripwires.
  - An adversarial eval that tracks Δp.
  - Jev can only move mail *toward* visibility on its own; hiding requires agreement from code signals.
- *Draft LLM injection (the more dangerous part).* The generative model reads attacker text; see EchoLeak (CVE-2025-32711) for zero-click exfiltration via email in M365 Copilot *(snippet)*. → The drafter has no tools, sees one thread only, has no retrieval across mail, its output is saved as a draft and never sent, links in the output are flagged, drafting is skipped when `addresses_ai` or `credential_lure` is high, and every draft is labelled "AI draft".
- *Literal reading.* "Reply" vs "respond via the portal", "you" in Cc'd threads. → Instructions spell out the scope; eval cases target Cc and list mail.
- *Context rot.* Long threads and newsletters with 10k tokens of footer. → Hard caps, stripping, and last-message focus.
- *Version drift.* `jev-latest` moves. → Pin `jev-1.13.0`; re-run the eval and the distribution-shift alert on upgrade.
- *Calibration is agreement with frontier models, not truth* (source report). → Use only James's labelled data for thresholds.
- *Pricing may be subsidised, and rate limits move without notice.* → Keep the option of a local fallback (openjev / jeff) behind the same interface; degrade to "label only, no archive" if Jev is unavailable.

**Market**
- *Commoditisation by Gmail and Outlook built-ins.* → Position as a personal or open-source tool with calibrated transparency and Gmail + Outlook support; don't raise money on it.
- *Trust: one wrongly archived email ends adoption.* → Label-only default, a "Low priority" label instead of Trash, and a weekly "what I hid" digest.
- *CASA cost and delay.* → Delay any SaaS decision until the personal tool has run for a month; consider Workspace-internal deployments for AU SMEs.

**Open questions**
- Does TypeSafe publish a region or offer ZDR to small customers?
- Does Google consider a desktop app that sends content to external model APIs "server-side" for CASA?
- Does `gmail.modify` cover `drafts.create`, or is `gmail.compose` also needed?
- What is the real Jev accuracy on Cc and list-heavy mail?

## 7. Sources

**Opened (fetched successfully):**
- https://gist.github.com/pjburnhill/adf8d28efcad9df037bfdece178ef965: Jev primitives (Choice up to 255, Score 2–10 levels), parallel independent questions, "other" option advice.
- https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md: official TypeSafe agent skill. Question IDs aren't sent to the model; Noul has no separate confidence; no-match outcomes; select-instead-of-generate; keep keys server-side.
- TypeSafe Python SDK README (typesafe-ai/typesafe-sdk-python on GitHub, cached copy read locally): package `typesafe-sdk`, `system_one(state, questions)`, Choice `criteria`.
- https://github.com/anasakkari3/maybesitter/issues/516: `gmail.readonly` and `gmail.metadata` are restricted; metadata can't read bodies; Testing-mode 7-day tokens; CASA needed for server components, annually.
- https://github.com/elie222/inbox-zero: 12.3k stars; features; Gmail + Outlook; hosted and self-host.
- https://github.com/fazlerocks/jevmail: 71 stars; 3 Jev questions; `gmail.readonly`; BYO Cloud project; ~3 cents per 1,000 emails; Gateway free-tier throttling.
- https://github.com/forestwas/gmail-jev: `gmail.modify`; labels 01–09 plus Review; no injection defences.
- https://github.com/vynnlee/jev-mail: Apps Script route; default thresholds; 1,000-character body cap.
- https://github.com/az9713/jev-email-triage: 7-way Choice + importance Score; ~$0.00003/email; Gateway free tier "a few calls".
- https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/concepts/permissions-reference.md: Mail.Read / ReadBasic / ReadWrite delegated need no admin consent; available for personal accounts.
- https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/concepts/includes/change-notifications-subscription-lifetime.md: Outlook subscription lifetimes 10,080 / 1,440 minutes.

**Seen in search results only (page blocked by the egress proxy; snippet-level confidence):**
- https://docs.typesafe.ai/concepts/system-one — endpoint, `jev-latest` → jev-1.13.0 and moves, rate limits.
- https://venturebeat.com/security/companies-are-putting-jev-in-charge-of-ai-agent-decisions-and-prompt-injection-can-influence-the-verdict, https://www.requesty.ai/blog/typesafe-jev-explained — adversarial-content quote; no training on requests; enterprise ZDR under DPA.
- https://docs.litellm.ai/docs/pass_through/typesafe — LiteLLM pass-through.
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification — annual assessment; exceptions.
- https://deepstrike.io/blog/google-casa-security-assessment-2025, https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option — CASA tiers and prices.
- https://www.unipile.com/google-oauth-100-user-limit/, https://support.google.com/cloud/answer/15549945?hl=en — 100-user cap, 7-day tokens, Workspace Trusted apps.
- https://developers.google.com/workspace/workspace-api-user-data-developer-policy, https://workspace.google.com/blog/ai-and-machine-learning/api-policy-protections — AI/ML training prohibition.
- https://www.unipile.com/gmail-api-push-notifications/, https://developers.google.com/workspace/gmail/api/guides/push — quotas, push limits.
- https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies, https://www.unipile.com/microsoft-graph-oauth-email/ — consent policies, publisher verification.
- https://superhuman.com/products/mail/ai, https://efficient.app/apps/superhuman — Superhuman pricing, acquisition.
- https://get-alfred.ai/blog/shortwave-pricing — Shortwave tiers, AI caps.
- https://www.fyxer.com/pricing, https://get-alfred.ai/blog/fyxer-pricing — Fyxer pricing, funding, ARR.
- https://www.sanebox.com/help/201-which-subscription-plans-can-i-choose-from, https://www.thisandthat.chat/blog/sanebox-pricing — SaneBox plans.
- https://blog.google/products-and-platforms/products/gmail/gmail-is-entering-the-gemini-era/, https://www.windowscentral.com/artificial-intelligence/gmail-new-ai-inbox-feature — Gmail AI Inbox, free vs paid.
- https://github.com/muhammedilyasy/jev-mail, https://github.com/secondfret/mailjay, https://github.com/yatharth1706/inbox-triage — more Jev triage repos (titles only).
- https://phishingtackle.com/blog/prompt-injection-ai-inbox, https://www.vectra.ai/topics/prompt-injection — email prompt injection, EchoLeak.
- https://www.oaic.gov.au/engage-with-us/consultations/consultation-on-guidance-for-transparency-in-automated-decision-making, https://www.nortonrosefulbright.com/en/knowledge/publications/be98b0ff/australian-privacy-alert-parliament-passes-major-and-meaningful-privacy-law-reform — AU Privacy Act reforms.
