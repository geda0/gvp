"""Characterization: GeminiRoutingChain transparently falls back to the
secondary model when the primary's stream rate-limits on its first chunk
(project invariant #9)."""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk

from app.gemini_routing import GeminiRoutingChain
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
            yield AIMessageChunk(content="from-fallback")

        return gen()


class _CommitThenBoom:
    """Primary: yields one chunk (commits the stream) THEN raises mid-stream."""

    def astream(self, _payload, config=None):
        async def gen():
            yield AIMessageChunk(content="from-primary")
            raise RuntimeError("mid-stream boom")

        return gen()


class _PlainFirstChunk:
    """Primary: its stream raises a NON-rate-limit error BEFORE yielding."""

    def astream(self, _payload, config=None):
        async def gen():
            raise RuntimeError("boom")
            yield  # unreachable; makes gen an async generator

        return gen()


class _RateLimitInvoke:
    """Primary (non-streaming): ainvoke raises an upstream 429."""

    async def ainvoke(self, _payload, config=None):
        raise UpstreamError(429)


class _OkInvoke:
    """Fallback (non-streaming): ainvoke returns distinct, assertable content."""

    async def ainvoke(self, _payload, config=None):
        return AIMessage(content="from-fallback")


@pytest.mark.asyncio
async def test_astream_first_chunk_ratelimit_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chain = GeminiRoutingChain(
        prefix=None,
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

    assert "".join(c.content for c in chunks) == "from-fallback"


@pytest.mark.asyncio
async def test_astream_committed_midstream_error_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chain = GeminiRoutingChain(
        prefix=None,
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
            seen.append(chunk.content)

    # The committed primary chunk reached the caller, then the mid-stream error
    # propagated out — the chain did NOT restart on the fallback.
    assert "from-primary" in seen
    assert "from-fallback" not in seen


@pytest.mark.asyncio
async def test_astream_non_ratelimit_error_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chain = GeminiRoutingChain(
        prefix=None,
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
            seen.append(chunk.content)

    # A plain (non-rate-limit) first-chunk error propagates immediately — the
    # fallback is only tried on an upstream rate limit, so it was NOT retried.
    assert "from-fallback" not in seen


@pytest.mark.asyncio
async def test_ainvoke_ratelimit_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chain = GeminiRoutingChain(
        prefix=None,
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
