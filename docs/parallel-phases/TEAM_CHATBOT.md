# Team Chatbot — Phase 2 brief (parallel)

**Mission:** Implement the **chat HTTP API** (LangChain-based) with **portfolio-grounded** behavior, **swappable model backends**, and **strong automated tests**. Prefer **free-tier-friendly** providers; **Gemini free tier** is the recommended default for “real” answers when keys are available.

**You own:** Chat service code, LangChain chains, RAG/context loading from repo JSON, provider abstraction, pytest (unit + API), error semantics, streaming if specified by contract.

**You do not own:** Nginx routing (Team Docker), visual design (Team UI). You **publish** a stable JSON contract and env vars.

---

## Provider strategy (deep comparison)

Requirements: **low or zero cost** for a personal portfolio, **LangChain-friendly**, **server-side keys only**, **predictable enough for tests**.

| Option | Cost | Pros | Cons | When to use |
|--------|------|------|------|--------------|
| **Mock / fake model** (`FakeListChatModel`, custom `Runnable`) | $0 | Deterministic, instant, no network, perfect for CI and Docker smoke | Not “real” UX | Default in compose; `CHAT_PROVIDER=mock` |
| **Google Gemini (Flash)** via AI Studio API key | **Free tier** (see [official pricing](https://ai.google.dev/gemini-api/docs/pricing) and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)) | Strong quality/cost ratio; good LangChain integration (`langchain-google-genai`); Flash suited to chat | Rate limits; free tier data may be used to improve Google products per policy | **`CHAT_PROVIDER=gemini`** recommended for dev/staging with real answers |
| **Groq** | Free tier with limits | Very fast inference | Limits change; another vendor | Alternative if team already uses Groq |
| **Ollama** (local) | $0 | No API bill; private | Heavier Docker image + model pull; slower cold start | Optional `CHAT_PROVIDER=ollama` for fully offline demos |
| **OpenAI** | Paid / low free trial | Mature docs | Not “free” long-term | Optional `CHAT_PROVIDER=openai` |

**Recommendation:** Implement **`mock` + `gemini`** first. Use **Gemini 2.x Flash** (not Pro) on free tier to stay within reasonable RPM/RPD. **Always** document: “Verify current limits on Google’s pricing page before load testing.”

**Security:** API keys only in server env (`GEMINI_API_KEY`, etc.). Never expose in static HTML or client bundle.

---

## LangChain architecture (suggested)

1. **Load context once** (or cached TTL): normalize [`resume/resume.json`](../../resume/resume.json) + [`data/projects.json`](../../data/projects.json) into text chunks → retriever (start simple: **BM25** or small in-memory store to avoid embedding model downloads in CI; upgrade to embeddings later if needed).
2. **Runnable chain:** retriever → prompt template (system: “You are a concise assistant for Marwan’s portfolio… cite sections, refuse unrelated harmful requests”) → LLM → output parser (string).
3. **Provider factory:** `get_llm()` switches on `CHAT_PROVIDER`; each provider behind same interface (`invoke` / `astream`).
4. **Observability:** structured logs for model name, latency, and error class (no raw user PII in logs if avoidable).

---

## HTTP API contract (align with Team Docker / UI)

Publish this in your README fragment:

- **`POST /api/chat`**  
  - Request: `{ "messages": [ { "role": "user"|"assistant"|"system", "content": "..." } ], "stream": false }`  
  - Response (non-stream): `{ "reply": "string", "model": "string" }` or `{ "error": "...", "code": "..." }` with appropriate HTTP status.
- **`GET /health`** → `{ "ok": true }` for compose healthcheck.

**Streaming (optional phase 2b):** If `stream: true`, respond `text/event-stream` with documented event format; UI team can add later. Non-streaming must remain supported for simpler tests.

**Limits:** Max messages length, max `content` length per message (truncate server-side with logged warning), max total messages count.

---

## Test cases (mandatory coverage)

Use **pytest** + **HTTPX** `AsyncClient` against the ASGI app (in-process) for speed; add **one** integration test optional against Docker if Team Docker provides a compose profile.

### Happy path and core behavior

1. **Health:** `GET /health` → 200, JSON `ok`.
2. **Minimal chat:** one user message → 200, non-empty `reply`, `model` present.
3. **Multi-turn:** two user turns with assistant in between; order preserved in prompt.
4. **RAG grounding:** question answerable only from resume/projects (e.g. employer name) returns correct fact; **wrong** answer fails test (golden assertion or substring).
5. **Out-of-corpus:** question unrelated to portfolio → polite refusal or “I only know about…” without inventing employers.

### Input validation and robustness

6. **Empty `messages`:** 400 + clear `error` code.
7. **Missing `messages`:** 400.
8. **Malformed JSON:** 400.
9. **Unknown `role`:** 400 or strip with warning (document behavior).
10. **Oversized payload:** 413 or 400 with stable error body (not stack trace).
11. **Unicode and RTL:** user content round-trips without mojibake in `reply` field encoding.

### Provider and configuration

12. **`CHAT_PROVIDER=mock`:** no external network; deterministic output for golden test.
13. **`CHAT_PROVIDER=gemini` without key:** 503 or 501 with `error` message (never crash).
14. **Invalid key (integration, optional):** graceful 502/503, no secret echo in response body.
15. **Simulated provider 429:** map to 429 + `Retry-After` optional; client-friendly JSON.

### Safety and abuse (lightweight)

16. **Prompt injection string** in user message: model should still follow system policy (best-effort; assert system instructions remain in chain, not that model is perfect).
17. **Concurrent requests:** two parallel `POST`s both return valid JSON (no shared mutable singleton bugs).

### Streaming (if implemented)

18. **Stream true:** first byte within timeout; terminal event or close documented.
19. **Client disconnect mid-stream:** server does not throw unhandled exception (log only).

---

## Handoff

- **Team Docker:** Dockerfile, `EXPOSE`, healthcheck path, env list, internal port.
- **Team UI:** Document final JSON fields and error shapes so the transcript and error banners map 1:1.

---

## Definition of done

- [ ] `CHAT_PROVIDER=mock` passes full pytest suite without network.
- [ ] `CHAT_PROVIDER=gemini` documented with key setup; manual smoke documented (automated gemini test optional with skipped-by-default marker if no key in CI).
- [ ] RAG tests (grounding + refusal) pass on mock with canned retriever or fixed corpus.
- [ ] No API keys in repository or client-side code.
