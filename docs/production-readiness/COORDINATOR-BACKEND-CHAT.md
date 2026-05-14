# Coordinator — Backend (Chat API)

**Mission:** Run [`docker/chat/`](../../docker/chat/) as a **production-grade** HTTP service: predictable errors, readiness, timeouts, observability, and tests aligned with [TEAM_CHATBOT.md](../parallel-phases/TEAM_CHATBOT.md).

## Coordinator responsibilities

- Own [`docker/chat/app/main.py`](../../docker/chat/app/main.py), [`providers.py`](../../docker/chat/app/providers.py), [`context.py`](../../docker/chat/app/context.py), [`Dockerfile`](../../docker/chat/Dockerfile), [`tests/`](../../docker/chat/tests/).
- **Secrets:** only `GEMINI_API_KEY` / `OPENAI_API_KEY` via env; never client or repo.
- **Readiness:** resolve tension between Docker healthcheck hitting `/health` and `chain is None` (503 on `/api/chat`)—prefer `/ready` or make `/health` reflect provider+corpus.
- **Upstream hardening:** timeouts, map 429/401 to JSON `code` + status per brief.
- **Corpus:** document rebuild-on-publish when `resume.json` / `projects.json` change (image COPY is build-time).

## Pre-audit notes (squad input)

- Ollama/Groq mentioned in TEAM_CHATBOT not implemented—either implement or document out-of-scope.
- pytest subset present; expand toward TEAM_CHATBOT matrix (multi-turn, oversized, concurrency, gemini-without-key).
- Single uvicorn process; scale out horizontally if load grows.

## Production definition of done

- [ ] `/health` vs `/ready` story documented in `docker/chat/README.md` and compose healthcheck updated if needed.
- [ ] Provider HTTP timeouts configured; 429 surfaced with stable JSON.
- [ ] Structured logs (no raw user content by default) + optional request id middleware.
- [ ] Critical pytest cases from TEAM_CHATBOT marked done or explicitly deferred with issue links.

---

### Worker agent prompt (copy below)

```
You are a worker for Backend/Chat under /Users/marwanelgendy/workspace/PP/gvp/docker/chat.
Read docs/production-readiness/COORDINATOR-BACKEND-CHAT.md and docs/parallel-phases/TEAM_CHATBOT.md.
Pick one vertical slice: (A) readiness endpoint + compose health, (B) LLM timeout + error code mapping, (C) pytest expansion for 3+ new cases from the brief.
Keep API contract: POST /api/chat { messages, stream } -> { reply, model } or { error, code }.
No secrets in repo. Minimal diff.
```
