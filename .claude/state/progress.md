# Progress / handoff log (READ THIS to continue work)

> Updated by the orchestrator every cycle. This is how any agent resumes cold.

## Current status
- Feature in flight: **none**. Shipped + accepted this session: **contact durability**
  (#3/#4/#5) and **chat turn-persistence** (#7; #8 timeout-row — 28s/55s cap clause open).
  Active layer: app · phase: **off**.
- Harness: **team-tactics 0.8.0** (teamentic 0.5.0 → 0.7.0 → 0.8.0). selftest 13/13; tic
  protocol live (auto-handoff SubagentStop hook; `.claude/state/tics.jsonl`, gitignored).
- Suites: **app `node --test` 23/23** · **chat pytest 75/75** green.
- **Deployed to STAGING (2026-06-04):** merged this branch → `agent` (`514f938`, conflict-free,
  staging API URLs preserved) and pushed `origin/agent` → Amplify staging build;
  `chat.marwanelgendy.link` reachable. See `releases.md`. ⚠ Amplify deploys the static FRONTEND
  only (unchanged by this work, which is backend/tests/docs/harness); the refactored contact
  Lambdas reach staging only via a SEPARATE `integrate-and-deploy.sh stage` / `workflow_dispatch`.
- Commits on `claude/compassionate-dubinsky-de3583` (8 this session): harness/ADRs/invariants ·
  CI · contact · state · kit 0.7.0 · chat tests · chat state · kit 0.8.0 (`cb2317b`).
- Next backlog item: chat fallback on first-chunk rate-limit (#9), then voice timbre (#10),
  then frontend guards (#1/#2).

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
