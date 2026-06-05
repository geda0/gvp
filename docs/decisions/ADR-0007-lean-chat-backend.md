# ADR-0007 — Lean chat backend: browser-direct voice, direct Gemini calls, App Runner

- **Status:** Proposed (migration plan; no code yet)
- **Date:** 2026-06-04
- **Supersedes / amends:** ADR-0002 (split chat hosting: SSE-Lambda + WS-ECS). With
  browser-direct voice there is no server WebSocket to host, so the split collapses to one
  small stateless service.
- **Keeps:** ADR-0003 (voice timbre lock — preserved; see "Voice timbre" below), ADR-0001
  (no hardcoded cross-origin host — the new backend URL still comes from a `<meta>` tag).

## Context

A senior review of the chat (voice/text) found the *behaviour* (grounded, multi-turn,
streaming, voice) is right, but the *implementation* is heavier than the job needs:

1. **Server-side voice WebSocket relay** (`/api/live/relay/{id}` proxies browser ↔ Google
   Live) — this is the load-bearing reason the backend must be a long-running container
   (ECS Fargate + ALB).
2. **LangChain + a custom `GeminiRoutingChain`** for what is one model call — ~100 s cold
   start (gvp's own `tdd.config` note) and the home of two real bugs (sticky day-long
   fallback, shared primary+fallback timeout budget).
3. **A RAG retrieval system** (synonyms, tag matching, roster index, truncation) over a
   **~14 KB** corpus that fits whole in the prompt on a 1M-token model.
4. **ECS+ALB SAM stack** (`chat-ecs-template.yaml`: VPC, subnets, SGs, target groups,
   listeners, cert) where the job is "run one container and give me an HTTPS URL."

Backend today: **~3,210 Python LOC** + `langchain*` ×4, `langchain-google-genai`,
`langchain-openai`, `rank-bm25`, `websockets`, `mangum`, …

### The precedent: `geda0/Based` already did this migration

Based is a sibling repo (TS) with the same Gemini text + Gemini Live voice needs. Its history:
- `78b1d9f feat(lv1): live-voice host — Gemini Live streamed audio over a backend WSS relay`
  (it started where gvp is now), then
- **`9b07c38 refactor(lv1): browser-direct voice transport — retire relay + ECS`.**

That refactor (documented in Based `docs/decisions/0007-live-voice-seam.md`) did exactly
what we are proposing, with measured results:
- The browser opens **Google's Live WSS directly** with a short-lived **ephemeral token**;
  the long-lived `GEMINI_API_KEY` stays server-side (`process.env` only).
- **Deleted** `live-relay.ts` / `live-relay.routes.ts` / `live-relay.test.ts`; dropped the
  `@fastify/websocket` / `ws` deps — the mint is plain HTTP.
- Backend kept only `POST /live/session`; **"ECS Express Mode CANCELLED — saves ~$25–30/mo."**
- Text path = a **~30-line direct `fetch`** to `…:generateContent` (no LangChain).
- Backend runs on **AWS App Runner** (image + port → HTTPS; key from SSM); frontend on
  S3+CloudFront. No ALB/VPC/SG.

Browser-direct transport (Based `frontend/src/lib/live-relay-client.ts`): `POST /live/session`
→ `{token, model, expiresAt, setup}` → open
`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=<token>`
and bridge events; send `setup` then `clientContent` on open.

## Decision

Migrate gvp's chat to the lean shape, **incrementally and reversibly**, keeping the current
ECS stack serving until each slimmer piece is verified on staging:

- **Voice:** mint a Gemini **ephemeral token** server-side; the browser connects **directly**
  to Gemini Live. **Retire the WS relay.**
- **Text:** call Gemini directly (`google-genai` / `httpx` streaming); **drop LangChain**.
  Keep primary→fallback as a small `try/except` (optional).
- **Grounding:** put the **whole knowledge pack in the system prompt**; **drop the retriever**
  (extract_tags/synonyms/_is_relevant/roster index/truncation). Simpler *and* more accurate.
- **Hosting:** move the now-stateless service from **ECS+ALB → App Runner** (Based's choice;
  one service, SSE works, secret from SSM). Lambda is a viable alt (see Alternatives).
- **Keep:** transcript persistence + admin telemetry as a plain DynamoDB write; the contact
  pipeline (unrelated); the voice timbre lock.

## Migration plan (phased; each phase ships + verifies on staging independently)

### Phase 0 — Guardrails (no behaviour change)
- Confirm the staging chat (`chat-api-stage`, now auto-deployed via the CI wiring) is the test
  bed. Pin current observable contracts with characterization tests where thin (chat 90 today).
- **Do NOT** spend effort on the deferred "runtime internals" batch (stream `aclose()`, relay
  idle/queue caps, fallback-timeout split): that code is in the relay / LangChain-streaming
  path this migration **deletes**. Fixing it is polishing machinery we remove.

### Phase 1 — Browser-direct voice (retire the relay) — *highest leverage*
- **Backend:** change `POST /api/live/session` to mint a Gemini ephemeral token via
  `google-genai` `client.authTokens.create({uses:1, expireTime≈10m, newSessionExpireTime≈3m})`
  (gvp already ships `google-genai==2.2.0`). Return `{token, model, expiresAt, setup}` where
  `setup` is built **server-side** (carries the voice config → preserves ADR-0003 timbre lock).
  **Delete** the relay bits of `live_gemini.py` + `live_relay.py` + the `/api/live/relay/{id}`
  route + the bridge map; drop the `websockets` dep.
- **Frontend (`js/chat-live.js`):** open Google's Live WSS directly with the ephemeral token
  (mirror Based's `live-relay-client.ts`); send `setup`→`clientContent` on open. Replace the
  relay/bridge `websocketUrl` path (it currently reads `websocketUrl` from the session body)
  with the direct WSS URL + `access_token`.
- **Verify (staging):** voice connects browser-direct; only the single-use ~3-min token
  transits; timbre still Charon; failure stays silent. The backend now holds **no WS**.

### Phase 2 — Slim the text reply path (drop LangChain + retriever)
- Replace `GeminiRoutingChain`/LangChain with a direct `google-genai` (or `httpx`) call;
  stream via `generateContentStream`. Keep fallback as a ~15-line `try/except` on first-chunk
  429 (optional — or drop it; one model is fine for a portfolio bot).
- Replace retrieval with a **whole-corpus system prompt**: serialize the full pack once and put
  it in the system message every turn. Delete `extract_tags`, `SYNONYMS`, `_is_relevant`, the
  roster index, and the truncation dance. (Removes the named-entity/enumeration failure modes
  entirely — the model sees everything.)
- Keep `_persist_text_turn` as a thin DynamoDB `put` (ok/error/timeout + latency/flags).
- Drop deps: `langchain*`, `langchain-google-genai`, `langchain-openai`, `rank-bm25`,
  `mangum` (if not Lambda). Cold start drops from ~100 s to ~instant.
- **Verify (staging):** same/better answers; cold first request is fast; transcripts still land.

### Phase 3 — Re-home: ECS+ALB → App Runner
- The service is now stateless HTTP: `/api/chat` (SSE) + `/api/live/session` (mint) +
  `/health` + the admin endpoints. Author an App Runner SAM/CFN stack (mirror Based
  `infra/staging.yaml`): ECR image + port + SSM secret + `/health` check. **Delete**
  `chat-ecs-template.yaml` (ALB/VPC/SG/target groups) after cutover.
- Retarget the chat CI (the `deploy-staging.yml` chat path we just wired) from the ECS SAM
  stack to the App Runner stack; tighten the IAM grant from ECS/ELB/EC2-SG to App Runner.
- **Verify (staging):** `chat-api-stage` served by App Runner; SSE streams; cost drops
  (~$16–25/mo ALB gone). Then repeat for prod.

### Phase 4 — Cutover + decommission
- Per-env chat `<meta>` URL points at the App Runner service (uses the cross-env URL guard we
  built so staging/prod don't cross).
- Decommission `gvp-chat-ecs-{stage,prod}` stacks + the now-unused relay image path. Update
  ADR-0002 (superseded), ADR-0003 (timbre now in the server-built `setup`), and
  `docs/architecture.md`.

## Voice timbre (ADR-0003) under browser-direct
The timbre lock stays server-controlled: the `setup` frame (with the prebuilt `Charon` voice
+ cadence) is built **server-side** in the mint endpoint and returned in the session response;
the browser only forwards it on `open`. The browser cannot pick the voice — the server does.

## Alternatives considered (hosting)
- **App Runner (recommended):** one container, native HTTPS, SSE works, warm instances, no
  ALB/VPC. Matches Based. Simplest ops.
- **Lambda (function URL + response streaming) + a tiny mint Lambda:** scale-to-zero
  (cheapest); viable now that LangChain's cold start is gone. More moving parts for SSE; keep
  as the option if cost-to-zero matters more than simplicity.
- **Keep ECS, just delete the relay:** removes the bug surface but still pays for ALB/VPC and
  the heavy SAM stack. Half-measure; not recommended.

## Consequences
- **Removed:** WS relay + bridge; LangChain/routing-chain; RAG retriever; ECS+ALB stack; the
  ~100 s cold start; ~half the Python deps; and the entire "deferred runtime internals" bug
  list (it lived in deleted code).
- **Kept:** grounded + multi-turn + streaming text; voice (now browser-direct); timbre lock;
  transcripts/admin (as a plain write); contact pipeline.
- **Net:** roughly the current capability at a fraction of the LOC, deps, infra, cost, and
  cold-start — and fewer places to break.

### Risks
- Browser-direct voice exposes Google's WSS endpoint + the **ephemeral** token to the browser
  (by design; single-use, ~3-min, key never transits). Based accepted this; acceptable here.
- App Runner SSE + long-ish Gemini turns: confirm App Runner's request timeout ≥ our cap (55 s).
- A migration has its own risk — hence the phased, staging-verified, reversible sequence; the
  current stack serves until each slice is proven.

## References
- Review findings: this session's chat logic/wisdom review (retrieval, persona, runtime).
- `geda0/Based`: ADR `docs/decisions/0007-live-voice-seam.md`; commit `9b07c38`
  (relay+ECS → browser-direct); `frontend/src/lib/live-relay-client.ts`,
  `backend/src/modules/live/live-token-client.ts`, `infra/staging.yaml` (App Runner).
- gvp current: `docker/chat/app/{main,live_gemini,live_relay,gemini_routing,providers,knowledge_context}.py`,
  `aws/chat-ecs-template.yaml`.
