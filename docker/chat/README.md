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

## Deploy (stage / prod)

Single entry point: **`scripts/integrate-and-deploy.sh`** from the repo root (see [`secrets.example/deploy.env.example`](../secrets.example/deploy.env.example) and optional [`secrets.example/chat-deploy.env.example`](../secrets.example/chat-deploy.env.example)).

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

- `GET /health` → `{"ok": true}`
- `GET /ready` → **`{"ok": true|false}`** by default (HTTP **200** when ready, **503** when degraded). Set **`CHAT_READY_VERBOSE=1`** or **`GET /ready?verbose=1&token=…`** matching **`CHAT_READY_VERBOSE_SECRET`** for the full diagnostics payload (paths, provider errors). Tests set **`CHAT_READY_VERBOSE=1`** automatically.
- `POST /api/chat` → body `{"messages":[{"role":"user|assistant|system","content":"..."}],"stream":false,"sessionId?":"..."}` → `{"reply":"...","model":"...","actions":[...]}` where `actions` may include `open-resume` or `open-contact` buttons with optional prefill fields.
- `POST /api/live/session` → optional body `{"sessionId?":"..."}` → `{ "websocketUrl", "handshake", "model", "apiVersion" }` mints a short-lived Gemini Live token and returns the JSON to send as the **first WebSocket frame** plus a `wss://…?access_token=…` URL for the browser. Requires **`GEMINI_API_KEY`** and a loaded knowledge pack. Local dev: if the static site proxies `/api/chat` to uvicorn, add the same proxy for **`/api/live/session`**.

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
