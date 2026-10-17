"""`siteState` on the two routes that take it (ADR-0015 §6.2, §6.4, §6.6).

`tests/test_site_state.py` pins the model and the formatter as a leaf. This file is the
wiring: that `/api/chat` and `/api/live/session` accept the field, refuse a malformed one,
persist the validated dump, and — the one that bites — that the live system instruction does
not silently overrun its budget once a site-state line is added to it.

THE BUDGET ROW IS THE IMPORTANT ONE, and its failure mode is why. MEASURED,
`knowledge_context.build_live_system_instruction`:

    max_total   = max(6000, min(CHAT_LIVE_SYSTEM_MAX_CHARS or 14000, 32000))
    budget_pack = max(3500, max_total - len(prompt_body) - 900)
    if len(blob) > budget_pack: blob = _truncate_text(blob, budget_pack)

The `900` is the reserve for `voice_rules`. A site-state line appended AFTER that arithmetic
does not raise, does not log, and does not fail a test — it pushes the combined instruction
past `max_total`, and the final `_truncate_text(combined, max_total)` then eats the TAIL of
the portfolio XML. The symptom is the voice agent quietly forgetting part of the portfolio,
weeks later, with every suite green. So the line has to be inside the reserve, and the
assertion is on the TOTAL LENGTH with a maximal line — not on where the code puts it.

ON THE CACHE, which decides where the line goes on the text path: Gemini's implicit cache
matches an identical PREFIX, and cached tokens do not count against the free tier's
16,000-input-tokens-per-minute-per-model quota (measured 2026-10-13; the whole reason
`tests/test_cache_prefix.py` exists). A per-turn system message is folded out of the turn
list and APPENDED to the system instruction (`gemini_routing._to_contents` +
`_GeminiCall.ainvoke`), so the static prompt stays the identical prefix and the volatile
line lands after it. Prepending it instead would truncate the cache prefix to nothing and
cost ~2.8x throughput, silently.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient

PACK_DIR = Path(__file__).resolve().parents[3] / 'data' / 'chat-knowledge'

VALID = {
    'section': 'portfolio',
    'projectId': 'team-tactics',
    'projectTitle': 'Team Tactics',
    'contactOpen': False,
    'voiceActive': False,
}


@pytest.mark.asyncio
async def test_chat_accepts_site_state(client: AsyncClient) -> None:
    r = await client.post('/api/chat', json={
        'messages': [{'role': 'user', 'content': 'what am I looking at?'}],
        'siteState': VALID,
    })
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_chat_without_site_state_still_works(client: AsyncClient) -> None:
    """§6.2: an older frontend against a newer server keeps working, unchanged."""
    r = await client.post('/api/chat', json={
        'messages': [{'role': 'user', 'content': 'hello'}],
    })
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
@pytest.mark.parametrize('bad', [
    {'section': 'Portfolio'},          # identity, wrong case
    {'projectId': 'has spaces'},       # identity, wrong charset
    {'section': 'x' * 40},             # identity, over the cap
    {'chatStage': 'docked'},           # a sixth key
])
async def test_a_malformed_site_state_is_a_400(client: AsyncClient, bad: dict) -> None:
    """REJECT, not clamp (§6.2). Via the app's existing RequestValidationError handler,
    which already converts 422 -> 400, so the caller gets the shape it already handles."""
    payload = dict(VALID)
    payload.update(bad)
    r = await client.post('/api/chat', json={
        'messages': [{'role': 'user', 'content': 'hi'}],
        'siteState': payload,
    })
    assert r.status_code == 400, r.text
    assert r.json().get('code') == 'validation_error'


@pytest.mark.asyncio
async def test_an_unknown_but_well_formed_section_is_accepted(client: AsyncClient) -> None:
    """THE MIGRATION RULE (§6.2). The FE and the chat host deploy independently and Amplify
    serves main's HTML as-is (invariant #11), so an IA rename reaches one side first. A
    server that 400s an unrecognised section turns that rename into a site-wide chat
    outage."""
    r = await client.post('/api/chat', json={
        'messages': [{'role': 'user', 'content': 'hi'}],
        'siteState': {**VALID, 'section': 'experience'},
    })
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_the_turn_persists_the_validated_dump(client: AsyncClient, stub_store) -> None:
    """§6.4: persist the MODEL's dump, never the raw payload — the precedent is
    `requestMessages` three lines above it in the same function."""
    r = await client.post('/api/chat', json={
        'messages': [{'role': 'user', 'content': 'hi'}],
        'siteState': {**VALID, 'projectTitle': 'T' * 400},
    })
    assert r.status_code == 200, r.text
    assert stub_store.calls, 'harness: nothing was persisted, so this proves nothing'

    turn = stub_store.calls[-1]['turn']
    assert turn.get('siteState') is not None, (
        'the admin panel needs to see what the visitor was looking at when a turn failed, '
        'and the value is already bounded, so it is worth persisting'
    )
    assert len(turn['siteState']['projectTitle']) == 120, (
        'the DUMP, not the raw payload: the clamp has to have been applied before it was '
        'stored, or the bound is decorative'
    )
    assert 'chatStage' not in turn['siteState']


@pytest.mark.asyncio
async def test_live_session_accepts_site_state(client: AsyncClient) -> None:
    r = await client.post('/api/live/session', json={
        'sessionId': 'abc123',
        'siteState': VALID,
    })
    # The mint itself may be unavailable in the test env; what this pins is that the field
    # does not make the request invalid.
    assert r.status_code != 400, r.text


@pytest.mark.asyncio
async def test_live_session_rejects_a_malformed_site_state(client: AsyncClient) -> None:
    r = await client.post('/api/live/session', json={
        'sessionId': 'abc123',
        'siteState': {**VALID, 'projectId': 'bad id'},
    })
    assert r.status_code == 400, r.text


def test_the_live_instruction_stays_inside_its_budget_WITH_a_site_state_line(monkeypatch):
    """§6.6. The trap: a line appended after the pack arithmetic overruns max_total, and the
    final truncate then eats the TAIL of the portfolio XML. No error, no log, green suite,
    and a voice agent that has quietly forgotten part of the portfolio."""
    from app.knowledge_context import build_live_system_instruction, load_knowledge_pack
    from app.site_state import MAX_SITE_STATE_LINE_CHARS, SiteStateIn, format_site_state_line

    monkeypatch.setenv('CHAT_LIVE_SYSTEM_MAX_CHARS', '14000')
    pack = load_knowledge_pack(PACK_DIR)
    prompt = 'prompt-version: test\n' + ('Be helpful. ' * 400)

    worst_line = format_site_state_line(SiteStateIn(
        section='s' * 32,
        projectId='p' * 64,
        projectTitle='t' * 120,
        contactOpen=True,
        voiceActive=True,
    ))
    assert len(worst_line) <= MAX_SITE_STATE_LINE_CHARS

    with_line = build_live_system_instruction(prompt, pack, site_state_line=worst_line)
    assert len(with_line) <= 14000, (
        'the site-state line must be INSIDE the budget arithmetic, not appended after it'
    )
    assert worst_line in with_line, (
        'and it must actually survive — a line that is budgeted for and then truncated away '
        'is the same defect wearing a different hat'
    )

    # And the pack must not have been starved to pay for it: a line of a few hundred
    # characters should cost a few hundred characters of pack, not thousands.
    without = build_live_system_instruction(prompt, pack)
    assert len(without) - len(with_line) <= len(worst_line) + 200


def test_the_live_instruction_is_unchanged_when_there_is_no_site_state():
    """The default call site must behave exactly as before — this is the one function every
    voice session's grounding goes through."""
    from app.knowledge_context import build_live_system_instruction, load_knowledge_pack

    pack = load_knowledge_pack(PACK_DIR)
    prompt = 'prompt-version: test\nBe helpful.'
    assert build_live_system_instruction(prompt, pack) == \
        build_live_system_instruction(prompt, pack, site_state_line='')
