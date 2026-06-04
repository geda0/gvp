# Design notes (durable intent across cycles)

> Orchestrator maintains this. Subagents start fresh; anything that must survive
> between cycles lives here.
>
> _Prior features SHIPPED: contact durability (#3/#4/#5), chat turn-persistence (#7/#8
> timeout-row), chat model fallback (#9) — see git + backlog "Shipped". Harness: 0.9.2._

## Feature goal
**Prove invariant #10 — Gemini Live voice timbre lock.** Backlog Next-up item "Gemini Live
voice timbre is pinned to the deep/slow male preset" `[chat]`. The lock exists (landed in commit
`b6a64b3`, ADR-0003) but is UNPROVEN — no test references `Charon`, `_live_voice_name`,
`speech_config`, or the cadence directive. This is a BRAND contract: the voice must stay deep/
slow/male unless deliberately changed.

`[chat]` layer = `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

## Test seam (planner to confirm from the code)
Targets: `docker/chat/app/live_gemini.py` — `_live_voice_name()` (default `Charon`; env override
`CHAT_LIVE_VOICE`) and `_live_connect_config(...)` (builds `speech_config` with a
`PrebuiltVoiceConfig(voice_name=...)` + AUDIO response modality on the `LiveConnectConfig`); and
`docker/chat/app/knowledge_context.py` `build_live_system_instruction(...)` (the deep/calm/
measured-cadence directive — pacing is steered by the prompt since Gemini Live has no speech-rate
knob). Reuse the existing `test_live_*.py` patterns (`test_live_handshake.py`, `test_live_session.py`).

## Acceptance checklist (observable; from backlog #10 / ADR-0003)
- [ ] (chat) with no override, `_live_voice_name()` resolves to **`Charon`**.
- [ ] (chat) setting `CHAT_LIVE_VOICE` to another preset → `_live_voice_name()` returns that value
      (override is deliberate, not silent).
- [ ] (chat) a minted Live connect config carries a **prebuilt voice** in its `speech_config`
      (`PrebuiltVoiceConfig` with the resolved voice name) AND the **AUDIO** response modality.
- [ ] (chat) the voice-mode system instruction (`build_live_system_instruction`) opens with the
      deep/calm/measured-cadence directive.

## Invariants
- #10 — Live voice pinned to a deep/slow male preset (`Charon`); changing it is a deliberate
  `CHAT_LIVE_VOICE` override. (UNPROVEN today.)

## Decisions made
- (pending) exact seam for `_live_connect_config` (does it need a live session / can it be called
  directly with minimal args?) — planner to determine; assert the observable config shape (voice
  name + modality), not internal call mechanics.

## Next 1–3 behaviors to specify
1. `_live_voice_name()` default == 'Charon' (the core lock).
2. `CHAT_LIVE_VOICE` override changes the resolved voice.
3. connect config carries the prebuilt voice + AUDIO modality.  (then the cadence directive.)

## Deferred smells / tech debt
- Frontend guards (#1/#2) + the small follow-ups (#8 cap, markSending, idempotencyKey,
  fallback-first persistence, last_model_id) are separate backlog items — not this feature.
