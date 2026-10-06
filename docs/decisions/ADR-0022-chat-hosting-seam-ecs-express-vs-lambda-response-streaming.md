# ADR-0022 — The chat hosting seam: is ECS Express load-bearing, or can SSE run on Lambda response streaming?

- **Status:** **OPEN — spike.** This ADR records the question, the verified evidence, and the
  decision criteria. **It does not decide.** No resource may be deleted on the strength of this
  document; §6 lists the measurements that settle it and §9 the drift it found.
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
- **Baseline:** the same measurement against the current Express host
  (`https://gv-0277d83a39d54698a254a52e95dcd476.ecs.us-east-2.on.aws/api/chat`).
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
- **Why it is in doubt:** this is a **container-image** Lambda, and the image is not lean.
  `docker/chat/Dockerfile:11` installs **`requirements-dev.txt` as well as** `requirements.txt`,
  and lines 17-18 copy `pytest.ini` and the whole `tests/` tree into the runtime image. ADR-0007
  §Context already records a **~100 s cold start** for the LangChain-bearing app, and ADR-0007
  **Phase 2 (drop LangChain + retriever) is DEFERRED** — so the heavy import graph that caused it
  is still present. A cold start of that order is disqualifying for a visitor-facing chat.
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

## 5. Decision (not yet taken)

**Deferred pending M-1 through M-4.** The honest current state:

- The **capability** premise of ADR-0002 is half-dead: voice no longer needs the container, and
  that is settled by code, not opinion.
- The **SSE** premise is untested on LWA in this repo. It is plausible on the published behaviour
  of Function URL response streaming, but plausible is not measured, and the specific risk here
  is not the transport — it is the **cold start of a fat container image whose LangChain
  dependency ADR-0007 Phase 2 deferred**.
- Therefore: **ECS Express stays until M-1, M-2 and M-3 pass and M-4 has an enforced ceiling.**

---

## 6. Open measurements — the gating list

| # | Measurement | Threshold | Status |
|---|-------------|-----------|--------|
| M-1 | SSE TTFT through LWA streaming vs ECS; chunk count > 1 | ≤ ECS median + 150 ms; p95 ≤ +400 ms; incremental or fail | **OPEN** |
| M-2 | Cold-start TTFT, container-image Lambda, ≥15 min idle | ≤ 3 s median / 5 s worst (5–10 s conditional) | **OPEN** |
| M-3 | Browser-direct voice against a Lambda-hosted mint | ≥ 9/10 `setupComplete`, no host-attributable 1011 | **OPEN** |
| M-4 | Monthly cost + enforced worst-case ceiling | < $10 expected **and** reserved concurrency + billing alarm | **OPEN** |

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
   `tests/` into the runtime image. Image weight is a direct input to **M-2**; worth fixing
   regardless of the hosting outcome.

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

### Recommended order (nothing destructive)
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
