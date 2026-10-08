"""Characterization: every chat text turn leaves exactly one transcript row
tagged with the right status (project invariant #7)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from app.main import app
from app.messages import MsgChunk


class _BoomChain:
    """Routing chain whose non-streaming call raises a plain (non-rate-limit)
    error, exercising main.py's generic-exception persistence branch."""

    async def ainvoke(self, _payload):
        raise RuntimeError("boom")


class _SlowChain:
    """Routing chain whose non-streaming call sleeps past a tiny provider
    timeout, exercising main.py's timeout persistence branch."""

    def __init__(self, sleep_s: float) -> None:
        self.sleep_s = sleep_s

    async def ainvoke(self, _payload):
        await asyncio.sleep(self.sleep_s)
        return "late"


class _StreamChain:
    """Routing chain whose streaming call yields a couple of chunks then
    completes cleanly, exercising main.py's _chat_stream success path
    (`chain.astream({...})` iterated via __anext__)."""

    def astream(self, _payload):
        async def gen():
            yield MsgChunk(text="hi")
            yield MsgChunk(text=" there")

        return gen()


class _MidStreamBoomChain:
    """Routing chain whose streaming call yields one chunk then raises a plain
    (non-rate-limit) error mid-stream, exercising main.py's _chat_stream
    error-persistence branch after at least one chunk has flushed."""

    def astream(self, _payload):
        async def gen():
            yield MsgChunk(text="hi")
            raise RuntimeError("mid-stream boom")

        return gen()


class _StallStreamChain:
    """Routing chain whose streaming call stalls (sleeps) past a tiny provider
    timeout before the first chunk, exercising main.py's _chat_stream per-chunk
    `asyncio.wait_for` deadline → timeout-persistence branch."""

    def __init__(self, sleep_s: float) -> None:
        self.sleep_s = sleep_s

    def astream(self, _payload):
        async def gen():
            await asyncio.sleep(self.sleep_s)
            yield MsgChunk(text="late")

        return gen()


# The one well-formed voice tool call, shared by the two tests below so that
# neither restates it (and so the whole-entry equality compares against the
# exact object posted). Keys are the full known set the sanitizer may keep.
WELL_FORMED_TOOL_CALL = {
    "id": "call-1",
    "name": "navigate_to_section",
    "args": {"section": "experience"},
    "response": {"ok": True},
}


async def _post_well_formed_voice_beacon(client, stub) -> dict:
    """Post ONE well-formed voice beacon and return the single turn the store
    received. Values are chosen to fail loudly under a coercion or
    swapped-assignment bug: a non-zero duration, audio counts that differ from
    each other and from the duration, `interrupted` TRUE (a False would survive
    a drop-the-field bug unnoticed), and a non-default intent."""
    await client.post(
        "/api/live/transcript",
        json={
            "sessionId": "voice-telemetry",
            "userText": "show me your experience",
            "assistantText": "Taking you there now.",
            "transport": "direct_google",
            "intent": "warm",
            "turnDurationMs": 7321,
            "audioInBytes": 48_000,
            "audioOutBytes": 96_512,
            "interrupted": True,
            "toolCalls": [WELL_FORMED_TOOL_CALL],
        },
    )
    assert len(stub.calls) == 1
    return stub.calls[0]["turn"]


@pytest.mark.asyncio
async def test_non_stream_error_persists_one_error_row(client, stub_store) -> None:
    # Arrange: a fake chain that raises a plain error; `stub_store` captures rows.
    chain_before = app.state.chain
    provider_error_before = app.state.provider_error

    app.state.chain = _BoomChain()
    app.state.provider_error = None

    try:
        # Act: a minimal valid non-streaming chat request.
        await client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "stream": False,
            },
        )
    finally:
        app.state.chain = chain_before
        app.state.provider_error = provider_error_before

    # Assert: exactly one row, tagged error, with populated error fields.
    assert len(stub_store.calls) == 1
    turn = stub_store.calls[0]["turn"]
    assert turn["status"] == "error"
    assert turn["errorCode"]
    assert isinstance(turn["errorMessage"], str)
    assert turn["errorMessage"]


@pytest.mark.asyncio
async def test_non_stream_timeout_persists_one_timeout_row(client, stub_store) -> None:
    # Arrange: a fake chain that sleeps past a tiny provider timeout.
    chain_before = app.state.chain
    provider_error_before = app.state.provider_error
    timeout_before = app.state.provider_timeout_seconds

    app.state.chain = _SlowChain(sleep_s=0.05)
    app.state.provider_error = None
    app.state.provider_timeout_seconds = 0.01

    try:
        # Act: a minimal valid non-streaming chat request that trips the timeout.
        await client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "stream": False,
            },
        )
    finally:
        app.state.chain = chain_before
        app.state.provider_error = provider_error_before
        app.state.provider_timeout_seconds = timeout_before

    # Assert: exactly one row, tagged timeout, with the stable upstream_timeout code.
    assert len(stub_store.calls) == 1
    turn = stub_store.calls[0]["turn"]
    assert turn["status"] == "timeout"
    assert turn["errorCode"] == "upstream_timeout"


@pytest.mark.asyncio
async def test_streaming_success_persists_one_ok_row(client, stub_store) -> None:
    # Arrange: a fake chain whose astream yields chunks then completes cleanly.
    chain_before = app.state.chain
    provider_error_before = app.state.provider_error

    app.state.chain = _StreamChain()
    app.state.provider_error = None

    try:
        # Act: a minimal valid STREAMING chat request; fully drain the SSE body so
        # the generator runs to completion and the terminal persist fires.
        resp = await client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            },
        )
        await resp.aread()
    finally:
        app.state.chain = chain_before
        app.state.provider_error = provider_error_before

    # Assert (on the persisted row per ADR-0002, NOT the SSE bytes): exactly one
    # row, tagged ok, and flagged as a streamed turn.
    assert len(stub_store.calls) == 1
    turn = stub_store.calls[0]["turn"]
    assert turn["status"] == "ok"
    assert turn["stream"] is True


@pytest.mark.asyncio
async def test_streaming_midstream_error_persists_one_error_row(
    client, stub_store
) -> None:
    # Arrange: a fake chain whose astream yields one chunk then raises a plain
    # (non-rate-limit) error mid-stream.
    chain_before = app.state.chain
    provider_error_before = app.state.provider_error

    app.state.chain = _MidStreamBoomChain()
    app.state.provider_error = None

    try:
        # Act: a minimal valid STREAMING chat request; fully drain the SSE body so
        # the generator runs to the mid-stream raise and the terminal persist fires.
        resp = await client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            },
        )
        await resp.aread()
    finally:
        app.state.chain = chain_before
        app.state.provider_error = provider_error_before

    # Assert (on the persisted row per ADR-0002, NOT the SSE bytes): the failed
    # streaming attempt still leaves exactly one admin-visible row, tagged error,
    # with a populated errorCode.
    assert len(stub_store.calls) == 1
    turn = stub_store.calls[0]["turn"]
    assert turn["status"] == "error"
    assert turn["errorCode"]


@pytest.mark.asyncio
async def test_streaming_timeout_persists_one_timeout_row(client, stub_store) -> None:
    # Arrange: a fake chain whose astream stalls past a tiny provider timeout
    # before the first chunk.
    chain_before = app.state.chain
    provider_error_before = app.state.provider_error
    timeout_before = app.state.provider_timeout_seconds

    app.state.provider_timeout_seconds = 0.01
    app.state.chain = _StallStreamChain(0.05)
    app.state.provider_error = None

    try:
        # Act: a minimal valid STREAMING chat request; fully drain the SSE body so
        # the generator runs past the deadline and the terminal persist fires.
        resp = await client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            },
        )
        await resp.aread()
    finally:
        app.state.chain = chain_before
        app.state.provider_error = provider_error_before
        app.state.provider_timeout_seconds = timeout_before

    # Assert (on the persisted row per ADR-0002, NOT the SSE bytes): the stalled
    # streaming attempt leaves exactly one admin-visible row, tagged timeout, with
    # the stable upstream_timeout code.
    assert len(stub_store.calls) == 1
    turn = stub_store.calls[0]["turn"]
    assert turn["status"] == "timeout"
    assert turn["errorCode"] == "upstream_timeout"


@pytest.mark.asyncio
async def test_public_transcript_post_persists_a_bounded_turn(
    client, stub_store
) -> None:
    """Invariant #17: the PUBLIC, unauthenticated /api/live/transcript sink bounds
    what reaches persistence. Asserted on the row the store actually receives —
    not on which helper the route called."""
    # Arrange: the route takes no credential, so post what a hostile caller can:
    # a transport label nobody mints, and a flood of tool calls whose FIRST entry
    # is itself hostile — a 500-char name, a ~50 KB payload, and an invented key.
    # Every bound is load-bearing downstream: aws/src/contact-admin.js:337 counts
    # the admin rollup's `transports` BY the persisted value, and :373 keys the
    # tool histogram BY the persisted `name`. The flood alone only exercises the
    # count cap, which is why one entry carries the per-entry attack too.
    hostile_entry = {
        "name": "x" * 500,
        "args": {"blob": "y" * 50_000},
        "exfiltrated": "a key no producer sends and no consumer reads",
    }
    flood = [hostile_entry] + [{"name": f"tool-{i}"} for i in range(499)]

    # Act: one fire-and-forget beacon, exactly as js/chat-live.js sends it.
    await client.post(
        "/api/live/transcript",
        json={
            "sessionId": "hostile-probe",
            "userText": "hi",
            "assistantText": "hello",
            "transport": "attacker-minted",
            "toolCalls": flood,
        },
    )

    # Assert: the turn still persists (clamp, don't reject — the beacon never
    # reads the response), but bounded in count, key space, and per-entry size.
    assert len(stub_store.calls) == 1
    turn = stub_store.calls[0]["turn"]
    assert turn["transport"] in {"live", "relay", "direct_google"}
    assert len(turn["toolCalls"]) == 10
    # The kept window is the FRONT of the posted list: the tenth entry posted is
    # the last one persisted. A tail window (`value[-10:]`) also keeps ten, but
    # not these ten — the caller does not get to choose which ten survive by
    # padding the head.
    assert turn["toolCalls"][-1]["name"] == "tool-8"
    # ...and the entry that was hostile is bounded per-entry, not merely counted:
    # the invented key is stripped and the 500-char name is cut to the 60-char
    # bound, so a caller cannot mint a giant permanent histogram key.
    hostile_kept = turn["toolCalls"][0]
    assert set(hostile_kept) <= {"id", "name", "args", "response"}
    assert len(hostile_kept["name"]) <= 60


@pytest.mark.asyncio
async def test_well_formed_voice_turn_persists_its_telemetry_untouched(
    client, stub_store
) -> None:
    """Invariant #7: main.py's voice telemetry coercion carries every posted
    field through to persistence with its posted value. Nothing to do with the
    M0 sanitizer — the tool-call half of this beacon is asserted separately, so
    a break in either names itself."""
    turn = await _post_well_formed_voice_beacon(client, stub_store)

    # Assert: every telemetry field reaches persistence with its posted value.
    assert turn["intent"] == "warm"
    assert turn["turnDurationMs"] == 7321
    assert turn["audioInBytes"] == 48_000
    assert turn["audioOutBytes"] == 96_512
    # `is True`, not `== True`: `== True` cannot distinguish a DynamoDB BOOL from
    # an N, so it would pass on a 1 that the admin panel renders wrongly.
    assert turn["interrupted"] is True


@pytest.mark.asyncio
async def test_well_formed_tool_call_survives_the_sanitizer_intact(
    client, stub_store
) -> None:
    """Invariant #17, the don't-break-the-honest-case half: clamping a HOSTILE
    payload (see test_public_transcript_post_persists_a_bounded_turn) must not
    cost a LEGITIMATE voice turn any part of its tool call. Characterization —
    green on arrival, and its whole value is that it stays green across the
    wiring change."""
    turn = await _post_well_formed_voice_beacon(client, stub_store)

    # Assert: the well-formed tool call survives intact — every key it was sent
    # with, `response` and `args` included. Whole-entry equality, not a subset
    # check: a sanitizer that silently added or shaved a key would pass the
    # looser form. This is the "existing voice telemetry unaffected" bar.
    entry, = turn["toolCalls"]
    assert entry == WELL_FORMED_TOOL_CALL


@pytest.mark.asyncio
async def test_caller_cannot_choose_the_timestamp_the_turn_is_stored_under(
    client, stub_store
) -> None:
    """Invariant #17's last clause — *no caller-supplied value becomes a storage
    key* — applied to the one field M0 never touched (ADR-0020 §5 A1). The
    persisted timestamp is the server's receive time, not the caller's: what
    arrives on the wire is ignored. `createdAt` is the RANGE key of the
    `byCreatedAt` GSI (`aws/template.yaml:161-166`) that the admin list queries
    `ScanIndexForward: false` (`aws/src/contact-admin.js:481`), and it is written
    `if_not_exists` (`transcript_store.py:83`), so one anonymous POST that owns
    it pins itself to page 1 of the owner's transcript list permanently."""
    # Arrange: a value no clock can produce, chosen because 'z' sorts above every
    # digit — it outranks every real ISO-8601 instant lexicographically. (Strict
    # ISO-8601 validation would NOT close this: '9999-12-31T23:59:59Z' is valid
    # and sorts first too.) Bracket the request with the test's own clock so
    # "the server's time" is pinned as a real window, with no clock seam.
    hostile_captured_at = "zzzzzzzzzzzzzzzz"
    before = datetime.now(timezone.utc)

    # Act: one fire-and-forget beacon, exactly as js/chat-live.js:671-702 sends
    # it, carrying the hostile sort key.
    response = await client.post(
        "/api/live/transcript",
        json={
            "sessionId": "sort-key-probe",
            "userText": "hi",
            "assistantText": "hello",
            "capturedAt": hostile_captured_at,
        },
    )
    after = datetime.now(timezone.utc)

    # Assert: the turn still persists — the field is IGNORED, not rejected. The
    # beacon never reads the response, so a 400 would silently lose a real turn,
    # and ignoring the field is what lets this ship with no frontend deploy.
    assert response.status_code == 204
    assert len(stub_store.calls) == 1
    stored_under = stub_store.calls[0]["created_at"]
    rendered_at = stub_store.calls[0]["turn"]["capturedAt"]

    # ...and the timestamps it persists are the server's own. Not merely
    # "different from the hostile string": a sink that mapped junk to some other
    # fixed value would still hand the caller its rank, so both the GSI sort key
    # and the value the admin panel renders (`js/admin.js:649`, and the day
    # bucket in `aws/src/common/daily-report.js:68`) are pinned to a parseable
    # ISO-8601 instant inside the window the request actually happened in.
    assert stored_under != hostile_captured_at
    assert before <= datetime.fromisoformat(stored_under) <= after
    assert rendered_at != hostile_captured_at
    assert before <= datetime.fromisoformat(rendered_at) <= after


@pytest.mark.asyncio
async def test_public_transcript_post_bounds_persisted_text_in_bytes_not_code_points(
    client, stub_store
) -> None:
    """Invariant #17 / ADR-0020 §5 A2, at the SINK: what the public
    `/api/live/transcript` route persists is bounded in UTF-8 **bytes** — the
    unit DynamoDB charges — `userText` at 8 000 and `assistantText` at 16 000.

    `clamp_text` already truncates on a byte budget at a code-point boundary and
    is pinned at helper level (`test_turn_input.py::
    test_clamped_text_fits_the_byte_budget_without_splitting_a_character`).
    Nothing calls it: the two `.strip()` expressions in `live_transcript`
    (`main.py:1207-1208`; ADR-0020 §5.13 clears them as 1208-1209) still hand the
    raw text to `persist_turn`, so a correct helper proves nothing about the
    sink. Hence route level, asserted on the row the store actually receives —
    "the sanitizer is right but unwired" is precisely the gap, and a per-FIELD
    budget can only be observed where the fields are.

    Why it matters: a maximal turn measures ~116 KB, so the 4th write into a
    session's single DynamoDB item is the one the 400 KB item limit refuses,
    after which `transcript_store.py:140-144` swallows the failure and the owner
    silently loses every later turn of that session. (A2 takes the worst case to
    ~44 KB: necessary, not sufficient — the per-item bound is A3.2.)
    """
    # Arrange: text that is LEGAL to the outer guard and over the inner one. The
    # Pydantic `max_length` at `main.py:172-173` counts CODE POINTS, so the
    # fixture has to DEFEAT that bound rather than trip it — astral-plane
    # characters are 4 UTF-8 bytes each, so 3 000 of them are 3 000 code points
    # (well inside the 8 000 cap) yet 12 000 bytes (half again over the 8 000
    # byte budget); the assistant side is 5 000 code points / 20 000 bytes
    # against its own 16 000-byte budget.
    #
    # The single leading ASCII character is load-bearing, not decoration: it
    # shifts every 4-byte character off a multiple-of-4 offset, so BOTH budgets
    # fall inside a character. Without it, 8 000 and 16 000 are exact character
    # boundaries and nothing here could tell a clamp that drops the severed tail
    # from one that keeps half a character (or a U+FFFD stand-in for it). The
    # two fields also start with different letters, so a swapped assignment
    # fails the prefix assertions below instead of passing them.
    spoken = 'a' + '🛸🪐🌍🚀' * 750
    answered = 'b' + '🛸🪐🌍🚀' * 1250
    assert len(spoken) == 3_001                     # code points — Pydantic's unit
    assert len(spoken.encode('utf-8')) == 12_001    # bytes — DynamoDB's unit
    assert len(answered) == 5_001
    assert len(answered.encode('utf-8')) == 20_001

    # Act: one fire-and-forget beacon, exactly as js/chat-live.js:671-702 sends it.
    await client.post(
        "/api/live/transcript",
        json={
            "sessionId": "byte-budget-probe",
            "userText": spoken,
            "assistantText": answered,
        },
    )

    # Assert: the turn still persists (clamp, don't reject — the beacon never
    # reads the response), and each free-text field is charged within its own
    # byte budget.
    assert len(stub_store.calls) == 1
    turn = stub_store.calls[0]["turn"]
    stored_user = turn["requestMessages"][0]["content"]
    stored_reply = turn["reply"]
    assert len(stored_user.encode('utf-8')) <= 8_000
    assert len(stored_reply.encode('utf-8')) <= 16_000

    # ...and what lands in the row is still whole text: a prefix of what was
    # posted (nothing invented, reordered, or replaced by U+FFFD) that
    # round-trips through UTF-8 (no half character or lone surrogate), and
    # non-empty — truncated, not deleted. The truncation index is deliberately
    # not asserted; that it truncates rather than drops the field is.
    assert spoken.startswith(stored_user)
    assert answered.startswith(stored_reply)
    assert stored_user.encode('utf-8').decode('utf-8') == stored_user
    assert stored_reply.encode('utf-8').decode('utf-8') == stored_reply
    assert stored_user
    assert stored_reply

    # ...and the two budgets are DIFFERENT, which one clamp applied twice would
    # not be: the reply keeps more than the user text's entire 8 000-byte
    # budget. A lower bound, not a length — it fences the copy-paste that passes
    # the `userText` budget to both call sites.
    assert len(stored_reply.encode('utf-8')) > 8_000


@pytest.mark.asyncio
async def test_non_stream_success_persists_one_ok_row(client, stub_store) -> None:
    # Arrange: leave the real mock chain in place so the non-streaming ainvoke
    # path succeeds (mirrors test_transcript_store's non-error setup); the
    # `stub_store` fixture captures rows. This is the non-stream analogue of S3.
    provider_error_before = app.state.provider_error
    app.state.provider_error = None

    try:
        # Act: a minimal valid NON-streaming chat request that completes cleanly.
        resp = await client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "stream": False,
            },
        )
    finally:
        app.state.provider_error = provider_error_before

    # Assert (on the persisted row, not just the HTTP code): exactly one row,
    # tagged ok, and flagged as a non-streamed turn.
    assert resp.status_code == 200
    assert len(stub_store.calls) == 1
    turn = stub_store.calls[0]["turn"]
    assert turn["status"] == "ok"
    assert turn["stream"] is False
