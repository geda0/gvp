"""SEC-7: server-side cooldown on the paid ?deep=1 smoke Live probe.

A deep probe mints a real (paid) Gemini Live session. Without a server-side
min-interval, anyone holding the probe key could hammer ?deep=1 and run up cost.
A second deep probe inside the min-interval is rejected (429 'cooldown') instead
of minting a session; after the interval it's allowed again. The cheap tier is
never throttled, and the once-daily report caller can opt past the cooldown."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


def _stub_probe(monkeypatch):
    from app import live_gemini

    async def fake_probe(instruction, greet_text=None):
        return {"ok": True}

    monkeypatch.setattr(live_gemini, "probe_live_session", fake_probe)


@pytest.mark.asyncio
async def test_second_deep_probe_within_interval_is_rejected(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setenv("SMOKE_PROBE_KEY", "secret")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setenv("SMOKE_DEEP_MIN_INTERVAL_SEC", "60")
    _stub_probe(monkeypatch)

    clock = {"t": 1000.0}
    from app import main

    monkeypatch.setattr(main, "_smoke_now", lambda: clock["t"])

    r1 = await client.get("/api/chat/smoke?deep=1", headers={"x-smoke-key": "secret"})
    assert r1.status_code == 200

    # 30s later — still inside the 60s window -> rejected, no paid session minted.
    clock["t"] = 1030.0
    r2 = await client.get("/api/chat/smoke?deep=1", headers={"x-smoke-key": "secret"})
    assert r2.status_code == 429
    body = r2.json()
    assert "cooldown" in str(body).lower()


@pytest.mark.asyncio
async def test_deep_probe_allowed_again_after_interval(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setenv("SMOKE_PROBE_KEY", "secret")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setenv("SMOKE_DEEP_MIN_INTERVAL_SEC", "60")
    _stub_probe(monkeypatch)

    clock = {"t": 2000.0}
    from app import main

    monkeypatch.setattr(main, "_smoke_now", lambda: clock["t"])

    r1 = await client.get("/api/chat/smoke?deep=1", headers={"x-smoke-key": "secret"})
    assert r1.status_code == 200

    # 61s later — past the window -> allowed again.
    clock["t"] = 2061.0
    r2 = await client.get("/api/chat/smoke?deep=1", headers={"x-smoke-key": "secret"})
    assert r2.status_code == 200
    body = r2.json()
    assert body["depth"] == "deep"


@pytest.mark.asyncio
async def test_cheap_tier_is_never_throttled(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setenv("SMOKE_PROBE_KEY", "secret")
    monkeypatch.setenv("SMOKE_DEEP_MIN_INTERVAL_SEC", "60")

    clock = {"t": 5000.0}
    from app import main

    monkeypatch.setattr(main, "_smoke_now", lambda: clock["t"])

    for _ in range(3):
        r = await client.get("/api/chat/smoke", headers={"x-smoke-key": "secret"})
        assert r.status_code == 200
        assert r.json()["depth"] == "cheap"


@pytest.mark.asyncio
async def test_once_daily_report_caller_bypasses_cooldown(client: AsyncClient, monkeypatch) -> None:
    """The trusted once-daily report caller marks its request so the deep probe is
    not throttled by an earlier ad-hoc dashboard probe."""
    monkeypatch.setenv("SMOKE_PROBE_KEY", "secret")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setenv("SMOKE_DEEP_MIN_INTERVAL_SEC", "60")
    _stub_probe(monkeypatch)

    clock = {"t": 7000.0}
    from app import main

    monkeypatch.setattr(main, "_smoke_now", lambda: clock["t"])

    # An ad-hoc deep probe arms the cooldown.
    r1 = await client.get("/api/chat/smoke?deep=1", headers={"x-smoke-key": "secret"})
    assert r1.status_code == 200

    # The report caller, inside the window, still gets its deep probe.
    clock["t"] = 7010.0
    r2 = await client.get(
        "/api/chat/smoke?deep=1&report=1", headers={"x-smoke-key": "secret"}
    )
    assert r2.status_code == 200
    assert r2.json()["depth"] == "deep"
