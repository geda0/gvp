# ADR-0026 — Barge-in on every path, one local interruption door, and a latency budget for chat routing

- **Status:** **Accepted (contract only — no code written by this ADR).** The seams below are what
  the test-writer builds failing tests against.
- **Date:** 2026-10-24
- **Source:** `docs/rca/2026-10-24-chat-latency-and-greeting-barge-in.md` (RCA + chosen fixes,
  decided by the owner). This ADR records the *seams* those fixes cross; it does not re-argue §4 of
  the RCA.
- **Supersedes:** ADR-0017 **§5.2** (the `'after-first-turn'` row and `deferFallbackMs` /
  `nudgeAfterAttach`) and **§5.3** (the deferred-attach wiring requirements).
- **Amends:** invariant **#9** and **#13** (the "rest of the UTC day" stickiness and #13's
  "the FINAL attempt is uncapped"), ADR-0023 **§2** ("no loop" — one bounded same-model retry is
  added) and ADR-0023 **§4.3 reason 1** (the day-long flag becomes a minutes-long TTL; the 429-only
  / 503-never split itself is **unchanged**).
- **Extends:** ADR-0022 §7.7 / §20.5 (the digest requirement and the post-deploy throwaway request).
- **New invariants:** **#25** (the visitor can always cut the assistant off) and **#26** (the
  routing latency budget) in `docs/tdd/project-invariants.md`.
- **Seam owner:** architect. **Implemented by:** the loop (test first).

---

## 1. Context

Two owner-visible defects, both measured in the RCA:

1. **The greeting cannot be interrupted** on the cold path (every first-time visitor). ADR-0017
   §5.2 deferred the microphone to the greeting's first `turnComplete`; with no upstream audio,
   Gemini Live's activity detection never fires `serverContent.interrupted`, so the Oct-13 gate
   (`js/voice-turn-gate.js` + `player.interrupt()`) is never reached. Separately, **no explicit
   visitor act other than hanging up stops playback locally** — a chip, a text turn into the call,
   or a mic tap all leave buffered audio playing.
2. **Replies are slow**: a 12 s first-chunk budget against a 0.6–1.5 s norm, an **uncapped last
   attempt** (19 s stalls measured), a fallback preference that sticks **for the rest of the UTC
   day**, and cold starts on ~60 % of real turns (9–10 s on the first after each deploy because the
   base image floats).

## 2. DECISION 1 — Mic attach: the cold path attaches at once; `micAttachPlan` is deleted

**The `'after-first-turn'` branch is superseded.** On every path the microphone is requested
immediately after the greeting `clientContent` is sent, which is the pre-2026-10-23 behaviour
(`startVoice` cold branch → `attachMicrophoneInternal()` at once).

**`js/mic-attach-plan.js` is deleted, not kept as a constant function.** With the deferred row gone,
every remaining row returns `{ attach: 'now', deferFallbackMs: 0, nudgeAfterAttach: false }`, and a
pure function whose output never varies is a test that pins nothing and a seam a future edit can
quietly re-open. Deleted with it, in the same slice:

- `MIC_DEFER_FALLBACK_MS`, `pendingMicAttach`, `deferredMicTimer`, `runDeferredMicAttach`,
  `clearDeferredMicAttach` and the `if (pendingMicAttach)` call at the greeting's first
  `turnComplete` in `js/chat-live.js`; the status copy *"Say hello once the greeting ends…"*.
- `test/mic-attach-plan.test.mjs`, and the deferral assertions of `test/mic-attach-wiring.test.mjs`
  (re-pointed at #25 — see §7).
- the `'mic-attach-plan'` entry in `test/component-boundaries.test.mjs`'s module list.

What §5.1 of ADR-0017 measured remains true and is **kept**: `denied` must reach
`getUserMedia` at once so its error surfaces (it does — attach-now), and the
`VOICE_SESSION_IDLE_NO_MIC_MS` sweep still closes a session whose attach failed. The cold-path
follow-up nudge returns to its pre-slice-14 rule (warm only); widening it is **out of scope**.

**The accepted cost, stated so nobody "fixes" it back:** on a first visit the browser's
permission sheet appears **over the speaking greeting**. That is the price of barge-in, and the
owner chose it (RCA §4, option A over C/D). Any future change that again delays the mic behind the
greeting must come with a different, measured route to barge-in **and** must keep #25 green.

## 3. DECISION 2 — One local interruption door: `interruptAssistant(reason)` in `js/chat-live.js`

### 3.1 The function

A closure inside `bindChatLiveVoice`, beside `sendClientContentText`:

```js
// js/chat-live.js — the ONLY place playback is cut and the turn gate cancelled.
const interruptAssistant = (reason) => { … }
// reason: 'server' | 'user_text' | 'mic_tap'
```

It does exactly three things, in this order:

1. `turnGate = nextTurnGate(turnGate, reason === 'server' ? 'interrupted' : 'localInterrupt')`
2. `player?.interrupt()`
3. `turnInterrupted = true` (telemetry, as today)

**It is the single door.** Every path that cuts the assistant off goes through it:

| Trigger | Today | Under this ADR |
|---|---|---|
| `serverContent.interrupted` (voice barge-in) | inline gate + `player.interrupt()` (`chat-live.js:1009-1013`) | `interruptAssistant('server')` |
| `sendUserText(text)` — the project chip into a live call (`js/chat.js:1588`) | sends `clientContent`, relies on the server | `interruptAssistant('user_text')` **then** send |
| Mic tap while a session is open but the mic is not live (attach failed / denied, greeting playing) | `attachMicrophone()` only; audio keeps playing | `interruptAssistant('mic_tap')` **then** `attachMicrophone()` |
| Mic tap while the mic IS live | `stopVoiceInternal` (ends the call; `player.close()` → `interrupt()`) | **unchanged** — ending the call is the explicit act (#20), and it already silences |

`sendUserText` keeps its signature and `false`-when-closed return; the interrupt happens only when
it is about to return `true`. **A source-level wiring test asserts no other call site in
`js/chat-live.js` calls `player.interrupt()` or `nextTurnGate(…, 'interrupted')`** — that is what
makes "single door" a fact rather than a convention. `interruptAssistant` is **not** added to the
returned object now; exposing it later (e.g. an Escape key) is additive.

### 3.2 The gate must know whether a server turn is in flight — an additive change to `voice-turn-gate.js`

The naïve local interrupt (`nextTurnGate(g, 'interrupted')` on every chip) **loses the chip's
reply**. Gemini Live delivers audio faster than real time, so the server's `turnComplete` often
arrives while the player still has seconds queued. Cancel the gate then and nothing re-opens it
until the *next* `turnComplete` — which belongs to the chip's own reply, so every chunk of that
reply is dropped. The gate re-opens at the server's next `turnComplete` **as today**; the new
rule is only *when* a local act may close it.

The state stays opaque; it gains one distinction and two events:

| state \ event | `turnStarted` | `localInterrupt` | `interrupted` (server) | `turnComplete` |
|---|---|---|---|---|
| `idle` (open, no server turn in flight) | `streaming` | **`idle`** (player stops; gate stays open) | `cancelled` | `idle` |
| `streaming` (open, server turn in flight) | `streaming` | `cancelled` | `cancelled` | `idle` |
| `cancelled` | `cancelled` | `cancelled` | `cancelled` | `idle` |

- `freshTurnGate()` → `idle`. `acceptsTurnOutput(s)` → `s !== cancelled` (unchanged meaning).
- `chat-live.js` fires `turnStarted` when it **sends** a `clientContent` turn (greeting, nudge,
  `sendUserText` — *after* the interrupt) and on **model output** for a turn (audio part, text part
  or output transcription) — so a turn requested but not yet answered counts as in flight.
- The server's own `interrupted` is unconditional, exactly as today.

Existing tests that compare `freshTurnGate()` to `'open'` (if any) are updated to go through
`acceptsTurnOutput`; nothing outside the module may read the raw state.

**Residual, inferred and therefore a probe requirement, not an assumption:** if Live answered a
mid-turn `clientContent` *without* a `turnComplete` for the turn it abandoned, the gate would stay
`cancelled` through the chip's reply. The Oct-13 VAD path relies on the same server behaviour and
held, but `clientContent`-triggered interruption is not the same path. **The stage probe must assert
the chip reply is heard after a chip sent mid-greeting** (§7).

### 3.3 The enqueue-after-interrupt race — CLOSED in the same slice

`PcmJitterPlayer.enqueue` is `async` (`await this.ensure()`); a chunk accepted by the gate just
before `interrupt()` can resume after it and `start()` a source on a cleared queue — a fragment of
the cut-off sentence plays after the visitor stopped it. Closed with an epoch:

- `PcmJitterPlayer` gains `this.epoch = 0`; `interrupt()` increments it.
- `enqueue` captures `const epoch = this.epoch` **before** its first `await` and returns without
  scheduling if `epoch !== this.epoch` after it.

Testable with a fake `AudioContext` whose `resume()` is a deferred promise: enqueue, interrupt,
resolve → zero sources started. `close()` already calls `interrupt()`, so it inherits the fix.

## 4. DECISION 3 — The routing latency budget (`docker/chat/app/gemini_routing.py`, `gemini_limit_state.py`)

### 4.1 Knobs

| Env var | Default | Meaning |
|---|---|---|
| `GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS` | **5** (was 12) | Per-attempt first-chunk cap, **every attempt including the last**. |
| `GEMINI_TIMEOUT_SECONDS` | 28 (unchanged, #8; clamp 55) | The whole request deadline. |
| `GEMINI_FALLBACK_PREFERENCE_TTL_MINUTES` | **10** | How long a primary 429 / first-chunk stall keeps the fallback first. `0` disables the preference. Invalid → default; clamped to `[0, 1440]`. |

Two named constants (not env): `MAX_MODEL_ATTEMPTS = 3` and
`PRIMARY_503_RETRY_DELAY_SECONDS = 0.3`.

### 4.2 The cap and its relation to the total timeout

```
first_chunk_cap = max(0.1, min(GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS,
                               0.6 * total_timeout / MAX_MODEL_ATTEMPTS))
```

- With defaults: `min(5, 0.6 × 28 / 3 = 5.6) = 5 s`.
- **The relation, as the invariant states it:** the sum of every attempt's first-chunk cap plus the
  retry delay is ≤ 60 % of the request deadline, so the committed stream always keeps ≥ 40 % of the
  deadline to generate. Shrinking `GEMINI_TIMEOUT_SECONDS` shrinks the cap; it can never push the
  first-token phase past the deadline.
- **The last attempt is capped too** (`astream`: `wait_for(iterator.__anext__(), first_chunk_cap)`
  on every attempt). A last-attempt stall raises `asyncio.TimeoutError`, which `_chat_stream`
  already maps to `upstream_timeout` and persists as `status: 'timeout'` (#7) and alerts as
  `chat_upstream_unavailable` (P1). `test_final_attempt_first_chunk_is_uncapped` is **inverted**.
- `ainvoke` (non-stream; the browser never uses it — `js/chat.js` always sends `stream: true`): a
  first-chunk cap means nothing for a whole response, so **every** `ainvoke` attempt is capped at
  `total_timeout / MAX_MODEL_ATTEMPTS`. The 503 retry and the TTL apply identically, keeping the
  two paths symmetric (ADR-0023 §3).
- **Worst cases with defaults:** answer or error by ≈ 10.3 s (primary 503 → retry stalls 5 s →
  fallback stalls 5 s) and ≤ 15.3 s in the theoretical worst, vs 28 s measured. A primary stall
  with a healthy fallback answers at ≈ 5 s + fallback latency.

### 4.3 Primary 503 → retry the primary once

On a **`503` / `UNAVAILABLE`** from the **primary** (and only that status — 500/502/504 keep going
straight to the other model, per ADR-0023 §4.1), the chain sleeps
`PRIMARY_503_RETRY_DELAY_SECONDS` and retries the **same primary once**, wherever the primary sits
in the order. At most **one** same-model retry per turn; total attempts ≤ `MAX_MODEL_ATTEMPTS`.
Effective orders:

- normal: `primary → [primary, only after a 503] → fallback`
- fallback-preferred: `fallback → primary → [primary, only after a 503]`

The retried 503 still does **not** call `note_primary_rate_limited()` (ADR-0023 §4.3 holds). If the
retry succeeds, the turn is a success and fires `chat_primary_unavailable` (P2) as ADR-0023 §5
specifies. Reason for the retry (M, RCA §2a): the fallback is effectively dead on the prod key
(24 rate-limited vs 1 ok in 10 days), so the primary's second chance is the more likely success.

### 4.4 The fallback preference expires in minutes

`gemini_limit_state` replaces the UTC-day boolean with an expiry on a **monotonic** clock:

```python
def note_primary_rate_limited(now: float | None = None) -> None   # 429 only (unchanged trigger)
def note_primary_timed_out(now: float | None = None) -> None      # first-chunk stall (unchanged trigger)
def prefer_fallback_first(now: float | None = None) -> bool       # True iff now < expiry
```

- Each note sets `expiry = now + TTL` (a later note **extends** it; it never shortens).
- `now=None` → `time.monotonic()`; the parameter exists so tests need no clock patching.
- The `primary_*_today` **counters stay UTC-daily** — they are telemetry for the admin
  host-status card, not routing.
- State remains per container, in-process (unchanged).

ADR-0023 §4.3's principle — *stickiness is earned by the cost of re-discovery* — still holds and
is why the stall stays sticky at all; what changes is that re-discovery now costs 5 s, not 12, and
that a day was never proportionate. The 503 circuit-breaker fence of ADR-0023 §4.3 stands.

### 4.5 What does not change — invariant #9

**Commit-on-first-chunk is untouched.** Once any chunk has been yielded, the chain is committed;
mid-stream errors (503 included) propagate, with no retry and no fallback. The 503 retry, the
caps and the TTL all act **strictly before the first chunk**. Non-retryable errors still fail fast
on the first attempt (ADR-0023 §4.2). Primary and fallback ids must still differ.

## 5. DECISION 4 — The warm contract

### 5.1 Wire shape

```
POST /api/chat
content-type: application/json
x-amz-content-sha256: <hex sha256 of the exact body bytes>
{"warm": true}

→ 204 No Content          (chain configured; warm done)
→ 503 {"code":"provider_unavailable", …}   (app.state.chain is None — same as a real turn)
→ 400 {"code":"warm_with_messages", …}     (warm: true AND a non-empty messages array)
```

- `ChatRequest` gains `warm: bool = False`. The branch is the **first** thing after the
  `chain is None` check in `chat()`, before the `empty_messages` 400.
- **What it does:** calls `warm = getattr(app.state.chain, 'warm', None)` and, if callable,
  `warm()`. `GeminiRoutingChain.warm()` is synchronous and builds the genai client via
  `_text_client_singleton(self.key)` (resolving the key first, ADR-0025, when it was not resolved
  at cold start). The mock chain has no `warm` → 204 with nothing done.
- **What it must not do — each a test:** no Gemini model call (no adapter `ainvoke`/`astream`), no
  transcript persistence (it is **not a turn** under #7 and writes nothing to the #17 sinks), no
  alert, no usage log, no turn/telemetry counters, no change to the routing state. One log line,
  `chat warm`, with elapsed ms.
- `stream`, `sessionId` and `siteState` are ignored on a warm request.
- Same route, same spelling: #18 (one spelling for the streaming route) is not touched.

### 5.2 Front door

- **Digest:** the body is built and hashed through the existing `buildChatRequest(payload)` in
  `js/chat-payload-hash.js` (`buildChatRequest({ warm: true })`), which returns the exact string
  and its `x-amz-content-sha256` header. Hand-writing the header elsewhere is how a body/hash
  mismatch ships (403 `InvalidSignatureException`, ADR-0022 §7.7).
- **WAF rate rule** (300 requests / 5 min / IP, ADR-0022 §15.3): at most one warm per page load
  is negligible against it; the trigger rule below is what guarantees "at most one".
- The `/api/chat` path behavior already routes to the Function URL origin with OAC
  (`aws/chat-stream-cdn-template.yaml`); no CDN change.

### 5.3 Client trigger

A small module `js/chat-prewarm.js` exporting
`createChatPrewarm({ chatApiUrl, fetchImpl, buildRequest }) → { trigger() }`:

- `trigger()` fires **at most once per page load** (idempotent; later calls are no-ops), does
  nothing when `chatApiUrl` is empty, and never throws or surfaces UI — failures are swallowed.
- Called on the **first chat-open intent**: the first of launcher `pointerenter`, launcher
  `focus`, hero-mic / chat-open click (the panel opening). Voice benefits too: `POST
  /api/live/session` is served by the same function.
- **Known limit, accepted:** a visitor who sends within the init window of the warm lands on a
  second, cold environment (the warm one is busy). Intent-to-send gaps are normally longer than a
  2–3.5 s init.

### 5.4 Post-deploy warm

`scripts/integrate-and-deploy.sh` (called by `deploy-staging.yml` and `deploy-prod.yml`) already
sends one throwaway `GET /health` through the distribution after deploy (ADR-0022 §20.5). It is
**kept** as the health read, and a `POST /api/chat {"warm":true}` with a shell-computed digest
(`printf %s "$body" | shasum -a 256`) is sent right after it. **Best effort**: the status and elapsed
ms are echoed (that number *is* the post-deploy cold-start measurement); a non-204 is a warning,
not a deploy failure — the deep smoke is the gate.

**Honest limit (M):** the `GET /health` throwaway already existed when the 9–10 s first-after-deploy
cold starts were measured, so a post-deploy warm alone does not fix them — a later visitor can land
on a fresh environment that lazily pulls uncached layers. The **base-image pin (§6)** is the
load-bearing fix for that; the warm makes the first environment cheap and verifies the POST/digest
path end to end.

## 6. DECISION 5 — Pin the base images by digest

`docker/chat/Dockerfile.lambda-stream`:

```dockerfile
FROM python:3.12-slim@sha256:<digest>
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0@sha256:<digest> /lambda-adapter /opt/extensions/lambda-adapter
```

- Keep the tag beside the digest for humans; the digest is what resolves.
- **A test** (`node --test` or pytest, reading the file) asserts every `FROM` and `COPY --from=`
  image reference in `Dockerfile.lambda-stream` carries `@sha256:` + 64 hex.
- **Bumping:** a deliberate commit. Resolve the new digest with
  `docker buildx imagetools inspect python:3.12-slim` (linux/amd64 manifest list digest), edit the
  line, deploy to stage, read the post-deploy warm's elapsed ms, then promote. Security patches are
  the reason to bump; there is no automatic bump today (no `.github/dependabot.yml`). Adding a
  Dependabot `docker` entry for `/docker/chat` is a reasonable follow-up, **not** decided here.
- **Not decided here, recorded:** the RCA's ~52 MB pip layer is rebuilt on every deploy. Pinning
  fixes the base layers only; making the pip layer reuse a prior layer (registry build cache) is a
  separate measurement-led change.

## 7. Tests and probes this ADR requires (for the test-writer)

- `test/voice-turn-gate.test.mjs`: the §3.2 table, every cell; especially `idle` +
  `localInterrupt` stays accepting, and `streaming` + `localInterrupt` cancels until
  `turnComplete`.
- Wiring (`test/voice-turn-gate-wiring.test.mjs` or a new `test/barge-in-wiring.test.mjs`):
  `sendUserText` and the open-session mic tap stop playback and route through `interruptAssistant`;
  the single-door source assertion; the cold path calls `getUserMedia` **before** the greeting's
  `turnComplete`; the enqueue epoch race.
- `docker/chat/tests/test_gemini_routing.py`: 5 s default; cap on the last attempt; cap ≤ 0.6 ×
  total / 3; 503 primary retry-once (both orders, never twice, no stickiness); TTL expiry via
  `now=`; `0` disables; commit-on-first-chunk still holds.
- Warm route: 204; no adapter call; no persistence; `warm_with_messages` 400; 503 when no chain.
- `scripts/qa/voice-stage-probe.mjs:129-134` asserts the **regression** today (*"mic requested only
  AFTER the greeting"*, *"greeting is not interrupted"*). It must be **inverted**: the fake mic starts
  at once and the probe asserts `interrupted` arrives **before** the greeting's `turnComplete` when
  the fake voice speaks; plus a chip sent mid-greeting stops playback locally and its reply is
  heard (§3.2 residual).

## 8. Consequences

- Barge-in is restored on the cold path at the cost of a permission sheet over the greeting.
- One function owns "stop talking"; a new trigger is one call, and the source test catches a
  second door.
- First-token worst case drops from ~28 s to ~10–15 s; a bad minute no longer degrades the rest of
  the day; but a turn the old uncapped last attempt would have answered at 6–19 s now errors at
  5 s. That trade is the owner's decision (RCA §4) and is visible per turn as
  `status: 'timeout'`.
- Two drift items for the loop, not fixed here: invariant **#13**'s text and
  `test_final_attempt_first_chunk_is_uncapped` describe the old uncapped last attempt (marked
  amended in the invariants file); ADR-0017 §5 stays as written (shipped ADRs are not edited).

## Addendum (2026-10-24, orchestrator; rev. 2) — barge-in by voice over a fully-delivered tail

**Gap found by the tdd-critic.** Gemini Live sends audio faster than real time, so its
`turnComplete` often lands while the player still has seconds queued. At that point no server
turn is in flight, so Live has nothing to interrupt, and speaking over that tail did not stop
it. That breaks #25 by voice. A fourth `interruptAssistant` reason, `'voice_local'`, closes the
gap. It is raised from an input-transcript fragment.

**Rule, rev. 2 (rev. 1 is superseded).** Rev. 1 dated speech by when its transcript fragments
*arrived*: a new utterance began when a fragment came more than 1.5 s after the previous one.
Arrival time measures transcription lag, not speech. A question fragment that landed 2.5 s late,
after the answer's `turnComplete`, still cut the visitor's own answer (critic repro).
`VOICE_UTTERANCE_GAP_MS` is therefore dropped. **When the visitor started speaking now comes
from the local microphone**:

- **Voice onset.** In `sendMicFrame` (`js/chat-live.js`), the path that encodes every mic frame,
  each frame's RMS is computed. An onset is a frame with RMS ≥ `VOICE_ONSET_RMS` (0.02) after
  at least `VOICE_ONSET_SILENCE_MS` (400 ms) of quieter frames. The time of the latest onset is
  kept in `lastVoiceOnsetAt`.
- **Cut** (`'voice_local'`) only when **all** of the following hold:
  - an input-transcript fragment arrives. This is the confirmation, and it guards against
    echo and noise: an onset alone never cuts;
  - `lastVoiceOnsetAt > playingTurnFirstOutputAt`. `playingTurnFirstOutputAt` is set when a
    turn's first model output arrives (audio, text or transcript, in either wire shape) and
    is reset at `turnComplete`;
  - `isIdleGate`: a turn in flight is the server's to interrupt;
  - `player.isPlaying()`: with nothing queued, nothing is cut, and nothing is recorded as an
    interruption.
- The reason maps to `localInterrupt`, so an idle gate stays idle and the answer plays.
- All `voice_local` state resets at hang-up (`stopVoiceInternal`). A call ended mid-answer
  must not leave its half-finished turn standing in for the next call's first output.

**Why the threshold is 0.02.** It is about −34 dBFS, on float samples where full scale is 1.0.
`getUserMedia` already runs with `echoCancellation: true` and `noiseSuppression: true`
(`attachMicrophoneOnce`). After those, room noise and the assistant's own playback leaking
back through the speakers sit well below 0.02, while ordinary speech at laptop or phone distance
runs about 0.03–0.2. The threshold only decides *when* speech began. Whether to cut is still
gated on Live's own transcription confirming that somebody spoke, so a noise spike over the
threshold cuts nothing on its own. The 400 ms silence window is shorter than a natural pause
between sentences and longer than the gaps between syllables. Continuous speech that began
before the answer is therefore one onset, not a fresh barge-in. **Both numbers are untuned
against real devices**: the stage probe records the onset and the cut on every run, and those
measurements are what should move them.

**Pinned** in `test/barge-in-wiring.test.mjs`:
- the greeting-tail cut (both wire shapes);
- the critic's lags (0.5, 2.5 and 4 s late fragments of a question spoken before the answer:
  no cut, both wire shapes);
- an onset after the answer's first output plus a fragment cuts;
- a fragment with no onset (echo) does not cut;
- continuous speech across the answer's start is one onset;
- the root-transcript first output counts;
- speech over a still-streaming answer is the server's to interrupt;
- nothing-queued speech records no interruption;
- the cross-call reset.

The `acceptsTurnOutput` guard on noting a turn's first output has no observable effect, so no
test can pin it. Every cancel empties the player and the next `turnComplete` resets the flag.
It is kept because it states the intent: only output that plays counts.

**Probe bound.** The time from the first voiced frame to playback silence has its own bound,
`VOICE_CUT_BUDGET_MS = 1500` in `scripts/qa/voice-stage-probe.mjs`. It is separate from
`GRACE_MS`, which is counted from `interrupted`. The probe records the measured number on every
run, and it detects voice onsets with the same RMS rule as the page.
