# ADR-0022 — The chat hosting seam: is ECS Express load-bearing, or can SSE run on Lambda response streaming?

- **Status:** **GATE PASSED 2026-10-06 — GO to finish the stage acceptance list. NO deletion.**
  **Read §24 first; it retires this ADR's critical path.** The one question the migration hung on
  — *can a browser reach a `RESPONSE_STREAM` Function URL on this account, unbuffered?* — is
  **answered yes, measured through CloudFront + OAC with an unsigned client** (§24.1): 200,
  `text/event-stream`, response headers **11.6 s** ahead of the first body byte, tokens in separate
  socket reads **38–216 ms** apart. **M-6's buffering clause PASSES; §23.1.2's NO-GO risk is
  RETIRED** (§24.2). The cause of the block was **none of §19's four hypotheses** — AWS's OAC
  documentation requires **two** grants (`lambda:InvokeFunctionUrl` **and**
  `lambda:InvokeFunction`) and the template had one (§24.3). What is left is ordinary: **B1** (the
  A/B, blocked only because `gvp-chat-express-stage` sits at `desiredCount: 0`), **D2** (the human
  voice pass), **E1/M-7** (the Lambda concurrency quota), the §23.3 template deltas, and the
  **first real frontend change this migration needs** — `x-amz-content-sha256` on every chat POST
  (§24.6). Cost case corrected to September actuals: **$39.50 of a $46.51 bill, 85%** (§24.4).
  Earlier status, kept because the reasoning is the record:
  **MEASURED 2026-10-06 — conditional GO to a side-by-side stage deploy. NO deletion.**
  M-1 (SSE through LWA response streaming) and M-2 (container-image cold start) were measured on a
  throwaway Function URL and **both PASS with margin** (§13). M-3 (voice) and M-4 (cost ceiling) are
  still OPEN, and the spike surfaced a **new hard blocker — M-5**, an unexplained `403` on the
  Function URL with `AuthType: NONE` (§19). The decisions needed to build the stage deploy are
  **§15 (Function URL vs API Gateway) · §16 (where the template lives) · §17 (custom domain) ·
  §18 (stage acceptance list) · §20 (build constraints)**, **as revised by §23** — the two
  untracked spike artifacts already on disk (`aws/chat-stream-template.yaml`,
  `docker/chat/Dockerfile.lambda-stream`) carry two further **measured account facts** that change
  the answers to Decisions 1 and 3: **a public Function URL (`AuthType: NONE`) is blocked
  account-wide**, and **reserved concurrency cannot be set on this account at all.** M-5 is
  therefore **RESOLVED** (§19), and **CloudFront + OAC + `AuthType: AWS_IAM` is promoted from
  "before the prod roll" to a prerequisite of measuring the browser path at all.** **Still true: no
  resource may be deleted on the strength of this document.** §14 records what this ADR got wrong
  as first written; §22 and §23.5 the drift.
- **Date:** 2026-10-06
- **Decides nothing yet; when decided it will amend:** ADR-0002 (split chat hosting) and
  ADR-0007 Phases 3–4 (hosting landed on ECS Express Mode).
- **Keeps regardless of outcome:** ADR-0001 (API base from a `<meta>` tag, never a hardcoded
  cross-origin host), ADR-0003 (voice timbre lock), ADR-0007 Phase 1 (browser-direct voice).
- **Numbering:** project ADRs run `0001`–`0014` plus `0020`. **`0015`–`0019` and `0021` are
  reserved** by `docs/plan-2026-09-port.md:118,151,166,191,215,241,257` for M2–M8 (M6 holds
  `ADR-0019`, M8 holds `ADR-0021`), so this spike takes **`0022`**. Note the separate TDD-kit ADR
  sequence referenced as "ADR 0022" in `docs/tdd/outer-loop.md:32` — a different namespace, not
  this document.

---

## 1. Context — the trigger is cost, not capability

The owner's AWS bill is **$49–92/mo**. Of that, the chat host is the largest discretionary slice:

**These two figures are SUPERSEDED by §24.4** (September actuals from Cost Explorer: ELB $16.20 +
VPC $14.41 + ECS $8.89 = **$39.50** of a **$46.51** bill). They derived from a July memory; the ALB
half was close (~$30.61 actual vs ~$29), the Fargate half was **2× too high** because only one task
is running — stage sits at `desiredCount: 0`. Kept in place because §10's argument was built on them.

| Item | ~Monthly |
|------|----------|
| ALB `ecs-express-gateway-alb-b1f2409b` (~$18 ELB + ~$10.80 for 3 public IPv4) | **~$29** |
| ECS Fargate tasks (`256` CPU / `512` MiB, `MinTaskCount: 1`, per `aws/chat-express-template.yaml:69-83,178-179`) | **~$18** |

That ALB is **shared** by `gvp-chat-prod-express` and `gvp-chat-stage-express`, is tagged
`AmazonECSManaged=true`, and therefore survives as long as **either** Express service does.
Deleting one environment's service removes roughly the Fargate half of that environment and
**none** of the $29.

The question this spike exists to answer: **the chat host is a long-running container for exactly
one remaining reason — unbuffered SSE for text. Is that reason still load-bearing, or can
Lambda response streaming serve it and retire ~$29–47/mo?**

### 1.1 What changed since ADR-0002

ADR-0002 named **two** reasons the host had to be a container: (1) Mangum buffers SSE, and
(2) voice needed a browser→server WebSocket upgrade. **Reason (2) is gone.** Verified in this
repo at this commit:

- **Voice no longer touches AWS compute.** `docker/chat/app/live_gemini.py:194-203` mints a
  single-use Google ephemeral token via `auth_tokens.create()` (`new_session_expire_time` 180 s,
  `expire_time` 600 s). `docker/chat/app/main.py:1109-1111` returns
  `google_constrained_browser_ws_url(token_name)` — i.e. `wss://…?access_token=<token>` — and
  sets `liveVoiceTransport` / `voiceBrowserExperience` to **`direct_google`**, the only transport
  the server ever mints. The browser opens Google's socket itself
  (`js/chat-live.js:1039-1040`: "no server relay").
- **The server-side relay is deleted.** No `@app.websocket` route exists anywhere in
  `docker/chat/app/`; `live_relay.py` is absent from the package. Recorded at
  `docs/architecture.md:462`.
- **So only SSE remains.** `docs/architecture.md:98` calls the Lambda stack a degraded fallback
  because "Mangum buffers the SSE generator, so the user sees the full reply at once", and
  `docker/chat/app/lambda_handler.py:9` is exactly `handler = Mangum(app)`. The streaming
  response itself is host-agnostic FastAPI: `docker/chat/app/main.py:852-860` returns a
  `StreamingResponse` of `text/event-stream` with `Cache-Control: no-cache` and
  `X-Accel-Buffering: no`.

**All three findings survive verification.** Mangum is the whole of the Lambda limitation — the
application code needs no change to stream.

---

## 2. The proposal under evaluation

Replace Mangum with the **AWS Lambda Web Adapter (LWA)** in response-streaming mode, exposed via
a **Lambda Function URL with `InvokeMode: RESPONSE_STREAM`**; then delete the ECS Express
services and let the shared ALB go with them.

Today neither half exists: there is **no LWA anywhere in the repo** (grep for
`lambda-web-adapter` / `AWS_LWA` returns nothing; `docker/chat/requirements.txt:5` pins
`mangum==0.19.0`), and **no Function URL** — `aws/chat-template.yaml:62-70,102-110` fronts the
function with an `AWS::Serverless::HttpApi`, not a Function URL. So the proposal is net-new
infrastructure work, not a flag flip.

---

## 3. The WebSocket correction — and the fence it requires

The proposal reached the architect with this wrong, so it is recorded explicitly:

> **Lambda Function URLs support HTTP response streaming. They do NOT support WebSocket
> upgrades. LWA is an HTTP proxy and cannot serve a `wss://` endpoint.**

**This does not block the proposal**, and the reason is precisely §1.1: nothing in this system
needs a server-side WebSocket any more. Voice is browser→Google direct. The only WebSocket the
server ever opens is **outbound** (`docker/chat/app/live_gemini.py:275` — `websockets.connect` to
Google, inside the admin deep probe `probe_live_session`), and outbound TCP works fine from
Lambda. An outbound client socket is not an inbound upgrade.

### 3.1 Fence — the condition under which this ADR's premise dies

**If a server-side WebSocket is ever reintroduced — a restored relay, a server-mediated Live
session, any `@app.websocket` route — the Lambda option is void and ECS (or an equivalent
upgrade-capable host) becomes mandatory again.** Such a change must supersede this ADR rather
than quietly re-add the dependency. The historical pressure to restore the relay was the "Google
close 1011" failure mode, which the stale docs in §8 still present as current; §5 records that
nothing in the live code makes host identity matter to voice.

---

## 4. Decision criteria — measurements with thresholds

The decision is **go/no-go on three measurements**. Each is stated as a number with a threshold,
not an opinion. None has been taken; all are **OPEN**.

### M-1 — Time-to-first-token for SSE through LWA streaming vs. the current ECS path

- **Measure:** wall-clock ms from request send to the first `token` SSE event arriving at the
  client, for `POST /api/chat` with `stream: true`. Same prompt, same model, ≥20 warm samples per
  host; report median and p95.
- **Baseline — CORRECTED 2026-10-06, see §14.1:** the comparison is against the **stage** Express
  host `https://gv-d7fa1a51ec09445caf0d435348131479.ecs.us-east-2.on.aws/api/chat`, **not** the prod
  host (`gv-0277d83a39d54698a254a52e95dcd476…`) this ADR first named. The LWA variant deploys to
  **stage**; comparing it against prod would mix a host change with an environment change. Both
  samples must come from the same machine, interleaved — §18.B1.
- **Threshold — GO:** LWA-streaming median TTFT ≤ **ECS median + 150 ms** *and* p95 ≤
  **ECS p95 + 400 ms**.
- **Threshold — NO-GO:** tokens do not arrive incrementally at all (i.e. the response is
  buffered), or median TTFT exceeds ECS by > 400 ms. Buffering is a hard fail: it is the exact
  defect that made the Lambda stack "degraded" in the first place.
- **Must also confirm:** that chunks *keep* flushing (not just the first) — count SSE events
  received and assert `streamChunkCount` > 1 at the client, since a streaming-capable transport
  that coalesces mid-stream is still a regression.

### M-2 — Cold-start latency for the first request on a container-image Lambda

- **Measure:** TTFT and total response time for the **first** request after ≥15 min idle, ≥5
  cold samples; report median and worst.
- **Why it was in doubt — THIS REASONING IS WITHDRAWN. See §14.2.** As first written this bullet
  cited `docker/chat/Dockerfile:11` (dev deps + `tests/` in the runtime image) and ADR-0007's
  **~100 s** cold start. **Both citations were wrong for this measurement.** `docker/chat/Dockerfile`
  builds the **ECS** image; the Lambda image is `docker/chat/Dockerfile.lambda`
  (`aws/chat-template.yaml:73-75`), which installs only `requirements-lambda.txt`, no dev deps and
  no `tests/`. And **LangChain is already gone** from both requirements files
  (`docker/chat/app/messages.py:1` is its dependency-free replacement) — so the ~100 s figure
  measured an image that no longer exists. The real risk was never image weight; it was unmeasured.
  **It has now been measured: 1542 ms first chunk on a cold environment (§13.2).**
- **Threshold — GO:** cold TTFT ≤ **3 s** median and ≤ **5 s** worst.
- **Threshold — CONDITIONAL:** 5–10 s — acceptable **only** with a cold-path UX (see §7) and/or
  provisioned concurrency, but provisioned concurrency has a standing monthly cost that must be
  subtracted from the ~$29–47 saving before the trade is called a win.
- **Threshold — NO-GO:** > 10 s with no mitigation that preserves the saving.
- **Note:** if M-2 fails only because of image weight, the cheaper experiment is to slim the
  image (drop dev deps and tests from the runtime stage) and/or land ADR-0007 Phase 2 **first**,
  then re-measure. Record that as a prerequisite, not a defeat.

### M-3 — Does browser-direct voice actually succeed against a Lambda-hosted mint?

- **Measure:** from a real browser on an HTTPS page, with the chat meta pointed at the Lambda
  Function URL: call `POST /api/live/session`, open the returned `websocketUrl`, and confirm a
  `setupComplete` frame and audible audio. ≥10 trials; record any close codes.
- **The historical concern** was Google close **1011** on `direct_google`.
- **Answer from code — host identity does NOT matter to the voice path today.** Verified:
  - The token is minted by a Google API call from the server and the browser connects to
    **Google**, not to us; our hostname never appears in the voice data path
    (`main.py:1109`, `js/chat-live.js:1039-1040`).
  - The one place the FE still marks a host as voice-incapable is unreachable:
    `js/chat-live.js:1117-1124` sets `voiceUnavailableOnHost` only when
    `transportForCloseMsg === 'relay'`, and the server only ever mints `direct_google`
    (`main.py:1110`). Therefore the guard at `js/chat-live.js:1264-1267`
    (`VOICE_UNAVAILABLE_ON_HOST_MSG`) can never fire. Likewise `isRelayWsPath`
    (`js/chat-live.js:1030`) tests for `/api/live/relay/` in the URL and is now always `false`.
  - `voiceAllowDirectGoogleDevOverride` (`js/chat-live.js:231-238`) — the localStorage escape
    hatch whose comment says `direct_google` "often fails with 1011" — is **defined and never
    called**. It is dead code and its comment is stale. Filed in §9.
- **Threshold — GO:** ≥ 9/10 trials reach `setupComplete` with audio, and **no 1011** attributable
  to host identity.
- **Threshold — NO-GO:** any reproducible 1011/4403 that disappears when only the chat host is
  swapped back to Express. That would falsify the core premise and must be recorded here before
  anything is deleted.
- **Caveat to respect while measuring:** `aws/chat-express-template.yaml:161` sets
  `GEMINI_LIVE_MINT_TIMEOUT_SEC: '50'` on ECS, while `aws/chat-template.yaml:56` gives the Lambda
  a **60 s** total timeout. A 50 s mint budget inside a 60 s invocation leaves almost no headroom
  on a cold start; the mint timeout must be re-tuned for Lambda or M-3 will fail for a timeout
  reason unrelated to 1011.

### M-4 — Cost and abuse exposure (added by this spike; not in the original proposal)

ECS Express is a **fixed** bill; Lambda is **metered**. Today the Express host has **no throttle
in front of it at all** — recorded at `docs/tdd/project-invariants.md:588-590` — whereas the
Lambda stack's HttpApi throttles to **5 rps / burst 10** (`aws/chat-template.yaml:67-69`). **A
Function URL has no API Gateway, so migrating to one DISCARDS that throttle.** The combination of
an unthrottled public endpoint, per-invocation billing, and a paid upstream model is a
cost-amplification path that the current fixed-price host does not have.

- **Measure:** projected monthly cost at current traffic, plus the worst-case monthly cost at the
  endpoint's achievable request rate.
- **Threshold — GO:** expected monthly cost < **$10** **and** a hard ceiling is configured —
  Lambda **reserved concurrency** plus a billing alarm — so the worst case is bounded.
- **Threshold — NO-GO:** no enforceable ceiling. "Cheaper on average, unbounded in the tail" is
  not an improvement over a $47 fixed bill for a personal portfolio.
- This measurement interacts with **M8 / ADR-0021** (rate guard), which is where the throttle
  properly belongs.

---

## 5. Decision (not yet taken) — **SUPERSEDED by §21.** Read §21 for the current decision.

**Deferred pending M-1 through M-4.** The honest current state *as of the pre-measurement spike*:

- The **capability** premise of ADR-0002 is half-dead: voice no longer needs the container, and
  that is settled by code, not opinion.
- The **SSE** premise is untested on LWA in this repo. It is plausible on the published behaviour
  of Function URL response streaming, but plausible is not measured, and the specific risk here
  is not the transport — it is the **cold start of a fat container image whose LangChain
  dependency ADR-0007 Phase 2 deferred**.
- Therefore: **ECS Express stays until M-1, M-2 and M-3 pass and M-4 has an enforced ceiling.**

---

## 6. Open measurements — the gating list

| # | Measurement | Threshold | Status (2026-10-06) |
|---|-------------|-----------|---------------------|
| M-1 | SSE TTFT through LWA streaming vs ECS; chunk count > 1 | ≤ ECS median + 150 ms; p95 ≤ +400 ms; incremental or fail | **PASS on the transport half, now over public HTTPS** — §24.1: 200 `text/event-stream` through CloudFront, token events 38–216 ms apart, headers 11.6 s before the first body byte. **The A/B vs stage Express is still owed and is BLOCKED** — stage Express is at `desiredCount: 0` (§24.5). The absolute 14 s TTFT is model latency, not transport. |
| M-2 | Cold-start TTFT, container-image Lambda, ≥15 min idle | ≤ 3 s median / 5 s worst (5–10 s conditional) | **PASS** — 1542 ms first chunk cold. Predicted to fail; did not (§13.2, §14.2). |
| M-3 | Browser-direct voice against a Lambda-hosted mint | ≥ 9/10 `setupComplete`, no host-attributable 1011 | **OPEN** — §18.D |
| M-4 | Monthly cost + enforced worst-case ceiling | < $10 expected **and** reserved concurrency + billing alarm | **OPEN** — thresholds now concrete in §15.3 |
| M-5 | **The ANONYMOUS front door.** Function URL returns `403` with `AuthType: NONE` and an apparently correct resource policy | root cause known; the design does not depend on `AuthType: NONE` | **RESOLVED.** Cause: an AWS-side account guardrail on anonymous Function URLs (§23.1). It governs `AuthType: NONE` **only** and does **not** extend to signed service principals (§24.2). The browser half was never M-5's to answer — it is M-8's; the two 403s had **different causes** and this table previously conflated them. One cheap open re-test is filed in §24.2, gating nothing. |
| M-6 | **CloudFront must not buffer the SSE stream** (§17.2) | no buffering; TTFT within +150 ms of direct; same chunk count | **PASS on the buffering clause** — §24.1, decisively (headers 11.6 s early, one token per socket read). **The parity clause is NOT measured** and merges into B1, which is blocked (§24.5). |
| M-8 | **The SIGNED path — §23.1.2's critical-path question, promoted to a numbered gate so it stops living inside M-5.** Does CloudFront OAC signing work for `POST` with a body under `InvokeMode: RESPONSE_STREAM`? | ≥1 unsigned-client HTTPS call returns a streamed 200 | **RESOLVED — PASS.** Cause of the 403 was a **documented prerequisite omitted**: OAC needs **both** `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` (§24.3). None of §19's four hypotheses named it. **§23.1.2's NO-GO risk is retired** (§24.2). Also measured: `UNSIGNED-PAYLOAD` → 403, so `x-amz-content-sha256` is mandatory (§24.6). |
| M-7 | **NEW.** An enforceable per-function concurrency cap exists | `ReservedConcurrentExecutions` settable at ≥ 1 | **BLOCKED by an account quota** — `ConcurrentExecutions=10` with minimum unreserved 10, so every reservation is rejected (§23.2). Needs a Service Quotas increase. |

The cheapest way to run all four is **one throwaway stage deploy** of the LWA variant alongside
the existing Express stage service, with the stage chat meta pointed at it locally (never
committed — see §7.1). Nothing needs to be deleted to measure.

---

## 7. Blast radius — what actually breaks if ECS goes away

Verified against the tree. **The deploy-script half of the original concern has largely already
been removed; the frontend-meta half is bigger than assumed.**

### 7.1 The committed `gvp:chat-api-url` meta — the real coupling

This is the load-bearing item. The Express hostnames are **opaque, ECS-generated** (`gv-<32 hex>`)
and are **hardcoded in four committed files plus a guard test**:

- `index.html:48` and `admin/index.html:16` on `agent` →
  `gv-d7fa1a51ec09445caf0d435348131479.ecs.us-east-2.on.aws`
- `index.html:48` and `admin/index.html:16` on `main` →
  `gv-0277d83a39d54698a254a52e95dcd476.ecs.us-east-2.on.aws`
- `test/frontend-api-url-env-guard.test.mjs:34` (prod) and `:41` (stage) pin those exact hosts.

Per **invariant 11** (`docs/tdd/project-invariants.md:253-269`), the committed meta is
load-bearing — the deploy workflows run `SYNC_API_URLS=0`, Amplify serves the committed HTML
as-is, and the guard is a fail-fast step in `.github/workflows/deploy-prod.yml:43`. So a host swap
is a **coordinated two-branch change**: 4 metas + 2 guard constants + the invariant text, or the
prod deploy fails closed (which is the guard working correctly).

Consumers that follow the meta automatically and need **no** code change:
`js/site-config.js:15` (`chatApiUrl`), `admin/index.html:28` (`window.__CHAT_API_URL__`), and
`js/admin.js:26-28`, which derives `chatSmokeUrl` from it. The **admin deep smoke probe therefore
does not break on a host swap** provided the meta is updated — contrary to the initial concern.

### 7.2 `scripts/integrate-and-deploy.sh` — much less coupled than assumed

- There is **no ECS/ALB discovery and no auto-sync left**. `CHAT_SYNC_CHAT_URL` comes from
  `CHAT_PROD_CHAT_API_URL` / `CHAT_STAGE_CHAT_API_URL`, else the Lambda stack's `ChatPostApiUrl`
  (lines 374-378). No `CHAT_ECS_*` variable is read anywhere in the script.
- `CHAT_EXPRESS_URL` is read from the stack output and **echoed, then discarded** (lines 360-365)
  — it never feeds the meta. `CLUSTER=""` / `SERVICE=""` at lines 366-367 are dead assignments.
- Lines 31 and 404-406 **already** say "Voice is browser-direct … any HTTPS chat host works" and
  report `OK — text + browser-direct voice (no server WebSocket needed)`. The script is already
  correct about voice.
- **What would change:** the `CHAT_DEPLOY_TARGET=express` branch (lines 312-369) and the
  `chat-express-template.yaml` deploy would be replaced by a Function-URL path. ~55 lines.

### 7.3 `CHAT_ECS_*` env and `CHAT_LIVE_RELAY` — documentation-only, already dead

- **`CHAT_ECS_*` survives only in prose:** `README.md:45,46,63,78`,
  `secrets.example/chat-deploy.env.example:46-107`, `CLAUDE.md:126,132`, and
  `docker/chat/README.md:70`. No script or template reads it. Deleting ECS invalidates **docs**,
  not behaviour.
- **`CHAT_LIVE_RELAY` is read nowhere in the application.** It persists only as a set-but-unread
  value at `aws/chat-template.yaml:95` (and its description at `:146`). `CHAT_LIVE_VOICE_STRICT`
  is likewise read nowhere. The `docker/chat/Dockerfile` does **not** set `CHAT_LIVE_RELAY=1`,
  despite `README.md:51` claiming it does.
- **The `/health` `liveRelay` field does not exist.** `docker/chat/app/main.py:462-464` returns
  exactly `{"ok": True}`. The field is a **documentation claim only**
  (`docker/chat/README.md:105`). Nothing to migrate.

### 7.4 Admin host-status card

`GET /api/chat/host-status` exists server-side (`docker/chat/app/main.py:590-623`) and is
`ADMIN_API_KEY`-gated. **There is no frontend card consuming it** — no reference to
`host-status` / `hostStatus` exists in `js/`, `admin/`, or `test/`. Its docstring mentions ECS
("without SSHing to ECS") and would need a wording update, nothing more.

### 7.5 The deep smoke probe — the one place a real timeout risk lives

`GET /api/chat/smoke?deep=1` (`docker/chat/app/main.py:655-733`) opens an **outbound** WSS to
Google via `probe_live_session` (`live_gemini.py:275`), bounded by `SMOKE_LIVE_TIMEOUT` (default
**25 s**, `main.py:714-715`), with `open_timeout=15` and a 30 s `recv` inside
(`live_gemini.py:277-290`). Outbound sockets work on Lambda, but **25 s of probe inside a 60 s
invocation plus a possible cold start is tight**, and the daily report (`report=1`) is exempt from
the cooldown and calls it. The probe's timeouts and the function timeout must be re-tuned
together; otherwise the daily digest starts reporting spurious `live probe timeout`.

### 7.6 The ALB — not in the template, not CFN-deletable

`aws/chat-express-template.yaml:146` declares a single `AWS::ECS::ExpressGatewayService`. **The
ALB is not a resource in this stack at all** — ECS creates and owns it
(`AmazonECSManaged=true`). Consequences: CloudFormation cannot delete it, and because it is
shared, **deleting one Express service does not remove it**. The $29 only disappears when the
**last** Express service across both environments is gone. A partial migration (stage only)
saves the stage Fargate task (~$9) and **none** of the ALB cost.

---

### 7.7 `x-amz-content-sha256` — the one frontend code change the migration requires (added §24.6)

With CloudFront + OAC in front of the Function URL, **every `POST` the browser sends must carry
`x-amz-content-sha256: hex(SHA-256(body))`** — a documented AWS requirement ("Lambda doesn't
support unsigned payloads"), measured here as `UNSIGNED-PAYLOAD` → **403
`InvalidSignatureException`** (§24.1 probe B). So the blast radius is **not** confined to the meta
tag of §7.1: `js/chat.js:1147-1163` must serialize the body once, hash that exact string, and send
that same string. It also hits **`POST /api/live/session`** whenever the distribution's default
behavior targets the Function URL origin. **This narrows §13.1/§21's "the application needed no code
change" to the server only.** CORS needs no change — `main.py:436-443` already sets
`allow_headers=['*']` (verified). Full detail, including the secure-context consequence for local
development, in §24.6.

---

## 8. Documentation defect — recorded as its own item

An outside analysis concluded ECS was *required for voice*. It reached that conclusion honestly,
by reading the committed docs. **These passages describe a deleted architecture:**

| Location | Stale claim |
|----------|-------------|
| `README.md:51` | "Voice transport needs a **WebSocket-capable** chat host with **`CHAT_LIVE_RELAY=1`** (default in the Dockerfile for ECS images)"; "the browser client **does not** open a `direct_google` Live socket by default (avoids Google **1011**); **use ECS/ALB for real voice**"; describes a deploy-script warning and `CHAT_ECS_AUTO_SYNC_CHAT_URL` that no longer exist. |
| `docker/chat/README.md:32` | Documents `CHAT_LIVE_RELAY` as live, pointing at `/api/live/relay/…`, and says `0` means "**voice from the browser typically fails** with Google close 1011". |
| `docker/chat/README.md:33-34` | `CHAT_LIVE_RELAY_BRIDGE_TTL_SEC`, `CHAT_LIVE_RELAY_UPSTREAM_OPEN_SEC` — settings for a deleted relay. |
| `docker/chat/README.md:35` | `CHAT_LIVE_VOICE_STRICT` — read nowhere in the app. |
| `docker/chat/README.md:62` | Table row claiming the Lambda shape makes the client "block `direct_google`". |
| `docker/chat/README.md:105` | `GET /health` → `{"ok": true, "liveRelay": true\|false}` — the field does not exist. |
| `scripts/sync-site-api-urls.mjs:18` | Help text: "Lambda-only execute-api will fail voice with 1011." |
| `docs/tdd/project-invariants.md:253-256` | Invariant 11 prose names `chat-api.marwanelgendy.link` / `chat-api-stage.marwanelgendy.link` as the chat hosts, but its own implementing test pins raw `*.ecs.*.on.aws` hostnames (`test/frontend-api-url-env-guard.test.mjs:34,41`) and there is no custom chat domain. |

**Per instruction, the READMEs are NOT fixed in this pass.** This is filed for the loop. It is
material because these docs are the mechanism by which the retired relay would be "restored" —
see the §3.1 fence. Note the cost of the defect is already realised: it produced a wrong
architectural conclusion from a correct reading of the repo.

---

## 9. Drift found — for the loop to fix, not the architect

Dead code whose comments actively misinform about the voice/host relationship:

1. `js/chat-live.js:231-238` — `voiceAllowDirectGoogleDevOverride` is **defined and never
   called**; its doc comment says `direct_google` "often fails with 1011".
2. `js/chat-live.js:1264-1267` — the `VOICE_UNAVAILABLE_ON_HOST_MSG` branch is **unreachable**:
   its flag is set only at `:1117-1124` under `transport === 'relay'`, which `main.py:1110` never
   mints.
3. `js/chat-live.js:1030` — `isRelayWsPath` is permanently `false`; the relay-only branches it
   guards (`:1048, 1063, 1075, 1087, 1109, 1139`, plus `voiceRelayCloseUserMessage` and
   `liveSetupTimeoutMessage`'s relay arm at `:218-223`) are dead.
4. `aws/chat-template.yaml:95` — sets `CHAT_LIVE_RELAY: '0'`, which no code reads.
5. `scripts/integrate-and-deploy.sh:360-367` — `CHAT_EXPRESS_URL` computed then discarded;
   `CLUSTER=""` / `SERVICE=""` dead.
6. `docker/chat/Dockerfile:11,17-18` — installs `requirements-dev.txt` and copies `pytest.ini` +
   `tests/` into the runtime image. **Re-scoped 2026-10-06:** this is the **ECS** image only, and it
   is **NOT** an input to M-2 — the Lambda image is `Dockerfile.lambda`, which does neither (§14.2).
   Still worth fixing (dev deps and tests do not belong in a runtime image), but it is now a tidy-up,
   not a gate.

Cleaning 1–3 is the cheapest insurance that nobody re-derives "ECS is needed for voice" from the
code the way §8 shows they did from the docs.

---

## 10. Interaction with planned work — M6 is the one to stop

**M6** (`docs/plan-2026-09-port.md:215-239`, ADR-0019) is ~5 slices of **ECS Express
scale-to-zero**: a warm Lambda, an idle sweep, `MinCapacity` pinning, an admin host-state card,
all `CHAT_SCALE_TO_ZERO=1`-gated. Its premise is that the Express host runs 24/7 at
`MinTaskCount: 1` (`aws/chat-express-template.yaml:79-80`).

**Plainly: do not build M6's ECS half yet, and do not delete ECS yet either. Run this spike's
measurements first — they are ~1 stage deploy, against M6's ~5 slices.**

- The two are **mutually exclusive on their infrastructure half.** M6 engineers the ECS task down
  to zero; this ADR asks whether the ECS task should exist. If Lambda wins, **M6's infra work is
  sunk** — and its own Gate G2 is already a go/no-go that may sink it anyway (if Express refuses
  `MinTaskCount=0` or denies `RegisterScalableTarget`). Two spikes now compete to invalidate the
  same 5 slices; this one also removes $29 of ALB that M6 **cannot** touch, because scale-to-zero
  leaves the ECS-managed ALB standing (§7.6).
- **M6's economics are strictly worse than deletion.** Best case, scale-to-zero saves the ~$18
  Fargate and keeps the ~$29 ALB. Deleting both Express services removes both. M6 is the right
  project only if ECS must stay.

### 10.1 What of M6 survives either way

**The FE cold-path work survives, and should be treated as independent of the hosting decision.**
Lambda cold starts (M-2) create the same user-visible problem as a cold ECS task:

- `js/lib/warm/warm-client.js` — the **activation beacon** on page load and the **5-minute
  heartbeat** while chat/voice is live.
- The **wait-then-resend** path: `502/503/504` → "Assistant is waking up (~1 min)" with automatic
  resend.
- The admin **host state** display (relabelled: "cold / warming / warm" rather than
  "scaled-to-zero").

What dies with ECS is the **infrastructure** half: `chat-warm-core.js`'s `decideActivation` /
`decideIdleScaleIn`, the ECS-scoped IAM (`service/*/portfolio-chat-*`), the idle sweep, and the
`MinCapacity=1` pinning — Lambda needs none of it (its scale-to-zero is free and automatic, which
is the whole point).

**M7** (`docs/plan-2026-09-port.md:241`) depends on M6 for its `chat_cold_wait` alert trigger.
That trigger comes from the **FE cold path**, which survives per above — so M7's dependency is
satisfied by the surviving half. Worth confirming when M7 is scheduled.

---

## 11. Rollback, and what is irreversible

### Reversible
- **Adding** an LWA/Function-URL variant alongside the running Express services. Costs one
  function; changes nothing for users. **All four measurements can be taken here.**
- Repointing the meta — but only as a *local, uncommitted* edit during measurement. Committing it
  trips invariant 11 and the prod guard (§7.1), which is the guard working as designed.
- Rolling the meta back to the Express hostname **while that Express service still exists**.

### Irreversible — the sharp edge
- **The Express service URL is not recoverable.** `gv-<32 hex>.ecs.us-east-2.on.aws` is generated
  per service. Delete `gvp-chat-prod-express` and that hostname is **gone for good**; recreating
  the service yields a **different** hostname. So "roll back to ECS" is not a redeploy — it is a
  redeploy **plus another coordinated two-branch meta + guard-constant change** (§7.1). The same
  is true in the other direction, which is exactly why a **custom domain**
  (`chat-api.marwanelgendy.link`, already named in invariant 11's prose but never built) would
  make this seam cheap to move in either direction. **Standing up that CNAME before any migration
  converts an irreversible step into a DNS flip, and is the single highest-leverage preparatory
  action available.**
- **The shared ALB is `AmazonECSManaged` and is not in any template** (§7.6). It is removed by ECS
  only when the last Express service goes. Two consequences: deleting **one** service saves $0 of
  the $29, and once **both** are gone the ALB and its 3 public IPv4 addresses are released — a new
  one would come back with a different name and different IPs. Nothing depends on those IPs today
  (no DNS record, no allowlist found), but that must be re-checked before deletion.
- **Discarding the HttpApi throttle** (§M-4) is reversible in principle but easy to forget; the
  Function URL must ship with reserved concurrency from day one, not as a follow-up.

### Recommended order (nothing destructive) — **SUPERSEDED by §21**, which adds M-5 first, M-6
### before the prod roll, and the custom-domain sequencing of §17.2
1. Take **M-1 … M-4** on a stage-only LWA Function URL, in parallel with the running Express
   stack. Commit no meta change.
2. If any threshold fails, record the number here and **stop**; M6 then becomes the live option.
3. If all pass: stand up the **custom domain** first, cut over behind it, run both hosts in
   parallel for one observation window, then delete **stage** Express, then **prod** — the ALB
   releases only after the second.
4. Supersede this ADR with the decision and a migration note covering the meta/guard/invariant
   change set.

---

## 12. Consequences of leaving this open

*(§12 was written before the measurements; M-1/M-2 are now taken — §13. The rest still holds.)*

- **ECS Express keeps costing ~$47/mo** until the measurements are taken. That is the price of not
  deciding on reasoning alone, and it is the correct price to pay — the alternative is deleting a
  working production host on an untested premise.
- **M6 is blocked**, deliberately. Building it would sink ~5 slices into infrastructure this spike
  may delete. Its FE cold-path slices (§10.1) are **unblocked** and worth building now: they are
  needed under either outcome.
- **The §8 doc defect stays live** until the loop fixes it, and it is the most likely cause of a
  future wrong decision about this seam. It is the highest-value cheap fix on this list.
- **The §3.1 fence is now on record.** Any future server WebSocket voids this ADR's premise and
  must supersede it explicitly.

---

# AMENDMENT — 2026-10-06: spike results and the decisions a side-by-side stage deploy needs

Everything below was added after the measurements. §1–§12 above are the spike as first written,
with four in-place corrections marked `CORRECTED` / `WITHDRAWN` / `Re-scoped` and itemised in §14.

## 13. Spike results — M-1 and M-2, measured

Method: a throwaway container Lambda, LWA with `AWS_LWA_INVOKE_MODE=response_stream`, behind a
Function URL with `InvokeMode: RESPONSE_STREAM`, exercised through `invoke_with_response_stream`.
Every resource was deleted afterwards. Image built from `requirements-lambda.txt` **plus an
explicit `boto3==1.35.86`** — see §20.

### 13.1 Warm — the transport works, and it keeps flushing

| | |
|---|---|
| Payload chunks | **42** |
| First chunk | **222 ms** |
| Last chunk | **1234 ms** |
| Spread (last − first) | **1012 ms** |
| Total body | 2136 bytes |

This settles the question §1.1 left open. 42 chunks spread over a full second is not a transport
that coalesces — it satisfies M-1's "must also confirm" clause (`streamChunkCount` > 1) with a
large margin. The buffered path was checked too: a non-streaming invoke returned
`{"statusCode":200,"headers":{…},"cookies":[]}` + delimiter + body, i.e. **LWA emits Lambda's
documented response-streaming wire format correctly** in both modes.

**And the application needed no code change.** `docker/chat/app/main.py:852-860` already returns a
host-agnostic `StreamingResponse`; **Mangum was the entire limitation**, exactly as §1.1 claimed
from reading the code. That claim is now measured, not inferred.

**What M-1 still owes:** these numbers come from the SDK, which bypasses the Function URL front
door, TLS and any intermediary. They prove LWA streams. They do **not** prove the browser path, and
they are not an A/B against ECS. The interleaved comparison against the **stage** Express host is
§18.B1, and it is a condition of acceptance.

### 13.2 Cold — the measurement predicted to fail, which did not

| | |
|---|---|
| Chunks | **42** (unchanged — no coalescing on a cold environment) |
| First chunk | **1542 ms** |
| Last chunk | **2492 ms** |
| Spread | **950 ms** |
| Delta vs warm, first byte | **+1320 ms** |

Against M-2's threshold (**GO** ≤ 3 s median / ≤ 5 s worst): **PASS, with roughly half the budget
unused.** §4 predicted this would fail and said a cold start "of that order is disqualifying". It
was wrong, for a specific and recordable reason — §14.2.

**Separate number, not a cold start:** the **first-ever** invoke after deploy, which pulls image
layers, was **~11 s**. That is a deploy-time cost and it must not be reported as user-facing
latency, nor used to argue M-2 either way. The mitigation is one throwaway invocation in the deploy
script after `sam deploy` (§20.5), so no visitor ever pays it.

## 14. Corrections to this ADR as first written

Recorded rather than silently rewritten, because three of the four produced wrong conclusions.

### 14.1 M-1's baseline named the wrong host
§4/M-1 used the **prod** Express host as the baseline. The LWA variant deploys to **stage**, so the
baseline is the **stage** host `gv-d7fa1a51ec09445caf0d435348131479.ecs.us-east-2.on.aws`
(`test/frontend-api-url-env-guard.test.mjs:41`, and the value committed on `agent` at
`index.html:48` / `admin/index.html:16`). Comparing a stage Lambda against prod Express would mix a
host change with an environment change. Corrected in place.

### 14.2 M-2's risk analysis cited the wrong image AND a dependency that is already gone — **so ADR-0007's ~100 s figure is stale and must stop being cited**

Three separate errors in one bullet:

1. **Wrong Dockerfile.** `docker/chat/Dockerfile` (dev deps at `:11`, `pytest.ini` + `tests/` at
   `:17-18`) is the **ECS** image. The Lambda image is **`docker/chat/Dockerfile.lambda`**, declared
   at `aws/chat-template.yaml:72-74`; it installs only `requirements-lambda.txt`, no dev
   dependencies, and copies **no** tests. The fat-image concern was never about the Lambda image.
2. **LangChain is already gone.** Neither `docker/chat/requirements.txt` nor
   `requirements-lambda.txt` contains any `langchain*` or `rank-bm25`; no module under
   `docker/chat/app/` imports one; `docker/chat/app/messages.py:1` is explicitly the
   "dependency-free internal message value types (replaces `langchain_core.messages`)". **ADR-0007
   Phase 2's LangChain half shipped and ADR-0007's status line was never updated** (§22.2).
3. **Therefore ADR-0007's `~100 s cold start`
   (`docs/decisions/ADR-0007-lean-chat-backend.md:22`, repeated at `:126,176,183`) measured a
   different, fatter, LangChain-bearing image that no longer exists in this repo. It is not
   evidence about any image that can be built from this tree today, and it must not be cited in any
   future hosting argument.** The measured replacement figure is **1542 ms** (§13.2).

The honest summary: M-2 was not risky for the reason given. It was risky because it was unmeasured.

### 14.3 §11's CNAME claim is right about the goal and wrong about the mechanism
§11 says standing up `chat-api.marwanelgendy.link` "converts an irreversible step into a DNS flip".
**A bare CNAME to an AWS-managed endpoint cannot work.** `<id>.lambda-url.<region>.on.aws` serves a
certificate for `*.lambda-url.<region>.on.aws`; a browser sending SNI/`Host:
chat-api.marwanelgendy.link` gets a name mismatch and fails TLS before any HTTP happens. The same is
true of `*.ecs.<region>.on.aws` today, and nothing in `aws/chat-express-template.yaml:145-181`
configures a custom domain. The indirection layer has to terminate TLS for our name — see §17.

### 14.4 The mint-timeout caveat is not ECS-specific
§4/M-3 presented `GEMINI_LIVE_MINT_TIMEOUT_SEC: '50'` as an ECS setting
(`aws/chat-express-template.yaml:161`). The **code default is also 50** —
`docker/chat/app/main.py:1068`. The existing Lambda stack sets the env nowhere and has
`Timeout: 60` (`aws/chat-template.yaml:56`), so it already runs a 50 s mint budget inside a 60 s
invocation **today, by default**. Filed as §22.5.

## 15. DECISION 1 — Function URL. There is no API Gateway option.

### 15.1 HTTP API v2 does not support response streaming. Neither does REST.

Lambda response streaming has exactly two front doors: a **Lambda function URL** with
`InvokeMode: RESPONSE_STREAM`, and the **`InvokeWithResponseStream`** API. The path that read like
API Gateway support — `/2021-11-15/functions/{FunctionName}/response-streaming-invocations` — is the
**Lambda data-plane endpoint for `InvokeWithResponseStream`**, i.e. the Lambda API reference, not an
API Gateway integration. (It is also the path the measurements in §13 went through.)

**API Gateway buffers the entire Lambda proxy response before returning it**, in both flavours: HTTP
API (v2) and REST. Putting a `RESPONSE_STREAM` function behind `AWS::Serverless::HttpApi` returns
the buffered body — the precise defect that made the Lambda stack "degraded"
(`docs/architecture.md:98`). A REST API does not fix it. So the choice §4/M-4 framed as
"Function URL vs keep the throttle" is not a choice: **keeping an API Gateway means keeping Mangum's
behaviour, which means there is no reason to do any of this.**

Two further constraints point the same way, and one of them is a live defect:

- API Gateway's integration timeout is **29–30 s**. The deep probe's `SMOKE_LIVE_TIMEOUT` default is
  **25 s** (`main.py:714-715`) with a 30 s inner `recv` (`live_gemini.py:277-290`). **The existing
  `chat-template.yaml` stack therefore cannot reliably complete `GET /api/chat/smoke?deep=1`
  today** — filed §22.6. A Function URL carries the function's full timeout and removes this cap.
- Function URLs support up to the function timeout, so §18.D3's `Timeout: 90` is available.

### 15.2 Decided shape

- **`InvokeMode: RESPONSE_STREAM`** — non-negotiable; it is the whole point.
- ~~`AuthType: NONE`~~ → **`AuthType: AWS_IAM` behind CloudFront OAC. REVISED — see §23.1:**
  `NONE` is **blocked account-wide** on account `429844072978`. Measured, not suspected.
- **No `Cors` block on the Function URL.** FastAPI's `CORSMiddleware` already owns CORS via
  `CHAT_CORS_ORIGINS`. Function URL CORS makes Lambda answer preflight and inject its own
  `Access-Control-Allow-*`, which duplicates the app's headers; browsers reject a response carrying
  two `Access-Control-Allow-Origin` values. **One owner for CORS, and it stays the app** — the same
  arrangement ECS has, which also keeps the stage comparison like-for-like. §18.A4 pins it.
- **No API Gateway in the new stack.** `chat-template.yaml`'s throttled HttpApi stays deployed and
  untouched as a zero-cost buffered fallback (§16).

**Rejected alternatives, for the record:** (a) split the origin — HttpApi for everything, Function
URL for the streaming route only: breaks ADR-0001's single `<meta>` base, doubles the CORS surface,
and the streaming route is the expensive one, so it throttles nothing that matters; (b)
`AuthType: AWS_IAM` called directly from the browser: needs credentials in the page.

### 15.3 M-4, made concrete — and an honest statement of what reserved concurrency does *not* bound

Arithmetic at the inherited `MemorySize: 1536` (`aws/chat-template.yaml:58`), x86, $0.0000166667
per GB-s → **$0.000025 per second**:

- **Per turn:** ~1.5 s billed at the measured 1234 ms last-chunk → **~$0.00004**. A thousand turns a
  month is **~$0.04**. At realistic portfolio traffic the Lambda bill rounds to zero, and the
  ~$29–47 of ECS is the whole of the saving.
- **Per pinned concurrent execution at 100% duty:** 2,592,000 s × $0.000025 = **$64.80/mo**.

That second number is the point: **reserved concurrency bounds blast radius and the number of
simultaneous paid Gemini calls — it does NOT bound dollars.** At 1536 MB, *one* continuously busy
execution already costs more than the ECS bill it replaces. Any claim that "reserved concurrency is
the cost ceiling" is false and this ADR will not carry it.

**Controls to ship with the stage stack, day one, as concrete numbers:**

| Control | Stage | Prod |
|---|---|---|
| `ReservedConcurrentExecutions` — **currently UNSETTABLE on this account, §23.2** | **2** | **3** |
| Alarm: `Invocations` Sum ≥ **2,000 / 5 min** → SNS email | required | required |
| Alarm: `Invocations` Sum ≥ **20,000 / 1 h** → SNS email | required | required |
| Alarm: `Duration` Sum ≥ **1,800,000 ms / 1 h** (30 min of compute) → SNS email | required | required |
| AWS Budget, Lambda-scoped, **$15/mo**, ACTUAL at 80% + 100% | required | required |
| AWS Budget, account, **$70/mo**, ACTUAL at 80% + 100% | required | required |
| Request-rate ceiling in front (CloudFront + WAF rate-based rule, **300 requests / 5 min / IP**) | not required | **required** |

The duration alarm is not redundant with the invocation alarms: a small number of long invocations
bills like a large number of short ones, and 90 s timeouts (§18.D3) make that reachable.

**Kill switch, documented and rehearsed, not improvised during an incident:**
`aws lambda put-function-concurrency --function-name <fn> --reserved-concurrent-executions 0` —
immediate, returns 429 to every caller, reversible in one command. §18.E4 requires it to be
exercised once on stage. **It should still work on this account even though reservations of 1–5 are
rejected** (§23.2): reserving **0** adds nothing to the account's reserved sum, so it cannot push
unreserved concurrency below the floor. "Kill" is available while "throttle" is not — confirm it
once, because it is currently the only hard control reachable.

**M-4 GO requires all of:** expected monthly cost **< $2** computed from the actual 30-day turn
count in the transcripts table × measured billed duration; the reserved concurrency value deployed;
all three alarms deployed and each validated once; both budgets created; the kill switch rehearsed;
and, for prod only, the rate-based rule live. **M-4 NO-GO** if any of these is deferred to "a
follow-up" — §11 already warns that the discarded throttle is easy to forget, and this is the
measurement that can make the migration cost more than it saves.

**Cost lever worth measuring while on stage (free, it is one template parameter):** 1536 MB was
sized for the LangChain-era image that §14.2 shows is gone. Re-measure M-1/M-2 at **1024 MB**
($43.20 per pinned execution-month) and **512 MB** ($21.60). If 512 still clears M-2, the worst case
drops below the saving and the cost argument stops being delicate.

## 16. DECISION 2 — a new template file, and the glob must grow with it

**Agreed with the proposal: a new file, `aws/chat-stream-template.yaml`, deployed as its own stack
(`gvp-chat-stream-stage`).** Reasons, in order: it cannot disturb the running Express services; a
CFN stack boundary is the cheapest blast-radius fence available for an experiment that may be
deleted; `sam delete` removes the whole thing; and it leaves `chat-template.yaml`'s **throttled**
HttpApi stack alive as a zero-cost rollback target — which is strictly better than editing it, since
editing it would mean mutating the fallback during the migration that depends on it.

Wire it as a third deploy target: **`CHAT_DEPLOY_TARGET=stream` → `aws/chat-stream-template.yaml`**,
parallel to the `express` branch at `scripts/integrate-and-deploy.sh:312` and the Lambda default.
Do not touch the `express` branch while both hosts run.

**One correction to the rationale: "a new file is ungated by `SECURITY_GLOB`" is a bug, not a
benefit, and it is not an acceptable reason to prefer the new file.** The new template carries
`GeminiApiKey` (NoEcho) and *defines the public internet-facing surface of the chat* — that is
exactly what the gate exists for. The same change must extend `SECURITY_GLOB`
(`.claude/tdd.config:63`) from `(^|/)aws/(template|chat-template)\.yaml` to
**`(^|/)aws/[^/]*template\.yaml`**, which also closes a pre-existing hole:
`aws/chat-express-template.yaml` is ungated today while carrying **three** NoEcho secrets
(`:20-24`, `:32-35`, `:49-53`) — §22.1. The edit only ever adds gating, so it cannot loosen the
harness; it is nevertheless a `.claude/tdd.config` change and therefore **the owner's to make, not
the architect's and not the loop's**. Recorded here as a requirement of the slice.

**Replace or supersede `chat-template.yaml`? Not decided now, deliberately.** The default answer
when it comes due: keep `chat-template.yaml` deployed and buffered for one full observation window
after the prod cutover, then retire it in its own change. Removing two hosting paths in one change
deletes the rollback you are relying on.

## 17. DECISION 3 — the custom domain is a CloudFront distribution, not a CNAME; it is required before the PROD roll, not before the stage deploy

### 17.1 What it has to be
Per §14.3, DNS alone cannot do this — TLS fails on a name mismatch. The indirection layer is
**CloudFront + an ACM certificate in `us-east-1` + a DNS record at the distribution**, with the
chat host as the **origin**. The reversible flip is then a *distribution origin change*, not a DNS
change and not a meta change. Required configuration, because the default settings break SSE:

- Cache policy **CachingDisabled** (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`).
- Origin request policy **AllViewerExceptHostHeader** (`b689b0a8-53d0-40ab-baf2-68738e2966ac`).
- `AllowedMethods` must include **POST** (`/api/chat`, `/api/live/session`).
- **`OriginReadTimeout: 60`** — the 30 s default is below the 25 s deep probe plus a cold start.
- No compression (same reason as `AWS_LWA_ENABLE_COMPRESSION`, §20.4).

**Origin auth, in preference order:** (1) `AuthType: AWS_IAM` + CloudFront **OAC** so the Function
URL is not publicly invocable at all — **verify OAC signing works for POST-with-body under response
streaming before committing to it**; (2) `AuthType: NONE` plus a CloudFront-injected shared-secret
header checked in the app — rejected unless (1) fails, because it is the only option that breaks
"the app needed no code change"; (3) `AuthType: NONE` with the raw host left reachable, relying on
§15.3's controls — acceptable for **stage**, not for prod.

### 17.2 Timing — decided, then **REVISED by §23.1**
- ~~**Before the stage deploy: NO.**~~ **REVISED: CloudFront + OAC is required BEFORE stage
  acceptance**, because a public Function URL does not exist on this account (§19, §23.1) and so
  there is no raw-host browser path to measure. State the cost honestly: B1 then compares
  *CloudFront → Function URL* against *raw ECS Express*, so **M-6 (does CloudFront buffer SSE?) is
  no longer separable from M-1** and the two must be read together. The original reason for
  deferring it was sound; the account removed the option.
- Original (pre-§23) rationale, kept for the record: it would add a second unmeasured hop to the
  very measurement the stage deploy exists to take, so measure raw against raw first.
- **Before the prod roll: YES, mandatory**, in this order:
  1. Stand up the stage distribution with the origin pointed at the **existing stage Express host**.
  2. New gate **M-6 — CloudFront must not buffer SSE:** TTFT within **+150 ms** of direct and the
     **same chunk count**. CloudFront passes chunked responses through, but it has to be configured
     to (§17.1), and an unverified CDN in front of an SSE stream reintroduces the original defect
     one layer up.
  3. Re-point the stage meta to `chat-api-stage.marwanelgendy.link`, Express still behind it, and
     let it sit one observation window. **This is the only meta/guard/branch change in the entire
     migration**, and it happens while the host behind it is the known-good one.
  4. Flip the stage distribution's origin to the stage Function URL. That flip is the rehearsal.
  5. Repeat 1–4 for prod.
  6. Only then delete Express — stage, then prod; the ALB releases after the second (§7.6).
- **Not at all: rejected.** Without the indirection layer, every future host change is the
  two-branch meta + guard-constant change of §7.1, and the ECS Express URLs are unrecoverable once
  deleted (§11). The distribution is what makes this seam cheap in *both* directions, which is the
  property §11 was reaching for.

### 17.3 What invariant 11 and its test say — two steps

**Step A, now, independent of this ADR** (it is already filed as a §8 doc defect, and leaving it
is dangerous because the invariant currently *reads as if the custom domain exists*, which is
licence to skip §17.2): invariant 11's prose at `docs/tdd/project-invariants.md:253-256` names
`chat-api.marwanelgendy.link` / `chat-api-stage.marwanelgendy.link`, which **do not exist**. Correct
the prose to the raw hosts its own test actually pins (`gv-0277d83a39d54698a254a52e95dcd476…` prod,
`gv-d7fa1a51ec09445caf0d435348131479…` stage), and add one sentence: *there is no custom chat domain
yet; standing one up is ADR-0022 §17.* Also fix the stale implementation references — the prose cites
`index.html:38-39` + `admin/index.html:14`, but the **chat** meta is `index.html:48` and
`admin/index.html:16` (`:14` is the contact meta). **No test change in Step A** — the test is
already correct; only the prose is lying.

**Step B, when the distribution exists:**
- Prose names the two custom hosts, and states *why*: the distribution is the thing that makes the
  chat host swappable without a two-branch change, so a committed meta that bypasses it re-creates
  the irreversibility.
- `test/frontend-api-url-env-guard.test.mjs` — `ENV_HOSTS.prod.chat` → `chat-api.marwanelgendy.link`,
  `ENV_HOSTS.stage.chat` → `chat-api-stage.marwanelgendy.link`. The existing structure needs no
  other change: two distinct hosts, so the prod/stage leak assertions keep working unaltered.
- **One new assertion, and it is the point of the change:** neither committed `gvp:chat-api-url` may
  contain a raw AWS-managed chat host — assert no match for
  `/\.(ecs|lambda-url)\.[a-z0-9-]+\.on\.aws/`. This is what stops a future deploy from quietly
  pointing the meta at a disposable hostname again. It is a *new* guarantee, stronger than
  "prod and stage never carry each other's host", and it is the test-shaped form of §11's lesson.
- Invariant 11's purpose is unchanged throughout: each branch ships its own environment's API bases.

## 18. DECISION 4 — the stage acceptance list

Checkable items. **All of A–G must hold before anything goes to prod**, and §17.2's M-6 is an
additional gate that comes later (it needs the distribution, which stage deliberately does not have).
Measurements that can be taken two ways must be taken over **public HTTPS**, not the SDK — §13.1's
numbers do not count toward acceptance.

**F0 — precondition. CLOSED 2026-10-06 (§24.2, §24.3).** **M-5 (§19) is closed and its root cause
written into this ADR.** Until the Function URL answers over HTTPS, no item in A or B can be
measured at all, so acceptance stalls regardless of how good §13's numbers are. Build the stack
while M-5 is open; do not accept it. — *The endpoint has now answered real browser-shaped HTTPS
requests through CloudFront + OAC; the per-item status of everything below is tabulated in §24.5.*

### A. Transport
- **A1** `POST /api/chat` with `stream: true` over the public Function URL returns
  `content-type: text/event-stream` and ≥ 2 distinct `token` events with strictly increasing arrival
  times and a last−first spread ≥ 200 ms. (Not coalesced.)
- **A2** On the stage page with the meta locally re-pointed (**uncommitted** — §7.1),
  `js/chat.js` → `readSseChat` grows the assistant bubble token-by-token, **with no frontend code
  change**. Visual confirmation.
- **A3** `stream: false` still returns the legacy JSON body, `content-type: application/json`, 200.
- **A4** Preflight `OPTIONS /api/chat` with `Origin: https://chat.marwanelgendy.link` returns
  **exactly one** `Access-Control-Allow-Origin` header. (Pins §15.2: no Function URL `Cors` block.)
- **A5 — added §24.6, and it is a hard requirement, not a note.** Through the distribution,
  `POST /api/chat` **with** `x-amz-content-sha256: hex(SHA-256(body))` returns 200
  `text/event-stream` (**measured** — §24.1 A) and **without** it returns 403
  `InvalidSignatureException` (**measured** — §24.1 B). The hash must be over the exact bytes sent.
  Satisfied for curl; **A2 is where it must be satisfied for the browser**, so A2 is gated on the
  `js/chat.js` change (§24.9 item 11).

### B. Latency — apples-to-apples
- **B1** One machine, one network position, **interleaved** A/B (alternate requests between hosts),
  same prompt, same model, **≥ 20 warm samples each**: stage Function URL vs
  `https://gv-d7fa1a51ec09445caf0d435348131479.ecs.us-east-2.on.aws/api/chat`. Report median + p95
  TTFT for both. **GO:** stream median ≤ Express median **+ 150 ms** and p95 ≤ Express p95
  **+ 400 ms**. Interleaving is not optional — sequential batches measure the network's mood, not
  the hosts. **BLOCKED 2026-10-06: `gvp-chat-express-stage` is at `desiredCount: 0` and returns
  503**, so the baseline host does not answer. Three options and a recommendation (scale stage to 1
  for the duration — well under $1/day) are in §24.5; **it is the owner's call, and a waiver must
  be recorded as a decision, not left as a gap.**
- **B2** **≥ 5 cold samples** over HTTPS after ≥ 15 min idle (or forced by a config update that
  recycles the environment). **GO:** ≤ 3 s median, ≤ 5 s worst. Expected to pass on §13.2.
- **B3** The ~11 s first-invoke-after-deploy is covered by a post-deploy warm-up invocation in the
  deploy script (§20.5), verified by deploying once and timing the first *subsequent* request.
- **B4** Record the chunk count on the HTTPS path and assert it is within 10% of the SDK's 42 —
  a front door that re-chunks is a finding, not a rounding error.

### C. Persistence — into the existing stage table
- **C1** After N stage turns, `page-staging-ChatTranscriptsTable-1XSZI611F4WDM` holds N new rows
  with `listPk = CHAT_TRANSCRIPT`, each carrying `stream: true`, `firstTokenLatencyMs` > 0,
  `streamChunkCount` > 1, `status: ok`.
- **C2** `GET /ready` **after ≥ 1 turn** (stage sets `CHAT_READY_VERBOSE=1`) shows
  `transcripts.configured: true`, `transcripts.disabled: false`, `writes_failed: 0`,
  `writes_succeeded == writes_attempted`. **The "after ≥ 1 turn" is load-bearing** — the boto3 check
  is lazy (§20.2), so `/ready` read before any traffic shows `disabled: false` even when boto3 is
  missing entirely. Reading it too early is how this bug stayed invisible last time.
- **C3** A failing turn also persists: force one error or timeout and confirm a row with
  `status: error`/`timeout` and a populated `errorCode`.
- **C4** The stage admin panel (`window.__CHAT_API_URL__` re-pointed locally) lists the new sessions,
  and the summary's `stream` block is non-zero.
- Note `GET /api/chat/host-status` is **not** usable for C2: neither chat template sets
  `ADMIN_API_KEY`, so it 401s everywhere today (§22.3). `/ready` is the working equivalent on stage.

### D. Voice (M-3)
- **D1** `POST /api/live/session` on the stream host: **≥ 10 trials, 0 failures**, each returning
  `liveVoiceTransport: direct_google` and a `wss://…access_token=…` URL; p95 mint latency < 3 s.
- **D2** Human pass: real browser, HTTPS stage page, voice opened, **audible** audio,
  **≥ 9/10** reach `setupComplete`, and **no 1011 attributable to host identity**. A reproducible
  1011 that disappears when only the host is swapped back to Express is a **NO-GO** that falsifies
  this ADR's premise (§4/M-3) and must be written here before anything is deleted.
- **D3** Timeouts re-tuned **in the template**, not inherited: function **`Timeout: 90`** (not 60),
  **`GEMINI_LIVE_MINT_TIMEOUT_SEC: '15'`** set explicitly — the code default is 50
  (`main.py:1068`), which inside even a 90 s invocation leaves no room beside a 25 s probe, and
  inside the inherited 60 s leaves almost none (§14.4). `SMOKE_LIVE_TIMEOUT` stays at 25.
- **D4** `GET /api/chat/smoke?deep=1` succeeds at least once on a **cold** environment (25 s probe +
  ~1.5 s cold start inside the 90 s timeout), and the `report=1` path — which is exempt from the
  cooldown — runs once on stage without `live probe timeout`.

### E. Controls (M-4)
- **E1** `ReservedConcurrentExecutions: 2` present in the deployed stage template.
- **E2** All three alarms of §15.3 deployed, each validated once (`set-alarm-state` is sufficient)
  and each confirmed to deliver the SNS email.
- **E3** Both budgets created.
- **E4** Kill switch rehearsed on stage: set reserved concurrency to 0, confirm **429**, restore,
  confirm recovery. Record the wall-clock time it took.
- **E5** Expected monthly cost computed **from data** — 30-day turn count from the transcripts table
  × measured billed duration × the chosen `MemorySize` — and **< $2**.

### F. Premise still intact
- **F1** No `@app.websocket` route anywhere in `docker/chat/app/` (the §3.1 fence, re-checked at roll
  time, not just at spike time).
- **F2** `grep -r 'langchain\|rank-bm25' docker/chat/requirements*.txt` still empty — the cold-start
  result of §13.2 depends on it, and a re-added heavy dependency silently invalidates M-2.

### G. Environment parity — otherwise the comparison is not like-for-like
`aws/chat-express-template.yaml:159-176` sets env that `aws/chat-template.yaml:87-99` does **not**.
The new template must set it, or stage measures a differently-configured application and the alert
path dies silently on the new host:
- **G1** Required: `CHAT_ENV` (read at `alerts.py:99`), `RESEND_API_KEY`, `CHAT_ALERT_EMAIL`,
  `CHAT_ALERT_FROM_EMAIL`, `CHAT_ALERT_COOLDOWN_SECONDS`, `CHAT_READY_VERBOSE: '1'` on stage,
  `GEMINI_LIVE_MINT_TIMEOUT_SEC` (§18.D3), `SMOKE_PROBE_KEY`, `CHAT_TRANSCRIPTS_TABLE`
  (= `page-staging-ChatTranscriptsTable-1XSZI611F4WDM`), `CHAT_CORS_ORIGINS`, and the
  `GEMINI_*` model set.
- **G2** Must **not** be set: `CHAT_LIVE_RELAY`, `CHAT_LIVE_VOICE_STRICT` — read nowhere in the
  application (§9.4). Carrying them forward propagates the §8 documentation defect into new
  infrastructure.
- **G3** IAM: `dynamodb:PutItem` + `dynamodb:UpdateItem` on that table and nothing else — mirror
  `aws/chat-template.yaml:76-86` / the Express `TaskRole` at `:123-142` (verified).
- **G4** `AWS_REGION` is supplied by the Lambda runtime; do not set it (the Express template must,
  which is why it appears there).

## 19. M-5 — the unexplained `403`. **RESOLVED: hypothesis 3. Evidence and design change in §23.1.**

> **§24.3 CORRECTS THE FRAME OF THIS WHOLE SECTION.** The list of four below reads as exhaustive
> and is not. The cause of the 403 on the **CloudFront** path was a **fifth** one: AWS's OAC
> documentation requires **two** grants — `lambda:InvokeFunctionUrl` **and**
> `lambda:InvokeFunction` — and the template had only the first. Hypothesis 1 below posed those two
> actions as **alternatives**, which made "both" unreachable from inside this list no matter how
> many probes were run. The two 403s (anonymous → §23.1; signed/CloudFront → §24.3) are **distinct
> failures with distinct causes** and must not be read as one finding.

*(Kept as written, because the ranking was wrong in an instructive way: the cause was the hypothesis
listed third, and the "escape hatch" named in the last paragraph turned out to be the design.)*

A Function URL with `AuthType: NONE` and an apparently correct resource policy (`Principal: "*"`,
condition `lambda:FunctionUrlAuthType: NONE`) returned **403**. The measurements were taken via
`invoke_with_response_stream` instead, which bypasses the front door entirely — **so §13 says
nothing about whether this endpoint is reachable from a browser.** Recorded as a first-class open
item because a Function URL is now the only design (§15.1), so this is load-bearing, and because an
account-level guardrail is one of the live hypotheses.

**Hypotheses, ranked:**
1. **Wrong action in the resource policy.** The Function URL front door authorises
   **`lambda:InvokeFunctionUrl`**, *not* `lambda:InvokeFunction`. A statement granting
   `lambda:InvokeFunction` with the `FunctionUrlAuthType` condition looks correct to the eye and
   yields exactly this 403. Most likely.
2. **Qualifier mismatch** — the URL config created against an alias/version while the permission was
   added to `$LATEST`, or the reverse. `add-permission` must carry the same `--qualifier` as
   `create-function-url-config`.
3. **An account or organisation guardrail** — an SCP or Resource Control Policy denying public
   Function URLs via the `lambda:FunctionUrlAuthType` condition key. **This is the hypothesis that
   matters**, because it would make the §15 design unavailable in this account. This account is not a
   clean sandbox: it holds the shared OIDC provider and non-gvp workloads.
4. **Propagation** — only if the 403 was transient. It was not.

**Settle procedure, all read-only:**
- `aws lambda get-function-url-config --function-name <fn>` → `AuthType`, `InvokeMode`, the URL.
- `aws lambda get-policy --function-name <fn>` → read the `Action` (must be
  `lambda:InvokeFunctionUrl`), the `Principal`, the `Condition`, **and the qualifier in the
  statement's `Resource` ARN**. This settles 1 and 2.
- `curl -i` the URL; capture `x-amzn-ErrorType` and `x-amzn-RequestId` and the body.
  `{"Message":"Forbidden"}` indicates a front-door auth rejection; an `AccessDeniedException` naming
  an explicit deny indicates a policy or SCP.
- Did the request reach the function? Check the `Invocations` metric and the log group for that
  minute. **No invocation at all = rejected at the front door**, which separates 1–3 from anything
  inside the app.
- If the account is in an Organization: `aws organizations describe-organization`, then
  `list-policies --filter SERVICE_CONTROL_POLICY` and `--filter RESOURCE_CONTROL_POLICY`. IAM Access
  Analyzer's public-access findings also surface a Function URL blocked by an RCP.

**Gate:** M-5 must be closed **before stage acceptance** (§18.F0), not before the stack is built.
**If the cause is hypothesis 3, the escape hatch is the direction §17 already points:** CloudFront
with **OAC** and `AuthType: AWS_IAM` needs no publicly-invocable Function URL, and a guardrail
written against `AuthType: NONE` would not block it. In that case §17.2's "not before the stage
deploy" is **overridden** — the distribution becomes a prerequisite of measuring at all, and M-6
must be taken together with M-1 rather than after it. If neither path works, this ADR is **NO-GO**
and ECS Express stays.

## 20. Build constraints

### 20.1 `boto3` must be installed explicitly, and it is not in `requirements-lambda.txt`
`docker/chat/requirements-lambda.txt` omits `boto3` **on purpose**: the Lambda image is built from
`public.ecr.aws/lambda/python:3.12` (`Dockerfile.lambda:3`), whose managed runtime ships it. **An LWA
image on `python:3.12-slim` does not**, so it must install it — exactly the trap documented for the
ECS image at `docker/chat/requirements.txt:8-13` ("the admin dashboard showed zero new sessions
despite the chat host reporting persistence success").

**Decided:** add **`docker/chat/requirements-lwa.txt`** = `-r requirements-lambda.txt` **+
`boto3==1.35.86`** (same pin as `requirements.txt:14`), carrying a comment that points at this
section. Do **not** add `boto3` to `requirements-lambda.txt` — that would pin a boto3 over the
managed runtime's inside `chat-template.yaml`'s image, changing the fallback stack that is not under
test. (`mangum` rides along via `-r` and is unused on the LWA path; harmless, and still needed by
`chat-template.yaml`. Dropping it is a later slimming option, not a gate.)

### 20.2 The failure mode is silent and lazy — not "raises at startup"
Precisely: `transcript_store._get_table` (`docker/chat/app/transcript_store.py:45-55`) catches the
`ImportError`, logs `boto3 unavailable; transcript persistence disabled`, and sets `_disabled = True`.
The `RuntimeError` is raised **per write** in `_persist_sync` (`:70-78`, whose message also says "at startup"), which is what increments
`writes_failed` / `last_error`. Two consequences: the import failure happens at the **first write
attempt**, not at startup, so `/ready` read before any traffic reports `disabled: false` with boto3
entirely absent (§18.C2); and the symptom is an empty table with a healthy-looking container, not a
crash. (`main.py:511-513`'s own comment says "boto3 import failed at startup" — also imprecise;
§22.4.)

### 20.3 LWA configuration the image must carry
- **`AWS_LWA_INVOKE_MODE=response_stream`** — as measured.
- **`AWS_LWA_PORT=8000`** — LWA defaults to 8080; this repo's uvicorn serves 8000
  (`docker/chat/Dockerfile:20-21`). Mismatch presents as a readiness failure, not a stream failure.
- **`AWS_LWA_READINESS_CHECK_PATH=/health`** — `main.py:462-464` returns `{"ok": true}`
  unconditionally. **Do not use `/ready`**: it returns **503** until corpus and provider are up
  (`main.py:550-557`), which would fail the readiness check on every cold start. **And do not leave
  it unset:** LWA's default readiness path is `/`, and **this app has no `/` route** — the only
  roots are `/health:462` and `/ready:550` — so the default probes a FastAPI **404**. The on-disk
  `Dockerfile.lambda-stream` omits this variable (§23.3).
- **`AWS_LWA_ENABLE_COMPRESSION` must stay unset/false.** Response compression buffers — the single
  defect this whole exercise exists to remove.
- `AWS_LWA_ASYNC_INIT=true` is held in reserve as the lever if cold start ever regresses past M-2.
  Not needed at 1542 ms.
- `CMD` runs uvicorn (as the ECS image does), **not** `app.lambda_handler.handler`. The LWA path
  never imports `lambda_handler.py`.

### 20.4 Function settings
`PackageType: Image`; **`Timeout: 90`** (§18.D3); `MemorySize: 1536` for parity initially, then the
1024/512 sweep of §15.3; `ReservedConcurrentExecutions` 2 stage / 3 prod;
`FunctionUrlConfig: { AuthType: NONE, InvokeMode: RESPONSE_STREAM }` and **no `Cors`**.

### 20.5 Deploy
`CHAT_DEPLOY_TARGET=stream` → `aws/chat-stream-template.yaml` (§16). After `sam deploy`, issue **one
throwaway invocation** so the ~11 s image-layer pull is paid by the deploy, not by a visitor
(§13.2, §18.B3).

## 21. Revised decision and ordering

**Decision: conditional GO to build and stage-deploy the LWA/Function-URL variant side by side with
Express. The deletion decision is still NOT taken.** What changed: the SSE premise is measured and
holds (§13.1), and the cold-start risk that §4 expected to be disqualifying is measured at 1542 ms
and is not (§13.2) — for the recorded reason that the prior ~100 s figure described an image this
tree can no longer build (§14.2). What has not changed: voice is unproven on the new host (M-3), the
cost ceiling is specified but not built (M-4), and the endpoint has not yet answered a single public
HTTPS request (M-5).

1. **Settle M-5** (§19) — read-only, minutes. If it is an account guardrail, go to CloudFront+OAC and
   do not build a public Function URL.
2. **Build**: `aws/chat-stream-template.yaml`, `docker/chat/Dockerfile.lwa`,
   `docker/chat/requirements-lwa.txt`, the `CHAT_DEPLOY_TARGET=stream` branch, the §15.3 controls in
   the template. Owner extends `SECURITY_GLOB` (§16).
3. **Deploy to stage** beside Express. Run §18.A–G. **Commit no meta change.**
4. **M-6**: stage distribution, origin = Express first, verify SSE through CloudFront, re-point the
   stage meta to the custom host (the migration's only meta/guard/invariant change — §17.3 Step B),
   then flip the origin to the Function URL.
5. **Prod**: distribution, meta, observation window, origin flip.
6. **Delete** stage Express, then prod Express. The ALB releases only after the second (§7.6).
7. **Supersede this ADR** with the decision and the migration note.

**Still forbidden until all of the above:** deleting any Express service; committing a meta change
(§7.1); building M6/ADR-0019's ECS half (§10). **Unblocked and worth doing now regardless of
outcome:** M6's FE cold-path slices (§10.1), the §8 doc fixes, §17.3 Step A, and §9's dead-code
cleanup.

## 22. New drift found by the amendment — for the loop, not the architect

1. **`aws/chat-express-template.yaml` is not on `SECURITY_GLOB`** while carrying three NoEcho
   secrets (`GeminiApiKey:20-24`, `SmokeProbeKey:32-35`, `ResendApiKey:49-53`) and defining the
   public chat surface. Pre-existing hole; closed by the glob widening in §16. **Owner's change.**
2. **ADR-0007's status line is wrong and actively harmful.** It says Phase 2 (drop LangChain +
   retriever) is **DEFERRED**; the LangChain half **shipped** (§14.2). Until its status and its
   `~100 s cold start` context line (`:22`, echoed `:126,176,183`) are amended, that figure will keep
   being cited as evidence about a current image — **it already produced one wrong conclusion, in
   §4 of this very ADR.** Highest-value fix on this list.
3. **`ADMIN_API_KEY` is set by neither chat template**, so `GET /api/chat/host-status`
   (`main.py:590-623`) returns **401 on every deployed host**. Combined with §7.4 (no frontend card
   consumes it), the endpoint is documented but unusable. Either set the key or stop describing it as
   available.
4. `main.py:511-513` comment claims `disabled=true` means "boto3 import failed **at startup**" — the
   check is lazy, at first write (§20.2). The comment is the reason the check gets read too early.
5. **`GEMINI_LIVE_MINT_TIMEOUT_SEC` defaults to `50` in code** (`main.py:1068`), and
   `aws/chat-template.yaml` sets it nowhere while giving the function `Timeout: 60` (`:56`). The
   existing Lambda stack therefore already runs a 50 s mint budget inside a 60 s invocation.
6. **The existing Lambda stack cannot reliably complete the deep probe.** API Gateway's integration
   timeout is 29–30 s; `SMOKE_LIVE_TIMEOUT` defaults to 25 s (`main.py:714-715`) with a 30 s inner
   `recv` (`live_gemini.py:277-290`). `aws/chat-template.yaml`'s HttpApi caps it below the probe's
   own budget.
7. Invariant 11's implementation references are stale for the chat meta: the prose cites
   `index.html:38-39` + `admin/index.html:14`; the chat meta is `index.html:48` /
   `admin/index.html:16` (`:14` is contact). Fix with §17.3 Step A.

## 23. Second amendment — the artifacts already on disk, and the two account facts that change the design

Found uncommitted in the working tree while writing §13–§22: **`aws/chat-stream-template.yaml`** and
**`docker/chat/Dockerfile.lambda-stream`** (both untracked). They are close to what §16/§20 specify,
and their parameter descriptions carry **two measured account facts that are more decisive than
anything in §13.** Recorded here because they change Decisions 1 and 3, not merely their detail.

### 23.1 **M-5 answered: a public Function URL is blocked account-wide. This is an AWS-side guardrail, not a template defect.**

> **SCOPE CORRECTED BY §24.2:** this finding governs the **anonymous** front door
> (`AuthType: NONE`, `Principal: '*'`) **only**. It does **not** extend to a SigV4-signed request
> from `cloudfront.amazonaws.com`, which is **measured working** (§24.1). Consequently §23.1.2's
> NO-GO risk — the critical path this ADR carried — is **RETIRED**. One open re-test of the
> guardrail's existence is filed in §24.2; it gates nothing.

Measured on account **`429844072978`**, 2026-10-06, per `aws/chat-stream-template.yaml:47-63`:

- A one-resource probe — trivial function, `AuthType: NONE`, resource policy with
  `Principal: '*'` + `Action: lambda:InvokeFunctionUrl` + condition
  `lambda:FunctionUrlAuthType = NONE` (i.e. **hypothesis 1 of §19 excluded**) — returns
  **403 / `x-amzn-ErrorType: AccessDeniedException`**.
- Reproduced in **both `us-east-2` and `us-east-1`**, and under **both** `RESPONSE_STREAM` and
  `BUFFERED` — so it is neither regional nor streaming-specific.
- **The same function with `AuthType: AWS_IAM` and a SigV4-signed request returns 200.** The
  function, the image and the code are fine; only the public front door is refused.
- The account is **not in an AWS Organization** (no SCP/RCP — §19 hypothesis 3's usual mechanism is
  excluded) and CloudTrail holds no public-access-block configuration event.

**Conclusion: §19's hypothesis 3 is correct in substance — an account-level guardrail — while its
proposed mechanism was wrong.** The practical effect is the same and it is binding: **`AuthType:
NONE` is not available, so §15.2's decided shape changes to `AuthType: AWS_IAM`, and the browser
path requires something in front that can sign.** That is CloudFront with **OAC** (§17.1 option 1),
which §19 already named as the escape hatch.

**Three consequences, all now decided:**
1. **§17's distribution moves from "before the prod roll" to "before stage acceptance."** It is no
   longer an optional nicety that buys reversibility; it is the only way a browser can reach the
   host at all. §17.2 updated.
2. **The OAC question of §17.1 becomes the critical path**, not a preference: *does CloudFront OAC
   signing work for `POST` with a request body under `InvokeMode: RESPONSE_STREAM`?* Verify this
   **first**, before any further build — if it does not, there is no browser-reachable Lambda
   streaming path on this account and **this ADR is NO-GO; ECS Express stays.** That single question
   is now the gate the whole migration hangs on, and it is cheaper to answer than anything else here.
3. **The silver lining is real and should be stated:** `AWS_IAM` + OAC is the shape §17.1 preferred
   on security grounds anyway — the Function URL is never publicly invocable, which removes the
   "unthrottled public endpoint" half of M-4's exposure (§4/M-4) without buying anything. The
   guardrail pushed the design where it should have gone.
4. Keep the template's `FunctionUrlAuthType` parameter (`NONE`/`AWS_IAM`) — it is the right shape for
   a fact that may change if the guardrail is lifted. But **`Default: NONE` is now wrong**: the
   default should be the value that deploys and works (`AWS_IAM`), with `NONE` as the opt-in for the
   day the guardrail lifts.

### 23.2 **M-7 (new): reserved concurrency cannot be set on this account — so M-4's enforceable ceiling does not currently exist**

Per `aws/chat-stream-template.yaml:64-86`: the account limit is **`ConcurrentExecutions = 10`** with
**`UnreservedConcurrentExecutions = 10`**, so `PutFunctionConcurrency` rejects **every** reservation
— *"decreases account's UnreservedConcurrentExecution below its minimum value of [10]"* — for 5 and
even for 1. §15.3's `ReservedConcurrentExecutions: 2`/`3` is therefore **not deployable today**.

- **This is not a soft problem, and it is worse than cost.** The account-wide ceiling of 10 is
  **shared with the contact functions** (`aws/template.yaml` ingress/sender/report/admin). A chat
  abuse burst on an endpoint with no throttle can consume all 10 and **starve the contact form** —
  turning a cost risk into a *loss-of-function* risk on an unrelated feature. ECS Express does not
  have this coupling. Record it as the sharpest edge of the migration as currently configured.
- **Prerequisite, and it is free:** raise the **Service Quotas** "Concurrent executions" limit for
  Lambda (default 1000; this account sits at 10, which is the new-account posture). Once it is
  above the minimum-unreserved floor, set `ReservedConcurrentExecutions: 5` — which simultaneously
  caps chat and **protects the contact functions' headroom**. Treat the quota increase as a **gate
  on the prod roll**, not a nicety.
- **Until then:** the only reachable hard controls are (a) the §15.3 alarms, (b) the kill switch
  (reserve **0** — expected to be allowed since it adds nothing to the reserved sum; confirm once,
  §18.E4), and (c) once CloudFront is in front, the **WAF rate-based rule at 300 requests / 5 min /
  IP** — which §15.3 required only for prod and should now be read as **required wherever the
  endpoint is reachable**, because it is the only *rate* ceiling available.
- `Default: 0` in the on-disk template is the honest choice for a stack that must deploy today, and
  the parameter description is correctly explicit about why. Keep both. **But `0` must not be read as
  "bounded"** — §15.3's arithmetic applies to the account's 10, i.e. a worst case near
  **10 × $64.80 ≈ $648/mo** at 1536 MB and 100% duty. That number belongs in the M-4 decision, not
  in a footnote.

### 23.3 Deltas between the on-disk artifacts and §18/§20 — implement these

Everything else in both files matches. These do not:

| # | Artifact | Delta | Required change |
|---|---|---|---|
| 1 | `chat-stream-template.yaml:127` | `Timeout: 60` | **`Timeout: 90`** — §18.D3. 60 cannot hold a 25 s deep probe plus a cold start plus the mint, and that is already a live defect on the HttpApi stack (§22.6). |
| 2 | `chat-stream-template.yaml:131-139` | Env set is missing the parity items | Add **`GEMINI_LIVE_MINT_TIMEOUT_SEC: '15'`** (code default is **50** — §14.4), **`CHAT_ENV`** (read at `alerts.py:99`), **`RESEND_API_KEY`**, **`CHAT_ALERT_EMAIL`**, **`CHAT_ALERT_FROM_EMAIL`**, **`CHAT_ALERT_COOLDOWN_SECONDS`**, **`SMOKE_PROBE_KEY`**, **`CHAT_READY_VERBOSE: '1'`** (stage — §18.C2 depends on it), **`CHAT_VOICE_MODEL`**. §18.G1. Without them the alert path dies silently on the new host and the stage comparison is not like-for-like. |
| 3 | `chat-stream-template.yaml` | No alarms, no SNS topic | Add the **three** alarms of §15.3 (invocations 2,000/5 min; invocations 20,000/1 h; duration-sum 1.8e6 ms/1 h) + an SNS email topic, following the `ChatErrorTopic` + `ChatLambdaErrorsAlarm` pattern at `aws/chat-template.yaml:114-140`. §18.E2. **This is the M-4 gate** — it is the item most likely to be deferred and must not be. |
| 4 | `chat-stream-template.yaml:47-50` | `FunctionUrlAuthType` `Default: NONE` | **`Default: AWS_IAM`** — §23.1.4. The default should be the value that works. |
| 5 | `Dockerfile.lambda-stream:35-40` | No `AWS_LWA_READINESS_CHECK_PATH` | Add **`AWS_LWA_READINESS_CHECK_PATH=/health`**. LWA's default is `/`, and this app has **no `/` route** (`main.py` has only `/health:462`, `/ready:550`) — the default probes a 404. §20.3. |
| 6 | `Dockerfile.lambda-stream:20-23` | Comment repeats the stale **~100 s** figure and attributes it to image weight | **Correct or delete the comment** — §14.2 shows that figure described a LangChain-bearing image this tree can no longer build, and that `Dockerfile.lambda` was never the fat one. Leaving it propagates the exact defect §8 is about, into new code. |
| 7 | `Dockerfile.lambda-stream:29` | `pip install -r requirements-lambda.txt boto3==1.35.86` (inline) rather than a `requirements-lwa.txt` | **Accepted as-is** — it pins the same version with the same explanation and avoids a fourth requirements file. §20.1 is amended: the inline pin is the chosen form, **provided the comment at `:25-28` stays**; it is the only thing standing between this image and the silent-persistence bug. |

Not deltas, and worth naming as correct: both files are **side-by-side by construction** (new stack,
new image, no `chat-template.yaml` / `chat-express-template.yaml` edit, committed meta untouched);
the Function URL carries **no `Cors` block** with the reason recorded at `:156-162` (§15.2); the
execution role is a single-table `PutItem`/`UpdateItem` (§18.G3); and the permission and URL are both
unqualified `$LATEST` with §19's hypothesis-2 noted at `:146-149`.

### 23.4 Process note — these files exist before this ADR decided their contract

They are **untracked**, which is the right state for a spike artifact, and their descriptions are
unusually good: they record measurements inline rather than asserting intent. The sequencing is
nonetheless backwards for a seam this size, and §23.1 is the illustration — the design question
("can the browser reach it at all?") was answered by a parameter description rather than by the
decision record. **Nothing to undo.** The §23.3 deltas are the reconciliation; apply them before the
stage deploy, and commit the files in the same slice that extends `SECURITY_GLOB` (§16) so the
template arrives gated rather than being added to the gate later.

### 23.5 Additional drift, from the artifacts

8. `aws/chat-stream-template.yaml` is untracked and **not yet on `SECURITY_GLOB`** while carrying
   `GeminiApiKey` (NoEcho) and defining the public surface — the hole §16 predicted, now concrete.
   Commit it and the glob widening together.
9. `docker/chat/Dockerfile.lambda-stream:20-23` cites the stale ~100 s cold-start figure (§23.3 #6).
10. The **account Lambda concurrency limit of 10 is shared with the contact stack** (§23.2) and is
    recorded nowhere in `docs/tdd/project-invariants.md`. It is a genuine cross-feature coupling —
    chat abuse can starve the contact form — and it exists **today**, independently of this ADR,
    because `aws/chat-template.yaml` sets no reserved concurrency either. Worth an invariant once the
    quota is raised and reservations are set, and worth a sentence in `docs/architecture.md` now.

---

# THIRD AMENDMENT — 2026-10-06: the gate PASSED, and the cause was a fifth one nobody listed

## 24. The OAC gate result — measured through CloudFront, with an unsigned browser-shaped client

### 24.1 What was measured

Method: an **unsigned** client (no viewer credentials — the browser's position) against the
CloudFront distribution of `aws/chat-stream-cdn-template.yaml`, with a **temporary,
distribution-scoped `lambda:InvokeFunction` grant** added by hand. The grant was **removed
afterwards**, so the design is proven but **not currently wired** — the template fix is dev-ops's,
in flight.

| Probe | Request | Result |
|---|---|---|
| **A** | `POST /api/chat` + `x-amz-content-sha256: sha256(body)` | **200**, `content-type: text/event-stream; charset=utf-8`; `ms_to_headers` **2 423**, `ms_to_first_byte` **14 034**; token events at 14 034, 14 148, 14 186, 14 402, 14 449, 14 540, 14 649, 14 719, 14 846, 14 989, 15 060 … — **one `token` event per socket read** |
| **B** | same, body hash replaced by `UNSIGNED-PAYLOAD` | **403 `InvalidSignatureException`** |
| **C/D/E** | `GET /health` | **200** through the default behavior |

**Derived from those numbers, and the derivations are the finding:**

- **Headers preceded the first body byte by 11 611 ms** (14 034 − 2 423). A proxy that buffered
  the body could not have emitted response headers 11.6 s before it.
- **Inter-token deltas: 114, 38, 216, 47, 91, 109, 70, 127, 143, 71 ms** — i.e. **38–216 ms**,
  each arriving in its own read. ("40–200 ms" is a fair summary; the recorded extremes are 38
  and 216.)
- **M-6's buffering clause: PASS.** CloudFront does not buffer the event stream. This is not a
  marginal number that a re-run could reverse.
- **M-6's parity clause — `+150 ms` of direct and the same chunk count — is NOT measured.** There
  was no interleaved direct baseline in this run. It merges into **B1**, which is blocked (§24.5).
  §23.1.1 said M-6 was no longer separable from M-1; that remains true, and the inseparable half
  is the part still owed.
- **§18.A1: PASS, over public HTTPS** — `text/event-stream`, ≥ 11 strictly-increasing `token`
  events, last−first spread ≥ 1 026 ms against a ≥ 200 ms floor. This is the first acceptance item
  §18 can count (§13.1's SDK numbers explicitly do not count).
- **§18.B4 is still owed.** The timeline is truncated (`…`), so the HTTPS chunk count was never
  put beside the SDK's 42. One line of the harness closes it; record the integer.
- **The 14 s TTFT is model latency, not transport, and must not be read as an M-1 number.** M-1 is
  a *relative* threshold by construction (§4), and this run is exactly why: an absolute TTFT on
  this prompt tells you about Gemini, not about the host. It makes B1's **interleaved** A/B
  unwaivable rather than optional.

### 24.2 §23.1's guardrail does NOT extend to signed service principals. The NO-GO is retired.

**Said unambiguously, because this ADR has carried it as the critical path for two amendments:**

§23.1.2 made one question the gate the whole migration hung on — *does CloudFront OAC signing work
for `POST` with a request body under `InvokeMode: RESPONSE_STREAM`?* — and said that if the answer
were no, **this ADR was NO-GO and ECS Express stayed.** The answer is **yes**: 200, with an
unbuffered `text/event-stream` body, to an unsigned client (§24.1).

Therefore:

1. **The account guardrail measured in §23.1 governs the ANONYMOUS front door only** —
   `AuthType: NONE` with `Principal: '*'`. It does **not** apply to a SigV4-signed request from
   the service principal `cloudfront.amazonaws.com`. §23.1's own second data point already said
   as much (`AWS_IAM` + a signed request → 200); what is new is that the *browser* path, through
   CloudFront, is also unaffected.
2. **§23.1.2's NO-GO risk is retired.** No item remaining in this ADR can make the Lambda host
   unreachable from a browser on this account. The critical path is now a short list of ordinary
   measurements (§24.5), not an existential question.
3. **§23.1.3's "silver lining" stands and is now the shipped shape**, not an aspiration: the
   Function URL is never publicly invocable, which removes the "unthrottled public endpoint" half
   of M-4's exposure for free.

**One open scope question, filed and deliberately NOT gating** (the architect's own addition):
§23.1's anonymous probe granted only `lambda:InvokeFunctionUrl` — **the same omission that caused
the CloudFront 403** (§24.3). So there is now a competing explanation for the anonymous 403 too,
and one read-only probe settles it: `AuthType: NONE` with **both** grants present. It is cheap, it
is on nobody's critical path (the design no longer wants `NONE`), and it changes no decision — but
**this ADR must not carry "`AuthType: NONE` is blocked account-wide" as a settled fact until that
probe is run.** If it returns 200, §23.1's conclusion was the fifth cause wearing a guardrail's
clothes, and the lesson of §24.3 applies to it twice.

### 24.3 The cause — a documented prerequisite, omitted. The four-cause list was not exhaustive.

AWS's page **"Restrict access to an AWS Lambda function URL origin"** requires **two** grants for
OAC: **`lambda:InvokeFunctionUrl`** *and* **`lambda:InvokeFunction`**, both with
`Principal: cloudfront.amazonaws.com` and `--source-arn` the distribution.
`aws/chat-stream-cdn-template.yaml` granted **only the first**. That is the whole of it.

- **§19's ranked list of four was exhaustive-looking and wrong, and §23.1 inherited the error.**
  Worse than an omission: §19's hypothesis 1 posed the two actions as **alternatives** —
  "`lambda:InvokeFunctionUrl`, *not* `lambda:InvokeFunction`" — when the documented requirement
  for this integration shape is a **conjunction**. Probe 1 of §23.1 then eliminated hypothesis 1
  **empirically** and correctly, which *hardened* the frame: a list of mutually exclusive
  candidates cannot contain "both", so no amount of further probing inside that list could reach
  the cause. A documented-prerequisite omission was never a candidate.
- **The lesson, stated so it transfers: read the service's own required-policy example before
  theorising about a denial.** A 403 from an AWS front door is an authorization *fact*, and the
  documentation for the exact integration shape states the required policy verbatim. The architect
  made the same error from the other end — the frame offered was "signing or buffering", and it was
  **neither**. Hypothesis ranking is a poor substitute for the vendor's worked example; here it
  cost this ADR its critical path for a full amendment cycle, and it produced a published NO-GO
  risk that never existed.
- **An asymmetry in the fix, worth recording because it is a security consequence, not a detail:**
  Lambda's `AddPermission` **rejects `FunctionUrlAuthType` for `lambda:InvokeFunction`** (it is
  accepted only for `lambda:InvokeFunctionUrl`), so the second statement carries **no auth-type
  condition**. It is therefore strictly broader than the first, and **`AWS:SourceArn` is its
  entire access control** — without it, principal `cloudfront.amazonaws.com` means *any*
  CloudFront distribution in *any* AWS account, the textbook confused deputy. Consequences:
  the two grants must live and die in the **same stack as the distribution** (they do), the
  `SourceArn` is not hygiene but the fence, and this statement must never be hand-added outside
  that stack — which is also the sharpest argument for §24.8's governance item.

### 24.4 Cost, corrected to September actuals

Verified from Cost Explorer. **September: ELB $16.20 + VPC $14.41 + ECS $8.89 = $39.50 of a
$46.51 total bill — 85%.** Amplify and WAF are now **$0**.

**§1's table is superseded** (`~$29` ALB + `~$18` Fargate ≈ `~$47`): it derived from a July memory.
The ALB half was close — $16.20 + $14.41 = **$30.61** vs `~$29`. The Fargate half was **2× too
high**, and the reason matters more than the arithmetic:

- **Only one task is running.** `gvp-chat-express-stage` sits at **`desiredCount: 0`** and returns
  **503**. One 256 CPU / 512 MiB task in `us-east-2` is
  `0.25 × $0.04048 + 0.5 × $0.004445 = $0.01234/h ≈ $9.01/mo` — the $8.89 actual, to within a
  partial month. Derived from the published price, not from a per-resource itemisation.
- The **$14.41 VPC line is consistent with four charged public IPv4 addresses**
  (`4 × 730 h × $0.005 = $14.60`): the ALB's three plus the one running task's ENI. Also derived —
  treat it as the working explanation, not a measurement.
- **The correction that survives from the earlier draft:** the ALB releases only after the **last**
  Express service across **both** environments is gone (§7.6), so **partial deletion saves $0 of
  the ALB**. Unchanged and still the sharpest fact in the cost case.

**Two consequences, both sharper than the correction itself:**

1. **The cheap half of the saving has already been taken, and it saved nothing.** Stage's Fargate
   is already $0 — and the ALB is **still billing $30.61/mo** with stage at `desiredCount: 0`.
   That is **M6 / ADR-0019's economics measured rather than predicted**: scaling an Express service
   to zero does **not** release the ECS-managed ALB, because the ALB belongs to the Express gateway
   (the service resource), not to the task. §10 argued this from the template; stage has now run
   the experiment by accident. Whatever remains of the $39.50 therefore hinges on deleting **prod**
   Express — the host serving users — which is an all-or-nothing decision, not a staged one.
2. **§15.3's arithmetic gets stronger, not weaker.** One pinned Lambda execution at 1536 MB and
   100% duty is $64.80/mo — now **1.6× the entire ECS bill it would replace** (was 1.4× against the
   stale $47). The claim "reserved concurrency is the cost ceiling" remains false; and against the
   account's limit of 10, the unbounded worst case is still ≈ **10 × $64.80 ≈ $648/mo** (§23.2).
   M-4's "< $2 expected" gate and E5's from-data computation stand, measured against **$39.50**.

### 24.5 Acceptance — what now has real numbers, and what remains

**§18.F0 is CLOSED.** M-5 is resolved (§23.1, and see §24.2's scope note), the signed-path 403 is
resolved (§24.3), and the endpoint has answered real browser-shaped HTTPS requests. §18 is now a
list of ordinary work.

| §18 item | Status |
|---|---|
| **F0** precondition | **CLOSED** — §24.2, §24.3 |
| **A1** SSE over public HTTPS, not coalesced | **PASS** — §24.1 |
| **A5** `x-amz-content-sha256` (**new**, §24.6) | **PASS for curl / OWED for the browser** — `js/chat.js` does not send it |
| **A2** token-by-token in a real browser, no FE change | **OWED, and now gated on A5** — the FE change is real (§24.6) |
| **A3 · A4** | owed |
| **B1** interleaved A/B vs stage Express | **BLOCKED TWICE** — stage Express at `desiredCount: 0` (see below) **and** the samples are contaminated by a chat-layer defect (§24.10). The only remaining measurement that can falsify the swap on latency |
| **B2** cold over HTTPS, ≥5 samples | owed (§13.2's 1 542 ms predicts a pass, but it was an SDK number) |
| **B3** post-deploy warm-up | owed — needs §20.5 in the deploy script |
| **B4** HTTPS chunk count vs 42 | owed — §24.1 |
| **C1–C4** persistence + admin | owed |
| **D1** mint ≥10/10 | owed |
| **D2** **human voice pass** | **OWED and unsubstitutable** — the last item that can falsify §4/M-3's premise; no probe replaces a human hearing audio |
| **D3 · D4** timeouts + deep probe | owed; D3 is also §23.3 delta 1 — the template still says `Timeout: 60` (`aws/chat-stream-template.yaml:127`) |
| **E1** reserved concurrency | **BLOCKED by M-7** (§23.2) — the **Lambda concurrency quota increase is a gate on the prod roll** |
| **E2 · E3 · E4 · E5** alarms, budgets, kill switch, cost | owed; §23.3 delta 3 (no alarms, no SNS topic) is unapplied, and this is still the set most likely to be quietly deferred |
| **F1 · F2** premise re-check | re-check at roll time |
| **G1–G4** env parity | owed — §23.3 delta 2 unapplied |
| **new** | the §24.7 / invariant 18 pin must exist before the prod roll |

**B1's blocker, recorded as a blocker on the comparison and not on the ADR:**
`gvp-chat-express-stage` is at **`desiredCount: 0` and returns 503**, so there is **no stage
Express baseline to interleave against**. Three options, and this is the **owner's call**:

- **(a) Scale stage Express to 1 for the duration of the A/B**, take the measurement, scale back.
  Cost: well under $1/day (≈$9/mo Fargate prorated, plus ~$3.65/mo of task IPv4).
- **(b) Run B1 against prod Express** and accept §14.1's mixed-variable defect, recorded on the
  number itself as a known weakness.
- **(c) Waive B1.**

**Recommendation: (a).** §24.1 shows TTFT on this workload is model-dominated, so the only
informative form of M-1 is relative and interleaved; (b) reintroduces exactly the confound §14.1
corrected in place; and (c) would leave the migration's latency claim resting on §13.1's SDK
numbers, which §13.1 itself disqualifies. A sub-$1 measurement against a $39.50/mo decision is not
a close call. **If the owner chooses (c), that waiver belongs in this ADR as a decision, not as a
gap** — a superseding note saying the latency claim is unmeasured on the browser path.

**The honest short list of what is left:** **B1** (blocked on stage Express at zero), **D2** (the
human voice pass), **E1/M-7** (the Lambda concurrency quota), plus the mechanical §23.3 deltas and
the §18 items above. **None of them is a NO-GO risk of the §23.1.2 kind.**

### 24.6 `x-amz-content-sha256` is a documented requirement — and the first real frontend change this migration needs

**Promoted from a note to a hard requirement, in §7's blast radius (as §7.7) and §18's acceptance
list (as A5).**

The AWS documentation states it verbatim: for `PUT`/`POST` through CloudFront OAC to a Lambda
function URL the client must compute the **SHA-256 of the request body** and send it in
**`x-amz-content-sha256`**, because **"Lambda doesn't support unsigned payloads."** It is a
documented prerequisite, **not an empirical quirk of this account** — and §24.1 probe B measured
the consequence: `UNSIGNED-PAYLOAD` → **403 `InvalidSignatureException`**.

**This narrows a claim this ADR has repeated twice.** §13.1 and §21 say "the application needed no
code change." That is true of the **server** and **false of the browser**: with CloudFront + OAC in
front, the browser must hash every chat body before sending it. Any future citation of "no code
change" must carry that qualifier (filed as §24.9 item 13).

What it means concretely, so the loop designs it rather than discovers it:

- `js/chat.js:1147-1163` (`postChatOnce`) serializes the body **inline** inside the `fetch`
  options. The hash must be over the **exact bytes sent**, so the body must be serialized **once**
  into a string, hashed with `crypto.subtle.digest('SHA-256', …)`, and **that same string** passed
  as `body` — hashing an object and re-serializing inside `fetch` is a silent 403.
- `crypto.subtle` requires a **secure context**. Fine on HTTPS (chat already needs it for voice),
  but it means the `localhost`-over-http fallback of `js/site-config.js:9-11` cannot talk to a
  distribution. Local development keeps talking to a local app or the raw origin.
- **Scope:** every `POST` routed to the OAC origin. Today that is `/api/chat`. It also covers
  **`POST /api/live/session`** *if* the default behavior ever targets the Function URL origin —
  which is exactly what happens in the template's "gate mode" (`DefaultOriginDomainName` empty,
  `aws/chat-stream-cdn-template.yaml:17-24`). Decide the default origin before shipping the FE
  change, or the FE must hash both routes.
- **CORS needs no change — verified.** `docker/chat/app/main.py:436-443` sets
  `allow_headers=['*']`, so the non-safelisted `x-amz-content-sha256` is already permitted on the
  preflight that `Content-Type: application/json` already forces. §15.2's "one owner for CORS, and
  it stays the app" holds unchanged, and §18.A4's single-`Access-Control-Allow-Origin` assertion is
  unaffected.

**New acceptance item A5:** `POST /api/chat` through the distribution **with** a correct
`x-amz-content-sha256` returns 200 `text/event-stream` (measured, §24.1 A) and **without** it
returns 403 `InvalidSignatureException` (measured, §24.1 B). A5 is satisfied for curl. **A2 is
where it must be satisfied for the browser**, and A2 is now gated on the `js/chat.js` change —
whose failing test is "the chat POST carries a correct `x-amz-content-sha256` for its exact body".

### 24.7 The new invariant — #18, and how it should be pinned

Written into `docs/tdd/project-invariants.md` as **invariant 18**: *the streaming chat route is
reachable by exactly one spelling, and every spelling the frontend can emit lands on a streaming
behavior; a silent fall-through to a buffered origin is a regression, not a variant.*

**The hole, precisely.** The **exact** pattern `/api/chat`
(`aws/chat-stream-cdn-template.yaml:106`) is **right and must stay exact** — `/api/chat*` would
also swallow `/api/chat/smoke` and `/api/chat/host-status`, which are request/response routes that
belong on the buffered origin. `POST /api/chat/` simply does not match it, and falls through the
**default** behavior. dev-ops is adding a second exact behavior for the trailing slash.

**What the fall-through actually does — worse than "loses streaming"** (derived from config and
code, not measured; one `curl -i -X POST <dist>/api/chat/` and a glance at `Location` confirms it):
the default origin's `/{proxy+}` ANY route (`aws/chat-template.yaml:104-109`) reaches FastAPI,
whose `redirect_slashes` answers **307** with an **absolute** `Location` built from the `Host`
header — and under `AllViewerExceptHostHeader` that Host is the **origin's**, so the browser is
redirected to the raw `*.execute-api.*.amazonaws.com` host. `fetch` follows a 307 with method and
body intact. So the browser ends up **off the distribution entirely**, on a host named in **no
`<meta>` tag** (invariant 2), buffered by API Gateway, inside its 29–30 s integration timeout
(§15.1, §22.6) — and the response is still **200**, still `text/event-stream`, still the correct
text, delivered all at once. `readSseChat` parses it happily. **Nothing anywhere reports an error.**

**A second cache behavior is necessary but NOT sufficient — and this is the strongest argument for
pin 1 below.** Found by dev-ops (tic 1249) while implementing it: route `/api/chat/` to a second
exact behavior on the **streaming** origin and `redirect_slashes` still fires, now answering 307
with an absolute `Location` naming the **private Function URL host** (`AuthType: AWS_IAM`) — and
**the browser cannot sign**, so the unsigned follow gets **403**. The trailing slash therefore has
**two** failure modes depending on which origin it lands on: **silently buffered 200** (default /
API Gateway origin) or **403 dead end** (Function URL origin). **The general rule, which outlives
this spelling: under OAC the origin must never emit an absolute self-referential redirect**, because
`AllViewerExceptHostHeader` makes the `Host` the *origin's* name — so every `30x` the app builds
from it points at a host no browser can reach. Three places to fix it, and they are not
equivalent: normalise the URI at the **edge** (viewer-request rewrite — dev-ops, in flight), never
**emit** the spelling (pin 1 — removes both failure modes at the source), or stop the app
redirecting at all (`FastAPI(redirect_slashes=False)`, which converts the silent class into a loud
404 across every route — the loop's call, and the trade must be stated).

**One correction to the premise as handed over.** "Every spelling the frontend can emit" implies the
frontend can emit the trailing slash. **At this commit it cannot.** `js/site-config.js:9` strips
trailing slashes from the meta content (`raw.replace(/\/+$/, '')`), `js/chat.js:338` uses the result
verbatim, and `js/chat-live.js:247` / `js/admin.js:26` re-strip before deriving their own paths. The
hole is real at the CDN layer and reachable from curl, from docs, from scripts and from the next
edit that joins a base to a path — but **the shipped frontend is already a one-spelling emitter,
incidentally rather than by contract.** That is the single most useful fact for choosing the pin.
The practically reachable spelling set is **`/api/chat`** and **`/api/chat/`** (query strings do not
participate in path matching; `//api/chat`, case variants and percent-encoded forms are not
emitted by anything in `js/`).

**How it should be pinned — all three have a role, and the order is a preference, not a menu:**

1. **The frontend guarantee, pinned by a node:test characterization — PREFERRED, and the one to
   insist on.** Assert that the shipped frontend can only ever emit `<base>/api/chat`:
   `resolveApiUrl` strips trailing slashes (feed it `…/api/chat/`, `…/api/chat///`), the POST
   endpoint is the unmodified `chatApiUrl`, and no module concatenates a `/` onto it.
   **Why first:** it pins the side that actually changes — the CDN template is 151 lines edited
   rarely and (once §24.8 lands) under review, while `js/`, `js/site-config.js` and the committed
   meta are edited every week; it runs **offline, in CI, on every commit**, with no AWS
   credentials, in the same shape as the two tests that already guard this seam
   (`test/frontend-api-config.test.mjs`, `test/frontend-api-url-env-guard.test.mjs`); and it costs
   one test, because the property is **already true** — the test converts an accident into a
   contract. It also makes the seam *statable* in one line — "the frontend emits exactly
   `<base>/api/chat`" — which is what lets the CDN side be built and reviewed independently.
2. **A template assertion — second, and cheap.** Parse `aws/chat-stream-cdn-template.yaml`; assert
   the streaming behaviors cover exactly the reachable set, that each targets the streaming origin,
   and that each carries CachingDisabled + AllViewerExceptHostHeader + `Compress: false`.
   **Why not first:** on its own it pins a *list*, and a list drifts from its emitter — it cannot
   know "every spelling the frontend can emit" without importing the frontend's knowledge, which is
   precisely the coupling pin 1 removes. Paired with pin 1 the list becomes checkable, and it
   catches the one failure pin 1 cannot: **the right pattern pointed at the wrong origin, or with a
   policy that buffers.** It is a new test shape for this repo (there is no template-assertion test
   in `test/` today), which is the only reason it ranks second.
3. **A journey — a release gate, not a suite pin.** For one real streaming POST through the
   distribution, assert **`x-cf-behavior: apichat-exact`**, `content-type: text/event-stream`, and
   ≥ 2 body reads ≥ 40 ms apart (§24.1 measured 38–216 ms, so the margin is wide).
   **Why not the pin:** it needs a deployed distribution, credentials and a live model call; it is
   flaky by construction and on a personal portfolio it gets run by hand or not at all. **Why it
   must exist anyway:** it is the only check that catches the actual user-visible symptom — a
   correct-looking configuration that still buffers — i.e. the only one that would have caught this
   class end-to-end. It belongs in §18's acceptance list and the admin smoke.
   **And it is nearly free, because the template already stamps the answer:**
   `aws/chat-stream-cdn-template.yaml:50-70,116,126` sets `x-cf-behavior: apichat-exact` / `default`
   per behavior, so "which behavior matched" is **client-visible without timing anything**. That
   header is the best thing in that template; keep it, and make asserting it part of every
   streaming check.

### 24.8 Governance — unresolved, and the owner's

**Three** chat templates now sit outside `SECURITY_GLOB` (`.claude/tdd.config:63`, which matches
only `(^|/)aws/(template|chat-template)\.yaml`):

- `aws/chat-stream-template.yaml` — `GeminiApiKey` (NoEcho); defines the function and its URL.
- `aws/chat-stream-cdn-template.yaml` — **new with the gate**; defines the **public front door**
  and **both invoke grants**, one of which (§24.3) carries no auth-type condition and is fenced
  only by `AWS:SourceArn`. This is the most review-worthy file of the three and the newest.
- `aws/chat-express-template.yaml` — the pre-existing hole, with **three** NoEcho secrets (§22.1).

§16's proposed widening to **`(^|/)aws/[^/]*template\.yaml`** covers all three and can only ever
add gating. **It remains the owner's decision; the architect has not edited `.claude/tdd.config`
and will not.** Filed, not fixed. What the gap means concretely today: the statement that makes the
chat function invocable has a wildcard-shaped principal and a single ARN condition standing between
it and any CloudFront distribution in any AWS account — exactly the edit a sensitive-surface gate
exists to force a human to look at.

### 24.9 Additional drift, for the loop (continues §22 / §23.5 at 11)

11. **`js/chat.js` sends no `x-amz-content-sha256`** (`:1147-1163`), so the browser cannot reach
    the distribution at all (§24.6). **Blocks §18.A2** and is the highest-value item on this list.
    Note the design constraint: serialize the body once, hash that string, send that string.
12. **`aws/chat-stream-template.yaml` still carries all four §23.3 deltas** — verified unapplied at
    this commit: `Timeout: 60` (`:127`), the env-parity set (§18.G1), no alarms / no SNS topic, and
    `FunctionUrlAuthType` `Default: NONE` (`:49`). Delta 4 is now doubly wrong: `AWS_IAM` is not
    merely the value that deploys, it is the value the **measured, working** design uses.
13. **"The application needed no code change" is narrower than it reads** (§13.1, §21): true of the
    server, false of the browser (§24.6). Correct it wherever it is cited.
14. **ADR-0007's `~100 s cold start` is still uncorrected** (§22.2). Unchanged and still the
    highest-value documentation fix in this ADR's whole list.
15. **`gvp-chat-express-stage` at `desiredCount: 0` returning 503 is documented nowhere** — not in
    `docs/architecture.md`, not in the deploy script's output, not in §8's table. Anyone following
    §14.1's instruction to baseline against the stage host meets a 503 with no way to know it is
    intentional. Worth one line in `docs/architecture.md`. **And it is evidence, not just drift:**
    scaling an Express service to zero does **not** release the ECS-managed ALB (§24.4), which is
    M6 / ADR-0019's central economic assumption, now measured.

### 24.10 The M-1 samples are contaminated by a chat-layer defect — re-measure, do not reuse

Found while this amendment was being written, and it is a **second, independent blocker on
§18.B1**: `is_upstream_rate_limit` (`docker/chat/app/upstream_errors.py:94-98`) is true for **429
only**, so `gemini_routing.py:303-304` / `:385-391` **re-raise a Gemini `503 UNAVAILABLE` instead
of falling back** to the healthy `gemma-4-26b-a4b-it`. Observed at **roughly 1 request in 3**
across two independent measurement sessions, on the ECS host serving prod.

**Consequence for this ADR:** every latency sample taken before the fix mixes host behaviour with
a self-inflicted ~30% error rate, and the failed turns are precisely the ones that return
**fastest** — so a TTFT median is biased **downwards** and the distribution is bimodal, not merely
noisy. **All A/B numbers taken before the fix are contaminated and must be RE-MEASURED, not
reused.** This applies to any Express-vs-stream comparison on either side.

The fix is decided in **ADR-0023** (retryable upstream set; a 503 reaches the fallback and does
**not** demote the primary) and amends invariant #9. It is the cheaper of B1's two blockers and
should land first — scaling stage Express up to take a contaminated measurement would waste both.
