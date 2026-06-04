# Plan: chat model fallback (invariant #9 — first-chunk rate-limit → fallback; committed after first chunk)

> Written by the `planner` subagent at the start of each feature; consumed by the
> orchestrator one slice per cycle. Tick a box when its slice reaches green.
> This file is part of the continuity contract — it tells the next agent exactly
> which slice is next.
>
> Layer for EVERY slice: **chat** — `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.
> UNIT level: test `GeminiRoutingChain` DIRECTLY (`app.gemini_routing`), NOT through
> `POST /api/chat`. Construct the chain with real `__init__`, then monkeypatch its `_build_chain`
> to return a per-`model_id` FAKE (fake primary for `primary_id`, fake fallback for `fallback_id`).
> The SLICE is always the OBSERVABLE routed output — which model's content the caller receives, or
> whether the error PROPAGATES — never internal call counts. See "## Notes" for the exact seam.
> Order is the execution order: the streaming walking skeleton first (S1), then its two
> commit/propagation edges (S2–S3), then the non-streaming analogue (S4), then the config guard
> (S5, which lives in `providers.py`, not the chain).

- [x] S1 [chat] `astream`: primary's `astream` raises an upstream RATE-LIMIT (`UpstreamError(status_code=429)`) on the FIRST chunk → iterating `chain.astream(...)` yields the FALLBACK model's chunks (caller sees a successful reply, content == the fallback's, NOT a raised 429) — the walking skeleton (inv: #9)
- [x] S2 [chat] `astream` COMMITTED: primary yields ≥1 chunk THEN raises mid-stream → the SAME error PROPAGATES out of the iterator (assert via `pytest.raises`); the fallback's chunks are NEVER produced (no restart once committed) (inv: #9)
- [x] S3 [chat] `astream` non-rate-limit first-chunk error: primary's `astream` raises a PLAIN error (e.g. `RuntimeError`) on the FIRST chunk → that error PROPAGATES (assert via `pytest.raises`); the fallback is NOT tried (inv: #9)
- [x] S4 [chat] `ainvoke`: primary's `ainvoke` raises an upstream RATE-LIMIT (`UpstreamError(status_code=429)`) → `await chain.ainvoke(...)` returns the FALLBACK model's output (non-streaming analogue of S1) (inv: #9)
- [x] S5 [chat] distinct-model guard: `build_llm_runnable` with `provider='gemini'` and identical primary+fallback model ids (`GEMINI_MODEL == GEMINI_FALLBACK_MODEL`) raises `RuntimeError` (`providers.py:200-201`); distinct ids build a `GeminiRoutingChain` (inv: #9)

## Notes — the EXACT seam the test-writer must use (do not re-discover)

### The chain under test (`docker/chat/app/gemini_routing.py`)
- `GeminiRoutingChain.__init__(self, prefix, primary_id, fallback_id, key, timeout, tools=None)`.
  For a unit test the collaborators are irrelevant — construct with sentinels, e.g.:
  `chain = GeminiRoutingChain(prefix=None, primary_id='m-primary', fallback_id='m-fallback', key='k', timeout=1.0)`.
- The injection seam is **`_build_chain(self, model_id)`** (line 57): the REAL one imports
  `ChatGoogleGenerativeAI` (a network model) and returns `self.prefix | llm`. Both `astream`
  (line 113) and `ainvoke` (line 78) call `self._build_chain(model_id)` per attempt inside their
  loop. Monkeypatch it to return a FAKE keyed by `model_id`:
  ```python
  fakes = {'m-primary': <fake primary>, 'm-fallback': <fake fallback>}
  monkeypatch.setattr(chain, '_build_chain', lambda model_id: fakes[model_id])
  ```
  This exercises the REAL `astream`/`ainvoke` routing logic while swapping only model construction.
  (Patch on the INSTANCE, not the class, so tests don't leak.) Do NOT patch `_model_order` —
  see the next bullet.
- **Model order is already deterministic in tests.** `_model_order()` (line 50) returns
  `[primary_id, fallback_id]` UNLESS `prefer_fallback_first()` is true. `conftest.py` has an
  **autouse** `_reset_gemini_limit_state` fixture that calls `gls.reset_for_tests()` before/after
  every test, so `prefer_fallback_first()` is `False` and the order is `[primary, fallback]` by
  default. The test-writer does NOT need to touch `gemini_limit_state` — but MUST keep the
  conftest autouse fixture in effect (don't disable it).

### How to make the fake PRIMARY raise an upstream rate-limit
- REUSE the canonical rate-limit fake from `test_readiness_timeout.py`:
  ```python
  class UpstreamError(Exception):
      def __init__(self, status_code): super().__init__(f'status={status_code}'); self.status_code = status_code
  ```
  `is_upstream_rate_limit(UpstreamError(429))` is `True` — `upstream_errors._extract_status_code_from_chain`
  reads the `.status_code` attribute → maps to 429 → rate-limit. (This is the SAME mechanism
  `test_chat_upstream_429_maps_to_stable_code` relies on; don't invent a new error type.)
- For a NON-rate-limit error (S3) raise a plain `RuntimeError('boom')` — `is_upstream_rate_limit`
  returns `False` for it (proven by `test_upstream_errors.py::test_is_upstream_rate_limit_generic_false`).

### Fake chain shapes (mirror `test_turn_persistence.py`'s `_StreamChain`)
- **`astream` fakes (S1–S3):** `astream` is called as `chain.astream(inp, config=config)` (note the
  `config` kwarg — line 114), then `.__aiter__()`/`.__anext__()`. So the fake's signature must be
  `def astream(self, _payload, config=None)` and it must return an async iterator. Use an inner
  async generator, exactly like `_StreamChain`:
  ```python
  class _RateLimitFirstChunk:           # primary for S1: raises 429 BEFORE any yield
      def astream(self, _payload, config=None):
          async def gen():
              raise UpstreamError(429)
              yield  # unreachable; makes gen an async generator
          return gen()
  class _OkStream:                      # fallback for S1: yields distinct content
      def astream(self, _payload, config=None):
          async def gen():
              yield AIMessageChunk(content='from-fallback')
          return gen()
  class _CommitThenBoom:                # primary for S2: one chunk THEN raises
      def astream(self, _payload, config=None):
          async def gen():
              yield AIMessageChunk(content='from-primary')
              raise RuntimeError('mid-stream boom')   # or UpstreamError(429) — still must propagate
          return gen()
  class _PlainFirstChunk:               # primary for S3: plain error before any yield
      def astream(self, _payload, config=None):
          async def gen():
              raise RuntimeError('boom')
              yield
          return gen()
  ```
  Import `from langchain_core.messages import AIMessageChunk`. Drive the chain with
  `chunks = [c async for c in chain.astream({'messages': []})]`.
- **`ainvoke` fakes (S4):** `ainvoke` is called as `await chain.ainvoke(inp, config=config)`
  (line 80) — signature `async def ainvoke(self, _payload, config=None)`. Reuse the shape of
  `ErrorChain`/`SlowChain` from `test_readiness_timeout.py`:
  ```python
  class _RateLimitInvoke:   # primary: async def ainvoke(...): raise UpstreamError(429)
  class _OkInvoke:          # fallback: async def ainvoke(...): return AIMessage(content='from-fallback')
  ```
  (`AIMessage` or any sentinel object/string the test can assert on.)

### How to ASSERT which model answered (the observable contract — NOT call counts)
- **S1 (fallback streamed):** assert the collected chunk CONTENT is the fallback's, e.g.
  `''.join(c.content for c in chunks) == 'from-fallback'`. A corroborating assertion is allowed:
  `chain.last_model_id == 'm-fallback'` (the chain records the committed model — a public-ish
  observable, line 137/120). Prefer the content assertion as the primary one.
- **S2 (committed → propagate):** `with pytest.raises(RuntimeError):  [c async for c in chain.astream(...)]`
  AND assert the first chunk seen before the raise was the PRIMARY's (`'from-primary'`), i.e. the
  fallback was never produced. Do NOT assert "fallback called 0 times" via a counter — assert the
  OUTPUT: collect chunks up to the raise and confirm none are `'from-fallback'`.
- **S3 (plain first-chunk → propagate):** `with pytest.raises(RuntimeError): [c async for c in chain.astream(...)]`
  and confirm NO fallback chunk was produced (collect-then-assert, same as S2).
- **S4 (ainvoke fallback):** `out = await chain.ainvoke({'messages': []})`; assert the returned
  value is the fallback's (`out.content == 'from-fallback'` or `out == <fallback sentinel>`); may
  corroborate with `chain.last_model_id == 'm-fallback'`.
- Mark every test `@pytest.mark.asyncio` (the suite uses it — see `test_readiness_timeout.py`).
- New test file: `docker/chat/tests/test_gemini_routing.py`.

### S5 — the distinct-model guard (lives in `providers.py`, not the chain)
- The guard is `providers.py:200-201`: inside `build_llm_runnable`, after resolving
  `primary_id = _gemini_primary_model_id()` / `fallback_id = _gemini_fallback_model_id()`, it
  raises `RuntimeError('GEMINI_MODEL and GEMINI_FALLBACK_MODEL must differ')` when they're equal.
- Drive it via env (those resolvers read `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` —
  `providers.py:54-59`). With `monkeypatch`: set `CHAT_PROVIDER='gemini'`, `GEMINI_API_KEY='k'`
  (line 192-194 requires a key BEFORE the guard), and `GEMINI_MODEL == GEMINI_FALLBACK_MODEL` →
  `with pytest.raises(RuntimeError): build_llm_runnable('gemini', <prompt>, <pack>)`.
- The constructor args: `build_llm_runnable(provider, system_prompt, knowledge_pack)` — for a
  guard test the prompt/pack only need to be values the upstream `_build_*` accepts; a minimal
  pack like `{'bio': {}, 'faq': [], 'roles': [], 'projects': []}` (the shape `_inject_retrieved`
  reads in `test_providers.py`) and a short system prompt string. If wiring the full
  `build_llm_runnable` proves heavy, the navigator may approve asserting the guard at a tighter
  seam — but the OBSERVABLE is "identical ids are rejected", however reached.

## Notes — out of scope for THIS feature (do NOT slice)
- **Persistence of the turn** (inv #7/#8) is DONE (shipped chat turn-persistence release,
  `test_turn_persistence.py`). This feature is the routing/fallback contract only — do not re-assert
  `status`/rows here.
- **The rate-limit classifier** (`is_upstream_rate_limit`, `upstream_error_body`) is already proven
  by `test_upstream_errors.py`, and **the daily-reset state tracker** (`prefer_fallback_first`,
  `note_primary_rate_limited`) by `test_gemini_limit_state.py`. Do NOT re-test those building
  blocks — S1–S5 USE them but assert the chain's routed OUTPUT, not the classifier/tracker.
- **The `prefer_fallback_first` reordering path** (when state says "try fallback first") is the
  state-tracker's contract, already covered — this feature pins the FALLBACK-ON-FAILURE behavior
  with the default `[primary, fallback]` order only.
- **Exact model ids** (`gemini-3.1-flash-lite` / `gemma-4-26b-a4b-it`) are configuration, not the
  invariant (project-invariants.md "Out of scope"). S5 asserts ids must DIFFER, never their values.
- Voice timbre lock (inv #10, backlog item 2) and the frontend guards (inv #1/#2, items 3–4) are
  separate backlog items — not in this feature.
