# ADR-0013 — Daily report bucketed by the owner's local timezone (REPORT_TZ), not UTC

- Status: Accepted
- Date: 2026-06-25
- Supersedes: none (first ADR to state the report-day invariant; extends the
  UTC-day convention previously implicit in `daily-report.js` / `report-queries-core.js`)
- Seam owner: architect

## Context

The daily report (the scheduled email Lambda **and** the admin "daily report"
endpoint, both fed by the one shared pure builder `common/daily-report.js`)
buckets and labels its "day" by **UTC**:

- `aggregateChat({day})` filters turns by `utcDayOf(capturedAt) === day`.
- `aggregateSite` / `aggregateContact` do **not** filter at all — they trust the
  query window to have already scoped the rows to one UTC day.
- The query window (`report-queries-core.js` `queryDayWith`) is a single DynamoDB
  `createdAt BETWEEN ${fromDay}T00:00:00 AND ${day}T23:59:59.999Z` (one condition
  per key).
- Both callers compute `day = previousUtcDay()` and the email footer reads
  "covers UTC day".

The admin dashboard, however, renders transcript times in the **owner's local**
time (`js/admin.js` `toLocaleString`). For the US-Pacific owner this disagrees at
the day boundary: a 7 PM-Pacific transcript is ≈ 02:00 UTC the next calendar day.
The dashboard files it under the local date the owner actually experienced; the
report counts it in the *next* UTC day. Net effect: the report for a day on which
the owner had real evening activity can read **0**, and report ↔ dashboard never
line up. Confirmed on Node 22.22 ICU: a `2026-06-25T02:00:00Z` instant is
`2026-06-24` in `America/Los_Angeles` but `2026-06-25` in UTC.

Owner decision: **report by the owner's local timezone** (`America/Los_Angeles`)
so the email/report and the dashboard agree on which day an event belongs to.

## Decision

### The contract / invariant (the seam)

> **The daily report's "day" is the owner's local calendar day in `REPORT_TZ`
> (default `America/Los_Angeles`) — not the UTC day.** A row belongs to the
> report for day `D` iff `localDayOf(row.<ts>, REPORT_TZ) === D`, where `<ts>` is
> `capturedAt`-or-`session.createdAt` for chat turns and `createdAt` for site
> events and contact messages. `buildDailyReport` therefore requires a `tz`, and
> **every** aggregator (site, chat, contact) filters its rows by that rule. The
> report's `date` field and all rendered labels are local-day labels.

This is a **behavioral** contract change at a shared seam (the builder feeds two
independently-deployed callers). It does not change any persisted row, any
DynamoDB key, or any HTTP request/response *shape* — only which rows land in which
day and what the `date`/footer mean. It is recorded here and added to
`project-invariants.md` (see Consequences); no shipped ADR is edited.

### How the rows get fetched (decision (a): keep the gated query as-is)

The query layer (`report-queries-core.js`, **gated**) is **NOT** changed. It keeps
its single-`BETWEEN`, UTC-millisecond-ISO window and the fractionless-start
boundary fix (AGG-1). Instead the callers exploit the existing
`day` + `lookbackDays` knobs to make the UTC window a **superset** of the target
local day, and the (now-universal) per-row local filter trims the overshoot:

For a target local day `D`, query each table with
`day = utcWindowDayForLocal(D)` (= `D` + 1 calendar day) and `lookbackDays: 1`.
That yields the UTC window `[D 00:00:00, D+1 23:59:59.999Z]` (≈ 48h). This window
strictly contains the Pacific local day's true instant span under **both** offsets
and **both** DST transitions — verified:

| Local day `D` (PT) | true instant span (UTC) | window `[D 00:00, D+1 23:59:59.999Z]` |
|---|---|---|
| PDT (UTC-7) | `[D 07:00Z, D+1 07:00Z)` | contains ✓ |
| PST (UTC-8) | `[D 08:00Z, D+1 08:00Z)` | contains ✓ |
| spring-forward (23h) | `[D 08:00Z, D+1 07:00Z)` | contains ✓ |
| fall-back (25h) | `[D 07:00Z, D+1 08:00Z)` | contains ✓ |

The window over-fetches ~24h of rows that belong to the *neighbouring* local days;
`localDayOf(...) === D` discards them. This is acceptable because (i) daily volume
is tiny, (ii) `queryDayWith`'s `maxItems` cap still bounds the heap, and (iii) the
chat path already over-fetches + per-turn-filters today (`lookbackDays:1`), so this
is the *same* proven pattern, merely widened by one day and extended to the site /
contact aggregators.

**Rejected alternative:** widening `report-queries-core.js` to take an explicit
`startIso`/`endIso` (so the UTC window exactly matches the local day, no
over-fetch). It is marginally cleaner at the query layer but (1) forces a **gated**
edit to a tested file for no behavioral benefit the local filter doesn't already
give, (2) the aggregators would *still* need the local filter anyway for the chat
midnight-straddle case, and (3) it couples the query layer to timezone logic that
belongs in the pure aggregator. The window-superset + universal-local-filter
approach keeps timezone knowledge in one place (the aggregators) and leaves the
gated query untouched. **Chosen.**

### New pure helpers — `common/events-shared.js` (UNGATED)

Three SDK-free, side-effect-free functions, unit-testable in the node:test
baseline:

- `localDayOf(ts, tz)` → the `YYYY-MM-DD` of instant `ts` in `tz`, via
  `Intl.DateTimeFormat('en-CA', { timeZone: tz })` (en-CA renders ISO order).
  Falls back to `String(ts).slice(0,10)` when `ts` is unparseable, mirroring the
  existing `utcDayOf` fallback contract.
- `previousLocalDay(tz, now = new Date())` → the local calendar day in `tz`
  immediately before `now` (the report's default target day).
- `utcWindowDayForLocal(localDay)` → the UTC `day` to pass to `queryDay` (with
  `lookbackDays: 1`) so the window covers the whole local day = `localDay` + 1.

`utcDayOf`/`previousUtcDay` are **left in place** (not removed) so nothing else
that imports them breaks; this ADR adds the local variants alongside.

### Configuration (decision (d): the one gated edit, named)

`REPORT_TZ` **defaults to `'America/Los_Angeles'` in code** (read in the two
callers, threaded into the helpers + builder). Because the default lives in code,
**no SAM-template env addition is required to ship.** An optional
`REPORT_TZ` env override (future, e.g. if the owner relocates) can be added to the
template later without changing this contract.

The **only gated source edit** this work requires is in **`contact-admin.js`**
(the admin endpoint is behind the consent gate): its `/daily-report` block + the
`getDailyReport(day)` helper must compute the local day + window + tz and pass `tz`
to the builder. To keep that gated diff minimal, the "compute target day → UTC
window day → tz, then call buildDailyReport" orchestration is extracted into a new
**UNGATED** shared helper that both callers invoke; the gated edit then shrinks to
swapping the `previousUtcDay()`/`queryDay` block for a single call to that helper.

> **Orchestrator: obtain owner consent for the gated edit to
> `aws/src/contact-admin.js` before the inner loop touches it.** This is the only
> gated file in the change set. `report-queries-core.js` (also gated) is **not**
> touched.

## Consequences

- Report ↔ dashboard agree on day attribution for the Pacific owner. The "0 on a
  busy day" boundary bug is fixed.
- `buildDailyReport` signature gains a required-in-practice `tz`. Callers that omit
  it would mis-bucket; the two in-repo callers are both updated in the same change.
  (Test-writer: a `buildDailyReport` call with no `tz` is now a defect to assert
  against, not a supported mode.)
- `aggregateSite` and `aggregateContact` start filtering by `{ day, tz }` (today
  they don't filter at all). This is required because the widened window
  deliberately over-fetches; an unfiltered site/contact aggregator would now
  double-count neighbouring days. **This is the load-bearing behavioral change** —
  flag it for the test-writer.
- The email footer "covers UTC day {date}" and the `<title>`/header wording change
  to the local-day phrasing; `report.date` becomes a local-day string. Any
  consumer that parsed `report.date` as a UTC day is affected — there are none in
  repo besides the renderers and the email subject/idempotency key (all move
  together).
- The idempotency key `daily-report-${day}` now keys on the local day. A
  one-time overlap is possible only if a manual back-fill is run for both the old
  UTC label and the new local label of the same calendar period; routine daily
  runs are unaffected (one run, one local day, one key).
- `project-invariants.md` gains a new invariant stating the local-day rule (wording
  below). No prior invariant is edited; this is the first to record report-day
  bucketing explicitly.
- Migration note: this changes which rows appear in *future* reports and how
  *past* days are labelled if re-generated via the admin endpoint or a back-fill.
  No data migration; raw rows are untouched. Historical emails already sent keep
  their old UTC labels.

### Exact new invariant wording (for `docs/tdd/project-invariants.md`)

> **Daily report day = owner-local (REPORT_TZ) calendar day.** The daily report
> (`common/daily-report.js`, the scheduled email Lambda, and the admin
> `/daily-report` endpoint) buckets and labels its day by the owner's local
> calendar day in `REPORT_TZ` (default `America/Los_Angeles`), **never** UTC. A row
> counts for report day `D` iff `localDayOf(row.<ts>, REPORT_TZ) === D` (where
> `<ts>` is the chat turn's `capturedAt`/session `createdAt`, or `createdAt` for
> site events and contact messages). Every aggregator — site, chat, **and**
> contact — applies this filter; the underlying DynamoDB query may over-fetch a
> wider UTC window (`day = localDay+1`, `lookbackDays: 1`) and relies on this
> per-row filter to trim it. `report.date` and all rendered labels are local-day
> strings.

## Confirmations recorded

- **(b)** The owner-local-day invariant is the right contract; it is additive to
  the invariant set (new invariant, supersedes nothing).
- **(c)** `Intl.DateTimeFormat` with `timeZone` is present and DST-correct on the
  `nodejs22.x` Lambda runtime (verified locally on Node v22.22.0, ICU built-in:
  `02:00Z` → `2026-06-24` PT, January `03:00Z` → `2026-01-14` PT).
- **(a)** The `day+1` / `lookbackDays:1` window trick is sound (table above) — the
  gated `report-queries-core.js` is left untouched.
- **(d)** The single gated edit is `aws/src/contact-admin.js`; orchestrator must
  get owner consent for it.
