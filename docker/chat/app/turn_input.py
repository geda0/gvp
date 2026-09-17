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
_MAX_ID_LENGTH = 100
_MAX_ENTRY_JSON_LENGTH = 2000
_KNOWN_TOOL_CALL_KEYS = frozenset({'name', 'args', 'id', 'response'})
# When an entry is over the JSON budget, drop the bulk keys (`args`,
# `response`) outright and keep only the identity: `{id, name}`. A shrunken
# stand-in would sit in the store looking like a real (if mangled) tool
# response, so the budget is enforced by dropping, never truncating.
_BULK_KEYS = ('args', 'response')

# `direct_google` is the only value the server mints today (main.py:1110); `live`
# is the existing default (main.py:1214); `relay` is a retired value kept in the
# allowlist for historical rows and older browser clients (js/chat-live.js:888) —
# not because anything still emits it.
_KNOWN_TRANSPORTS = frozenset({'live', 'relay', 'direct_google'})


def clamp_transport(value: object) -> str:
    """Clamp caller-supplied `transport` to a known value; total, never raises."""
    return value if isinstance(value, str) and value in _KNOWN_TRANSPORTS else 'live'


def sanitize_tool_calls(value: list[dict]) -> list[dict]:
    bounded = (_bound_entry(entry) for entry in value[:_MAX_TOOL_CALLS])
    return [entry for entry in bounded if entry is not None]


def _bound_entry(entry: dict) -> dict | None:
    bounded = {key: val for key, val in entry.items() if key in _KNOWN_TOOL_CALL_KEYS}

    name = bounded.get('name')
    if not isinstance(name, str):
        # `name` is an identity — it's the admin toolHistogram key
        # (contact-admin.js:373), not a telemetry value. A non-string name
        # has no truthful string form, so coercing it (e.g. `str(name)`)
        # would mint a permanent dashboard row for a tool that never ran.
        # Drop the whole entry instead of coercing.
        return None
    name = name.strip()
    if not name:
        return None
    bounded['name'] = name[:_MAX_NAME_LENGTH]

    # `id` is a correlation value, not a storage key — the DynamoDB
    # partition key is the *session* id, bounded separately by rejection at
    # main.py:163 — and no consumer reads it (contact-admin.js:371-376 keys
    # the tool histogram on `name` alone; js/admin.js:820 reads only
    # `name`). So truncating it can't collide a storage key or mint a
    # phantom dashboard row, the two harms that would justify dropping the
    # entry instead. Cap chosen generously above real tool-call ids
    # (Gemini/OpenAI-style ids are well under 64 chars) so the identity pair
    # `{id, name}` fits the JSON budget by construction: 100 + 60 chars of
    # content plus JSON framing is far under the 2000-char budget, so the
    # bulk-key drop below never has to run just to make room for identity.
    entry_id = bounded.get('id')
    if isinstance(entry_id, str):
        bounded['id'] = entry_id[:_MAX_ID_LENGTH]

    if len(json.dumps(bounded)) > _MAX_ENTRY_JSON_LENGTH:
        for key in _BULK_KEYS:
            bounded.pop(key, None)

    # Re-check: the budget is enforced, not assumed. The only way identity
    # alone can still be over budget here is a non-string `id` (e.g. a large
    # dict/list) that the cap above doesn't reach, since it only truncates
    # `str`. There's no truthful way to shrink a non-string id without
    # mangling it into a lossy stand-in, so drop the entry outright rather
    # than let an over-budget row through.
    if len(json.dumps(bounded)) > _MAX_ENTRY_JSON_LENGTH:
        return None

    return bounded
