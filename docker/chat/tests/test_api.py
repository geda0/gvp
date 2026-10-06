"""API tests: health, validation, mock provider, RAG grounding."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health(client: AsyncClient) -> None:
    r = await client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data.get("ok") is True


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
async def test_over_long_session_id_is_rejected_and_persists_nothing(
    client: AsyncClient,
    stub_store,
) -> None:
    """Invariant #17, the reject-the-identity half. `sessionId` is not telemetry:
    it lands as the DynamoDB partition key `id` (`transcript_store.py:123`), so
    clamping it would merge every caller sharing a 128-char prefix into one row.
    An identity that does not fit is refused, never truncated. `POST /api/chat`
    takes no credential, so the bound has to hold for an anonymous caller; real
    ids are 32-36 chars (`js/chat.js:185-190`), so no honest client trips it."""
    # Arrange: an otherwise perfectly valid chat request whose only defect is a
    # session id far past the bound. The `stub_store` fixture stands in for the
    # store and catches any write. Without the bound this request succeeds and
    # persists an ok row
    # (test_turn_persistence.py::test_non_stream_success_persists_one_ok_row),
    # so "nothing persisted" is a real observation, not a vacuous one.

    # Act
    r = await client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
            "sessionId": "x" * 200,
        },
    )

    # Assert: refused in this app's own validation shape — 400 `validation_error`
    # from the RequestValidationError handler (main.py:1266-1283), not FastAPI's
    # default 422 — and the over-long id never reached storage.
    assert r.status_code == 400
    assert r.json().get("code") == "validation_error"
    assert stub_store.calls == []


@pytest.mark.asyncio
async def test_malformed_json_400(client: AsyncClient) -> None:
    r = await client.post(
        "/api/chat",
        content=b"{not json",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400
    assert r.json().get("code") == "malformed_json"
