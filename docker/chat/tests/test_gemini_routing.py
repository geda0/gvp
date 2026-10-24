"""Characterization: GeminiRoutingChain transparently falls back to the
secondary model when the primary's stream rate-limits on its first chunk
(project invariant #9)."""

from __future__ import annotations

import asyncio

import pytest

from app.gemini_routing import GeminiRoutingChain
from app.messages import Msg, MsgChunk
from app.providers import build_llm_runnable


class UpstreamError(Exception):
    """Mirror of the canonical rate-limit fake in test_readiness_timeout.py:
    is_upstream_rate_limit reads `.status_code` and maps 429 -> rate limit."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"status={status_code}")
        self.status_code = status_code


class _RateLimitFirstChunk:
    """Primary: its stream raises an upstream 429 BEFORE yielding any chunk."""

    def astream(self, _payload, config=None):
        async def gen():
            raise UpstreamError(429)
            yield  # unreachable; makes gen an async generator

        return gen()


class _UnavailableFirstChunk:
    """Primary: its stream raises an upstream 503 UNAVAILABLE ("this model is
    currently experiencing high demand") BEFORE yielding any chunk — the live
    prod failure of 2026-10-06. The 503 is carried ON THE EXCEPTION (reachable by
    _extract_status_code_from_chain, as a real google.genai APIError's code is),
    deliberately NOT only via upstream_error_body — which maps this to a
    502/`model_error` body, so a predicate reading the MAPPED status is not
    reading the upstream one."""

    def astream(self, _payload, config=None):
        async def gen():
            raise UpstreamError(503)
            yield  # unreachable; makes gen an async generator

        return gen()


class _OkStream:
    """Fallback: its stream yields distinct, assertable content."""

    def astream(self, _payload, config=None):
        async def gen():
            yield MsgChunk(text="from-fallback")

        return gen()


class _CommitThenBoom:
    """Primary: yields one chunk (commits the stream) THEN raises mid-stream."""

    def astream(self, _payload, config=None):
        async def gen():
            yield MsgChunk(text="from-primary")
            raise RuntimeError("mid-stream boom")

        return gen()


class _PlainFirstChunk:
    """Primary: its stream raises a NON-rate-limit error BEFORE yielding."""

    def astream(self, _payload, config=None):
        async def gen():
            raise RuntimeError("boom")
            yield  # unreachable; makes gen an async generator

        return gen()


class _HangFirstChunk:
    """Primary: never yields a first chunk (simulates a stuck / too-slow model
    that produces no first token within the budget)."""

    def astream(self, _payload, config=None):
        async def gen():
            await asyncio.sleep(3600)
            yield MsgChunk(text="never")  # pragma: no cover

        return gen()


class _SlowOkStream:
    """Fallback whose first chunk arrives only AFTER a delay longer than the
    per-attempt first-chunk budget — output the final attempt must NOT wait for
    (ADR-0026 §4.2: the last model is time-boxed like every other)."""

    def __init__(self, delay: float) -> None:
        self._delay = delay

    def astream(self, _payload, config=None):
        async def gen():
            await asyncio.sleep(self._delay)
            yield MsgChunk(text="from-fallback")

        return gen()


class _RateLimitInvoke:
    """Primary (non-streaming): ainvoke raises an upstream 429."""

    async def ainvoke(self, _payload, config=None):
        raise UpstreamError(429)


class _UnavailableInvoke:
    """Primary (non-streaming): ainvoke raises an upstream 503 UNAVAILABLE — the
    non-streaming sibling of _UnavailableFirstChunk. The 503 is carried ON THE
    EXCEPTION (readable by _extract_status_code_from_chain, as a real
    google.genai APIError's code is), deliberately NOT only via
    upstream_error_body — which maps this to a 502/`model_error` body, so a
    predicate reading the MAPPED status is not reading the upstream one."""

    async def ainvoke(self, _payload, config=None):
        raise UpstreamError(503)


class _HangInvoke:
    """Primary (non-streaming): ainvoke hangs past the budget (too-slow model)."""

    async def ainvoke(self, _payload, config=None):
        await asyncio.sleep(3600)
        return Msg(role="ai", content="never")  # pragma: no cover


class _OkInvoke:
    """Fallback (non-streaming): ainvoke returns distinct, assertable content."""

    async def ainvoke(self, _payload, config=None):
        return Msg(role="ai", content="from-fallback")


@pytest.mark.asyncio
async def test_astream_first_chunk_ratelimit_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.0,
    )
    fakes = {"m-primary": _RateLimitFirstChunk(), "m-fallback": _OkStream()}
    # __slots__ forbids per-instance attrs; patch the bound seam on the class
    # (monkeypatch auto-reverts, so no leak across tests).
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    chunks = [c async for c in chain.astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-fallback"


@pytest.mark.asyncio
async def test_astream_first_chunk_503_unavailable_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 503 UNAVAILABLE on the primary's FIRST chunk is retryable, so the turn
    succeeds on the healthy secondary (invariant #9 as amended by ADR-0023 §4.1).
    Live on prod ~1 turn in 3 the visitor instead got `event: error` /
    `code: model_error` with zero tokens while the fallback sat unused."""
    from app import gemini_limit_state

    # Pin the attempt order to [primary, fallback]: without this a prior test's
    # prefer_fallback flip would serve the fallback FIRST and pass vacuously.
    gemini_limit_state.reset_for_tests()
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.0,
    )
    fakes = {"m-primary": _UnavailableFirstChunk(), "m-fallback": _OkStream()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    chunks = [c async for c in chain.astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-fallback"


@pytest.mark.asyncio
async def test_a_503_does_not_demote_the_primary_for_the_day_but_a_429_does(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stickiness is 429-ONLY — the retry decision and the quota bookkeeping are
    SEPARATE, and that separation is the invariant (ADR-0023 §4.3, invariant #9).
    `note_primary_rate_limited()` flips `_prefer_fallback` for the rest of the UTC
    DAY (in-process, resets only at midnight, no admin surface, no way to clear it
    but a restart) and bumps `primary_rate_limit_hits_today()` — the counter an
    operator reads to judge quota pressure. A 503 is a statement about Google's
    capacity in that instant and it FAILS FAST, so re-discovering it next turn is
    cheap: it must retry the turn and leave BOTH untouched. One transient 503
    otherwise silently demotes the primary for every visitor for up to 24 hours
    and inflates the quota counter with a non-quota event.

    The 429 half is in this same test on purpose: without it a blanket "never
    flip" satisfies the 503 half while silently deleting the quota cooldown
    invariant #9 has always had. Both halves are driven through a real `astream`
    turn, never by calling the bookkeeping function directly — the contract is
    about what the ROUTING does.
    """
    from app import gemini_limit_state

    # A clean day, asserted: it pins the attempt order to [primary, fallback] (a
    # leaked flip would serve the fallback first and pass vacuously) and makes
    # "untouched" below a real observation rather than a pre-existing value.
    gemini_limit_state.reset_for_tests()
    assert gemini_limit_state.prefer_fallback_first() is False
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.0,
    )

    unavailable = {"m-primary": _UnavailableFirstChunk(), "m-fallback": _OkStream()}
    monkeypatch.setattr(
        GeminiRoutingChain,
        "_build_chain",
        lambda self, model_id: unavailable[model_id],
    )
    after_503 = [c async for c in chain.astream({"messages": []})]

    # The 503 turn really did take the retryable branch — the branch the quota
    # bookkeeping sits in — and still left the day's routing state alone.
    assert "".join(c.text for c in after_503) == "from-fallback"
    assert gemini_limit_state.prefer_fallback_first() is False
    assert gemini_limit_state.primary_rate_limit_hits_today() == 0

    ratelimited = {"m-primary": _RateLimitFirstChunk(), "m-fallback": _OkStream()}
    monkeypatch.setattr(
        GeminiRoutingChain,
        "_build_chain",
        lambda self, model_id: ratelimited[model_id],
    )
    after_429 = [c async for c in chain.astream({"messages": []})]

    # A real quota signal on the same chain still earns the daily demotion, and
    # the counter reads exactly one hit — the 503 contributed nothing to it.
    assert "".join(c.text for c in after_429) == "from-fallback"
    assert gemini_limit_state.prefer_fallback_first() is True
    assert gemini_limit_state.primary_rate_limit_hits_today() == 1


@pytest.mark.asyncio
async def test_astream_committed_midstream_error_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.0,
    )
    fakes = {"m-primary": _CommitThenBoom(), "m-fallback": _OkStream()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    seen: list[str] = []
    with pytest.raises(RuntimeError):
        async for chunk in chain.astream({"messages": []}):
            seen.append(chunk.text)

    # The committed primary chunk reached the caller, then the mid-stream error
    # propagated out — the chain did NOT restart on the fallback.
    assert "from-primary" in seen
    assert "from-fallback" not in seen


@pytest.mark.asyncio
async def test_astream_non_ratelimit_error_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.0,
    )
    fakes = {"m-primary": _PlainFirstChunk(), "m-fallback": _OkStream()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    seen: list[str] = []
    with pytest.raises(RuntimeError):
        async for chunk in chain.astream({"messages": []}):
            seen.append(chunk.text)

    # A plain (non-rate-limit) first-chunk error propagates immediately — the
    # fallback is only tried on an upstream rate limit, so it was NOT retried.
    assert "from-fallback" not in seen


@pytest.mark.asyncio
async def test_ainvoke_ratelimit_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.0,
    )
    fakes = {"m-primary": _RateLimitInvoke(), "m-fallback": _OkInvoke()}
    # __slots__ forbids per-instance attrs; patch the bound seam on the class
    # (monkeypatch auto-reverts, so no leak across tests).
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    result = await chain.ainvoke({"messages": []})

    # The primary's non-streaming call rate-limited (429), so the chain retried
    # the fallback and returned ITS output — the caller never sees the 429.
    assert result.content == "from-fallback"


@pytest.mark.asyncio
async def test_ainvoke_503_unavailable_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 503 UNAVAILABLE on the primary's non-streaming call is retryable, so the
    turn succeeds on the healthy secondary (invariant #9 as amended by ADR-0023
    §4.1). The sibling half of the live prod failure of 2026-10-06: the streaming
    path now retries, but a non-streaming turn still fails outright with the
    fallback sitting unused."""
    from app import gemini_limit_state

    # Pin the attempt order to [primary, fallback]: without this a prior test's
    # prefer_fallback flip would serve the fallback FIRST and pass vacuously.
    gemini_limit_state.reset_for_tests()
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.0,
    )
    fakes = {"m-primary": _UnavailableInvoke(), "m-fallback": _OkInvoke()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    result = await chain.ainvoke({"messages": []})

    assert result.content == "from-fallback"


@pytest.mark.asyncio
async def test_a_non_streaming_503_does_not_demote_the_primary_for_the_day_but_a_429_does(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The `ainvoke` half of the 429-ONLY stickiness rule (ADR-0023 §4.3,
    invariant #9) — the separation of the retry decision from the quota
    bookkeeping has to hold on BOTH paths, and the streaming test cannot see this
    one: `ainvoke` carries its own copy of the bookkeeping guard
    (`gemini_routing.py:313`), so reverting that copy to an unconditional
    `if model_id == self.primary_id:` leaves the suite green while a single
    transient 503 silently demotes the primary for every visitor for up to 24
    hours (in-process, no admin surface, nothing clears it but a restart) and
    inflates `primary_rate_limit_hits_today()` — the counter an operator reads to
    judge quota pressure — with a non-quota event.

    A 503 is a statement about Google's capacity in that instant and it FAILS
    FAST, so re-discovering it next turn is cheap: it must retry the turn and
    leave BOTH the preference and the counter untouched.

    The 429 half is in this same test on purpose: without it a blanket "never
    flip" satisfies the 503 half while silently deleting the quota cooldown
    invariant #9 has always had. Both halves are driven through a real `ainvoke`
    turn, never by calling the bookkeeping function directly — the contract is
    about what the ROUTING does.
    """
    from app import gemini_limit_state

    # A clean day, asserted: it pins the attempt order to [primary, fallback] (a
    # leaked flip would serve the fallback first and pass vacuously) and makes
    # "untouched" below a real observation rather than a pre-existing value.
    gemini_limit_state.reset_for_tests()
    assert gemini_limit_state.prefer_fallback_first() is False
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.0,
    )

    unavailable = {"m-primary": _UnavailableInvoke(), "m-fallback": _OkInvoke()}
    monkeypatch.setattr(
        GeminiRoutingChain,
        "_build_chain",
        lambda self, model_id: unavailable[model_id],
    )
    after_503 = await chain.ainvoke({"messages": []})

    # The 503 turn really did take the retryable branch — the branch the quota
    # bookkeeping sits in — and still left the day's routing state alone.
    assert after_503.content == "from-fallback"
    assert gemini_limit_state.prefer_fallback_first() is False
    assert gemini_limit_state.primary_rate_limit_hits_today() == 0

    ratelimited = {"m-primary": _RateLimitInvoke(), "m-fallback": _OkInvoke()}
    monkeypatch.setattr(
        GeminiRoutingChain,
        "_build_chain",
        lambda self, model_id: ratelimited[model_id],
    )
    after_429 = await chain.ainvoke({"messages": []})

    # A real quota signal on the same chain still earns the daily demotion, and
    # the counter reads exactly one hit — the 503 contributed nothing to it.
    assert after_429.content == "from-fallback"
    assert gemini_limit_state.prefer_fallback_first() is True
    assert gemini_limit_state.primary_rate_limit_hits_today() == 1


def test_distinct_model_guard_rejects_identical_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """build_llm_runnable enforces that the Gemini primary and fallback model
    ids differ (project invariant #9): identical ids are rejected, distinct ids
    build a routing chain."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    pack = {"bio": {}, "faq": [], "roles": [], "projects": []}

    # Identical primary/fallback ids -> the distinct-model guard rejects them.
    monkeypatch.setenv("GEMINI_MODEL", "same-model")
    monkeypatch.setenv("GEMINI_FALLBACK_MODEL", "same-model")
    with pytest.raises(RuntimeError):
        build_llm_runnable("gemini", "system prompt", pack)

    # Distinct ids -> a GeminiRoutingChain is built (no network: model
    # construction is lazy, behind _build_chain).
    monkeypatch.setenv("GEMINI_MODEL", "primary-model")
    monkeypatch.setenv("GEMINI_FALLBACK_MODEL", "fallback-model")
    chain, _model_id = build_llm_runnable("gemini", "system prompt", pack)
    assert isinstance(chain, GeminiRoutingChain)


@pytest.mark.asyncio
async def test_astream_first_chunk_timeout_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the primary stream produces NO first chunk within the per-attempt
    budget (a stuck/too-slow model), the chain abandons it and falls back to the
    secondary instead of letting the whole request time out."""
    from app import gemini_limit_state

    gemini_limit_state.reset_for_tests()
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=0.5,
    )
    fakes = {"m-primary": _HangFirstChunk(), "m-fallback": _OkStream()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    chunks = [c async for c in chain.astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-fallback"


@pytest.mark.asyncio
async def test_primary_stream_timeout_flips_prefer_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A primary first-chunk timeout records the slowness so subsequent requests
    prefer the fallback first (mirror of the 429 cooldown) — visitors stop eating
    the primary's stall on every turn."""
    from app import gemini_limit_state

    gemini_limit_state.reset_for_tests()
    assert gemini_limit_state.prefer_fallback_first() is False
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=0.5,
    )
    fakes = {"m-primary": _HangFirstChunk(), "m-fallback": _OkStream()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    _ = [c async for c in chain.astream({"messages": []})]

    assert gemini_limit_state.prefer_fallback_first() is True
    assert gemini_limit_state.primary_timeout_hits_today() == 1


@pytest.mark.asyncio
async def test_final_attempt_first_chunk_is_capped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """INVERTED by ADR-0026 §4.2 (was test_final_attempt_first_chunk_is_uncapped,
    invariant #13 as amended by #26): the LAST model is capped like every other.
    A fallback whose first chunk would arrive after the per-attempt budget ends
    the turn with asyncio.TimeoutError — which _chat_stream maps to the honest
    `upstream_timeout` — instead of an uncapped 19 s wait."""
    from app import gemini_limit_state

    gemini_limit_state.reset_for_tests()
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=1.5,  # first-chunk budget = max(0.1, min(5, 0.6*1.5/3 = 0.3)) = 0.3s
    )
    # Primary stalls -> fall back; the fallback's first chunk would land at 2 s,
    # well past its own 0.3 s budget, so the final attempt times out too.
    fakes = {"m-primary": _HangFirstChunk(), "m-fallback": _SlowOkStream(2.0)}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    seen: list[str] = []
    with pytest.raises(asyncio.TimeoutError):
        async for chunk in chain.astream({"messages": []}):
            seen.append(chunk.text)

    assert seen == []


@pytest.mark.asyncio
async def test_primary_timeout_then_fallback_failure_exhausts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Primary times out -> fall back; if the fallback also fails the error
    propagates, and ONLY the primary's timeout is recorded (the note is keyed on
    the primary, not 'any timeout')."""
    from app import gemini_limit_state

    gemini_limit_state.reset_for_tests()
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=0.3,
    )
    fakes = {"m-primary": _HangFirstChunk(), "m-fallback": _RateLimitFirstChunk()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    with pytest.raises(UpstreamError):
        async for _ in chain.astream({"messages": []}):
            pass

    assert gemini_limit_state.primary_timeout_hits_today() == 1


@pytest.mark.asyncio
async def test_ainvoke_timeout_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The non-streaming path also falls back when the primary call hangs past
    the per-attempt budget."""
    from app import gemini_limit_state

    gemini_limit_state.reset_for_tests()
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=0.5,
    )
    fakes = {"m-primary": _HangInvoke(), "m-fallback": _OkInvoke()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    result = await chain.ainvoke({"messages": []})

    assert result.content == "from-fallback"


# ---------------------------------------------------------------------------
# ADR-0026 §4 / invariant #26 — the routing latency budget.
# ---------------------------------------------------------------------------


@pytest.fixture
def virtual_clock(monkeypatch: pytest.MonkeyPatch):
    """Run the test's event loop on VIRTUAL time: `loop.time()` reads a counter,
    and whenever the loop would block in select() waiting for its next timer it
    advances the counter by that timeout instead of sleeping. A 5 s stall then
    costs no wall time and is measured exactly — the budget is asserted in the
    loop's own seconds, not inferred from a flaky wall clock. Call the returned
    installer from INSIDE the async test (it needs the running loop)."""

    class _Clock:
        def __init__(self) -> None:
            self.now = 0.0

    clock = _Clock()

    def install() -> _Clock:
        loop = asyncio.get_running_loop()
        selector = loop._selector  # type: ignore[attr-defined]
        real_select = selector.select

        def select(timeout=None):
            if timeout is not None and timeout > 0:
                clock.now += timeout
                return real_select(0)
            return real_select(timeout)

        monkeypatch.setattr(loop, "time", lambda: clock.now)
        monkeypatch.setattr(selector, "select", select)
        return clock

    return install


class _StampedOkStream:
    """A healthy model that records the loop time at which it was STARTED, so a
    test can read exactly when the chain abandoned the previous attempt."""

    def __init__(self) -> None:
        self.started_at: float | None = None

    def astream(self, _payload, config=None):
        self.started_at = asyncio.get_running_loop().time()

        async def gen():
            yield MsgChunk(text="from-fallback")

        return gen()


def _chain(timeout: float = 28.0) -> GeminiRoutingChain:
    return GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=timeout,
    )


@pytest.mark.asyncio
async def test_first_chunk_budget_defaults_to_five_seconds(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """ADR-0026 §4.1: with GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS unset the per-attempt
    first-chunk budget is 5 s (was 12) under the default 28 s request deadline —
    a stalled primary is abandoned for the fallback at t = 5 s."""
    monkeypatch.delenv("GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS", raising=False)
    clock = virtual_clock()
    chain = _chain(28.0)
    fallback = _StampedOkStream()
    fakes = {"m-primary": _HangFirstChunk(), "m-fallback": fallback}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    chunks = [c async for c in chain.astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-fallback"
    assert fallback.started_at == pytest.approx(5.0, abs=0.01)
    assert clock.now == pytest.approx(5.0, abs=0.01)


@pytest.mark.asyncio
async def test_every_ainvoke_attempt_is_capped_at_a_third_of_the_deadline(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """ADR-0026 §4.2: a first-chunk cap means nothing for a whole response, so on
    the non-streaming path EVERY attempt — the last included — is capped at
    total_timeout / MAX_MODEL_ATTEMPTS. Both models hanging under a 30 s deadline
    end the turn with asyncio.TimeoutError at exactly 2 x 10 s."""
    clock = virtual_clock()
    chain = _chain(30.0)
    fakes = {"m-primary": _HangInvoke(), "m-fallback": _HangInvoke()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    with pytest.raises(asyncio.TimeoutError):
        await chain.ainvoke({"messages": []})

    assert clock.now == pytest.approx(20.0, abs=0.01)


class _Recorded:
    """Wraps a fake model and appends `(model_id, loop time)` to a shared log
    every time the chain STARTS an attempt on it — the observable attempt order."""

    def __init__(self, model_id: str, inner, log: list) -> None:
        self._id = model_id
        self._inner = inner
        self._log = log

    def astream(self, payload, config=None):
        self._log.append((self._id, asyncio.get_running_loop().time()))
        return self._inner.astream(payload, config=config)

    async def ainvoke(self, payload, config=None):
        self._log.append((self._id, asyncio.get_running_loop().time()))
        return await self._inner.ainvoke(payload, config=config)


def _install(monkeypatch: pytest.MonkeyPatch, fakes: dict, log: list) -> None:
    recorded = {mid: _Recorded(mid, fake, log) for mid, fake in fakes.items()}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: recorded[model_id]
    )


@pytest.mark.asyncio
async def test_astream_primary_503_is_retried_once_on_the_primary_then_falls_back(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """ADR-0026 §4.3: a primary 503 UNAVAILABLE is retried on the SAME primary
    once, after PRIMARY_503_RETRY_DELAY_SECONDS (0.3 s); a second 503 goes to the
    fallback — never a third primary attempt."""
    clock = virtual_clock()
    log: list = []
    _install(
        monkeypatch,
        {"m-primary": _UnavailableFirstChunk(), "m-fallback": _OkStream()},
        log,
    )

    chunks = [c async for c in _chain().astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-fallback"
    assert [mid for mid, _t in log] == ["m-primary", "m-primary", "m-fallback"]
    assert log[1][1] == pytest.approx(0.3, abs=0.01)


@pytest.mark.asyncio
async def test_astream_fallback_first_order_still_retries_a_primary_503_once(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """ADR-0026 §4.3, the fallback-preferred order: fallback -> primary ->
    [primary, only after a 503]. The retry follows the primary wherever it sits,
    is taken at most once, and a retried 503 sets no fallback preference beyond
    the one already in force (ADR-0023 §4.3)."""
    from app import gemini_limit_state

    virtual_clock()
    gemini_limit_state.note_primary_rate_limited()
    log: list = []
    _install(
        monkeypatch,
        {"m-primary": _UnavailableFirstChunk(), "m-fallback": _RateLimitFirstChunk()},
        log,
    )

    with pytest.raises(UpstreamError):
        async for _ in _chain().astream({"messages": []}):
            pass

    assert [mid for mid, _t in log] == ["m-fallback", "m-primary", "m-primary"]
    assert gemini_limit_state.primary_rate_limit_hits_today() == 1


@pytest.mark.asyncio
async def test_ainvoke_primary_503_is_retried_once_on_the_primary_then_falls_back(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """ADR-0026 §4.3 on the non-streaming path (the two paths stay symmetric,
    ADR-0023 §3): primary 503 -> primary again after 0.3 s -> fallback."""
    virtual_clock()
    log: list = []
    _install(
        monkeypatch,
        {"m-primary": _UnavailableInvoke(), "m-fallback": _OkInvoke()},
        log,
    )

    result = await _chain().ainvoke({"messages": []})

    assert result.content == "from-fallback"
    assert [mid for mid, _t in log] == ["m-primary", "m-primary", "m-fallback"]
    assert log[1][1] == pytest.approx(0.3, abs=0.01)


@pytest.mark.asyncio
async def test_astream_primary_429_is_not_retried_on_the_primary(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """ADR-0026 §4.3: the same-model retry is for 503 ONLY. A primary 429 goes
    straight to the fallback, as before."""
    virtual_clock()
    log: list = []
    _install(
        monkeypatch,
        {"m-primary": _RateLimitFirstChunk(), "m-fallback": _OkStream()},
        log,
    )

    chunks = [c async for c in _chain().astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-fallback"
    assert [mid for mid, _t in log] == ["m-primary", "m-fallback"]


class _OkPrimaryStream:
    def astream(self, _payload, config=None):
        async def gen():
            yield MsgChunk(text="from-primary")

        return gen()


@pytest.mark.asyncio
async def test_switch_alert_names_the_model_that_failed_and_the_one_tried_next(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """Design-notes L1: in the fallback-first order a stalled FALLBACK hands the
    turn to the PRIMARY, and the alert must say exactly that — never
    "m-fallback stalled; switching to m-fallback"."""
    from app import alerts, gemini_limit_state

    virtual_clock()
    gemini_limit_state.note_primary_rate_limited()
    fired: list[tuple[str, str]] = []
    monkeypatch.setattr(
        alerts, "fire_alert", lambda kind, summary, detail="": fired.append((kind, summary))
    )
    _install(
        monkeypatch,
        {"m-primary": _OkPrimaryStream(), "m-fallback": _HangFirstChunk()},
        [],
    )

    chunks = [c async for c in _chain().astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-primary"
    assert len(fired) == 1
    summary = fired[0][1]
    assert summary.startswith("m-fallback ")
    assert summary.endswith("switching to m-primary")


@pytest.mark.asyncio
async def test_a_primary_503_alerts_as_unavailable_naming_the_retry_then_the_switch(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """ADR-0023 §5 / ADR-0026 §4.3: a primary 503 fires `chat_primary_unavailable`
    (P2) — not the mislabelled `chat_primary_rate_limit` — and each alert names
    what happens next: the same-model retry, then the switch to the fallback."""
    from app import alerts

    virtual_clock()
    fired: list[tuple[str, str]] = []
    monkeypatch.setattr(
        alerts, "fire_alert", lambda kind, summary, detail="": fired.append((kind, summary))
    )
    _install(
        monkeypatch,
        {"m-primary": _UnavailableFirstChunk(), "m-fallback": _OkStream()},
        [],
    )

    chunks = [c async for c in _chain().astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-fallback"
    assert [kind for kind, _s in fired] == [
        "chat_primary_unavailable",
        "chat_primary_unavailable",
    ]
    assert fired[0][1].startswith("m-primary ")
    assert fired[0][1].endswith("retrying m-primary")
    assert fired[1][1].startswith("m-primary ")
    assert fired[1][1].endswith("switching to m-fallback")


class _CommitThen503:
    """Primary: yields one chunk (commits) THEN raises an upstream 503 — the
    status that is retried BEFORE a first chunk and must not be after one."""

    def astream(self, _payload, config=None):
        async def gen():
            yield MsgChunk(text="from-primary")
            raise UpstreamError(503)

        return gen()


@pytest.mark.asyncio
async def test_a_503_after_the_first_chunk_is_never_retried_invariant_9(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """Invariant #9 under ADR-0026 §4.5: the 503 retry, the caps and the TTL act
    strictly BEFORE the first chunk. Once a chunk has been yielded a mid-stream
    503 propagates — no primary retry, no fallback, no duplicated text."""
    virtual_clock()
    log: list = []
    _install(
        monkeypatch,
        {"m-primary": _CommitThen503(), "m-fallback": _OkStream()},
        log,
    )

    seen: list[str] = []
    with pytest.raises(UpstreamError):
        async for chunk in _chain().astream({"messages": []}):
            seen.append(chunk.text)

    assert seen == ["from-primary"]
    assert [mid for mid, _t in log] == ["m-primary"]


class _Primary503ThenHang:
    """Primary: the first attempt is an instant 503, the retry stalls forever."""

    def __init__(self) -> None:
        self.calls = 0

    def astream(self, payload, config=None):
        self.calls += 1
        if self.calls == 1:
            return _UnavailableFirstChunk().astream(payload, config=config)
        return _HangFirstChunk().astream(payload, config=config)


@pytest.mark.asyncio
async def test_worst_case_all_stall_turn_ends_within_fifteen_seconds(
    monkeypatch: pytest.MonkeyPatch, virtual_clock
) -> None:
    """Design-notes L1 worst-case bound / invariant #26, on a fake clock with the
    DEFAULT knobs (28 s deadline, 5 s cap): the longest attempt chain the router
    allows — primary 503, primary retry stalls, fallback stalls — gives the
    visitor the honest timeout within 15 s (it was ~28 s). Three attempts, never
    a fourth."""
    monkeypatch.delenv("GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS", raising=False)
    clock = virtual_clock()
    log: list = []
    _install(
        monkeypatch,
        {"m-primary": _Primary503ThenHang(), "m-fallback": _HangFirstChunk()},
        log,
    )

    with pytest.raises(asyncio.TimeoutError):
        async for _ in _chain(28.0).astream({"messages": []}):
            pass

    assert [mid for mid, _t in log] == ["m-primary", "m-primary", "m-fallback"]
    assert clock.now <= 15.0
    assert clock.now == pytest.approx(10.3, abs=0.01)
