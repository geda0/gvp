# Security and platform hardening backlog

Post-remediation spikes (not yet implemented in code). Use this list when prioritizing threat modeling, cost controls, and compliance.

## Chat and live API

| Item | Notes |
|------|--------|
| **Abuse / cost** | `POST /api/chat` and `POST /api/live/session` are public; consider API Gateway usage plans, WAF rate limits, per-IP buckets in FastAPI, signed short-lived tokens from the static origin, or CAPTCHA on first use. |
| **Live WebSocket token** | Token is delivered in the WebSocket URL query string (`live_gemini.py`); consider opaque server-minted ids, body exchange, or `Sec-WebSocket-Protocol` to keep tokens out of query strings and access logs. |
| **Transcript session identity** | Client-supplied `sessionId` feeds Dynamo keys (`transcript_store.py`); consider server-issued ids (HTTP-only cookie or signed JWT). |
| **`google.genai` private APIs** | `live_gemini.py` uses internal SDK modules; pin versions aggressively or wrap in an adapter with contract tests. |

## Contact stack and static site

| Item | Notes |
|------|--------|
| **Contact CORS `*`** | Document intentional open browser POST; add WAF / rate limits if abuse becomes costly. |
| **Analytics / consent** | gtag loads from Google; add notice or consent gate if required by jurisdiction; consider SRI or self-hosted fonts for supply-chain posture. |

## Testing

| Item | Notes |
|------|--------|
| **Node Lambdas** | Add `node:test` for `buildMessageRecord`, `validateMessage`, `requireAdminKey`, ingress error paths. |
| **Frontend** | Smoke tests for `resolveChatApiBase`, navigation hash handling (mock `window`/`document`). |
| **Python** | Expand pytest for `chat()` upstream error mapping, `/ready` minimal vs verbose when `CHAT_READY_VERBOSE` unset. |
