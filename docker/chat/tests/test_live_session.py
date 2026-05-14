"""Tests for POST /api/live/session (Gemini Live ephemeral token)."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_live_session_mocked_ok(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')

    async def fake_mint(instruction: str) -> dict:
        assert 'Voice mode' in instruction
        return {
            'handshake': {'setup': {'model': 'models/gemini-3.1-flash-live-preview'}},
            'model': 'models/gemini-3.1-flash-live-preview',
            'apiVersion': 'v1alpha',
            '_authTokenName': 'auth_tokens/unit-test-token',
        }

    monkeypatch.setattr('app.main.mint_live_session_async', fake_mint)

    r = await client.post('/api/live/session', json={'sessionId': 'sess-unit'})
    assert r.status_code == 200
    body = r.json()
    assert '/api/live/relay/' in body['websocketUrl']
    assert body['websocketUrl'].startswith('ws://') or body['websocketUrl'].startswith('wss://')
    assert body['handshake']['setup']['model']
    assert body['model']
    assert body['apiVersion'] == 'v1alpha'


@pytest.mark.asyncio
async def test_live_session_gemini_key_missing(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)

    r = await client.post('/api/live/session', json={})
    assert r.status_code == 503
    body = r.json()
    assert body.get('code') == 'gemini_key_missing'


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
async def test_live_session_runtime_error_503(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')

    async def fake_mint(_instruction: str) -> dict:
        raise RuntimeError('token service offline')

    monkeypatch.setattr('app.main.mint_live_session_async', fake_mint)

    r = await client.post('/api/live/session', json={})
    assert r.status_code == 503
    assert r.json().get('code') == 'live_unavailable'


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
