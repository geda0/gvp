# ADR-0020 — The public chat surface: every unauthenticated sink bounds what it persists

- Status: Accepted
- Date: 2026-09-17
- Supersedes: none. **Extends** ADR-0007 (browser-direct voice — this ADR fences the public
  surface that posture created), ADR-0008 (IP-pepper HMAC + consent gate — same
  "public input is bounded/hashed before storage" rule, applied there to `/api/events`),
  and ADR-0009 §SEC-7 (the paid deep-probe cooldown).
- Seam owner: architect
- Cited by: **M0** (implements §2 F1 and §3 F1b), **M7** (alert prioritisation — an
  *extension of this ADR*, not a separate one), **M8** / ADR-0021 (rate guard, retention TTL,
  CSP, read-only admin key — see §"What this ADR does NOT cover").
- **Numbering note:** ADR-0020 is the **security & privacy review** for the 2026-09 port, and
  it covers **both** halves of that review: the bounded public sink (M0, decided here) and
  alert prioritisation (M7, which extends this ADR rather than taking a number of its own).
  M8 keeps **0021**. There is no renumbering; `docs/plan-2026-09-port.md` is being corrected
  to match by the orchestrator.

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
| `POST /api/chat` (`:823`) | **public** | `messages` ≤ `MAX_MESSAGES` = **32** (`CHAT_MAX_MESSAGES`, `:60`) → 400 `too_many_messages` (`:840`); per-message `content` ≤ `MAX_CONTENT_LEN` = **8000** (`CHAT_MAX_CONTENT_LEN`, `:61`), enforced by a **truncating** `field_validator` (`:143-156`) — oversize content is silently cut, not rejected. Wall clock: `provider_timeout_seconds` (Gemini default **28 s**, `providers.py:19-33`) — non-streaming `asyncio.wait_for` → 504 `upstream_timeout`; streaming holds one end-to-end deadline with a per-chunk `wait_for` (`:942-956`) plus a first-chunk budget (`GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS`, `gemini_routing.py:35-41`). Model fallback on a **first-chunk** rate-limit or stall (`gemini_routing.py:276-278`, `:358-371`); committed to the current model once any chunk flushes (invariants #9, #13). Alerts: `chat_primary_rate_limit` / `chat_primary_timeout` / `chat_model_error` / `chat_upstream_unavailable` via `alerts.py fire_alert` — best-effort, per-type cooldown `CHAT_ALERT_COOLDOWN_SECONDS` (default 3600 s), **ships dark** unless an alert email + `RESEND_API_KEY` are set (invariant #14). Every turn persists, ok/error/timeout (invariant #7). **Unbounded: `sessionId`** — see §3. |
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

It is not code execution or data exfiltration — it is an integrity/cost hole: poison the
owner's dashboard, bloat the table. It is cheap to close and it blocks nothing else, which is
why M0 ships it alone.

### 3. Finding F1b — `ChatRequest.sessionId` is the same defect class, one field over

Found while verifying §1. `main.py:162` declares:

```python
class ChatRequest(BaseModel):
    ...
    sessionId: str | None = None      # no max_length
```

Its two siblings — `LiveSessionRequest.sessionId` (`:168`) and `LiveTranscriptTurn.sessionId`
(`:170`) — are both `Field(default=None, max_length=128)`. `POST /api/chat` is equally
unauthenticated, and its `sessionId` is handed straight to `store.persist_turn(session_id=…)`
(`main.py:798`), where `transcript_store.py:123` does
`resolved_id = str(session_id or '').strip() or f"chat-{uuid4()}"` and uses it as the
**DynamoDB partition key `id`**.

That is F1's defect class exactly — *unauthenticated caller owns a key space* — differing only
in that the key is the item's identity rather than a histogram bucket. Fixing the two capped
siblings while leaving the uncapped one open would be arbitrary, and the field is one line
away from the F1 call site in the same reviewed file. **It is therefore pulled into M0 as
F1b**, not deferred.

Real clients are nowhere near the bound: `createSessionId()` (`js/chat.js:185-190`) returns a
`crypto.randomUUID()` (36 chars) or `chat-<ms>-<hex>` (~32 chars). 128 is ~4× headroom.

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

### D1b — `ChatRequest.sessionId` gets a Pydantic `max_length=128`, and **rejects**

> **`ChatRequest.sessionId` becomes `Field(default=None, max_length=128)`** — byte-identical
> to `LiveSessionRequest.sessionId` and `LiveTranscriptTurn.sessionId`. A **Pydantic bound on
> the model, not** a `clamp_session_id` in `turn_input.py`. Over-long ⇒ the request is
> **rejected**.

Rejecting here and clamping in D1 is not an inconsistency; it is the rule this seam runs on:

> **Clamp values; reject identities.** A telemetry *value* (`transport`, a tool-call `args`
> blob) can be clamped because a clamped value is still a truthful, weaker fact and the turn
> survives. An *identity* — a field that becomes a storage key — must never be silently
> rewritten: truncating a 5000-char id to its first 128 chars makes every caller sharing that
> prefix **collide into one partition key**, silently merging distinct sessions' turns into a
> single transcript row. That is a worse integrity outcome than the bloat we are fixing, and
> it is invisible in the admin panel. So the identity field rejects.

Two facts make rejection safe and cheap here, both verified:

- **It is a 400, not a 422.** This app installs its own `RequestValidationError` handler
  (`main.py:1265-1281`) that converts *every* Pydantic failure to
  `400 {"error": …, "code": "validation_error"}`. So the ambient concern about a 422 leaking
  out of an unauthenticated endpoint does not apply — the caller sees the same shaped 400
  that `empty_messages` / `too_many_messages` already return, and the two capped siblings have
  behaved exactly this way in production since they shipped.
- **No legitimate client can trip it** (§3: ids are 32–36 chars). A request that trips a 128
  bound is a bug or an attack, and for `/api/chat` — unlike the fire-and-forget transcript
  beacon — the caller *does* read the response, so a 400 is actionable feedback rather than a
  silently dropped turn.

**Rejected: also add a `clamp_session_id` to `turn_input.py` as defense-in-depth.** Two
mechanisms for one field means two behaviours to reason about at the same boundary, and the
clamp would only ever run on input the Pydantic bound has already refused — dead code that
invites a future reader to "simplify" by deleting the *bound* instead. One bound, one
behaviour. (`transcript_store.py:123` retains its own `or f"chat-{uuid4()}"` fallback for the
empty case; that is unchanged and still correct.)

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

**This ADR is the deliberate security review for the `main.py` edit.** The implementer is
cleared to edit `docker/chat/app/main.py` under `SECURITY_REVIEW=1` to *exactly* these three
changes, and to **nothing beyond them**:

1. Add `from app.turn_input import clamp_transport, sanitize_tool_calls`.
2. Replace the `transport = …` / `tool_calls = …` assignments at **`main.py:1214-1215`** with
   calls to those two functions (**F1**, D1).
3. Change **`main.py:162`** from `sessionId: str | None = None` to
   `sessionId: str | None = Field(default=None, max_length=128)` (**F1b**, D1b) — the same
   expression already on `LiveSessionRequest.sessionId` and `LiveTranscriptTurn.sessionId`.
   `Field` is already imported (`main.py:21`); no other import is needed, and no clamp
   function is added for this field.

Item 3 is a **one-line, one-token-wide** widening of the cleared diff onto a field in the same
reviewed file whose two siblings already carry the identical bound — it does not open a new
review surface. Any change to `main.py` beyond these three needs its own review.

### D3 — What this decision deliberately does NOT change

- **`aws/src/contact-admin.js` is not touched.** It is gated, and once the write side is
  bounded its rollup arithmetic is correct as written.
- **No schema migration, no backfill.** Rows already written keep whatever they hold; the
  bound applies from deploy forward. `toolCalls` stays a list of dicts and `transport` stays a
  string, so every existing reader (`contact-admin.js:337,371-374`, `js/admin.js:820`,
  `js/voice-resume-button.js`) keeps working unchanged.
- **No new env knobs.** The five numbers are module constants. If one ever needs tuning it
  becomes a knob then, with a migration note.
- **`POST /api/live/session` is unchanged by M0**, and `POST /api/chat` changes only by the
  one-line F1b bound. Their remaining gap is **volume**, not payload shape — that is M8's,
  and it is named below.

## Consequences

- **Closed by M0:** `POST /api/live/transcript` can no longer bloat a DynamoDB item and can no
  longer inject a key into the admin transport histogram; `POST /api/chat` can no longer be
  handed an unbounded DynamoDB partition key (F1b). Legitimate voice telemetry — a handful of
  `{id, name, args, response}` calls per turn with a known transport — passes through
  untouched, as does every real `sessionId`. That "unaffected" claim is the acceptance bar for
  the slice.
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

- **Rate / cost limiting — M8 (ADR-0021). There is no throttle underneath it today.** State
  this plainly, because the M8 plan text reads as though a gateway throttle already backs the
  rate guard up: **it does not.** The shipped chat host is ECS Express
  (`aws/chat-express-template.yaml`) — a public managed HTTPS URL fronted by an
  Express-managed ALB with **no API-Gateway-style throttle at all**. The
  `ThrottlingBurstLimit`/`RateLimit` pairs that exist in the repo are on
  `aws/chat-template.yaml:68-69` (the **Lambda-container fallback** host, not the shipped one)
  and `aws/template.yaml:67-114` (the **contact** API). So on the shipped path, M8's
  `app/rate_guard.py` will be the **FIRST** rate limit on `POST /api/chat` and
  `POST /api/live/session` — a sole defence, not a second layer. Until it lands, the only
  rate control on the highest-cost public call in the system (one paid ~3-min Live token per
  anonymous request) is its own 50 s mint timeout. Sizing, failure mode, and the decision to
  default per-IP limits to **0 = OFF** (the shared-NAT lockout concern) must all be made on
  that assumption. **Bounding a payload is not rate limiting**; nothing in this ADR makes the
  mint safe from volume abuse.
- **Alert priority — M7, which extends THIS ADR.** §1 lists *which* alerts exist and that they
  are best-effort with a 1 h per-type cooldown (invariant #14). It says nothing about
  **priority**. M7 adds the `[P1]/[P2]` split (P1 `chat_live_error`, `contact_submit_error`,
  `voice_mint_failed`; P2 `chat_cold_wait`, `chat_live_blocked`) as the second half of this
  security & privacy review — additive to this ADR's alert table, recorded by amending this
  ADR rather than by opening a new one. A `/api/live/session` mint failure firing a P1 is an
  *addition* to §1, not a contradiction.
- **Retention — M8.** Nothing here expires a transcript. M8's 180-day rolling `ttl` + DynamoDB
  TTL is the privacy half of this seam; this ADR only bounds what enters it.
- **Browser-side hardening — M8.** CSP + security headers (`customHttp.yml`) and the public
  privacy note are the visitor-facing half; the residual `script-src 'unsafe-inline'` (no build
  step) stays until the site has one.
- **Admin read/write split — M8.** `ADMIN_API_KEY` is today a single full-privilege secret; the
  optional timing-safe `ADMIN_READONLY_KEY` (sees every dashboard, 403 on every POST mutation)
  refines the gated rows in §1's table. `SMOKE_PROBE_KEY` staying a **distinct** secret is
  settled here and must survive that change.
- **The tool-name histogram stays attacker-*influenced* on the READ side — M0 bounds it, it
  does not close it.** `aws/src/contact-admin.js:371-374` builds `toolHistogram` keyed by the
  persisted tool-call `name`, which arrives from the unauthenticated transcript endpoint. M0
  bounds each `name` to **60 chars** and each turn to **10 entries**, so no single request can
  flood the histogram and no key can be huge — but across many requests the key *space* is
  still caller-chosen, so the owner's dashboard can be made to render a long tail of junk tool
  names. Closing it properly means bucketing anything outside the known tool set to `'other'`
  on the read side, and `contact-admin.js` is a **gated** file — so it is deferred to M8.
  Recorded here explicitly so nobody reads "F1 is fixed" as "the histogram is clean."

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
> The rule the seam runs on is **clamp values, reject identities**: a clamped telemetry value
> is still a truthful, weaker fact, but a field that becomes a **storage key** must never be
> silently rewritten — truncating it makes every caller sharing that prefix collide into one
> partition key, silently merging distinct sessions into one row. So the identity field is
> bounded by **rejection**: `sessionId` carries `max_length=128` on all three request models
> that own one — `ChatRequest` (`main.py:162`), `LiveSessionRequest` and
> `LiveTranscriptTurn` — because it lands as the DynamoDB partition key `id`
> (`transcript_store.py:123`). All three are unauthenticated, so all three are capped; an
> over-long id is a **400** `validation_error`, not a 422, via this app's own
> `RequestValidationError` handler (`main.py:1265-1281`). Real ids are 32–36 chars
> (`js/chat.js:185-190`), so no legitimate client can trip it.

(The appended invariant also carries the standard *Implemented by* / *Proven by* / *Scope
note* sub-bullets; the scope note restates plainly that this bounds **payload shape and key
space, not volume**, and that M8's rate guard will be the *first* limit on `/api/chat` and
`/api/live/session`, not a second layer.)

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
- **A Pydantic bound on this app yields 400, not 422.** `main.py:1265-1281` installs a
  `RequestValidationError` handler that maps every validation failure to
  `400 {"error": …, "code": "validation_error"}` (and `malformed_json` for bad JSON). F1b
  therefore introduces no new status code and no new error shape — it makes
  `ChatRequest.sessionId` behave exactly as its two already-capped siblings have in production.
- Legitimate session ids are 32–36 chars (`crypto.randomUUID()` or `chat-<ms>-<hex>`,
  `js/chat.js:185-190`), so the 128 bound has ~4× headroom and no real client can trip it.
- `POST /api/events` is on the **contact** HttpApi (`aws/template.yaml:318`), not the chat
  host, and is already bounded at 64 KiB with a 40/20 route throttle.
- The shipped ECS Express host has **no** API-Gateway throttle; the throttles in
  `aws/chat-template.yaml` cover only the Lambda-container fallback. M8's rate guard is
  therefore the *first* rate limit on `/api/chat` and `/api/live/session`, not a second one.
