# Team Chatbot Excellence (largest)

**Mission:** maximize answer correctness (grounded, non-hallucinated) and speed (fast first token/response, stable tail latency).

**Primary code ownership**

- [docker/chat/app/main.py](../../docker/chat/app/main.py)
- [docker/chat/app/providers.py](../../docker/chat/app/providers.py)
- [docker/chat/app/context.py](../../docker/chat/app/context.py)
- [docker/chat/tests/test_api.py](../../docker/chat/tests/test_api.py)
- [docker/chat/README.md](../../docker/chat/README.md)

## Track A - Retrieval / RAG quality

**Goals**

- Improve retrieval quality for real questions from portfolio/resume.
- Tune BM25 chunking and `k` without increasing latency regressions.

**Worker prompt**

```text
You are Chat Track A (RAG quality) in /Users/marwanelgendy/workspace/PP/gvp.
Work only in docker/chat/app/context.py, providers.py, and docker/chat/tests.
Implement measurable retrieval improvements (chunk shaping, k strategy, query normalization) and add tests proving better grounding on known prompts.
Do not add heavy external dependencies unless justified.
```

## Track B - Prompt and policy correctness

**Goals**

- Tighten refusal policy and grounding instructions.
- Prevent unsupported claims and keep concise answers.

**Worker prompt**

```text
You are Chat Track B (prompt/policy) in /Users/marwanelgendy/workspace/PP/gvp.
Work only in docker/chat/app/providers.py and tests.
Refine system prompt policy for grounded answers and unrelated-question refusal. Add tests for out-of-corpus and anti-hallucination behavior.
Keep API contract unchanged.
```

## Track C - Latency / flash-fast response

**Goals**

- Reduce p95 latency and improve perceived speed.
- Add timeout controls and clear fast-fail behavior.

**Worker prompt**

```text
You are Chat Track C (latency) in /Users/marwanelgendy/workspace/PP/gvp.
Work in docker/chat/app/main.py, providers.py, docker/nginx.conf, and tests/docs only if needed.
Add provider timeout handling, deterministic error mapping, and optional streaming-readiness hooks without breaking current non-stream API.
Measure and document impact in docker/chat/README.md.
```

## Track D - Model routing and operational defaults

**Goals**

- Stabilize provider/model defaults for production.
- Keep fallback behavior explicit and safe when keys are missing.

**Worker prompt**

```text
You are Chat Track D (model routing) in /Users/marwanelgendy/workspace/PP/gvp.
Work in docker/chat/app/providers.py, docker/.env.example, and docker/chat/README.md.
Improve provider routing defaults (mock/gemini/openai), environment documentation, and graceful fallback semantics.
Do not leak secrets to code or frontend.
```

## Definition of done

- [ ] All existing `docker/chat` tests pass.
- [ ] New tests added for grounded correctness and speed/error paths.
- [ ] README explains provider defaults, limits, and performance knobs.
- [ ] No API contract break: `POST /api/chat` remains `{messages, stream}` -> `{reply, model}` or `{error, code}`.
