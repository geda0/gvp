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
    per-attempt first-chunk budget — valid output the UNCAPPED final attempt must
    still wait for (proves the last model is not time-boxed)."""

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
async def test_final_attempt_first_chunk_is_uncapped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The LAST model must run without the per-attempt first-chunk cap, so a
    slow-but-valid fallback still answers (the overall request deadline governs).
    Guards against a regression that time-boxes the final attempt too."""
    from app import gemini_limit_state

    gemini_limit_state.reset_for_tests()
    chain = GeminiRoutingChain(
        inject=None,
        system_prompt="",
        primary_id="m-primary",
        fallback_id="m-fallback",
        key="k",
        timeout=0.3,  # first-chunk budget = min(12, 0.18) = 0.18s
    )
    # Primary stalls -> fall back; fallback's first chunk is later than 0.18s but
    # must NOT be capped (the final attempt is uncapped).
    fakes = {"m-primary": _HangFirstChunk(), "m-fallback": _SlowOkStream(0.4)}
    monkeypatch.setattr(
        GeminiRoutingChain, "_build_chain", lambda self, model_id: fakes[model_id]
    )

    chunks = [c async for c in chain.astream({"messages": []})]

    assert "".join(c.text for c in chunks) == "from-fallback"


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
