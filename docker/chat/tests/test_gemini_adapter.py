"""Adapter-level tests for the google-genai swap (ADR-0007 Phase 2, slices B+D).

These cover the seams that have no LangChain equivalent anymore:
  * SDK ``types.FunctionCall`` list -> internal ``{name, args, id}`` tool_calls,
  * ``Msg`` list -> ``types.Content`` + system-instruction folding,
  * streaming tool calls arriving in an empty-text chunk (risk seam #1) being
    collected once by main's accumulator,
  * non-stream ``generate_content`` -> ``Msg`` with text + tool_calls.

A fake google-genai client stands in for the network so the real SDK type
conversions (Content/Part/Config build) still execute.
"""

from __future__ import annotations

import pytest

from app.gemini_routing import (
    GeminiRoutingChain,
    _to_contents,
    _tool_calls_from_function_calls,
)
from app.messages import Msg, MsgChunk, accumulate


class _FakeFunctionCall:
    """Quacks like ``types.FunctionCall`` (.name, .args, .id)."""

    def __init__(self, name, args, id=None):
        self.name = name
        self.args = args
        self.id = id


class _FakeResponse:
    def __init__(self, text, function_calls=None):
        self.text = text
        self.function_calls = function_calls


class _FakeChunk:
    def __init__(self, text, function_calls=None):
        self.text = text
        self.function_calls = function_calls


class _FakeAioModels:
    def __init__(self, captured):
        self._captured = captured

    async def generate_content(self, *, model, contents, config):
        self._captured['model'] = model
        self._captured['contents'] = contents
        self._captured['config'] = config
        return _FakeResponse(
            'Use the contact form.',
            function_calls=[
                _FakeFunctionCall(
                    'open_contact_form',
                    {'subject': 'Role', 'message': 'Hi'},
                    id='call_1',
                )
            ],
        )

    async def generate_content_stream(self, *, model, contents, config):
        self._captured['model'] = model
        self._captured['contents'] = contents
        self._captured['config'] = config

        async def gen():
            # Text arrives first, then the tool call lands in an EMPTY-text
            # chunk (risk seam #1) — it must still be collected exactly once.
            yield _FakeChunk('Sure, ')
            yield _FakeChunk('opening it.')
            yield _FakeChunk('', function_calls=[_FakeFunctionCall('open_resume', None)])

        return gen()


class _FakeAio:
    def __init__(self, captured):
        self.models = _FakeAioModels(captured)


class _FakeClient:
    def __init__(self, captured):
        self.aio = _FakeAio(captured)


def _routing_chain_with_fake(monkeypatch, captured):
    monkeypatch.setattr(
        'app.gemini_routing._text_client_singleton',
        lambda key: _FakeClient(captured),
    )
    from app.providers import chat_tools

    return GeminiRoutingChain(
        inject=None,  # _prepare passes inp straight through when inject is None
        system_prompt='SYSTEM PROMPT',
        primary_id='m-primary',
        fallback_id='m-fallback',
        key='k',
        timeout=5.0,
        tools=chat_tools(),
    )


def test_tool_calls_from_function_calls_maps_shape() -> None:
    calls = _tool_calls_from_function_calls(
        [
            _FakeFunctionCall('open_resume', None, id='a'),
            _FakeFunctionCall('open_contact_form', {'subject': 'x'}, id=None),
            _FakeFunctionCall('', {'ignored': True}),  # empty name -> dropped
        ]
    )
    assert calls == [
        {'name': 'open_resume', 'args': {}, 'id': 'a'},
        {'name': 'open_contact_form', 'args': {'subject': 'x'}, 'id': None},
    ]
    assert _tool_calls_from_function_calls(None) == []


def test_to_contents_folds_system_and_maps_roles() -> None:
    contents, system = _to_contents(
        [
            Msg(role='system', content='S1'),
            Msg(role='human', content='hi'),
            Msg(role='ai', content='hello'),
            Msg(role='system', content='S2'),
        ]
    )
    assert system == 'S1\n\nS2'
    assert [c.role for c in contents] == ['user', 'model']
    assert contents[0].parts[0].text == 'hi'
    assert contents[1].parts[0].text == 'hello'


@pytest.mark.asyncio
async def test_adapter_ainvoke_returns_msg_with_tool_calls(monkeypatch) -> None:
    captured: dict = {}
    chain = _routing_chain_with_fake(monkeypatch, captured)
    out = await chain.ainvoke({'messages': [Msg(role='human', content='reach him?')]})

    assert isinstance(out, Msg)
    assert out.role == 'ai'
    assert out.content == 'Use the contact form.'
    assert out.tool_calls == [
        {'name': 'open_contact_form', 'args': {'subject': 'Role', 'message': 'Hi'}, 'id': 'call_1'}
    ]
    # The static system prompt was folded into the SDK config (no per-turn system role).
    assert captured['config'].system_instruction == 'SYSTEM PROMPT'
    assert chain.last_model_id == 'm-primary'


@pytest.mark.asyncio
async def test_adapter_astream_collects_toolcall_from_empty_text_chunk(monkeypatch) -> None:
    captured: dict = {}
    chain = _routing_chain_with_fake(monkeypatch, captured)

    chunks = [c async for c in chain.astream({'messages': [Msg(role='human', content='resume?')]})]
    assert all(isinstance(c, MsgChunk) for c in chunks)

    # main's accumulator folds the stream: text concatenated, tool call collected once.
    final = accumulate(chunks)
    assert final.content == 'Sure, opening it.'
    assert final.tool_calls == [{'name': 'open_resume', 'args': {}, 'id': None}]
