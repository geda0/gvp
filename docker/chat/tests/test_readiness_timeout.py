from __future__ import annotations

import asyncio

import pytest
from httpx import AsyncClient


class SlowChain:
    def __init__(self, sleep_s: float) -> None:
        self.sleep_s = sleep_s

    async def ainvoke(self, _payload):
        await asyncio.sleep(self.sleep_s)
        return "late"


class ErrorChain:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    async def ainvoke(self, _payload):
        raise self.exc


class UpstreamError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"status={status_code}")
        self.status_code = status_code


@pytest.mark.asyncio
async def test_ready_reports_success(client: AsyncClient) -> None:
    r = await client.get("/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["provider"]["ready"] is True
    assert body["corpus"]["ready"] is True


@pytest.mark.asyncio
async def test_ready_reports_provider_failure(client: AsyncClient) -> None:
    from app.main import app

    original_chain = app.state.chain
    original_error = app.state.provider_error
    try:
        app.state.chain = None
        app.state.provider_error = "Provider init failed"
        r = await client.get("/ready")
    finally:
        app.state.chain = original_chain
        app.state.provider_error = original_error

    assert r.status_code == 503
    body = r.json()
    assert body["ok"] is False
    assert body["provider"]["ready"] is False
    assert body["provider"]["error"] == "Provider init failed"


@pytest.mark.asyncio
async def test_chat_timeout_maps_to_504(client: AsyncClient) -> None:
    from app.main import app

    original_chain = app.state.chain
    original_timeout = app.state.provider_timeout_seconds
    try:
        app.state.chain = SlowChain(sleep_s=0.05)
        app.state.provider_timeout_seconds = 0.01
        r = await client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hello"}], "stream": False},
        )
    finally:
        app.state.chain = original_chain
        app.state.provider_timeout_seconds = original_timeout

    assert r.status_code == 504
    assert r.json()["code"] == "upstream_timeout"


@pytest.mark.asyncio
async def test_chat_upstream_429_maps_to_stable_code(client: AsyncClient) -> None:
    from app.main import app

    original_chain = app.state.chain
    try:
        app.state.chain = ErrorChain(UpstreamError(status_code=429))
        r = await client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hello"}], "stream": False},
        )
    finally:
        app.state.chain = original_chain

    assert r.status_code == 429
    assert r.json()["code"] == "upstream_rate_limited"

