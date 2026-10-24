"""UTC daily reset and primary rate-limit preference for Gemini routing."""

from __future__ import annotations

from unittest.mock import patch

from app import gemini_limit_state as gls


def test_prefer_fallback_after_primary_rate_limit() -> None:
    gls.reset_for_tests()
    assert gls.prefer_fallback_first() is False
    gls.note_primary_rate_limited()
    assert gls.prefer_fallback_first() is True
    assert gls.primary_rate_limit_hits_today() == 1
    gls.note_primary_rate_limited()
    assert gls.primary_rate_limit_hits_today() == 2


def test_new_utc_day_clears_the_counters_but_the_preference_follows_its_ttl() -> None:
    """AMENDED by ADR-0026 §4.4: the `primary_*_today` counters stay UTC-daily
    (admin telemetry), but routing no longer keys on the day — a preference set
    a minute before midnight still holds a minute after it."""
    gls.reset_for_tests()
    with patch.object(gls, '_today_utc', return_value='2026-01-10'):
        gls.note_primary_rate_limited(now=1000.0)
        assert gls.prefer_fallback_first(now=1000.0) is True
        assert gls.primary_rate_limit_hits_today() == 1

    with patch.object(gls, '_today_utc', return_value='2026-01-11'):
        assert gls.prefer_fallback_first(now=1060.0) is True
        assert gls.primary_rate_limit_hits_today() == 0


def test_fallback_preference_expires_after_the_default_ten_minute_ttl(
    monkeypatch,
) -> None:
    """ADR-0026 §4.4: a primary 429 / stall prefers the fallback for
    GEMINI_FALLBACK_PREFERENCE_TTL_MINUTES (default 10) on a monotonic clock —
    not for the rest of the UTC day. `now=` injects the clock."""
    monkeypatch.delenv('GEMINI_FALLBACK_PREFERENCE_TTL_MINUTES', raising=False)
    gls.reset_for_tests()

    gls.note_primary_rate_limited(now=1000.0)

    assert gls.prefer_fallback_first(now=1000.0 + 599.0) is True
    assert gls.prefer_fallback_first(now=1000.0 + 600.0) is False


def test_a_zero_ttl_disables_the_fallback_preference_but_still_counts(
    monkeypatch,
) -> None:
    """ADR-0026 §4.1: GEMINI_FALLBACK_PREFERENCE_TTL_MINUTES=0 disables the
    preference — the primary is always tried first — while the daily counters
    (telemetry, not routing) still record the hit."""
    monkeypatch.setenv('GEMINI_FALLBACK_PREFERENCE_TTL_MINUTES', '0')
    gls.reset_for_tests()

    gls.note_primary_timed_out(now=1000.0)

    assert gls.prefer_fallback_first(now=1000.0) is False
    assert gls.primary_timeout_hits_today() == 1
