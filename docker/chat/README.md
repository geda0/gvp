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
| `CORPUS_RESUME_PATH` / `CORPUS_PROJECTS_PATH` | JSON files (defaults under repo root when unset) |
| `CORPUS_RESUME` / `CORPUS_PROJECTS` | Legacy aliases for the same paths |

## API

- `GET /health` → `{"ok": true}`
- `POST /api/chat` → body `{"messages":[{"role":"user|assistant|system","content":"..."}],"stream":false}` → `{"reply":"...","model":"..."}`

Errors: JSON body with `error` and `code` where applicable.

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
