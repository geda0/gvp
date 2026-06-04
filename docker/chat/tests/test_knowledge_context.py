from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from app.knowledge_context import (
    build_context,
    build_live_system_instruction,
    compact_history,
    extract_tags,
    load_system_prompt,
    match_faq,
    parse_prompt_version,
    serialize_context_xml,
)


def test_extract_tags_applies_synonyms() -> None:
    tags = extract_tags('Does he have Amazon Web Services and auth experience?')
    assert 'aws' in tags
    assert 'identity' in tags


def test_match_faq_uses_overlap_and_returns_trigger() -> None:
    faq = [
        {
            'q': ['can i see the resume', 'do you have a cv'],
            'a': 'Yes, resume is available.',
            'trigger_tool': 'open_resume',
        }
    ]
    hit = match_faq('Do you have a CV link?', faq)
    assert hit is not None
    assert hit['trigger_tool'] == 'open_resume'


def test_build_context_filters_by_tags_and_falls_back() -> None:
    pack = {
        'bio': {'name': 'Marwan'},
        'faq': [],
        'roles': [
            {'id': 'r1', 'relevance_tags': ['aws']},
            {'id': 'r2', 'relevance_tags': ['identity']},
        ],
        'projects': [
            {'id': 'p1', 'relevance_tags': ['frontend']},
            {'id': 'p2', 'relevance_tags': ['aws']},
        ],
    }
    scoped = build_context('Tell me about AWS work', '', pack)
    assert [r['id'] for r in scoped['roles']] == ['r1']
    assert [p['id'] for p in scoped['projects']] == ['p2']
    assert scoped['retrieval_fallback'] is False

    fallback = build_context('Tell me about cooking', '', pack)
    assert len(fallback['roles']) == 2
    assert len(fallback['projects']) == 2
    assert fallback['retrieval_fallback'] is True


def test_serialize_context_xml_includes_faq_suggestion() -> None:
    xml = serialize_context_xml(
        {
            'bio': {'name': 'Marwan'},
            'roles': [{'id': 'ibm-apptio', 'company': 'IBM'}],
            'projects': [{'id': 'gvp', 'name': 'GVP'}],
            'faq_match': {'a': 'Use contact form.', 'trigger_tool': 'open_contact_form'},
            'tags': ['aws'],
        }
    )
    assert '<knowledge_pack>' in xml
    assert '<suggested_response>' in xml
    assert 'open_contact_form' in xml


def test_compact_history_adds_summary_when_over_limit() -> None:
    messages = [HumanMessage(content=f'user-{i}') if i % 2 == 0 else AIMessage(content='ok') for i in range(14)]
    compacted = compact_history(messages, max_messages=12)
    assert len(compacted) == 13
    assert compacted[0].type == 'human'
    assert 'Earlier in this conversation' in str(compacted[0].content)


def test_parse_prompt_version_requires_first_line_header() -> None:
    text = '\n'.join(
        [
            '<!-- prompt-version: 2.1.0 -->',
            'You are a portfolio assistant.',
            'prompt-version: should-not-be-used',
        ]
    )
    assert parse_prompt_version(text) == '2.1.0'
    assert parse_prompt_version('System prompt body\nprompt-version: 9.9.9') == 'unknown'


def test_load_system_prompt_requires_parseable_header(tmp_path) -> None:
    prompt = tmp_path / 'system-prompt.md'
    prompt.write_text('No version header here.\nPrompt body.', encoding='utf-8')

    try:
        load_system_prompt(prompt)
    except RuntimeError as exc:
        assert 'prompt-version header' in str(exc)
    else:
        raise AssertionError('Expected load_system_prompt to fail without header')


def test_build_context_is_deterministic_for_same_inputs() -> None:
    pack = {
        'bio': {'name': 'Marwan'},
        'faq': [
            {
                'q': ['can i see the resume'],
                'a': 'Yes, there is a resume PDF.',
                'trigger_tool': 'open_resume',
            }
        ],
        'roles': [
            {'id': 'r1', 'relevance_tags': ['aws', 'platform architecture']},
            {'id': 'r2', 'relevance_tags': ['identity']},
        ],
        'projects': [
            {'id': 'p1', 'relevance_tags': ['frontend']},
            {'id': 'p2', 'relevance_tags': ['aws']},
        ],
    }
    first = build_context('Can I see the resume and AWS work?', 'Earlier: architecture', pack)
    second = build_context('Can I see the resume and AWS work?', 'Earlier: architecture', pack)

    assert first == second
    assert first['faq_match'] is not None
    assert [r['id'] for r in first['roles']] == ['r1']
    assert [p['id'] for p in first['projects']] == ['p2']


def test_build_context_matches_by_name_and_company() -> None:
    # Named-entity queries must retrieve THEIR entry even with no matching relevance tag,
    # and not depend on the item happening to sit in the first two array slots.
    pack = {
        'bio': {'name': 'Marwan'},
        'faq': [],
        'roles': [
            {'id': 'jc', 'company': 'JumpCloud', 'relevance_tags': ['identity']},
            {'id': 'hp', 'company': 'HP', 'relevance_tags': ['frontend']},
            {'id': 'apptio', 'company': 'Apptio', 'relevance_tags': ['spark']},
        ],
        'projects': [
            {'id': 'gvp', 'name': 'GVP', 'relevance_tags': ['ai']},
            {'id': 'rover', 'name': 'Monday Rover', 'relevance_tags': ['ai']},
            {'id': 'team-tactics', 'name': 'Team Tactics', 'relevance_tags': ['ai']},
        ],
    }
    # 'Team Tactics' has no tag a generic query would hit, and sits at index 2 (outside the
    # first-two fallback slice) — only name matching can surface it.
    ctx = build_context('Tell me about Team Tactics', '', pack)
    assert 'team-tactics' in [p['id'] for p in ctx['projects']]
    # Company match for roles (Apptio is index 2, outside the fallback slice).
    ctx2 = build_context('What did he build at Apptio?', '', pack)
    assert 'apptio' in [r['id'] for r in ctx2['roles']]


def test_build_context_includes_full_project_index_for_enumeration() -> None:
    # A generic / "list everything" query can't retrieve detail for all projects, but the
    # assistant must still be able to NAME them all — so a lightweight index of every project
    # is always present and serialized.
    pack = {
        'bio': {},
        'faq': [],
        'roles': [],
        'projects': [
            {'id': 'a', 'name': 'Alpha', 'why_it_matters': 'first'},
            {'id': 'b', 'name': 'Beta', 'why_it_matters': 'second'},
            {'id': 'c', 'name': 'Gamma', 'why_it_matters': 'third'},
        ],
    }
    ctx = build_context('what has he built — list everything', '', pack)
    assert [p['id'] for p in (ctx.get('project_index') or [])] == ['a', 'b', 'c']
    xml = serialize_context_xml(ctx)
    assert 'Alpha' in xml and 'Beta' in xml and 'Gamma' in xml
    assert '<project_index>' in xml


def test_extract_tags_covers_labs_and_portfolio_categories() -> None:
    # 'playground' and 'portfolio' are used as relevance_tags in the data; they must be
    # reachable from natural queries, or those items can never match on category.
    assert 'playground' in extract_tags('what side projects and experiments has he built')
    assert 'portfolio' in extract_tags('tell me about his work history and career')


def test_live_voice_instruction_is_third_person_never_team_we() -> None:
    # Honesty contract: Marwan is an individual, not a team. The voice persona must mirror the
    # text prompt — third person throughout, never "we offer" / team voice.
    pack = {'bio': {'name': 'X'}, 'roles': [], 'projects': [], 'faq': []}
    out = build_live_system_instruction('<!-- prompt-version: t1 -->\nBody line for voice', pack)
    low = out.lower()
    assert 'we offer' not in low
    assert 'team voice' not in low
    assert 'third person' in low


def test_build_live_system_instruction_appends_voice_suffix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CHAT_VOICE_SYSTEM_APPEND', 'CUSTOM_APPEND_MARKER')
    pack = {'bio': {'name': 'X'}, 'roles': [], 'projects': [], 'faq': []}
    text = '<!-- prompt-version: t1 -->\nBody line for voice'
    out = build_live_system_instruction(text, pack)
    assert 'Voice mode' in out
    assert 'CUSTOM_APPEND_MARKER' in out
