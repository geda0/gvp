# Design notes (durable intent across cycles)

> Orchestrator maintains this. Subagents start fresh; anything that must survive
> between cycles lives here.
>
> _Previous feature (contact durability, items 2–4) SHIPPED + committed 2026-06-03;
> see git history + backlog "Shipped". Harness upgraded to team-tactics 0.7.0 (tics)._

## Feature goal
**Characterize chat turn-persistence** (invariants #7 + #8) on the `[chat]` (pytest) layer —
close the gaps the existing 70-test suite leaves: today only the **non-stream OK** turn is
proven (`test_chat_persists_transcript_turn`), and `status` is never asserted. We must prove
that EVERY chat turn leaves exactly one transcript row tagged with the right `status`
(`ok`/`error`/`timeout`) — so failed/timed-out attempts surface in the admin panel instead of
vanishing — across BOTH the non-streaming and the entirely-untested streaming (`_chat_stream`)
paths.

Backlog Next-up items 1 (error/timeout status) + 2 (streaming terminal states). `[chat]` layer
= `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

## Test seam (to be confirmed by the planner from the code)
Drive `POST /api/chat` through the FastAPI app with a FAKE routing chain (raises a
non-rate-limit error / sleeps past the timeout / streams chunks then errors) and a
configured-but-stub/in-memory `TranscriptStore`, then assert the persisted row's `status` +
`errorCode`/`errorMessage`. Targets: `_persist_text_turn` (main.py ~664-732), the non-stream
path (ok ~842, timeout ~799, error ~823) and `_chat_stream` (~864-941). Reuse the existing
pytest fixtures — discover them from `docker/chat/tests/conftest.py`,
`test_transcript_store.py`, `test_readiness_timeout.py`, `test_api.py` (every existing chat
test uses `stream:false`).

## Acceptance checklist (observable; from backlog items 1–2)
- [ ] (chat) non-stream: chain raises a non-rate-limit error → exactly ONE row with
      `status=='error'` and populated `errorCode`/`errorMessage`.
- [ ] (chat) non-stream: exceeds the provider timeout → exactly ONE row with
      `status=='timeout'` (in addition to the already-proven 504).
- [ ] (chat) (already proven — do NOT re-add) non-stream ok → one row `status=='ok'`.
- [ ] (chat) stream (`stream:true`): success → exactly ONE row `status=='ok'` after the
      stream completes.
- [ ] (chat) stream: chain errors AFTER the stream has started → one row `status=='error'`.
- [ ] (chat) stream: per-chunk deadline exceeded → one row `status=='timeout'`.

## Invariants
- #7 — every chat text turn persisted before the response returns (ok/error/timeout, stream
  + non-stream). Today PARTIAL (only non-stream ok, status unasserted).
- #8 — each provider call bounded by a timeout (504 + persisted `timeout` row; streaming
  per-chunk deadline). Today PARTIAL (504 proven; persisted timeout row + streaming deadline
  not).

## Decisions made
- (pending) exact fake-chain + stub-store seam — planner to determine from conftest.py and
  reuse existing fixtures; assert persistence + telemetry, NOT byte-incremental wire (ADR-0002:
  Lambda/Mangum buffers SSE, so token-by-token isn't guaranteed on every host).

## Next 1–3 behaviors to specify
1. Non-stream error → one row `status='error'` (+ errorCode).
2. Non-stream timeout → one row `status='timeout'`.
3. Streaming ok → one row `status='ok'` (brings the `_chat_stream` path under test).

## Deferred smells / tech debt
- Item 3 (first-chunk rate-limit → fallback) and item 4 (voice timbre lock) are separate
  backlog items — not in this feature.
