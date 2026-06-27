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
> {ok,error,timeout}×{stream,non-stream} cells); **#9** (first-chunk rate-limit → fallback;
> committed after first chunk) is proven by `docker/chat/tests/test_gemini_routing.py` (all
> four clauses — rate-limit→fallback on `astream` + `ainvoke`, committed-midstream propagation,
> non-rate-limit not retried, distinct-model guard); **#10** (Live voice timbre pinned to the
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
> **Proven set: ALL SIXTEEN — #1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16.**
> Every CHAT-layer invariant (#7, #8, #9, #10, #13, #14, #15) and every `[app]` invariant (#1–#6,
> #11, #12) now holds; there are no open invariant clauses. **#12–#15 are the 2026-06-25 pass** over
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

9. **On a first-chunk rate limit the chat chain transparently falls back to the
   secondary model; once any chunk has flushed it is committed.** `GeminiRoutingChain`
   tries the primary model first; if the FIRST attempt fails with an upstream rate-limit
   it retries on the fallback; once a chunk has been yielded, mid-stream errors propagate
   rather than restart. Non-rate-limit errors are not retried. Primary and fallback model
   ids must differ.
   - Implemented by: `docker/chat/app/gemini_routing.py:99-144` (`astream`: fall back
     only when the first `__anext__` raises a rate-limit; commit after first yield),
     `:71-97` (`ainvoke` analogue); distinct-model guard
     `docker/chat/app/providers.py:200-201`.
   - Proven by: `docker/chat/tests/test_gemini_routing.py` — all four clauses, asserting the
     routed-output / propagation contract (not call counts): first-chunk rate-limit → fallback
     on **streaming** (*test_astream_first_chunk_ratelimit_falls_back*: primary `astream` raises
     `UpstreamError(429)` before any yield → joined content `== "from-fallback"`) and
     **non-streaming** (*test_ainvoke_ratelimit_falls_back*: `ainvoke` 429 → `result.content ==
     "from-fallback"`); committed-after-first-chunk propagation
     (*test_astream_committed_midstream_error_propagates*: yields `"from-primary"` then raises →
     `RuntimeError` propagates, `"from-primary"` seen, `"from-fallback"` NOT seen — no fallback
     restart); non-rate-limit first-chunk error not retried
     (*test_astream_non_ratelimit_error_not_retried*: plain `RuntimeError` before any yield
     propagates, `"from-fallback"` NOT seen); and the distinct-model guard
     (*test_distinct_model_guard_rejects_identical_ids*: `build_llm_runnable` rejects identical
     `GEMINI_MODEL`/`GEMINI_FALLBACK_MODEL`, builds a `GeminiRoutingChain` for distinct ids).
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
    delay — a chat turn.** `[chat]` `fire_alert` is fire-and-forget: it is a no-op when
    unconfigured (ships **dark** — needs `CHAT_ALERT_EMAIL`/`CONTACT_REPORT_EMAIL` +
    `RESEND_API_KEY`), it never raises in a sync (no-running-loop) context, it is throttled
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
    any other Resend error still throws.
    - Implemented by: `aws/src/common/daily-report.js` (pinned `generatedAt`,
      `stabilizeSmokeForReport`, `isResendIdempotencyConflict`) + the
      `aws/src/contact-daily-report.js` handler (stabilizes the live smoke; swallows only
      the idempotency 409). Recorded in
      `docs/decisions/ADR-0014-daily-report-send-idempotency.md`.
    - Proven by: `test/daily-report.test.mjs` — *"renders byte-identical HTML and text
      across two builds"* (and the with-stabilized-smoke analogue), *"pins generatedAt to
      the report day rather than wall-clock"*, the `stabilizeSmokeForReport`
      projection / no-mutation / omit-when-empty tests, and *"isResendIdempotencyConflict
      is true only for a 409 invalid_idempotent_request"*. Run: `node --test`.

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
