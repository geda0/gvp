"""ADR-0020 F1: the PUBLIC /api/live/transcript sink bounds what it persists."""

from __future__ import annotations

import json

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
