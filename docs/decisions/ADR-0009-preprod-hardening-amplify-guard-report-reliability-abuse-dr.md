# ADR-0009 — Pre-prod hardening: Amplify env-guard, daily-report reliability, per-IP abuse limit, DR policy, cron

## Status

Accepted. Addresses pre-prod review findings **INFRA-1/FE-1** (Amplify env-guard), **INFRA-2**
(daily-report DLQ + alarm), **SEC-3** (per-IP abuse limit), **INFRA-4** (DR policy), and **INFRA-3**
(cron consolidation). These are infra/seam decisions promoting `agent` → STAGE the right way.

This ADR **is the deliberate security review** for the `aws/template.yaml` changes it specifies.
The implementer is cleared to edit `aws/template.yaml` under `SECURITY_REVIEW=1` to the contracts
below — and to nothing beyond them.

## Context

`agent` adds the first-party events pipeline (`SiteEventsTable`, `EventsIngressFunction`,
`DailyReportFunction`) on top of the existing contact stack. The pre-prod review confirmed five
infra gaps that change contracts/seams. None is an externally-exploitable hole for a personal
portfolio, but the owner asked to fix them "the right way" before STAGE. Key code anchors:

- Amplify serves `main`'s committed HTML verbatim; the only env-guard
  (`test/frontend-api-url-env-guard.test.mjs`) runs **only** in the backend workflow
  (`deploy-prod.yml:42-50`), so the **Amplify static pipeline has no gate** and can publish leaked
  staging hosts (the 2026-06-04 incident, hotfixed in 843e648). **No `amplify.yml` exists.**
- `DailyReportFunction` (`aws/template.yaml:267-290`) is a `Schedule` (async) Lambda with **no
  `DeadLetterConfig`/`OnFailure` and no Errors alarm** — a failed daily digest is silent. The chat
  stack already has the pattern: `ChatLambdaErrorsAlarm` (`aws/chat-template.yaml:115-133`).
- `POST /api/events` is unauthenticated with a deliberately high stage throttle (rate 20/burst 40,
  `aws/template.yaml:104-106`); the throttle is **stage-global, not per-IP**, and each request fans
  out to up to `MAX_EVENTS_PER_BATCH=100` BatchWrite rows on a PAY_PER_REQUEST table — a billing-DoS
  amplification with no per-IP ceiling and no budget alarm.
- The three DynamoDB tables (`aws/template.yaml:108-184`) have **no PITR and no
  DeletionPolicy/UpdateReplacePolicy** — a stack delete or replacing update destroys all rows.
- `DailyReportFunction` and the pre-existing `ContactFailureReportFunction` both fire
  `cron(0 12 * * ? *)` (`aws/template.yaml:290,319`) — two emails at the same minute.

## Decision

### INFRA-1/FE-1 — Amplify env-guard (compose with the existing backend guard)

Add an **`amplify.yml`** at the repo root whose `preBuild` runs the existing guard:

```
GVP_EXPECTED_ENV=prod node --test test/frontend-api-url-env-guard.test.mjs
```

**Contract:** the Amplify build **fails closed** (non-zero exit aborts the build, nothing ships) if
`main`'s committed `index.html` / `admin/index.html` carry any non-prod API host. This makes the
*frontend* pipeline enforce the same invariant the backend workflow already enforces — the two are
**independent gates on the same test**, so a leak can no longer slip through whichever pipeline
lacks a gate. The guard remains *detection that now also prevents* on the Amplify side; it does not
change the test or the promotion procedure (still: restore prod meta on `main`, then verify).

This ADR does **not** dictate the rest of `amplify.yml` (build/artifact phases) beyond requiring the
`preBuild` guard command and that a guard failure aborts the build. **Note:** `amplify.yml` is not
under the SECURITY_GLOB; this item needs no `SECURITY_REVIEW`.

### INFRA-2 — DailyReport reliability (mirror the chat alarm pattern)

Add to `aws/template.yaml`, wired to the **existing `ContactAlarmTopic`** (reuse, don't add a new
SNS topic):

- **An Errors CloudWatch alarm on `DailyReportFunction`** — `Namespace: AWS/Lambda`,
  `MetricName: Errors`, `Dimensions: [{ Name: FunctionName, Value: !Ref DailyReportFunction }]`,
  `Statistic: Sum`, `Period: 300`, `EvaluationPeriods: 1`, `Threshold: 1`,
  `ComparisonOperator: GreaterThanOrEqualToThreshold`, `TreatMissingData: notBreaching`,
  `AlarmActions: [!Ref ContactAlarmTopic]`. This mirrors `ChatLambdaErrorsAlarm`.
- **A `DeadLetterConfig`/`EventInvokeConfig` `OnFailure` SQS target** for the function so the failed
  invocation event is captured, not dropped after AWS's 2 async retries.

**Contract:** a failed daily digest becomes observable (alarm email) and recoverable (DLQ),
matching the durability bar set by `ContactDlqAlarm`. The alarm is the cheap, high-value half — ship
it even if the DLQ is staged separately.

### SEC-3 — Per-IP abuse limit (the proportionate seam)

**Decision: minimal, NOT WAF or an app-level token bucket.** For a personal portfolio:

1. **Lower `MAX_EVENTS_PER_BATCH` from 100 to 25** in `aws/src/common/events-shared.js` — caps the
   per-request write fan-out at exactly one BatchWrite (the FE already caps batches at `MAX_BUFFER=40`
   in `js/site-events.js:11`, so legitimate traffic is unaffected; 40 simply flushes as 25+15).
2. **Add an AWS Budget / billing alarm** (this can be account-level / out-of-template) so a cost
   spike from sustained abuse is caught early.

**Rejected — WAF RateBasedRule:** real per-IP enforcement, but a WebACL + association is recurring
cost and operational weight disproportionate to a low-traffic portfolio whose worst case is bounded
billing (rows TTL out; no data loss/exfil). **Rejected — app-level token bucket:** a conditional-write
counter keyed by `ipHash`+minute adds DynamoDB writes/latency on the hot path and its own complexity
to defend a wallet, not data. The amplification factor is the lever worth pulling now; revisit WAF
only if real traffic + abuse materialize.

**Contract:** the events ingress write fan-out per request is bounded to ≤25 rows. `MAX_EVENTS_PER_BATCH`
is an internal cap, not a wire contract — lowering it is **additive/non-breaking** to the FE
(no FE change needed). Note: this single constant change touches `events-shared.js` (SECURITY_GLOB)
— covered by the clearance below.

### INFRA-4 — DR policy on the DynamoDB tables

- `ContactMessagesTable` and `ChatTranscriptsTable` (durable business data): add
  `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` (top-level on the resource) **and**
  `PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }`.
- `SiteEventsTable` (TTL-pruned analytics, daily email is the durable record): add
  `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain`. **PITR optional** (TTL + daily
  aggregation make point-in-time recovery low-value; leave it off unless cheap to enable).

**Contract / operational note:** once `Retain` ships, a `sam delete` / stack teardown leaves the
tables orphaned (intentional — that is the protection). The runbook for intentional teardown must
delete the tables manually afterward. This is a one-way door worth taking for the two business-data
tables.

### INFRA-3 — Cron consolidation

**Decision: stagger, do not merge (yet).** Move `ContactFailureReportFunction` to
`cron(30 11 * * ? *)` and keep `DailyReportFunction` at `cron(0 12 * * ? *)`. The two emails no
longer collide at the same minute and stop sharing Resend rate-limit headroom.

**Why not merge:** folding the failure report into the daily digest is a behavioral/product change
to the email contract (what the digest contains, when the owner is alerted to delivery failures) —
out of scope for an infra-hardening pass and a job for the product-owner, not this ADR. Staggering
is the minimal correct fix; merging is logged as backlog (see drift note below).

## Consequences

- `aws/template.yaml` gains: one alarm + DLQ wiring for `DailyReportFunction`; `Retain` (×3) +
  PITR (×2) on the tables; a staggered cron on `ContactFailureReportFunction`. New `amplify.yml`.
  `MAX_EVENTS_PER_BATCH` drops to 25 in `events-shared.js`.
- **No new SNS topic, no new IAM, no WAF, no app-level counter.** Reuses `ContactAlarmTopic` and the
  existing env-guard test.
- **`Retain` is a one-way door** for the two business tables — teardown now requires a manual table
  delete. Accepted.
- Per-IP abuse remains best-effort (throttle + lowered fan-out + budget alarm); a determined attacker
  can still consume the stage-global throttle budget. Accepted for this blast radius; WAF is the
  documented escalation if traffic grows.
- **Does not address** SEC-2/SEC-1 (see ADR-0008), nor the low-severity backlog items (AGG-1
  day-boundary, EV-2 report idempotency, EV-3 accepted-count, SEC-4/INFRA-5 pre-parse body cap,
  INFRA-6 node-22 CI, FE-3 no-session id, FE-4 funnel terminal event, the cron *merge*) — those are
  filed for the loop, not fixed here.

## Backlog filed for the loop (drift, not fixed by this ADR)

So the inner loop can pick these up without re-deriving them:
- **SEC-4 / INFRA-5** — pre-parse body-size cap (≤64KB → 413) in `parseJsonBody`.
- **EV-2** — daily-report idempotency (Idempotency-Key to Resend keyed on report date; cheapest, no
  IAM change).
- **AGG-1** — `:start` BETWEEN bound vs Python `+00:00` chat `createdAt` at the UTC-day boundary.
- **INFRA-3 (merge)** — retire `ContactFailureReportFunction` into the daily digest (product-owner).
- **INFRA-6** — bump CI `setup-node` to 22 to match the `nodejs22.x` runtime.
- **FE-3** — per-load random id instead of the shared `'no-session'` constant.

## Implementer clearance (SECURITY_GLOB)

Cleared under `SECURITY_REVIEW=1` for: `aws/template.yaml` (DailyReport alarm + DLQ; table
`Retain`/PITR; staggered cron) and the single `MAX_EVENTS_PER_BATCH` 100→25 constant in
`aws/src/common/events-shared.js`. `amplify.yml` is outside the gate and needs no review flag. Out
of scope for this ADR: any other behavior on the gated surfaces, and all items in the backlog list
above.

## Addendum (2026-06-17) — Pre-prod hardening: gated-surface clearance for upcoming P1/P2 slices

**Status: Accepted — extends this ADR's clearance only; does not change any decision above.**

ADR-0008 cleared `contact-shared.js`; this ADR cleared `template.yaml` + the `events-shared.js`
constant. The planner flagged that several upcoming P1/P2 slices touch **additional** SECURITY_GLOB
files **not yet cleared**, blocking the implementer at the gate. This addendum **is the deliberate
security review** for exactly the changes below. No source/tests are touched here — docs only. Each
entry: the change, the security consideration, the clearance.

### `aws/src/events-ingress-core.js` — cleared

- **S10 / EV-3** — make the `202` response body report `persisted` / `received` / `dropped`
  honestly (true counts of what the handler actually wrote vs. what arrived). **Response-shape only**
  — no change to what is persisted, no new field carries PII, no auth change.
- **S12 / EV-4** — reject a decoded body over **~64KB** with a pre-parse size cap **before**
  `JSON.parse`, returning `413`, on the public unauthenticated `POST /api/events`. The cap
  **reduces attack surface**: it bounds work done before the parse on the only unauthenticated
  endpoint, so an oversized payload can't drive parse/allocation cost. Net security improvement.
- **Cleared.** The body cap tightens the surface; the count change is response-shape only.

### `aws/src/common/resend.js` — cleared

- **S11 / EV-2** — forward a stable `Idempotency-Key` header derived from the report date so a
  retry / double-fire of the daily report yields **one** delivered email. **No secret and no PII
  change** — the key is derived from a date, not from message content or recipient data; the request
  body, recipients, and auth header are unchanged. Idempotency only.
- **Cleared.**

### `aws/src/report-queries-core.js` — cleared

- **S21 / AGG-1** — lower the `:start` `BETWEEN` lower bound so `+00:00` midnight rows
  (Python-emitted chat `createdAt`) are included at the UTC-day boundary. Query-shape correction.
- **S22 / EV-1** — bound the per-day in-memory materialization so an unbounded result set can't grow
  memory without limit. Defensive bound on an internal aggregation step.
- **S26 / TC-01** — remove or re-wire the dead `utcDayBounds` helper (dead-code cleanup / correct
  re-wiring). No new behavior on the wire.
- **Security note:** all three are **query-shape only** over **admin-gated reads** — no
  unauthenticated path, no write, no auth change, no PII surfaced that wasn't already admin-visible.
- **Cleared.**

### `docker/chat/app/main.py` — cleared

- **S17 / SEC-7** — add a **server-side cooldown / min-interval** on the `?deep=1` paid Live probe so
  a caller can't fire the paid path repeatedly. Tightens the **cost** surface.
- **S18 / FE-2** — validate a **probe-scoped credential distinct from the contact-admin key**, with a
  **timing-safe** comparison. Tightens the **auth** surface (least-privilege: the probe no longer
  rides the admin key; constant-time compare avoids a timing oracle).
- **Security note:** both changes **TIGHTEN** the auth/cost surface — a net security improvement,
  not a relaxation.
- **Cleared.**

### Clearance statement

**These edits are reviewed and cleared; the implementer may set `SECURITY_REVIEW=1` for exactly
these files/changes** — `aws/src/events-ingress-core.js` (EV-3 honest counts, EV-4 ≤64KB pre-parse
cap → 413), `aws/src/common/resend.js` (EV-2 date-derived `Idempotency-Key`),
`aws/src/report-queries-core.js` (AGG-1 `:start` bound, EV-1 per-day materialization bound, TC-01
`utcDayBounds`), and `docker/chat/app/main.py` (SEC-7 `?deep=1` cooldown, FE-2 timing-safe
probe-scoped credential). **Out of scope** of this clearance: any other behavior on these gated
surfaces beyond the listed slices.
