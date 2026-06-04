# Design notes (durable intent across cycles)

> Orchestrator maintains this. Subagents start fresh; anything that must survive
> between cycles lives here.
>
> _Prior features SHIPPED: contact durability (#3/#4/#5), chat turn-persistence (#7/#8
> timeout-row) — see git history + backlog "Shipped". Harness: team-tactics 0.9.0._

## Feature goal
**Prove invariant #9 — chat model fallback on first-chunk rate-limit.** Backlog Next-up item
"Chat falls back to the secondary model on a first-chunk rate limit" `[chat]`. Today UNPROVEN:
only the rate-limit *classifier* (`is_upstream_rate_limit`) and the daily-reset *state tracker*
are tested — `GeminiRoutingChain` itself (the fallback logic) has no test.

`[chat]` layer = `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q`.

## Test seam (planner to confirm from the code)
Test `GeminiRoutingChain` directly (`docker/chat/app/gemini_routing.py`) with FAKE primary +
fallback chains — primary raises an upstream rate-limit on the FIRST chunk (`astream`) / call
(`ainvoke`); assert the chain transparently produces the FALLBACK's output. Reuse the existing
rate-limit helpers + fake-chain patterns from `docker/chat/tests/test_upstream_errors.py`,
`test_gemini_limit_state.py`, `test_providers.py`. Read `gemini_routing.py` for the exact
constructor + how primary/fallback are injected, and `providers.py:200-201` for the
distinct-model guard.

## Acceptance checklist (observable; from backlog #9)
- [ ] (chat) `astream`: primary raises an upstream RATE-LIMIT on the first chunk → the chain
      streams the **fallback** model's output (caller sees a successful reply, not a 429).
- [ ] (chat) `astream`: once ≥1 chunk has been yielded, a mid-stream error **propagates**
      (the chain is committed — it does NOT restart on the fallback).
- [ ] (chat) a first-chunk error that is **NOT** a rate-limit is **not** retried on the fallback
      (it propagates).
- [ ] (chat) `ainvoke`: primary rate-limit → fallback (the non-streaming analogue).
- [ ] (chat) the distinct-model guard: configuring identical primary + fallback model ids is
      rejected.

## Invariants
- #9 — first-chunk rate-limit → fallback; committed after first chunk; non-rate-limit not
  retried; primary≠fallback. (PARTIAL today: classifier + state tracker only.)

## Decisions made
- (pending) exact fake-chain seam for `GeminiRoutingChain` — planner to determine; assert the
  observable routed OUTPUT (which model answered) + propagation, not internal call counts.

## Next 1–3 behaviors to specify
1. `astream` first-chunk rate-limit → fallback streams (the walking skeleton).
2. `astream` committed-after-first-chunk: post-yield error propagates (no restart).
3. first-chunk non-rate-limit error → not retried.  (then `ainvoke` analogue + distinct-model guard)

## Deferred smells / tech debt
- Voice timbre lock (#10) + frontend guards (#1/#2) are separate backlog items — not this feature.
