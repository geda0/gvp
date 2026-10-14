"""Can a visitor's question actually REACH the records it should?

WHY THIS EXISTS — measured 2026-10-13.

Retrieval has two vocabularies and nothing kept them in sync:

  * `SYNONYMS` maps a phrase a visitor might type -> a canonical tag. `extract_tags`
    can only ever emit a tag that is a KEY of that dict.
  * each role/project carries `relevance_tags`, and `_is_relevant` matches those
    against whatever `extract_tags` emitted.

So a `relevance_tags` value with no corresponding SYNONYMS **key** is dead weight: no
question can produce it, and the records behind it are unreachable by topic. Measured on
the shipped pack: **20 of 39 record tags were unreachable**, stranding records behind
`serverless` (3), `backend` (3), `security`, `mobile`, `games`, `cloud`,
`infrastructure`, `query systems` (2 each), and a dozen more.

The visible symptom, measured against the real pack:

    "what about security?"            -> 0 tags, 0 roles, 0 projects
    "has he done any backend work?"   -> 0 tags, 0 roles, 0 projects
    "any mobile experience?"          -> 0 tags, 0 roles, 0 projects
    "tell me about his react work"    -> 0 tags, 0 roles, 0 projects

`_is_relevant` then falls back to `roles_all[:2]` / `projects_all[:2]` — the first two
entries, chosen by array position rather than by relevance. The visitor gets a confident
answer drawn from arbitrary records, which is worse than a thin one: nothing in the
transcript shows that retrieval missed.

Note this is NOT the token-quota problem (see test_cache_prefix.py). Fallback ships
roughly as many tokens as a hit does — 15,468 vs 16,543 chars measured — so this costs
answer QUALITY, not throughput. The two were found together and are independent.

The drift is silent and one-directional: adding a tag to a record is a content edit, in
a JSON file, by someone who has no reason to open knowledge_context.py. So the first test
is a standing drift detector rather than a one-time cleanup.
"""

from pathlib import Path

from app.knowledge_context import (
    SYNONYMS,
    _is_relevant,
    extract_tags,
    load_knowledge_pack,
    normalize,
)

PACK_DIR = Path(__file__).resolve().parents[3] / 'data' / 'chat-knowledge'


def _pack():
    return load_knowledge_pack(PACK_DIR)


def _record_tags(pack):
    """Every tag the shipped records actually declare -> the record ids using it."""
    gating: dict[str, list[str]] = {}
    for kind in ('projects', 'roles'):
        for row in pack.get(kind) or []:
            for tag in row.get('relevance_tags') or []:
                gating.setdefault(normalize(str(tag)), []).append(str(row.get('id')))
    return gating


def test_every_tag_a_record_declares_is_reachable_from_some_question():
    """A record tag with no SYNONYMS key can never be produced, so it strands records."""
    pack = _pack()
    gating = _record_tags(pack)
    assert gating, 'the pack declares no relevance_tags at all, so this test would be vacuous'

    synonym_keys = {normalize(k) for k in SYNONYMS}
    unreachable = {t: ids for t, ids in gating.items() if t not in synonym_keys}

    detail = ', '.join(
        f'{tag} ({len(ids)} record{"s" if len(ids) != 1 else ""})'
        for tag, ids in sorted(unreachable.items(), key=lambda kv: -len(kv[1]))
    )
    assert not unreachable, (
        f'{len(unreachable)} of {len(gating)} record tags cannot be produced by any question, '
        'so the records behind them are unreachable by topic and retrieval falls back to '
        f'whatever sits in the first two array slots. Add a SYNONYMS key for each: {detail}'
    )


def test_a_synonym_key_that_no_record_uses_is_also_drift():
    """The reverse direction: a key matching nothing is a dangling promise.

    Harmless at runtime, but it means someone added a query vocabulary for content that
    does not exist (or renamed the tag on the records and left the key behind). Caught
    here so the two vocabularies stay a closed set in both directions.
    """
    pack = _pack()
    gating = _record_tags(pack)
    synonym_keys = {normalize(k) for k in SYNONYMS}
    orphans = sorted(synonym_keys - set(gating))

    assert not orphans, (
        f'{len(orphans)} SYNONYMS keys match no record at all, so a visitor asking about them '
        f'retrieves nothing specific: {orphans}. Either tag the relevant records or drop the key.'
    )


def test_topic_questions_retrieve_at_least_one_record():
    """The behaviour the two vocabularies exist to produce.

    Each question below names a topic the pack genuinely covers, so each must retrieve
    something specific rather than falling through to array position. Kept separate from
    the vocabulary tests above because this is the user-visible property: a visitor asking
    about security should learn about the security work, not about whichever two records
    happen to be first.
    """
    pack = _pack()
    failures = []

    # topic -> a record id that MUST be retrievable for that topic, so the test proves
    # the right record came back rather than merely some record.
    expectations = [
        ('what about security?', 'jumpcloud'),
        ('has he done any backend work?', 'instant-ink-hp'),
        ('any mobile experience?', '5d-agency-swi'),
        ('tell me about serverless', 'ai-assistant-chatbot'),
        ('what has he done with embedded hardware?', 'monday-rover'),
        ('does he have cloud experience?', 'jumpcloud'),
    ]

    for question, expected_id in expectations:
        tags = extract_tags(question)
        query_norm = normalize(question)
        hits = [
            str(row.get('id'))
            for kind in ('projects', 'roles')
            for row in pack.get(kind) or []
            if _is_relevant(row, tags, query_norm)
        ]
        if not hits:
            failures.append(f'{question!r}: retrieved NOTHING (tags={sorted(tags)})')
        elif not any(h.startswith(expected_id) or expected_id.startswith(h) for h in hits):
            failures.append(
                f'{question!r}: retrieved {hits} but not the expected {expected_id!r} '
                f'(tags={sorted(tags)})'
            )

    assert not failures, (
        'topic retrieval missed records the pack genuinely contains, so these questions get '
        'an answer built from arbitrary records:\n  ' + '\n  '.join(failures)
    )


def test_tech_a_record_lists_is_askable():
    """If a record advertises a technology, a visitor naming it should find that record.

    `react` was the case that exposed this: it appears in `tech` lists, is not a record
    tag, and is not a synonym value, so "tell me about his react work" matched nothing at
    all. A visitor has no way to know which words are in the vocabulary and which are not.
    """
    pack = _pack()
    synonym_values = {normalize(str(v)) for vals in SYNONYMS.values() for v in vals}
    synonym_keys = {normalize(k) for k in SYNONYMS}
    askable = synonym_values | synonym_keys

    # A CURATED list, not everything in the `tech` arrays. Deriving it automatically
    # flags 23 entries, but many are domain phrases rather than things anyone asks by
    # name ("advertising tech", "datacenters", "asset management", "research tooling"),
    # and forcing vocabulary for those would fill SYNONYMS with noise. Which words are
    # worth being askable is a product judgment, so it is written down here explicitly.
    # Each of these is listed by 2+ records AND is a thing a visitor or recruiter
    # plausibly types.
    SHOULD_BE_ASKABLE = [
        'react',       # the case that exposed this — records list "ReactJS"
        'terraform',
        'docker',
        'golang',
        'postgresql',
    ]
    for item in SHOULD_BE_ASKABLE:
        assert any(
            item in normalize(str(t))
            for kind in ('projects', 'roles')
            for row in pack.get(kind) or []
            for t in row.get('tech') or []
        ), f'{item!r} is not in any record\'s tech list, so this expectation is stale'

    missing = sorted(t for t in SHOULD_BE_ASKABLE if not any(t in a or a in t for a in askable))

    assert not missing, (
        f'{len(missing)} technologies are listed by 2+ records but match no query vocabulary, '
        f'so asking about them retrieves nothing specific: {missing}'
    )
