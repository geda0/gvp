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


def test_new_utc_day_clears_preference_and_counter() -> None:
    gls.reset_for_tests()
    with patch.object(gls, '_today_utc', return_value='2026-01-10'):
        gls.note_primary_rate_limited()
        assert gls.prefer_fallback_first() is True
        assert gls.primary_rate_limit_hits_today() == 1

    with patch.object(gls, '_today_utc', return_value='2026-01-11'):
        assert gls.prefer_fallback_first() is False
        assert gls.primary_rate_limit_hits_today() == 0
