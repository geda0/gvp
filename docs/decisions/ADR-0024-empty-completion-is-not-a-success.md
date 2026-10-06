# ADR-0024 — An empty completion is a FAILURE, not a success: the zero-token `done`

- **Status:** **Accepted (contract only — no code written by this ADR).** The contract in §3 is
  what the test-writer builds the failing test against.
- **Date:** 2026-10-06
- **Seam:** the chat terminal frame — `docker/chat/app/main.py` (`event: done` / the non-streaming
  `JSONResponse`) ↔ `js/chat.js` (`readSseChat`) ↔ `js/chat-reply-text.js`. **Both sides of this
  seam are individually correct and the defect lives between them**, which is why it needs a
  contract decision rather than a bug fix on one side.
- **Relates to:** **ADR-0023** (the 503 → fallback retry) — this is a *different* failure of the
  same turn and is explicitly **not** covered there: every clause of ADR-0023 is keyed on an
  **exception carrying an upstream status**, and this failure raises nothing. Recorded as
  ADR-0023 §9's closing paragraph. **Extends ADR-0020 §5.13** (*one event type = one priority =
  one throttle bucket*). Touches invariant **#7** (every turn persisted with its terminal
  `status`) — see §5.
- **Seam owner:** architect. **Implemented by:** the loop (test first).

---

## 1. Context — measured in production, twice

Observed by dev-ops on 2026-10-06, independently reproduced: a turn in which the **fallback model
is reached, returns zero tokens, and the host reports `event: done` with `"reply": ""` after
~19.6 s.** No exception is raised anywhere. The turn is a **success** on every surface the system
has:

- `_chat_stream` initializes `stream_status = 'ok'` (`main.py:946`) and only ever changes it in the
  `except asyncio.TimeoutError` / `except Exception` arms. A stream that completes with no chunks
  takes neither arm, so `saw_chunk` stays `False`, `aggregated` stays `None`, and
  `reply_text` is `''` (`:1004`).
- `sse_error` is `None`, so the generator yields the **terminal `done` frame with an empty reply**
  (`:1032-1036`) and logs `chat stream ok` (`:1037-1040`).
- `_persist_text_turn` records `status='ok'`, `outputCharCount=0` (`:1013-1027`; invariant #7 is
  satisfied — the row exists and its status is terminal, it is just the **wrong** status). The
  admin panel's `recentFailures` therefore never shows it.
- **Nothing alerts.** The only alert types on this path (`chat_model_error`,
  `chat_upstream_unavailable`, `chat_primary_rate_limit`, `chat_primary_timeout`) are all fired
  from `gemini_routing.py`'s `except` arms. There is no exception, so there is no alert, and
  ADR-0023 §5's proposed types would not fire either.
- The non-streaming path is the same hole with one fewer variable: `:919` passes a hardcoded
  `status='ok'` and `:923` returns `{"reply": reply_text, …}` with no emptiness check.

**And the frontend hides it — by design, correctly, for a different case.** `readSseChat` guards
only `if (!sawDone && !reply)` (`js/chat.js:1141`), so `sawDone=true, reply=''` returns normally;
then `deriveReplyText(reply, actions)` (`:1287`) substitutes a human line for an empty reply
(`js/chat-reply-text.js:15-37`). With **no** actions that line is
**`'I do not have a response yet. Please try again.'`** — and that substitution is *deliberate and
tested* (`test/chat-reply-text.test.mjs:48`), added because the model sometimes fires a tool with
no prose and the bare fallback "read as broken" next to the action button.

**That is the whole defect in one sentence: a by-design UX smoothing on the client swallows a
server-side failure, because the server never told the client the two cases apart.** The visitor
does not literally see nothing; they see a generic apology that is indistinguishable from a real
answer-less turn, after ~19.6 s, on a turn the system counts as a success.

## 2. Why this is a seam decision and not a one-line fix

Three places could hold the check, and only one is right:

- **The client** (`deriveReplyText` raises instead of substituting) — **rejected.** It cannot tell
  the two cases apart either; it would break the tool-without-prose case the helper exists for,
  and the server would still persist `ok` and still never alert. A failure must be classified
  where it is observable, which is the only place that knows `chunk_count`, `fallbackUsed` and the
  elapsed time.
- **The routing chain** (`GeminiRoutingChain` raises on an empty stream) — **rejected.** The chain's
  contract is *which model answered*; emptiness is a property of the **turn**, and the chain cannot
  see the actions/tool-calls that make an empty text legitimate. It would also re-enter ADR-0023's
  retry path, which is a separate decision (§6).
- **The route, at the terminal frame** — **chosen.** `_chat_stream` and the non-streaming handler
  are the exact points where text, actions and tool-calls are all in scope and the terminal
  status, the persisted row and the SSE frame are all still unwritten.

## 3. DECISION — the contract

**A turn is EMPTY, and therefore a FAILURE, when it produced no assistant text AND no action.**
Stated as the predicate the test is written against, applied identically on both paths after
finalization and **before** the terminal frame or the `JSONResponse`:

```
empty = (not reply_text.strip()) and not actions and not tool_calls
```

**The `and not actions` half is load-bearing, not defensive.** It is what preserves the
tool-without-prose turn that `deriveReplyText` was built for: a turn with an action and no prose
stays a **success** and keeps emitting `done` with an empty `reply`. Only text-less *and*
action-less turns change behavior. **A test that pins the failure without pinning this exemption
is incomplete** — it would make the résumé/navigate/contact turns fail.

Three consequences of `empty`, each separately testable:

1. **Terminal frame.** Emit `event: error` with
   **`{"error": …, "code": "empty_completion"}`** in place of `done` — the streaming path already
   has exactly this shape (`:1028-1030` yields `sse_error` and returns), and
   `js/chat.js:1128-1133` already turns an `event: error` into a visible, user-facing message.
   **The frontend needs no change to get the visible failure** (that is the point of choosing this
   spelling). Non-streaming: the same `code` in the error body with HTTP **502**, matching how
   `upstream_error_body` already reports a model-side failure.
2. **Persistence (invariant #7).** `status='error'`, `errorCode='empty_completion'`,
   `outputCharCount=0`, with `streamChunkCount` / `firstTokenLatencyMs` / `fallbackUsed` as
   observed — so the row lands in the admin panel's `recentFailures` and the failing session is
   visible in the list without opening the detail view. #7's clause is unchanged; this only
   corrects which terminal status is written.
3. **Alerting — a new event type, per ADR-0020 §5.13.** **`chat_empty_completion` (P1).** It may
   **not** reuse `chat_model_error`: the throttle bucket is the event type
   (`alerts.py` cooldown, default 3600 s), so sharing a type would let whichever cause fires first
   mask the other for the window — and these two have different diagnoses (a non-retryable
   upstream error vs. a model that answered with nothing). P1 because the visitor got no answer:
   it is a user-visible failure, which is exactly the line `chat_model_error` already draws.

## 4. The ~19.6 s is a second signal, and it is NOT this decision

The empty turn also took ~19.6 s — a zero-token stream that burned most of the first-chunk budget.
That is evidence the primary is degraded, and it belongs to **ADR-0023 §6's unpaid countability
debt** (a retried 503 is counted nowhere and alerted wrongly), not here. **This ADR sets no latency
budget and changes no deadline** (#8 is untouched). The `firstTokenLatencyMs` / `streamChunkCount`
fields already persisted by consequence 2 are what make the correlation visible later; nothing more
is decided.

## 5. The invariant: deferred ON PURPOSE, and this is the reason

The rule *"a turn that produced no text and no action is not a success"* is invariant-grade. It is
**deliberately NOT being written into `docs/tdd/project-invariants.md` by this ADR.**

The same session that produced this ADR had to rewrite invariant #9's conformance paragraph because
it had gone false, and had ADR-0020 **blocked by the critic for citing tests that did not exist.**
Adding a second unproven invariant in the same edit that removes a false claim trades one
credibility problem for another. **#18's precedent does not apply:** #18 was admitted with no test
because the regression it names is live in *infrastructure*, which the suite cannot reach. This
rule is a **pure classification at a seam** — it can be pinned by a test today, cheaply. When a
rule is cheaply testable, its home is a failing test, not a paragraph.

**So: admit it as invariant #19 in the same commit as the first failing test, not before.** Until
then this ADR is the record, and the conformance note it earns on arrival must say which of the
three consequences in §3 is pinned — each is a separate slice and the first to land does not cover
the others.

## 6. What this ADR does NOT decide

- **No retry on an empty completion.** Whether an empty primary turn should be re-attempted (on
  the same model or the fallback) is a separate decision with its own cost and latency profile —
  and ADR-0023 §8 already fences same-model retry as needing its own ADR. This ADR makes the
  failure **loud**, not **recovered**. Note the ordering consequence: if a retry is added later, it
  must sit *before* this classification, not instead of it.
- **No change to `deriveReplyText`.** The helper's tool-without-prose behavior is correct and
  stays, protected by §3's `and not actions` clause. Its no-actions branch becomes unreachable from
  the streaming success path once §3 lands; it is kept as defence in depth (and because the legacy
  JSON path at `js/chat.js:1211` can still produce an empty reply from a host that predates this
  change).
- **No voice-path change.** `/api/live/*` has no routing chain and no `done` frame; an empty voice
  turn is a different observation with a different seam.
- **No deadline, budget or alert-cooldown change.**
