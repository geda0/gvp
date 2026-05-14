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
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
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
| `GEMINI_FALLBACK_MODEL` | Used when the primary returns rate limits / quota (default **`gemma-4-26b-a4b-it`**). After a primary 429, the service prefers the fallback first until **UTC midnight**, then resets. |
| `OPENAI_API_KEY` | Required when `CHAT_PROVIDER=openai` |
| `OPENAI_MODEL` | Optional override (default `gpt-4o-mini`) |
| `CHAT_PROVIDER_TIMEOUT_SECONDS` | Global upstream timeout in seconds (default `15`) |
| `GEMINI_TIMEOUT_SECONDS` | Optional Gemini-specific timeout override |
| `OPENAI_TIMEOUT_SECONDS` | Optional OpenAI-specific timeout override |
| `CHAT_KNOWLEDGE_DIR` | Directory containing `bio.json`, `roles.json`, `projects.json`, `faq.json` (default `data/chat-knowledge`) |
| `CHAT_SYSTEM_PROMPT_PATH` | Prompt markdown file with `prompt-version` header (default `docker/chat/prompts/system-prompt.md`) |
| `CHAT_CORS_ORIGINS` | Optional comma-separated list of browser origins allowed to call the API (e.g. `https://marwanelgendy.link`). Required when the static site and chat run on different hosts. |

## Deploy (stage / prod)

Single entry point: **`scripts/integrate-and-deploy.sh`** from the repo root (see [`secrets.example/deploy.env.example`](../secrets.example/deploy.env.example) and optional [`secrets.example/chat-deploy.env.example`](../secrets.example/chat-deploy.env.example)).

```bash
bash scripts/integrate-and-deploy.sh        # prod — stack SAM_STACK_NAME (default page)
bash scripts/integrate-and-deploy.sh stage  # staging contact stack; set CHAT_STAGE_CHAT_API_URL for chat meta (FastAPI URL, not the chat.* frontend)
```

Chat Docker build runs **in parallel with `sam build`** when `CHAT_ECR_REPOSITORY_URI` or `CHAT_ALWAYS_BUILD=1` is set. ECR push and ECS use the same env vars as before. **GitHub Actions → Integrate and deploy** passes **deploy_environment** (`prod` / `stage`).

### AWS Lambda + Gemini (staging API URL)

SAM template **[`aws/chat-template.yaml`](../aws/chat-template.yaml)** deploys an **HTTP API** + **Lambda container** (image from [`Dockerfile.lambda`](../docker/chat/Dockerfile.lambda)) with **`CHAT_PROVIDER=gemini`**. Set **`CHAT_SAM_STACK_NAME`** + **`GEMINI_API_KEY`** in `.secrets/chat-deploy.env`; `integrate-and-deploy.sh` writes **`ChatPostApiUrl`** into **`gvp:chat-api-url`** on stage when **`CHAT_STAGE_CHAT_API_URL`** is unset. **`CHAT_CORS_ORIGINS`** (comma-separated) should include your staging **frontend** origin (e.g. `https://chat.marwanelgendy.link`) so the browser can call the execute-api host. Local image build: `npm run sam:build:chat` from repo root (requires SAM CLI + Docker). If you run **`sam deploy`** yourself for this template, pass **`--resolve-image-repos`** (or **`--image-repository`** / **`--image-repositories`**) so SAM can push the container image to ECR.

## Staging: frontend vs chat API

**`chat.marwanelgendy.link`** is used as the **staging static site** (S3 + CloudFront). That is expected: there is no FastAPI there unless you add a **CloudFront behavior** to proxy **`/api/chat`**, **`/health`**, **`/ready`** to your ECS/ALB origin.

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
- `GET /ready` → readiness for knowledge pack + provider chain (`200` when ready, `503` when degraded). With **`CHAT_PROVIDER=gemini`**, `provider.gemini` includes **`primary_model`**, **`fallback_model`**, and **`primary_rate_limits_today`** (count of primary 429/quota events since last **UTC** midnight).
- `POST /api/chat` → body `{"messages":[{"role":"user|assistant|system","content":"..."}],"stream":false,"sessionId?":"..."}` → `{"reply":"...","model":"...","actions":[...]}` where `actions` may include `open-resume` or `open-contact` buttons with optional prefill fields.

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

Or without a venv (after `pip install -r requirements.txt` in your environment):

```bash
cd docker/chat && pytest
```

## Tests in Docker

```bash
docker build -f docker/chat/Dockerfile -t gvp-chat .
docker run --rm --entrypoint python gvp-chat -m pytest /app/tests -q
```
