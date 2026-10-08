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
# ADR-0020 §5 A4: nesting depth of `args` / `response`, counted as containers
# IN THE VALUE (`{'a': 1}` is depth 1). The byte budget cannot see shape.
_MAX_ARG_DEPTH = 6

# `direct_google` is the only value the server mints today (main.py:1110); `live`
# is the existing default (main.py:1214); `relay` is a retired value kept in the
# allowlist for historical rows and older browser clients (js/chat-live.js:888) —
# not because anything still emits it.
_KNOWN_TRANSPORTS = frozenset({'live', 'relay', 'direct_google'})


def clamp_transport(value: object) -> str:
    """Clamp caller-supplied `transport` to a known value; total, never raises."""
    return value if isinstance(value, str) and value in _KNOWN_TRANSPORTS else 'live'


def clamp_text(value: object, max_bytes: int) -> str:
    """Truncate free text to `max_bytes` of UTF-8, never splitting a character.

    ADR-0020 §5 A2. Pydantic's `max_length` on `userText` / `assistantText`
    counts CODE POINTS, while DynamoDB charges UTF-8 BYTES: 8 000 astral-plane
    code points persist as 32 000 bytes. That is why one maximal turn measures
    ~116 KB and four of them breach DynamoDB's 400 KB item limit, silently
    losing every later turn of the session.

    Clamps rather than rejects: these are telemetry values, so a truncated
    transcript is a truthful weaker fact where a lost turn is not. The Pydantic
    bounds stay as a cheap outer guard, so no caller sees a new 400.

    Cutting the encoded bytes can sever at most the final character, and
    `ignore` drops exactly that incomplete tail — so the result is a prefix of
    the input and keeps every whole character that fits the budget.
    """
    return value.encode('utf-8')[:max_bytes].decode('utf-8', 'ignore')


def sanitize_tool_calls(value: list[dict]) -> list[dict]:
    bounded = (_bound_entry(entry) for entry in value[:_MAX_TOOL_CALLS])
    return [entry for entry in bounded if entry is not None]


def _nests_deeper_than(value: object, limit: int) -> bool:
    """True when `value` holds more than `limit` levels of nested dict/list.

    Iterative on purpose (ADR-0020 §5 A4): a recursive walk would raise
    `RecursionError` on the very payloads this exists to stop, which would make
    `sanitize_tool_calls` less total than it is. Stops at the first level past
    the limit, so a hostile value is never walked to its full depth.
    """
    stack = [(value, 0)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, dict):
            children = node.values()
        elif isinstance(node, list):
            children = node
        else:
            continue
        depth += 1
        if depth > limit:
            return True
        stack.extend((child, depth) for child in children)
    return False


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

    # ADR-0020 §5.14 (A4b): an `id` that is PRESENT and not a `str` drops the
    # entry. It is a value with no truthful clamp — truncation is undefined
    # for it, `str()` would mint a fake correlation id, and dropping the key
    # alone would contradict the already-pinned outcome that such an entry is
    # dropped. Decided on type, so it must run before the first `json.dumps`
    # below (which is recursive); an entry with no `id` at all is legitimate.
    if 'id' in bounded and not isinstance(bounded['id'], str):
        return None

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

    # ORDER IS LOAD-BEARING (ADR-0020 §5 A4): this depth check must run before
    # the first `json.dumps` below. `json.dumps` is itself recursive, so a payload
    # nested past the interpreter's recursion limit raises `RecursionError` from
    # the serialization before any check placed after it could run. Do not move
    # it down for tidiness. A too-deep entry is clamped, not dropped: the same
    # bulk-key drop as an over-budget entry, leaving `{id, name}`.
    if any(_nests_deeper_than(bounded.get(key), _MAX_ARG_DEPTH) for key in _BULK_KEYS):
        for key in _BULK_KEYS:
            bounded.pop(key, None)

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
