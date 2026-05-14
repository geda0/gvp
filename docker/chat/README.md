# Portfolio chat API (FastAPI + LangChain)

## Build context (Docker)

Build from the **repository root** so `resume/` and `data/` are in scope:

```bash
docker build -f docker/chat/Dockerfile .
```

The image copies `resume/resume.json` and `data/projects.json` into `/app/corpus/` and sets `CORPUS_RESUME_PATH` / `CORPUS_PROJECTS_PATH`.

## Run locally

```bash
cd docker/chat
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
CORPUS_RESUME_PATH=/path/to/gvp/resume/resume.json \
CORPUS_PROJECTS_PATH=/path/to/gvp/data/projects.json \
CHAT_PROVIDER=mock \
.venv/bin/uvicorn app.main:app --reload --port 8000
```

## Environment

| Variable | Description |
|----------|-------------|
| `CHAT_PROVIDER` | `mock` (default, no network), `gemini` (`GEMINI_API_KEY`), `openai` (`OPENAI_API_KEY`) |
| `GEMINI_API_KEY` | Required when `CHAT_PROVIDER=gemini` |
| `GEMINI_MODEL` | Optional override (default `gemini-2.0-flash`) |
| `OPENAI_API_KEY` | Required when `CHAT_PROVIDER=openai` |
| `OPENAI_MODEL` | Optional override (default `gpt-4o-mini`) |
| `CHAT_PROVIDER_TIMEOUT_SECONDS` | Global upstream timeout in seconds (default `15`) |
| `GEMINI_TIMEOUT_SECONDS` | Optional Gemini-specific timeout override |
| `OPENAI_TIMEOUT_SECONDS` | Optional OpenAI-specific timeout override |
| `CORPUS_RESUME_PATH` / `CORPUS_PROJECTS_PATH` | JSON files (defaults under repo root when unset) |
| `CORPUS_RESUME` / `CORPUS_PROJECTS` | Legacy aliases for the same paths |
| `CHAT_CORS_ORIGINS` | Optional comma-separated list of browser origins allowed to call the API (e.g. `https://marwanelgendy.link`). Required when the static site and chat run on different hosts. |

## Deploy (stage / prod)

Single entry point: **`scripts/integrate-and-deploy.sh`** from the repo root (see [`secrets.example/deploy.env.example`](../secrets.example/deploy.env.example) and optional [`secrets.example/chat-deploy.env.example`](../secrets.example/chat-deploy.env.example)).

```bash
bash scripts/integrate-and-deploy.sh        # prod — stack SAM_STACK_NAME (default page)
bash scripts/integrate-and-deploy.sh stage  # staging stack SAM_STACK_NAME_STAGE (default page-staging); HTML sync uses https://chat.marwanelgendy.link/api/chat by default
```

Chat Docker build runs **in parallel with `sam build`** when `CHAT_ECR_REPOSITORY_URI` or `CHAT_ALWAYS_BUILD=1` is set. ECR push and ECS use the same env vars as before. **GitHub Actions → Integrate and deploy** passes **deploy_environment** (`prod` / `stage`).

## API

- `GET /health` → `{"ok": true}`
- `GET /ready` → readiness for corpus + provider chain (`200` when ready, `503` when degraded)
- `POST /api/chat` → body `{"messages":[{"role":"user|assistant|system","content":"..."}],"stream":false}` → `{"reply":"...","model":"..."}`

Errors: JSON body with `error` and `code` where applicable. Timeout and upstream failures are mapped to stable codes (`upstream_timeout`, `upstream_rate_limited`, `upstream_auth_error`, `model_error`).

## Tests

```bash
cd docker/chat
.venv/bin/pytest
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
