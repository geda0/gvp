# Backlog

_Owned by the product-owner. Prioritized top-down; the top ready item is built next.
Each item: a short title, its value, the layer tag, and acceptance criteria (observable
behaviors — never "implement X"). Move accepted items down to "Shipped"._

> **Theme of this backlog (adoption bootstrap).** `docs/tdd/project-invariants.md` lists
> 10 load-bearing invariants; today **only #6 (reduced motion) is proven**. This backlog
> brings the repo to the team's standard: first make CI actually gate the suite, then
> characterize the highest-value UNPROVEN invariants (contact durability), then close the
> precise chat-coverage GAPS the existing 70-test pytest suite leaves open, then add cheap
> frontend guard tests, then retire the debt the ADRs flagged. Green baseline at adoption
> (2026-06-03): **app 10/10 · chat 70/70**.
>
> **Coverage-audit verdict (chat layer, vs the invariant claims).** Read before
> backlogging anything chat-side — several invariants are already partly proven:
> - **#7 (every turn persisted; ok/error/timeout; stream + non-stream) — PARTIAL.**
>   `test_transcript_store.py::test_chat_persists_transcript_turn` proves the **non-stream
>   OK** turn persists exactly one row (asserts session/prompt/model/flags) but **never
>   asserts the `status` field**; the `TranscriptStore` write-mechanics tests cover DDB
>   shape + success/disabled counters. **GAP:** no test drives `status='error'` or
>   `status='timeout'` and asserts the persisted row's `status`/`errorCode`, and **no test
>   touches the streaming (`_chat_stream`/SSE) persistence path at all** (every existing
>   chat test uses `stream:false`).
> - **#8 (provider timeout → 504 + timeout row; bounded calls) — PARTIAL.**
>   `test_readiness_timeout.py::test_chat_timeout_maps_to_504` proves the **non-stream**
>   504 + `code:upstream_timeout`; `test_providers.py::test_gemini_default_upstream_timeout`
>   proves the 28s default. **GAP:** the 504 path is not asserted to **persist a `timeout`
>   row**, the **streaming per-chunk deadline** is untested, and the **55s ceiling cap** is
>   untested.
> - **#9 (first-chunk rate-limit → fallback; committed after first chunk) — GAP.**
>   `test_upstream_errors.py` proves the rate-limit *classifier* (`is_upstream_rate_limit`,
>   `upstream_error_body`) and `test_gemini_limit_state.py` proves the daily-reset *state
>   tracker* — both adjacent building blocks. **No test exercises `GeminiRoutingChain`
>   itself**: nothing asserts that a first-chunk rate-limit falls over to the fallback
>   model, that a mid-stream error AFTER a yield is NOT retried (committed), or the
>   distinct-model guard.
> - **#10 (voice timbre pinned to Charon + cadence directive) — GAP.**
>   `test_live_handshake.py` proves the setup handshake shape (`responseModalities==['AUDIO']`,
>   systemInstruction, tools) — i.e. the AUDIO-modality half — and `test_live_session.py`
>   covers session minting/gating. **No test references `Charon`, `_live_voice_name`,
>   `speech_config`, or `PrebuiltVoiceConfig`**, and nothing asserts the cadence directive.
>   The brand-contract timbre lock is effectively unproven.
>
> **App-layer state:** the only node test is `test/starfield-reduced-motion.test.mjs`.
> There are **zero node tests under `js/`, `scripts/`, or `aws/`** — the contact Lambda
> handlers and all frontend modules are uncovered by `node --test` today.

## Decisions resolved (navigator)

- **(a) RESOLVED — reframing accepted (default taken).** Invariant #2 is governed as
  "no hardcoded cross-origin host; every base derives from a `<meta>` tag, same-origin
  local-only fallback, never-`*` CORS." Backlog item "No hardcoded cross-origin API host"
  tests the meta/CORS contract, not literal single-origin.
- **(b) RESOLVED — (i) repurpose in place (default taken), now SHIPPED.** `tdd-verify.yml`
  was rewritten into a `node --test` job (`actions/setup-node`, no install step — root
  `package.json` has no deps/lockfile and `node --test` needs none); the stale
  `pnpm install --frozen-lockfile` + `pnpm verify` template is gone. See Shipped items 1/11.

## Decisions needed (navigator)

- _none open. New (post-shipment) navigator note: the contact Lambdas were refactored into
  the ADR-0006 injectable-core seam (`contact-ingress-core.js` / `contact-sender-core.js`)
  with `export const handler` and deployed behavior unchanged by design (ADR-0006). The
  characterization landed behind that seam; **deploying the refactored Lambdas to
  prod/stage is a separate release decision** (no behavior change is intended, so it can
  ride the next deploy rather than forcing one)._

### (Archived — original decision text, now resolved)

- **(a) Confirm the single-origin reframing for invariant #2.** The adoption brief and
  ADR-0001 describe a "single-origin `/api/*` proxy," but **production is cross-origin**:
  the shipped meta tags point chat at `chat-api.marwanelgendy.link` (ALB) and contact at an
  `execute-api` host, distinct from the Amplify static origin; same-origin `/api/*` is only
  the local-dev fallback (hostname-gated to `localhost`/`127.0.0.1`). `project-invariants.md`
  ("Out of scope") already reframes the real contract as **"#2: no hardcoded cross-origin
  host — every base derives from a `<meta>` tag, with a same-origin local-only fallback,"**
  governed by backend CORS allowlists (never `*`). Please **confirm this reframing is
  accepted** so backlog item P4a tests the meta/CORS contract, not literal single-origin.
  *(Affects only what P4a asserts; default if no objection: accept the reframing.)*

- **(b) Fix-vs-delete `tdd-verify.yml`.** `.github/workflows/tdd-verify.yml` is the unedited
  teamentic template — it runs `pnpm install --frozen-lockfile` + `pnpm verify`, but this
  repo has **no `pnpm-lock.yaml` and no `verify` script**, so it fails on every push/PR
  today (flagged by ADR-0005 as drift). The chat suite is already CI-gated by
  `docker-compose-chat-ci.yml`. Choose one for P1:
  - **(i) Repurpose** `tdd-verify.yml` into a node:test job (`actions/setup-node` +
    `npm ci || npm install` + `node --test`) — keeps the canonical floor visibly gated in
    its own workflow; **or**
  - **(ii) Delete** `tdd-verify.yml` and add the node:test job to an existing workflow.

  Either way the **acceptance for P1 is the same** (node:test runs green in CI on every
  push/PR; no failing workflow remains). This decision only picks the file layout.
  *(Default if no objection: (i) repurpose in place — least surprising, one workflow per bar.)*

## MILESTONE — Pre-prod hardening → stage (active)

> **Origin.** A 37-agent adversarial pre-prod review of the 22-commit `agent`→`main` diff produced
> **28 confirmed-real findings** (23 unique after dedup: INFRA-1≡FE-1, EV-4≡SEC-4≡INFRA-5,
> SEC-7≡CHAT-SMOKE-1, AGG-3≡TC-04). Zero of these are externally-exploitable holes, shipped secrets,
> or active data-loss bugs on a personal portfolio — the verifier rated **all 23 "not a prod blocker"**.
> The owner's directive is explicit: **"fix everything and do everything the right way, then re-deploy
> to STAGE"** (staging, NOT prod). So this milestone treats the verifier's "fix-soon / acceptable-backlog"
> calls as **in-scope work**, not deferrals — every FIX item ships before the stage deploy, calibrated to
> the blast radius (the verifier's severity downgrades are honored as priorities, not as licence to skip).
> Full per-finding detail (file:line + verifier confirmation) lives in the review output; this backlog is
> the prioritized plan.
>
> **Target = STAGE.** Because we deploy to staging (not prod), the promotion-procedure half of INFRA-1/FE-1
> (re-pinning prod hosts on `main` after the fast-forward) is **NOT triggered now** — see design-notes.
> The **structural** half (an `amplify.yml` preBuild env-guard so Amplify fails closed on a leaked staging
> host) **IS in scope** as P0 hardening: it is the only durable fix for the recurring 2026-06-04 incident.
>
> **Three judgment calls decided** (owner to confirm): SEC-2 → HMAC+pepper; SEC-1 → minimal dismissible
> banner; FE-2 → split a separate probe key. Rationale in `design-notes.md` "Decisions".
>
> **Layer tags:** `[app node:test]` (js/, aws/src/ pure cores), `[app infra-template]`
> (`aws/template.yaml` — SECURITY_GLOB-gated), `[chat pytest]` (docker/chat), `[frontend-manual]`
> (browser-verified UX, qa-verifier signs the UX bullet), `[CI]` (workflow/yml). Items touching the
> deployed SAM template or chat container are exercised by their existing suites where a pure seam exists;
> infra-template / config-only changes are verified by review against the diff (no node:test seam), per the
> "infra-only halves" convention already used for the contact DLQ topology.

### P0 — ship-blockers for the stage deploy

1. **Amplify build fails closed on a leaked staging API host** — `[CI]` — _structural fix for the
   recurring 2026-06-04 host-leak incident (INFRA-1 / FE-1). The existing `deploy-prod.yml` env-guard
   only reds the BACKEND workflow; Amplify is an independent pipeline that serves committed HTML as-is,
   so today nothing stops the static site shipping a wrong-environment backend host._
   - [ ] An `amplify.yml` (or `amplify.yaml`) exists at repo root with a `preBuild` phase that runs the
         environment guard test, so the Amplify build itself fails when the committed HTML points at the
         wrong-environment backend.
   - [ ] The guard runs the existing `test/frontend-api-url-env-guard.test.mjs` with the build's expected
         environment (e.g. `GVP_EXPECTED_ENV` resolved per branch/app), and a leaked host makes the
         Amplify build exit non-zero (does not deploy).
   - [ ] On a tree whose committed HTML matches the expected environment, the preBuild guard passes and
         the build proceeds.
   - _P0 because it is the one item that converts the 2026-06-04 incident from "detected after the fact in
     a separate workflow" to "the static deploy cannot ship the leak." Decision: how `GVP_EXPECTED_ENV` is
     resolved per Amplify app (the agent app expects staging hosts, main expects prod) is a navigator/
     dev-ops call — see design-notes._

2. **DailyReport scheduled function failures are observable** — `[app infra-template]` — _INFRA-2. The
   daily digest + deep live-smoke is the ONLY daily health signal; today a thrown invocation is retried
   twice then silently dropped with no alarm, so the owner loses the digest and never knows._
   - [ ] `DailyReportFunction` has a CloudWatch `Errors` alarm (`AWS/Lambda`, `FunctionName` dimension)
         wired to the existing `ContactAlarmTopic` (mirrors the chat stack's `ChatLambdaErrorsAlarm`).
   - [ ] A failed scheduled invocation surfaces (alarm fires / notifies) rather than being silently dropped.
   - [ ] The same alarm coverage extends to `ContactFailureReportFunction` (the other un-alarmed scheduled
         function), so no scheduled Lambda is unmonitored.
   - _P0: cheapest, highest-value reliability fix; without it every other reliability item is invisible
     when it fails. Verifier rated medium; "do it right" + observability-first makes it a ship-blocker._

3. **No analytics fires before consent** — `[frontend-manual]` `[app node:test]` — _SEC-1. The site ships
   IP-derived `ipHash`, sessionId, user-agent and behavioral events to BOTH Google Analytics and an owned
   DynamoDB store with zero consent — a genuine GDPR/ePrivacy gap. Decision: minimal dismissible banner +
   `localStorage` flag (see design-notes)._
   - [ ] On a first visit with no stored consent decision, neither `gtag` analytics nor the first-party
         beacon (`recordEvent`/`flushEvents`) sends any network request.
   - [ ] A dismissible consent banner is shown on first visit; accepting it stores a consent flag in
         `localStorage` and from then on GA + the beacon fire as today.
   - [ ] Declining (or dismissing without accepting) keeps both GA and the beacon suppressed, and the
         decision persists across reloads (no banner re-shown, no events sent).
   - [ ] qa-verifier confirms the banner UX in a browser (shown once, dismiss persists, theme-consistent,
         keyboard-dismissible, respects reduced-motion).
   - _P0: the only finding with an external-party (visitor) dimension and a regulatory basis; "the right
     way" requires gating before the first beacon. A node:test can pin the gate logic (no send without the
     flag); the banner appearance is the frontend-manual UX bullet._

4. **Visitor IP identifier is not a reversible plain hash** — `[app node:test]` — _SEC-2. `hashIp()` is an
   unsalted truncated SHA-256(IP), trivially rainbow-table-reversible, now written to the new higher-volume
   public events store and used as the `uniqueVisitors` key. Decision: HMAC-SHA256 with a Secrets Manager
   pepper (see design-notes)._
   - [ ] The stored `ipHash` is a keyed hash (HMAC with a server-side pepper sourced from Secrets Manager /
         env), so the same IP without the pepper cannot be recovered from a precomputed table.
   - [ ] The `uniqueVisitors` metric still works (same IP within a pepper epoch → same hash → counted once).
   - [ ] With no pepper configured, behavior fails safe (documented: either refuse to start, or fall back to
         a clearly-documented non-IP visitor key — navigator note in design-notes).
   - _P0: privacy correctness on data we collect from third parties; HMAC+pepper is the "right way" and
     preserves the metric. The pure hash function is node:test-able; the Secrets Manager wiring is
     infra-template verified by review._

### P1 — this milestone (before stage deploy)

5. **Public events beacon cannot be used for billing amplification** — `[app infra-template]`
   `[app node:test]` — _SEC-3. The unauthenticated `/api/events` route has only a global stage throttle
   (no per-IP), and each request fans out to up to 100 BatchWrite rows against a PAY_PER_REQUEST table
   (~2000 writes/s sustainable) — a wallet/billing-DoS vector._
   - [ ] An AWS Budget / billing alarm exists so a cost spike on the events path is caught early (cheapest
         mitigation, do first).
   - [ ] The per-request amplification factor is reduced: `MAX_EVENTS_PER_BATCH` is lowered (e.g. to 25,
         one BatchWrite) and/or the `/api/events` route throttle is brought closer to expected beacon volume.
   - [ ] The lowered batch cap is reflected in the events-shared core and its tests stay green.
   - _P1: bounded billing cost only (rows TTL out), no data/secret/exfil dimension; but "do it right" means
     shrinking the amplification and adding the budget alarm. A per-IP token bucket / WAF rule is the deeper
     fix — see item 18 (P2)._

6. **Events ingress rejects oversized bodies before parsing** — `[app node:test]` — _EV-4 / SEC-4 /
   INFRA-5 (one item, three dimensions). `parseJsonBody()` base64-decodes and `JSON.parse()`s the full body
   with no length check, on the unauthenticated public events route with the elevated throttle._
   - [ ] A request whose (decoded) body exceeds a small cap (e.g. ~64KB — a 40-event batch is well under) is
         rejected with 400/413 BEFORE `JSON.parse` runs.
   - [ ] A normal beacon batch (≤40 events) is accepted unchanged.
   - [ ] The guard lives centrally (in `parseJsonBody` or the events handler) so it also hardens the contact
         ingress path for free.
   - _P1: bounded by the 10MB gateway cap so low-impact, but the central guard is cheap, hardens two routes,
     and is straightforwardly node:test-able at the core seam._

7. **Daily report email is not duplicated on retry / double-fire** — `[app node:test]` — _EV-2. The
   scheduled report sends via Resend with no idempotency key; EventBridge at-least-once + async-Lambda retry
   + Resend's own 5xx retry can each produce a duplicate digest._
   - [ ] The report send carries a stable idempotency token keyed on the report date (e.g. a Resend
         `Idempotency-Key`), so a retried send for the same day does not produce a second email.
   - [ ] Two sends for the same report date resolve to a single delivered email (idempotent).
   - _P1: annoyance-only (a dup email to the owner), but the Resend idempotency-key fix needs no IAM change
     and is testable at the sender seam. A per-day marker row would need write IAM — note that as the
     heavier alternative in design-notes; the idempotency-key is the chosen path._

8. **Storage-disabled visitors get distinct beacon session ids** — `[app node:test]`
   `[frontend-manual]` — _FE-3. When `sessionStorage` is unavailable (private mode), `getSessionId()`
   returns the literal `'no-session'` for every visitor, merging distinct visitors into one bucket in the
   daily report's session count and the per-session inspector._
   - [ ] When `sessionStorage` throws/unavailable, the session id is a freshly-generated per-load random id
         (not a shared constant), so two such visitors produce different ids.
   - [ ] When `sessionStorage` is available, behavior is unchanged (stable per-tab id as today).
   - _P1: analytics-quality fix; the FE module gains its first test (closes part of TC-02) and the fallback
     is a one-line change in the catch branch._

9. **Chat deep-probe (`?deep=1`) has a server-side cooldown** — `[chat pytest]` — _SEC-7 /
   CHAT-SMOKE-1. The admin-gated deep smoke mints a REAL paid Gemini Live session with no per-call
   cooldown/in-flight guard; a key-holder (or the key-carrying admin SPA) can fire paid probes back-to-back._
   - [ ] A second deep probe within a short server-side min-interval of the previous one is rejected (e.g.
         429 / "cooldown") rather than minting another paid Live session.
   - [ ] After the cooldown elapses, a deep probe is allowed again; the once-daily report caller is
         unaffected (interval well under 24h).
   - _P1: gated by a timing-safe admin key so not externally exploitable, but "do it right" caps the cost if
     the key leaks; testable in the chat pytest suite against the smoke handler._

10. **Separate probe-scoped key for the chat smoke endpoint** — `[chat pytest]` `[frontend-manual]` —
    _FE-2. The admin SPA forwards the contact-admin session key as `x-admin-key` to the chat ECS host, so
    one secret unlocks two trust domains. Decision: split a dedicated key (see design-notes)._
    - [ ] The chat `/api/chat/smoke` endpoint validates a probe-scoped credential distinct from the
          contact-admin key (its own env secret on the chat container), with a timing-safe compare.
    - [ ] The admin SPA sends the probe-scoped key (not the contact-admin key) to the chat host; the deep
          probe still works end-to-end against staging.
    - [ ] A compromise of one trust domain's key does not unlock the other.
    - _P1: owner-only residual risk today, but "do everything the right way" = trust-domain separation.
      qa-verifier confirms the deep probe still works in the admin panel against staging after the split._

11. **`avgFirstToken` is defined consistently across digest and admin panel** — `[app node:test]`
    `[frontend-manual]` — _AGG-2. The daily digest counts `firstTokenLatencyMs` only for `stream && ok`
    turns; the admin transcripts/summary panel counts it for ANY finite value — so the same data shows two
    different "avg first token" numbers to the same operator._
    - [ ] The two surfaces either compute the average from the same definition, OR the admin panel labels
          them distinctly (e.g. "avg first token (streamed OK)" vs "(all text turns)") so they are not
          silently conflated.
    - [ ] The chosen definition is covered by a test so a regression re-diverges them red.
    - _P1: operator-confusion only, no data loss; pick the stream+ok "healthy streaming" definition as the
      canonical one (reuse the shared aggregator) or label distinctly. qa-verifier confirms the admin panel
      reads correctly._

12. **Every contact submission has a matching terminal funnel event** — `[app node:test]` — _FE-4. On a
    2xx response with a missing/non-object body or non-JSON content-type, `contact.js` shows the user an
    error but emits no `contact_submit_ok`/`contact_submit_error`, so the funnel records an open
    `contact_submit` with no outcome — skewing the daily report's success/error rate._
    - [ ] A 2xx-with-unexpected-reply path emits a terminal `contact_submit_error` (e.g.
          `reason: 'unexpected_reply'`) before returning, so every `contact_submit` has a matching outcome.
    - [ ] The normal success and 4xx/5xx/validation/network paths are unchanged (still emit their existing
          terminal events).
    - _P1: minor analytics skew; the user already sees the right message. Easy node:test against the contact
      core's event-emission contract._

### P2 — follow-ups (this milestone if time; else fast-follow, owner's call)

13. **Daily-report empty-day average test asserts the real property** — `[app node:test]` —
    _AGG-3 / TC-04. The empty-day test asserts `report.avgFirstTokenMs` (a top-level property that never
    exists → always `undefined` → passes vacuously) instead of `report.chat.avgFirstTokenMs`, so it would
    not catch a regression that made the nested average `NaN`._
    - [ ] The empty-day test asserts `report.chat.avgFirstTokenMs === undefined`, and a deliberate `NaN`
          there would make it fail.
    - _P2: test-quality only, code is correct. Bundle into a test-hardening pass._

14. **Chat day-boundary `+00:00` rows are captured by the lookback** — `[app node:test]` — _AGG-1. The
    `queryDay` `:start` bound is built as a JS `...000Z` string; Python chat `createdAt` uses the `+00:00`
    offset form, which sorts lexicographically below `Z`, so a chat row in microseconds 0–999 of a UTC day
    is dropped from the next day's lookback._
    - [ ] The `:start` lower bound sorts at/below both the `...000Z` and `...+00:00` representations (e.g. a
          fractionless `${day}T00:00:00` lower bound), OR chat `createdAt` is normalized to `Z` form on write.
    - [ ] A regression test in `report-queries.test.mjs` asserts a `+00:00` midnight chat row is included.
    - _P2: practically unreachable trigger (session starting in the first ~1ms of a UTC day with turns
      crossing midnight) and even then only cross-midnight tail turns are undercounted in one day's report._

15. **`/api/events` 202 count is unambiguous** — `[app node:test]` — _EV-3. The 202 `accepted` count is the
    persisted-count, silently omitting events the server dropped (unnamed, >100, excess params), with no
    signal — though the FE never reads the response body._
    - [ ] The 202 response either renames `accepted` to `persisted`, OR additionally returns
          `received`/`dropped`, so the count is unambiguous.
    - _P2: zero consumer reads it today; cosmetic. Trivial if touched._

16. **Per-day query is bounded under a flood** — `[app node:test]` `[app infra-template]` — _EV-1.
    `queryDayWith` pushes every row of a UTC day into one unbounded array; under a sustained flood the daily
    report could OOM/timeout (256MB/60s). The Errors alarm (item 2) makes a silent failure visible; this
    bounds the cause._
    - [ ] `queryDayWith` either caps the materialized item count or aggregates incrementally within the
          pagination loop instead of collecting the whole day in memory.
    - [ ] The existing report-queries tests stay green; a test pins the bounded/incremental behavior.
    - _P2: requires an attacker sustaining the throttle ceiling for a full day; with item 2's alarm in place
      a failure is at least observed. Item 5's lowered amplification also reduces the achievable volume._

17. **DynamoDB tables have PITR + retention on the durable business data** — `[app infra-template]` —
    _INFRA-4. No table has `PointInTimeRecoverySpecification` or `DeletionPolicy/UpdateReplacePolicy: Retain`;
    a stack delete or replacing update destroys all rows. The meaningful gap is `ContactMessagesTable`
    (real inbound contact data); `SiteEventsTable` is TTL-pruned analytics (lower stakes)._
    - [ ] `ContactMessagesTable` (and `ChatTranscriptsTable`) have `DeletionPolicy: Retain` +
          `UpdateReplacePolicy: Retain` and `PointInTimeRecoveryEnabled: true`.
    - [ ] `SiteEventsTable` has `Retain` policies (PITR optional given the 120-day TTL).
    - _P2: DR/config hardening, not active loss; loss only on an operator-initiated delete/replace. Note:
      the genuinely valuable gap (ContactMessagesTable) is PRE-EXISTING, unchanged by this branch._

18. **Per-IP rate limiting on the public events beacon** — `[app infra-template]` — _SEC-3 (deeper half).
    Beyond item 5's amplification reduction + budget alarm, a real per-IP ceiling is the durable fix._
    - [ ] A per-IP control bounds beacon abuse independent of the global stage throttle (e.g. a WAF
          RateBasedRule on the HttpApi, or a conditional-write token-bucket keyed by `ipHash`+minute).
    - _P2: the deeper structural mitigation; item 5 (budget alarm + lowered amplification) is the P1 floor.
      Escalation note: a WAF RuleGroup adds AWS cost — navigator/dev-ops call whether to add WAF on a
      personal portfolio vs the cheaper token-bucket; see design-notes._

19. **Stale CORS comment in the beacon is corrected** — `[app node:test]` (or doc-only) — _SEC-5. The
    `js/site-events.js` comment claims the gateway returns `Access-Control-Allow-Origin: *` (false — the
    template uses an explicit allowlist), which could mislead a future maintainer into "fixing" CORS in a
    way that breaks the beacon._
    - [ ] The comment states the true reason (`text/plain` keeps the POST a CORS-safelisted simple request,
          avoiding preflight) and no longer claims a wildcard ACAO.
    - _P2: pure comment defect, zero runtime effect. No code change required._

20. **Dead `utcDayBounds` helper is removed or wired in** — `[app node:test]` — _TC-01. `utcDayBounds`
    returns HALF-OPEN bounds and is tested, but it has zero production callers; the live path
    (`queryDayWith`) uses an inclusive-last-ms end. Divergent, dead, false coverage._
    - [ ] `utcDayBounds` is either deleted (with its test) as dead code, OR consumed by
          `report-queries-core` so a single tested contract is the one shipped.
    - _P2: live path is already correctly tested; only the unused helper is the trap._

21. **FE beacon module has test coverage** — `[app node:test]` — _TC-02. `js/site-events.js`
    (recordEvent/flushEvents/buffer-cap/text-plain) ships with zero tests; the backend half is well-covered._
    - [ ] A node:test (stubbing `navigator.sendBeacon`, `fetch`, `sessionStorage`) asserts: buffer flushes at
          the cap, `recordEvent` stamps `ts` and no-ops on empty name, `flushEvents` no-ops on empty buffer and
          swaps the buffer before posting, and the `text/plain` blob type is preserved.
    - _P2: best-effort analytics, errors swallowed by design. Partly overlaps item 8's consent/session test;
      land them together._

22. **Thin handler wrappers above the core seam are tested** — `[app node:test]` — _TC-03. The
    `getSessionEvents` day-defaulting + `?date` regex guard (logic, not glue) and the daily-report
    `fetchDeepChatChecks` timeout/error mapping are untested above the pure-core seam._
    - [ ] A handler-level test for `getSessionEvents` (inject a fake `queryDay`) asserts the today-UTC
          default, the `?date` regex guard, and `lookbackDays:1`.
    - [ ] (Ideally) a test for `contact-daily-report`'s `fetchDeepChatChecks` timeout/error mapping.
    - _P2: small low-risk branch behind the admin-key gate; the regex already blocks malformed dates._

23. **Lambda runtime and CI node major match** — `[CI]` — _INFRA-6. `Globals.Function.Runtime` is
    `nodejs22.x` while the deploy workflows' node:test + SAM steps pin `node-version: 20`, so the suite is
    validated on a different major than ships (low risk — code is baseline ESM + @aws-sdk + fetch)._
    - [ ] The CI `actions/setup-node` `node-version` is bumped to `22` in the deploy + test workflows so the
          suite runs on the same major that ships to Lambda.
    - _P2: also clears the Node 20 deprecation warning noted in progress.md. Pure CI hygiene._

### INFRA-3 — dual cron (folded into item 2's pass)

> **INFRA-3** (two scheduled functions both at `cron(0 12 * * ? *)`) is a low smell — two emails in the
> same minute, only when failed contact rows exist. Address it opportunistically while touching the
> template for item 2: either stagger the failure-report cron (e.g. `cron(30 11 * * ? *)`) or fold
> failed-contact detail into the daily digest. Not its own item; one-line acceptance: the two scheduled
> functions no longer fire at the same UTC minute (or are consolidated to one). `[app infra-template]`, P2.

## Next up (post-milestone — pre-existing OPTIONAL tail, NOT in this milestone)

> _**All ten invariants are fully proven** (the last open clause — #8's 55s cap — shipped 2026-06-04; see
> Shipped "Invariant-completion pins"). The items below are the LOW-priority / OPTIONAL tdd-critic hardening
> tail that predates this milestone: #9 cross-turn pinning (1–2), then optional #10 hardening (3–4). None
> blocks any invariant or the stage deploy — defer until the Pre-prod hardening milestone is signed off._

1. **Pin cross-turn fallback-first persistence** — `[chat]` — _tdd-critic follow-up on the #9
   sign-off: the in-turn first-chunk fallback is now proven, but the routing chain's memory that
   the **primary already rate-limited this run** is unpinned — a refactor could drop
   `note_primary_rate_limited()` and no test would go red, silently re-hammering the throttled
   primary on the next turn._
   - [ ] After the primary returns a rate-limit (429), `prefer_fallback_first()` reports
         **True** (the chain has recorded that the primary should be skipped first next turn).
   - [ ] Removing or never calling `note_primary_rate_limited()` makes the test **fail** in CI.
   - _Low priority. Pins the cross-turn half of #9 that the in-turn fallback tests
     (`test_gemini_routing.py`) do not exercise._

2. **Pin `last_model_id` (which model answered)** — `[chat]` — _tdd-critic follow-up on the #9
   sign-off: the admin telemetry surfaces which model committed a turn, but nothing asserts the
   committed model id, so a routing refactor could mis-report it (e.g. always the primary) without
   a red test._
   - [ ] After a turn commits on the fallback, the chain exposes the **fallback** model id as the
         answering model id (the one the admin panel surfaces); after a normal primary turn it
         exposes the **primary** id.
   - [ ] Reporting the wrong committed model id makes the test **fail** in CI.
   - _Low priority. Asserts the committed-model id the admin telemetry reads._

3. **Enforce the deep/slow-male voice family (allowlist)** — `[chat]` — _tdd-critic OPTIONAL
   follow-up on the #10 sign-off: `_live_voice_name()` echoes any opaque `CHAT_LIVE_VOICE` value
   verbatim (`(os.environ.get('CHAT_LIVE_VOICE') or 'Charon').strip() or 'Charon'`), so the
   'deep/slow male' qualifier in invariant #10 is **documentary, not enforced** — an operator could
   set the override to a bright/female preset and nothing would object._ **(low priority / OPTIONAL)**
   - [ ] A `CHAT_LIVE_VOICE` override that is **not** in a blessed deep/slow-male allowlist is
         rejected or coerced back to the `Charon` default (rather than echoed verbatim).
   - [ ] An override that **is** in the allowlist is honored unchanged (S2's deliberate-override
         behavior is preserved for blessed presets).
   - _Optional hardening; would tighten invariant #10 from "deliberate override" to "deliberate
     override within the brand voice family." Changing the allowlist is a product decision
     (supersede ADR-0003). Skippable — today's behavior is by design (operator-trusted env)._

4. **Couple the voice preset + cadence prose against drift** — `[chat]` — _tdd-critic OPTIONAL
   follow-up on the #10 sign-off: S3 (prebuilt `Charon` in `speech_config`) and S4 (the cadence
   directive in `build_live_system_instruction`) pin the **two halves independently**, but ADR-0003
   notes the preset and the cadence prose "must move together"; a refactor could change one without
   the other and no single test would catch the silent drift._ **(low priority / OPTIONAL)**
   - [ ] A single higher-level test ties the resolved voice preset to the matching cadence
         directive, so changing one half without the other makes the test **fail** in CI.
   - _Optional hardening; closes the coupling gap ADR-0003 calls out. The independent halves are
     already proven by S3/S4 — this only guards them against drifting apart._

## In progress
- _see `design-notes.md` + `progress.md`_

## Shipped

_Adoption baseline (2026-06-03): invariant #6 (reduced motion) proven by
`test/starfield-reduced-motion.test.mjs`; app 10/10 · chat 70/70 green._

**Release: Team Tactics private-repo contact CTA (signed off 2026-06-06).** `[app]` UX — no backend
change. Labs card `link` → `#contact`, CTA **Request access**, `contactPrefill` opens contact dialog.
`test/team-tactics-project.test.mjs`; app **42/42** green.

- **Team Tactics CTA opens contact form** — `[app]` ✓ ACCEPTED.
  - No `github.com/geda0/team-tactics` in project link; `#contact` + **Request access**.
  - Click closes project dialog and opens contact form with prefilled subject/message.

**Release: Invariant-completion pins (#8 cap + #7 ok-cell + tdd-critic Obs A/C) (signed off
2026-06-04).** App suite **36/36**, chat **86/86** green; tdd-critic milestone audit = PASS-on-
substance (CONCERNS were two pre-existing soft spots, one of which — the #7 ok-cell — is closed
here; the other, #10 coupling/allowlist, stays OPTIONAL-backlogged). Four characterization pins
(all green on write — **no production change**), landing **#8 fully proven** and tightening #7.
**With this release every one of the ten project invariants is fully proven; there are no open
invariant clauses, and all six #7 persistence cells assert the row's terminal status directly.**
The remaining backlog is the LOW-priority / OPTIONAL tdd-critic hardening tail (#9 cross-turn, #10
allowlist/coupling) — none blocks an invariant.

- **Pin non-stream OK turn persists `status=='ok'`** — `[chat]` — _invariant **#7**, last soft
  cell closed (tdd-critic milestone finding)._ ✓ ACCEPTED.
  `docker/chat/tests/test_turn_persistence.py::test_non_stream_success_persists_one_ok_row` — a
  successful non-streaming turn persists exactly one row with `turn['status']=='ok'` and
  `turn['stream'] is False` (the genuine `ainvoke` success path). Previously only the row's
  existence was proven (HTTP 200); now all six {ok,error,timeout}×{stream,non-stream} cells assert
  the persisted terminal status directly.

- **Pin chat provider timeout clamp to the 55s ceiling** — `[chat]` — _invariant **#8**, the last
  open clause, now PROVEN (PARTIAL → FULL)._ ✓ ACCEPTED. Bullet → proving test
  (`docker/chat/tests/test_providers.py::test_gemini_timeout_clamped_to_55s_ceiling`):
  - A `GEMINI_TIMEOUT_SECONDS` of `120` resolves to **`55.0`** (clamped to the API-Gateway
    integration ceiling, `min(parsed, 55.0)` at `providers.py:46-47`), while a sub-ceiling `40`
    resolves to **`40.0`** (passed through — the clamp caps but does not floor). Lowering or
    removing the clamp fails CI. _(The 28s default stays covered by
    `test_gemini_default_upstream_timeout`; not re-proven.)_

- **Pin sender `markSending` order on the happy path** — `[app]` — _tdd-critic Obs A, closed._
  ✓ ACCEPTED. `test/contact-sender-core.test.mjs` — on a successful delivery the row is marked
  **`sending`** with the bumped attempt count (`attempts===1`) **before** `sendEmail` is called
  (asserted on the shared call-order array); dropping or reordering the transition fails CI.

- **Pin contact `idempotencyKey` in the enqueued job** — `[app]` — _tdd-critic Obs C, closed._
  ✓ ACCEPTED. `test/contact-ingress-core.test.mjs` — on a valid submission the job handed to
  `enqueueDelivery` carries a **non-empty string `idempotencyKey`** (for safe redrive dedup);
  dropping the field fails CI. _(The existing S1 test still covers the `id`.)_

**Release: Frontend bundle guards (#1 + #2) (signed off 2026-06-04).** App suite **30/30** green
(`node --test`; +7 from the 23/23 baseline). `[app]` characterization only — no UX change. Invariants
**#1** and **#2** move UNPROVEN → PROVEN via `test/frontend-no-secrets.test.mjs` (secret-shaped
literal scan + meta/GA contract on `index.html` / `admin/index.html`) and
`test/frontend-api-config.test.mjs` (no hardcoded cross-origin hosts in `js/`, `site-config`
imports/fallbacks, session-body `websocketUrl`). **Every invariant is now proven except #8's cap
clause.**

- **No secret-shaped strings ship in the frontend bundle** — `[app]` — _invariant **#1**, now
  PROVEN._ ✓ ACCEPTED.
  - Guard scan of `index.html`, `admin/index.html`, `css/`, `js/` — no Gemini/Resend/`sk-` literals.
  - `index.html` remote API config = two `gvp:*-api-url` metas + public GA id only.
  - `admin/index.html` = `gvp:contact-api-url` only.

- **No hardcoded cross-origin API host in frontend JS** — `[app]` — _invariant **#2**, now PROVEN._
  ✓ ACCEPTED.
  - No forbidden `http(s)://` host literals in `js/` (CDN allowlist only).
  - `contact.js` / `chat.js` / `chat-live.js` import from `site-config.js`.
  - Voice WS uses `websocketUrl` from session body (`new WebSocket(websocketUrl)`).

**Release: Gemini Live voice-timbre lock characterization (#10) (signed off 2026-06-04).** Chat
suite **84/84** green (`cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`; +4 from the
80/80 model-fallback baseline), tdd-critic = PASS-on-substance. This is a `[chat]`-layer
characterization feature — **no UX change** — so sign-off is code-level against the 4 new tests in
`docker/chat/tests/test_live_voice_timbre.py`; no running-app QA pass. With this release **invariant
#10 moves UNPROVEN → PROVEN** (all four clauses — default → `Charon`, deliberate override honored
verbatim, prebuilt voice on the connect config's `speech_config`, and the prompt-side cadence
directive; the AUDIO response-modality half was already proven by `test_live_handshake.py`). The
tests call the **pure resolver / config builders** directly (`_live_voice_name()`,
`_live_connect_config(...)`, `build_live_system_instruction(...)`) — no session minting, client, or
network — so the proof pins the observable contract and survives a transport refactor. **With #10
shipped the entire CHAT layer's invariants (#7, #8 timeout-row, #9, #10) are proven; the only
remaining UNPROVEN invariants — #1 and #2 — are both `[app]`-layer frontend guards.** _Two
LOW-priority / OPTIONAL hardening follow-ups from the tdd-critic were filed (Next-up 8–9), both
by-design today and explicitly skippable: (8) `_live_voice_name()` echoes ANY opaque
`CHAT_LIVE_VOICE` — the 'deep/slow male' qualifier is documentary, not enforced (no allowlist); and
(9) S3/S4 pin the preset and the cadence prose independently, so a single coupling test could guard
the two halves ADR-0003 says "must move together" against silent drift._

- **Gemini Live voice timbre is pinned to the deep/slow male preset** — `[chat]` — _invariant
  **#10**, now PROVEN._ ✓ ACCEPTED. Bullet → proving test
  (`docker/chat/tests/test_live_voice_timbre.py`):
  - With no override, the resolved Live voice name is **`Charon`** (the deep/measured male default)
    → **S1** *test_live_voice_defaults_to_charon* (`monkeypatch.delenv('CHAT_LIVE_VOICE')`;
    asserts `_live_voice_name() == 'Charon'`).
  - Setting `CHAT_LIVE_VOICE` to another preset changes the resolved voice to that value — the
    override is deliberate, never silently coerced → **S2** *test_live_voice_override_is_honored*
    (`monkeypatch.setenv('CHAT_LIVE_VOICE', 'Orus')`; asserts `_live_voice_name() == 'Orus'`,
    echoed verbatim — not forced back to `Charon`).
  - A minted Live connect config carries a **prebuilt voice** named `Charon` in its `speech_config`
    → **S3** *test_connect_config_carries_prebuilt_charon_voice* (builds
    `_live_connect_config('hi')`; asserts `cfg.speech_config.voice_config.prebuilt_voice_config`
    is a `types.PrebuiltVoiceConfig` with `voice_name == 'Charon'`). _The **AUDIO** response
    modality half of the same connect config is already proven by
    `test_live_handshake.py` (`responseModalities == ['AUDIO']`), so S3 scopes to the voice only._
  - The voice-mode system instruction opens with the deep/calm/measured-cadence directive — cadence
    is steered by the prompt (Gemini Live has no speech-rate knob, per ADR-0003) → **S4**
    *test_live_system_instruction_has_cadence_directive* (`build_live_system_instruction(...)` with
    `CHAT_VOICE_SYSTEM_APPEND` cleared so the directive is intrinsic; asserts the stable substring
    `'deep, calm, measured cadence'` — not the full tuneable paragraph).
  - _Carve-out (tdd-critic, now Next-up 8–9, OPTIONAL): the override is echoed verbatim with no
    deep/slow-male allowlist (the qualifier is documentary), and the preset (S3) + cadence prose
    (S4) are pinned independently rather than coupled. Both backlogged as low-priority/optional,
    not silently closed; today's behavior is by design._

**Release: chat model fallback characterization (#9) (signed off 2026-06-04).** Chat suite
**80/80** green (`cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`; +5 from the 75/75
turn-persistence baseline), tdd-critic = PASS. This is a `[chat]`-layer characterization feature —
**no UX change** — so sign-off is code-level against the 5 new tests in
`docker/chat/tests/test_gemini_routing.py`; no running-app QA pass. With this release **invariant
#9 moves UNPROVEN → PROVEN** (all four clauses — first-chunk-rate-limit→fallback on both `astream`
and `ainvoke`, committed-after-first-chunk propagation, non-rate-limit-not-retried, and the
distinct-model guard). The tests assert the **routed output / propagation contract** (the
fallback's distinct content reaches the caller; a committed primary chunk + its mid-stream error
both reach the caller and the fallback does not), **not** call counts — so the proof survives a
routing refactor. _Two LOW-priority pinning follow-ups from the tdd-critic were filed (Next-up
7–8): the **cross-turn** fallback-first memory (`prefer_fallback_first()` after a 429) and the
committed `last_model_id` the admin surfaces are not pinned by these in-turn tests._

- **Chat falls back to the secondary model on a first-chunk rate limit** — `[chat]` — _invariant
  **#9**, now PROVEN._ ✓ ACCEPTED. Bullet → proving test
  (`docker/chat/tests/test_gemini_routing.py`):
  - First-chunk upstream rate-limit → the chain transparently produces the **fallback** model's
    output (caller sees a reply, not a 429) → **S1** *test_astream_first_chunk_ratelimit_falls_back*
    (primary's `astream` raises `UpstreamError(429)` before any yield; asserts the joined stream
    content `== "from-fallback"`) **and** **S4** *test_ainvoke_ratelimit_falls_back* (non-streaming
    `ainvoke` 429 → asserts `result.content == "from-fallback"`).
  - Once a chunk has been yielded, a mid-stream error **propagates** (committed — no fallback
    restart) → **S2** *test_astream_committed_midstream_error_propagates* (`_CommitThenBoom` yields
    `"from-primary"` then raises; asserts `pytest.raises(RuntimeError)`, `"from-primary" in seen`,
    `"from-fallback" not in seen`).
  - A first-chunk error that is **not** a rate-limit is **not** retried on the fallback → **S3**
    *test_astream_non_ratelimit_error_not_retried* (`_PlainFirstChunk` raises a plain `RuntimeError`
    before any yield; asserts the error propagates and `"from-fallback" not in seen`).
  - Identical primary/fallback model ids are **rejected** (distinct-model guard) → **S5**
    *test_distinct_model_guard_rejects_identical_ids* (`build_llm_runnable` with equal
    `GEMINI_MODEL`/`GEMINI_FALLBACK_MODEL` → `pytest.raises(RuntimeError)`; distinct ids →
    `isinstance(chain, GeminiRoutingChain)`).
  - _Carve-out (tdd-critic, now Next-up 7–8): these prove the **in-turn** fallback; the
    **cross-turn** fallback-first memory and the committed `last_model_id` are pinned separately
    (low priority, backlogged not silently closed)._

**Release: chat turn-persistence characterization (signed off 2026-06-03).** Chat suite
**75/75** green (`cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`; +5 from the 70/70
adoption baseline), tdd-critic = PASS. This is a `[chat]`-layer characterization feature — **no
UX change** — so sign-off is code-level against the 5 new tests in
`docker/chat/tests/test_turn_persistence.py`; no running-app QA pass. With this release
**invariant #7 moves UNPROVEN → PROVEN** (all six {ok,error,timeout}×{stream,non-stream}
persistence cells now exist) and **invariant #8 advances PARTIAL → mostly proven** (the
persisted `timeout` row is now proven on both paths; only the `providers.py` 28s-default/55s-cap
clause stays open → new Next-up #7). _Honesty caveat carried into #7's "Proven by": five of the
six cells assert the persisted row's `status`; the **non-stream-ok** cell
(`test_chat_persists_transcript_turn`) proves the row persists but does **not** assert
`turn['status']=='ok'` (it asserts HTTP `status_code==200`). Harmless — it is the success path —
and noted rather than papered over._

- **Chat error/timeout turns are persisted with the right status** — `[chat]` — _invariant
  **#7**, non-stream half, now PROVEN._ ✓ ACCEPTED. Bullet → proving test
  (`docker/chat/tests/test_turn_persistence.py`):
  - Non-rate-limit error on a non-streaming turn → exactly one row, `status=='error'` with a
    populated `errorCode`/`errorMessage` → **S1** *test_non_stream_error_persists_one_error_row*
    (`_BoomChain.ainvoke` raises `RuntimeError`; asserts `len(stub.calls)==1`,
    `turn['status']=='error'`, `turn['errorCode']` truthy, `turn['errorMessage']` a non-empty str).
  - Non-streaming turn over the provider timeout → exactly one row, `status=='timeout'` (beyond
    the already-proven 504) → **S2** *test_non_stream_timeout_persists_one_timeout_row*
    (`_SlowChain(0.05)` vs `provider_timeout_seconds=0.01`; asserts `len(stub.calls)==1`,
    `turn['status']=='timeout'`, `turn['errorCode']=='upstream_timeout'`).
  - (Already proven — not re-added) a successful non-streaming turn persists one row →
    `test_transcript_store.py::test_chat_persists_transcript_turn` (proves the row persists;
    does not assert `turn['status']` — see honesty caveat above).

- **Chat streaming turns persist on every terminal state** — `[chat]` — _invariant **#7/#8**,
  streaming half, now PROVEN (the `_chat_stream`/SSE path was previously 0% covered — every
  prior chat test used `stream:false`)._ ✓ ACCEPTED. Bullet → proving test
  (`docker/chat/tests/test_turn_persistence.py`, asserting the persisted row per ADR-0002, not
  the SSE bytes):
  - Successful streaming turn (`stream:true`) → one row, `status=='ok'`, flagged streamed →
    **S3** *test_streaming_success_persists_one_ok_row* (`_StreamChain.astream` yields two
    chunks then completes; after `resp.aread()` asserts `len(stub.calls)==1`,
    `turn['status']=='ok'`, `turn['stream'] is True`).
  - Streaming turn that errors **after** the stream started → one row, `status=='error'` →
    **S4** *test_streaming_midstream_error_persists_one_error_row* (`_MidStreamBoomChain` yields
    one chunk then raises; asserts `len(stub.calls)==1`, `turn['status']=='error'`,
    `turn['errorCode']` truthy).
  - Streaming turn past the per-chunk deadline → one row, `status=='timeout'` → **S5**
    *test_streaming_timeout_persists_one_timeout_row* (`_StallStreamChain(0.05)` stalls before
    the first chunk vs `provider_timeout_seconds=0.01` → per-chunk `asyncio.wait_for`; asserts
    `len(stub.calls)==1`, `turn['status']=='timeout'`, `turn['errorCode']=='upstream_timeout'`).
  - _Carve-out (tdd-critic note, now Next-up #7): the persisted `timeout` row is proven here
    (S2 non-stream, S5 streaming) but the `providers.py` 28s-default/55s-cap resolution is the
    one #8 clause these tests bypass — backlogged, not silently closed._

**Release: contact durability + canonical-bar CI (signed off 2026-06-03).** Full app suite
**23/23** green (`node --test`), chat **70/70** unchanged, tdd-critic = PASS. Backend
characterization/extraction behind the ADR-0006 injectable-core seam — **no UX change** (the
deployed Lambda behavior is unchanged by design), so sign-off is code-level against the
tests, with no running-app QA pass. With this release **invariants #3, #4, #5 move from
UNPROVEN → PROVEN** (only #6 was proven at adoption); each is now guarded by `node --test` so
a regression fails CI. _Note: deploying the refactored Lambdas to prod/stage is a separate
release decision — behavior is unchanged, so it can ride the next deploy._

- **CI runs the canonical bar on every push** — `[app + infra]` — _the suite now gates
  pushes._ ✓ ACCEPTED.
  - ✓ `node --test` runs on every push + pull_request — `.github/workflows/tdd-verify.yml`
    (`on: [push, pull_request]`, `actions/setup-node@v4` node 20, `run: node --test`; no
    install step since root `package.json` has no deps/lockfile).
  - ✓ Green on a clean checkout (verified locally: `# tests 23 / # pass 23 / # fail 0`).
  - ✓ Chat pytest (70/70) still gated — `.github/workflows/docker-compose-chat-ci.yml`
    (`chat-tests` job) is untouched.
  - ✓ No workflow fails on a clean checkout — the stale `pnpm install --frozen-lockfile` +
    `pnpm verify` template is gone (the file is now a node:test job); the two remaining
    workflows (`docker-compose-chat-ci.yml`, `integrate-and-deploy.yml`) invoke no missing
    `pnpm`/lockfile/script.
  - _Navigator decision (b) resolved to (i) repurpose-in-place._

- **Retire or repurpose `tdd-verify.yml`** — `[infra]` — _ADR-0005 drift cleared._
  ✓ ACCEPTED (same change as item above).
  - ✓ No workflow runs `pnpm verify` / expects a missing lockfile or npm script.
  - ✓ The `node --test` bar is gated by exactly one clearly-named workflow (`tdd-verify.yml`,
    single `node-test` job — no duplicate node:test elsewhere); the chat pytest gate is
    untouched.

- **Contact ingress is durable before it returns success** — `[app]` — _invariant **#3**,
  now PROVEN._ ✓ ACCEPTED. Bullet → proving test (`test/contact-ingress-core.test.mjs`):
  - Writes to DDB **and** enqueues SQS **before** `200`, body reports persisted + queued (+id)
    → *"valid submission persists then enqueues before returning 200"* (asserts
    `statusCode==200`, `body.persisted==true`, `body.delivery=='queued'`, `body.id` truthy,
    and `deepEqual(calls, ['persist','enqueue'])` for strict before-200 ordering).
  - Idempotency guard (`attribute_not_exists(id)`) so a replay does not double-write → asserted
    by **ADR-0004/0006 review** (the guard lives in the S5 composition root's real
    `PutCommand`, `aws/src/contact-ingress.js`), **not** node:test — recorded honestly per the
    plan note; the core is SDK-free.
  - Persist throws → **500**, no enqueue → *"persist failure returns 500 and does not enqueue"*
    (`statusCode==500`, non-empty `body.error`, `enqueueCalled==false`).
  - Enqueue throws after a successful persist → **500** → *"enqueue failure after persist
    returns 500"* (asserts `persistRan==true` then `statusCode==500`).
  - _(Extraction-faithfulness extras also landed, hardening the seam: malformed JSON → 400
    `Invalid JSON`; failed validation → 400; missing config → 500; method gate OPTIONS→204
    preflight / GET→405 — all "without IO". These exceed the original 4 bullets.)_

- **Contact honeypot silently discards bots** — `[app]` — _invariant **#4**, now PROVEN._
  ✓ ACCEPTED. Bullet → proving test (`test/contact-ingress-core.test.mjs`):
  - Non-empty hidden `company` → **200** → *"honeypot company field is silently discarded
    with 200 and no IO"* (`statusCode==200`).
  - That submission does **no** DDB write and **no** SQS enqueue → same test
    (`persistCalled==false`, `enqueueCalled==false`); the 200 is a hollow decoy with no id →
    *"honeypot 200 body is a hollow decoy with no id"* (`body.persisted==true`,
    `body.delivery=='queued'`, `body.id===undefined`).
  - `company` empty still persists+enqueues (honeypot does not block real traffic) → covered
    by *"valid submission persists then enqueues…"* (uses an empty honeypot and asserts both
    IO calls fire).

- **Contact sender retries on failure and is safe to redeliver** — `[app]` — _invariant
  **#5**, now PROVEN (the code/sender half)._ ✓ ACCEPTED. Bullet → proving test
  (`test/contact-sender-core.test.mjs`):
  - A row already `sent` → **no-op** (Resend not re-called, no duplicate) → *"sender skips
    already-sent or missing rows with no IO"* (`deepEqual(calls, [])` across an already-`sent`
    row and a missing row).
  - Resend failure → row marked `failed` **and the handler re-throws** so SQS redelivers →
    *"sender marks failed and rethrows when send fails"* (`assert.rejects(...)`,
    `markFailedArgs.id=='m1'`, bumped `attempts==1`, non-empty `errorMessage`, and
    `markSent` never called).
  - A successful send transitions to `sent` → *"sender sends then marks the row sent"*
    (`send` ordered before `markSent`, `markSentArgs.resendId=='resend-1'`).
  - **Infra half (NOT node:test):** the SQS redrive `maxReceiveCount: 5` → `ContactDeliveryDlq`
    → `ContactDlqAlarm` → `ContactAlarmTopic` email is **asserted by review against ADR-0004**
    and verified present in `aws/template.yaml:143-172`. Recorded explicitly so this sign-off
    is honest: only the sender's idempotency + status-transition behavior is proven by
    `node --test`; the dead-letter/alarm topology is infra config verified by review.

- **Guard: contact `*-core.js` import no `@aws-sdk`** — `[app/infra]` — _protects the
  install-free node floor (ADR-0005/0006)._ ✓ ACCEPTED (landed with the seam).
  - `test/contact-core-no-aws-sdk.test.mjs` scans every `aws/src/*-core.js` for an ESM
    `from '@aws-sdk/...'` or CJS `require('@aws-sdk/...')` and fails if found; also asserts
    ≥1 core file exists so the guard is never vacuous. (The composition roots
    `contact-ingress.js`/`contact-sender.js` may import the SDK — only the cores may not.)

## Out of scope for this backlog (not regressions; documented in project-invariants.md)
- **Infra-only halves of invariants** are asserted by review against the ADRs, not unit
  tests: invariant #5's SQS `maxReceiveCount:5` → DLQ → `ContactDlqAlarm` → SNS email
  (`aws/template.yaml`, ADR-0004); invariant #1's Secrets-Manager / SAM-param injection
  (ADR/architecture review).
- **Best-effort persistence when unconfigured.** With `CHAT_TRANSCRIPTS_TABLE` unset,
  `build_transcript_store()` returns `None` and turns intentionally skip persistence — the
  shipped turn-persistence tests (`test_turn_persistence.py`, S1–S5) assert behavior **with a
  store configured** via a stub; the no-op-when-unconfigured path is already covered by
  `test_build_transcript_store_requires_table`.
- **Token-by-token wire streaming is ECS-only** (Lambda/Mangum buffers SSE). The shipped
  streaming-persistence tests (S3–S5) assert the turn is persisted with stream telemetry, not
  that the bytes arrive incrementally (they assert the persisted row per ADR-0002).
- **Voice working end-to-end is a deployment-topology property** (API Gateway can't upgrade
  WebSockets); the shipped voice-timbre characterization (#10) pins the voice *config/timbre*
  (resolved voice name, prebuilt `speech_config`, cadence directive), not live network success.
- **Exact model ids, theme cosmetics, and CORS allowlist contents** are configuration, not
  invariants — only the behaviors (fallback, bounded timeout, never-`*` CORS) are.
