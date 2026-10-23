"""M4 chat slice 3 (ADR-0017 §4.1): the open project is pinned into retrieval.

It rides in the EXISTING dynamic <relevant_projects> section through an explicit parameter -
never as prose appended to the query (that would change role retrieval and <retrieval_tags>),
never in the head (that kills prompt caching). Prepended, cap raised by one so the question's
own matches keep their slots, deduplicated, and an unknown id changes nothing.
"""

from __future__ import annotations

from pathlib import Path

from app.knowledge_context import build_context, load_knowledge_pack, serialize_context_xml
from tests.test_cache_prefix import QUESTIONS, _common_prefix_len, _system_prompt_chars

PACK = load_knowledge_pack(Path(__file__).resolve().parents[3] / 'data' / 'chat-knowledge')


def _ids(ctx):
    return [p.get('id') for p in ctx['projects']]


def test_the_pinned_project_is_prepended_and_the_questions_matches_keep_their_slots():
    plain = build_context('what did he do at Apptio?', '', PACK)
    pinned = build_context('what did he do at Apptio?', '', PACK, pinned_project_id='team-tactics')
    assert _ids(pinned)[0] == 'team-tactics'
    assert _ids(pinned)[1:] == [i for i in _ids(plain) if i != 'team-tactics']


def test_pinning_a_project_already_matched_does_not_duplicate_it():
    ctx = build_context('what did he do at Apptio?', '', PACK, pinned_project_id='apptio')
    assert _ids(ctx).count('apptio') == 1 and _ids(ctx)[0] == 'apptio'


def test_the_pin_changes_neither_roles_nor_retrieval_tags():
    q = 'tell me about his aws experience'
    plain = build_context(q, '', PACK)
    pinned = build_context(q, '', PACK, pinned_project_id='monday-rover')
    assert pinned['roles'] == plain['roles']
    assert pinned['tags'] == plain['tags']


def test_an_unknown_or_empty_pin_changes_nothing():
    q = 'hi'
    plain = build_context(q, '', PACK)
    for pin in (None, '', 'not-a-project', '__proto__'):
        assert build_context(q, '', PACK, pinned_project_id=pin) == plain


def test_pinning_leaves_the_cacheable_prefix_byte_identical():
    """The constraint that bit M2: the head must not vary per turn."""
    blobs = [serialize_context_xml(build_context(q, '', PACK)) for q in QUESTIONS]
    pinned = [
        serialize_context_xml(build_context(q, '', PACK, pinned_project_id='team-tactics'))
        for q in QUESTIONS
    ]
    assert _common_prefix_len(blobs + pinned) == _common_prefix_len(blobs)


def test_the_largest_pin_still_clears_the_quota_floor():
    """ADR-0017 §4.1: at most ~420 tokens on ~1,314 of headroom - redo the addition, not a guess."""
    worst = 0
    for q in QUESTIONS:
        for pid in [p['id'] for p in PACK['projects']]:
            blob = serialize_context_xml(build_context(q, '', PACK, pinned_project_id=pid))
            worst = max(worst, len(blob))
    prefix = _common_prefix_len([serialize_context_xml(build_context(q, '', PACK)) for q in QUESTIONS])
    dynamic_tokens = (worst - prefix) // 4
    assert 16000 / max(dynamic_tokens, 1) >= 5.0, f'{dynamic_tokens} dynamic tokens'


# ---- 3b: the chain input seam (providers._inject_retrieved), shared by the real and mock chains
def test_inject_retrieved_forwards_pinned_project_id_into_relevant_projects():
    from app.messages import Msg
    from app.providers import _inject_retrieved

    # 'hi' falls back to the first two projects, so pin one OUTSIDE that pair.
    out = _inject_retrieved(PACK, {'messages': [Msg(role='human', content='hi')], 'pinnedProjectId': 'monday-rover'})
    blob = str(out['messages'][0].content)
    rel = blob[blob.index('<relevant_projects>'):]
    assert 'monday-rover' in rel[:rel.index('</relevant_projects>')]
    plain = _inject_retrieved(PACK, {'messages': [Msg(role='human', content='hi')]})
    assert str(plain['messages'][0].content) != blob


# ---- 3c: /api/chat passes the visitor's open project (siteState.projectId) into the chain
def test_chain_input_carries_the_open_project_from_site_state():
    from app.main import ChatRequest, _chain_input

    req = ChatRequest.model_validate({
        'messages': [{'role': 'user', 'content': 'hi'}],
        'siteState': {'section': 'labs', 'projectId': 'team-tactics', 'projectTitle': 'Team Tactics'},
    })
    assert _chain_input(req, ['m']) == {'messages': ['m'], 'pinnedProjectId': 'team-tactics'}
    bare = ChatRequest.model_validate({'messages': [{'role': 'user', 'content': 'hi'}]})
    assert _chain_input(bare, ['m']) == {'messages': ['m']}


def test_both_chat_paths_build_their_chain_input_through_the_one_helper():
    src = (Path(__file__).resolve().parents[1] / 'app' / 'main.py').read_text()
    assert '.ainvoke({"messages"' not in src and '.astream({"messages"' not in src
    assert src.count('_chain_input(payload, lc_messages)') == 2
