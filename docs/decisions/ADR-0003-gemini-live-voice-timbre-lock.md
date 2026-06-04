# ADR-0003 — Gemini Live voice contract + deep/slow male timbre lock

## Status

Accepted. (Retroactively recorded during the teamentic adoption bootstrap; the timbre
lock landed in commit `b6a64b3` "voice: lock Gemini Live to a deep, slow male timbre".)

## Context

Browser voice uses Google's Gemini Live API. The mic UI is part of the brand surface
and is always rendered (there is no feature flag in the FE — README:51,
`docs/architecture.md` §4 "Mic UI is always in the frontend"). The portfolio wants one
consistent spoken persona — a deep, calm, measured male voice — rather than whatever
default the model would otherwise pick. Gemini Live has no speech-rate knob, so pacing
has to be steered through the system instruction.

## Decision

Pin a single voice persona for every minted Live session, configurable per environment
but with a deliberate default.

- **Voice preset:** `_live_voice_name()` defaults to `Charon` ("the deepest, most
  measured male preset") and is overridable via `CHAT_LIVE_VOICE`
  (`docker/chat/app/live_gemini.py:87-99`). It is wired into the session as a
  `SpeechConfig` → `VoiceConfig` → `PrebuiltVoiceConfig(voice_name=...)` on
  every connect (`live_gemini.py:108-117`), and the chosen voice is logged at mint time
  (`live_gemini.py:211-218`).
- **Cadence:** because Live has no rate control, the voice-mode system instruction opens
  with "speak with a deep, calm, measured cadence — slower than conversational default …
  the lower-register pacing suits the prebuilt voice preset"
  (`docker/chat/app/knowledge_context.py:395-399`).
- **Model:** the Live model defaults to `gemini-3.1-flash-live-preview`, overridable via
  `CHAT_VOICE_MODEL` / `GEMINI_VOICE_MODEL` / `GEMINI_LIVE_MODEL`
  (`docker/chat/app/live_env.py:8-20`).
- **Transport:** the relay proxies the browser WebSocket ↔ Google Live with
  `Authorization: Token` upstream (`docker/chat/app/live_relay.py:41-57`); the active
  voice is surfaced to ops as `liveVoiceName` on `GET /api/chat/host-status`
  (`main.py:640-657`, set by commit `b6a64b3`). The override env is documented in
  `secrets.example/chat-deploy.env.example` (`CHAT_LIVE_VOICE=Charon`).

## Consequences

- The timbre is a **brand contract**. Changing the voice name, the default, or the
  cadence directive is a deliberate product decision (supersede this ADR), not an
  incidental edit — `Charon` + the slow-cadence instruction together define the persona.
- The voice config lives in two coupled places: the `SpeechConfig` preset
  (`live_gemini.py`) and the cadence prose (`knowledge_context.py`). They must move
  together; tuning one without the other breaks the intended effect.
- Code matches the architecture doc and the commit message; no discrepancy found.
