# Plan: chat turn-persistence (invariants #7 + #8 — every turn leaves one row with the right status)

> Written by the `planner` subagent at the start of each feature; consumed by the
> orchestrator one slice per cycle. Tick a box when its slice reaches green.
> This file is part of the continuity contract — it tells the next agent exactly
> which slice is next.
>
> Layer for EVERY slice: **chat** — `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.
> Drive `POST /api/chat` through the existing `client` fixture; inject a fake `app.state.chain`
> and a `StubStore` as `app.state.transcript_store` (save/restore in try/finally), then assert
> on the persisted row(s). The SLICE is always the persisted row's `status` (+ `errorCode`),
> NOT the HTTP body or the SSE wire (ADR-0002). See "## Notes" for the exact fixtures.
> Order is the execution order: non-stream error/timeout first (S1–S2, reuse the existing
> `ainvoke`-only fakes), then the untested streaming path (S3–S5, needs a NEW `astream` fake).

- [x] S1 [chat] non-stream: fake chain whose `ainvoke` raises a non-rate-limit error (plain `RuntimeError`) → exactly ONE persisted row (`len(stub.calls)==1`) with `turn['status']=='error'` and a populated `turn['errorCode']` + `turn['errorMessage']` (inv: #7)
- [x] S2 [chat] non-stream: fake `SlowChain` sleeps past a tiny `app.state.provider_timeout_seconds` → exactly ONE persisted row with `turn['status']=='timeout'` and `turn['errorCode']=='upstream_timeout'` (the 504 itself is already proven by `test_readiness_timeout.py`; this slice adds the row) (inv: #8)
- [x] S3 [chat] streaming `stream:true`: fake chain with an `astream` async-generator yielding ≥1 AIMessageChunk then completing → exactly ONE persisted row with `turn['status']=='ok'` and `turn['stream']==True` after the stream drains (brings the untested `_chat_stream` persistence path under test) (inv: #7)
- [x] S4 [chat] streaming: fake `astream` yields ≥1 chunk THEN raises a non-rate-limit error mid-stream → exactly ONE persisted row with `turn['status']=='error'` and a populated `turn['errorCode']` (inv: #7)
- [x] S5 [chat] streaming: fake `astream` stalls (sleeps) past a tiny `app.state.provider_timeout_seconds` between/at the first chunk → exactly ONE persisted row with `turn['status']=='timeout'` and `turn['errorCode']=='upstream_timeout'` (per-chunk deadline) (inv: #8)

## Notes — the EXACT seam the test-writer must use (do not re-discover)
- **Driver fixture:** `client` (in `docker/chat/tests/conftest.py`) — httpx `AsyncClient` over
  `ASGITransport(app)` inside `LifespanManager(app)`. Mark every test `@pytest.mark.asyncio`.
  `CHAT_PROVIDER=mock` is set there; the real chain is the mock unless you override it.
- **Inject the fake chain:** save `app.state.chain` (and restore in `finally`), assign your fake.
  This is the universal pattern in `test_readiness_timeout.py`, `test_api_extended.py`,
  `test_transcript_store.py`. Also set `app.state.provider_error = None` before the POST.
- **Inspect persisted rows:** REUSE `StubStore` from `test_transcript_store.py` —
  `self.calls=[]`; `async def persist_turn(self, **kwargs): self.calls.append(kwargs)`.
  Set `app.state.transcript_store = stub` (save/restore). The row to assert is
  `stub.calls[0]['turn']`; the status field is `stub.calls[0]['turn']['status']`,
  error fields `['turn']['errorCode']` / `['turn']['errorMessage']` (only present when
  `status != 'ok'` — see `main.py:_persist_text_turn` ~720-723). Assert `len(stub.calls)==1`
  to pin "exactly one row".
- **Existing fakes to reuse as-is (S1–S2):** `SlowChain(sleep_s)` and
  `ErrorChain(exc)` live in `test_readiness_timeout.py` (both `ainvoke`-only).
  For S1 raise a PLAIN `RuntimeError`/`Exception`, NOT the rate-limit `UpstreamError(429)` —
  rate-limit/fallback is invariant #9 (backlog item 3), out of scope here; a generic exception
  maps via `upstream_error_body` to a `model_error`-class code, which is what S1 asserts.
- **NEW fake for streaming (S3–S5) — the one piece not yet in the suite:** the non-stream fakes
  only implement `ainvoke`, but `_chat_stream` calls `chain.astream({...})` and iterates it
  (`main.py:877-902`). The test-writer must add a fake exposing
  `def astream(self, _payload)` that returns an async iterator (async generator) of
  `AIMessageChunk`s (import `from langchain_core.messages import AIMessageChunk`). For S4 yield
  ≥1 chunk then `raise RuntimeError(...)`; for S5 `await asyncio.sleep(...)` longer than the
  tiny timeout so the per-chunk `wait_for` trips. `astream` is what makes the row carry
  `stream=True` and exercises the terminal `_persist_text_turn(status=stream_status)` at
  `main.py:931-941`.
- **Timeout knob (S2, S5):** set `app.state.provider_timeout_seconds` small (e.g. 0.01) and make
  the fake sleep longer (e.g. 0.05) — exactly as `test_chat_timeout_maps_to_504` does. Restore it.

## Notes — out of scope for THIS feature (do NOT slice)
- The **non-stream OK** row is already proven by
  `test_transcript_store.py::test_chat_persists_transcript_turn` — do not re-add it (the
  acceptance checklist marks it "already proven").
- Per ADR-0002, assert **persistence + the `status` field**, NOT that the SSE wire is
  byte-incremental (Lambda/Mangum buffers SSE; token-by-token is ECS-only). S3–S5 may read the
  streamed body to drain it, but the ASSERTION is on `stub.calls`, never on chunk boundaries.
- The no-op-when-unconfigured persist (`app.state.transcript_store is None`) is already covered
  by `test_build_transcript_store_requires_table`; every slice here runs WITH a stub store set.
- First-chunk rate-limit → fallback (inv #9, backlog item 3) and the voice timbre lock
  (inv #10, item 4) are separate backlog items — not in this feature. S1/S4 deliberately use a
  PLAIN error, not a rate-limit, to stay on the persistence contract and off the #9 fallback path.
