from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from app.providers import _inject_retrieved


def test_inject_retrieved_compacts_and_prefixes_knowledge_xml() -> None:
    pack = {
        'bio': {'name': 'Marwan'},
        'faq': [],
        'roles': [
            {'id': 'r1', 'relevance_tags': ['aws']},
            {'id': 'r2', 'relevance_tags': ['identity']},
        ],
        'projects': [
            {'id': 'p1', 'relevance_tags': ['aws']},
            {'id': 'p2', 'relevance_tags': ['frontend']},
        ],
    }
    messages = []
    for i in range(16):
        if i % 2 == 0:
            messages.append(HumanMessage(content=f'user-{i} AWS context'))
        else:
            messages.append(AIMessage(content=f'assistant-{i}'))

    injected = _inject_retrieved(pack, {'messages': messages})
    injected_messages = injected['messages']

    assert str(injected_messages[0].content).startswith('<knowledge_pack>')
    assert '<retrieval_tags>' in str(injected_messages[0].content)
    # 12-message compacted tail + 1 summary + 1 injected knowledge message.
    assert len(injected_messages) == 14
    assert str(injected_messages[1].content).startswith('Earlier in this conversation')
