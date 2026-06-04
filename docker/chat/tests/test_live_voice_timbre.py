"""Pin the Gemini Live voice-timbre lock (project invariant #10).

Invariant #10: every minted Live session uses a deep, slow male preset,
defaulting to Charon. Changing the voice must be a deliberate CHAT_LIVE_VOICE
override, never an accident. This file characterizes that contract by calling
the pure resolver / config builders directly (no session minting, no client,
no network) — see docs/tdd/project-invariants.md #10.

S1: with no CHAT_LIVE_VOICE override, _live_voice_name() resolves to exactly
'Charon' — the core timbre lock.
S2: with CHAT_LIVE_VOICE set to another preset, _live_voice_name() returns that
exact value — the override is deliberate, never silent.
S3: a minted Live connect config carries a prebuilt voice whose name is the
resolved default 'Charon' in its speech_config. (The AUDIO response modality
half of the connect config is already covered by test_live_handshake.py.)
S4: the voice-mode system instruction opens with a deep/calm/measured-cadence
directive — Gemini Live has no speech-rate knob, so pacing is steered by the
prompt. This is the prompt half of invariant #10 (the speech_config half is S3).
"""

from __future__ import annotations

import pytest

from google.genai import types

from app import live_gemini
from app.knowledge_context import build_live_system_instruction


def test_live_voice_defaults_to_charon(monkeypatch: pytest.MonkeyPatch) -> None:
    # Arrange: clear any leaked override so the default branch resolves.
    monkeypatch.delenv('CHAT_LIVE_VOICE', raising=False)

    # Act
    voice = live_gemini._live_voice_name()

    # Assert: the brand-locked deep/measured male preset.
    assert voice == 'Charon'


def test_live_voice_override_is_honored(monkeypatch: pytest.MonkeyPatch) -> None:
    # Arrange: a deliberate operator override to an alternate male preset.
    monkeypatch.setenv('CHAT_LIVE_VOICE', 'Orus')

    # Act
    voice = live_gemini._live_voice_name()

    # Assert: the override is echoed VERBATIM (not silently coerced to Charon).
    assert voice == 'Orus'


def test_connect_config_carries_prebuilt_charon_voice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange: clear any leaked override so the default voice resolves at build time
    # (the connect config calls _live_voice_name() when it is constructed).
    monkeypatch.delenv('CHAT_LIVE_VOICE', raising=False)

    # Act: build the connect config the same way test_live_handshake.py does
    # (sync; no client, key, or network needed for this pure builder).
    cfg = live_gemini._live_connect_config('hi')

    # Assert: the speech_config pins a PREBUILT voice named 'Charon' — the timbre
    # lock the session is minted with. (Scope: voice only; the AUDIO modality is
    # already proven by test_live_handshake.py.)
    prebuilt = cfg.speech_config.voice_config.prebuilt_voice_config
    assert isinstance(prebuilt, types.PrebuiltVoiceConfig)
    assert prebuilt.voice_name == 'Charon'


def test_live_system_instruction_has_cadence_directive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange: no CHAT_VOICE_SYSTEM_APPEND — the cadence directive must be intrinsic
    # to the built instruction, not contributed by an operator append override.
    monkeypatch.delenv('CHAT_VOICE_SYSTEM_APPEND', raising=False)
    pack = {'bio': {'name': 'X'}, 'roles': [], 'projects': [], 'faq': []}
    text = '<!-- prompt-version: t1 -->\nBody line for voice'

    # Act
    out = build_live_system_instruction(text, pack)

    # Assert: the load-bearing ADR-0003 pacing phrase — Gemini Live has no
    # speech-rate knob, so the prompt steers cadence (stable substring, not the
    # full tuneable paragraph).
    assert 'deep, calm, measured cadence' in out
