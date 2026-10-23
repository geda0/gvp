"""Verify the Live setup handshake is the full wire shape, not a stub.

Gemini Live's BidiGenerateContentConstrained endpoint silently rejects setup
frames that miss the fields the ephemeral token's LiveConnectConstraints
locked in (generationConfig.responseModalities, systemInstruction, tools,
input/outputAudioTranscription). The client then waits for setupComplete
that never arrives and the FE eventually times out at LIVE_SETUP_WAIT_MS.

This test exercises the same code path the SDK uses for direct-API-key
sessions (live.py: _LiveConnectParameters_to_mldev → drop config → re-set
setup.model) so a future change that quietly drops fields surfaces here
instead of as a 45-60s hang in the browser.
"""

from __future__ import annotations

import pytest

from app import live_gemini


@pytest.fixture
def _stub_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')
    monkeypatch.setattr(live_gemini, '_live_client', None, raising=False)


def test_handshake_has_full_setup_shape(_stub_api_key: None) -> None:
    client = live_gemini._live_client_singleton()
    cfg = live_gemini._live_connect_config('You are Marwan.')

    handshake = live_gemini._build_setup_handshake(client, 'gemini-3.1-flash-live-preview', cfg)

    assert 'setup' in handshake, handshake
    setup = handshake['setup']

    assert setup['model'] == 'models/gemini-3.1-flash-live-preview'
    assert setup['generationConfig']['responseModalities'] == ['AUDIO']
    assert setup['systemInstruction']['parts'][0]['text'] == 'You are Marwan.'
    assert isinstance(setup['inputAudioTranscription'], dict)
    assert isinstance(setup['outputAudioTranscription'], dict)

    tools = setup.get('tools')
    assert isinstance(tools, list) and tools, setup
    decls = tools[0].get('functionDeclarations')
    assert isinstance(decls, list) and decls, tools
    names = {d.get('name') for d in decls}
    # M4 slice 2 (ADR-0017 §3.1): the project tools ride the same handshake, and the project
    # enum survives serialisation - it is the only roster the voice model gets (§4.2).
    assert names == {
        'open_resume', 'open_contact_form', 'navigate_to_section', 'open_project', 'close_project'
    }, names
    from app.project_refs import PROJECT_IDS
    open_project = next(d for d in decls if d.get('name') == 'open_project')
    assert open_project['parameters']['properties']['project']['enum'] == list(PROJECT_IDS)

    assert 'config' not in handshake, handshake


def test_live_connect_config_audio_only() -> None:
    """Gemini Live rejects mixed AUDIO+TEXT response_modalities."""
    cfg = live_gemini._live_connect_config('hi')
    assert [m.value if hasattr(m, 'value') else m for m in cfg.response_modalities] == ['AUDIO']
