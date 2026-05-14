"""Extended API tests for ordering, limits, provider failures, and concurrency."""

from __future__ import annotations

import asyncio

import pytest
from httpx import AsyncClient
from langchain_core.messages import AIMessage

from app.main import MAX_MESSAGES, app


class RecordingChain:
    """Captures chain inputs so tests can assert message ordering."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def ainvoke(self, payload: dict[str, object]) -> AIMessage:
        self.calls.append(payload)
        return AIMessage(content="recorded reply")


@pytest.mark.asyncio
async def test_chat_multi_turn_preserves_order(client: AsyncClient) -> None:
    chain_before = app.state.chain
    provider_error_before = app.state.provider_error
    model_before = app.state.model_id
    recording_chain = RecordingChain()
    app.state.chain = recording_chain
    app.state.provider_error = None
    app.state.model_id = "mock-portfolio"

    try:
        r = await client.post(
            "/api/chat",
            json={
                "messages": [
                    {"role": "user", "content": "Who is this portfolio for?"},
                    {"role": "assistant", "content": "It is for Marwan Elgendy."},
                    {"role": "user", "content": "What company is linked to TBM?"},
                ]
            },
        )
    finally:
        app.state.chain = chain_before
        app.state.provider_error = provider_error_before
        app.state.model_id = model_before

    assert r.status_code == 200
    assert r.json()["reply"] == "recorded reply"
    assert recording_chain.calls, "Expected chain to receive at least one invoke"

    lc_messages = recording_chain.calls[0]["messages"]
    assert [m.type for m in lc_messages] == ["human", "ai", "human"]
    assert [m.content for m in lc_messages] == [
        "Who is this portfolio for?",
        "It is for Marwan Elgendy.",
        "What company is linked to TBM?",
    ]


@pytest.mark.asyncio
async def test_chat_invalid_role_returns_validation_error(client: AsyncClient) -> None:
    r = await client.post(
        "/api/chat",
        json={"messages": [{"role": "tool", "content": "invalid"}]},
    )
    assert r.status_code == 400
    body = r.json()
    assert body.get("code") == "validation_error"
    assert "error" in body


@pytest.mark.asyncio
async def test_chat_too_many_messages_400(client: AsyncClient) -> None:
    over_limit_messages = [
        {"role": "user", "content": f"message-{i}"} for i in range(MAX_MESSAGES + 1)
    ]
    r = await client.post("/api/chat", json={"messages": over_limit_messages})
    assert r.status_code == 400
    body = r.json()
    assert body.get("code") == "too_many_messages"
    assert "At most" in body.get("error", "")


@pytest.mark.asyncio
async def test_chat_provider_unavailable_503(client: AsyncClient) -> None:
    chain_before = app.state.chain
    provider_error_before = app.state.provider_error
    app.state.chain = None
    app.state.provider_error = "provider init failed for test"

    try:
        r = await client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hello"}]},
        )
    finally:
        app.state.chain = chain_before
        app.state.provider_error = provider_error_before

    assert r.status_code == 503
    body = r.json()
    assert body.get("code") == "provider_unavailable"
    assert "provider init failed for test" in body.get("error", "")


@pytest.mark.asyncio
async def test_chat_parallel_requests_are_stable(client: AsyncClient) -> None:
    async def _send(i: int):
        return await client.post(
            "/api/chat",
            json={
                "messages": [
                    {"role": "user", "content": f"Parallel request {i} about projects"}
                ]
            },
        )

    responses = await asyncio.gather(*[_send(i) for i in range(6)])
    assert len(responses) == 6
    for r in responses:
        assert r.status_code == 200
        body = r.json()
        assert body.get("reply", "").strip()
        assert body.get("model") == "mock-portfolio"
