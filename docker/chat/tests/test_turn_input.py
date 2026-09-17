"""ADR-0020 F1: the PUBLIC /api/live/transcript sink bounds what it persists."""

from __future__ import annotations

import json

from app import turn_input
from app.turn_input import sanitize_tool_calls

# The only keys a tool-call entry may carry into DynamoDB. Derived from the
# producers and consumers, not from taste:
#   name, args, id  — written by main.py `_tool_calls_from_result` (text turns)
#   name, args, id, response — sent by js/chat-live.js for voice turns
# `name` is the one key the admin rollup reads (aws/src/contact-admin.js tool
# histogram; js/admin.js turn meta line).
KNOWN_TOOL_CALL_KEYS = {'name', 'args', 'id', 'response'}


def test_oversized_tool_calls_payload_is_capped_at_ten_entries() -> None:
    # Arrange: an unauthenticated caller floods the sink with tool calls.
    flood = [{'name': f'tool-{i}', 'args': {'i': i}} for i in range(500)]

    # Act
    kept = sanitize_tool_calls(flood)

    # Assert: the persisted turn carries at most the ten-entry bound.
    assert len(kept) == 10


def test_single_hostile_entry_is_bounded_in_name_size_and_keys() -> None:
    # Arrange: one entry that beats the count cap but is itself hostile —
    # a 500-char name, a huge payload, and a key the caller invented.
    hostile = {
        'name': 'x' * 500,
        'args': {'blob': 'y' * 50_000},
        'response': {'result': 'z' * 50_000},
        'exfiltrated': 'a key no producer sends and no consumer reads',
    }

    # Act
    entry, = sanitize_tool_calls([hostile])

    # Assert: the entry survives, but bounded in all three respects.
    assert len(entry['name']) <= 60
    assert len(json.dumps(entry)) <= 2000
    assert set(entry) <= KNOWN_TOOL_CALL_KEYS


def test_entry_over_the_json_budget_keeps_its_identity_and_drops_the_bulk() -> None:
    # Arrange: one entry whose diagnostic payload blows the 2000-char serialized
    # budget on its own, carrying the identifying keys `{id, name}` alongside it.
    oversized = {
        'id': 'call-42',
        'name': 'lookupResume',
        'args': {'query': 'q' * 50_000},
        'response': {'text': 'r' * 50_000},
    }

    # Act
    entry, = sanitize_tool_calls([oversized])

    # Assert: the identity survives and the bulk is gone outright. A shrunken
    # stand-in is not an acceptable weaker fact — it would sit in the store
    # looking like a real tool response while being a mangled fragment.
    assert entry['id'] == 'call-42'
    assert entry['name'] == 'lookupResume'
    assert 'args' not in entry
    assert 'response' not in entry


def test_tool_name_is_normalized_or_the_entry_is_dropped() -> None:
    # Arrange: four entries whose `name` is the field the admin rollup turns into
    # a storage/display key (aws/src/contact-admin.js:373
    # `String(call?.name || '').trim() || 'unknown'`, rendered per key by
    # js/admin.js:550-559). One carries a real name behind padding; the other
    # three carry no usable identity at all. The list name is the live hole —
    # downstream `String([...])` joins it into a 200-char caller-authored key,
    # which the 60-char bound never sees because it only fires on `str`.
    batch = [
        {'id': 'call-1', 'name': '  search_resume  '},
        {'id': 'call-2', 'name': ['a' * 100, 'b' * 100]},
        {'id': 'call-3', 'name': '   '},
        {'id': 'call-4', 'args': {'query': 'who is marwan'}},
    ]

    # Act
    kept = sanitize_tool_calls(batch)

    # Assert: the one usable name survives as a normalized string, and every
    # entry left without one is gone. `name` is an identity, not a telemetry
    # value — invariant 17's "clamp values, reject identities" — so an unusable
    # one may not be rewritten into a phantom tool the owner's histogram then
    # counts as an invocation that never happened.
    assert kept == [{'id': 'call-1', 'name': 'search_resume'}]


def test_caller_invented_transport_is_clamped_to_a_known_value() -> None:
    # Arrange: what the server actually mints today (app/main.py:1110
    # `liveVoiceTransport = "direct_google"`, pinned by test_live_session.py) next
    # to a label an unauthenticated caller can invent. Every distinct string the
    # sink persists becomes a permanent histogram key downstream —
    # aws/src/contact-admin.js:336-337 counts by the persisted value and
    # js/admin.js:566,768 renders that object — so the key space must be the
    # sink's to decide, not the caller's.
    minted = 'direct_google'
    invented = 'live"><img src=x onerror=alert(1)>'

    # Act
    kept = turn_input.clamp_transport(minted)
    clamped = turn_input.clamp_transport(invented)

    # Assert: the real value survives intact; anything else collapses onto a
    # known key rather than minting a new one.
    assert kept == 'direct_google'
    assert clamped == 'live'
