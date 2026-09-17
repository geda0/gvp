"""Characterization: every chat text turn leaves exactly one transcript row
tagged with the right status (project invariant #7)."""

from __future__ import annotations

import asyncio

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


class StubStore:
    def __init__(self) -> None:
        self.calls = []

    async def persist_turn(self, **kwargs) -> None:
        self.calls.append(kwargs)


@pytest.mark.asyncio
async def test_non_stream_error_persists_one_error_row(client) -> None:
    # Arrange: a fake chain that raises a plain error + a stub store to capture rows.
    chain_before = app.state.chain
    store_before = app.state.transcript_store
    provider_error_before = app.state.provider_error

    stub = StubStore()
    app.state.chain = _BoomChain()
    app.state.transcript_store = stub
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
        app.state.transcript_store = store_before
        app.state.provider_error = provider_error_before

    # Assert: exactly one row, tagged error, with populated error fields.
    assert len(stub.calls) == 1
    turn = stub.calls[0]["turn"]
    assert turn["status"] == "error"
    assert turn["errorCode"]
    assert isinstance(turn["errorMessage"], str)
    assert turn["errorMessage"]


@pytest.mark.asyncio
async def test_non_stream_timeout_persists_one_timeout_row(client) -> None:
    # Arrange: a fake chain that sleeps past a tiny provider timeout + a stub store.
    chain_before = app.state.chain
    store_before = app.state.transcript_store
    provider_error_before = app.state.provider_error
    timeout_before = app.state.provider_timeout_seconds

    stub = StubStore()
    app.state.chain = _SlowChain(sleep_s=0.05)
    app.state.transcript_store = stub
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
        app.state.transcript_store = store_before
        app.state.provider_error = provider_error_before
        app.state.provider_timeout_seconds = timeout_before

    # Assert: exactly one row, tagged timeout, with the stable upstream_timeout code.
    assert len(stub.calls) == 1
    turn = stub.calls[0]["turn"]
    assert turn["status"] == "timeout"
    assert turn["errorCode"] == "upstream_timeout"


@pytest.mark.asyncio
async def test_streaming_success_persists_one_ok_row(client) -> None:
    # Arrange: a fake chain whose astream yields chunks then completes + a stub store.
    chain_before = app.state.chain
    store_before = app.state.transcript_store
    provider_error_before = app.state.provider_error

    stub = StubStore()
    app.state.chain = _StreamChain()
    app.state.transcript_store = stub
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
        app.state.transcript_store = store_before
        app.state.provider_error = provider_error_before

    # Assert (on the persisted row per ADR-0002, NOT the SSE bytes): exactly one
    # row, tagged ok, and flagged as a streamed turn.
    assert len(stub.calls) == 1
    turn = stub.calls[0]["turn"]
    assert turn["status"] == "ok"
    assert turn["stream"] is True


@pytest.mark.asyncio
async def test_streaming_midstream_error_persists_one_error_row(client) -> None:
    # Arrange: a fake chain whose astream yields one chunk then raises a plain
    # (non-rate-limit) error mid-stream + a stub store to capture rows.
    chain_before = app.state.chain
    store_before = app.state.transcript_store
    provider_error_before = app.state.provider_error

    stub = StubStore()
    app.state.chain = _MidStreamBoomChain()
    app.state.transcript_store = stub
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
        app.state.transcript_store = store_before
        app.state.provider_error = provider_error_before

    # Assert (on the persisted row per ADR-0002, NOT the SSE bytes): the failed
    # streaming attempt still leaves exactly one admin-visible row, tagged error,
    # with a populated errorCode.
    assert len(stub.calls) == 1
    turn = stub.calls[0]["turn"]
    assert turn["status"] == "error"
    assert turn["errorCode"]


@pytest.mark.asyncio
async def test_streaming_timeout_persists_one_timeout_row(client) -> None:
    # Arrange: a fake chain whose astream stalls past a tiny provider timeout
    # before the first chunk + a stub store to capture rows.
    chain_before = app.state.chain
    store_before = app.state.transcript_store
    provider_error_before = app.state.provider_error
    timeout_before = app.state.provider_timeout_seconds

    stub = StubStore()
    app.state.provider_timeout_seconds = 0.01
    app.state.chain = _StallStreamChain(0.05)
    app.state.transcript_store = stub
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
        app.state.transcript_store = store_before
        app.state.provider_error = provider_error_before
        app.state.provider_timeout_seconds = timeout_before

    # Assert (on the persisted row per ADR-0002, NOT the SSE bytes): the stalled
    # streaming attempt leaves exactly one admin-visible row, tagged timeout, with
    # the stable upstream_timeout code.
    assert len(stub.calls) == 1
    turn = stub.calls[0]["turn"]
    assert turn["status"] == "timeout"
    assert turn["errorCode"] == "upstream_timeout"


@pytest.mark.asyncio
async def test_public_transcript_post_persists_a_bounded_turn(client) -> None:
    """Invariant #17: the PUBLIC, unauthenticated /api/live/transcript sink bounds
    what reaches persistence. Asserted on the row the store actually receives —
    not on which helper the route called."""
    # Arrange: the route takes no credential, so post what a hostile caller can:
    # a flood of tool calls and a transport label nobody mints. The transport key
    # space is load-bearing downstream — aws/src/contact-admin.js:337 counts the
    # admin rollup's `transports` BY the persisted value.
    store_before = app.state.transcript_store
    stub = StubStore()
    app.state.transcript_store = stub

    try:
        # Act: one fire-and-forget beacon, exactly as js/chat-live.js sends it.
        await client.post(
            "/api/live/transcript",
            json={
                "sessionId": "hostile-probe",
                "userText": "hi",
                "assistantText": "hello",
                "transport": "attacker-minted",
                "toolCalls": [{"name": f"tool-{i}"} for i in range(500)],
            },
        )
    finally:
        app.state.transcript_store = store_before

    # Assert: the turn still persists (clamp, don't reject — the beacon never
    # reads the response), but bounded in count and key space.
    assert len(stub.calls) == 1
    turn = stub.calls[0]["turn"]
    assert len(turn["toolCalls"]) <= 10
    assert turn["transport"] in {"live", "relay", "direct_google"}


@pytest.mark.asyncio
async def test_well_formed_voice_turn_persists_its_telemetry_untouched(client) -> None:
    """The regression guard for bounding the sink: clamping a HOSTILE payload must
    not cost a LEGITIMATE voice turn any of its telemetry. Characterization —
    green on arrival, and its whole value is that it stays green across the
    wiring change."""
    # Arrange: one well-formed voice beacon. Values are chosen to fail loudly under
    # a coercion or swapped-assignment bug: a non-zero duration, audio counts that
    # differ from each other and from the duration, `interrupted` TRUE (a False
    # would survive a drop-the-field bug unnoticed), and a non-default intent.
    tool_call = {
        "id": "call-1",
        "name": "navigate_to_section",
        "args": {"section": "experience"},
        "response": {"ok": True},
    }
    store_before = app.state.transcript_store
    stub = StubStore()
    app.state.transcript_store = stub

    try:
        # Act
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
                "toolCalls": [tool_call],
            },
        )
    finally:
        app.state.transcript_store = store_before

    # Assert: every telemetry field reaches persistence with its posted value.
    assert len(stub.calls) == 1
    turn = stub.calls[0]["turn"]
    assert turn["intent"] == "warm"
    assert turn["turnDurationMs"] == 7321
    assert turn["audioInBytes"] == 48_000
    assert turn["audioOutBytes"] == 96_512
    assert "interrupted" in turn
    assert turn["interrupted"] is True
    # And the well-formed tool call survives intact — every key it was sent with,
    # `response` and `args` included. This is the "existing voice telemetry
    # unaffected" bar: sanitizing the hostile case may not shave the honest one.
    entry, = turn["toolCalls"]
    assert entry == tool_call


@pytest.mark.asyncio
async def test_non_stream_success_persists_one_ok_row(client) -> None:
    # Arrange: leave the real mock chain in place so the non-streaming ainvoke
    # path succeeds (mirrors test_transcript_store's non-error setup), and swap in
    # a stub store to capture rows. This is the non-stream analogue of S3.
    store_before = app.state.transcript_store
    provider_error_before = app.state.provider_error

    stub = StubStore()
    app.state.transcript_store = stub
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
        app.state.transcript_store = store_before
        app.state.provider_error = provider_error_before

    # Assert (on the persisted row, not just the HTTP code): exactly one row,
    # tagged ok, and flagged as a non-streamed turn.
    assert resp.status_code == 200
    assert len(stub.calls) == 1
    turn = stub.calls[0]["turn"]
    assert turn["status"] == "ok"
    assert turn["stream"] is False
