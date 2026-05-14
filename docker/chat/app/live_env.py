"""Voice (Gemini Live) env resolution without importing google-genai."""

from __future__ import annotations

import os


def live_model_id() -> str:
    """Live API model id for browser voice.

    Precedence: CHAT_VOICE_MODEL (voice-only override) → GEMINI_VOICE_MODEL (alias)
    → GEMINI_LIVE_MODEL (SAM/chat-template default) → built-in default.

    Text chat stays on GEMINI_MODEL / providers.py; voice can diverge via CHAT_VOICE_MODEL.
    """
    for key in ('CHAT_VOICE_MODEL', 'GEMINI_VOICE_MODEL', 'GEMINI_LIVE_MODEL'):
        v = (os.environ.get(key) or '').strip()
        if v:
            return v
    return 'gemini-3.1-flash-live-preview'
