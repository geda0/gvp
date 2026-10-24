"""ADR-0026 §5.1 — the warm contract: `POST /api/chat {"warm": true}` starts the
function and builds the model client WITHOUT a model call, and is not a turn.

Not to be confused with the voice probe's `?greet=warm` intent (GET
/api/live/probe), which is unrelated."""

from __future__ import annotations

import pytest

from app.main import app


class _WarmableChain:
    """A routing-chain stand-in that records `warm()` and FAILS LOUDLY on any model
    call — a warm that reached the model would raise into the response."""

    def __init__(self) -> None:
        self.warm_calls = 0
        self.model_calls = 0

    def warm(self) -> None:
        self.warm_calls += 1

    async def ainvoke(self, _payload, config=None):
        self.model_calls += 1
        raise AssertionError("a warm must never call the model")

    def astream(self, _payload, config=None):
        self.model_calls += 1
        raise AssertionError("a warm must never call the model")


@pytest.mark.asyncio
async def test_warm_request_returns_204_and_warms_the_chain_without_a_model_call(
    client, monkeypatch
) -> None:
    chain = _WarmableChain()
    monkeypatch.setattr(app.state, "chain", chain)

    resp = await client.post("/api/chat", json={"warm": True})

    assert resp.status_code == 204
    assert resp.content == b""
    assert chain.warm_calls == 1
    assert chain.model_calls == 0


@pytest.mark.asyncio
async def test_warm_with_messages_is_rejected_and_neither_warms_nor_answers(
    client, stub_store, monkeypatch
) -> None:
    """ADR-0026 §5.1: `warm: true` AND a non-empty `messages` is a contradiction —
    400 `warm_with_messages`, not silently a warm and not silently a turn."""
    chain = _WarmableChain()
    monkeypatch.setattr(app.state, "chain", chain)

    resp = await client.post(
        "/api/chat",
        json={"warm": True, "messages": [{"role": "user", "content": "hi"}]},
    )

    assert resp.status_code == 400
    assert resp.json()["code"] == "warm_with_messages"
    assert chain.warm_calls == 0
    assert chain.model_calls == 0
    assert stub_store.calls == []


@pytest.mark.asyncio
async def test_warm_without_a_configured_chain_is_503_provider_unavailable(
    client, monkeypatch
) -> None:
    """ADR-0026 §5.1: no chain -> the same 503 a real turn gets."""
    monkeypatch.setattr(app.state, "chain", None)

    resp = await client.post("/api/chat", json={"warm": True})

    assert resp.status_code == 503
    assert resp.json()["code"] == "provider_unavailable"


@pytest.mark.asyncio
async def test_warm_is_not_a_turn_it_logs_one_chat_warm_line_and_touches_nothing(
    client, stub_store, monkeypatch, caplog
) -> None:
    """ADR-0026 §5.1, "what it must not do": a warm writes no transcript (#7/#17
    sinks), fires no alert, leaves the routing state alone — and leaves exactly
    one `chat warm` log line carrying its elapsed ms (the post-deploy cold-start
    measurement)."""
    import logging

    from app import alerts, gemini_limit_state

    fired: list = []
    monkeypatch.setattr(alerts, "fire_alert", lambda *a, **k: fired.append(a))
    monkeypatch.setattr(app.state, "chain", _WarmableChain())
    sent = {"warm": True, "stream": True, "sessionId": "warm-probe"}

    with caplog.at_level(logging.INFO):
        resp = await client.post("/api/chat", json=sent)

    assert resp.status_code == 204
    assert stub_store.calls == []
    assert fired == []
    assert gemini_limit_state.prefer_fallback_first() is False
    assert gemini_limit_state.primary_rate_limit_hits_today() == 0
    assert gemini_limit_state.primary_timeout_hits_today() == 0
    warm_lines = [r.getMessage() for r in caplog.records if "chat warm" in r.getMessage()]
    assert len(warm_lines) == 1
    assert "elapsed_ms=" in warm_lines[0]
