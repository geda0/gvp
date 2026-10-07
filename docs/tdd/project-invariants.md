# Project invariants

These are the rules the gvp portfolio system must ALWAYS uphold — the things that
must never silently break. For any new code path that touches one, the test that
proves it comes FIRST.

> **Honesty note (adoption bootstrap; updated 2026-06-25):** invariants **#1** (no secrets in
> the shipped frontend) and **#2** (API bases from meta tags / same-origin local fallback) are
> proven by `test/frontend-no-secrets.test.mjs` and `test/frontend-api-config.test.mjs`. Invariants
> **#3, #4, #5**
> (contact durability — landed via the ADR-0006 injectable-core seam) and **#6** (reduced
> motion) are proven by `node --test`; **#7** (every chat turn persisted with its terminal
> `status`) is proven by `docker/chat/tests/test_turn_persistence.py` (all six
> {ok,error,timeout}×{stream,non-stream} cells); **#9** (first-chunk **retryable** failure →
> fallback; committed after first chunk) is **partly** proven by
> `docker/chat/tests/test_gemini_routing.py` — `429` and `503` → fallback on `astream` + `ainvoke`,
> the 429-only stickiness split on both, committed-midstream propagation, non-rate-limit not
> retried (`astream` only), distinct-model guard — **with five clauses still unpinned; see the
> #9 note below and #9's own CONFORMANCE paragraph**; **#10** (Live voice timbre pinned to the
> deep/slow male `Charon` preset + cadence directive) is now proven by
> `docker/chat/tests/test_live_voice_timbre.py` (all four clauses — default → `Charon`,
> deliberate override honored verbatim, prebuilt voice on the connect config's `speech_config`,
> and the prompt-side cadence directive; the AUDIO response-modality half by
> `test_live_handshake.py`). **#8** is now **fully proven** — the persisted `timeout` row is
> asserted on both paths AND the `providers.py` cap clause (28s Gemini default +
> 55s-API-Gateway-ceiling clamp of an over-large override) is proven by
> `test_providers.py::test_gemini_timeout_clamped_to_55s_ceiling`. **#11** (each branch ships its
> own environment's API bases — `main`=prod, `agent`=staging, diverging only on the
> `gvp:*-api-url` metas) is proven by `test/frontend-api-url-env-guard.test.mjs`, born from the
> 2026-06-04 staging-on-prod fast-forward incident (hotfixed in `843e648`).
> **Proven set as of 2026-06-25: SIXTEEN — #1–#16** — but that sentence has since expired twice and
> is kept with its correction attached rather than rewritten, because "all N proven" is the exact
> shape of claim that goes stale silently: **#9 was re-opened on 2026-10-06 by ADR-0023 and is now
> only PARTLY proven** (five named unpinned clauses in its own CONFORMANCE paragraph), and #17/#18
> were added with their own conformance paragraphs. The honest read today: **#1–#8, #10–#16 proven;
> #9 partly; #17 partly; #18 not at all.** Every CHAT-layer invariant (#7, #8, #9, #10, #13, #14,
> #15) and every `[app]` invariant (#1–#6, #11, #12) has at least one real pin. **#12–#15 are the 2026-06-25 pass** over
> load-bearing behavior shipped since 2026-06-04: **#12** (the living theme is a pure, bounded,
> continuous function of local time) is proven by `test/theme-time.test.mjs`; **#13** (chat falls
> back on a primary first-chunk TIMEOUT, not only a rate-limit — the stall sibling of #9) is proven
> by `docker/chat/tests/test_gemini_routing.py`; **#14** (instant alerts are best-effort and can
> never raise into / delay a chat turn) is proven by `docker/chat/tests/test_alerts.py`; **#15**
> (the chat-knowledge build is idempotent on committed source and `resume-access` stays
> `navigate_to_section`) is proven by `test/chat-knowledge-build.test.mjs` (ADR-0012). Each claim is
> a characterization test that fails CI on regression and belongs on the upgrade backlog. Each claim
> is cited to `file:line` so the navigator can confirm it against the code, not take it on faith.
> Line numbers are from the state of the repo at adoption and may drift; treat the cited
> function/symbol as the anchor.
>
> **#9 HAS OPEN CLAUSES (2026-10-06, ADR-0023):** its old wording — *"Non-rate-limit
> errors are not retried"* — was itself the defect. A Gemini `503 UNAVAILABLE` re-raised instead
> of reaching the healthy fallback, on ~1 request in 3 against the prod host. **The `503` half
> now SHIPPED and is pinned on both paths** (`f1a214d`, `0227545`, `fff8bc9`, `3daf8d7`; suite
> 138), together with the 429-only stickiness split — an earlier version of this note and of #9's
> conformance paragraph said it was unimplemented, which is **no longer true**. But the amended
> trigger is **not fully pinned**: only `429` and `503` are exercised, the predicates' superset
> clause is unasserted, `ainvoke`'s non-retryable side is unfenced, and the §5/§6 event types and
> counters do not exist at all — so a retried 503 still fires a **mislabelled**
> `chat_primary_rate_limit`. **Five named unpinned clauses live in #9's own CONFORMANCE paragraph;
> read it before citing #9, and do not infer coverage from "the 503 fix shipped."**
>
> **Added since, and counted separately (2026-10-06):** **#17** (ADR-0020) and **#18** (ADR-0022
> §24.7) each carry their **own conformance paragraph**, because neither is fully proven — the
> "all sixteen" sentence above is scoped to **#1–#16** and must not be read as covering them.
> **#18 is the first invariant admitted with no test at all**, deliberately: the regression it
> names (a streaming route silently falling through a CDN onto a buffered origin) is live in
> infrastructure now, and recording the rule ahead of its pin is cheaper than discovering it in
> production. Its three candidate pins, and which one the architect prefers, are in the invariant.
>
> **Considered but NOT promoted (2026-06-25):** the voice-résumé safety net
> (`js/voice-resume-button.js`) and the empty-reply derivation (`js/chat-reply-text.js`) are pure,
> well-tested helpers (`test/voice-resume-button.test.mjs`, `test/chat-reply-text.test.mjs`), but a
> regression there degrades a single reply's copy — it is not a durability, safety, secret, or
> correctness defect — so they stay feature tests, not invariants. See "Out of scope."

## Invariants

1. **No secrets in the shipped frontend.** The browser bundle (HTML/CSS/JS) never
   contains the Resend, Gemini, or admin API keys; the only API-related values it
   ships are the two `<meta>` URLs and the public Google Analytics measurement ID.
   Keys live only in `.secrets/` (gitignored) / Secrets Manager and are injected into
   Lambda/ECS runtime env at deploy time.
   - Implemented by: `index.html:38-39` (only `gvp:contact-api-url` + `gvp:chat-api-url`
     meta tags; GA id `G-EYTRKC93DL` at `index.html:36` is a public measurement id, not
     a secret); secrets reach the backend only as SAM params —
     `aws/template.yaml:36` (`RESEND_API_KEY: !Ref ResendApiKey`),
     `aws/template.yaml:234` (`ADMIN_API_KEY: !Ref AdminApiKey`),
     `aws/chat-template.yaml:85` + `aws/chat-express-template.yaml:141`
     (`GEMINI_API_KEY: !Ref GeminiApiKey`; ECS Express Mode replaced the retired
     `chat-ecs-template.yaml` per ADR-0007 Phase 3/4); `.gitignore:34` excludes `.secrets/`. The
     admin key in `js/admin.js:106` is read from `sessionStorage` (operator types it at
     runtime), never embedded.
   - Proven by: `test/frontend-no-secrets.test.mjs` — scans `index.html`, `admin/index.html`,
     `css/`, and `js/` for Gemini (`AIza…`), Resend (`re_…`), and `sk-…` literals; asserts
     `index.html` remote API config is only the two `gvp:*-api-url` meta tags plus the public GA
     measurement id; asserts `admin/index.html` carries only `gvp:contact-api-url`. Run:
     `node --test`.

2. **All API base URLs come from meta tags, never a hardcoded cross-origin host.**
   Every frontend network call resolves its base from a `<meta>` tag via
   `site-config.js`; when the tag is empty the only fallback is a **same-origin**
   `/api/*` path (and only on `localhost`/`127.0.0.1`). No module hardcodes a remote
   API hostname. The voice WebSocket URL is taken from the server's minted session
   response body, not constructed against a hardcoded host. (Under browser-direct voice —
   ADR-0007 Phase 1 — that body's `websocketUrl` is Google's Live WSS endpoint carrying a
   single-use ephemeral token; the contract is unchanged: the URL comes from the response,
   never a string literal.)
   - Implemented by: `js/site-config.js:5-15` (`resolveApiUrl` → `contactApiUrl`,
     `chatApiUrl`; local-only `/api/contact` / `/api/chat` fallbacks);
     consumers `js/contact.js:1,27,107`, `js/chat.js:4,300,1109`,
     `js/chat-live.js:7,245`; voice WS URL from response body at
     `js/chat-live.js:131-132,1012-1013,1090`.
   - Proven by: `test/frontend-api-config.test.mjs` — no hardcoded cross-origin `http(s)://`
     host literals in `js/` (CDN allowlist only); `contact.js` / `chat.js` / `chat-live.js`
     import `contactApiUrl` / `chatApiUrl` from `site-config.js`; `site-config.js` pins meta
     names + localhost-only `/api/*` fallbacks; voice uses `websocketUrl` from the session body
     (`new WebSocket(websocketUrl)`, never a string-literal WS URL). Run: `node --test`.

3. **A valid contact submission is durable before the API returns success.** On the
   ingress path a valid message is written to DynamoDB (`PutItem`, idempotency-guarded)
   AND enqueued to SQS, and only then is `200 { persisted, queued }` returned; if either
   the persist or the enqueue throws, the endpoint returns `500` (never a false success).
   - Implemented by: `aws/src/contact-ingress.js:44-68` (await `PutCommand` with
     `ConditionExpression: attribute_not_exists(id)`, then await `SendMessageCommand`,
     then return 200; the surrounding `try/catch` returns 500 at lines 69-77).
   - Proven by: `test/contact-ingress-core.test.mjs` (via the `createIngressHandler` core) —
     *"valid submission persists then enqueues before returning 200"* (asserts persist→enqueue
     order then 200), *"persist failure returns 500 and does not enqueue"*, *"enqueue failure
     after persist returns 500"*, plus the parse-400 / validate-400 / missing-env-500 /
     method-gate branch tests. The `attribute_not_exists(id)` idempotency guard lives in the
     S5 composition root's real `PutCommand` — verified by ADR-0004/0006 review, not node:test.
     Run: `node --test`.

4. **The contact honeypot silently discards bots with a 200 and no email.** When the
   hidden `company` field is filled, ingress returns `200 { ok, persisted, delivery }`
   without writing to DynamoDB or enqueuing SQS, so no delivery email is ever sent for
   that submission.
   - Implemented by: `aws/src/contact-ingress.js:31-33` (early return when
     `record.company` is truthy, before the persist/enqueue block); `company` is
     captured into the record at `aws/src/common/contact-shared.js:62,74`.
   - Proven by: `test/contact-ingress-core.test.mjs` — *"honeypot company field is silently
     discarded with 200 and no IO"* (200, neither persist nor enqueue called) + *"honeypot 200
     body is a hollow decoy with no id"* (the decoy success body carries no message `id`).

5. **Contact delivery retries and dead-letters instead of dropping.** A queued message
   that fails to send is retried via SQS redrive up to 5 receives, then moved to the
   DLQ; DLQ depth raises a CloudWatch alarm to the ops email. The sender treats an
   already-`sent` row as a no-op (safe redelivery).
   - Implemented by: `aws/template.yaml:143-148` (`RedrivePolicy maxReceiveCount: 5` →
     `ContactDeliveryDlq`), `aws/template.yaml:157-172` (`ContactDlqAlarm` →
     `ContactAlarmTopic` email); sender idempotency + status transitions in
     `aws/src/contact-sender.js:72` (skip when `status === 'sent'`), `88` (markSent),
     `92` (markFailed then rethrow so SQS retries).
   - Proven by: `test/contact-sender-core.test.mjs` (via the `createSenderHandler` core) —
     *"sender sends then marks the row sent"*, *"sender skips already-sent or missing rows with
     no IO"* (no duplicate email on redelivery), *"sender marks failed and rethrows when send
     fails"* (re-throw → SQS redelivers). The SQS redrive (`maxReceiveCount:5`) → DLQ →
     `ContactDlqAlarm` → SNS half is infra (`aws/template.yaml`) — verified by ADR-0004 review,
     not node:test.

6. **Reduced motion is honored by the canvas animation.** When
   `prefers-reduced-motion: reduce` is set, star/snow counts and trail alpha shift to the
   reduced tier (scaled, capped, floored); the default (non-reduced) experience also
   eases a fixed fraction toward those reduced values. *(PROVEN)*
   - Implemented by: `js/starfield-prefs.js:40-84`
     (`starCountForPreference`, `snowflakeCountForPreference`,
     `spaceTrailAlphaForPreference`, `defaultExperience*`, `*SpeedMultiplierForPreference`)
     against constants at `js/starfield-prefs.js:6-31`.
   - Proven by: `test/starfield-reduced-motion.test.mjs` (e.g. *"reduced-motion star
     count scales and caps"*, *"reduced-motion star count respects floor when full count
     is tiny"*, *"space trail alpha: default vs reduced"*, *"default experience star
     count eases 15% toward reduced count"*). Run: `npm run test:reduced-motion`.

7. **Every chat text turn is persisted before the response returns — success, error,
   or timeout.** Both the non-streaming (`ainvoke`) and streaming (`_chat_stream`)
   paths call `_persist_text_turn(...)` on the terminal state, writing a row tagged with
   `status` (`ok`/`error`/`timeout`) and, on failure, `errorCode`/`errorMessage`, so a
   failed attempt is visible in the admin panel instead of vanishing into logs. (If the
   transcript store is unconfigured the persist is a deliberate no-op — see Out of
   scope.)
   - Implemented by: non-stream success/timeout/error persists at
     `docker/chat/app/main.py:842-847` (ok), `:799-808` (timeout, status `timeout`),
     `:823-832` (error, status `error`); stream persists every terminal state at
     `docker/chat/app/main.py:931-941`; persistence body
     `docker/chat/app/main.py:664-732`; row write
     `docker/chat/app/transcript_store.py:113-144`.
   - Proven by: `docker/chat/tests/test_turn_persistence.py` — non-stream **error** (S1
     *test_non_stream_error_persists_one_error_row*: `status=='error'` + populated
     `errorCode`/`errorMessage`) and **timeout** (S2 *test_non_stream_timeout_…*:
     `status=='timeout'` + `errorCode=='upstream_timeout'`); streaming **ok** (S3
     *test_streaming_success_…*: `status=='ok'`, `stream is True`), **error** (S4
     *test_streaming_midstream_error_…*: `status=='error'` + `errorCode`) and **timeout** (S5
     *test_streaming_timeout_…*: `status=='timeout'` + `errorCode=='upstream_timeout'`); and
     non-stream **ok** (*test_non_stream_success_persists_one_ok_row*: `status=='ok'`,
     `stream is False`) — each asserts exactly one persisted row via a stub store. That is all six
     {ok,error,timeout}×{stream,non-stream} cells, and **all six now assert the persisted
     `turn['status']` directly** (the prior non-stream-ok soft spot — which only asserted HTTP
     `status_code==200` via `test_transcript_store.py::test_chat_persists_transcript_turn` — was
     closed 2026-06-04). Run: `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

8. **Each chat provider call is bounded by a timeout.** Non-streaming calls are wrapped
   in `asyncio.wait_for(..., provider_timeout_seconds)` (504 + persisted `timeout` row on
   expiry); the streaming path enforces the same single end-to-end deadline with
   per-chunk `asyncio.wait_for`. The Gemini timeout default (28s) is capped below the API
   Gateway integration ceiling.
   - Implemented by: non-stream deadline `docker/chat/app/main.py:791-794`; stream
     deadline `docker/chat/app/main.py:864-884` (`deadline = monotonic()+timeout_s`,
     per-chunk `wait_for(remaining)`); timeout resolution + caps
     `docker/chat/app/providers.py:23-47` (Gemini default 28s, ceiling 55s).
   - Proven by: FULLY — the persisted `timeout` **row** on both paths by
     `docker/chat/tests/test_turn_persistence.py` (S2 non-stream and S5 streaming per-chunk
     `wait_for` deadline → `status=='timeout'`, `errorCode=='upstream_timeout'`); the 504
     mapping by `test_readiness_timeout.py::test_chat_timeout_maps_to_504`; the 28s Gemini
     default by `test_providers.py::test_gemini_default_upstream_timeout`; and the
     **55s-API-Gateway-ceiling cap** by
     `test_providers.py::test_gemini_timeout_clamped_to_55s_ceiling` (a `GEMINI_TIMEOUT_SECONDS`
     of `120` is clamped to `55.0`, while a sub-ceiling `40` passes through unchanged — the clamp
     caps but does not floor). No open clause remains.
     Run: `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

9. **On a RETRYABLE upstream failure of the first attempt the chat chain transparently falls
   back to the secondary model; once any chunk has flushed it is committed.**
   **AMENDED 2026-10-06 by ADR-0023** — the trigger was "a first-chunk **rate limit**" and this
   invariant used to state *"Non-rate-limit errors are not retried."* **That sentence was the bug:**
   a Gemini `503 UNAVAILABLE` re-raised on the first attempt and the healthy fallback was never
   tried, on roughly **1 request in 3** against the prod host. The trigger is now an **enumerated
   retryable set**, of which the rate limit is a subset. `GeminiRoutingChain` tries the primary
   model first; if the FIRST attempt fails **retryably** it retries on the fallback; once a chunk
   has been yielded, mid-stream errors propagate rather than restart. Primary and fallback model
   ids must differ.
   **RETRYABLE — the exact set (ADR-0023 §4.1), keyed on the status carried by the UPSTREAM
   exception:** `429`/`RESOURCE_EXHAUSTED`, `503`/`UNAVAILABLE`, `500`/`INTERNAL`,
   `504`/`DEADLINE_EXCEEDED`, `502`.
   **NOT RETRYABLE, and never tried on the second model (ADR-0023 §4.2):**
   `401`/`403`/`UNAUTHENTICATED`/`PERMISSION_DENIED` (**both models share one API key, so the
   retry cannot succeed** — the clause a naive widening breaks), `400`/`INVALID_ARGUMENT`, `413`,
   `422`, any other 4xx, `404`/`NOT_FOUND` (a bad model id must stay loud, not hide behind a
   silent fallback), and **anything with no extractable status — unknown is not transient,
   default deny.**
   **The retry decision and the quota bookkeeping are SEPARATE, and that separation is the
   invariant** (ADR-0023 §3, §4.3): retryability is asked of `is_upstream_retryable`, while
   `note_primary_rate_limited()` — which flips `prefer_fallback_first` for the **rest of the UTC
   day** — is called for a **`429` only**. A 503 retries the turn and leaves the routing
   preference untouched: it is a statement about Google's capacity in that instant, not about our
   quota, and it **fails fast**, so re-discovering it next turn is cheap. The rule generalises —
   **stickiness is earned by the cost of RE-DISCOVERY, not by the severity of the error**, which
   is why #13's 12-second stall is sticky and this is not.
   **Three outcomes, three event types** (ADR-0023 §5, applying ADR-0020 §5.13's *one type = one
   priority*) — **NONE of this is implemented; see CONFORMANCE clause 4, and do not cite this
   paragraph as describing current behavior**: a retried 503 whose turn then **succeeds** fires
   **`chat_primary_unavailable` (P2)** — firing the P1-shaped `chat_model_error` on a turn that succeeded would be a false
   alarm, and silence would hide a real degradation; a retryable failure on the **last** model
   fires the existing **`chat_upstream_unavailable` (P1)**; and **`chat_model_error` (P1)** keeps
   its exact meaning — a **non-retryable** error that ended the turn — so its blast radius
   shrinks, which is the point.
   **CONFORMANCE (rewritten 2026-10-06 after the slices landed; the paragraph it replaces said
   the retryable-set half was unimplemented, which is now false on both paths).** What holds and
   is pinned: the **commit-on-first-chunk** half; the **503 → fallback** retry on **both**
   `astream` and `ainvoke`; and the **429-only stickiness** split on both. `is_upstream_retryable`
   exists (`upstream_errors.py:111-125`) and is the retry predicate at
   `gemini_routing.py:306` (`ainvoke`) and `:394` (`astream`); the quota bookkeeping is a separate
   guarded call at `:313-314` and `:401-402` (`and is_upstream_rate_limit(e)`). Landed in
   `f1a214d` (astream predicate + bookkeeping split), `0227545` (ainvoke), `fff8bc9` and `3daf8d7`
   (the two stickiness pins). Baseline **138 passed**.
   **What is NOT pinned, listed so the gap is visible rather than inferred — this invariant may
   not be read as claiming any of the five below, and the conformance paragraph may not be widened
   until the matching slice is green.** Each was re-verified by mutation on 2026-10-06 against
   baseline 138:
   1. **The retryable SET is only exercised at `429` and `503`.** `500`, `502` and `504` — and
      the status names `INTERNAL` and `DEADLINE_EXCEEDED` — are in the enumerated set above and
      **unfenced on both paths**. Mutation: shrinking `_RETRYABLE_UPSTREAM_CODES` to `{429, 503}`
      and the status-name set to `{RESOURCE_EXHAUSTED, UNAVAILABLE}` leaves the suite **138
      green** — three of the five codes and two of the four status names can be deleted in one
      edit with nothing going red. (By contrast the two covered corners are real: dropping
      `429`/`RESOURCE_EXHAUSTED` fails 4 tests, and dropping `503`/`UNAVAILABLE` fails the other
      4.)
   2. **The superset clause is unasserted.** ADR-0023 §3 requires
      `is_upstream_retryable` ⊇ `is_upstream_rate_limit` — *"a contract clause worth its own test,
      because it is what stops the two predicates drifting."* **No test asserts the containment.**
      It happens to hold today, and its `429` corner is incidentally covered by clause 1's
      mutation, but the two predicates can still drift apart on every other code in one edit.
      There is also **no direct unit test of `is_upstream_retryable` at all** —
      `tests/test_upstream_errors.py` covers only `is_upstream_rate_limit` and
      `upstream_error_body`; the new predicate is reached exclusively through routing tests.
   3. **The non-retryable side of `ainvoke` is entirely unfenced.** There is no `ainvoke`
      analogue of `test_astream_non_ratelimit_error_not_retried`, so on the **non-streaming**
      path nothing pins `401`/`403`, `404`/`NOT_FOUND`, or the **default-deny-on-no-extractable-
      status** rule — the three clauses of §4.2 that a naive widening breaks. The streaming path
      has exactly **one** test standing between the shared API key and a doubled-latency auth
      retry.
   4. **The three event types of §5 are NOT implemented — and the current alerting is
      factually wrong for a 503.** Both retry paths still log `gemini rate_limited` /
      `gemini stream rate_limited` (`gemini_routing.py:315-318`, `:403-406`) and fire
      **`chat_primary_rate_limit`** (`:326-329`, `:414-417`) on a 503 that was never a rate
      limit. **`chat_primary_unavailable` (P2) does not exist** — it appears nowhere in
      `docker/chat/app/`, only in ADR-0023 and this document. So a retried 503 is observable only as a mislabelled
      rate-limit alert, and §6's countability consequence is unmet.
   5. **§6's countability debt is unpaid, so a retried 503 leaves no durable record at all.**
      `note_primary_unavailable()` / `primary_unavailable_hits_today()` do not exist in
      `gemini_limit_state.py`, and the recommended `upstream_unavailable` body code
      (`{500,502,503,504}` → a distinct `errorCode`, §6) does not exist in `upstream_errors.py`.
      ADR-0023 accepted the trade **"observability instead of state"**; the state half is gone
      (correctly — clause 4's stickiness split is pinned) and the observability half was never
      built. Today a 503 is counted nowhere and named wrongly. **Nothing here may be read as
      claiming that a degraded primary is visible to an operator.**
   - Implemented by: `docker/chat/app/gemini_routing.py:333-427` (`astream`: fall back only when
     the first `__anext__` fails; commit after first yield), `:259-331` (`ainvoke` analogue);
     the retry decision `:394` / `:306` (`if not is_upstream_retryable(e): fire_alert(
     'chat_model_error', …); raise`) and the **separately guarded** quota bookkeeping `:401-402` /
     `:313-314` (`if model_id == self.primary_id and is_upstream_rate_limit(e):
     note_primary_rate_limited()`); `docker/chat/app/upstream_errors.py:111-125`
     (`is_upstream_retryable` — keyed on `genai_errors.APIError.code`/`.status` then
     `_extract_status_code_from_chain`, **never** on the status `upstream_error_body` returns,
     because that function maps auth `401/403` → **502**; default deny when no status is
     extractable), `:105-108` (`_RETRYABLE_UPSTREAM_CODES = {429, 500, 502, 503, 504}` and
     `_RETRYABLE_UPSTREAM_STATUS_NAMES = {RESOURCE_EXHAUSTED, UNAVAILABLE, INTERNAL,
     DEADLINE_EXCEEDED}` — **three fifths of this set is unfenced, see CONFORMANCE clause 1**),
     `:94-98` (`is_upstream_rate_limit` — now **bookkeeping only**); daily routing state
     `docker/chat/app/gemini_limit_state.py:35-69`; distinct-model guard
     `docker/chat/app/providers.py:200-201`.
   - Proven by: `docker/chat/tests/test_gemini_routing.py` — asserting the
     routed-output / propagation contract (not call counts): first-chunk rate-limit → fallback
     on **streaming** (*test_astream_first_chunk_ratelimit_falls_back*: primary `astream` raises
     `UpstreamError(429)` before any yield → joined content `== "from-fallback"`) and
     **non-streaming** (*test_ainvoke_ratelimit_falls_back*: `ainvoke` 429 → `result.content ==
     "from-fallback"`); the **503 sibling on both paths**
     (*test_astream_first_chunk_503_unavailable_falls_back* and
     *test_ainvoke_503_unavailable_falls_back*: `UpstreamError(503)` before any yield →
     `"from-fallback"`; the 503 is carried **on the exception**, deliberately not only via
     `upstream_error_body`, which maps it to a 502/`model_error` body — so a predicate reading
     the MAPPED status is not reading the upstream one); the **429-only stickiness split** on
     both paths (*test_a_503_does_not_demote_the_primary_for_the_day_but_a_429_does* and
     *test_a_non_streaming_503_does_not_demote_the_primary_for_the_day_but_a_429_does*: after a
     503 turn, `prefer_fallback_first() is False` and `primary_rate_limit_hits_today() == 0`;
     after a 429 turn on the same chain, `True` and `== 1` — both halves driven through a real
     turn, never by calling the bookkeeping function directly, and each test calls
     `reset_for_tests()` and asserts the clean day so a leaked flip cannot make it pass
     vacuously); committed-after-first-chunk propagation
     (*test_astream_committed_midstream_error_propagates*: yields `"from-primary"` then raises →
     `RuntimeError` propagates, `"from-primary"` seen, `"from-fallback"` NOT seen — no fallback
     restart); non-rate-limit first-chunk error not retried
     (*test_astream_non_ratelimit_error_not_retried*: plain `RuntimeError` before any yield
     propagates, `"from-fallback"` NOT seen); and the distinct-model guard
     (*test_distinct_model_guard_rejects_identical_ids*: `build_llm_runnable` rejects identical
     `GEMINI_MODEL`/`GEMINI_FALLBACK_MODEL`, builds a `GeminiRoutingChain` for distinct ids).
     **Mutation record (2026-10-06, baseline 138 passed; each run alone and reverted):** the
     `astream` predicate reverted to `is_upstream_rate_limit` fails *only*
     *test_astream_first_chunk_503_unavailable_falls_back*; the `ainvoke` predicate reverted fails
     *only* *test_ainvoke_503_unavailable_falls_back*; the bookkeeping guard reverted at `:401`
     fails the `astream` stickiness pin and at `:313` the `ainvoke` one — **before those two pins
     existed BOTH guard reverts survived at 137 green**, which is why they are the part of this
     invariant most worth re-reading. A predicate written against the **mapped** status (the
     ADR-0023 §3 auth trap: `upstream_error_body` maps `401/403` → `502`, and `502` is in the
     retryable set) fails **exactly one** test —
     *test_astream_non_ratelimit_error_not_retried* — and it catches the trap only
     **transitively**, because a plain `RuntimeError` also maps to `502`. **No test in the suite
     uses a real `401`/`403` on a routing path**, and `ainvoke` has no analogue at all
     (CONFORMANCE clause 3). So §3's trap is fenced on the stream path by a single incidental
     test, not by two and not on purpose.
     Run: `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

10. **The Gemini Live voice timbre is pinned to a deep, slow male preset.** Every minted
    Live session sets `speech_config` to a prebuilt voice defaulting to **`Charon`**
    (deep, measured male), and the voice-mode system instruction opens with a
    deep/calm/measured-cadence directive (Gemini Live has no speech-rate knob; pacing is
    steered by the prompt). Changing the voice is a deliberate `CHAT_LIVE_VOICE` override,
    not an accident.
    - Implemented by: `docker/chat/app/live_gemini.py:87-99` (`_live_voice_name()`
      defaults to `Charon`), `:108-121` (`speech_config` →
      `PrebuiltVoiceConfig(voice_name=...)` on the `LiveConnectConfig`); cadence directive
      in `docker/chat/app/knowledge_context.py` `build_live_system_instruction` (voice
      rules "speak with a deep, calm, measured cadence …", landed in commit `b6a64b3`);
      surfaced to admin as `liveVoiceName` at `docker/chat/app/main.py:642-657`.
    - Proven by: `docker/chat/tests/test_live_voice_timbre.py` — all four clauses, calling the
      pure resolver / config builders directly (no session minting, client, or network):
      **default → `Charon`** (*test_live_voice_defaults_to_charon*: with `CHAT_LIVE_VOICE` cleared,
      `_live_voice_name() == 'Charon'`); **deliberate override honored verbatim**
      (*test_live_voice_override_is_honored*: `CHAT_LIVE_VOICE='Orus'` → `_live_voice_name() ==
      'Orus'`, not coerced back to the default); **prebuilt voice on the connect config**
      (*test_connect_config_carries_prebuilt_charon_voice*: `_live_connect_config(...)` →
      `speech_config.voice_config.prebuilt_voice_config` is a `types.PrebuiltVoiceConfig` with
      `voice_name == 'Charon'`); and the **prompt-side cadence directive**
      (*test_live_system_instruction_has_cadence_directive*: `build_live_system_instruction(...)`
      with `CHAT_VOICE_SYSTEM_APPEND` cleared contains the stable substring `'deep, calm, measured
      cadence'`). The **AUDIO response-modality** half of the same connect config is proven by
      `test_live_handshake.py` (`responseModalities == ['AUDIO']`), so the voice-timbre file scopes
      to the voice/cadence contract. _NON-blocking by-design carve-outs (tdd-critic, backlogged
      OPTIONAL): the override is echoed for ANY opaque value (no deep/slow-male allowlist — the
      qualifier is documentary), and the preset + cadence prose are pinned independently rather than
      coupled against drift (ADR-0003 says they "must move together")._ Run: `cd docker/chat &&
      PYTHONPATH=. python3 -m pytest tests -q`.

11. **Each branch ships its own environment's API bases; `main` (prod) and `agent` (staging)
    diverge ONLY on the `gvp:*-api-url` metas.** The committed `index.html` / `admin/index.html`
    on `main` carry the PROD hosts (`lwi0vmdpb5.execute-api…` contact +
    `chat-api.marwanelgendy.link` chat) and NEVER a staging host; on `agent` the inverse
    (`fvfqpef8kb.execute-api…` contact + `chat-api-stage.marwanelgendy.link` chat). Amplify serves
    the committed HTML as-is (there is no `amplify.yml`) and the deploy workflows run
    `SYNC_API_URLS=0`, so the committed meta value is load-bearing — a staging host on `main`
    publishes the staging backends to production (the 2026-06-04 `agent`→`main` fast-forward
    incident, hotfixed in `843e648`).
    - Implemented by: `index.html:38-39` + `admin/index.html:14` (prod metas on `main`);
      `scripts/sync-site-api-urls.mjs` rewrites the metas per environment only when a deploy runs
      with `SYNC_API_URLS=1` — the workflows keep `SYNC_API_URLS=0`, so the value shipped is the
      committed one.
    - Proven by: `test/frontend-api-url-env-guard.test.mjs` — environment-gated
      (`GVP_EXPECTED_ENV=prod|stage` explicit, else `GITHUB_REF_NAME` `main`→prod / `agent`→stage,
      else skipped, so it never fails on a feature branch or a plain local `node --test`). For the
      target env it asserts the `index.html` + `admin/index.html` contact/chat meta HOSTS are that
      env's hosts and carry NO host from the other env (the host, not the path, is pinned — the
      incident was a host swap). Wired as an explicit fail-fast step in `deploy-prod.yml`
      (`GVP_EXPECTED_ENV=prod`) and `deploy-staging.yml` (`GVP_EXPECTED_ENV=stage`), and it also
      rides the existing CI `node --test` via `GITHUB_REF_NAME`. Run:
      `GVP_EXPECTED_ENV=prod node --test test/frontend-api-url-env-guard.test.mjs`.

12. **The living theme is a pure, bounded, continuous function of local time.** `[app]`
    The time-of-day engine maps one scalar (local wall-clock hours) to the sky gradient,
    the canvas-scene weights (`star`/`sun`/`firefly`/`ground`), and which chrome palette
    to apply — with **no DOM, no imports, no side effects**. Every scene weight stays in
    **[0,1]** across the whole day; the cycle is **continuous** across every keyframe
    boundary AND across the midnight wrap (no visible jump at 0↔24); the sky/scene/chrome
    are a deterministic function of the hour alone; and out-of-range / nullish inputs are
    clamped, never thrown. (Reduced-motion easing of the resulting star/snow counts is
    owned by #6, not here — this engine has no animation.)
    - Implemented by: `js/theme-time.js:14-27` (the ascending `KEYFRAMES` + the virtual
      `h=24` wrap endpoint that reuses midnight); `:30-34` (`clampHours` wraps into
      `[0,24)`, non-finite → 0); `:66-88` (`_segmentAt` + `sceneParamsAt` — `_lerp` between
      the two bracketing keyframes, all weights in `[0,1]`); `:91-115` (`skyStopsAt` /
      `skyGradientAt` interpolate the hex stops, `chromeThemeAt` picks `garden`/`space` off
      `sun ≥ star`); consumed (not duplicated) at `js/starfield.js:14,380` (`import
      { sceneParamsAt }` → `sceneParamsAt(currentTimeHours())`).
    - Proven by: `test/theme-time.test.mjs` — *"every scene param stays within [0,1] across
      the whole day"* (steps `h` 0→24 by 0.25, asserts each weight in `[0,1]`), *"scene
      params are continuous — no jumps across a keyframe boundary"* (11.98 vs 12.02 within
      ε), *"scene params wrap continuously across midnight"* (23.98 vs 0.02 within ε),
      *"scene params hit their keyframe extremes"*, *"skyStopsAt … matches keyframes
      exactly"*, *"chromeThemeAt picks garden by day and space by night"*, and *"inputs are
      defensive: nullish / out-of-range hours never throw"*. Run: `node --test`.

13. **On a primary first-chunk TIMEOUT (a stall) the chat chain falls back too — not only
    on a rate limit; and the FINAL attempt is uncapped.** `[chat]` The stall sibling of #9:
    if the primary produces no first chunk within the per-attempt first-chunk budget
    (`min(GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS|12s, 60% of the request deadline)`),
    `GeminiRoutingChain` abandons it and tries the fallback on **both** `astream` and
    `ainvoke`. The timeout is recorded (`note_primary_timed_out`) so subsequent turns
    `prefer_fallback_first` — mirroring the 429 cooldown — and visitors stop eating the
    stall on every turn. The **last** model in the order runs WITHOUT the per-attempt cap
    (only the overall request deadline #8 governs it), so a slow-but-valid fallback still
    answers. Commit-on-first-chunk (#9) is unchanged: once a chunk yields, mid-stream
    errors propagate.
    - Implemented by: `docker/chat/app/gemini_routing.py:35-46` (`_first_chunk_timeout` —
      12s default, capped at 60% of the total budget); `:355-385` (`astream`: `is_last` →
      bare `__anext__`, else `wait_for(_first_chunk_timeout)`; on `TimeoutError`
      `_aclose_quietly` the stalled iterator, `note_primary_timed_out()`, `continue` to the
      fallback; re-raise when `is_last`); `:273-300` (`ainvoke` analogue); the daily
      prefer-fallback flip in `docker/chat/app/gemini_limit_state.py:55-63`
      (`note_primary_timed_out` sets `_prefer_fallback = True`).
    - Proven by: `docker/chat/tests/test_gemini_routing.py` —
      *test_astream_first_chunk_timeout_falls_back* (primary hangs → joined content `==
      "from-fallback"`), *test_ainvoke_timeout_falls_back* (non-stream analogue),
      *test_primary_stream_timeout_flips_prefer_fallback* (`prefer_fallback_first()` flips
      `False`→`True`, `primary_timeout_hits_today() == 1`),
      *test_final_attempt_first_chunk_is_uncapped* (fallback's first chunk arrives AFTER the
      per-attempt budget but is still awaited — the last attempt is not time-boxed), and
      *test_primary_timeout_then_fallback_failure_exhausts* (primary stalls → fallback
      fails → error propagates, and only the PRIMARY's timeout is recorded). Run: `cd
      docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

14. **Operational alerting is best-effort: an instant alert can never raise into — or
    delay — a chat turn.** `[chat]`
    **AMENDED 2026-10-07 by ADR-0022 §25.4a — read this with #19.** This invariant is a **safety**
    contract (what alerting may do *to a turn*), **not a liveness** one (whether an event reaches a
    human). "Best-effort" bounds the failure **mode**, not the failure **rate**: it licenses
    occasional loss on a configured host; it does **not** license a production host on which the
    gate is unconditionally `False`, which is *certainty* of non-delivery. **MEASURED 2026-10-07:**
    `alerts_enabled()` is `False` on both deployed stage Lambda chat hosts. Delivery is covered by
    **#19**; no word of #14 below is superseded.
    `fire_alert` is fire-and-forget: it is a no-op when
    unconfigured (ships **dark**). **Correction, 2026-10-07:** the gate is **three conjuncts over
    five names**, not two — a destination (`CHAT_ALERT_EMAIL` **or** `CONTACT_REPORT_EMAIL`,
    `alerts.py:34-39`) **AND** a from-address (`CHAT_ALERT_FROM_EMAIL` **or** `CONTACT_FROM_EMAIL`,
    `:42-46`) **AND** `RESEND_API_KEY` (`:50`). This invariant previously listed only
    `CHAT_ALERT_EMAIL`/`CONTACT_REPORT_EMAIL` + `RESEND_API_KEY`, as the module docstring
    (`:10-12`) still does, so a reader who configured exactly those got a silent no-op anyway.
    It never raises in a sync (no-running-loop) context, it is throttled
    to one email per event type per cooldown window (`CHAT_ALERT_COOLDOWN_SECONDS`, default
    3600s), and the actual `_send` swallows EVERY exception. The request path schedules the
    send as a detached task and returns immediately, so a broken or slow alert provider can
    never block the turn the alert is about (the alerts fired from `gemini_routing.py`'s
    fallback/timeout branches must stay on this best-effort contract).
    - Implemented by: `docker/chat/app/alerts.py:53-54` (`alerts_enabled` gate),
      `:80-94` (`fire_alert` — early-return when disabled or throttled; `get_running_loop`
      `RuntimeError` → debug-log and return, never raise; `loop.create_task(_send(...))`
      detached), `:65-72` (`_should_send` per-event-type cooldown), `:106-137` (`_send`
      wrapped in `try/except Exception` — a failed/≥400 HTTP post is logged, never raised);
      callers `docker/chat/app/gemini_routing.py:292-326,376-411`.
    - Proven by: `docker/chat/tests/test_alerts.py` — *test_dark_by_default_is_no_op*
      (`alerts_enabled() is False` + `fire_alert` does not raise with no config/loop),
      *test_fire_alert_outside_loop_never_raises* (configured but no running loop → safe
      no-op), *test_send_failure_is_swallowed* (a `post()` that raises is caught inside
      `_send`, which completes normally), *test_throttled_per_event_type* (same type within
      cooldown sends once; a different type is independent), and
      *test_throttle_resets_after_cooldown*. Run: `cd docker/chat && PYTHONPATH=. python3 -m
      pytest tests -q`.

15. **The chat-knowledge artifacts are an idempotent rebuild of committed source, and
    `resume-access` routes to the on-site section.** `[chat]` Rebuilding
    `data/chat-knowledge/{faq,projects,roles,bio}.json` from the committed source
    (`build-chat-knowledge.mjs`'s `FAQ`, `data/projects.json`, `resume/resume.json`,
    `bio.source.json`) through the builder's OWN exported functions reproduces the committed
    artifacts **byte-for-byte** (`JSON.stringify(value, null, 2) + '\n'`) — a hand-edit to
    either side, or a no-op CLI letting them drift, is caught. The `resume-access` FAQ entry
    carries `trigger_tool: "navigate_to_section"` (NOT `open_resume`), pinning the
    agent-as-guide posture (ADR-0010/0012: guide on-site, never default to the résumé PDF).
    - Implemented by: `scripts/build-chat-knowledge.mjs` (exported `FAQ`, `buildProjects`,
      `buildRoles`; `main()` CLI side effect gated so the module imports purely — the seam
      ADR-0012 §AC-5 mandates); committed outputs in `data/chat-knowledge/` (the five files
      `bio.json`, `bio.source.json`, `faq.json`, `projects.json`, `roles.json`).
    - Proven by: `test/chat-knowledge-build.test.mjs` — *"rebuilding faq.json … equals the
      committed artifact (idempotent)"*, the `projects.json` / `roles.json` / `bio.json`
      passthrough analogues (each `serialize(builder(source)) === committed(name)`), and
      *"resume-access FAQ entry triggers navigate_to_section, never open_resume"*. Recorded
      in `docs/decisions/ADR-0012-team-tactics-claim-traceability-and-build-idempotency-test-seams.md`.
      Run: `node --test`.

16. **The daily-report email body is deterministic per day, and a Resend idempotency
    409 is a no-op success.** `[app]` `buildDailyReport({ day })` stamps a day-canonical
    `generatedAt` (`${day}T00:00:00.000Z`, not wall-clock), and the email's live smoke
    health card is projected to categorical form before rendering
    (`stabilizeSmokeForReport` keeps `overall`/`depth` + per-check `{ name, status, cost }`;
    drops `latencyMs`, timestamps, and `detail`) — so two builds of the same day + rows
    render **byte-for-byte-identical** HTML and text. The scheduled send is keyed
    `daily-report-${day}`, and Resend rejects that key with a *changed* body (HTTP 409
    `invalid_idempotent_request`); a non-deterministic body (the old `nowIso()` stamp +
    live smoke latencies) made every EventBridge retry 409 so the report **never reliably
    sent** (ADR-0014). The handler also treats that specific 409 as success
    (`isResendIdempotencyConflict`) — at-most-once delivery, never a thrown retry-storm;
    any other Resend error still throws. **The key is also scoped per ENVIRONMENT**
    (`reportIdempotencyKey(day, fn)` → `daily-report-${stack}-${day}`, stack derived from
    `AWS_LAMBDA_FUNCTION_NAME`) and **only the prod stack emails** (`reportEmailEnabled`
    false for `*-staging-*`) — because staging + prod share one Resend account and
    staging's cron fires ~14s first; an unscoped key let staging claim the day and 409
    prod's real report every day (ADR-0014 addendum — the actual root cause of the 0-data
    reports).
    - Implemented by: `aws/src/common/daily-report.js` (pinned `generatedAt`,
      `stabilizeSmokeForReport`, `isResendIdempotencyConflict`, `reportEnvScope`,
      `reportIdempotencyKey`, `reportEmailEnabled`) + the
      `aws/src/contact-daily-report.js` handler (stabilizes the live smoke; env-scoped
      key; emails only on the prod stack; swallows only the idempotency 409). Recorded in
      `docs/decisions/ADR-0014-daily-report-send-idempotency.md`.
    - Proven by: `test/daily-report.test.mjs` — *"renders byte-identical HTML and text
      across two builds"* (and the with-stabilized-smoke analogue), *"pins generatedAt to
      the report day rather than wall-clock"*, the `stabilizeSmokeForReport`
      projection / no-mutation / omit-when-empty tests, *"isResendIdempotencyConflict
      is true only for a 409 invalid_idempotent_request"*, *"reportIdempotencyKey is
      scoped per environment"*, and *"reportEmailEnabled is false for the staging stack"*;
      handler wiring pinned in `test/daily-report-wiring.test.mjs`. Run: `node --test`.

17. **THE RULE: anything persisted from an unauthenticated endpoint is bounded at the sink,
    before the write — in count, in size (bytes, not code points), in shape (depth) and in key
    space — and no caller-supplied value becomes a storage key.** `[chat]` Public sinks may not
    hand caller-controlled structure to storage.
    **CONFORMANCE, stated second and kept honest, because an earlier wording asserted the rule
    as if it were already fact** (refuted by the six-lens review of 2026-10-05, recorded as
    ADR-0020 §5): the rule is **met today** for **entry count** (≤10), **serialized JSON size
    per tool-call entry** (≤2 000 chars, re-checked), the **`transport` key space** (a 3-value
    set), the **`sessionId` partition key** (`max_length=128`, rejected not clamped) and — since
    commit `2018a40` — the **`createdAt` GSI sort key**, which is now **server-stamped**:
    `capturedAt` is gone from `LiveTranscriptTurn` and `main.py:1216` is `captured_at = now_iso`,
    matching what the text path has always done (`:771-773`). A caller may still *send*
    `capturedAt`; it is ignored, which is what made that a no-coordinated-deploy change.
    Since commit `bd84398` it is also met for the **nesting depth of `args` and `response`**
    (`_MAX_ARG_DEPTH = 6`, clamped by dropping the bulk) — **but only those two keys.**
    It is **NOT met** for the depth of a non-`str` **`id`**, which still reaches `json.dumps`
    and can raise out of the route (A4b, *Pending (4)* — the sharpest item left), nor for the
    **byte** size of the free-text fields, **turns / bytes per DynamoDB item**, or tool-name
    **cardinality across requests**. Those are decided in ADR-0020 §5 A4b, A2, A3 and A7, and
    listed as *Pending* below with their verification. **Nothing here may be read as claiming
    them until the matching slice is green — in particular this invariant does NOT claim that
    `sanitize_tool_calls` never raises.**
    `POST /api/live/transcript` takes **no credential of any kind**,
    so before `persist_turn` it clamps `transport` to the known set
    `{'live','relay','direct_google'}` — anything else (unknown, empty, wrong type) becomes
    `'live'` — and sanitizes `toolCalls` to **≤10 entries** (taken from the front, order
    preserved), **known keys only** (`id`/`name`/`args`/`response` — the union of what the
    text path and the voice client actually produce), and **≤2000 chars of serialized JSON
    per entry**. Two of those bounds behave differently on purpose, and the difference is
    the invariant:
    `name` is an **identity**, not a value — it is the admin tool histogram's key
    (`aws/src/contact-admin.js:373`) — so it is **never coerced**: a `name` that is
    missing, not a `str`, or empty after stripping **drops the whole entry**, because
    coercing it (`str(['a','b'])`) would mint a permanent dashboard row for a tool that
    never ran. A usable `name` is stripped and truncated to **60 chars**.
    `id` is a correlation **value** no consumer reads, so it is truncated (**100 chars**)
    rather than dropped. Over the JSON budget, the bulk keys (`args`, `response`) are
    dropped and the entry is kept as its identity `{id, name}` — never a truncated,
    unparseable JSON fragment — and then the budget is **re-checked**: an entry still over
    2000 chars (only reachable via a non-`str` `id`, which the 100-char truncation cannot
    reach) is dropped outright rather than persisted over budget.
    **Worst case per turn, derived rather than measured** (ADR-0020 §5 A8 — the earlier
    "19 930 chars" was a measurement of one payload, not a bound, and was wrong): every kept
    entry satisfies `len(json.dumps(entry)) <= _MAX_ENTRY_JSON_LENGTH` *by the final re-check*,
    so `toolCalls` per turn is at most
    `_MAX_TOOL_CALLS × _MAX_ENTRY_JSON_LENGTH` = **10 × 2000 = 20 000 characters**. Those are
    ASCII characters (`json.dumps` defaults to `ensure_ascii=True`), so the same number bounds
    **bytes**; and it bounds **DynamoDB** bytes too, because for every JSON type DynamoDB's
    documented accounting is ≤ its `json.dumps` character count (a string's UTF-8 bytes ≤ its
    escaped length; a map costs `3 + Σ(len(k)+1+v)` vs JSON's `2 + Σ(len(k)+4+v)`; a list costs
    `3 + Σ(v+1)` vs JSON's `2 + Σ(v+2)`; `true`/`null`/number literals cost ≤ their printed
    length). Check it by multiplying two constants — do not re-measure it.
    Unbounded values here are not merely an item-size problem:
    `aws/src/contact-admin.js:337,371-375` builds the admin rollup's `transports` /
    `toolHistogram` keyed **by the persisted value**, so without this bound an anonymous
    caller owns the key space of the owner's dashboard, plus DynamoDB item bloat and the
    retention/read cost that follows it. **Precisely how far that is closed:** key **length**
    (60 chars), key **shape** (a usable `str` or the entry is dropped) and key **count per
    request** (10) are bounded; tool-name **cardinality across requests** is not, and cannot be
    at this sink — cardinality is a cross-request property the sink cannot see, so it is
    read-side work by construction (ADR-0020 §5 A7a, carried by ADR-0021). `transport`
    cardinality *is* closed, because its key space is a fixed 3-value set.
    The sink **clamps rather than rejects** (the turn still persists, because the caller is
    a fire-and-forget `keepalive` beacon that never reads the response,
    `js/chat-live.js:671-700`).
    The rule the seam runs on is **clamp values, reject identities**: a clamped telemetry
    value is still a truthful, weaker fact, but a field that becomes a **storage key** must
    never be silently rewritten — truncating it makes every caller sharing that prefix
    collide into one partition key, silently merging distinct sessions into one row. So the
    identity field is bounded by **rejection**: `sessionId` carries `max_length=128` on all
    three request models that own one — `ChatRequest` (`main.py:163`), `LiveSessionRequest`
    (`:167`) and `LiveTranscriptTurn` (`:171`) — because it lands as the DynamoDB partition
    key `id` (`transcript_store.py:123`). All three are unauthenticated, so all three are
    capped; an over-long id is a **400** `validation_error`, not a 422, via this app's own
    `RequestValidationError` handler (`main.py:1266-1283`). Real ids are 32–36 chars
    (`js/chat.js:185-190`), so no legitimate client can trip it.
    - Implemented by: `docker/chat/app/turn_input.py` — a pure leaf module (no FastAPI, no
      boto3, no I/O) exporting `clamp_transport` / `sanitize_tool_calls`; the five bounds
      live there as **module-private** constants (`_MAX_TOOL_CALLS`, `_MAX_NAME_LENGTH`,
      `_MAX_ID_LENGTH`, `_MAX_ENTRY_JSON_LENGTH`, `_KNOWN_TRANSPORTS`) and the tests assert
      the numeric bounds from the outside, as behaviour — they are not imported as
      constants, so a bound and its test cannot be changed in one edit. Plus the
      `max_length=128` on the three `sessionId` fields. `docker/chat/app/main.py` is on
      `SECURITY_GLOB`, so it only imports (`main.py:25`) and calls the sanitizers
      (`main.py:1215-1216`), plus the one-token `Field` bound at `main.py:163`; keeping the
      logic in the ungated leaf is deliberate and is what keeps the reviewed
      security-surface diff to an import plus a call site. Recorded in
      `docs/decisions/ADR-0020-public-chat-surface-bounded-sinks.md`, which is also the
      architect clearance for that `main.py` edit.
    - Proven by (every case below exists today, by this name): six helper-level cases in
      `docker/chat/tests/test_turn_input.py` —
      *test_oversized_tool_calls_payload_is_capped_at_ten_entries* (the count cap);
      *test_single_hostile_entry_is_bounded_in_name_size_and_keys* (the 60-char `name`, the
      2000-char budget, and the key allowlist — a caller-invented key is stripped);
      *test_entry_over_the_json_budget_keeps_its_identity_and_drops_the_bulk*;
      *test_entry_identity_fields_cannot_defeat_the_json_budget* (the `id` bound — bulk
      hidden in `id` is bounded too);
      *test_tool_name_is_normalized_or_the_entry_is_dropped* (a padded name is stripped; a
      **list** `name`, a whitespace-only `name` and a **missing** `name` each drop the entry
      — the never-coerce rule); and
      *test_caller_invented_transport_is_clamped_to_a_known_value* (`'direct_google'`
      round-trips; an invented label becomes `'live'`).
      **Nesting depth of `args` / `response`** (A4, commit `bd84398`) —
      *test_args_deeper_than_six_levels_keeps_its_identity_and_loses_the_bulk* (the
      `_MAX_ARG_DEPTH` boundary: the bulk goes, the entry stays as `{id, name}`);
      *test_args_deeper_than_pythons_recursion_limit_is_bounded_without_raising* (a value nested
      past `sys.getrecursionlimit()` **returns** a bounded entry — this pins that the walk never
      descends past the limit and runs before the first serialization, and it is the case the
      six-level boundary cannot see); and
      *test_response_nested_too_deep_costs_the_entry_its_bulk_as_well* (the bound covers both
      bulk keys, not just `args`). **These three cover `args` and `response` only.** They do
      **not** establish that `sanitize_tool_calls` never raises — a non-`str` `id` nested deep
      still does, which is *Pending (4)* / A4b.
      **The boundary pins for the two formerly-loose constants** (A5/A6, commit `16eef30`) —
      *test_the_per_entry_json_budget_bounds_at_exactly_two_thousand_characters* and
      *test_the_tool_call_id_bounds_at_exactly_one_hundred_characters*, plus
      *test_an_entry_still_over_budget_after_the_bulk_drop_is_dropped_outright* for the final
      re-check.
      Route level, `docker/chat/tests/test_turn_persistence.py` —
      *test_public_transcript_post_persists_a_bounded_turn* (the sanitizers are actually
      wired into `POST /api/live/transcript`: a flood is cut to 10 and an invented transport
      lands inside the known set) and
      *test_well_formed_voice_turn_persists_its_telemetry_untouched* (the "existing voice
      telemetry unaffected" bar: a real `{id,name,args,response}` entry reaches the store
      **intact**, key for key).
      The reject-the-identity half is API-level, so it sits alongside the other
      request-validation cases in `docker/chat/tests/test_api.py` —
      *test_over_long_session_id_is_rejected_and_persists_nothing*: a 200-char `sessionId`
      on `POST /api/chat` answers **400** `validation_error` and the recording store sees
      zero writes. Run: `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.
    - Totality — what is and is **not** guaranteed: `clamp_transport(value: object)` is
      **total**; it accepts anything and returns a member of the known set (`None`, `''`
      and a non-string all yield `'live'`). `sanitize_tool_calls(value: list[dict])` is
      **total only over its declared type** — it raises `TypeError`/`AttributeError` on
      `None`, on a bare `str`, on a list containing `None`, and on a value that will not
      JSON-serialize. Those four are **not** a live hole: the only caller is
      `main.py:1218`, behind `LiveTranscriptTurn.toolCalls:
      list[dict[str, Any]] | None`, so Pydantic answers **400** `validation_error` on every
      one of those shapes before the route body runs, and that call site passes
      `payload.toolCalls or []` so `None` never arrives. The signature is honest about the
      narrow contract rather than advertising a guarantee the body does not make.
      **One raise IS live, and it is not on that list — corrected 2026-10-06 rather than left
      to be discovered:** a **deep non-`str` `id`** is a perfectly well-typed
      `list[dict[str, Any]]`, so Pydantic admits it and `json.dumps` (`turn_input.py:109`)
      raises `RecursionError` from `main.py:1218`, which is **outside** the route's `try`
      (`:1246`) — so it surfaces as a **500 on an unauthenticated endpoint**. Measured at a
      500-level `id` in a 1 074-byte request; the band from ~28 levels up persists an
      over-32-level item instead. A4b closes it (*Pending (4)*). Until it ships, **"no
      reachable public request reaches a raise" is false**, and the depth tests above must not
      be read as covering it. **Gap,
      recorded not claimed:** there is no test that a non-list, a `None`-bearing list, or a
      non-serializable value is refused at the boundary, and no test that
      `clamp_transport` handles `''`/`None`/non-`str`, nor that `'live'` and `'relay'`
      round-trip. If a second caller is ever added for `sanitize_tool_calls`, it must
      either carry the same Pydantic bound or the function must be made total first.
    - **Unpinned bounds — CLOSED by A5/A6, commit `16eef30`.** Re-verified by mutation on
      2026-10-06 against baseline **133 passed**: every one of the mutations below now **fails**
      — `_MAX_ENTRY_JSON_LENGTH` → 100 000 (2 fail), `_MAX_ID_LENGTH` → 1 966 (1),
      `_MAX_ARG_DEPTH` → 60 (2), the re-check deletion (1), and `max_length=128` deleted from
      `LiveTranscriptTurn` (1). The constants are deliberately still not imported by the tests,
      so a bound and its test cannot move in one edit. **The record of what was wrong, kept
      because it is the reason the numbers are now pinned at their boundaries** (verified by
      mutation on 2026-10-05, baseline 124 passed; ADR-0020 §5 A5, A6): three of the numbers
      above were claimed here but held by no test, so they could be moved in one edit —
      (a) deleting `max_length=128` from
      **`LiveTranscriptTurn.sessionId`** (`main.py:171`) leaves the suite **green** — the bound
      on the public transcript sink is the one of the three that nothing pins (deleting it from
      `LiveSessionRequest` or `ChatRequest` each fail one test); (b) deleting the **final
      re-check** (`turn_input.py:82-83`) — the line that makes the worst case a ceiling rather
      than an estimate — leaves the suite **green**; (c) `_MAX_ENTRY_JSON_LENGTH` can be raised
      from 2 000 to **100 000** and `_MAX_ID_LENGTH` from 100 to **1 966** with the suite green,
      because the hostile fixtures use 50 000-char blobs (25× the budget) and so trip any budget
      below ~100 100. Closing these needs **boundary** cases (just-under / just-over the
      documented number), not bigger payloads; test-only, no source change.
    - Scope note: this invariant bounds **per-entry payload shape and key space**, not
      **volume** and not the **item**. The 20 000-char figure is **per turn**, not per item:
      `transcript_store.py:79-111` `list_append`s every turn into one DynamoDB item keyed by
      session id under **no `ConditionExpression`** and with **no cap on turns**, and that item
      caps at 400 KB. Measured (ADR-0020 §5 A3): one maximal turn is **116 008 bytes**, so three
      successful public writes leave a session at 85 % of 409 600 and **the fourth write — and
      every turn after it, forever — is refused**, with the caller still getting 204 and the
      error swallowed into `writes_failed` (`transcript_store.py:140-144`), a counter visible
      only on `/ready` and the gated `/api/chat/host-status`. **No alert fires on a persist
      failure anywhere in the chat host today.**
      Rate and cost limiting is NOT claimed here and does not exist yet: the shipped ECS
      Express chat host has no API-Gateway throttle in front of it (the throttles in
      `aws/chat-template.yaml` cover only the Lambda-container fallback), so M8's
      `app/rate_guard.py` will be the *first* limit on `POST /api/chat` and the paid
      `POST /api/live/session`, not a second layer. Transcript retention TTL, the admin
      read/write key split, and read-side bucketing of unknown tool names in
      `aws/src/contact-admin.js:371-375` (still caller-influenced across requests) are
      likewise **deferred to M8** — see ADR-0020 §"What this ADR does NOT cover". The retention
      TTL must be computed from the **server** clock: deriving it from a persisted `capturedAt`
      would hand the expiry to the caller, which is the hole in *Pending (1)* one field over.
    - **Pending — decided, not yet implemented** (ADR-0020 §5, in priority order). Each line is
      an open hole in THE RULE above, and the conformance paragraph may not be widened until
      the matching slice is green:
      1. ~~**`capturedAt` is a caller-chosen sort key.**~~ **CLOSED by A1, commit `2018a40`** —
         the first violation of the rule's *no caller-supplied value becomes a storage key*
         clause that M0 had missed. Kept here as the worked example, because it is the clearest
         statement of what the rule is for: `capturedAt` was taken verbatim (`max_length=64`,
         no format check) and written as the item's `createdAt`, the RANGE key of the
         `byCreatedAt` GSI (`aws/template.yaml:161-166`) the admin list reads
         `ScanIndexForward: false` (`aws/src/contact-admin.js:481`). Verified before the fix:
         `capturedAt: 'zzzzzzzzzzzzzzzz'` answered **204** and pinned that session to page 1
         permanently (`createdAt` is written `if_not_exists`), poisoning the 30-day activity
         sparkline (`contact-admin.js:721-724`) and dropping the turn from the daily digest
         (`aws/src/common/daily-report.js:68-69`). **Strict ISO-8601 validation would not have
         closed it** — `9999-12-31T23:59:59Z` is valid and sorts first too; a sort key the
         caller chooses is not telemetry. Now server-stamped. Pinned by the sort-key case in
         `docker/chat/tests/test_turn_persistence.py`, which doubles as the pin on Pydantic's
         ignore-unknown-fields tolerance that A2 and A4 also rely on.
      2. **Persist failures are silent, and the fix needs TWO event types.** Decision **A3.1′**
         (ADR-0020 §5.13): `alerts.py:65-72` throttles per **event type** and knows nothing
         about priority, so one shared type would let a routine *session full* fire suppress a
         genuine *writes are broken* for the cooldown window (default 3600 s) — the benign
         condition masking the outage the alert exists to announce. Therefore
         **`chat_transcript_write_failed` (P1)** for any non-budget persist exception, shipping
         with A3.1, and **`chat_transcript_session_full` (P2)** for
         `ConditionalCheckFailedException` only, shipping with A3.2 so neither branch is ever
         unreachable. **The seam rule this establishes, which M7 inherits: one event type = one
         priority = one throttle bucket; if two conditions need different priorities they are
         different event types.** Priority is a static property of the type (a `_PRIORITY` dict
         consulted when `alerts.py:111` builds the subject), never a per-fire argument and never
         part of the throttle key.
      3. ~~**The three unpinned bounds.**~~ **CLOSED by A5/A6** — see the bullet above.
      4. ~~**Nesting depth is unbounded.**~~ **CLOSED by A4 for `args`/`response`, commit
         `bd84398`** — see the *Proven by* additions above. **STILL OPEN on the identity key,
         and it is the sharpest item left in this list.** A4 walks `_BULK_KEYS` only
         (`turn_input.py:105`), while `_bound_entry` keeps `id` whatever its type and only
         touches it under `isinstance(entry_id, str)` (`:95-97`) — so a non-`str` `id` reaches
         the first `json.dumps` (`:109`) with its shape intact. Measured through the route:
         a 40-level `id` in a **153-byte** request persists an item **44** levels deep (refused
         by DynamoDB, swallowed), and a 500-level `id` in a **1 074-byte** request raises
         `RecursionError` out of `main.py:1218`, which sits **outside** the route's `try`
         (`:1246`) — **a 500 on an unauthenticated endpoint**, the precise hole the *Totality*
         bullet exists to deny. Decision **A4b** (ADR-0020 §5.14): a non-`str` `id` **drops the
         entry**, decided on type, before any serialization — making unconditional the outcome
         `test_an_entry_still_over_budget_after_the_bulk_drop_is_dropped_outright` already pins
         for the shallow case, and making `id` behave like `name`, which is already total on
         type and therefore has no such hole.
      5. **The text fields are bounded in code points, charged in bytes.** Verified: 8 000
         astral-plane code points persist 32 000 bytes. Decision **A2**: `clamp_text` on a UTF-8
         byte budget (8 000 / 16 000 bytes), clamping not rejecting.
      6. **The item has no size bound.** Decision **A3.2**: a `bytesStored` counter in the item
         plus `ConditionExpression`. **The 380 KiB budget originally shipped here was DEFECTIVE and
         is corrected (2026-10-07, `5620bd8`)** — its 20_480 bytes of headroom were smaller than one
         turn (42_848 route-clamped), so an over-limit item was reachable by arithmetic, and
         `bytesStored` undercounts the real item by ≥5.6% because it counts only the turn's JSON.
         MEASURED on stage: the counter read 387_824 while DynamoDB had already refused the write,
         and two turns were lost. The threshold is now computed per write as
         `limit - turn_bytes - margin`. Note what A3.2 does and does not deliver: it made the
         failure **loud** (that is A3.1, and it is real) but it did not **bound** the item until
         this correction, so ADR-0020's "A3.2 makes the invariant true" was false as written.
      7. **The admin tool histogram collides on `Object.prototype` keys.** Verified in node:
         `contact-admin.js:374` on a plain `{}` turns a tool named `toString` into the string
         `"function toString() { [native code] }11"`, compounding through the merge at
         `:697-699`; `__proto__` silently drops the bucket. Not prototype pollution. Decision
         **A7b**: `Object.create(null)` at **six** sites, verified at this commit — `:330`, `:332`,
         `:333` (the per-item counters) and `:618`, `:619`, `:641` (the summary counters).
         **This list said four.** The architect's clearance scoped it to four; the test-writer found
         the summary objects are bumped from keys arriving as OWN properties of an
         already-null-prototype item object, so fixing only the item side left `errorsByCode`
         corruptible through `summary.stream.errorsByCode`. Six shipped, and the widening was
         recorded in the clearance at the time rather than justified afterwards.

18. **The streaming chat route is reachable by exactly one spelling, and every spelling the
    frontend can emit lands on a streaming behavior — a silent fall-through to a buffered origin
    is a regression, not a variant.** `[chat]` When a CDN sits in front of the chat host
    (ADR-0022 §17, §23.1 — CloudFront + OAC is the only browser-reachable shape for the
    `RESPONSE_STREAM` Function URL on this account), the shipped frontend emits the chat endpoint
    as **exactly `<base>/api/chat`** — no trailing slash, no doubled separator — and **every**
    spelling it can emit matches a cache behavior whose target origin is the **streaming** origin
    and whose policies do not buffer (`CachingDisabled`, `AllViewerExceptHostHeader`,
    `Compress: false`). A spelling that misses those behaviors falls through the **default**
    behavior, and when the default behavior points at the buffered API Gateway origin — the shape
    ADR-0022 intends to ship, so non-streaming routes keep the 5 rps / burst 10 throttle — the
    reply is still **200**, still `text/event-stream`, still the correct text, delivered **all at
    once**. That is the exact defect this seam exists to remove (`docs/architecture.md:98`), and it
    fails **with no error anywhere**: `readSseChat` parses a complete SSE body happily.
    **Why the trailing slash is the hole, mechanically** (derived from config + code, not measured;
    one `curl -i -X POST <dist>/api/chat/` and a glance at `Location` confirms it): the **exact**
    pattern `/api/chat` (`aws/chat-stream-cdn-template.yaml:106`) is **correct and must stay
    exact** — the glob `/api/chat*` would also swallow `/api/chat/smoke` and
    `/api/chat/host-status`, which are request/response routes belonging on the buffered origin.
    But `/api/chat/` does not match it. It reaches the default origin's `/{proxy+}` ANY route
    (`aws/chat-template.yaml:104-109`), where Starlette's `redirect_slashes` answers **307** with
    an **absolute** `Location` built from the `Host` header — and under
    `AllViewerExceptHostHeader` that Host is the **origin's**, so the browser is redirected to the
    raw `*.execute-api.*.amazonaws.com` host. `fetch` follows a 307 with method and body intact, so
    the browser ends up **off the distribution entirely**, on a host named in **no `<meta>` tag**
    (invariant 2), buffered by API Gateway, inside its 29–30 s integration timeout.
    **AND THE DEEPER RULE, which adding a behavior does NOT satisfy** (found by dev-ops
    2026-10-06 while implementing the trailing-slash behavior): **under OAC the origin must never
    emit an absolute, self-referential redirect**, because **the browser cannot sign**. Route
    `/api/chat/` to a second exact behavior on the **streaming** origin and the same
    `redirect_slashes` now answers 307 with a `Location` naming the **private Function URL host**
    (`*.lambda-url.*.on.aws`, `AuthType: AWS_IAM`) — and the unsigned follow gets **403**. So the
    trailing slash has **two** failure modes, chosen by which origin the fall-through lands on:
    **(a)** default behavior → buffered API Gateway origin → a **silently buffered 200**;
    **(b)** a second behavior → Function URL origin → a **403 dead end**. A second cache behavior
    is therefore **necessary but not sufficient**: the spelling must be normalised **before** the
    origin sees it (a CloudFront viewer-request URI rewrite — in flight), or never emitted
    (pin 1), or the app must stop redirecting at all (`FastAPI(redirect_slashes=False)`, which
    turns the whole silent class into a loud 404 on every route — the loop's call, with that
    trade stated). This is also the general form: **any** `30x` the chat app builds from the `Host`
    header is unfollowable under OAC, because `AllViewerExceptHostHeader` means that header is the
    *origin's* name, not ours.
    **CONFORMANCE — PIN 1 IS NOW PROVEN, 2026-10-07. The paragraph that stood here said the
    opposite** ("this invariant is NOT proven, and nothing in the suite catches its violation
    today"), which was true when written and is superseded rather than deleted, because it is what
    explains why the pin was written.
    `test/frontend-api-config.test.mjs::every chat-api-url meta spelling derives exactly
    <base>/api/chat` asserts **18 derivations** — three bases, including both real committed hosts,
    times six spellings (clean, one trailing slash, three, surrounded by whitespace, and whitespace
    plus slashes) — through a **fresh cache-busted import** of `js/site-config.js` per case with a
    stubbed `document`, since that module reads `document` at import time and static imports hoist
    above a stub. `hostname` is deliberately not `localhost`, so the local fallback can never be
    what makes a case pass. It asserts the derivation's OUTPUT, not the source text: a regex over
    `js/` would keep passing the moment someone rewrote the normalisation into something
    equivalent-looking that no longer normalised.
    **MUTATION-VERIFIED, both halves independently, each applied under an assertion that its anchor
    matched** (a mutation that silently fails to apply reads as a survivor, and this project has
    already published one wrong "SURVIVED" that way): removing `.replace(/\/+$/, '')` fails the
    test with **exactly 12 of 18** cells gaining a trailing slash — `.trim()` is a separate call
    and survives that edit, so the clean and whitespace-only spellings still match — and removing
    `.trim()` instead fails the whitespace spellings. Both counts matched the hand-derived
    prediction before the run, and `js/site-config.js` was restored to an empty diff after each.
    **THE "no doubled separator" CLAUSE — over-claimed when first marked PROVEN hours earlier,
    now actually implemented and pinned (`b0f0a4a`).** Caught by the `tdd-critic`, and the finding
    stands recorded rather than quietly fixed because the over-claim is instructive: the paragraph
    above this one asserted PROVEN for an invariant whose *headline* names two spellings, while
    `js/site-config.js` normalised only one. VERIFIED before fixing: a meta of
    `https://h.example//api/chat` derived that string verbatim. `//api/chat` misses CloudFront's
    exact `/api/chat` behavior exactly as `/api/chat/` does, so it falls through to the buffered
    default origin — the identical silent 200. Of the six spellings originally pinned, five varied
    one property and **none** varied the property the invariant headline names.
    The critic's sharpest point was my own argument turned around: the trailing slash was pinned to
    guard against "the next edit that joins a base to a path", and that edit is **already in the
    tree twice, in opposite styles** — `aws/chat-stream-template.yaml` joins `${Base}api/chat` with
    no separator *because* a Function URL ends in `/`, while `aws/chat-template.yaml` and
    `aws/chat-express-template.yaml` expose bases with none, and
    `scripts/sync-site-api-urls.mjs` writes its argument into the meta verbatim. So the **less**
    protected spelling was the one scoped out.
    Now a 7th spelling, and mutation-verified twice: removing the interior collapse fails, and
    collapsing *everything* (so `https://` becomes `https:/`) also fails — the second mutant is
    what proves the test guards scheme preservation and not merely the collapse. The scheme is
    preserved by splitting it off rather than with a `(?<!:)` lookbehind, because Safari gained
    lookbehind only in 16.4 and an unsupported one is a parse-time `SyntaxError` that takes the
    whole module down instead of degrading.
    **Still unproven, and not closed by pin 1:** that either spelling is unreachable from anywhere
    other than `js/chat.js` — both remain reachable from curl, the docs, and the deploy scripts,
    which is why the edge rewrite in `aws/chat-stream-cdn-template.yaml` carries the other half of
    this invariant. **And one claim above is weaker than it reads:** "both real committed hosts" are
    two string *literals* in the test, not values derived from `index.html`, so when ADR-0022 moves
    prod off the ECS host those cells keep passing against hosts that no longer ship. Deriving one
    base from the committed meta — the shape `test/frontend-api-url-env-guard.test.mjs` already
    uses — is the open follow-up.
    What pin 1 converts is the *incidental* property into a contract: the frontend was **already** a
    one-spelling emitter, but **incidentally, not by
    contract** — `js/site-config.js:9` strips trailing slashes from the meta content
    (`raw.replace(/\/+$/, '')`), `js/chat.js:338` uses the result verbatim as the POST endpoint
    (`:1149`), and `js/chat-live.js:247` / `js/admin.js:26` re-strip before deriving their own
    paths. So `POST /api/chat/` is **not** reachable from `js/chat.js` as written — it is reachable
    from curl, from the docs, from the deploy scripts, and from the next edit that joins a base to
    a path. The practically reachable spelling set is therefore **`/api/chat`** and
    **`/api/chat/`**; query strings do not participate in CloudFront path matching, and
    `//api/chat`, case variants and percent-encoded forms are emitted by nothing in `js/`.
    - Implemented by: `aws/chat-stream-cdn-template.yaml:103-127` — the exact `/api/chat` behavior
      targets `stream-function-url` with `CachePolicyId 4135ea2d…` (CachingDisabled),
      `OriginRequestPolicyId b689b0a8…` (AllViewerExceptHostHeader) and `Compress: false`; the
      default behavior carries the same policies but the **other** origin, which is why the
      fall-through is silent rather than broken. Frontend side: the single-spelling derivation at
      `js/site-config.js:5-15` + `js/chat.js:338`. **A second exact behavior for `/api/chat/` is in
      flight** (ADR-0022 §24.7).
    - Proven by: **nothing yet.** Three pins, in the order the architect recommends them — full
      reasoning in ADR-0022 §24.7:
      1. **Frontend guarantee — PREFERRED, and the one to insist on.** A `node:test`
         characterization that the shipped frontend can only ever emit `<base>/api/chat`:
         `resolveApiUrl` strips trailing slashes (feed it `…/api/chat/`, `…/api/chat///`), the POST
         endpoint is the unmodified `chatApiUrl`, and no module concatenates a `/` onto it. It pins
         the side that actually **changes** (the CDN template is 151 lines edited rarely; `js/` and
         the committed meta are edited weekly), it runs **offline, in CI, on every commit** with no
         AWS credentials, it is the same shape as `test/frontend-api-config.test.mjs` and
         `test/frontend-api-url-env-guard.test.mjs` which already guard this seam, and it costs one
         test because the property is already true — the test converts an accident into a contract.
      2. **Template assertion — second, and cheap.** Parse `aws/chat-stream-cdn-template.yaml`;
         assert the streaming behaviors cover exactly the reachable spelling set, that each targets
         the streaming origin, and that each carries CachingDisabled +
         AllViewerExceptHostHeader + `Compress: false`. On its own it pins a *list*, and a list
         drifts from its emitter — but paired with pin 1 it catches the one failure pin 1 cannot:
         the right pattern pointed at the **wrong origin**, or with a policy that buffers.
      3. **Journey — a release gate, not a suite pin.** For one real streaming POST through the
         distribution, assert **`x-cf-behavior: apichat-exact`**
         (`aws/chat-stream-cdn-template.yaml:50-59,116` stamps it — keep that header; it makes
         "which behavior matched" client-visible without timing anything),
         `content-type: text/event-stream`, and ≥ 2 body reads ≥ 40 ms apart (measured spacing was
         38–216 ms). It needs a deployed distribution, credentials and a live model call, so it
         belongs in ADR-0022 §18's acceptance list and the admin smoke rather than `node --test` —
         but it is the only check that catches the actual user-visible symptom, a correct-looking
         configuration that still buffers.

19. **An operational alert reaches a durable channel on every host that can emit it — alerting is a
    property of the APPLICATION, not of the host it happens to run on.** `[chat]` Recorded
    2026-10-07 by **ADR-0022 §25 (DECISION 5)**; the complement of **#14**, which bounds what
    alerting may do *to a turn* but says nothing about whether an event reaches a human.
    **Two tiers, and the split is the invariant:**
    **Tier 1 — emission (application, host-independent, mandatory).** Every `fire_alert` call writes
    one structured, stably-prefixed line to stdout/stderr at **WARNING or above** — event type, env
    label, summary — **unconditionally, before and independently of any delivery attempt**, whether
    or not `alerts_enabled()` is true. The per-type cooldown may suppress the *email*; it must not
    suppress the *line*. A log line cannot raise and cannot block, so Tier 1 satisfies #14 **by
    construction** rather than by budget — which is why it is a log line and not an awaited network
    call. **Tier 2 — delivery (host capability, at least one per host).** On a long-lived process
    (ECS Express) the in-process Resend send is the delivery tier. On Lambda it is a **CloudWatch
    Logs metric filter on the Tier-1 line → alarm → SNS**, because log delivery is the *runtime's*
    obligation and completes with the invocation, whereas an in-process HTTP POST is the *process's*
    obligation and the process is not guaranteed to run again.
    **Corollary — env parity.** Every host running `docker/chat/app` carries the env the alert gate
    reads: a destination (`CHAT_ALERT_EMAIL` **or** `CONTACT_REPORT_EMAIL`) **AND** a from-address
    (`CHAT_ALERT_FROM_EMAIL` **or** `CONTACT_FROM_EMAIL`) **AND** `RESEND_API_KEY` — three conjuncts
    over five names (`alerts.py:33-54`) — plus `CHAT_ENV`, without which `_env_label()` is
    `'unknown'` (`:97-103`) and an alert cannot be attributed to stage or prod. **Scope is the
    APPLICATION, not the route:** the six event types fire from `gemini_routing.py` (4 types, 10
    sites) *and* `transcript_store.py:180,186` (2 types), and the latter persists **voice** turns
    too — so a host that serves only `POST /api/live/session` can still emit. Scoping this to
    `POST /api/chat` is the mistake that produced the 2026-10-07 finding.
    **WHY THIS IS AN INVARIANT AND NOT A PREFERENCE, measured:** on 2026-10-07
    `get-function-configuration` showed `alerts_enabled()` `False` and `_env_label()` `'unknown'` on
    **both** deployed stage Lambda chat hosts (`…ChatStreamFunction-48hA0gOKhVzC`, 7 env keys;
    `gvp-chat-stage-ChatFunction-e9cDGaRVL5II`, 11 keys), while the ECS Express template
    (`aws/chat-express-template.yaml:160-176`, 17 vars) is the only host configured. Stage's
    committed meta points at the CloudFront front door (commit `046563d`) whose two origins are both
    Lambda — so stage chat is **serving traffic with the alarm bell disconnected**, across all six
    event types, on an upstream that ADR-0023 exists because it was failing roughly 1 request in 3.
    Alerting had silently become a property of one host.
    **AND IT WAS THEN OBSERVED FIRING, not inferred** (ADR-0022 §25.1a, same day): a real stage turn
    through the front door returned a healthy-looking `200 text/event-stream`, while the log group
    showed the primary model timing out on a **six-token** prompt, demoting itself for the day
    (`note_primary_timed_out()`, `gemini_limit_state.py:55-63`), and the visitor waiting **13.2 s**
    for first token. `fire_alert('chat_primary_timeout', …)` was called and returned at
    `alerts.py:86`: **no log line, no email, no record of any kind.** Note what makes this the
    decisive case rather than an unlucky one — **the fallback WORKED**, so the degradation is
    invisible at the HTTP layer by design. No error code, no 5xx, no truncated stream, nothing an
    uptime check or a CloudFront metric can see. **When the only symptom is latency and the recovery
    is automatic, the alert is not one channel among several; it is the only one.**
    **Measured support for the two-tier split, from a controlled comparison inside one invocation:**
    `logger.warning(…)` (`gemini_routing.py:376-380`) and `fire_alert(…)` (`:387-390`) are in the
    **same `except` branch, eleven lines apart** — the synchronous line reached CloudWatch, the
    fire-and-forget alert did not. Tier 1 is therefore *demonstrated viable* on a RESPONSE_STREAM
    Lambda behind LWA, not merely argued. **Limits, stated so they are not over-claimed:** that
    probe exercised a **mid-turn** line, not a post-response one; it does **not** measure the freeze
    question (ADR-0022 §25.3-M stays owed); and n = 1 bounds any claim about rate.
    - Implemented by: **Tier 1 yes; the corollary in the TEMPLATES but not yet on the DEPLOYED
      hosts; Tier 2 on Lambda not at all.** Updated 2026-10-07 after the slices landed, because the
      previous wording ("nothing yet, on either tier") was written while they were in flight and was
      false within the hour.
      **Tier 1 — `39e2033`.** `fire_alert` now emits
      `logger.warning('CHAT_ALERT event=%s env=%s %s', ...)` as its first statement, above the gate,
      so an unconfigured host leaves a durable record instead of returning in silence.
      **Corollary — `f59f863`**, which added `RESEND_API_KEY`, `CHAT_ALERT_EMAIL`,
      `CHAT_ALERT_FROM_EMAIL` and `CHAT_ENV` to the `Environment:` block of both
      `aws/chat-template.yaml` and `aws/chat-stream-template.yaml` (one satisfier per conjunct is
      enough, so the `CONTACT_*` alternates are deliberately not declared).
      **STAGE IS NOW LIT — MEASURED 2026-10-07 after the deploy**, and this paragraph previously
      said the opposite, which was true when written and false within the hour. Read back from
      `get-function-configuration` on both hosts:
      `…ChatStreamFunction-48hA0gOKhVzC` 7 → **11 env keys**, `alerts_enabled()` **True**,
      `_env_label()` **`stage`**; `gvp-chat-stage-ChatFunction-e9cDGaRVL5II` 11 → **15 env keys**,
      `alerts_enabled()` **True**, `_env_label()` **`stage`**. `ReservedConcurrentExecutions` is
      **5** and survived the deploy, and the committed `gvp:chat-api-url` metas were untouched, so
      invariant 11 still holds. **PROD is NOT lit** — it remains on `gvp-chat-express-prod`, which
      was already configured, so prod alerting never broke; the gap was stage and the two Lambda
      hosts the prod roll targets.
      **WIRED IS STILL NOT LIT, as a standing property:** all three parameters default to `''`, so
      a deploy can no longer omit a *key* but can still pass an empty *value*. The suite pins key
      presence only, deliberately, so liveness is never provable from the repo. That is why
      ADR-0022 §27.1 keeps **B-5** (one post-deploy liveness check) as a blocker in its own right
      rather than folding it into B-1 — and this deploy is the first time that check has actually
      been run.
      **Still unimplemented:** Tier 2 on Lambda (metric filter on the Tier-1 line, alarm, SNS) and
      the startup announcement — ADR-0022 §26.5 items **E6** and **G5**. Note `:92-93` still logs
      the no-loop exit at DEBUG, below the default level; DECISION 5 moves it to WARNING and that is
      a separate slice.
    - Proven by: **partially — the corollary only.** `test/chat-alert-gate-env.test.mjs` asserts
      that every template which can run `docker/chat/app` passes the alert gate, **deriving** the
      five legal names from `alerts.py` rather than hardcoding them (which is how the `CONTACT_*`
      fallbacks were found), and scoping its parse to the `Environment:` block so a
      declared-but-never-passed `Parameters:` entry does **not** satisfy it. Its independently
      parsed counts (11 and 7) match the deployed functions exactly. **It asserts key PRESENCE,
      never values** — values are deploy-time parameters and asserting them would make the test a
      secret-shaped liability.
      **Tier 1 is now proven too**, by
      `docker/chat/tests/test_alerts.py::test_emits_tier1_warning_line_even_when_gate_is_disabled`,
      which deletes all five gate names, asserts `alerts_enabled() is False` as a precondition so it
      cannot pass vacuously, and then requires exactly one record at WARNING or above carrying the
      stable `CHAT_ALERT` prefix, the event type and the env label — presence, never values.
      **Mutation-verified four ways**, each caught: demoting the call to DEBUG, dropping the env
      label from the format, changing the prefix, and — the one that matters, since it is the actual
      defect — moving the line back BELOW the gate. The reordering mutant was applied under an
      assertion that its anchor matched, because a mutation that silently fails to apply reads as a
      survivor and this project has already published one wrong "SURVIVED" that way.
      **Still unproven: Tier 2 on Lambda** (that a metric filter exists and alarms — a template
      assertion), the **startup announcement**, and **post-response Tier-1 delivery on Lambda**
      (§25.1a observed a MID-TURN line; the two transcript types fire at the END of a turn from
      `_persist_text_turn`, and that is a short inference, not an observation). Those are ADR-0022
      §26.5 items **G5** and **E6** plus a runtime check that no unit test can stand in for.
    - **Open, labelled honestly: DERIVED, NOT MEASURED** — that a surviving `loop.create_task`
      (`alerts.py:94`) wrapping an awaited 10 s httpx POST (`:128-129`) is frozen by Lambda when the
      response completes, and therefore delayed to the next invocation or lost. Reasoning in
      ADR-0022 §25.3; the measurement is specified there as **§25.3-M** and needs the owner's
      authorization. **This invariant does not depend on the answer** — if the freeze claim is false,
      Tier 2's metric filter is belt rather than the primary; Tier 1 is required either way, because
      the silent exit at `:85-86` is what hid this for the life of the feature.

## Out of scope / explicitly allowed

- **"Single origin" is not literal in production.** The shipped meta tags point chat
  (and contact) at *different* hosts than the Amplify static site — the chat host
  (`gvp:chat-api-url`) is the stateless chat container on **ECS Express Mode** (an
  ECS-managed ALB + AWS TLS, ADR-0007 Phase 3/4) and an `execute-api` host for
  contact (`index.html:38-39`). Voice does **not** add a host: the browser connects
  browser-direct to Google's Live WSS with an ephemeral token, so the chat host serves
  only HTTP (`/api/chat` SSE + `/api/live/session` mint), never a WebSocket. Same-origin
  `/api/*` is only the local-dev fallback
  (nginx mirrors it on `:8080`, `docker/nginx.conf`). The real invariant is #2 (no
  hardcoded host; bases from meta), not "everything is same-origin." Cross-origin calls
  are governed by backend CORS allowlists (`aws/src/common/contact-shared.js:135-141`,
  `docker/chat/app/main.py:140-145`), which never use `*`.

- **Token-by-token streaming is NOT guaranteed on every host.** The shipped chat host is
  the stateless container on **ECS Express Mode** (Fargate behind an ECS-managed ALB,
  ADR-0007 Phase 3/4), where the SSE wire is unbuffered and tokens stream through. The
  Lambda chat stack (`aws/chat-template.yaml`) remains as a dev/degraded fallback, and
  there Mangum buffers the SSE generator so the client sees the full reply at once. The
  invariant is that a turn is *persisted with stream telemetry*, not that the wire is
  incremental on every possible host. (The old `CHAT_LIVE_RELAY` flag that once gated this
  was removed with the server WebSocket relay — see ADR-0007 Phase 1.)

- **Voice is browser-direct, so it no longer depends on a WebSocket-capable host.**
  Under ADR-0007 Phase 1 the server holds **no** WebSocket: `POST /api/live/session` is a
  plain HTTP endpoint that mints a single-use Gemini ephemeral token and returns a
  `websocketUrl` pointing at Google's Live WSS
  (`google.ai.generativelanguage…BidiGenerateContentConstrained?access_token=…`), which the
  **browser** opens directly (`docker/chat/app/main.py:916-1000` mint;
  `js/chat-live.js:1012-1076` browser-direct connect). The mint can still fail server-side
  (503 on missing corpus/`GEMINI_API_KEY`, 504 on mint timeout), but those are HTTP
  responses any chat host can serve — including the Lambda fallback, which no longer breaks
  voice the way the old server-relay path did. Voice working end-to-end is still a runtime
  property (valid key + reachable Google Live), not a code invariant.

- **Transcript persistence is best-effort when unconfigured.** If
  `CHAT_TRANSCRIPTS_TABLE` is unset, `build_transcript_store()` returns `None`
  (`docker/chat/app/transcript_store.py:147-151`) and chat turns skip persistence
  (`main.py:692-694`) while the user still gets a reply; `POST /api/live/transcript`
  returns 503 in that state (`main.py:1153-1165`). "Every turn is persisted" (#7) holds
  *when a store is configured* — the no-op-when-unconfigured behavior is intentional, not
  a bug to test against.

- **Exact model ids are configuration, not invariants.** `GEMINI_MODEL`
  (`gemini-3.1-flash-lite`), `GEMINI_FALLBACK_MODEL` (`gemma-4-26b-a4b-it`), and
  `GEMINI_LIVE_MODEL` are env-overridable defaults
  (`docker/chat/app/providers.py:54-59`); only the *behavior* (primary→fallback on rate
  limit, #9; bounded timeout, #8) is invariant. The provider itself (`mock` vs `gemini`
  vs `openai`) is also configuration.

- **Theming is cosmetic.** `space` / `garden` / `studio` / `auto` themes and their
  starfield/snow scenes are presentation only; switching them changes no contract beyond
  the reduced-motion easing in #6.

- **CORS allowlist contents and the `www`/apex/`chat.` host expansion** are configuration
  driven by `CHAT_CORS_ORIGINS` / `CONTACT_CORS_ORIGINS`; the invariant is "never `*`,"
  not any specific origin set.

- **Reply-copy polish is a feature, not an invariant.** `deriveReplyText`
  (`js/chat-reply-text.js`) — which turns an empty tool-only reply into an action-tied line
  instead of the dead "no response yet" fallback — and `shouldRevealResumeButton`
  (`js/voice-resume-button.js`) — which reveals the résumé button when the voice agent
  *says* "tap the button" without calling `open_resume` — are pure, unit-tested helpers
  (`test/chat-reply-text.test.mjs`, `test/voice-resume-button.test.mjs`) and a genuine UX
  improvement. But a regression there degrades the wording / affordance of a single reply;
  it is not a durability, secret, safety, or correctness defect, so they remain feature
  tests, not "must NEVER silently break" invariants. The agent-as-guide POSTURE they serve
  is invariant only where it crosses a real seam — the `resume-access ⇒ navigate_to_section`
  routing pinned in #15.
