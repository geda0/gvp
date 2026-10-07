# ADR-0023 — Upstream retryability: a Gemini 503 must reach the fallback, and must NOT demote the primary

- **Status:** **Accepted (contract only — no code written by this ADR).** The contract below is
  what the test-writer builds the failing test against.
- **Date:** 2026-10-06
- **Amends:** **invariant #9** (`docs/tdd/project-invariants.md`), whose text says in terms
  *"Non-rate-limit errors are not retried."* That sentence is now wrong and is replaced — see §2.
  Invariant **#13** (first-chunk timeout → fallback) is **unchanged** and is the discriminator this
  ADR leans on (§4). Invariant **#7** (every turn persisted with its terminal status) is unchanged
  and gains a more specific `errorCode` (§6).
- **Extends:** ADR-0020 §5.13 — *one event type = one priority = one throttle bucket; a different
  outcome needs a different event TYPE, not a priority argument.* §5 applies that rule rather than
  reasoning around it.
- **Contaminates, and therefore blocks:** ADR-0022 **§18.B1** — see §7 and ADR-0022 §24.10.
- **Seam owner:** architect. **Implemented by:** the loop (test first).

---

## 1. Context — the gap, verified in code

- `is_upstream_rate_limit` (`docker/chat/app/upstream_errors.py:94-98`) is true for **HTTP 429
  only** (or a body `code` of `upstream_rate_limited`, which `upstream_error_body` emits only for
  429 / `RESOURCE_EXHAUSTED`).
- `gemini_routing.py:303-304` (`ainvoke`) and `:385-391` (`astream`) both read:
  `if not is_upstream_rate_limit(e): fire_alert('chat_model_error', …); raise`.
- Therefore a Gemini **`503 UNAVAILABLE`** ("this model is currently experiencing high demand")
  **re-raises on the first attempt**. The visitor gets `event: error` / `code: model_error`, and
  the healthy fallback `gemma-4-26b-a4b-it` is **never attempted** — even though the whole purpose
  of `GeminiRoutingChain` is to have a second model for exactly this.
- **Observed live: roughly 1 request in 3**, across two independent measurement sessions, on the
  ECS host serving prod right now.

The one-line widening of `is_upstream_rate_limit` is the wrong fix, and §3 is the reason.

## 2. DECISION 1 — the amended retry trigger (the invariant #9 change)

**The retry trigger is no longer "a rate limit". It is "a RETRYABLE upstream failure on the first
attempt", where retryable is an enumerated set (§4) that contains the rate limit as a subset.**

What stays exactly as it was, and is **not** in question:

- **Commit-on-first-chunk.** Once any chunk has been yielded, the chain is committed to that model
  and **mid-stream errors propagate** — no restart, no fallback, at any status. A 503 arriving
  mid-stream is a mid-stream error, full stop.
- **The last attempt still raises.** No third model, no loop.
- **Primary and fallback model ids must differ** (`providers.py:200-201`).
- **Non-retryable errors still fail fast** on the first attempt, with `chat_model_error`, and are
  **never** tried on the second model.

## 3. DECISION 2 — the predicate shape: a second predicate. CONFIRMED, with a name.

**Confirmed: do NOT widen `is_upstream_rate_limit`.** Add a separate predicate.

**Name: `is_upstream_retryable(exc) -> bool`.** Overruling `is_upstream_unavailable` on one
ground: the set includes 500/502/504, which are not all "unavailable", and the question the call
site asks is not a diagnosis but a **decision** — *may I try the other model?* The name should
state the decision. `is_upstream_rate_limit` keeps its exact current meaning and becomes a
**bookkeeping** predicate only.

**The call-site shape, stated precisely so the test-writer has no judgement call** (both
`ainvoke` ~`:303` and `astream` ~`:385`, identically):

```
if not is_upstream_retryable(e):
    fire_alert('chat_model_error', …); raise          # unchanged behaviour, narrower blast radius
if model_id == self.primary_id and is_upstream_rate_limit(e):
    note_primary_rate_limited()                       # QUOTA bookkeeping only — see §4
# …then the existing retry / is_last / alert path, with the alert TYPE chosen per §5
```

**A contract clause worth its own test, because it is what stops the two predicates drifting:**
`is_upstream_retryable` must be a **superset** of `is_upstream_rate_limit` — for every fixture
where the latter is true, the former is true.

**Implementation constraint, and it is a trap, not a nicety:** the predicate must key on the
**upstream status carried by the exception** (`google.genai.errors.APIError.code` / `.status`,
`httpx.HTTPStatusError.response.status_code`, or `_extract_status_code_from_chain`) — **never on
the status `upstream_error_body` returns.** `upstream_error_body` maps auth **401/403 → 502**
(`:32-37`, `:59-64`), so a predicate that tested "mapped status in (502, 503, 504)" would make an
**authentication failure retryable**. Both models share one API key (`self.key`), so that retry is
guaranteed to fail — it would double the latency of a certain failure and hide its cause.

## 4. DECISION 3 — the exact status set, and the stickiness question

### 4.1 Retryable (try the other model)

| Upstream signal | genai `status` | Retryable | Note |
|---|---|---|---|
| **429** | `RESOURCE_EXHAUSTED` | **YES** | Already is. Keeps the superset property of §3. |
| **503** | `UNAVAILABLE` | **YES** | The gap. The whole reason for this ADR. |
| **500** | `INTERNAL` | **YES** | Documented as transient; a *different model* is a strictly better retry than the same one. |
| **504** | `DEADLINE_EXCEEDED` | **YES** | The HTTP-shaped sibling of the `asyncio.TimeoutError` path that invariant #13 **already** retries. Falling back when *we* time the primary out but not when *Google* reports the deadline would be incoherent. |
| **502** | (no distinct genai status) | **YES** | Subject to §3's constraint: match the **upstream** 502, never the mapped one. |

### 4.2 Not retryable (fail fast, `chat_model_error`, raise)

- **401 / 403**, `UNAUTHENTICATED`, `PERMISSION_DENIED` — one shared key; the retry cannot succeed.
  **This is the clause most worth a test**, because it is precisely what a naive widening breaks.
- **400 / `INVALID_ARGUMENT`**, **413**, **422**, and any other 4xx — our request is wrong; a
  second model will reject it too.
- **404 / `NOT_FOUND`** — a bad model id is a configuration error and must stay loud. Masking it
  behind a silent fallback is how a half-broken deploy survives a week.
- **No extractable status** — **default deny**. Unknown is not transient.
- **Anything after the first chunk has flushed** — §2.

### 4.3 The stickiness decision: a 503 does **NOT** flip `prefer_fallback_first`

**Decided: `note_primary_rate_limited()` is called for 429 ONLY.** A 503/500/502/504 retries the
turn and leaves the daily routing preference untouched. Five reasons, in order of weight:

1. **"Sticky" here means up to 24 hours.** `gemini_limit_state._prefer_fallback`
   (`:20-27, 41-47`) resets only at **UTC midnight**, in-process, with no admin surface and no way
   to clear it but a restart. Letting a condition measured in **seconds** demote a model for the
   rest of the day is out of all proportion.
2. **The two signals say different things, and only one is predictive.** 429 /
   `RESOURCE_EXHAUSTED` is a statement about **our quota**: retrying the primary is *predictably*
   wasteful, so skipping it is a pure win. 503 is a statement about **Google's capacity in that
   instant** — and at the observed ~1-in-3 rate, **two of three requests still succeed on the
   primary.** Demoting on the first 503 throws away a 67%-healthy primary on a single sample.
3. **The costs of being wrong are asymmetric.** Wrongly demoting degrades **reply quality** for
   every later visitor that day, silently and unobservably. Wrongly keeping the primary costs
   **one extra round trip** on the ~1/3 of turns that 503 — which is exactly what the fallback is
   for, is self-limiting, and shows up per-turn as `fallbackUsed` in the transcripts.
4. **Invariant #13 is not a counter-example; it is the discriminator.** A stall costs the visitor
   the **entire first-chunk budget (12 s)** before the fallback even starts, so paying it every
   turn is intolerable and stickiness buys real latency back. A 503 **fails fast**.
   **The general rule this establishes: stickiness is earned by the cost of RE-DISCOVERY, not by
   the severity of the error.** Cheap-to-rediscover conditions are retried per request; expensive
   ones are remembered.
5. The alternative costs nothing to defer, and §6 replaces it with observability.

**What would change this decision — stated so it is falsifiable, and fenced so it cannot be done
by widening:** if 503s turn out to be **clustered** rather than independent (a sustained window
where the primary 503s on, say, >80% of attempts for minutes), then a short-lived demotion is
right. It must then be a **new, separately-expiring, seconds-to-minutes circuit breaker** —
**not** `note_primary_rate_limited()`'s daily flag — and it supersedes this §4.3 with a new ADR.
Reaching for the daily flag because it is already there is the thing this ADR forbids.

## 5. DECISION 4 — alerting: a new event type, P2. Not a priority argument.

Per ADR-0020 §5.13, priority is a static property of the event **type**, so a different outcome
needs a different type. There are three outcomes and they get three types:

| Outcome | Event type | Priority | Why |
|---|---|---|---|
| 503 on the primary, turn then **succeeds** on the fallback | **`chat_primary_unavailable`** (new) | **P2** | Sits exactly alongside the existing `chat_primary_rate_limit` and `chat_primary_timeout` (`gemini_routing.py:318-321, 288-291`) — the established shape is *one type per cause of a **successful** fallback*. |
| 503 on the **last** model too — the turn fails | **`chat_upstream_unavailable`** (existing) | **P1** | The type that already means "all chat models failed". **Today a last-model 503 wrongly fires `chat_model_error` and raises**; moving 503 into the retryable branch corrects that as a side effect. Assert it. |
| A **non-retryable** error ends the turn | **`chat_model_error`** (existing, unchanged meaning) | **P1** | Its blast radius **shrinks**, which is the point: today it fires on self-healing transient overload ~1/3 of the time, manufacturing a P1 out of a condition the system recovers from. |

**Firing `chat_model_error` on a turn that then SUCCEEDS would be a false P1** — that is the thing
to avoid, and a new type is the only correct mechanism. **Silence is also wrong**, which is why the
answer is a P2 type and not "drop the alert".

**Two honest notes for whoever implements it:**

- **The `_PRIORITY` dict ADR-0020 §5.13 decided does not exist yet** — verified: there is no
  `_PRIORITY` in `docker/chat/app/alerts.py`, and the subject line is
  `[chat alert · {env}] {event_type} — {summary}` (`:110-111`). So "P2" here is a **declaration
  about the type**, to be honoured by that dict when ADR-0020 A3.1 ships. Until then the only
  visible difference is the type name. Do not go looking for a priority to pass.
- **Throttling is already per event type** (`alerts.py:65-72`, one send per type per
  `CHAT_ALERT_COOLDOWN_SECONDS`, default 3600). So `chat_primary_unavailable` costs at most one
  email an hour, and the alert body already says counts live in the daily report — which §6 makes
  true.

## 6. Consequence of declining stickiness: the condition must become COUNTABLE

Declining a sticky demotion means declining the only record the system currently keeps of "the
primary is degraded". That debt is paid here, not later:

- **Add `note_primary_unavailable()` / `primary_unavailable_hits_today()` to
  `gemini_limit_state`**, mirroring `_primary_429_today` / `_primary_timeout_today`
  (`:41-69`) — a **counter only**, and explicitly **NOT** setting `_prefer_fallback`. The symmetry
  is deliberate: the module already distinguishes "count it" from "act on it"; this is the first
  entry that only counts.
- **Recommended companion, separately testable, NOT a prerequisite of the predicate:** give the
  retryable-overload set its own body code in `upstream_error_body` —
  **`(503, {code: 'upstream_unavailable', …})`** for {500, 502, 503, 504} — so the persisted
  `errorCode` on a failed turn (`main.py:903, 991`, invariant #7) distinguishes *upstream
  overloaded* from *model error* in the admin panel and the daily report. Verified safe: nothing in
  `js/`, `admin/` or `aws/src/` matches on the `model_error` string, and the frontend's
  wait-then-resend path already treats 502/503/504 alike, so the status change from 502 → 503 is
  inert. Keep it separate from §3's predicate, which must **not** be implemented via the mapped
  status (§3's trap).
- Between the P2 alert, the daily counter and the per-turn `fallbackUsed`, the degradation is
  visible without being sticky. **That is the trade this ADR makes: observability instead of
  state.**

## 7. Blast radius on ADR-0022 — the M-1 numbers are contaminated

**`is_upstream_rate_limit`'s 503 blind spot injected ~30% spurious failures into the ADR-0022 M-1
latency measurements.** A turn that 503s on the primary today **fails** instead of falling back, so
any sample set taken before this fix mixes "host latency" with "a self-inflicted error rate of
roughly one in three" — and the failed turns are exactly the ones that return fastest, which biases
a TTFT median *downwards* and makes the distribution bimodal rather than merely noisy.

**Consequence: every A/B number taken before the fix is contaminated and must be RE-MEASURED, not
reused.** This lands on ADR-0022 §18.B1, which was already blocked for a second, unrelated reason
(`gvp-chat-express-stage` at `desiredCount: 0`). Recorded there as **ADR-0022 §24.10**. Both
blockers must clear before B1 counts, and the fix in this ADR is the cheaper of the two.

## 8. What this ADR does NOT decide

- **No retry of the same model.** The fallback is a *different* model; this ADR adds no
  same-model retry, no backoff schedule, and no jitter. A retry loop against one overloaded model
  is a different decision and needs its own ADR.
- **No change to the first-chunk budget** or to #8's request deadline.
- **No circuit breaker.** §4.3 fences it explicitly.
- **No voice-path change.** `live_gemini.py` mints a token and the browser talks to Google
  directly (ADR-0007 Phase 1); there is no routing chain in that path to fall back within.

---

## 9. Conformance addendum — 2026-10-06, after the first two slices (no decision changed)

**This section records what shipped against the contract above and what did not. It amends no
decision; §§1–8 stand as written.** It exists because the failure mode this project keeps paying
for is a *document that outlives its facts* — ADR-0007's stale ~100 s cold-start figure survived
long enough to produce a wrong hosting conclusion, and invariant #9's own conformance paragraph had
to be rewritten within hours of being written.

**Shipped and pinned.** §2's amended trigger and §3's two-predicate shape, exactly as specified:
`is_upstream_retryable` in `upstream_errors.py:111-125`, used at `gemini_routing.py:394`
(`astream`, `f1a214d`) and `:306` (`ainvoke`, `0227545`); §4.3's separation — the quota call guarded
by `and is_upstream_rate_limit(e)` at `:401-402` / `:313-314` — pinned on both paths by `fff8bc9`
and `3daf8d7`. Suite **138 passed**. Mutation-verified clause by clause; the record lives in
invariant #9's *Proven by*, not here.

**NOT shipped, and the detail matters because the shipped half reads as if the whole ADR landed:**

- **§4.1's set is only exercised at `429` and `503`.** `500`/`502`/`504`/`INTERNAL`/
  `DEADLINE_EXCEEDED` are in the code and held by no test — the set can be shrunk to `{429, 503}`
  with the suite green.
- **§3's superset clause — the one this ADR called "a contract clause worth its own test, because
  it is what stops the two predicates drifting" — has no test.** It is the clause most at risk
  precisely because it is the one about drift.
- **§4.2 is unfenced on `ainvoke`** (no analogue of `test_astream_non_ratelimit_error_not_retried`).
- **§5 is entirely unimplemented and §6's counters do not exist.** Both retry paths still log
  `gemini rate_limited` and fire `chat_primary_rate_limit` on a 503 — a **mislabelled** alert on a
  non-quota event. `chat_primary_unavailable` (P2), `note_primary_unavailable()` and
  `primary_unavailable_hits_today()` appear nowhere in `docker/chat/app/`. The trade §6 accepted —
  *"observability instead of state"* — currently has **neither**: a retried 503 is counted nowhere
  and named wrongly.

**One finding that makes §3 *better* than it assumed, recorded because §3 named this the clause
most worth a test.** The auth trap (`upstream_error_body` maps `401/403` → `502`, and `502` is
retryable, so a predicate keyed on the *mapped* status would retry an auth failure on the same
shared key) **is** caught on the stream path today: implementing the predicate as
`upstream_error_body(exc)[0] in _RETRYABLE_UPSTREAM_CODES` fails the suite. But it is caught by
**exactly one** test, *test_astream_non_ratelimit_error_not_retried*, and only **transitively** — a
plain `RuntimeError` also maps to `502`, so the test that trips is about plain errors, not about
auth. `test_astream_first_chunk_ratelimit_falls_back` **passes** under that mutant (a 429 maps to
429, which is retryable either way), so the trap's fence is one incidental test, not two and not
deliberate. **No test anywhere in the suite uses a real `401`/`403` on a routing path, and
`ainvoke` has no fence at all.** §3's warning was right; the coverage behind it is thinner than
"the stream path already had one" suggests.

**Stale prose left by this ADR's own slices, filed for the loop, not fixed here:** the module
docstring of `gemini_routing.py` (`:14-17`), `astream`'s docstring (`:338-341`), and two places in
`tests/test_gemini_routing.py` (the module docstring and the comment at `:318-319`) all still say
the fallback happens *only* on a rate limit. Recorded as **ADR-0022 §24.9 item 16** — the project's
drift ledger for the loop — alongside item 17 (`main.py:1` and `docker/chat/README.md:1` still
advertising LangChain). Both are the same class of defect as the conformance paragraph this section
exists to correct.

**A second production defect, out of scope here, decided separately:** the fallback can be reached,
return **zero tokens**, and report `event: done` with `"reply": ""` after ~19.6 s — a *silent empty
success*, measured twice. It is not an error on any path in this ADR, so nothing in §5 would ever
fire for it. Recorded as **ADR-0024**, not as an addendum here: §§1–8 are all keyed on an
**exception carrying an upstream status**, and this failure raises nothing.
