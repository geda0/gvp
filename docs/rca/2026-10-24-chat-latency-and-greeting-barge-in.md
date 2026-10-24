# RCA + retro — slow chat replies, and a greeting the visitor cannot interrupt (2026-10-24)

Owner report: "the chat is very slow on response and the issue that the greeting continues even
after the interruption came back."

Both found by read-only investigation (architect role, two parallel passes) against code, git
history, ECR manifests, 30 days of `/gvp/chat-stream/{prod,stage}` logs, and live turns.
**M** = measured, **I** = inferred.

## 1. The greeting cannot be interrupted (regression, on prod since 2026-10-23)

**Root cause (M).** `6a1cb34` (M4 slice 14, `js/mic-attach-plan.js`) defers attaching the
microphone to the greeting's first `turnComplete` whenever permission is `prompt`/unknown and the
assistant speaks first — i.e. every first-time visitor. With no upstream audio, Gemini Live's
automatic activity detection hears nothing, never sends `serverContent.interrupted`, and the
Oct-13 barge-in fix (`voice-turn-gate.js` + `player.interrupt()`) is never reached. The gate
itself is intact; the path to it was cut. Shipped to prod in `4118aa3`.

**Secondary (M, code).** No visitor action other than closing/typing stops the greeting locally:
a mic tap during the deferred greeting raises the permission sheet but leaves the audio playing;
a project chip goes to the call as clientContent and relies on the server to cancel (I).

**Why nothing caught it (M).** Slice 14 traded barge-in for "the permission sheet never covers the
greeting", and no test held barge-in as a requirement. `scripts/qa/voice-stage-probe.mjs:129-134`
asserts the *regression* ("the greeting is not interrupted before it completes"; the fake mic only
starts after `turnComplete`), so the 16/16 stage pass reported it as success. Gate tests inject
`interrupted` and so cannot see that the frame no longer arrives.

## 2. Slow replies — two independent causes

**2a. Gemini tail latency on the prod key, amplified by routing (biggest; M).**
- Prod first-token p50/p90 1.7 s / 9.2 s (stage key, same code: 0.86 s / 2.3 s). Primary
  `gemini-3.1-flash-lite` returned 503s on Oct 9/13/14; the `gemma-4-26b-a4b-it` fallback took
  5–14 s or returned 500/429 (24 rate-limited vs 1 ok in 10 days — effectively dead on this key).
- One primary timeout/429 makes the container prefer the fallback **for the rest of the UTC day**
  (`gemini_limit_state.py`), so every later turn wastes a hop on gemma, and the primary — now the
  *last* attempt — runs with **no first-chunk cap** (stalls to 19 s measured).
- The first-chunk budget is 12 s against a normal 0.6–1.5 s, so a stall + failed fallback = a 28 s
  wait ending in an error.
- (I) The prod key looks free-tier (quota 429s, overload 503s) — owner to check.

**2b. Cold starts hit ~60% of real turns (M).** ~0–10 turns/day; 22 of 37 prod invocations cold.
Normal init 2–3.5 s. **Since Oct 23 the first cold start after each deploy is 9–10 s**: every
build now ships new `python:3.12-slim` base layers + a rebuilt pip layer (~52 MB never cached),
and every phase of init slows by the same factor (lazy image-chunk loading, not code). The owner's
"10 s" was exactly this; the release log's "15 s" was cold + a 12 s stall + a gemma 500.

**Ruled out (M):** per-request key re-resolution (cached after first success), transcript
persistence (after the last token), prompt growth (~7–8k tokens, ~55% cache hit), client waits
(digest only), Lambda memory size.

## 3. Retro

**Went well**
- The barge-in mechanism from Oct 13 held; the regression was upstream, which made it a clean fix.
- Per-turn telemetry (`firstTokenLatencyMs`, `fallbackUsed`, REPORT lines) made the latency RCA
  measurable rather than guessed.

**Went wrong**
- A UX trade-off (no sheet over the greeting) silently cancelled a previously-fixed, owner-visible
  behaviour. Barge-in was never written down as an invariant, so the critic had nothing to hold.
- The QA probe was written to confirm the new design, and asserted the regression as a pass. A
  probe that only checks the happy path of the slice under test is not a regression net.
- Routing tuned for "survive rate limits" made the common slow case worse (day-long sticky
  fallback, uncapped last attempt, 12 s budget), and the fallback model's health was never watched.
- The base image floats, so every deploy pays a ~9 s cold start the first visitor absorbs.

**Changes we are making**
- New invariant: *the visitor can always cut the assistant off — by voice or by any explicit
  action — on every path, cold or warm.* A probe and a wiring test assert it.
- QA probes for a slice must include the **owner-visible regressions** of the area, not just the
  slice's own claims.
- Latency gets a budget, not just telemetry (first token ≤ ~5 s worst case on a bad day).

## 4. Brainstorm → chosen fixes

| Problem | Options considered | Chosen |
|---|---|---|
| Cold-path barge-in | A) attach mic at once (pre-Oct-23); C) ask permission before greeting; D) client VAD (needs same permission — rejected) | **A** — restores the proven path, smallest change |
| Non-speech interruption | B) local stop of playback + gate on mic tap / chip / send | **B** on both paths |
| Routing amplifies stalls | shorter first-chunk budget; fallback preference expires in minutes; cap every attempt; retry primary once on 503; swap the dead fallback | **all but the model swap** (swap needs a model verified on the prod key — owner) |
| Cold start | prewarm on chat intent; warm after deploy; pin base image; provisioned concurrency (~$5.5/mo) | **prewarm on open + post-deploy warm + pin base digest**; PC not needed at this traffic |
| Free-tier key (I) | enable billing | **owner action** |
