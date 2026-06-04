# Project invariants

These are the rules the gvp portfolio system must ALWAYS uphold — the things that
must never silently break. For any new code path that touches one, the test that
proves it comes FIRST.

> **Honesty note (adoption bootstrap; updated 2026-06-03):** invariants **#3, #4, #5**
> (contact durability — landed via the ADR-0006 injectable-core seam) and **#6** (reduced
> motion) are proven by `node --test`; **#7** (every chat turn persisted with its terminal
> `status`) is now proven by `docker/chat/tests/test_turn_persistence.py` (all six
> {ok,error,timeout}×{stream,non-stream} cells). **#8** is **persisted-row-proven** (the
> `timeout` row is asserted on both paths) but its **cap clause is still open** — the
> `providers.py` 28s-default / 55s-ceiling resolution is unproven (see #8 "Proven by" + the
> "Pin chat provider timeout resolution + cap" backlog item). **Proven set: #3, #4, #5, #6,
> #7 (+#8 partial).** **#1, #2, #9, #10 remain UNPROVEN** — each is a candidate for a
> characterization test and belongs on the upgrade backlog. Each claim is cited to `file:line`
> so the navigator can confirm it against the code, not take it on faith. Line numbers are from
> the state of the repo at adoption and may drift; treat the cited function/symbol as the
> anchor.

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
     `aws/chat-template.yaml:85` + `aws/chat-ecs-template.yaml:232`
     (`GEMINI_API_KEY: !Ref GeminiApiKey`); `.gitignore:34` excludes `.secrets/`. The
     admin key in `js/admin.js:106` is read from `sessionStorage` (operator types it at
     runtime), never embedded.
   - Proven by: NONE YET — candidate for a characterization test (e.g. grep the served
     bundle for key patterns / assert meta tags are the only API config).

2. **All API base URLs come from meta tags, never a hardcoded cross-origin host.**
   Every frontend network call resolves its base from a `<meta>` tag via
   `site-config.js`; when the tag is empty the only fallback is a **same-origin**
   `/api/*` path (and only on `localhost`/`127.0.0.1`). No module hardcodes a remote
   API hostname. The voice WebSocket URL is taken from the server's minted session
   response body, not constructed against a hardcoded host.
   - Implemented by: `js/site-config.js:5-15` (`resolveApiUrl` → `contactApiUrl`,
     `chatApiUrl`; local-only `/api/contact` / `/api/chat` fallbacks);
     consumers `js/contact.js:1,27,107`, `js/chat.js:4,300,1109`,
     `js/chat-live.js:7,245`; voice WS URL from response body at
     `js/chat-live.js:131-132,1012-1013,1090`.
   - Proven by: NONE YET — candidate for a characterization test (assert each module's
     endpoint derives from `site-config` exports + same-origin fallback; assert no
     `http(s)://` literal endpoints in `js/`).

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
     *test_streaming_timeout_…*: `status=='timeout'` + `errorCode=='upstream_timeout'`); each
     asserts exactly one persisted row via a stub store. Together with the pre-existing
     `test_transcript_store.py::test_chat_persists_transcript_turn` (non-stream **ok**) that is
     all six {ok,error,timeout}×{stream,non-stream} cells. *Caveat:* the non-stream-ok test
     proves the row **persists** (session/prompt/model/flags) but asserts HTTP `status_code==200`
     rather than the persisted `turn['status']=='ok'`; the other five each assert the row's
     `status` directly. Run: `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

8. **Each chat provider call is bounded by a timeout.** Non-streaming calls are wrapped
   in `asyncio.wait_for(..., provider_timeout_seconds)` (504 + persisted `timeout` row on
   expiry); the streaming path enforces the same single end-to-end deadline with
   per-chunk `asyncio.wait_for`. The Gemini timeout default (28s) is capped below the API
   Gateway integration ceiling.
   - Implemented by: non-stream deadline `docker/chat/app/main.py:791-794`; stream
     deadline `docker/chat/app/main.py:864-884` (`deadline = monotonic()+timeout_s`,
     per-chunk `wait_for(remaining)`); timeout resolution + caps
     `docker/chat/app/providers.py:23-47` (Gemini default 28s, ceiling 55s).
   - Proven by: PARTIAL — the persisted `timeout` **row** is proven on both paths by
     `docker/chat/tests/test_turn_persistence.py` (S2 non-stream and S5 streaming per-chunk
     `wait_for` deadline → `status=='timeout'`, `errorCode=='upstream_timeout'`), and the 504
     mapping by `test_readiness_timeout.py::test_chat_timeout_maps_to_504`; the 28s default by
     `test_providers.py::test_gemini_default_upstream_timeout`. **STILL OPEN:** the
     `providers.py` timeout-resolution **cap** — the 28s-default / 55s-API-Gateway-ceiling clamp
     of a `>55s` override — is **not yet proven** (no test sets an over-ceiling override and
     asserts the clamp). Tracked by the "Pin chat provider timeout resolution + cap" backlog
     item. Run: `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

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
   - Proven by: NONE YET — candidate for a characterization test (fake primary raising a
     rate-limit on first chunk; assert fallback streams; assert a mid-stream error after
     a yield is NOT retried).

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
    - Proven by: NONE YET — candidate for a characterization test (assert
      `_live_voice_name()` default is `Charon` and that `_live_connect_config` carries a
      prebuilt voice + AUDIO modality; assert override via `CHAT_LIVE_VOICE`).

## Out of scope / explicitly allowed

- **"Single origin" is not literal in production.** The shipped meta tags point chat
  (and contact) at *different* hosts than the Amplify static site —
  `chat-api.marwanelgendy.link` for chat/voice (ALB) and an `execute-api` host for
  contact (`index.html:38-39`). Same-origin `/api/*` is only the local-dev fallback
  (nginx mirrors it on `:8080`, `docker/nginx.conf`). The real invariant is #2 (no
  hardcoded host; bases from meta), not "everything is same-origin." Cross-origin calls
  are governed by backend CORS allowlists (`aws/src/common/contact-shared.js:135-141`,
  `docker/chat/app/main.py:140-145`), which never use `*`.

- **Token-by-token streaming is NOT guaranteed on every host.** Lambda + Mangum buffers
  the SSE generator, so on the Lambda chat stack the client sees the full reply at once;
  true streaming is an ECS-only property (`CHAT_LIVE_RELAY=1`). The invariant is that a
  turn is *persisted with stream telemetry*, not that the wire is incremental everywhere.

- **Voice may legitimately fail at the network layer on Lambda-only deploys.** API
  Gateway HTTP API cannot upgrade WebSockets, so with `CHAT_VOICE_ECS_BOOTSTRAP=0` voice
  fails (text chat still works); `POST /api/live/session` only hard-fails early (503)
  when `CHAT_LIVE_VOICE_STRICT=1` (`docker/chat/app/main.py:52-53,986-993`). Voice
  working is a deployment-topology property, not a code invariant.

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
