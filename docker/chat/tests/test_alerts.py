"""Instant chat alerts: dark-by-default, throttled, never breaks a turn."""

from __future__ import annotations

import asyncio

import pytest

from app import alerts


def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CHAT_ALERT_EMAIL', 'owner@example.com')
    monkeypatch.setenv('CHAT_ALERT_FROM_EMAIL', 'alerts@example.com')
    monkeypatch.setenv('RESEND_API_KEY', 'k-test')


def test_dark_by_default_is_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CHAT_ALERT_EMAIL', raising=False)
    monkeypatch.delenv('CONTACT_REPORT_EMAIL', raising=False)
    monkeypatch.delenv('RESEND_API_KEY', raising=False)
    alerts.reset_for_tests()
    assert alerts.alerts_enabled() is False
    # Must not raise even with no loop / no config.
    alerts.fire_alert('chat_primary_timeout', 'should be ignored')


def test_enabled_when_email_and_key_present(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    assert alerts.alerts_enabled() is True


def test_fire_alert_outside_loop_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    alerts.reset_for_tests()
    # Sync context: no running loop — must be a safe no-op, not a crash.
    alerts.fire_alert('chat_primary_timeout', 'no loop here')


@pytest.mark.asyncio
async def test_schedules_send_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    alerts.reset_for_tests()
    sent: list[tuple[str, str]] = []

    async def _fake_send(event_type: str, summary: str, detail: str) -> None:
        sent.append((event_type, summary))

    monkeypatch.setattr(alerts, '_send', _fake_send)
    alerts.fire_alert('chat_primary_timeout', 'primary stalled')
    await asyncio.sleep(0)  # let the scheduled task run

    assert sent == [('chat_primary_timeout', 'primary stalled')]


@pytest.mark.asyncio
async def test_throttled_per_event_type(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv('CHAT_ALERT_COOLDOWN_SECONDS', '3600')
    alerts.reset_for_tests()
    sent: list[str] = []

    async def _fake_send(event_type: str, summary: str, detail: str) -> None:
        sent.append(event_type)

    monkeypatch.setattr(alerts, '_send', _fake_send)

    alerts.fire_alert('chat_primary_timeout', 'first')
    alerts.fire_alert('chat_primary_timeout', 'second (throttled)')
    alerts.fire_alert('chat_primary_rate_limit', 'different type, allowed')
    await asyncio.sleep(0)

    # Same type within cooldown -> one send; a different type is independent.
    assert sent.count('chat_primary_timeout') == 1
    assert sent.count('chat_primary_rate_limit') == 1


@pytest.mark.asyncio
async def test_send_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The actual send must never raise — a failing HTTP call is caught inside
    _send so a fire-and-forget alert can never break (or warn on) a chat turn."""
    _configure(monkeypatch)
    import httpx

    class _BoomClient:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a) -> bool:
            return False

        async def post(self, *a, **k):
            raise RuntimeError('network boom')

    monkeypatch.setattr(httpx, 'AsyncClient', _BoomClient)

    # Direct call: must complete without raising despite the post() failure.
    await alerts._send('chat_primary_timeout', 'summary', 'detail')


@pytest.mark.asyncio
async def test_throttle_resets_after_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv('CHAT_ALERT_COOLDOWN_SECONDS', '0')
    alerts.reset_for_tests()
    sent: list[str] = []

    async def _fake_send(event_type: str, summary: str, detail: str) -> None:
        sent.append(event_type)

    monkeypatch.setattr(alerts, '_send', _fake_send)

    alerts.fire_alert('chat_primary_timeout', 'a')
    alerts.fire_alert('chat_primary_timeout', 'b')
    await asyncio.sleep(0)

    # Zero cooldown -> every call sends.
    assert sent.count('chat_primary_timeout') == 2
