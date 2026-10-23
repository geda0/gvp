"""Tests for POST /api/live/session — Gemini Live ephemeral token, browser-direct.

ADR-0007 Phase 1: the server WebSocket relay is retired. The browser connects
directly to Google's Live WSS with the short-lived ephemeral token; the server
only mints the token + builds the setup handshake.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.main import app

_FAKE_MINT = {
    'handshake': {'setup': {'model': 'models/gemini-3.1-flash-live-preview'}},
    'model': 'models/gemini-3.1-flash-live-preview',
    'apiVersion': 'v1alpha',
    '_authTokenName': 'auth_tokens/unit-test-token',
}


@pytest.mark.asyncio
async def test_live_session_returns_browser_direct_google(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')

    async def fake_mint(instruction: str) -> dict:
        assert 'Voice mode' in instruction
        return dict(_FAKE_MINT)

    monkeypatch.setattr('app.main.mint_live_session_async', fake_mint)

    r = await client.post('/api/live/session', json={'sessionId': 'sess-unit'})
    assert r.status_code == 200
    body = r.json()
    # Browser connects directly to Google's Live WSS with the ephemeral token.
    assert 'generativelanguage.googleapis.com' in body['websocketUrl']
    assert 'BidiGenerateContentConstrained' in body['websocketUrl']
    assert 'access_token=' in body['websocketUrl']
    assert '/api/live/relay/' not in body['websocketUrl']  # no server relay
    assert body['handshake']['setup']['model']
    assert body['model']
    assert body['apiVersion'] == 'v1alpha'
    assert body.get('liveVoiceTransport') == 'direct_google'
    assert body.get('voiceHint') == 'ok'


@pytest.mark.asyncio
async def test_live_relay_route_is_removed() -> None:
    # The server WebSocket relay endpoint is retired (browser-direct only).
    paths = {getattr(r, 'path', '') for r in app.routes}
    assert not any('/api/live/relay' in p for p in paths)


@pytest.mark.asyncio
async def test_live_session_gemini_key_missing(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)

    r = await client.post('/api/live/session', json={})
    assert r.status_code == 503
    assert r.json().get('code') == 'gemini_key_missing'


@pytest.mark.asyncio
async def test_live_session_corpus_missing(client: AsyncClient) -> None:
    pack = app.state.knowledge_pack
    prompt = app.state.system_prompt
    try:
        app.state.knowledge_pack = None
        app.state.system_prompt = ''

        r = await client.post('/api/live/session', json={})
        assert r.status_code == 503
        assert r.json().get('code') == 'corpus_unavailable'
    finally:
        app.state.knowledge_pack = pack
        app.state.system_prompt = prompt


@pytest.mark.asyncio
async def test_live_session_runtime_error_503(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')

    async def fake_mint(_instruction: str) -> dict:
        raise RuntimeError('token service offline')

    monkeypatch.setattr('app.main.mint_live_session_async', fake_mint)

    r = await client.post('/api/live/session', json={})
    assert r.status_code == 503
    assert r.json().get('code') == 'live_unavailable'


@pytest.mark.asyncio
async def test_live_session_mint_timeout_504(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')

    async def slow_mint(_instruction: str) -> dict:
        import asyncio

        await asyncio.sleep(2.0)
        return dict(_FAKE_MINT)

    monkeypatch.setattr('app.main.mint_live_session_async', slow_mint)
    monkeypatch.setenv('GEMINI_LIVE_MINT_TIMEOUT_SEC', '0.05')

    r = await client.post('/api/live/session', json={'sessionId': 'sess-timeout'})
    assert r.status_code == 504
    assert r.json().get('code') == 'live_mint_timeout'


@pytest.mark.asyncio
async def test_live_session_malformed_json(client: AsyncClient) -> None:
    r = await client.post(
        '/api/live/session',
        content=b'{',
        headers={'Content-Type': 'application/json'},
    )
    assert r.status_code == 400
    assert r.json().get('code') == 'malformed_json'


@pytest.mark.asyncio
async def test_live_session_session_id_too_long_400(client: AsyncClient) -> None:
    long_id = 'x' * 200
    r = await client.post('/api/live/session', json={'sessionId': long_id})
    assert r.status_code == 400
    assert r.json().get('code') == 'validation_error'


# M7 (ADR-0020 amendment) — a voice mint that fails is a P1 `voice_mint_failed`: the
# visitor asked for voice and it will not start. Every failure exit of /api/live/session
# fires exactly one alert, and the HTTP answer is unchanged.
def _capture_alerts(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    fired: list[tuple[str, str]] = []
    monkeypatch.setattr(
        'app.main.fire_alert', lambda t, s, d='': fired.append((t, s)), raising=False
    )
    return fired


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('raised', 'status'),
    [(RuntimeError('token service offline'), 503), (ValueError('upstream boom'), None)],
)
async def test_live_session_mint_failure_fires_voice_mint_failed(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, raised: Exception, status: int | None
) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')
    fired = _capture_alerts(monkeypatch)

    async def fake_mint(_instruction: str) -> dict:
        raise raised

    monkeypatch.setattr('app.main.mint_live_session_async', fake_mint)

    r = await client.post('/api/live/session', json={})
    if status is not None:
        assert r.status_code == status
    assert r.status_code >= 500 or r.status_code == 429
    assert [t for t, _ in fired] == ['voice_mint_failed']


@pytest.mark.asyncio
async def test_live_session_mint_timeout_fires_voice_mint_failed(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')
    fired = _capture_alerts(monkeypatch)

    async def slow_mint(_instruction: str) -> dict:
        import asyncio

        await asyncio.sleep(2.0)
        return dict(_FAKE_MINT)

    monkeypatch.setattr('app.main.mint_live_session_async', slow_mint)
    monkeypatch.setenv('GEMINI_LIVE_MINT_TIMEOUT_SEC', '0.05')

    r = await client.post('/api/live/session', json={})
    assert r.status_code == 504
    assert [t for t, _ in fired] == ['voice_mint_failed']


@pytest.mark.asyncio
async def test_live_session_missing_token_fires_voice_mint_failed(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')
    fired = _capture_alerts(monkeypatch)

    async def tokenless_mint(_instruction: str) -> dict:
        payload = dict(_FAKE_MINT)
        payload.pop('_authTokenName', None)
        return payload

    monkeypatch.setattr('app.main.mint_live_session_async', tokenless_mint)

    r = await client.post('/api/live/session', json={})
    assert r.status_code == 500
    assert [t for t, _ in fired] == ['voice_mint_failed']


@pytest.mark.asyncio
async def test_live_session_success_fires_no_alert(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')
    fired = _capture_alerts(monkeypatch)

    async def fake_mint(_instruction: str) -> dict:
        return dict(_FAKE_MINT)

    monkeypatch.setattr('app.main.mint_live_session_async', fake_mint)

    r = await client.post('/api/live/session', json={})
    assert r.status_code == 200
    assert fired == []


@pytest.mark.asyncio
async def test_live_session_missing_key_fires_voice_mint_failed(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Critic D1: a deploy that drops GEMINI_API_KEY makes every voice start fail; that
    is the same visitor-facing outage as a failed mint, so it is the same P1 type."""
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    fired = _capture_alerts(monkeypatch)

    r = await client.post('/api/live/session', json={})
    assert r.status_code == 503
    assert r.json().get('code') == 'gemini_key_missing'
    assert [t for t, _ in fired] == ['voice_mint_failed']
