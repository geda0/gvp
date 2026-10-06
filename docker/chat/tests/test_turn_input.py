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


def test_entry_identity_fields_cannot_defeat_the_json_budget() -> None:
    """The 2000-char budget is total: bulk hidden in `id` is bounded too.

    Verified path for why this is a real loss, not a tidiness complaint:
    `main.py:1216` sanitizes, `main.py:1230` puts the result in the turn, and
    `transcript_store.py:79-111` `list_append`s every turn into ONE DynamoDB
    item keyed by session id — which caps at 400 KB. One unauthenticated
    beacon can push a session's item over that cap; each later `persist_turn`
    for that id then raises, is swallowed at `transcript_store.py:140-144`
    (counted in `writes_failed`, logged, no propagation), and the owner loses
    every subsequent turn of that conversation with no visible symptom.
    """
    # Arrange: an entry whose bulk sits in the identity keys rather than in
    # `args`/`response`. Nothing here is droppable bulk, so the budget has to
    # be enforced on the identity itself or not at all.
    identity_heavy = {'id': 'x' * 50_000, 'name': 'lookupResume'}

    # Act
    entry, = sanitize_tool_calls([identity_heavy])

    # Assert: the entry still fits the per-entry budget, and the one truthful
    # fact it carries — that `lookupResume` ran — survives intact. `id` is a
    # correlation value no consumer reads (the admin rollup keys only on
    # `name`: contact-admin.js:373, admin.js:820), so invariant 17's "clamp
    # values, reject identities" makes this a clamp, not a dropped entry.
    assert len(json.dumps(entry)) <= 2000
    assert entry['name'] == 'lookupResume'


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


def test_an_entry_still_over_budget_after_the_bulk_drop_is_dropped_outright() -> None:
    """The final re-check (`turn_input.py:82-83`) — the line that makes invariant
    #17's per-entry budget TOTAL rather than assumed (ADR-0020 §5 A6c, A8).

    Every other oversized case is rescued by dropping `args`/`response`, so the
    re-check never fires for them and deleting it left the whole suite green.
    The input that reaches it is an entry whose bulk sits in a key the bulk-drop
    cannot remove and the 100-char truncation cannot reach: a NON-STRING `id`.
    Without the re-check that entry is persisted over budget, and the published
    ceiling (`_MAX_TOOL_CALLS x _MAX_ENTRY_JSON_LENGTH` = 20 000 chars per turn)
    becomes an estimate — a number derived from constants that the code does not
    actually hold to.
    """
    # Arrange: ~50 KB of bulk inside a dict-valued `id`. `args`/`response` are
    # absent on purpose, so the bulk-key drop has nothing to remove and the
    # entry is still far over budget when it comes back around.
    unshrinkable = {'id': {'blob': 'x' * 50_000}, 'name': 'lookupResume'}

    # Act
    kept = sanitize_tool_calls([unshrinkable])

    # Assert: dropped outright. There is no truthful way to shrink a non-string
    # id, and a mangled stand-in would sit in the store looking like a real tool
    # call — so the budget is enforced by dropping the entry, not by letting an
    # over-budget row through.
    assert kept == []


def test_the_per_entry_json_budget_bounds_at_exactly_two_thousand_characters() -> None:
    """The per-entry JSON budget AT ITS BOUNDARY (ADR-0020 §5 A6a).

    2000 is written here as a LITERAL, deliberately: it is the number invariant
    #17 and ADR-0020 D1/A8 publish (the worst case per turn is
    `_MAX_TOOL_CALLS x _MAX_ENTRY_JSON_LENGTH` = 10 x 2000 = 20 000 chars, which
    a reader is told to verify by multiplying two constants). The constant is
    module-private and is NOT imported, because a test that reads the constant it
    is pinning passes for every value of it — which is exactly how this bound
    came to be raisable from 2 000 to 100 000 with the suite green. The existing
    oversized cases all use ~50 KB blobs, so they only prove "far too big gets
    smaller"; this pins the edge, so moving the constant by ONE breaks the suite.
    """
    # Arrange: two entries that differ by a single character of payload. The
    # blob lengths are sized against 52 chars of JSON framing + identity keys,
    # and the two preconditions below pin that arithmetic to the boundary — if
    # serialization framing ever changes, they fail loudly instead of letting
    # the boundary drift.
    at_budget = {'id': 'call-1', 'name': 'probe', 'args': {'q': 'x' * 1948}}
    just_over = {'id': 'call-1', 'name': 'probe', 'args': {'q': 'x' * 1949}}
    assert len(json.dumps(at_budget)) == 2000
    assert len(json.dumps(just_over)) == 2001

    # Act
    kept, = sanitize_tool_calls([at_budget])
    bounded, = sanitize_tool_calls([just_over])

    # Assert: an entry that FITS is persisted whole — key for key, diagnostic
    # payload included (a budget that shaved a conforming entry would be a
    # silent data loss for every honest voice turn) — and one single character
    # past the budget loses its bulk and keeps only its identity.
    assert kept == at_budget
    assert bounded == {'id': 'call-1', 'name': 'probe'}


def test_the_tool_call_id_bounds_at_exactly_one_hundred_characters() -> None:
    """The `id` cap AT ITS BOUNDARY (ADR-0020 §5 A6b).

    100 is written here as a LITERAL for the same reason as the budget above:
    `_MAX_ID_LENGTH` is module-private and is not imported, so changing the
    code's constant must break this test. Pinned only by a 50 KB fixture, this
    bound was raisable from 100 to 1 966 with the suite green — `id` is the one
    tool-call field bounded by truncation rather than rejection (it is a
    correlation value no consumer reads, per invariant #17's "clamp values,
    reject identities"), so the truncation point is the whole of the bound.
    """
    # Arrange: two ids differing by one character, with the overflow character
    # distinct from the rest so the assertion proves a PREFIX truncation rather
    # than any replacement that happens to be the right length.
    at_cap = {'id': 'i' * 100, 'name': 'lookupResume'}
    just_over = {'id': 'i' * 100 + 'Z', 'name': 'lookupResume'}

    # Act
    kept, = sanitize_tool_calls([at_cap])
    clamped, = sanitize_tool_calls([just_over])

    # Assert: an id that FITS round-trips untouched (whole-entry equality — a
    # cap that shaved a conforming id would break correlation for every real
    # tool call), and the id one character past the cap comes back at the cap,
    # having lost exactly its overflow.
    assert kept == at_cap
    assert clamped['id'] == 'i' * 100
