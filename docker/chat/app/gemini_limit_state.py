"""Gemini primary degradation state, per container, in-process.

Routing (ADR-0026 §4.4): a primary 429 or first-chunk stall prefers the fallback
until a MONOTONIC expiry ``now + TTL`` — minutes, not the rest of the UTC day.
Telemetry: the ``primary_*_today`` counters stay UTC-daily (admin host-status card).
"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone

_DEFAULT_TTL_MINUTES = 10.0

_lock = threading.Lock()
_utc_day: str | None = None
_fallback_until: float | None = None
_primary_429_today: int = 0
_primary_timeout_today: int = 0


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


def _sync_day_unlocked() -> None:
    global _utc_day, _primary_429_today, _primary_timeout_today
    t = _today_utc()
    if _utc_day != t:
        _utc_day = t
        _primary_429_today = 0
        _primary_timeout_today = 0


def _ttl_seconds() -> float:
    raw = os.environ.get('GEMINI_FALLBACK_PREFERENCE_TTL_MINUTES')
    try:
        minutes = float(raw) if raw else _DEFAULT_TTL_MINUTES
    except ValueError:
        minutes = _DEFAULT_TTL_MINUTES
    return minutes * 60.0


def _now(now: float | None) -> float:
    return time.monotonic() if now is None else now


def _prefer_fallback_unlocked(now: float) -> None:
    """Set/extend the preference to ``now + TTL``; a later note never shortens it."""
    global _fallback_until
    ttl = _ttl_seconds()
    if ttl <= 0:
        return
    expiry = now + ttl
    if _fallback_until is None or expiry > _fallback_until:
        _fallback_until = expiry


def sync_day_and_maybe_reset() -> None:
    with _lock:
        _sync_day_unlocked()


def prefer_fallback_first(now: float | None = None) -> bool:
    with _lock:
        return _fallback_until is not None and _now(now) < _fallback_until


def note_primary_rate_limited(now: float | None = None) -> None:
    with _lock:
        _sync_day_unlocked()
        global _primary_429_today
        _prefer_fallback_unlocked(_now(now))
        _primary_429_today += 1


def primary_rate_limit_hits_today() -> int:
    with _lock:
        _sync_day_unlocked()
        return _primary_429_today


def note_primary_timed_out(now: float | None = None) -> None:
    """Record that the primary stalled past its first-chunk budget. Like a 429,
    this prefers the fallback for the TTL so subsequent turns skip the
    known-slow primary instead of eating the stall on every request."""
    with _lock:
        _sync_day_unlocked()
        global _primary_timeout_today
        _prefer_fallback_unlocked(_now(now))
        _primary_timeout_today += 1


def primary_timeout_hits_today() -> int:
    with _lock:
        _sync_day_unlocked()
        return _primary_timeout_today


def reset_for_tests() -> None:
    """Clear routing state (pytest isolation)."""
    global _utc_day, _fallback_until, _primary_429_today, _primary_timeout_today
    with _lock:
        _utc_day = None
        _fallback_until = None
        _primary_429_today = 0
        _primary_timeout_today = 0
