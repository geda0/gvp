"""Smoke-test endpoint: GET /api/chat/smoke.

Cheap tier (default) reports a host/provider check; deep tier (?deep=1) runs a
REAL live-model probe (the Gemini Live API path) so a silent model/credential
outage is caught — not just a static 'ok'. Admin-key gated; never raises (a probe
failure becomes a 'fail' check, the route still returns 200)."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_smoke_requires_admin_key(client: AsyncClient) -> None:
    r = await client.get("/api/chat/smoke")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_smoke_cheap_reports_host_check(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setenv("ADMIN_API_KEY", "secret")
    r = await client.get("/api/chat/smoke", headers={"x-admin-key": "secret"})
    assert r.status_code == 200
    body = r.json()
    assert body["depth"] == "cheap"
    names = [c["name"] for c in body["checks"]]
    assert "chat_host" in names
    # mock provider => chain configured => host check passes
    host = next(c for c in body["checks"] if c["name"] == "chat_host")
    assert host["status"] == "pass"
    # no deep model check unless ?deep=1
    assert "chat_model_live" not in names
    assert body["overall"] in ("pass", "warn")


@pytest.mark.asyncio
async def test_smoke_deep_runs_the_live_probe_and_marks_it_paid(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setenv("ADMIN_API_KEY", "secret")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    from app import live_gemini

    async def fake_probe(instruction, greet_text=None):
        return {"ok": True}

    monkeypatch.setattr(live_gemini, "probe_live_session", fake_probe)
    r = await client.get("/api/chat/smoke?deep=1", headers={"x-admin-key": "secret"})
    assert r.status_code == 200
    body = r.json()
    assert body["depth"] == "deep"
    live = next(c for c in body["checks"] if c["name"] == "chat_model_live")
    assert live["status"] == "pass"
    assert live["cost"] == "paid", "the live probe is a real (paid) model call"


@pytest.mark.asyncio
async def test_smoke_deep_probe_failure_is_a_fail_check_not_a_500(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setenv("ADMIN_API_KEY", "secret")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    from app import live_gemini

    async def boom(instruction, greet_text=None):
        raise RuntimeError("live api down")

    monkeypatch.setattr(live_gemini, "probe_live_session", boom)
    r = await client.get("/api/chat/smoke?deep=1", headers={"x-admin-key": "secret"})
    assert r.status_code == 200, "a probe failure must not 500 the smoke endpoint"
    body = r.json()
    live = next(c for c in body["checks"] if c["name"] == "chat_model_live")
    assert live["status"] == "fail"
    assert body["overall"] == "fail"
