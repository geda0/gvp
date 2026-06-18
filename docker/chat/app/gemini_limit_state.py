"""UTC daily tracking for Gemini primary degradation (prefer fallback after the
primary rate-limits *or* stalls past the first-chunk budget)."""

from __future__ import annotations

import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_utc_day: str | None = None
_prefer_fallback: bool = False
_primary_429_today: int = 0
_primary_timeout_today: int = 0


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


def _sync_day_unlocked() -> None:
    global _utc_day, _prefer_fallback, _primary_429_today, _primary_timeout_today
    t = _today_utc()
    if _utc_day != t:
        _utc_day = t
        _prefer_fallback = False
        _primary_429_today = 0
        _primary_timeout_today = 0


def sync_day_and_maybe_reset() -> None:
    with _lock:
        _sync_day_unlocked()


def prefer_fallback_first() -> bool:
    with _lock:
        _sync_day_unlocked()
        return _prefer_fallback


def note_primary_rate_limited() -> None:
    with _lock:
        _sync_day_unlocked()
        global _prefer_fallback, _primary_429_today
        _prefer_fallback = True
        _primary_429_today += 1


def primary_rate_limit_hits_today() -> int:
    with _lock:
        _sync_day_unlocked()
        return _primary_429_today


def note_primary_timed_out() -> None:
    """Record that the primary stalled past its first-chunk budget. Like a 429,
    this flips the daily preference to fallback-first so subsequent turns skip the
    known-slow primary instead of eating the stall on every request."""
    with _lock:
        _sync_day_unlocked()
        global _prefer_fallback, _primary_timeout_today
        _prefer_fallback = True
        _primary_timeout_today += 1


def primary_timeout_hits_today() -> int:
    with _lock:
        _sync_day_unlocked()
        return _primary_timeout_today


def reset_for_tests() -> None:
    """Clear routing state (pytest isolation)."""
    global _utc_day, _prefer_fallback, _primary_429_today, _primary_timeout_today
    with _lock:
        _utc_day = None
        _prefer_fallback = False
        _primary_429_today = 0
        _primary_timeout_today = 0
