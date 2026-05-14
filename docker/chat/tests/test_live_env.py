"""Tests for app.live_env (voice model selection without google-genai)."""

from __future__ import annotations

import pytest

from app.live_env import live_model_id


def test_live_model_id_prefers_chat_voice_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CHAT_VOICE_MODEL', 'voice-model-x')
    monkeypatch.setenv('GEMINI_LIVE_MODEL', 'live-default-y')
    assert live_model_id() == 'voice-model-x'


def test_live_model_id_gemini_voice_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CHAT_VOICE_MODEL', raising=False)
    monkeypatch.setenv('GEMINI_VOICE_MODEL', 'alias-z')
    monkeypatch.setenv('GEMINI_LIVE_MODEL', 'live-default-y')
    assert live_model_id() == 'alias-z'


def test_live_model_id_falls_back_to_gemini_live(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CHAT_VOICE_MODEL', raising=False)
    monkeypatch.delenv('GEMINI_VOICE_MODEL', raising=False)
    monkeypatch.setenv('GEMINI_LIVE_MODEL', 'live-only')
    assert live_model_id() == 'live-only'


def test_live_model_id_builtin_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CHAT_VOICE_MODEL', raising=False)
    monkeypatch.delenv('GEMINI_VOICE_MODEL', raising=False)
    monkeypatch.delenv('GEMINI_LIVE_MODEL', raising=False)
    assert live_model_id() == 'gemini-3.1-flash-live-preview'
