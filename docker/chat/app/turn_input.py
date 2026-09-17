"""ADR-0020 F1: the PUBLIC /api/live/transcript sink bounds what it persists.

The sink accepts caller-supplied turn data with no auth in front of it, so
this module is a pure sanitizer — no FastAPI, no boto3, no I/O — kept
separate so it can be unit-tested as a leaf and reused wherever raw turn
input needs to be bounded before it touches persistence.
"""

from __future__ import annotations

_MAX_TOOL_CALLS = 10


def sanitize_tool_calls(value: list[dict]) -> list[dict]:
    return value[:_MAX_TOOL_CALLS]
