# Plan: Gemini Live voice-timbre lock (invariant #10 — voice pinned to Charon; cadence directive)

> Written by the `planner` subagent at the start of each feature; consumed by the
> orchestrator one slice per cycle. Tick a box when its slice reaches green.
> This file is part of the continuity contract — it tells the next agent exactly
> which slice is next.
>
> Layer for EVERY slice: **chat** — `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.
> UNIT level: call the three pure functions DIRECTLY (no `POST /api/live/session`, no client, no
> network). `_live_voice_name()` and `_live_connect_config(...)` live in `app.live_gemini`;
> `build_live_system_instruction(...)` lives in `app.knowledge_context`. The SLICE is always the
> OBSERVABLE config the function returns — the resolved voice string, the prebuilt-voice name +
> modality on the returned `LiveConnectConfig`, the directive text in the returned instruction —
> never internal call mechanics. See "## Notes" for the exact seam (the test-writer must not
> re-discover it). New test file: `docker/chat/tests/test_live_voice_timbre.py`.
> Order is the execution order: the core lock first (S1), then its deliberate-override edge (S2),
> then the connect-config voice wiring (S3), then the cadence directive (S4).

- [x] S1 [chat] `_live_voice_name()` with no `CHAT_LIVE_VOICE` set resolves to exactly `'Charon'` — the core timbre lock (monkeypatch.delenv `CHAT_LIVE_VOICE`; assert `== 'Charon'`) (inv: #10)
- [x] S2 [chat] `_live_voice_name()` with `CHAT_LIVE_VOICE` set to another preset (e.g. `'Orus'`) returns that exact value — the override is deliberate, not silent (monkeypatch.setenv; assert `== 'Orus'`) (inv: #10)
- [x] S3 [chat] a `_live_connect_config('hi')` carries a PREBUILT voice in its `speech_config` whose `voice_name == 'Charon'` (the resolved default) — the VOICE half of the connect config (AUDIO-modality half already covered by `test_live_handshake.py`; see Notes — assert voice only) (inv: #10)
- [x] S4 [chat] `build_live_system_instruction(<prompt>, <minimal pack>)` returns text containing the deep/calm/measured-cadence directive — assert a STABLE substring (`'deep, calm, measured cadence'`), not the full prose (inv: #10)

## Notes — the EXACT seam the test-writer must use (do not re-discover)

### Imports + file
- `from app import live_gemini` (S1–S3) and `from app.knowledge_context import build_live_system_instruction` (S4).
- All four assertions go in a NEW file `docker/chat/tests/test_live_voice_timbre.py`. None of these
  three functions is currently referenced by any existing test for the timbre contract (audit
  confirmed — see overlap note), so there is nothing to extend; create the file fresh.
- `_live_voice_name()` and `_live_connect_config(...)` are SYNCHRONOUS — no `@pytest.mark.asyncio`,
  no `async def`, no client, no network. `build_live_system_instruction(...)` is sync too.

### S1 / S2 — `_live_voice_name()` (`docker/chat/app/live_gemini.py:87-99`)
- Signature: `_live_voice_name() -> str` — takes NO arguments. Body is
  `return (os.environ.get('CHAT_LIVE_VOICE') or 'Charon').strip() or 'Charon'`.
- **S1 (default):** the env var leaks across tests, so EXPLICITLY clear it:
  `monkeypatch.delenv('CHAT_LIVE_VOICE', raising=False)` then `assert live_gemini._live_voice_name() == 'Charon'`.
  Do NOT just rely on it being unset in your shell — `delenv` makes the test hermetic.
- **S2 (override):** `monkeypatch.setenv('CHAT_LIVE_VOICE', 'Orus')` then
  `assert live_gemini._live_voice_name() == 'Orus'`. Use a real alternate male preset name like
  `'Orus'` or `'Fenrir'` (from the docstring) — the value is opaque to the function; assert it is
  returned VERBATIM. (Asserting `!= 'Charon'` is too weak; assert the exact echoed value so the
  "not silent" contract is pinned.)
- `monkeypatch` is the standard pytest fixture (declare `monkeypatch: pytest.MonkeyPatch` as a test
  arg); `import pytest` and `from app import live_gemini` at the top — this is the SAME pattern
  `test_knowledge_context.py::test_build_live_system_instruction_appends_voice_suffix` uses for env.

### S3 — `_live_connect_config(...)` voice wiring (`docker/chat/app/live_gemini.py:102-121`)
- Signature: `_live_connect_config(system_instruction: str) -> types.LiveConnectConfig`. Call it
  DIRECTLY with any string — `test_live_handshake.py` already does `live_gemini._live_connect_config('hi')`
  (no client, no api key needed for THIS function — the api-key/client path is `mint_live_session_async`,
  not `_live_connect_config`). Reuse that exact call.
- The function builds, internally:
  `speech_config = types.SpeechConfig(voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=_live_voice_name())))`
  and returns `types.LiveConnectConfig(... speech_config=speech_config, response_modalities=[types.Modality.AUDIO] ...)`.
- **How to reach the voice name on the returned cfg** (attribute path on the typed object — pydantic
  model, snake_case attrs): `cfg = live_gemini._live_connect_config('hi')` then
  `cfg.speech_config.voice_config.prebuilt_voice_config.voice_name`. Assert it `== 'Charon'`
  (with `CHAT_LIVE_VOICE` cleared via `monkeypatch.delenv('CHAT_LIVE_VOICE', raising=False)` so the
  default resolves — the connect config calls `_live_voice_name()` at build time, so the same env
  rule applies). A corroborating assertion is allowed but optional: that
  `cfg.speech_config.voice_config.prebuilt_voice_config` is a `types.PrebuiltVoiceConfig` instance
  (`from google.genai import types`) — prefer the `voice_name == 'Charon'` assertion as primary.
- **OVERLAP — scope S3 to the VOICE only.** `test_live_handshake.py` ALREADY asserts the AUDIO
  response modality twice: `test_live_connect_config_audio_only` does
  `assert [m.value if hasattr(m,'value') else m for m in cfg.response_modalities] == ['AUDIO']`, and
  `test_handshake_has_full_setup_shape` asserts `setup['generationConfig']['responseModalities'] == ['AUDIO']`.
  So S3 must NOT re-assert the modality — assert ONLY the prebuilt voice name. (The acceptance
  bullet pairs "prebuilt voice AND AUDIO modality"; the AUDIO half is already proven, so this slice
  closes the un-proven half — the VOICE — and references the existing modality coverage rather than
  duplicating it.)

### S4 — `build_live_system_instruction(...)` cadence directive (`docker/chat/app/knowledge_context.py:368-417`)
- Signature: `build_live_system_instruction(system_prompt: str, pack: dict[str, Any]) -> str`. Returns
  a string whose FIRST block is `voice_rules` (lines 395-410), which BEGINS:
  `'Voice mode: speak with a deep, calm, measured cadence — slower than conversational default. …'`.
- **Call seam (reuse the existing pattern exactly):** the prompt must have a `prompt-version` first
  line (the function drops line 0), and the pack must have the keys `build_context` reads. Copy the
  shape from `test_knowledge_context.py::test_build_live_system_instruction_appends_voice_suffix`:
  ```python
  pack = {'bio': {'name': 'X'}, 'roles': [], 'projects': [], 'faq': []}
  text = '<!-- prompt-version: t1 -->\nBody line for voice'
  out = build_live_system_instruction(text, pack)
  ```
  (Do NOT set `CHAT_VOICE_SYSTEM_APPEND` — that env is the existing test's concern, not this one.)
- **The assertion (assert intent, NOT brittle prose):** assert the STABLE cadence substring
  `assert 'deep, calm, measured cadence' in out`. That phrase is the load-bearing brand directive
  (ADR-0003 §Decision "Cadence") and the genuinely UNPROVEN half (see overlap note). Do NOT assert
  the whole `voice_rules` paragraph or use `.startswith(<long string>)` / an exact-equality match —
  the surrounding prose (concise-for-speech, third-person, language-switching) is tuneable and would
  make the test brittle. One stable substring is enough to pin the contract; the em-dash (`—`) is
  part of the prose AFTER the phrase, so the chosen substring avoids it.
- **OVERLAP — note, do NOT collide.** `test_knowledge_context.py::test_build_live_system_instruction_appends_voice_suffix`
  already asserts `'Voice mode' in out`, but it does so as a side-effect of proving the
  `CHAT_VOICE_SYSTEM_APPEND` feature and asserts only the bare `'Voice mode'` PREFIX — it does NOT
  assert the deep/calm/measured-CADENCE intent (the #10 brand contract). So assert the cadence
  phrase (`'deep, calm, measured cadence'`), NOT `'Voice mode'`, to avoid duplicating that test and
  to pin the genuinely-unproven directive. (Asserting `'Voice mode'` here would just re-cover the
  existing test; the cadence substring is the new, contract-specific signal.)

## Notes — out of scope for THIS feature (do NOT slice)
- **The setup handshake wire shape** (`_build_setup_handshake`, `mint_live_session_async`,
  `responseModalities==['AUDIO']`, systemInstruction/tools shape, the model id) is already proven by
  `test_live_handshake.py`; **session minting / gating / 503 / 504 / malformed-json / strict-relay**
  by `test_live_session.py`. Do NOT re-slice the handshake, the AUDIO modality, the relay/transport,
  or the session-endpoint behavior — this feature is the VOICE TIMBRE + CADENCE contract only.
- **The exact voice value as configuration vs invariant.** The invariant is "a deep/slow male
  preset, defaulting to Charon, changeable only via `CHAT_LIVE_VOICE`" — S1 pins the `'Charon'`
  default and S2 pins the override mechanism; we do NOT assert any specific OVERRIDE value is
  "blessed" (S2 uses `'Orus'` only as a probe that the function echoes its input). Changing the
  default voice or the cadence prose is a product decision (supersede ADR-0003), not a test edit.
- **Voice working end-to-end** (the live WebSocket relay reaching Google, audio actually playing) is
  a deployment-topology property (API Gateway can't upgrade WebSockets) — explicitly out of scope
  per project-invariants.md; this feature pins the voice CONFIG/timbre the session is minted with,
  not live network success.
- **`liveVoiceName` on `GET /api/chat/host-status`** (the admin surface of the active voice,
  `main.py:642-657`) is downstream telemetry, not the timbre lock itself — not sliced here.
