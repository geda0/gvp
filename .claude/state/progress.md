# Progress / handoff log (READ THIS to continue work)

> Updated by the orchestrator every cycle. This is how any agent resumes cold.

## Current status
- **2026-06-17 — MILESTONE "Pre-prod hardening → stage" IN FLIGHT.** Goal: TDD-fix all confirmed
  pre-prod review findings, then deploy `agent`→staging (NOT prod). 37-agent adversarial review of the
  22-commit `agent`→`main` diff found 28 confirmed issues; the only 2 "blockers" are ONE promotion-procedure
  hazard (staging API hosts → Amplify, no guard — see memory `prod-promotion-procedure`), rest medium/low.
  Planned: product-owner backlog (`.claude/state/backlog.md`) + 3 decisions (`design-notes.md`); architect
  **ADR-0008** (HMAC ipHash pepper + consent gate) + **ADR-0009** (amplify guard / DLQ-alarm / abuse / DR /
  cron); planner **31-slice queue in `plan.md`** (P0 S1–S7+S31, P1 S8–S20, P2 S21–S29; S30 per-IP WAF DEFERRED).
  **CODE-COMPLETE + browser-verified (2026-06-17): app `node --test` 120/0/1, chat (.venv) pytest 102/0, gate RE-ARMED.**
  All 31 slices done except S16 (AWS Budget = owner runbook/account-level per ADR-0009) and S30 (per-IP WAF = ADR-deferred).
  Parallel-track workflow landed the gated batch under a navigator-authorized SECURITY_GLOB disarm window (re-armed after).
  Integration-closure batch wired the connective tissue: FE MAX_BUFFER→25; contact-daily-report uses x-smoke-key+report=1
  + day-derived Idempotency-Key; SAM params/env IpHashPepper(IP_HASH_PEPPER) + SmokeProbeKey(SMOKE_PROBE_KEY) across
  template.yaml + chat-template.yaml + deploy seeding. tdd-critic = CONCERNS→addressed (3 loose text-guards tightened;
  security behaviors genuinely proven). FE qa-manual browser-verified: consent banner (first-visit→accept persists+inits GA,
  no reappear, 0 console errors), admin avgFirstToken relabels, admin x-smoke-key probe field (deep btn disabled w/o key).
  **REMAINING = the stage DEPLOY only**, gated on TWO owner actions: provide `IP_HASH_PEPPER` + `SMOKE_PROBE_KEY` secret
  values for staging (else those features deploy INERT: ipHash='' / smoke locked), and confirm the outward push (agent→
  staging CI + Amplify). Then qa-verifier E2E on staging. Detail of the earlier slices ↓.
  ---
  **Done so far (suite 93/0/1):** kit→**0.61.0** (gate re-verified 8/8). **ipHash track** S1/S2/S3 + S3b —
  `hashIp(ip,pepper)` HMAC-SHA256-keyed, returns `''` (never reversible unkeyed) when no pepper; events + contact
  callers thread `process.env.IP_HASH_PEPPER` and hash the leftmost XFF client IP (contact dedupes-match events).
  **Consent gate** S4/S5 — `js/consent.js` `hasAnalyticsConsent()` default-deny; `flushEvents()` buffer-preserves
  when denied, `initAnalytics()` skips `gtag('config')` when denied. **tdd-critic = PASS-with-1-gap** (the contact
  end-to-end coverage gap; closed via S3b). Active layer **app** · phase **off** (clean boundary).
  **RESUME at remaining P0:** S7 (DailyReport+ContactFailureReport Errors alarm — `aws/template.yaml`, GATED → run
  under `SECURITY_REVIEW=1`, cleared by ADR-0009), S31 (`amplify.yml` env-guard, CI — per-app `GVP_EXPECTED_ENV`),
  S6 (consent banner UX — qa-verifier/browser). Then P1 (S8–S20) + P2 (S21–S29; S30 deferred). NEEDED before P1
  gated slices: architect clearance addendum for events-ingress-core / resend.js / report-queries-core / chat main.py
  (planner flagged — not ADR-cleared yet). Owner deploy-time actions: `IP_HASH_PEPPER` secret + per-Amplify-app
  `GVP_EXPECTED_ENV`. Earlier reporting-feature history below ↓.
- **2026-06-16 — ttics reinstall recovered + reporting fixes (app layer).** A fresh Cursor 0.56.0
  reinstall had reset the data files to stubs; restored backlog/progress/invariants/releases/plan/
  design-notes from `main` and merged `tdd.config` (LAYERS="app chat", `node --test`, chat pytest layer;
  kept the new 0.56 knobs). Then fixed the new **reporting** feature via the red→green loop: #1 chat
  day-bucketing (`aggregateChat` buckets each turn by its TRUE UTC day from `capturedAt`/`utcDayOf`;
  `queryDay` now half-open via the shared `utcDayBounds` + `lookbackDays:1`, wired into both report
  consumers), #2 BatchWrite **UnprocessedItems** drain (`persistEventRows` extracted, tested, wired),
  plus HTML-escaping + queryDay-pagination regression tests. Suites GREEN: **app `node --test` 74 pass /
  1 skip · chat pytest 91**. tdd-critic = CONCERNS, top one addressed (UTC parse). Backlogged follow-ups:
  handler-level look-back test (needs ddb injection), `capturedAt`-less fallback-day test, and the
  security/infra hardening tail (WAF/per-IP rate limit, body-size cap, HMAC IP hash, DailyReport DLQ/alarm,
  dual-cron consolidation, idempotency). Active layer: **app** · phase: **off**.
- Feature in flight: **none**. **ALL TEN INVARIANTS NOW FULLY PROVEN** — the last open clause
  (#8's 55s API-Gateway cap) shipped 2026-06-04, plus two contact-core tdd-critic pins (Obs A
  `markSending` order, Obs C enqueued `idempotencyKey`) and the #7 non-stream-OK cell
  (`turn['status']=='ok'`, closing the milestone tdd-critic finding). Active layer: **app** ·
  phase: **off**.
- Harness: **team-tactics 0.32.0** (`--preset full-team`; refreshed 2026-06-06 via
  `npx github:geda0/team-tactics@latest update --preset full-team`). selftest **15/15**; tic
  protocol live; `docs/tdd/tool-support.md` present.
- Suites: **app `node --test` 43 pass / 1 skipped (44 total)** · **chat pytest 86/86** (last recorded).
- tdd-critic milestone audit = **PASS-on-substance** (all pins honest/RED-capable). Two CONCERNS
  were pre-existing soft spots: #7 ok-cell (now CLOSED) and #10 coupling/allowlist (OPTIONAL,
  backlogged). Plus a minor non-blocking note: pin-1 order could deep-equal the full call sequence.
- **DEPLOYED to STAGING + PROD (2026-06-06), both GREEN.** Team Tactics contact CTA promoted
  agent→main (`d9ce997`) with prod API metas preserved. Staging deploy `27051135017` · prod deploy
  `27051407724`. Amplify: `agent`→chat.marwanelgendy.link · `main`→www.marwanelgendy.link.
  ⚠ CI actions on Node20 (GitHub deprecation 2026-06-16).
- Next backlog: only the LOW-priority / OPTIONAL tdd-critic hardening tail remains (#9 cross-turn
  fallback-first + `last_model_id`; OPTIONAL #10 voice allowlist + preset/cadence coupling). None
  blocks an invariant. Reasonable checkpoint with the navigator on whether to grind these or stop.

## Bootstrap deliverables (done this session)
- **Harness:** `.claude/tdd.config` now has TWO layers — `app` (node:test over
  js/ scripts/ aws/) and `chat` (pytest over docker/chat/app). resolve_layer + globs
  verified.
- **Architecture:** `docs/decisions/ADR-0001..0005` (single-origin proxy is LOCAL-ONLY;
  split chat hosting; Gemini Live timbre lock = `Charon`; contact durability; two-layer
  harness). ADR-0005 flags `tdd-verify.yml` as broken scaffold.
- **Invariants:** `docs/tdd/project-invariants.md` — 10 load-bearing invariants, each
  cited to file:line. **Only #6 (reduced motion) is proven today**; #1–#5,#7–#10 are
  UNPROVEN and drive the backlog.
- **Backlog:** `.claude/state/backlog.md` — 11 prioritized items (CI → contact
  durability → chat coverage gaps → frontend guards → cleanup), with a per-invariant
  coverage audit of the existing 70-test pytest suite.

## Open navigator decisions (block nothing but item framing)
- (a) Confirm the single-origin **reframing** of invariant #2 (production is cross-origin
  via CORS; same-origin `/api/*` is local-dev only). Default: accept.
- (b) `tdd-verify.yml`: repurpose-in-place vs delete-and-fold. Default: repurpose. Item 1
  acceptance is identical either way.

## How to resume
1. Read AGENTS.md, then this file, then state/backlog.md + design-notes.md + the ADRs.
2. Run BOTH layer suites for ground truth (commands above).
3. Build the top "Next up" backlog item via the red→green loop: set
   `.claude/state/{layer,phase}`, planner → ordered slices in plan.md, then
   red→test-writer / green→implementer; tdd-critic every ~3 cycles.

## Cycle log (newest first)
- 2026-06-06 — **PRODUCTION release: Team Tactics contact CTA.** Merged `origin/agent` → `main`
  (`d9ce997`), prod API metas kept (`index.html`/`admin` staging hosts rejected). deploy-prod run
  `27051407724` GREEN. qa-verifier PASS on staging before promote; navigator confirmed prod path.
  Recorded in `releases.md`.
- 2026-06-06 — **SHIPPED Team Tactics contact CTA** (`[app]`). Private repo: `link` → `#contact`,
  `linkText` → **Request access**, `contactPrefill` with subject/message. [`js/project-link.js`](js/project-link.js)
  + [`js/projects.js`](js/projects.js) closes project dialog and lazy-opens contact form on CTA click.
  Guards in `test/team-tactics-project.test.mjs`. `chatSummary` on team-tactics + ai-assistant
  prevents rebuild regression. app 43 pass / 1 skipped; tdd-critic PASS; product-owner ACCEPTED.
  **Committed** `0f4ab64` (product) · harness `46d938a`. **Pushed** to `origin/agent`
  2026-06-06; CI deploy-staging run 27051135017 GREEN.
- 2026-06-06 — **Adopted team-tactics 0.32.0 (full-team preset).** Ran
  `npx github:geda0/team-tactics@latest update --preset full-team` — already on 0.32.0; refreshed
  mechanism files + merged settings hooks; data preserved (`tdd.config`, invariants, state).
  validate OK (app + chat layers). selftest **15/15**; app **36/36**. Manifest timestamp only in
  git diff unless uncommitted kit files differ from HEAD.
- 2026-06-04 — **FEATURE: enhance project dialog text** (phase `off`). Root cause: dialog used
  regex-stripped `textContent` (blob + literal `&ldquo;`). Now renders trusted HTML via
  `innerHTML`; `htmlToPlainText` for card/spaceman plain paths. CSS: paragraph spacing, section
  labels from `<strong>`, code + list styling. Cleaned entities in `projects.json`; chat
  `stripHtml` decodes entities. `test/project-description-format.test.mjs`. app 34/34.
- 2026-06-04 — **FEATURE: Team Tactics featured on website** (phase `off`). Polished playground
  entry (`label: Open kit`, tighter card + dialog copy, ties to this repo). Rebuilt
  `team-tactics.svg` for card-scale legibility (title, tic bus, hooks, orchestrator, agents;
  XML entities for arrows). `test/team-tactics-project.test.mjs` pins featured id + clean SVG.
  Regenerated chat-knowledge. app 32/32. Not yet committed.
- 2026-06-04 — **SHIPPED frontend bundle guards (#1 + #2)** — formal close. Acceptance mapped:
  invariant **#1** ← `test/frontend-no-secrets.test.mjs` (bundle scan + index/admin meta/GA);
  invariant **#2** ← `test/frontend-api-config.test.mjs` (no remote hosts in `js/`, site-config
  imports/fallbacks, session `websocketUrl`). app **30/30**; tdd-critic **PASS** (behavior-level
  characterization, green-on-write). Invariants #1/#2 → PROVEN. Not yet committed.
- 2026-06-04 — **Adopted team-tactics 0.9.2 + SHIPPED chat voice-timbre lock (#10).** 0.9.2 (tagged
  `v0.9.2`) adds enforced write-claims to guard-edit-scope (P1 sectioning) — gated + NO-OP without a
  `.claude/state/scope` file, so the gate is unchanged here (selftest 13/13); committed `66c08e6`.
  Then ran the chat red→green loop for **#10**: planner sliced S1–S4 (pure functions); test-writer
  added 4 characterization tests to `docker/chat/tests/test_live_voice_timbre.py` (default→Charon,
  override honored, connect-config prebuilt voice, cadence directive) — all green-on-write (lock
  pre-existed, ADR-0003). chat 80→84. tdd-critic PASS-on-substance (2 by-design advisories →
  optional follow-ups); product-owner accepted → Shipped; invariant **#10 PROVEN**. **Milestone:
  all chat-layer invariants proven; remaining = #1/#2 (`[app]` frontend guards) + #8 cap.** Not yet
  committed (this feature).
- 2026-06-04 — **Adopted team-tactics 0.9.0 + SHIPPED chat model fallback (#9).** 0.9.0 (untagged
  on main; navigator pushed `v0.9.0` @ `6073ec1`) adds divide-and-conquer + sectioning docs +
  local `tics` viewer; gate unchanged (selftest 13/13); committed `dfece9f`. Then ran the chat
  red→green loop for **#9** (model fallback): planner sliced S1–S5; test-writer added 5
  characterization tests to `docker/chat/tests/test_gemini_routing.py` (astream + ainvoke
  rate-limit→fallback, committed-midstream propagation, non-rate-limit-not-retried, distinct-model
  guard) — all green-on-write (logic pre-existed). Seam: construct `GeminiRoutingChain` directly +
  class-level `_build_chain` monkeypatch (chain has `__slots__`), assert routed-output/propagation
  (not call counts). chat 75→80. tdd-critic = PASS; product-owner accepted → Shipped; invariant
  **#9 PROVEN**. Follow-ups filed (cross-turn fallback-first persistence; `last_model_id`). Not
  yet committed (this feature).
- 2026-06-04 — **PRODUCTION DEPLOY — GREEN.** Per navigator (Go, full prod deploy), gated on a
  staging E2E contact submission (qa-verifier **PASS**: persist→sent in ~2.8s, honeypot no-IO,
  400 on invalid). Built the prod CI pipeline: OIDC role `gvp-prod-ci-deploy` (main-only trust,
  contact-only policy scoped to `page`; no IAM iteration needed — preloaded the staging-learned
  perms), `AWS_DEPLOY_ROLE_ARN_PROD` secret, `deploy-prod.yml` (push→main path-filtered +
  dispatch, test-gated, `integrate-and-deploy.sh prod`). FF-pushed `main` (639eea8→`fda626f`, 16
  commits) → auto-triggered `deploy-prod` run **26938125929** (test ✅ + deploy ✅, 1m23s) +
  Amplify www rebuild. Health: `page` UPDATE_COMPLETE, contact `lwi0vmdpb5` OPTIONS 204 (matches
  FE prod meta), `www.marwanelgendy.link` 200, prod chat ECS `chat-api.marwanelgendy.link` 200
  (untouched). Frontend visually unchanged (work is backend/tooling). 1 staging QA item to clean
  (`cfe4b88e…` in page-staging-ContactMessagesTable).
- 2026-06-04 — **Adopted team-tactics 0.8.5 + DEPLOYED to STAGE (contact-only, GREEN).** 0.8.5 was
  untagged on `main`; navigator pushed `v0.8.5` (commit `7badc88`), then `npx …#v0.8.5 update`:
  tics-view `.js`→`.cjs` (CommonJS) + new `sections.md` context-map seed; gate unchanged (settings
  untouched), selftest 13/13, app 23/23, chat 75/75; committed `63e0a5b`. Merged → `agent`
  (`8f4584c`, staging URLs intact) + pushed. Triggered `deploy-staging` (run **26936642631**):
  **test ✅ + deploy ✅** (55s, CONTACT-ONLY — first run after CHAT_SAM_STACK_NAME removal + IAM
  tighten, so it also verified that config). Health: contact `fvfqpef8kb` OPTIONS 204 (matches FE
  meta), frontend `chat.marwanelgendy.link` 200, ECS chat `chat-api-stage` 200 (untouched).
  Note: CI actions run on Node20 (GitHub deprecation 2026-06-16 — bump action versions later).
- 2026-06-04 — **Adopted team-tactics 0.8.3 + finalized staging CI/CD (contact-only).** 0.8.3 was
  untagged (only on `main`); navigator pushed `v0.8.3` (commit `35a1c6c`), then
  `npx github:geda0/team-tactics#v0.8.3 update`: adds local `tics` viewer CLI
  (`.claude/hooks/tics` + `tics-view.js`) + per-layer tic auto-scope; gate unchanged (settings
  untouched), selftest 13/13, app 23/23, chat 75/75; committed `16b423f`. Then per navigator
  (contact-only CI): removed `CHAT_SAM_STACK_NAME` var, tightened the OIDC role to contact-only,
  and **tore down the orphaned chat** — deleted CFN `gvp-chat-stage` + `*-CompanionStack` + the
  companion ECR repo; **preserved** `gvp-chat` (ECS voice repo), `page-staging`, SAM bucket.
  Final staging CI/CD: push→`agent` → test gate → contact-only `integrate-and-deploy.sh stage`;
  chat stays manual (ECS at `chat-api-stage…`). (IAM ops used ambient root creds — flagged.)
- 2026-06-04 — **Staging CI/CD pipeline COMPLETED + verified GREEN.** Built
  `.github/workflows/deploy-staging.yml` (push→`agent`, path-filtered, test-gated, runs
  `integrate-and-deploy.sh stage`; frontend=Amplify, SYNC=0). Root cause of "not complete": repo
  had 0 secrets/vars (local deploys use ambient AWS creds + `.secrets/`). Seeded 6 secrets + 6
  vars from `.secrets/` (piped, never printed); `CHAT_VOICE_ECS_BOOTSTRAP=0`. Existing OIDC role
  was for `geda0/Based`; created **`gvp-staging-ci-deploy`** (OIDC, trust `repo:geda0/gvp:*`,
  SCOPED policy; dev-ops added 2 in-scope perms: SAM transform changeset + `--resolve-image-repos`
  CompanionStack). Deploy run **26929994505 SUCCESS** (3m29s): contact `page-staging`
  (`fvfqpef8kb…` matches FE meta ✓) + chat Lambda `gvp-chat-stage` (`m7qmz78kb6…`); health 200/204.
  **CAVEAT:** FE chat meta → `chat-api-stage.marwanelgendy.link` (ECS/ALB voice, separate) so the
  CI chat Lambda is orphaned — chat-deploy-via-CI needs a navigator decision (ECS vs Lambda+repoint
  vs contact-only). IAM role created via ambient **root** creds (flagged). See releases.md.
- 2026-06-04 — **Adopted team-tactics 0.8.0 + deployed to STAGING.** `npx github:geda0/team-tactics#v0.8.0
  update` (pinned git tag — NOT `npx tics`, which is an unrelated npm pkg): non-blocking
  `subagent-handoff.sh` SubagentStop hook + scoped/spool tics; referee unchanged (selftest 13/13),
  data preserved; committed `cb2317b`. Then per navigator: merged `claude/compassionate-dubinsky-de3583`
  → `agent` (the Amplify staging-deploy branch) in a throwaway worktree — conflict-free (`514f938`),
  staging URLs preserved (contact `fvfqpef8kb…`, chat `chat-api-stage…`); verified app 23/23 + chat
  75/75 green, then `git push origin agent` (6771384..514f938) → Amplify staging build.
  `chat.marwanelgendy.link` reachable. Recorded in `releases.md`.
- 2026-06-04 — **Chat turn-persistence (items 1–2) SHIPPED** under team-tactics 0.7.0. Ran the
  red→green loop on the `chat` layer: planner sliced S1–S5; test-writer added 5 characterization
  tests (non-stream error/timeout + streaming ok/error/timeout) to
  `docker/chat/tests/test_turn_persistence.py` — all green-on-write (the persistence behavior
  pre-existed in `main.py`; we pinned it). chat 70→75 green. Emitted `delegate` tics per the new
  protocol; hooks logged `signal` tics (`.claude/state/tics.jsonl`). tdd-critic = PASS;
  product-owner accepted → Shipped; invariants #7 PROVEN, #8 timeout-row proven (cap clause
  backlogged). Not yet committed.
- 2026-06-04 — Adopted **team-tactics 0.7.0** (rename from teamentic 0.5.0; adds tic protocol).
  Ran `npx github:geda0/team-tactics#v0.7.0 update` — NOT `npx tics` (that resolves to an
  unrelated npm package `tics@3.x`; team-tactics ships from the git repo only). Refreshed
  mechanism files + AGENTS/CLAUDE/KICKOFF managed blocks; manifest dir `.teamentic`→`.team-tactics`;
  added `tic.sh` + `docs/tics/tic-protocol.md`; `.gitignore` now ignores `tics.jsonl`. Data files
  preserved (configSchema still 2). selftest **13/13 PASS**, suite **23/23**. Committed the whole
  session (bootstrap + contact + kit) as 5 logical commits. Next: chat coverage (items 1–2).
- 2026-06-03 — Contact sender (item 4) + FEATURE ACCEPTANCE: S6–S9 green, 23/23 `node --test`.
  Drove `aws/src/contact-sender-core.js` (success→markSent · skip already-sent/missing ·
  fail→markFailed+rethrow; NO @aws-sdk) red→green; S9 rewrote `contact-sender.js` → thin
  composition root (real Get/Update store + `sendViaResend`, `node --check` OK, reviewed by
  orchestrator). Final tdd-critic = **PASS** (3 non-blocking obs → 2 logged as follow-ups).
  product-owner accepted items 1,2,3,4,11 → Shipped; project-invariants.md #3/#4/#5 → PROVEN.
  **Milestone boundary** — paused for navigator (commit / deploy / continue to chat items).
- 2026-06-03 — Contact ingress (items 2–3): S1–S5 green, 20/20 `node --test`. Drove
  `contact-ingress-core.js` (full handler, NO @aws-sdk) via red→green:
  valid·persist-fail·enqueue-fail·honeypot·honeypot-decoy·parse-400·validate-400·
  missing-env-500·method-gate. Added `test/contact-core-no-aws-sdk.test.mjs` guard. S5
  rewrote `contact-ingress.js` → thin composition root wiring real PutCommand
  (attribute_not_exists) + SQS (node --check OK, behavior identical, reviewed by
  orchestrator). tdd-critic after S4 = PASS on S1–S4; flagged S5-readiness → drove the
  S4a–S4e branch-parity slices. Deferred: core now logs in its catch (could inject a
  logger). Next: sender S6–S9 (inv #5).
- 2026-06-03 — CI fixed (items 1 + 11): dev-ops repurposed `tdd-verify.yml` → `node --test`
  on every push/PR (no install step); chat pytest still gated by
  `docker-compose-chat-ci.yml`; no broken workflow remains. Navigator chose repurpose-in-place.
- 2026-06-03 — Bootstrap: added `chat` pytest layer to tdd.config; recorded green
  baseline (app 10/10 · chat 70/70); architect wrote ADR-0001..0005; product-owner
  wrote project-invariants.md (1/10 proven) + backlog.md (11 items). Phase held `off`
  (doc/config work). Next: navigator sign-off, then fix CI (item 1) + start contact
  durability (item 2).
- (seed) Kit installed. Define the first feature via KICKOFF.md.
