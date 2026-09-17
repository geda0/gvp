"""ADR-0020 F1: the PUBLIC /api/live/transcript sink bounds what it persists.

The sink accepts caller-supplied turn data with no auth in front of it, so
this module is a pure sanitizer — no FastAPI, no boto3, no I/O — kept
separate so it can be unit-tested as a leaf and reused wherever raw turn
input needs to be bounded before it touches persistence.
"""

from __future__ import annotations

import json

_MAX_TOOL_CALLS = 10
_MAX_NAME_LENGTH = 60
_MAX_ENTRY_JSON_LENGTH = 2000
_KNOWN_TOOL_CALL_KEYS = frozenset({'name', 'args', 'id', 'response'})
# Shrink order when an entry is over the JSON budget: `response` first (voice
# turns only), then `args`. `name` is never touched here — it's the only key
# the admin rollup reads (aws/src/contact-admin.js tool histogram; js/admin.js
# turn meta line), so it must survive intact even when the diagnostic payload
# doesn't. Don't "simplify" this into truncating the serialized blob or
# dropping the entry — that would cost the rollup its tool name for no reason.
_SHRINKABLE_KEYS = ('response', 'args')


def sanitize_tool_calls(value: list[dict]) -> list[dict]:
    return [_bound_entry(entry) for entry in value[:_MAX_TOOL_CALLS]]


def _bound_entry(entry: dict) -> dict:
    bounded = {key: val for key, val in entry.items() if key in _KNOWN_TOOL_CALL_KEYS}

    name = bounded.get('name')
    if isinstance(name, str):
        bounded['name'] = name[:_MAX_NAME_LENGTH]

    for key in _SHRINKABLE_KEYS:
        if key not in bounded or len(json.dumps(bounded)) <= _MAX_ENTRY_JSON_LENGTH:
            continue
        bounded[key] = _shrink(bounded, key)

    return bounded


def _shrink(bounded: dict, key: str) -> str:
    """Shrink `bounded[key]` (as a string) until the entry fits the budget.

    `response`/`args` are caller-controlled diagnostic payloads that nothing
    downstream reads, so a truncated string stand-in is an acceptable lossy
    result here — unlike `name`, which `_bound_entry` keeps intact.
    """
    text = json.dumps(bounded[key])
    while text and len(json.dumps({**bounded, key: text})) > _MAX_ENTRY_JSON_LENGTH:
        text = text[: len(text) // 2]
    return text
