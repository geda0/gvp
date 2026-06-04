"""Characterization: every chat text turn leaves exactly one transcript row
tagged with the right status (project invariant #7)."""

from __future__ import annotations

import asyncio

import pytest
from langchain_core.messages import AIMessageChunk

from app.main import app


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
            yield AIMessageChunk(content="hi")
            yield AIMessageChunk(content=" there")

        return gen()


class _MidStreamBoomChain:
    """Routing chain whose streaming call yields one chunk then raises a plain
    (non-rate-limit) error mid-stream, exercising main.py's _chat_stream
    error-persistence branch after at least one chunk has flushed."""

    def astream(self, _payload):
        async def gen():
            yield AIMessageChunk(content="hi")
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
            yield AIMessageChunk(content="late")

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
