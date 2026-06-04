# Progress / handoff log (READ THIS to continue work)

> Updated by the orchestrator every cycle. This is how any agent resumes cold.

## Current status
- Feature in flight: **none** — **contact durability (items 2–4) SHIPPED + accepted**
  (product-owner sign-off 2026-06-03; tdd-critic = PASS). Both contact Lambdas extracted to
  injectable cores behind thin composition roots; invariants **#3/#4/#5 now PROVEN**.
- Active layer: app · Current phase: **off** (milestone boundary, no active TDD cycle).
- Suite now: **app `node --test` 23/23 green** · chat 70/70 green. Floor: `node --test`.
- NOT committed/deployed yet: the worktree holds all bootstrap + feature changes uncommitted
  (awaiting navigator's commit decision). Deploying the refactored Lambdas is a SEPARATE
  release decision — behavior is unchanged by design (ADR-0006), so it can ride the next deploy.
- Next feature (top of backlog "Next up"): **chat coverage gaps** (items 1–4, `[chat]` layer —
  switch `.claude/state/layer` to `chat`).

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
