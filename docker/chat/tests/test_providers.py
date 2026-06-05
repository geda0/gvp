from __future__ import annotations

from app.messages import Msg
from app.providers import _inject_retrieved, get_provider_timeout_seconds


def test_gemini_default_upstream_timeout(monkeypatch) -> None:
    monkeypatch.delenv('GEMINI_TIMEOUT_SECONDS', raising=False)
    monkeypatch.delenv('CHAT_PROVIDER_TIMEOUT_SECONDS', raising=False)
    assert get_provider_timeout_seconds('gemini') == 28.0


def test_gemini_timeout_clamped_to_55s_ceiling(monkeypatch) -> None:
    # An over-large override must be capped at the 55s API Gateway integration
    # ceiling so a slow upstream can't exceed the gateway limit (invariant #8).
    monkeypatch.delenv('CHAT_PROVIDER_TIMEOUT_SECONDS', raising=False)
    monkeypatch.setenv('GEMINI_TIMEOUT_SECONDS', '120')
    assert get_provider_timeout_seconds('gemini') == 55.0

    # The clamp only caps; a legitimate value under the ceiling passes through.
    monkeypatch.setenv('GEMINI_TIMEOUT_SECONDS', '40')
    assert get_provider_timeout_seconds('gemini') == 40.0


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
            messages.append(Msg(role='human', content=f'user-{i} AWS context'))
        else:
            messages.append(Msg(role='ai', content=f'assistant-{i}'))

    injected = _inject_retrieved(pack, {'messages': messages})
    injected_messages = injected['messages']

    assert str(injected_messages[0].content).startswith('<knowledge_pack>')
    assert '<retrieval_tags>' in str(injected_messages[0].content)
    # 12-message compacted tail + 1 summary + 1 injected knowledge message.
    assert len(injected_messages) == 14
    assert str(injected_messages[1].content).startswith('Earlier in this conversation')
