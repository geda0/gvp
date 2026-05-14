from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from app.knowledge_context import (
    build_context,
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
