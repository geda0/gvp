# ADR-0020 — The public chat surface: every unauthenticated sink bounds what it persists

- Status: Accepted
- Date: 2026-09-17
- Supersedes: none. **Extends** ADR-0007 (browser-direct voice — this ADR fences the public
  surface that posture created), ADR-0008 (IP-pepper HMAC + consent gate — same
  "public input is bounded/hashed before storage" rule, applied there to `/api/events`),
  and ADR-0009 §SEC-7 (the paid deep-probe cooldown).
- Seam owner: architect
- Cited by: **M0** (implements §F1), **M7** (alert priorities extend the alert table in §1),
  **M8** (rate guard, retention TTL, CSP, read-only admin key extend §Consequences).
- **Numbering note:** `docs/plan-2026-09-port.md` ("Cross-cutting") pencilled **0020 → M7**
  and **0021 → M8**. This ADR takes **0020** — the security/privacy seam M0 needs *now* and
  that M7/M8 both cite. M7 and M8 shift to **0021** and **0022**. The plan doc is the
  orchestrator's to update; no shipped ADR is edited.

## Context

The chat host is a public, unauthenticated service. ADR-0007 moved voice browser-direct, so
the browser now posts its own telemetry back to us: the host both *serves* anonymous visitors
and *accepts writes* from them. Nothing in the repo states, in one place, which endpoints are
open and what bounds each one — so every later hardening slice (M7's alert priorities, M8's
rate guard / TTL / CSP / read-only admin key) has been re-deriving the surface by reading
`main.py`. This ADR fixes the surface as a contract, records the one open sink that is
currently unbounded, and clears the minimal edit that closes it.

### 1. The public surface contract (verified against code, 2026-09-17)

Everything below is on `docker/chat/app/main.py` unless noted. "Public" = **no credential of
any kind** is checked; the only gate is CORS (`CHAT_CORS_ORIGINS`, never `*`), which restricts
*browsers*, not `curl`.

| Endpoint | Auth | Bounds that hold today |
|---|---|---|
| `POST /api/chat` (`:823`) | **public** | `messages` ≤ `MAX_MESSAGES` = **32** (`CHAT_MAX_MESSAGES`, `:60`) → 400 `too_many_messages` (`:840`); per-message `content` ≤ `MAX_CONTENT_LEN` = **8000** (`CHAT_MAX_CONTENT_LEN`, `:61`), enforced by a **truncating** `field_validator` (`:143-156`) — oversize content is silently cut, not rejected. Wall clock: `provider_timeout_seconds` (Gemini default **28 s**, `providers.py:19-33`) — non-streaming `asyncio.wait_for` → 504 `upstream_timeout`; streaming holds one end-to-end deadline with a per-chunk `wait_for` (`:942-956`) plus a first-chunk budget (`GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS`, `gemini_routing.py:35-41`). Model fallback on a **first-chunk** rate-limit or stall (`gemini_routing.py:276-278`, `:358-371`); committed to the current model once any chunk flushes (invariants #9, #13). Alerts: `chat_primary_rate_limit` / `chat_primary_timeout` / `chat_model_error` / `chat_upstream_unavailable` via `alerts.py fire_alert` — best-effort, per-type cooldown `CHAT_ALERT_COOLDOWN_SECONDS` (default 3600 s), **ships dark** unless an alert email + `RESEND_API_KEY` are set (invariant #14). Every turn persists, ok/error/timeout (invariant #7). |
| `POST /api/live/session` (`:1043`) | **public** | `sessionId` ≤ 128 chars. Mint bounded by `GEMINI_LIVE_MINT_TIMEOUT_SEC` (default **50 s**) → 504 `live_mint_timeout`; 503 when the corpus or `GEMINI_API_KEY` is missing. **This is the highest-cost public call in the system:** each success mints one real, single-use Google Live ephemeral token (~3 min) — a *paid* resource — and returns it to an anonymous caller. There is **no** per-caller limit, counter, or cooldown on it. |
| `POST /api/live/transcript` (`:1185`) | **public** | 503 when no store is configured; 204 when both texts are empty. Bounded: `userText` ≤ 8000, `assistantText` ≤ 16000, `capturedAt` ≤ 64, `intent` ≤ 16 **and** clamped to `{cold, warm, None}` (`:1216-1218`), `turnDurationMs` 0…30 min, `audioInBytes`/`audioOutBytes` 0…200 MiB, `interrupted` bool. **Unbounded: `toolCalls`, and the value space of `transport`** — see §2. |
| `POST /api/events` (`aws/template.yaml:318`) | **public** | **Not on the chat host** — it is the contact HttpApi's `EventsIngressFunction`. Bounded by `MAX_BODY_BYTES` = 64 KiB (`aws/src/events-ingress-core.js:12,25`), written in ≤25-item `BatchWrite` chunks, caller IP hashed with `IP_HASH_PEPPER` (ADR-0008). Route throttle 40 burst / 20 rate (`aws/template.yaml:111-114`). Recorded here because M7 wires its alerts through this ingress. |
| `GET /health` (`:462`) | **public** | Returns `{"ok": true}` and nothing else — no state, no probe, constant cost. |
| `GET /ready` (`:550`) | public status, **secret-gated body** | The status code (200/503) is always visible; the full JSON (provider, model id, corpus, transcript-store counters) is emitted only when `CHAT_READY_VERBOSE=1` **or** `?verbose=1&token=<CHAT_READY_VERBOSE_SECRET>` matches under a length check + `secrets.compare_digest` (`:533-548`). Ungated body is `{"ok": bool}`. |
| `GET /api/chat/smoke` (`:655`) | **key-gated** (`x-smoke-key` / `SMOKE_PROBE_KEY`, `hmac.compare_digest`, `:618-630`) | A **probe-scoped secret, deliberately distinct from `ADMIN_API_KEY`**, because `?deep=1` mints a real paid Live probe: a leaked admin key alone must not buy Live sessions. The deep tier is cooled down server-side by `SMOKE_DEEP_MIN_INTERVAL_SEC` (default 60 s) → 429 + `Retry-After`; `?report=1` bypasses the cooldown for the trusted once-daily digest (ADR-0009 §SEC-7). Never raises — a failed probe is a `fail` check with status 200. |
| `GET /api/chat/host-status` (`:590`) | **key-gated** (`ADMIN_API_KEY`) | Operational counters + provider/model/voice-preset only; no transcript content. |
| `GET /api/live/probe` (`:1130`) | **secret-gated** (same rule as `/ready` verbose) | Returns **404**, not 401, when not allowed — the endpoint does not advertise itself. It mints a real Live session, so it is correctly not public. |

**Front-door note (load-bearing for M8).** The shipped host is ECS Express
(`aws/chat-express-template.yaml`) — a **public managed HTTPS URL with no API-Gateway-style
throttle in front of it**. The `ThrottlingBurstLimit`/`RateLimit` settings in
`aws/chat-template.yaml:68-69` apply only to the *Lambda-container* fallback host, and those
in `aws/template.yaml:67-114` only to the contact API. So on the shipped path there is **no
infrastructure rate limit** on `/api/chat` or `/api/live/session`; the in-process timeouts and
the smoke cooldown are the only rate control that exists. Closing that gap is M8's job
(`app/rate_guard.py`), and this ADR is the surface it must cover.

### 2. Finding F1 — the public transcript sink is unbounded

`POST /api/live/transcript` is public, and `main.py:1215` does:

```python
tool_calls = payload.toolCalls or []
```

The model (`main.py:169-183`) declares
`toolCalls: list[dict[str, Any]] | None = Field(default=None)` — **no bound on entry count,
entry keys, or entry content** — and `transport: str | None = Field(default=None, max_length=32)`,
which bounds the *length* of the string but not its *value space*. Both flow straight into the
persisted turn (`:1219-1230`) and into DynamoDB via `transcript_store.persist_turn`.

Downstream, `aws/src/contact-admin.js:337` does:

```js
transports[transport] = (transports[transport] || 0) + 1
```

and `:371-374` does the same for each tool-call `name` into `toolHistogram`. So an anonymous
caller controls **histogram keys in the admin rollup** (unbounded cardinality in a response the
owner's dashboard renders) and **DynamoDB item size** (unbounded nested JSON per turn — which
is also unbounded retention cost and unbounded read cost for every admin query that touches
that session). The known transport set is exactly `live | relay | direct_google`
(`contact-admin.js:327`); anything else is, by construction, junk or an attack.

This is the one *live* hole on `main` today. It is not code execution or data exfiltration —
it is an integrity/cost hole: poison the owner's dashboard, bloat the table. It is cheap to
close and it blocks nothing else, which is why M0 ships it alone.

## Decision

### D1 — The sink sanitizes what it persists (the contract)

> **Everything persisted from an unauthenticated endpoint is bounded in count, size and key
> space at the sink, before the write.** For `POST /api/live/transcript` that means:
>
> - **`transport`** is clamped to the known set `{'live', 'relay', 'direct_google'}`. Any
>   other value — unknown, empty, wrong type — becomes **`'live'`**. The request is **not**
>   rejected: this is fire-and-forget telemetry from a `keepalive` fetch
>   (`js/chat-live.js:671-700`); dropping a real turn to punish a bad field is the wrong
>   trade. Clamp, persist, move on.
> - **`toolCalls`** is capped at **10 entries** (excess dropped, order preserved from the
>   front); a non-list becomes `[]`; non-dict entries are dropped.
> - Each surviving entry keeps **known keys only** — `id`, `name`, `args`, `response` — and
>   nothing else. This allowlist is the **union of both real producers**: the text path writes
>   `{name, args, id}` (`main.py:270-282`) and the voice client writes
>   `{id, name, args, response}` (`js/chat-live.js:986`). Dropping `response` would be a
>   silent telemetry regression, so it is in the set.
> - Entry **`name`** is coerced to `str`, stripped, truncated to **60 chars**; an entry whose
>   `name` is empty after stripping is dropped (it carries no signal and would land in the
>   admin histogram as `'unknown'`).
> - Each entry's **serialized JSON is ≤ 2000 chars**. If an entry exceeds it, the bulky
>   members (`args`, `response`) are dropped and the entry is kept as its identity
>   (`{id, name}`) — never a truncated, unparseable JSON fragment. The tool *happened*; that
>   fact is the signal the dashboard needs, and it survives.
>
> The result is a bounded, shaped item: ≤10 entries × ≤2000 chars ≈ 20 KB worst case for
> `toolCalls`, a 3-value `transport` key space, and an admin histogram whose transport keys
> can no longer be attacker-chosen.

**Rejected: reject the request (4xx) on an out-of-bounds payload.** It matches the
`too_many_messages` precedent on `/api/chat`, but this caller is a fire-and-forget beacon that
ignores the response; a 4xx would lose the legitimate half of the turn and tell the attacker
exactly where the boundary is. Sanitize-and-persist keeps the telemetry *and* the bound.

**Rejected: sanitize on the read side (`contact-admin.js`).** It would leave the table
bloated, leave every other reader exposed, and require editing a **gated** file for a problem
that belongs at the write boundary. Bound it where it enters.

### D2 — Placement: a new pure leaf module, `docker/chat/app/turn_input.py`

`docker/chat/app/main.py` matches `SECURITY_GLOB` in `.claude/tdd.config`
(`(^|/)docker/chat/app/(main|lambda_handler|live_env|live_gemini)\.py`), so **every** edit to
it is blocked in every phase unless `SECURITY_REVIEW=1` is set after a deliberate review.
`turn_input.py` does **not** match the glob.

> **The sanitizing logic lives in a NEW pure leaf module `docker/chat/app/turn_input.py`: no
> FastAPI, no boto3, no I/O, no `app.state`** — importable and unit-testable on its own,
> sitting alongside `alerts.py` / `transcript_store.py` / `upstream_errors.py` as leaf infra.
> `main.py` gains **one import and one call site** and nothing else.

The shape both sides build to (the two lines at `main.py:1214-1215` become the two calls; the
constants are exported so tests pin the numbers, not magic literals):

```python
# docker/chat/app/turn_input.py — pure; no FastAPI, no boto3, no I/O
KNOWN_TRANSPORTS   = frozenset({'live', 'relay', 'direct_google'})
DEFAULT_TRANSPORT  = 'live'
MAX_TOOL_CALLS     = 10
MAX_TOOL_NAME_LEN  = 60
MAX_TOOL_CALL_JSON = 2000
TOOL_CALL_KEYS     = ('id', 'name', 'args', 'response')

def clamp_transport(value: object) -> str: ...
def sanitize_tool_calls(value: object) -> list[dict[str, Any]]: ...
```

Both functions are **total**: any input — `None`, a string, a deeply nested dict, a list of
nulls, a value that will not serialize — returns a valid, bounded result and never raises. A
sanitizer that can throw would turn a hostile payload into a 500 on a public endpoint, which
is a worse hole than the one being closed.

**This ADR is the deliberate security review for that `main.py` edit.** The implementer is
cleared to edit `docker/chat/app/main.py` under `SECURITY_REVIEW=1` to *exactly* this change —
add `from app.turn_input import clamp_transport, sanitize_tool_calls`, and replace the
`transport = …` / `tool_calls = …` assignments at `main.py:1214-1215` with calls to them — and
to **nothing beyond it**. Any other change to `main.py` in the same slice needs its own review.

### D3 — What this decision deliberately does NOT change

- **`aws/src/contact-admin.js` is not touched.** It is gated, and once the write side is
  bounded its rollup arithmetic is correct as written.
- **No schema migration, no backfill.** Rows already written keep whatever they hold; the
  bound applies from deploy forward. `toolCalls` stays a list of dicts and `transport` stays a
  string, so every existing reader (`contact-admin.js:337,371-374`, `js/admin.js:820`,
  `js/voice-resume-button.js`) keeps working unchanged.
- **No new env knobs.** The five numbers are module constants. If one ever needs tuning it
  becomes a knob then, with a migration note.
- **`POST /api/chat` and `POST /api/live/session` are unchanged by M0.** Their gaps are named
  below and belong to M8.

## Consequences

- **Closed by M0:** `POST /api/live/transcript` can no longer bloat a DynamoDB item and can no
  longer inject a key into the admin transport histogram. Legitimate voice telemetry — a
  handful of `{id, name, args, response}` calls per turn with a known transport — passes
  through untouched. That "unaffected" claim is the acceptance bar for the slice.
- **Visible change (flag for the test-writer / PO):** a turn that today would persist 200 tool
  calls persists 10, and one that would persist a 50 KB `args` blob persists the entry without
  `args`. No real client produces either.
- **`main.py`'s diff stays reviewable:** one import + two call sites, all logic in an ungated,
  directly unit-testable leaf. Future bounds (below) land in the same module with **no**
  further `main.py` edit and therefore **no** further security review.
- One new invariant (**#17**, wording below) enters `docs/tdd/project-invariants.md`, pinned by
  `docker/chat/tests/test_turn_input.py`. No prior invariant is edited.

### What this ADR does NOT cover

Named so later work **extends** this ADR instead of contradicting it:

- **Rate / cost limiting — M8.** `POST /api/live/session` mints a paid ~3-min Live token per
  anonymous call, with no counter and (on ECS Express) no infrastructure throttle. M8's
  `app/rate_guard.py` owns this: global sliding-window caps by default (120 chat/min, 30 paid
  mints/10 min) → `429 + Retry-After`, per-IP limits present but defaulting to **0 = OFF** (the
  shared-NAT lockout concern). **Bounding a payload is not rate limiting**; this ADR does not
  claim to make the mint safe from volume abuse.
- **Alert priority — M7.** §1 lists *which* alerts exist and that they are best-effort with a
  1 h per-type cooldown (invariant #14). It says nothing about **priority**. M7 adds the
  `[P1]/[P2]` split (P1 `chat_live_error`, `contact_submit_error`, `voice_mint_failed`;
  P2 `chat_cold_wait`, `chat_live_blocked`) — additive to this ADR's alert table. A
  `/api/live/session` mint failure firing a P1 is an *addition* to §1, not a contradiction.
- **Retention — M8.** Nothing here expires a transcript. M8's 180-day rolling `ttl` + DynamoDB
  TTL is the privacy half of this seam; this ADR only bounds what enters it.
- **Browser-side hardening — M8.** CSP + security headers (`customHttp.yml`) and the public
  privacy note are the visitor-facing half; the residual `script-src 'unsafe-inline'` (no build
  step) stays until the site has one.
- **Admin read/write split — M8.** `ADMIN_API_KEY` is today a single full-privilege secret; the
  optional timing-safe `ADMIN_READONLY_KEY` (sees every dashboard, 403 on every POST mutation)
  refines the gated rows in §1's table. `SMOKE_PROBE_KEY` staying a **distinct** secret is
  settled here and must survive that change.
- **Cardinality of `toolHistogram` keys.** M0 bounds tool-call `name` **length** (60) and
  **count per turn** (10), so the histogram can no longer be flooded from one request — but the
  key *space* is still caller-influenced across many requests. Bucketing unknown names to
  `'other'` requires a read-side (gated) change; deferred to M8, recorded here so it is not
  mistaken for an oversight.
- **`ChatRequest.sessionId` is unbounded.** `main.py:162` declares
  `sessionId: str | None = None` with **no `max_length`**, unlike `LiveSessionRequest.sessionId`
  and `LiveTranscriptTurn.sessionId` (both 128). It becomes the DynamoDB partition key `id`
  (`transcript_store.py:123`). Found while verifying this surface; it is **not** part of the F1
  decision and **not** covered by this ADR's `main.py` clearance. Filed for the loop — the
  natural home is a `clamp_session_id` in the same `turn_input.py` (an additive extension of
  this contract, so no new ADR is needed) landing with M8's hardening.

### Exact new invariant wording (appended to `docs/tdd/project-invariants.md` as #17)

> **Anything persisted from an unauthenticated endpoint is bounded in count, size, and key
> space before it is written.** `[chat]` Public sinks may not hand caller-controlled structure
> to storage: `POST /api/live/transcript` (no credential of any kind) clamps `transport` to
> `{'live','relay','direct_google'}` — unknown ⇒ `'live'` — and sanitizes `toolCalls` to ≤10
> entries, known keys only (`id`/`name`/`args`/`response`), `name` ≤60 chars (empty ⇒ entry
> dropped), and ≤2000 chars of serialized JSON per entry (over ⇒ keep `{id,name}`, drop the
> bulk) before `persist_turn`. Unbounded values are not merely an item-size problem:
> `aws/src/contact-admin.js:337,371-374` builds `transports` / `toolHistogram` keyed **by the
> persisted value**, so an anonymous caller would otherwise own the key space of the owner's
> admin rollup. The sanitizers are **total** — any input returns a bounded result, never an
> exception (a throwing sanitizer turns a hostile payload into a 500 on a public endpoint) —
> and they **clamp rather than reject**: the turn still persists, because the caller is a
> fire-and-forget `keepalive` beacon that never reads the response (`js/chat-live.js:671-700`).

## Confirmations recorded

- `docker/chat/app/main.py` **is** on `SECURITY_GLOB`; `docker/chat/app/turn_input.py` is
  **not**. The sanitizer therefore lands ungated and the reviewed `main.py` diff is one import
  + two call sites. **This ADR is that review.**
- The tool-call key allowlist is the **union of both real producers** — text
  (`main.py:270-282`: `name`/`args`/`id`) and voice (`js/chat-live.js:986`:
  `id`/`name`/`args`/`response`). A `{name, args, id}`-only allowlist would silently drop
  `response` from every real voice turn and break the "existing voice telemetry unaffected"
  acceptance bullet.
- The known transport set `live | relay | direct_google` is confirmed on **both** sides — the
  FE sends `lastLiveVoiceTransport || 'live'` (`js/chat-live.js:682`), the mint stamps
  `liveVoiceTransport = 'direct_google'` (`main.py:1105`), and the admin rollup names exactly
  those three (`aws/src/contact-admin.js:327`).
- `POST /api/events` is on the **contact** HttpApi (`aws/template.yaml:318`), not the chat
  host, and is already bounded at 64 KiB with a 40/20 route throttle.
- The shipped ECS Express host has **no** API-Gateway throttle; the throttles in
  `aws/chat-template.yaml` cover only the Lambda-container fallback. M8's rate guard is
  therefore the *first* rate limit on `/api/chat` and `/api/live/session`, not a second one.
