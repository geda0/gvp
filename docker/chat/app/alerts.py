"""Instant operational alerts for chat degradation — model switch / fallback,
primary timeout, rate-limit, and hard upstream failures.

Design goals:
  * NEVER block or break a chat turn — fire-and-forget, swallow every error.
  * NO spam — throttled to at most one email per event type per cooldown window
    (CHAT_ALERT_COOLDOWN_SECONDS, default 3600s). The daily report carries the
    full counts; these are the "you should know NOW" pings.
  * Ships DARK — a no-op unless CHAT_ALERT_EMAIL (or CONTACT_REPORT_EMAIL) and
    RESEND_API_KEY are set on the container, so it's safe to deploy before the
    owner wires the secret.

Delivery reuses Resend (same provider the contact stack already uses).
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

_RESEND_URL = 'https://api.resend.com/emails'

_lock = threading.Lock()
_last_sent: dict[str, float] = {}


def _dest_email() -> str:
    return (
        os.environ.get('CHAT_ALERT_EMAIL')
        or os.environ.get('CONTACT_REPORT_EMAIL')
        or ''
    ).strip()


def _from_email() -> str:
    return (
        os.environ.get('CHAT_ALERT_FROM_EMAIL')
        or os.environ.get('CONTACT_FROM_EMAIL')
        or ''
    ).strip()


def _api_key() -> str:
    return (os.environ.get('RESEND_API_KEY') or '').strip()


def alerts_enabled() -> bool:
    return bool(_dest_email() and _from_email() and _api_key())


def _cooldown_seconds() -> float:
    raw = os.environ.get('CHAT_ALERT_COOLDOWN_SECONDS')
    try:
        return float(raw) if raw else 3600.0
    except ValueError:
        return 3600.0


def _should_send(event_type: str, now: float) -> bool:
    """At most one alert per event_type per cooldown window."""
    with _lock:
        last = _last_sent.get(event_type)
        if last is not None and (now - last) < _cooldown_seconds():
            return False
        _last_sent[event_type] = now
        return True


def reset_for_tests() -> None:
    with _lock:
        _last_sent.clear()


def fire_alert(event_type: str, summary: str, detail: str = '') -> None:
    """Schedule an instant alert without blocking the caller. Safe on the request
    path: never raises, never delays the turn, no-op when unconfigured or
    throttled. Requires a running event loop to actually send (the chat request
    handlers provide one)."""
    if not alerts_enabled():
        return
    if not _should_send(event_type, time.monotonic()):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.debug('alert %s: no running loop, skipped', event_type)
        return
    loop.create_task(_send(event_type, summary, detail))


def _env_label() -> str:
    return (
        os.environ.get('CHAT_ENV')
        or os.environ.get('STAGE')
        or os.environ.get('ENVIRONMENT')
        or 'unknown'
    ).strip() or 'unknown'


async def _send(event_type: str, summary: str, detail: str) -> None:
    try:
        import httpx

        env = _env_label()
        subject = f'[chat alert · {env}] {event_type} — {summary}'[:200]
        cooldown = int(_cooldown_seconds())
        body = (
            f'Event: {event_type}\n'
            f'Env: {env}\n'
            f'{summary}\n\n'
            f'{detail}\n\n'
            f'(Throttled to 1 per {cooldown}s per event type. '
            f'Full counts are in the daily report.)'
        )
        payload: dict[str, Any] = {
            'from': _from_email(),
            'to': [_dest_email()],
            'subject': subject,
            'text': body,
        }
        headers = {'Authorization': f'Bearer {_api_key()}'}
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(_RESEND_URL, json=payload, headers=headers)
        if resp.status_code >= 400:
            logger.warning(
                'alert send failed event=%s status=%s', event_type, resp.status_code
            )
        else:
            logger.info('alert sent event=%s', event_type)
    except Exception:  # pragma: no cover - alerts must never break a turn
        logger.warning('alert send errored event=%s', event_type, exc_info=True)
