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
    """Stand-in for what DynamoDB raises when an `UpdateItem`'s
    `ConditionExpression` is false — here A3.2's `bytesStored < :budget` guard,
    i.e. a session that hit its byte budget. Deliberately carries BOTH
    recognition affordances a real botocore error has: the class **name**
    (`type(exc).__name__` — the discriminator ADR-0020 §5.13 decided on, because
    `transcript_store.py:75-78` exists precisely so the module survives boto3
    being absent, and so it may not add a `botocore.exceptions` import that can
    fail at module scope) and the `response['Error']['Code']` botocore
    populates. So the test pins the ROUTING, not the mechanism: either
    recognition strategy satisfies it.
    """

    def __init__(self) -> None:
        super().__init__(
            'An error occurred (ConditionalCheckFailedException) when calling '
            'the UpdateItem operation: The conditional request failed'
        )
        self.response = {
            'Error': {
                'Code': 'ConditionalCheckFailedException',
                'Message': 'The conditional request failed',
            }
        }


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
async def test_persist_sends_a_conditional_write_charging_the_turn_against_a_380_kib_budget() -> None:
    """ADR-0020 A3.2 — the wedge. Every turn is `list_append`ed into ONE
    DynamoDB item under a 400 KB hard limit with no `ConditionExpression` and
    no cap, so after enough turns the item no longer fits: every later write
    raises, is swallowed into `writes_failed`, and the turn is lost. The
    session is permanently wedged. A2 cut the worst-case turn to ~44 KB, which
    buys ~9 turns instead of 4 — it does not close it.

    The fix is a byte budget carried IN the item: the write charges the turn's
    own serialized size to `bytesStored` and is conditional on `bytesStored`
    still being under budget. A count cap was rejected: it cannot be both
    generous to a real conversation and sufficient against worst-case turns.

    SCOPE — this pins the WRITE, not the refusal. The refusal is DynamoDB's:
    `UpdateItem` is evaluated atomically server-side, so a failed condition
    appends nothing and increments nothing. A test for "a full session stops
    accepting turns" would have to implement a ConditionExpression evaluator
    in the fake table, and its verdict would then rest on that evaluator —
    which can be wrong in both directions (a stub that mis-parses and refuses
    too early goes green anyway; a stub that never refuses goes green against
    a store whose condition is nonsense). Any evaluator must also read the
    expression string, so simulating the refusal is MORE coupled to the exact
    expression text than asserting on it directly, while looking less so. So
    this test claims only what a unit test can see: the request issued.

    The budget is written here as a literal, deliberately NOT imported — a
    test that reads the constant it pins passes for every value of it, the
    hole A5/A6 closed for the other bounds.
    """
    table = FakeTable()
    store = TranscriptStore('ChatTranscripts')
    store._table = table

    # A ~60 KB turn. The item-level fields (SET fresh each turn, not
    # accumulated) are made bulkier still, so "the size of the turn being
    # appended" and "the size of the whole write" are ~20 KB apart and the
    # last assertion can tell them apart. Charging the whole write would
    # re-charge that scaffolding on every single turn, draining the budget
    # against bytes the item never accumulates.
    turn = {'userText': 'u', 'assistantText': 'x' * 60_000}

    await store.persist_turn(
        session_id='s-budget',
        created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1',
        provider='gemini',
        model='m' * 20_000,
        turn=turn,
        flags={},
    )

    assert len(table.calls) == 1
    update = table.calls[0]

    assert 'ConditionExpression' in update, (
        'an unconditional list_append into a 400 KB item is the wedge: the '
        'write that overflows and every write after it is refused forever'
    )
    condition = update['ConditionExpression']
    assert 'attribute_not_exists(bytesStored)' in condition, (
        "the session's first turn has no bytesStored yet — without this "
        'clause the condition is false on turn one and no session could '
        'ever start'
    )
    assert 'bytesStored < :budget' in condition

    values = update['ExpressionAttributeValues']
    assert values[':budget'] == 380 * 1024, '380 KiB = 389_120 bytes'

    assert (
        'bytesStored = if_not_exists(bytesStored, :zero) + :turnBytes'
        in update['UpdateExpression']
    ), 'the budget that is never accumulated is a budget that never trips'

    assert 60_000 <= values[':turnBytes'] <= 61_000, (
        'charge the serialized size of THIS turn (~60 KB here) — not a '
        'constant, not a count, and not the ~80 KB whole write'
    )


@pytest.mark.asyncio
async def test_broken_write_fires_an_actionable_alert(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A persist failure announces itself as `chat_transcript_write_failed`
    (ADR-0020 A3.1'), carrying what the owner needs to act: the exception class
    and the session id the write was for. Today the error is swallowed into a
    `writes_failed` counter visible only on /ready and the gated host-status, so
    a broken table has no symptom anyone would ever see.

    Priority is a static property OF the type (P1 here), not of the call site,
    so nothing about priority is pinned here. The P2 `chat_transcript_session_full`
    type arrives with A3.2, when a ConditionExpression makes that branch
    reachable — and ITS test must pass at the DEFAULT 3600s cooldown. Needing
    `CHAT_ALERT_COOLDOWN_SECONDS='0'` to see both fires would mean the two types
    have been collapsed back into one shared throttle bucket, which is the
    masking bug this amendment exists to prevent.
    """
    # Alerts ship dark: configure with throwaway values and capture at the send
    # seam, so nothing is delivered. No cooldown override — one fire after a
    # reset must get through at the production default.
    monkeypatch.setenv('CHAT_ALERT_EMAIL', 'owner@example.com')
    monkeypatch.setenv('CHAT_ALERT_FROM_EMAIL', 'alerts@example.com')
    monkeypatch.setenv('RESEND_API_KEY', 'k-test')
    alerts.reset_for_tests()
    fired: list[tuple[str, str, str]] = []

    async def _capture(event_type: str, summary: str, detail: str) -> None:
        fired.append((event_type, summary, detail))

    monkeypatch.setattr(alerts, '_send', _capture)

    store = TranscriptStore('ChatTranscripts')
    store._table = RaisingTable(RuntimeError('ProvisionedThroughputExceeded'))

    # Must return normally: a persist failure may never break the fire-and-forget
    # turn that triggered it.
    await store.persist_turn(
        session_id='s-broken', created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1', provider='mock', model='m',
        turn={'reply': 'a'}, flags={},
    )
    await asyncio.sleep(0)  # let the detached alert task run

    assert [event_type for event_type, _, _ in fired] == [
        'chat_transcript_write_failed'
    ]
    detail = fired[0][2]
    assert 'RuntimeError' in detail, 'the alert must name what broke'
    assert 's-broken' in detail, 'the alert must name the session it lost'
    # The counter still moves: the alert is additional to the swallow, not a
    # replacement for it.
    assert store.stats()['writes_failed'] == 1


@pytest.mark.asyncio
async def test_a_full_session_announces_itself_as_session_full_while_a_broken_write_still_announces_broken_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ADR-0020 §5.13 (A3.1'). A3.2's `ConditionExpression` made the
    `ConditionalCheckFailedException` branch reachable in production for the
    first time, and `persist_turn` funnels EVERY exception into one
    `chat_transcript_write_failed` — the P1 "writes are broken" page. So a
    routine full session now wakes the owner for an outage that isn't one.

    Per §5.13's table, the two conditions are two event TYPES, because
    `alerts.py:65-72` throttles per type and knows nothing about priority:
      * `chat_transcript_write_failed` (P1) — any persist exception that is NOT
        the budget condition: *writes are broken*.
      * `chat_transcript_session_full` (P2) — ONLY the budget condition:
        *one session hit its byte budget; writes are healthy*.

    BOTH halves are asserted here on purpose. The session-full half alone is
    satisfied by renaming the existing fire unconditionally, which would delete
    the P1 outage signal outright.

    And the cooldown is deliberately left at the PRODUCTION DEFAULT (3600s —
    the env override is removed, not zeroed). That is what makes this a test of
    *independent throttle buckets* rather than of two string literals: the
    benign P2 fires FIRST, which is the exact shape of the masking bug §5.13
    exists to prevent. Under one shared type it owns the bucket for the hour and
    the outage below is silently swallowed, so `fired` holds one entry instead of
    two. If this test ever needs `CHAT_ALERT_COOLDOWN_SECONDS='0'` to pass, the
    types have collapsed back into one bucket and the amendment has been undone.
    """
    # Alerts ship dark: configure with throwaway values and capture at the send
    # seam, so nothing is delivered.
    monkeypatch.setenv('CHAT_ALERT_EMAIL', 'owner@example.com')
    monkeypatch.setenv('CHAT_ALERT_FROM_EMAIL', 'alerts@example.com')
    monkeypatch.setenv('RESEND_API_KEY', 'k-test')
    monkeypatch.delenv('CHAT_ALERT_COOLDOWN_SECONDS', raising=False)
    alerts.reset_for_tests()
    fired: list[tuple[str, str, str]] = []

    async def _capture(event_type: str, summary: str, detail: str) -> None:
        fired.append((event_type, summary, detail))

    monkeypatch.setattr(alerts, '_send', _capture)

    full_session = TranscriptStore('ChatTranscripts')
    full_session._table = RaisingTable(ConditionalCheckFailedException())
    broken_writes = TranscriptStore('ChatTranscripts')
    broken_writes._table = RaisingTable(RuntimeError('ProvisionedThroughputExceeded'))

    refusal_returned = await full_session.persist_turn(
        session_id='s-full', created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1', provider='mock', model='m',
        turn={'reply': 'a'}, flags={},
    )
    await asyncio.sleep(0)  # let the detached alert task run

    await broken_writes.persist_turn(
        session_id='s-broken', created_at='2026-01-01T00:00:00+00:00',
        prompt_version='v1', provider='mock', model='m',
        turn={'reply': 'a'}, flags={},
    )
    await asyncio.sleep(0)

    assert [event_type for event_type, _, _ in fired] == [
        'chat_transcript_session_full',
        'chat_transcript_write_failed',
    ], (
        'a budget refusal is a healthy write refusing one full session (P2); a '
        'broken write is an outage (P1). One shared type means the frequent '
        'benign fire suppresses the outage for the whole cooldown window'
    )
    assert 's-full' in fired[0][2], (
        'the session-full alert must name the session that stopped accepting '
        'turns — it is the only thing the owner can act on'
    )
    # The swallow still holds: the caller is a fire-and-forget beacon, so a
    # refusal may never surface at the turn that triggered it.
    assert refusal_returned is None
