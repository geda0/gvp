from __future__ import annotations

import pytest

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
    store = TranscriptStore('ChatTranscripts', ttl_days=30)
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


@pytest.mark.asyncio
async def test_persist_turn_increments_success_counter() -> None:
    """writes_succeeded must reflect actual DynamoDB writes, not silent no-ops."""
    table = FakeTable()
    store = TranscriptStore('ChatTranscripts', ttl_days=30)
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
    store = TranscriptStore('ChatTranscripts', ttl_days=30)
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
