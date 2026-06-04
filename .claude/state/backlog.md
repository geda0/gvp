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

## Next up

> _Top of queue after the chat turn-persistence release: items 1–2 (the #7 non-stream +
> streaming persistence cells) are now in Shipped. Remaining order is unchanged — the next two
> chat coverage gaps (1–2 below, formerly 3–4), then frontend guards (3–4), then two small
> post-release follow-ups (5–6), then one low-priority cap follow-up (7)._

1. **Chat falls back to the secondary model on a first-chunk rate limit** — `[chat]` —
   _closes the #9 GAP: `GeminiRoutingChain` itself is untested; only its rate-limit
   classifier and the daily-reset state tracker are covered today._
   - [ ] When the primary model raises an upstream rate-limit on the **first** chunk, the
         routing chain transparently produces its output from the **fallback** model
         (caller sees a successful reply, not a 429).
   - [ ] Once a chunk has been yielded, a mid-stream error **propagates** (the chain is
         committed — it does **not** restart on the fallback).
   - [ ] A first-chunk error that is **not** a rate-limit is **not** retried on the fallback.
   - [ ] Configuring identical primary and fallback model ids is rejected (the distinct-model
         guard holds).
   - _Fake primary chain that raises a rate-limit on first `__anext__`; assert against both
     `astream` and `ainvoke`._

2. **Gemini Live voice timbre is pinned to the deep/slow male preset** — `[chat]` — _closes
   the #10 GAP: the Charon timbre lock + cadence directive is a brand contract that no test
   currently guards._
   - [ ] With no override, the resolved Live voice name is **`Charon`**.
   - [ ] A minted Live connect config carries a **prebuilt voice** in its `speech_config`
         and the **AUDIO** response modality.
   - [ ] Setting `CHAT_LIVE_VOICE` to another preset changes the resolved voice name to that
         value (override is deliberate, not silent).
   - [ ] The voice-mode system instruction opens with the deep/calm/measured-cadence
         directive (cadence is steered by the prompt, per ADR-0003).
   - _Assert `_live_voice_name()` + `_live_connect_config(...)` + `build_live_system_instruction`.
     Changing the default or the cadence prose is a product decision (supersede ADR-0003)._

3. **No secret-shaped strings ship in the frontend bundle** — `[app]` — _invariant #1: the
   browser bundle (HTML/CSS/JS) never contains the Resend, Gemini, or admin API keys; a
   regression that hardcodes a key fails CI instead of leaking to production._
   - [ ] A guard test scanning the shipped frontend (HTML/CSS/JS) finds **no** Gemini
         (`AIza…`), Resend (`re_…`), or admin-key-shaped strings.
   - [ ] The only API-related config in `index.html` is the two `gvp:*-api-url` meta tags
         plus the public Google Analytics measurement id (a non-secret).
   - [ ] The test passes on the current tree (it characterizes today's clean state) and
         would **fail** if a key-shaped literal were added to any shipped frontend file.
   - _Cheap, high-signal guard. Decision (a) does not affect this item._

4. **No hardcoded cross-origin API host in frontend JS** — `[app]` — _invariant #2
    (reframed per resolved decision (a)): every frontend network base derives from a
    `<meta>` tag via `site-config`, with only a same-origin local-dev fallback; no module
    hardcodes a remote API hostname._
    - [ ] A guard test finds **no** hardcoded `http(s)://` API-host literal in `js/`
          (Google Fonts/Analytics/CDN and code comments excluded).
    - [ ] Each network consumer (`contact.js`, `chat.js`, `chat-live.js`) resolves its base
          from `site-config` exports (`contactApiUrl`/`chatApiUrl`), and the empty-meta
          fallback is the same-origin `/api/*` path only on `localhost`/`127.0.0.1`.
    - [ ] The voice WebSocket URL is taken from the minted session response body, not built
          against a hardcoded host.
    - [ ] The test passes on the current tree and would fail if a remote API host were
          hardcoded in `js/`.
    - _Navigator decision (a) sets the framing (meta + same-origin fallback, not literal
      single-origin)._

5. **Pin sender `markSending` on the happy path** — `[app]` — _tdd-critic Obs A: the
   sender's `sending` transition is currently unpinned, so a refactor could drop it (losing
   the in-flight attempt bump that the admin panel and retry accounting rely on) without any
   test going red._
   - [ ] On a successful delivery, the row is marked **`sending`** (with the bumped attempt
         count) **before** `sendEmail` is called — the order is observable and asserted.
   - [ ] Removing the `markSending` transition (or moving it after the send) makes the test
         **fail** in CI.
   - _Low priority. Extends the `createSenderHandler` fakes already in
     `test/contact-sender-core.test.mjs` (the happy-path test injects a no-op `markSending`
     today; this asserts its call + ordering)._

6. **Pin contact `idempotencyKey` in the enqueued job** — `[app]` — _tdd-critic Obs C: the
   SQS delivery job is asserted to carry the message `id`, but not an `idempotencyKey`;
   dropping that field would weaken redelivery de-duplication without a red test._
   - [ ] On a valid submission, the job handed to `enqueueDelivery` carries a **non-empty
         `idempotencyKey`**.
   - [ ] Removing the `idempotencyKey` from the enqueued job makes the test **fail** in CI.
   - _Low priority. One added assertion on the captured `enqueuedJob` in the existing valid-
     submission test in `test/contact-ingress-core.test.mjs`._

7. **Pin chat provider timeout resolution + cap** — `[chat]` — _the one sub-clause of #8 the
   turn-persistence tests bypass (tdd-critic note): the persisted `timeout` row is proven, but
   `providers.py`'s timeout resolution — the 28s Gemini default and the 55s API-Gateway
   ceiling — is only half-covered (`test_gemini_default_upstream_timeout` proves the default,
   nothing proves the cap)._
   - [ ] With no override, `get_provider_timeout_seconds('gemini')` resolves the Gemini
         default of **28s** (already proven by `test_gemini_default_upstream_timeout` — this
         item only adds the cap case).
   - [ ] A `>55s` override (e.g. `GEMINI_TIMEOUT_SECONDS`/`CHAT_PROVIDER_TIMEOUT_SECONDS`) is
         **clamped to the 55s** API-Gateway integration ceiling, not passed through.
   - [ ] Lowering or removing the clamp makes the test **fail** in CI.
   - _Low priority. Extends `test_providers.py`; closes the last open clause of invariant #8._

## In progress
- _see `design-notes.md` + `progress.md`_

## Shipped

_Adoption baseline (2026-06-03): invariant #6 (reduced motion) proven by
`test/starfield-reduced-motion.test.mjs`; app 10/10 · chat 70/70 green._

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
  WebSockets); Next-up item 2 (Gemini Live voice timbre) pins the voice *config/timbre*, not
  live network success.
- **Exact model ids, theme cosmetics, and CORS allowlist contents** are configuration, not
  invariants — only the behaviors (fallback, bounded timeout, never-`*` CORS) are.
