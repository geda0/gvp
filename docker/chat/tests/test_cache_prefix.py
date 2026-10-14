"""Is the knowledge blob shaped so Gemini's implicit cache can actually hit it?

WHY THIS EXISTS — measured on prod 2026-10-13.

The free tier's binding quota is `GenerateContentInputTokensPerModelPerMinute-FreeTier`
= **16,000 INPUT tokens per minute, per model**. Every turn was shipping ~5,900 input
tokens (1,812 of system prompt + ~4,000 of knowledge), so the site could serve about
**2.7 turns/minute** before the primary 429'd. The fallback then re-sent the same
oversized payload to `gemma-4-26b-a4b-it`, draining ITS separate 16,000 as well, and the
turn died as `chat_upstream_unavailable` — the visitor's "upstream error".

Trimming was measured and REJECTED: even truncating every project summary to 300 chars
only moved 2.8 -> 3.4 turns/min, and it costs answer quality.

What actually works is implicit caching. Verified live against the prod key, same model:

    call 2: prompt=11220  cached=None     <- cold
    call 3: prompt=11220  cached=8170     <- 73% served from cache

and those two calls, 22,440 prompt tokens inside one minute, did NOT 429 — consistent
with cached tokens not counting against the input-token quota (11,220 + 3,050 uncached =
14,270, just under 16,000).

Implicit caching matches an **identical PREFIX**. That makes prompt ORDER load-bearing in
a way nothing else in this file is: a single dynamic field placed high in the blob
truncates the cache prefix to nothing and silently costs ~2.8x throughput. That is
exactly the bug this pins. The original head was

    <knowledge_pack><bio>...</bio><retrieval_tags>...</retrieval_tags><role_index>...

where `<retrieval_tags>` varies per question, so the identical prefix died at ~2,988
tokens — under the 4,096 minimum for 3.x Flash, so caching never engaged at all.

The failure mode is invisible: answers stay correct, tests stay green, and only the 429
rate moves. So these tests assert the two properties caching needs, and nothing about
wording or formatting.

NOTE on the threshold: published minimums disagree (1,024 / 2,048 / 4,096 / 6,144
depending on model and on Gemini-API vs Vertex docs). We target comfortably above the
highest figure seen rather than sitting on the line.
"""

import html
from pathlib import Path

from app.knowledge_context import (
    build_context,
    load_knowledge_pack,
    serialize_context_xml,
)

PACK_DIR = Path(__file__).resolve().parents[3] / 'data' / 'chat-knowledge'

# Deliberately spans the retrieval behaviours: a greeting that matches nothing, a
# tag hit, a name hit, and a topic with no reachable tag. The cache prefix must be
# identical across ALL of them, because a real visitor's turns are this varied.
QUESTIONS = [
    'hi',
    'thanks',
    'what does marwan do?',
    'tell me about his aws experience',
    'what did he do at Apptio?',
    'does he know python?',
    'tell me about his react work',
]

# Headroom over the largest published minimum (6,144 on Vertex for some 3.x models)
# is not required, but we must clear the 4,096 that the Gemini API docs state for the
# 3.x Flash family, with margin so an edit to the bio cannot silently drop us under.
MIN_CACHEABLE_PREFIX_TOKENS = 4096
CHARS_PER_TOKEN = 4


def _pack():
    return load_knowledge_pack(PACK_DIR)


def _blobs():
    pack = _pack()
    return [serialize_context_xml(build_context(q, '', pack)) for q in QUESTIONS]


def _common_prefix_len(strings):
    shortest = min(len(s) for s in strings)
    i = 0
    while i < shortest and len({s[i] for s in strings}) == 1:
        i += 1
    return i


def _system_prompt_chars():
    p = Path(__file__).resolve().parents[1] / 'prompts' / 'system-prompt.md'
    return len(p.read_text()) if p.exists() else 0


def test_knowledge_blob_shares_a_cacheable_prefix_across_unrelated_questions():
    blobs = _blobs()
    prefix_chars = _common_prefix_len(blobs)
    total_tokens = (_system_prompt_chars() + prefix_chars) // CHARS_PER_TOKEN

    # Where does it diverge? Surfaced in the failure so the offending dynamic field
    # is named rather than guessed at.
    sample = blobs[0][max(prefix_chars - 40, 0):prefix_chars + 60]

    assert total_tokens >= MIN_CACHEABLE_PREFIX_TOKENS, (
        f'the identical prefix is only ~{total_tokens} tokens '
        f'({prefix_chars} chars of knowledge blob + {_system_prompt_chars()} chars of '
        f'system prompt), under the {MIN_CACHEABLE_PREFIX_TOKENS}-token minimum for '
        'implicit caching — so NOTHING is cached and every turn pays full price against '
        'a 16,000 input-token/minute quota (~2.7 turns/min). Something dynamic is sitting '
        f'too high in the blob. Divergence begins near: {sample!r}'
    )


def test_every_static_section_precedes_every_dynamic_one():
    """Order is the mechanism, so pin it directly rather than only its byte effect.

    A future edit that appends a static section AFTER a dynamic one would keep the
    prefix long enough to pass the test above while wasting the new section's cache
    benefit. This catches that.
    """
    blob = _blobs()[0]

    static_tags = ('<bio>', '<role_index>', '<project_index>', '<faq>')
    dynamic_tags = ('<retrieval_tags>', '<relevant_roles>', '<relevant_projects>')

    positions = {t: blob.find(t) for t in static_tags + dynamic_tags}
    present_static = {t: p for t, p in positions.items() if t in static_tags and p >= 0}
    present_dynamic = {t: p for t, p in positions.items() if t in dynamic_tags and p >= 0}

    assert present_static, f'no static section found at all in the blob: {positions}'
    assert present_dynamic, f'no dynamic section found at all in the blob: {positions}'

    last_static = max(present_static.values())
    first_dynamic = min(present_dynamic.values())

    assert last_static < first_dynamic, (
        'a static section appears AFTER a dynamic one, so its tokens fall outside the '
        'cacheable prefix and are paid for on every single turn. Static sections must all '
        f'precede every dynamic one. Offsets: static={present_static}, '
        f'dynamic={present_dynamic}'
    )


def test_the_whole_faq_is_static_context_not_a_single_keyword_match():
    """The FAQ set never varies, so it belongs in the cached prefix.

    It used to ship as `<faq_match>` — one keyword-matched entry, recomputed per turn,
    which is both a dynamic field (cache-hostile) and a worse answer than letting the
    model see every question it might be asked.
    """
    pack = _pack()
    faq_rows = pack.get('faq') or []
    assert faq_rows, 'the pack has no FAQ rows, so this test would be vacuous'

    blobs = _blobs()
    prefix = blobs[0][:_common_prefix_len(blobs)]

    # The blob is XML-escaped (`_xml_safe` uses quote=True), so an apostrophe in a
    # question becomes &#x27;. Compare escaped-to-escaped, or a question like
    # "what's his salary expectation" reads as missing when it is in fact present.
    def present(text: str) -> bool:
        return html.escape(text, quote=True) in prefix

    missing = [
        str((row.get('q') or [''])[0])
        for row in faq_rows
        if str((row.get('q') or [''])[0])
        and not present(str((row.get('q') or [''])[0]))
    ]
    assert not missing, (
        f'{len(missing)} of {len(faq_rows)} FAQ questions are absent from the cacheable '
        'prefix, so the FAQ is still being selected per turn instead of shipped once and '
        f'cached. First few missing: {missing[:3]}'
    )


def test_the_dynamic_remainder_is_small_enough_to_clear_the_quota():
    """What still costs tokens every turn must leave real headroom under 16,000/min.

    This is the test that actually encodes the user-visible goal: turns per minute.
    """
    blobs = _blobs()
    prefix_chars = _common_prefix_len(blobs)

    worst_dynamic_chars = max(len(b) - prefix_chars for b in blobs)
    dynamic_tokens = worst_dynamic_chars // CHARS_PER_TOKEN
    turns_per_minute = 16000 / max(dynamic_tokens, 1)

    assert turns_per_minute >= 5.0, (
        f'the per-turn uncached payload is still ~{dynamic_tokens} tokens, allowing only '
        f'{turns_per_minute:.1f} turns/min against the 16,000 input-token/minute quota. '
        'Measured before this work: 2.7 turns/min. Move static content ahead of the '
        'dynamic sections, or shrink what varies.'
    )
