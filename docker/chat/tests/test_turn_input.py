"""ADR-0020 F1: the PUBLIC /api/live/transcript sink bounds what it persists."""

from __future__ import annotations

from app.turn_input import sanitize_tool_calls


def test_oversized_tool_calls_payload_is_capped_at_ten_entries() -> None:
    # Arrange: an unauthenticated caller floods the sink with tool calls.
    flood = [{'name': f'tool-{i}', 'args': {'i': i}} for i in range(500)]

    # Act
    kept = sanitize_tool_calls(flood)

    # Assert: the persisted turn carries at most the ten-entry bound.
    assert len(kept) == 10
