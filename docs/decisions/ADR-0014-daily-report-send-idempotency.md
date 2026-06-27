# ADR-0014 — Daily-report send: deterministic body + treat Resend 409 idempotency-conflict as success

- Status: Accepted
- Date: 2026-06-27
- Supersedes: none (extends the idempotency-key convention introduced for the
  daily report; ADR-0013 set the report *day*, this fixes the *send*)
- Seam owner: architect

## Context

The scheduled daily-report email never reliably sends. Confirmed against prod
(CloudWatch `/aws/lambda/page-DailyReportFunction-c9fRdKLrcbU3`, every day
6/23–6/26; this is **not** the ADR-0013 timezone issue, which is already fixed):

- `contact-daily-report.js` `handler` runs daily at 12:00 UTC; EventBridge
  async-retries it 3×.
- It calls `sendViaResend(...)` with a **day-stable** idempotency key
  `daily-report-${day}` (`contact-daily-report.js:96`).
- The email **body is non-deterministic** for the same `day`, from two sources:
  1. `buildDailyReport` (`common/daily-report.js:152`) stamps
     `generatedAt: nowIso()` (wall-clock) into the report; it is rendered into the
     HTML footer (`daily-report.js:294`) and the text body (`daily-report.js:303`).
  2. The handler computes a **live** smoke health card (`computeReportSmoke()` →
     real probe latencies, the live chat-model probe, and `rollupSmoke`'s own
     `generatedAt: nowIso()` in `smoke-core.js:18`) and threads it as `report.smoke`,
     rendered by `smokeCard()` into the HTML (`daily-report.js:185-199, 252`) and
     the text body (`daily-report.js:304-308`).
- Resend hashes the **whole** request body against the idempotency key. Same key +
  changed body ⇒ HTTP **409** `invalid_idempotent_request` ("…key has been used
  within the last 24 hours, but the request body was modified…").
  `sendViaResend` treats every non-2xx as a throw (`resend.js:58-63`); the handler
  has no catch, so it throws; EventBridge retries; every retry re-renders a *new*
  live body and 409s again. Net: a stale/early body can win the key, the real-data
  retries all 409, and the owner sees "0" reports.

The smoke health card is **valuable** (the owner reads system health in the email)
and must not simply be deleted. Note: the smoke card is **email-only** — the admin
`/daily-report` endpoint (`contact-admin.js:181-192`) does **not** pass `smoke`, so
nothing in this ADR changes the dashboard preview.

Owner-approved direction:
1. Make the idempotency-keyed body **deterministic per day** so retries render
   byte-identical and Resend returns the cached success instead of 409.
2. Treat a Resend 409 idempotency-conflict as **success** in the handler (a 409
   means today's report was already accepted; the at-most-once intent is satisfied).

## Decision

Two independent defenses, both required (belt **and** braces): (A) make the body
deterministic so the 409 should not arise on a clean retry, and (B) treat the 409
as success so a residual body-drift or a partial-then-retry never throws a
retry-storm again. Each alone is insufficient: (A) without (B) still throws if any
body bit drifts (e.g. a future field, or a real-vs-stale ordering); (B) without (A)
silently drops the *real-data* report and keeps the stale/early one. Together the
report is both correct and never storms.

### (A) Deterministic idempotency-keyed body — the seam is `buildDailyReport`

The body that flows under the `daily-report-${day}` key (subject + HTML + text)
**must be a pure function of the report's `day` and the day's rows** — nothing
wall-clock, nothing live.

1. **`generatedAt`: pin to a day-stable value, do not drop it.** It is rendered
   (footer "Generated …", text "Generated: …") and the owner uses it; dropping it
   would churn the renderers and the existing assertion
   (`daily-report.test.mjs:39` asserts `report.generatedAt` is truthy). Instead,
   `buildDailyReport` derives it from the report `day`, not `nowIso()`:
   `generatedAt = ${day}T00:00:00.000Z` (the day's canonical instant). It stays a
   valid ISO string and a real, stable value for the report period; the footer reads
   "Generated {day}T00:00:00.000Z · covers {day}". `nowIso()` is no longer called by
   `buildDailyReport`; the `contact-shared` import there becomes unused and is
   removed.
   - *Rejected:* keep `nowIso()` but strip `generatedAt` from the keyed body only
     (render it nowhere). It loses an owner-visible field for no gain over pinning,
     and leaves a non-deterministic field on the object that a future renderer could
     re-introduce. Pinning makes the *object itself* deterministic, which is the
     property the test should pin.

2. **Smoke card: render it deterministically — keep status, drop the varying
   bits.** Resend hashes the whole body, so "exclude smoke from idempotency" can
   only mean "the varying smoke bits are not in the sent body." We keep the card
   (health is the point of it) but render only the day-stable signal:
   - **Kept in the keyed body:** `smoke.overall` and, per check, `name`, `status`,
     and `cost`. These are categorical health — exactly what the owner needs at a
     glance, and stable across retries of the same run.
   - **Removed from the keyed body:** per-check `latencyMs` and any `detail` derived
     from latency/timestamps, and `smoke.generatedAt`/any timestamp. `latencyMs`
     and probe timings are the only intra-run-varying fields; cutting them makes
     `smokeCard()`/the text smoke block a pure function of the categorical result.
   - The pure-result determinism is achieved by **stabilizing the smoke object the
     handler hands to the builder**, not by editing the live probes. A small pure
     helper `stabilizeSmokeForReport(smoke)` (in `common/daily-report.js`, ungated)
     projects a live rollup down to `{ overall, depth, checks: [{ name, status, cost }] }`
     — no `latencyMs`, no `generatedAt`, no free-text `detail`. The handler calls it
     on the live `computeReportSmoke()` result before `buildDailyReportForDay`; the
     renderers render whatever is present (a check with no `latencyMs` renders no
     "… ms" suffix; no `detail` renders an empty detail cell). The renderers thus
     stay general and email-client-safe; determinism is enforced upstream at the
     seam, where it is unit-testable.
   - *Why not "keep it live but exclude from idempotency":* there is no Resend knob
     to exclude part of a body from the hash. "Live but excluded" is not
     expressible; the only faithful reading is "the live bits are not in the sent
     body," which is exactly (2). Recorded so a future reader doesn't re-litigate it.
   - *Rejected:* drop the smoke card from the email entirely (simplest determinism).
     Owner values the health signal; a categorical card preserves it. The detailed,
     latency-bearing live smoke remains available out-of-band (the admin `/smoke`
     endpoint and the dashboard), so nothing is lost — only relocated out of the
     once-per-day deduped email.

After (A), for a fixed `day` and a fixed set of rows, `subject`, `renderReportHtml`,
and `renderReportText` are byte-for-byte identical on every retry, so Resend returns
the original 2xx for the same key. (Rows can in principle differ between 12:00-UTC
retries minutes apart; (B) covers that residual.)

### (B) Treat a Resend 409 idempotency-conflict as success — in the **handler**

- **Where:** the **handler** (`contact-daily-report.js`), **not** `sendViaResend`.
  `sendViaResend` (`common/resend.js`, **gated**) is the shared email primitive,
  also used by `contact-sender` (which sends *without* an idempotency key). A 409 is
  meaningful only for an idempotency-keyed send; swallowing it inside the shared
  primitive would change semantics for every caller and require touching the gated
  surface for behavior that belongs to one caller. Keep `sendViaResend` as-is
  (it already attaches `error.status` and `error.body`); the handler catches.
- **Detection — a pure predicate, the unit-test seam.** Add
  `isResendIdempotencyConflict(error)` to `common/daily-report.js` (ungated):

  > returns `true` iff `error?.status === 409` **and**
  > `error?.body?.name === 'invalid_idempotent_request'`.

  The `name`-field gate is load-bearing: a bare `status === 409` could be some other
  Resend 409, and a real failure must still throw. The predicate is SDK-free and
  pure — directly unit-testable.
- **Handler behavior:** wrap the `sendViaResend(...)` call in `try/catch`. On catch,
  if `isResendIdempotencyConflict(error)` → log a single structured INFO line
  (`{ ok: true, date: day, idempotent: true, msg: 'resend idempotency conflict treated as already-sent' }`)
  and return the **same success shape** the happy path returns, but with
  `idempotent: true` added (`statusCode: 200`, `body` JSON includes
  `ok: true, date, events, chatSessions, contactMessages, idempotent: true`). The
  function does **not** rethrow, so EventBridge sees success and does not retry.
  Any other error → **rethrow** unchanged (real send failures must still fail loudly
  and retry).

### What is intentionally NOT changed

- `common/resend.js` (**gated**): untouched. Its retry/throw contract is correct for
  the shared path; the 409 handling lives in the one caller that sets a key.
- `common/report-queries.js` / `-core.js` (**gated**): untouched.
- `aws/template.yaml`: untouched — no new env, no schedule change.
- The admin `/daily-report` endpoint and dashboard: untouched (they pass no `smoke`
  and render `report.generatedAt` only in the same pinned form the builder now
  produces — a strictly more deterministic, still-valid value).

## The seam (contract) both sides build to

> **The daily-report email body delivered under key `daily-report-${day}` is a pure
> function of `day` and the day's rows.** `buildDailyReport` sets
> `generatedAt = ${day}T00:00:00.000Z` (never wall-clock). Any smoke result reaching
> the renderers for the email is first projected to categorical form
> (`{ overall, depth, checks: [{ name, status, cost }] }` — no latency, timestamp,
> or free-text detail) by `stabilizeSmokeForReport`. A Resend send that returns
> 409 `invalid_idempotent_request` for that key is **success** (the day's report is
> already accepted), detected by the pure predicate `isResendIdempotencyConflict`.

## Files / functions to change (ordered for the red→green loop)

All edits are **ungated** except where noted. None touch a gated file.

1. **`aws/src/common/daily-report.js`** (UNGATED) — the determinism + predicate seam:
   - `buildDailyReport`: set `generatedAt` from `day`
     (`${day}T00:00:00.000Z`) instead of `nowIso()`; remove the now-unused
     `nowIso` import.
   - **Add** pure `stabilizeSmokeForReport(smoke)` → projects a live rollup to
     `{ overall, depth, checks: [{ name, status, cost }] }` (or `undefined` when
     `smoke` is falsy). Exported.
   - **Add** pure `isResendIdempotencyConflict(error)` →
     `error?.status === 409 && error?.body?.name === 'invalid_idempotent_request'`.
     Exported.
   - (No renderer rewrite required: `smokeCard()` / `renderReportText` already
     tolerate a check with no `latencyMs`/`detail` — confirm the "… ms"/"paid"
     suffix degrades cleanly when `latencyMs` is absent; if it renders `undefined`,
     guard that one suffix so an absent latency renders nothing.)
2. **`aws/src/contact-daily-report.js`** (UNGATED — confirmed not on SECURITY_GLOB):
   - Import `stabilizeSmokeForReport` and `isResendIdempotencyConflict`.
   - Project the live smoke before building:
     `const smoke = stabilizeSmokeForReport(await computeReportSmoke())`.
   - Wrap `await sendViaResend({...})` in `try/catch`; on
     `isResendIdempotencyConflict(error)` log one INFO line and fall through to the
     existing success return with `idempotent: true`; otherwise rethrow.
   - `computeReportSmoke()` / `fetchDeepChatChecks()` themselves are unchanged (still
     gather live latencies); only the projection happens at the seam.

## Testability — the red→green seams (SDK-free node:test baseline)

The baseline imports **pure / `common/*` units only**, never the SDK-importing
handlers (`contact-daily-report.js` imports `@aws-sdk/*`, so it stays out of
node:test, consistent with ADR-0006). New/extended tests, all against
`common/daily-report.js`:

- **Body determinism (`daily-report.test.mjs`)**: `buildDailyReport({ day, ...rows })`
  called twice with the same inputs yields an identical `generatedAt`, and
  `generatedAt === '${day}T00:00:00.000Z'` (not the current run's clock). Stronger:
  `renderReportHtml`/`renderReportText` are byte-identical across two builds with the
  same inputs (this is the property Resend depends on). Update the existing
  `report.generatedAt` truthiness assertion (line 39) to assert the pinned value.
- **Smoke projection**: `stabilizeSmokeForReport(liveRollup)` strips `latencyMs`,
  `generatedAt`, and free-text `detail`, keeping `overall`, `depth`, and per-check
  `{ name, status, cost }`; and `renderReportHtml(buildDailyReport({...smoke: stabilized}))`
  contains the check names + status pills + `paid` cost but **not** the latency
  number. `undefined`/empty smoke projects to `undefined` (card omitted).
- **Idempotency predicate (`resend-idempotency.test.mjs` or `daily-report.test.mjs`)**:
  `isResendIdempotencyConflict` is `true` for `{ status: 409, body: { name: 'invalid_idempotent_request' } }`
  and `false` for a 409 with a different `name`, a non-409 status, a bare `Error`
  with no `status`/`body`, and `undefined` — so only the specific conflict is
  swallowed and every real failure still throws.

The handler's catch-and-return-success wiring (step 2) is integration glue around
these pure units and is **not** node:test-covered (it imports the SDK); it is
verified by reading + the pure predicate's tests, per the project's handler-seam
convention (ADR-0006).

## Consequences

- The scheduled report stops 409-storming: a clean retry hits the same body and
  Resend replays the original 2xx; a residual body-drift or post-accept retry is
  caught as success. The owner gets exactly one correct report per local day.
- The email's smoke card loses per-check latencies and timestamps (now categorical:
  name + status pill + cost). Detailed live smoke remains available via the admin
  `/smoke` endpoint and the dashboard. Flag for the test-writer/PO as an intended
  visible change to the email.
- `report.generatedAt` is now a day-stable instant (`{day}T00:00:00.000Z`), not "the
  moment the email was built." Any reader interpreting it as build-time is affected;
  the only readers are the two renderers and (transitively) the email — all moved
  together. The admin dashboard renders the same field and gets the same pinned
  value (harmless, more deterministic).
- `buildDailyReport` no longer calls `nowIso()` and so no longer depends on
  `contact-shared` for time — one fewer non-deterministic dependency in the pure
  builder.
- No gated file changes; no SAM/template/IAM change; no data migration. Historical
  emails already sent are unaffected.
- Migration note: none. The first scheduled run after deploy renders a deterministic
  body under `daily-report-${day}`; if that day's key was already burned by a stale
  body within Resend's 24h window, (B) treats the residual 409 as success and the
  next day proceeds cleanly with a key that has only ever seen the deterministic body.

### Invariant to add (`docs/tdd/project-invariants.md`)

> **Daily-report email body is deterministic per day.** The email sent under
> idempotency key `daily-report-${day}` (subject + HTML + text) is a pure function
> of `day` and that day's rows. `buildDailyReport` sets
> `generatedAt = ${day}T00:00:00.000Z` (never wall-clock `nowIso()`), and any smoke
> result rendered into the email is first projected to categorical form
> (`overall`, `depth`, per-check `name`/`status`/`cost` — no latency, timestamp, or
> free-text detail) via `stabilizeSmokeForReport`. A Resend `409`
> `invalid_idempotent_request` for that key is treated as a successful (already-sent)
> delivery, detected by `isResendIdempotencyConflict(error)`; every other send error
> still throws.

## Confirmations recorded

- The smoke card is **email-only** — the admin `/daily-report` endpoint passes no
  `smoke` (`contact-admin.js:181-192`), so this ADR does not change the dashboard
  preview.
- `contact-daily-report.js` is **NOT** on `SECURITY_GLOB`; `common/daily-report.js`
  is **NOT** gated. Both edits proceed without `SECURITY_REVIEW=1`. The gated
  `common/resend.js` and `common/report-queries*.js` are **untouched**.
- The pure seams (`stabilizeSmokeForReport`, `isResendIdempotencyConflict`, pinned
  `generatedAt`) live in the already-SDK-free `common/daily-report.js`, so they are
  directly unit-testable in the node:test baseline without `aws/src/node_modules`.
