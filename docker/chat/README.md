# Portfolio chat API (FastAPI + LangChain)

## Build context (Docker)

Build from the **repository root** so `resume/` and `data/` are in scope:

```bash
docker build -f docker/chat/Dockerfile .
```

The image copies `data/chat-knowledge/` and `docker/chat/prompts/system-prompt.md` into Lambda and sets `CHAT_KNOWLEDGE_DIR` / `CHAT_SYSTEM_PROMPT_PATH`.

## Run locally

```bash
cd docker/chat
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
CHAT_KNOWLEDGE_DIR=/path/to/gvp/data/chat-knowledge \
CHAT_SYSTEM_PROMPT_PATH=/path/to/gvp/docker/chat/prompts/system-prompt.md \
CHAT_PROVIDER=mock \
.venv/bin/uvicorn app.main:app --reload --port 8000
```

## Environment

| Variable | Description |
|----------|-------------|
| `CHAT_PROVIDER` | `mock` (default, no network), `gemini` (`GEMINI_API_KEY`), `openai` (`OPENAI_API_KEY`) |
| `GEMINI_API_KEY` | Required when `CHAT_PROVIDER=gemini` |
| `GEMINI_MODEL` | Primary model override (default **`gemini-3.1-flash-lite`**) |
| `GEMINI_LIVE_MODEL` | Multimodal **Live** model id for browser voice (default **`gemini-3.1-flash-live-preview`**) |
| `CHAT_LIVE_RELAY` | **`1`** (default in [`Dockerfile`](Dockerfile) for ECS images): browser WebSocket to **`/api/live/relay/…`** on this app; upstream Google uses **`Authorization: Token`**. **`0`**: browser opens Google with **`access_token`** query only (Lambda HTTP API stack; **voice from the browser typically fails** with Google close 1011). SAM [`chat-template.yaml`](../aws/chat-template.yaml) sets **`0`**. |
| `CHAT_LIVE_VOICE_STRICT` | **`1`**: when **`CHAT_LIVE_RELAY=0`**, **`POST /api/live/session`** returns **503** `live_voice_requires_relay` and does **not** mint an ephemeral token. Default **off** (Lambda keeps returning `direct_google` JSON for backward compatibility). |
| `CHAT_LIVE_SYSTEM_MAX_CHARS` | Max characters for combined voice system instruction + knowledge XML (default **14000**) |
| `OPENAI_API_KEY` | Required when `CHAT_PROVIDER=openai` |
| `OPENAI_MODEL` | Optional override (default `gpt-4o-mini`) |
| `CHAT_PROVIDER_TIMEOUT_SECONDS` | Global upstream timeout in seconds (default `15` for mock/OpenAI; ignored for Gemini when unset in favor of Gemini default below) |
| `GEMINI_TIMEOUT_SECONDS` | Optional Gemini-specific timeout override (default **28** when unset — large knowledge packs + tools often exceed 15s; capped at 55s) |
| `GEMINI_MAX_OUTPUT_TOKENS` | Cap Gemini reply length for lower latency (default **896**, clamped 256–2048) |
| `CHAT_KNOWLEDGE_PACK_MAX_CHARS` | Hard cap on serialized `<knowledge_pack>` size (default **14000**) |
| `OPENAI_TIMEOUT_SECONDS` | Optional OpenAI-specific timeout override |
| `CHAT_KNOWLEDGE_DIR` | Directory containing `bio.json`, `roles.json`, `projects.json`, `faq.json` (default `data/chat-knowledge`) |
| `CHAT_SYSTEM_PROMPT_PATH` | Prompt markdown file with `prompt-version` header (default `docker/chat/prompts/system-prompt.md`) |
| `CHAT_CORS_ORIGINS` | Optional comma-separated list of browser origins allowed to call the API (e.g. `https://marwanelgendy.link`). Required when the static site and chat run on different hosts. |
| `CHAT_READY_VERBOSE` | Set to **`1`** so **`GET /ready`** returns the full diagnostics JSON (default is **`{"ok": …}`** only). |
| `CHAT_READY_VERBOSE_SECRET` | With **`CHAT_READY_VERBOSE` unset**, full **`/ready`** body is available only as **`GET /ready?verbose=1&token=<secret>`** (token and secret must be the same length for comparison). |

## Gemini Multimodal Live (browser voice)

Voice uses the **Gemini Live** WebSocket protocol (preview). Official overview: [Multimodal Live API](https://ai.google.dev/gemini-api/docs/multimodal-live). Message shapes and auth tokens: [Live API reference](https://ai.google.dev/api/live). Browser tokens: [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens). WebSocket walkthrough: [Get started with Live API (WebSockets)](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).

**Audio:** input **16-bit PCM, 16 kHz**; model output is typically **24 kHz** (see Google’s multimodal-live doc). The static site opens the Live WebSocket and completes the **`setup` / `setupComplete`** handshake **before** requesting the microphone, so the ephemeral token’s **new-session** window is not spent during the permission prompt. Mic PCM is sent only after **`setupComplete`** ([`js/chat-live.js`](../js/chat-live.js)).

**Backend:** [`app/live_gemini.py`](app/live_gemini.py) mints tokens with **`v1alpha`**, explicit **`new_session_expire_time`** / **`expire_time`**, and **`LiveConnectConstraints`**. Relay: [`app/live_relay.py`](app/live_relay.py) (required for working voice in practice).

**Verify voice after deploy:** `POST /api/live/session` on the **same host** as `gvp:chat-api-url` should return **`liveVoiceTransport":"relay"`**, **`voiceBrowserExperience":"relay_recommended"`**, **`voiceHint":"ok"`**, and a **`websocketUrl`** containing **`/api/live/relay/`**. In DevTools Network, the voice socket should hit your API host (not `generativelanguage.googleapis.com`). First inbound JSON should include **`setupComplete`** within a few seconds (the FE waits up to 45s). The relay sends setup **once** server-side; the browser must **not** send a second setup on that path. If voice hangs on “Connecting…” then times out, redeploy the chat image with the latest relay + `js/chat-live.js` and confirm **`CHAT_CORS_ORIGINS`** includes your page origin (relay closes with **4403** when Origin is rejected). If you see **`direct_google`** / **`direct_google_only`**, the browser client skips opening that socket unless `localStorage gvp_chat_voice_allow_direct=1` (debug only); use ECS + relay for real voice.

| Deploy shape | `CHAT_LIVE_RELAY` | Mic meta (`GVP_CHAT_VOICE`) | Voice outcome |
|--------------|-------------------|-------------------------------|---------------|
| Lambda HTTP API (SAM) | `0` | off | Text chat; mic hidden. |
| Lambda + mic meta on | `0` | on | Mic visible; client blocks **`direct_google`** (clear error, no 1011 loop). |
| ECS/ALB + relay | `1` | on | **`relay`** path; voice can work. |
| Lambda + strict | `0` + **`CHAT_LIVE_VOICE_STRICT=1`** | n/a | **503** on live session; no token mint. |

## Deploy (stage / prod)

Single entry point: **`scripts/integrate-and-deploy.sh`** from the repo root (see [`secrets.example/deploy.env.example`](../secrets.example/deploy.env.example) and optional [`secrets.example/chat-deploy.env.example`](../secrets.example/chat-deploy.env.example)). **`GVP_CHAT_VOICE=1`** (or **`true`** / **`yes`**) turns on the static site’s mic UI via **`gvp:chat-voice-enabled`** during the same script’s HTML meta sync; omit for a text-only chat surface in the browser.

```bash
bash scripts/integrate-and-deploy.sh        # prod — stack SAM_STACK_NAME (default page)
bash scripts/integrate-and-deploy.sh stage  # staging contact stack; set CHAT_STAGE_CHAT_API_URL for chat meta (FastAPI URL, not the chat.* frontend)
```

Chat Docker build runs **in parallel with `sam build`** when `CHAT_ECR_REPOSITORY_URI` or `CHAT_ALWAYS_BUILD=1` is set. ECR push and ECS use the same env vars as before. **GitHub Actions → Integrate and deploy** passes **deploy_environment** (`prod` / `stage`).

### AWS Lambda + Gemini (staging API URL)

SAM template **[`aws/chat-template.yaml`](../aws/chat-template.yaml)** deploys an **HTTP API** + **Lambda container** (image from [`Dockerfile.lambda`](../docker/chat/Dockerfile.lambda)) with **`CHAT_PROVIDER=gemini`**. Set **`CHAT_SAM_STACK_NAME_STAGE`** / **`CHAT_SAM_STACK_NAME_PROD`** (or legacy **`CHAT_SAM_STACK_NAME`**) + **`GEMINI_API_KEY`** in `.secrets/chat-deploy.env`; `integrate-and-deploy.sh` writes **`ChatPostApiUrl`** into **`gvp:chat-api-url`** on stage when **`CHAT_STAGE_CHAT_API_URL`** is unset. **`CHAT_CORS_ORIGINS`** (comma-separated) should include your staging **frontend** origin (e.g. `https://chat.marwanelgendy.link`) so the browser can call the execute-api host. Local image build: `npm run sam:build:chat` from repo root (requires SAM CLI + Docker). If you run **`sam deploy`** yourself for this template, pass **`GeminiApiKey`** (required) and **`--resolve-image-repos`** (or **`--image-repository`** / **`--image-repositories`**) so SAM can push the container image to ECR.

## Staging: frontend vs chat API

**`chat.marwanelgendy.link`** is used as the **staging static site** (S3 + CloudFront). That is expected: there is no FastAPI there unless you add a **CloudFront behavior** to proxy **`/api/chat`**, **`/api/live/session`**, **`/health`**, **`/ready`** to your ECS/ALB origin.

**`<meta name="gvp:chat-api-url">`** (and env **`CHAT_STAGE_CHAT_API_URL`** when syncing) must be the URL that reaches **uvicorn** — e.g. an **ALB HTTPS URL**, **`https://api-chat.…/api/chat`**, or the same **`chat.…`** host **only if** you proxy `/api/*` to the container.

## Public URL troubleshooting (404 on `/api/chat`)

**Symptom:** Requests to **`https://chat.<domain>/api/chat`** return **301 → 404** and **`Server: AmazonS3`**.

**Cause:** The browser is calling the **static frontend** hostname. **`gvp:chat-api-url`** was set to that host by mistake, or the staging site does not reverse-proxy `/api/chat` to FastAPI.

**Fix:** Set **`CHAT_STAGE_CHAT_API_URL`** (and HTML meta) to your **real API** origin, **or** add CloudFront/API Gateway rules so **`/api/chat`** on the frontend hostname forwards to the chat service.

**Smoke check** against the **API** URL you put in meta (expect **200**):

```bash
curl -sS -o /dev/null -w '%{http_code} %{url_effective}\n' -L 'https://YOUR-API-HOST/health'
```

## API

- `GET /health` → `{"ok": true, "liveRelay": true|false}` mirrors **`CHAT_LIVE_RELAY`** (use for quick voice wiring checks; `integrate-and-deploy.sh` may GET this after deploy).
- `GET /ready` → **`{"ok": true|false}`** by default (HTTP **200** when ready, **503** when degraded). Set **`CHAT_READY_VERBOSE=1`** or **`GET /ready?verbose=1&token=…`** matching **`CHAT_READY_VERBOSE_SECRET`** for the full diagnostics payload (paths, provider errors). Tests set **`CHAT_READY_VERBOSE=1`** automatically.
- `POST /api/chat` → body `{"messages":[{"role":"user|assistant|system","content":"..."}],"stream":false,"sessionId?":"..."}` → `{"reply":"...","model":"...","actions":[...]}` where `actions` may include `open-resume` or `open-contact` buttons with optional prefill fields.
- `POST /api/live/session` → optional body `{"sessionId?":"..."}` → includes `websocketUrl`, `handshake`, `model`, `apiVersion`, `liveVoiceTransport`, `voiceBrowserExperience` (`relay_recommended` \| `direct_google_only`), `voiceHint` (`ok` \| `relay_required_for_voice`). **`relay`**: browser opens **`wss://…/api/live/relay/{id}`**. **`direct_google`**: query-token Google URL (browser client blocks unless `localStorage gvp_chat_voice_allow_direct=1`). With **`CHAT_LIVE_VOICE_STRICT=1`** and relay off: **503** `live_voice_requires_relay` (no mint). Local dev: proxy **`/api/chat`**, **`/api/live/session`**, **`/api/live/relay/`** when using relay.

Errors: JSON body with `error` and `code` where applicable. Timeout and upstream failures are mapped to stable codes (`upstream_timeout`, `upstream_rate_limited`, `upstream_auth_error`, `model_error`).

## Tests

```bash
cd docker/chat
.venv/bin/pytest
```

Phase 4 eval gate only:

```bash
cd docker/chat
.venv/bin/pytest tests/test_eval_gate.py -v
```

Or without a venv (after `pip install -r requirements.txt -r requirements-dev.txt` in your environment):

```bash
cd docker/chat && pytest
```

## Tests in Docker

```bash
docker build -f docker/chat/Dockerfile -t gvp-chat .
docker run --rm --entrypoint python gvp-chat -m pytest /app/tests -q
```
