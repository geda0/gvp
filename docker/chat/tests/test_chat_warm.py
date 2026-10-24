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
