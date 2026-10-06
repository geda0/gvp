from __future__ import annotations

import asyncio

import pytest

from app import alerts
from app.main import app
from app.transcript_store import TranscriptStore, build_transcript_store


class StubStore:
    def __init__(self) -> None:
        self.calls = []

    async def persist_turn(self, **kwargs) -> None:
        self.calls.append(kwargs)


class FakeTable:
    def __init__(self) -> None:
        self.calls = []

    def update_item(self, **kwargs) -> None:
        self.calls.append(kwargs)


class RaisingTable:
    """DynamoDB table stand-in whose UpdateItem always fails."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    def update_item(self, **kwargs) -> None:
        raise self._error


class ConditionalCheckFailedException(Exception):
    """Stands in for boto3's error-factory exception when DynamoDB refuses a
    conditional write — the "this session is full" case. Carries BOTH the real
    class name and the real error code so the store may recognise it either
    way."""

    def __init__(self) -> None:
        super().__init__(
            'An error occurred (ConditionalCheckFailedException) when calling '
            'the UpdateItem operation: The conditional request failed'
        )
        self.response = {'Error': {'Code': 'ConditionalCheckFailedException'}}


@pytest.mark.asyncio
async def test_chat_persists_transcript_turn(client) -> None:
    chain_before = app.state.chain
    store_before = app.state.transcript_store
    provider_error_before = app.state.provider_error
    model_before = app.state.model_id
    provider_before = app.state.provider_name
    prompt_version_before = app.state.prompt_version

    stub = StubStore()
    app.state.transcript_store = stub
    app.state.provider_error = None
    app.state.model_id = 'mock-portfolio'
    app.state.provider_name = 'mock'
    app.state.prompt_version = 'test-v1'

    try:
        response = await client.post(
            '/api/chat',
            json={
                'sessionId': 'session-abc',
                'messages': [{'role': 'user', 'content': 'Tell me about TBM'}],
            },
        )
    finally:
        app.state.chain = chain_before
        app.state.transcript_store = store_before
        app.state.provider_error = provider_error_before
        app.state.model_id = model_before
        app.state.provider_name = provider_before
        app.state.prompt_version = prompt_version_before

    assert response.status_code == 200
    assert len(stub.calls) == 1
    payload = stub.calls[0]
    assert payload['session_id'] == 'session-abc'
    assert payload['prompt_version'] == 'test-v1'
    assert payload['turn']['promptVersion'] == 'test-v1'
    assert payload['model'] == 'mock-portfolio'
    assert isinstance(payload['turn'].get('requestMessages'), list)
    assert 'retrieval' in payload['turn']
    assert 'toolCalls' in payload['turn']
    assert set(payload['flags'].keys()) >= {
        'no_retrieval_match',
        'negative_feedback',
        'possible_refusal',
        'long_conversation',
        'tool_offered_not_taken',
    }


def test_build_transcript_store_requires_table(monkeypatch) -> None:
    monkeypatch.delenv('CHAT_TRANSCRIPTS_TABLE', raising=False)
    assert build_transcript_store() is None


@pytest.mark.asyncio
async def test_transcript_store_updates_defaults() -> None:
    table = FakeTable()
    store = TranscriptStore('ChatTranscripts')
    store._table = table

    await store.persist_turn(
        session_id='session-xyz',
        created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1',
        provider='gemini',
        model='gemini-3.1-flash-lite',
        turn={'reply': 'ok'},
        flags={'no_retrieval_match': True},
    )

    assert len(table.calls) == 1
    update = table.calls[0]
    assert update['Key'] == {'id': 'session-xyz'}
    assert 'UpdateExpression' in update
    values = update['ExpressionAttributeValues']
    assert values[':listPk'] == 'CHAT_TRANSCRIPT'
    assert values[':reviewedDefault'] is False
    assert values[':adminNotesDefault'] == ''
    assert ':expiresAt' not in values
    assert 'expiresAt' not in update['UpdateExpression']


@pytest.mark.asyncio
async def test_persist_turn_increments_success_counter() -> None:
    """writes_succeeded must reflect actual DynamoDB writes, not silent no-ops."""
    table = FakeTable()
    store = TranscriptStore('ChatTranscripts')
    store._table = table

    await store.persist_turn(
        session_id='s1', created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1', provider='mock', model='m',
        turn={'reply': 'a'}, flags={},
    )
    s = store.stats()
    assert s['writes_attempted'] == 1
    assert s['writes_succeeded'] == 1
    assert s['writes_failed'] == 0
    assert s['last_success_at'] is not None
    assert s['last_error'] is None


@pytest.mark.asyncio
async def test_persist_turn_disabled_counts_as_failure_not_success() -> None:
    """Regression: when boto3 is missing (or _get_table returns None for any
    reason), the old code returned silently and writes_succeeded incremented
    — making the chat host falsely report persistence working while no
    DynamoDB write occurred. Now: writes_failed increments + last_error is
    populated so /ready surfaces the disabled state immediately."""
    store = TranscriptStore('ChatTranscripts')
    store._disabled = True  # simulate boto3 import failure

    await store.persist_turn(
        session_id='s1', created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1', provider='mock', model='m',
        turn={'reply': 'a'}, flags={},
    )
    s = store.stats()
    assert s['writes_attempted'] == 1
    assert s['writes_succeeded'] == 0, 'silent skip must not look like a success'
    assert s['writes_failed'] == 1
    assert s['last_error'] is not None
    assert 'disabled' in s['last_error'].lower() or 'boto3' in s['last_error'].lower()


@pytest.mark.asyncio
async def test_persist_failure_fires_alert_whose_priority_names_the_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed transcript write is announced, and its priority says WHICH
    failure (ADR-0020 A3.1). Today the error is swallowed into a `writes_failed`
    counter visible only on /ready and the gated host-status, so a broken table
    — or a session that can never accept another turn — has no symptom the owner
    would ever see. `[P1]` = writes are broken; `[P2]` = session full, expected.
    """
    # Alerts ship dark: configure with throwaway values and capture at the send
    # seam, so nothing is actually delivered. Zero cooldown so both fires land.
    monkeypatch.setenv('CHAT_ALERT_EMAIL', 'owner@example.com')
    monkeypatch.setenv('CHAT_ALERT_FROM_EMAIL', 'alerts@example.com')
    monkeypatch.setenv('RESEND_API_KEY', 'k-test')
    monkeypatch.setenv('CHAT_ALERT_COOLDOWN_SECONDS', '0')
    alerts.reset_for_tests()
    fired: list[tuple[str, str]] = []

    async def _capture(event_type: str, summary: str, detail: str) -> None:
        fired.append((event_type, summary))

    monkeypatch.setattr(alerts, '_send', _capture)

    broken = TranscriptStore('ChatTranscripts')
    broken._table = RaisingTable(RuntimeError('ProvisionedThroughputExceeded'))
    session_full = TranscriptStore('ChatTranscripts')
    session_full._table = RaisingTable(ConditionalCheckFailedException())

    # Both calls must return normally — a persist failure may never break the
    # fire-and-forget turn that triggered it.
    await broken.persist_turn(
        session_id='s-broken', created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1', provider='mock', model='m',
        turn={'reply': 'a'}, flags={},
    )
    await session_full.persist_turn(
        session_id='s-full', created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1', provider='mock', model='m',
        turn={'reply': 'b'}, flags={},
    )
    await asyncio.sleep(0)  # let the detached alert tasks run

    assert [event_type for event_type, _ in fired] == [
        'chat_transcript_write_failed',
        'chat_transcript_write_failed',
    ]
    assert '[P1]' in fired[0][1], 'writes are broken is P1'
    assert '[P2]' in fired[1][1], 'session full is expected, so P2'
