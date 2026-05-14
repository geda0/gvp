"""CORS origin expansion (apex <-> www for two-label hosts; https chat. apex for voice WebSocket relay)."""

from __future__ import annotations

from app.main import _cors_expand_apex_www


def test_expand_apex_adds_www() -> None:
    out = _cors_expand_apex_www(['https://marwanelgendy.link'])
    assert set(out) == {
        'https://marwanelgendy.link',
        'https://www.marwanelgendy.link',
        'https://chat.marwanelgendy.link',
    }


def test_expand_www_adds_apex() -> None:
    out = _cors_expand_apex_www(['https://www.marwanelgendy.link'])
    assert set(out) == {
        'https://marwanelgendy.link',
        'https://www.marwanelgendy.link',
        'https://chat.marwanelgendy.link',
    }


def test_skip_deeper_subdomain() -> None:
    out = _cors_expand_apex_www(['https://chat.marwanelgendy.link'])
    assert out == ['https://chat.marwanelgendy.link']


def test_dedupe_and_order_stable() -> None:
    out = _cors_expand_apex_www(
        [
            'https://marwanelgendy.link',
            'https://www.marwanelgendy.link',
        ]
    )
    assert len(out) == 3
    assert set(out) == {
        'https://marwanelgendy.link',
        'https://www.marwanelgendy.link',
        'https://chat.marwanelgendy.link',
    }
