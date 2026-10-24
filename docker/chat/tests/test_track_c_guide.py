"""Work-showcase Track C (backlog items 5-7): the text agent guides, it does not hand out PDFs.

Item 6: "show me around" is a declared tool (`start_tour`) the page runs as a step-by-step tour,
not prose. Item 7: `open_resume` reaches the visitor ONLY when the visitor's own words asked for
the résumé/CV file. The model's tool choice is a suggestion; the visitor's words are the gate,
so the guard reads the LAST USER MESSAGE, never the model's prose (ADR-0015 §5.2 rejected
acting on model prose; this filters on the visitor's).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient

from app.main import app, resume_was_requested
from app.messages import Msg
from app.providers import chat_tools

PROMPT = (Path(__file__).resolve().parents[1] / 'prompts' / 'system-prompt.md').read_text()


def _decls():
    return {d.name: d for d in chat_tools()[0].function_declarations}


def test_the_text_path_declares_start_tour():
    decl = _decls().get('start_tour')
    assert decl is not None, 'a tour the model cannot request is a tour that never starts'
    assert 'show me around' in decl.description.lower()


def test_start_tour_becomes_a_start_tour_action():
    from app.main import _actions_from_result

    actions = _actions_from_result(Msg(role='ai', content='', tool_calls=[{'name': 'start_tour', 'args': {}, 'id': 't'}]))
    assert actions and actions[0]['id'] == 'start-tour'


@pytest.mark.parametrize('text', [
    'Can I download your resume?',
    'send me the CV please',
    'Do you have a résumé PDF?',
    'where is the resume file',
    'Curriculum vitae?',
])
def test_explicit_resume_asks_are_recognised(text):
    assert resume_was_requested([{'role': 'user', 'content': text}])


@pytest.mark.parametrize('text', [
    'Tell me about your experience',
    "What's his background?",
    'What has he worked on?',
    'Show me around',
    'Is he a good fit for a staff role?',
])
def test_open_questions_are_not_resume_asks(text):
    assert not resume_was_requested([{'role': 'user', 'content': text}])


def test_only_the_last_user_message_counts():
    history = [
        {'role': 'user', 'content': 'send me your resume'},
        {'role': 'assistant', 'content': 'Here it is.'},
        {'role': 'user', 'content': 'and what did he do at Apptio?'},
    ]
    assert not resume_was_requested(history), 'a résumé ask two turns ago does not license a PDF now'


class _ResumeChain:
    async def ainvoke(self, _payload, config=None):
        return self._msg()

    async def astream(self, _payload, config=None):
        yield self._msg()

    def _msg(self):
        return Msg(role='ai', content='He has fifteen years of work.', tool_calls=[
            {'name': 'open_resume', 'args': {}, 'id': 'r'},
            {'name': 'navigate_to_section', 'args': {'section': 'portfolio'}, 'id': 'n'},
        ])


async def _post(client: AsyncClient, text: str):
    before = (app.state.chain, app.state.model_id, app.state.provider_error)
    app.state.chain, app.state.model_id, app.state.provider_error = _ResumeChain(), 'mock', None
    try:
        return await client.post('/api/chat', json={'messages': [{'role': 'user', 'content': text}], 'stream': False})
    finally:
        app.state.chain, app.state.model_id, app.state.provider_error = before


@pytest.mark.asyncio
async def test_the_endpoint_drops_an_unrequested_resume_but_keeps_the_navigation(client: AsyncClient):
    body = (await _post(client, 'Tell me about your experience')).json()
    ids = [a['id'] for a in body['actions']]
    assert 'open-resume' not in ids, 'an open question about experience must not hand out the PDF'
    assert 'navigate' in ids, 'the guard removes the résumé only, never the guidance'


@pytest.mark.asyncio
async def test_the_endpoint_keeps_a_requested_resume(client: AsyncClient):
    body = (await _post(client, 'Can I download the resume PDF?')).json()
    assert 'open-resume' in [a['id'] for a in body['actions']]


def test_the_prompt_no_longer_sends_the_resume_for_summaries_or_qualification():
    line = next(l for l in PROMPT.splitlines() if l.startswith('- `open_resume('))
    # The 1.6.0 line TRIGGERED on these; mentioning them as exclusions is the fix, not the bug.
    assert 'asks for a career summary' not in line and 'initial qualification' not in line, line
    assert 'explicitly' in line and 'Never for a career summary' in line


def test_the_prompt_leads_with_the_work_and_runs_tours():
    assert '`start_tour(' in PROMPT
    guide = PROMPT[PROMPT.index('# Tools available'):]
    assert 'show me around' in guide.lower()
    on_ramp = next(l for l in PROMPT.splitlines() if 'tell me about yourself' in l)
    assert 'resume' not in on_ramp.lower(), 'the on-ramps lead with the work, not the PDF'


@pytest.mark.asyncio
async def test_the_streaming_endpoint_applies_the_same_guard(client: AsyncClient):
    """The browser uses the streaming path, so the guard has to be on it too."""
    import json

    before = (app.state.chain, app.state.model_id, app.state.provider_error)
    app.state.chain, app.state.model_id, app.state.provider_error = _ResumeChain(), 'mock', None
    try:
        r = await client.post('/api/chat', json={
            'messages': [{'role': 'user', 'content': 'Tell me about your experience'}], 'stream': True})
    finally:
        app.state.chain, app.state.model_id, app.state.provider_error = before
    done = None
    for frame in r.text.split('\n\n'):
        if frame.startswith('event: done'):
            done = json.loads(frame.split('data: ', 1)[1])
    assert done is not None, r.text[:300]
    ids = [a['id'] for a in done['actions']]
    assert 'open-resume' not in ids and 'navigate' in ids, ids


def test_voice_declares_start_tour_too():
    """Voice reads the same prompt, which now names start_tour. A prompt that names a tool the
    voice session cannot call is a spoken promise with nothing behind it."""
    from app.live_gemini import _LIVE_TOOLS

    names = [d.name for d in _LIVE_TOOLS.function_declarations]
    assert 'start_tour' in names


@pytest.mark.parametrize('text', [
    'Do you have a résumé?',
    '¿Me puedes mandar tu currículum?',
    'Pode me enviar o currículo?',
    'Lebenslauf bitte',
    'أرسل لي السيرة الذاتية',
    '可以发一下简历吗',
    'his c.v. please',
])
def test_resume_asks_in_other_languages_count(text):
    """The prompt replies in the visitor's language, so the gate has to read it too."""
    assert resume_was_requested([{'role': 'user', 'content': text}]), text


@pytest.mark.parametrize('yes', ['yes please', 'Sure, send it', 'ok', 'sí', 'oui'])
def test_a_yes_to_a_resume_offer_counts(yes):
    history = [
        {'role': 'user', 'content': 'what is his background?'},
        {'role': 'assistant', 'content': 'He led data platforms at Apptio. Want his resume as well?'},
        {'role': 'user', 'content': yes},
    ]
    assert resume_was_requested(history), yes


def test_a_yes_to_something_else_does_not():
    history = [
        {'role': 'assistant', 'content': 'Want me to show you the Labs?'},
        {'role': 'user', 'content': 'yes please'},
    ]
    assert not resume_was_requested(history)


class _OnlyResumeChain:
    async def ainvoke(self, _payload, config=None):
        return Msg(role='ai', content='', tool_calls=[{'name': 'open_resume', 'args': {}, 'id': 'r'}])

    async def astream(self, _payload, config=None):
        yield await self.ainvoke(_payload)


@pytest.mark.asyncio
@pytest.mark.parametrize('stream', [False, True])
async def test_dropping_the_only_action_never_leaves_an_empty_reply(client: AsyncClient, stream):
    """A turn whose only content was the dropped résumé would otherwise render "try again"."""
    import json

    before = (app.state.chain, app.state.model_id, app.state.provider_error)
    app.state.chain, app.state.model_id, app.state.provider_error = _OnlyResumeChain(), 'mock', None
    try:
        r = await client.post('/api/chat', json={
            'messages': [{'role': 'user', 'content': 'Tell me about your experience'}], 'stream': stream})
    finally:
        app.state.chain, app.state.model_id, app.state.provider_error = before
    if stream:
        body = next(json.loads(f.split('data: ', 1)[1]) for f in r.text.split('\n\n') if f.startswith('event: done'))
    else:
        body = r.json()
    assert body['actions'] == []
    assert body['reply'].strip(), 'an empty reply renders as "try again" on the page'
    assert 'work' in body['reply'].lower(), 'and it leads with the work'
