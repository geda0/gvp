"""API tests: health, validation, mock provider, RAG grounding."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health(client: AsyncClient) -> None:
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


@pytest.mark.asyncio
async def test_chat_empty_messages_400(client: AsyncClient) -> None:
    r = await client.post("/api/chat", json={"messages": []})
    assert r.status_code == 400
    body = r.json()
    assert body.get("code") == "empty_messages"
    assert "error" in body


@pytest.mark.asyncio
async def test_chat_mock_happy_path(client: AsyncClient) -> None:
    r = await client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "Hello, who is this site about?"}],
            "stream": False,
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert "reply" in data and data["reply"].strip()
    assert data.get("model") == "mock-portfolio"


@pytest.mark.asyncio
async def test_grounding_apptio_substring(client: AsyncClient) -> None:
    """Answer must be grounded in corpus (resume / projects mention Apptio for TBM)."""
    r = await client.post(
        "/api/chat",
        json={
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Which employer in the materials is associated with "
                        "Technology Business Management and IT financial planning?"
                    ),
                }
            ],
        },
    )
    assert r.status_code == 200
    reply = r.json()["reply"]
    assert "Apptio" in reply


@pytest.mark.asyncio
async def test_malformed_json_400(client: AsyncClient) -> None:
    r = await client.post(
        "/api/chat",
        content=b"{not json",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400
    assert r.json().get("code") == "malformed_json"
