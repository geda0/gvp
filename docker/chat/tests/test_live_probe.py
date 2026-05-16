"""GET /api/live/probe — server-side voice end-to-end diagnostic.

Real upstream calls are out of scope here; we cover the gating, error
mapping, and the success path with the upstream replaced by a stub. That's
enough to keep the route honest and exercise the report shape.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_probe_hidden_without_verbose(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Default: probe is hidden so anonymous traffic can't trigger token mints."""
    monkeypatch.delenv('CHAT_READY_VERBOSE', raising=False)
    monkeypatch.delenv('CHAT_READY_VERBOSE_SECRET', raising=False)
    r = await client.get('/api/live/probe')
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_probe_gemini_key_missing(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CHAT_READY_VERBOSE', '1')
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    r = await client.get('/api/live/probe')
    assert r.status_code == 503
    assert r.json().get('code') == 'gemini_key_missing'


@pytest.mark.asyncio
async def test_probe_corpus_missing(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CHAT_READY_VERBOSE', '1')
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')
    pack = app.state.knowledge_pack
    prompt = app.state.system_prompt
    try:
        app.state.knowledge_pack = None
        app.state.system_prompt = ''
        r = await client.get('/api/live/probe')
        assert r.status_code == 503
        assert r.json().get('code') == 'corpus_unavailable'
    finally:
        app.state.knowledge_pack = pack
        app.state.system_prompt = prompt


@pytest.mark.asyncio
async def test_probe_setup_complete_ok(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Happy path: stub the probe to mimic a clean setupComplete from Google."""
    monkeypatch.setenv('CHAT_READY_VERBOSE', '1')
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')

    async def fake_probe(_instr: str) -> dict:
        return {
            'ok': True,
            'model': 'models/gemini-3.1-flash-live-preview',
            'handshake_chars': 1234,
            'setup_complete': True,
            'first_frame_keys': ['setupComplete'],
            'steps': {'mint_ms': 120, 'ws_open_ms': 80, 'setup_send_ms': 1, 'first_frame_ms': 220},
            'total_ms': 430,
        }

    monkeypatch.setattr('app.live_gemini.probe_live_session', fake_probe)
    r = await client.get('/api/live/probe')
    assert r.status_code == 200
    body = r.json()
    assert body['ok'] is True
    assert body['setup_complete'] is True
    assert 'mint_ms' in body['steps']


@pytest.mark.asyncio
async def test_probe_reports_upstream_failure(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Failure path returns 502 with the upstream error captured for triage."""
    monkeypatch.setenv('CHAT_READY_VERBOSE', '1')
    monkeypatch.setenv('GEMINI_API_KEY', 'unit-test-key')

    async def fake_probe(_instr: str) -> dict:
        return {
            'ok': False,
            'error': 'upstream_failed: ConnectionClosed: 1011',
            'model': 'models/gemini-3.1-flash-live-preview',
            'steps': {'mint_ms': 110, 'ws_open_ms': 90},
        }

    monkeypatch.setattr('app.live_gemini.probe_live_session', fake_probe)
    r = await client.get('/api/live/probe')
    assert r.status_code == 502
    body = r.json()
    assert body['ok'] is False
    assert 'upstream_failed' in body['error']
