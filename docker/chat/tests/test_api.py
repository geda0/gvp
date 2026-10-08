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
async def test_over_long_session_id_on_the_transcript_sink_is_rejected_and_persists_nothing(
    client: AsyncClient,
    stub_store,
) -> None:
    """The same reject-the-identity half of invariant #17, on the OTHER public
    sink — `POST /api/live/transcript` (ADR-0020 §5 A5). This is the sink whose
    own `sessionId` bound (`LiveTranscriptTurn`, `main.py:171`) nothing pinned:
    the sibling case above covers `ChatRequest`, a different request model on a
    different route, so deleting the transcript model's bound left the suite
    green. Both routes take no credential, and both land `sessionId` as the
    DynamoDB partition key `id` (`transcript_store.py:123`), so an identity that
    does not fit must be refused here too — truncating it would merge every
    caller sharing a 128-char prefix into one session's row.
    """
    # Arrange: an otherwise well-formed voice beacon whose only defect is a
    # session id far past the bound. The identical beacon WITH a short id
    # persists exactly one turn
    # (test_turn_persistence.py::test_public_transcript_post_persists_a_bounded_turn),
    # so "nothing persisted" is a real observation, not a vacuous one.

    # Act
    r = await client.post(
        "/api/live/transcript",
        json={
            "sessionId": "x" * 200,
            "userText": "hi",
            "assistantText": "hello",
        },
    )

    # Assert: refused in this app's own validation shape — 400 `validation_error`
    # from the RequestValidationError handler (main.py:1268-1285), not FastAPI's
    # default 422 — and the over-long id never reached storage. Note this is the
    # one place the sink REJECTS rather than clamps: the beacon is
    # fire-and-forget and never reads the response, which is exactly why the
    # bound has to be asserted on the store, not on the status code alone.
    assert r.status_code == 400
    assert r.json().get("code") == "validation_error"
    assert stub_store.calls == []


@pytest.mark.asyncio
async def test_session_id_shaped_like_an_alert_log_line_is_rejected_everywhere_and_persists_nothing(
    client: AsyncClient,
    stub_store,
) -> None:
    """ADR-0022 §30.4, DECISION 9. `sessionId` is echoed into the operational
    log stream: `main.py:1046` logs it verbatim, and `transcript_store.py:217,223`
    build the alert summary that `alerts.py:97` interpolates into the Tier-1
    `CHAT_ALERT` line the §29.4 metric filter watches. After §29 that line is the
    PRIMARY record of a degradation event on Lambda, so an anonymous caller who
    chooses the text inside it can fire the alarm on demand, or forge the
    `event=`/`env=` fields of a REAL alert so a stage transcript failure reads as
    a prod upstream outage. The identity is therefore refused at the one point
    every log site shares — the field itself — rather than sanitized per site.
    All three request models own a `sessionId` (`ChatRequest` main.py:163,
    `LiveSessionRequest` :167, `LiveTranscriptTurn` :171) and all three routes
    are unauthenticated, so all three are asserted here; the test lives in
    test_api.py because one test has to observe `/api/live/session` too.
    """
    # Arrange: the forged id is 26 chars, so `max_length=128` admits it today —
    # the two over-long pins above cannot see this attack. The minted id is the
    # control: it is what the app's own `createSessionId()` produces
    # (`crypto.randomUUID()`, js/chat.js:186-191), so a bound that rejects it has
    # broken every real client, and this test cannot pass by rejecting strings
    # indiscriminately.
    forged_id = "CHAT_ALERT event=x env=prod"
    minted_id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

    # Act + Assert, route by route. Asserted inline rather than after all three
    # posts so a failing run stops at the first route instead of reaching the
    # live-session token mint. Refusal is in this app's own validation shape —
    # 400 `validation_error` from the RequestValidationError handler
    # (main.py:1268-1285), not FastAPI's default 422 — matching the over-long
    # pins above.
    r_chat = await client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
            "sessionId": forged_id,
        },
    )
    assert r_chat.status_code == 400
    assert r_chat.json().get("code") == "validation_error"

    r_sink = await client.post(
        "/api/live/transcript",
        json={
            "sessionId": forged_id,
            "userText": "hi",
            "assistantText": "hello",
        },
    )
    assert r_sink.status_code == 400
    assert r_sink.json().get("code") == "validation_error"

    r_session = await client.post(
        "/api/live/session",
        json={"sessionId": forged_id},
    )
    assert r_session.status_code == 400
    assert r_session.json().get("code") == "validation_error"

    # Assert: the forged identity reached no storage — the same observation the
    # over-long pins make, through the same recording stub.
    assert stub_store.calls == []

    # Assert the control on that same stub, so "persists nothing" above is a real
    # observation and not vacuous: the id the app actually mints is still served
    # and still persists its turn under that id.
    r_minted = await client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
            "sessionId": minted_id,
        },
    )
    assert r_minted.status_code == 200
    assert len(stub_store.calls) == 1
    assert stub_store.calls[0]["session_id"] == minted_id


@pytest.mark.asyncio
async def test_an_empty_session_id_is_rejected_while_an_absent_one_still_succeeds(
    client: AsyncClient,
    stub_store,
) -> None:
    """The deliberate behaviour change of ADR-0022 §30.4, DECISION 9, pinned in
    both directions because only one of them is a tightening.

    `""` used to be accepted — it is a `str`, and `max_length` only bounds the
    top end. An empty identity is not an identity: it lands as the DynamoDB
    partition key `id` (`transcript_store.py:123`), so every anonymous caller
    sending one collides into a single row, and downstream it is
    indistinguishable from "no id at all". It is now a 400.

    The second half is what keeps that from breaking every honest client: a
    caller that omits the field — `str | None`, `default=None`, and most callers
    never set it — is not claiming an identity and must still be served. Pinning
    only the rejection half would let a bound that ALSO rejected null review as
    correct, and that would 400 the majority of real traffic.
    """
    # Act: the empty identity, on the busiest public route.
    r_empty = await client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
            "sessionId": "",
        },
    )

    # Assert: refused, and nothing was persisted under the empty key.
    assert r_empty.status_code == 400
    assert r_empty.json().get("code") == "validation_error"
    assert stub_store.calls == []

    # Act: the identical request with an explicitly absent identity.
    r_null = await client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
            "sessionId": None,
        },
    )

    # Assert: still served, still persisted, and the absent id is passed through
    # as absent rather than rewritten into a storage key of its own.
    assert r_null.status_code == 200
    assert len(stub_store.calls) == 1
    assert stub_store.calls[0]["session_id"] is None


@pytest.mark.asyncio
async def test_malformed_json_400(client: AsyncClient) -> None:
    r = await client.post(
        "/api/chat",
        content=b"{not json",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400
    assert r.json().get("code") == "malformed_json"
