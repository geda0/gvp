# ADR-0020 — The public chat surface: every unauthenticated sink bounds what it persists

- Status: Accepted; **extended by its own §5 addendum (2026-10-05), which refutes the headline
  of D1 and adds decisions A1-A8**. Read §5 before relying on §1-§4.
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

> **Read as a snapshot, not as current state.** This table and §2/§3 record the surface **as
> it stood before M0**, which is what this ADR reviewed. The two gaps it names as
> "Unbounded" — `toolCalls` / `transport` (F1) and `ChatRequest.sessionId` (F1b) — are
> **closed**; line numbers have since drifted by one to three lines. See §4.

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
>   front). Shape is enforced *upstream of the sanitizer*, by Pydantic: the field is
>   `list[dict[str, Any]] | None`, so a non-list, or a list holding a non-dict, is a **400**
>   `validation_error` before the route body runs. The sanitizer therefore does not defend
>   against those shapes itself — see §4.3.
> - Each surviving entry keeps **known keys only** — `id`, `name`, `args`, `response` — and
>   nothing else. This allowlist is the **union of both real producers**: the text path writes
>   `{name, args, id}` (`main.py:270-282`) and the voice client writes
>   `{id, name, args, response}` (`js/chat-live.js:986`). Dropping `response` would be a
>   silent telemetry regression, so it is in the set.
> - Entry **`name`** is **never coerced**. It is the admin tool histogram's key
>   (`contact-admin.js:373`), i.e. an *identity*, so the same "reject identities" rule as
>   D1b applies one level down: a `name` that is **missing, not a `str`, or empty after
>   stripping drops the whole entry**. Coercing it — `str(['a'*100,'b'*100])` — would mint a
>   permanent dashboard row for a tool that never ran, which is precisely the harm F1 is
>   about. A usable `name` is stripped and truncated to **60 chars**. *(This is stronger
>   than the "coerce to `str`" wording this ADR originally carried; see §4.1.)*
> - Entry **`id`** is a correlation *value* — no consumer reads it (`contact-admin.js:371-375`
>   keys the histogram on `name` alone; `js/admin.js:820` reads only `name`) — so it is
>   **truncated to 100 chars**, not dropped. The cap sits well above real provider tool-call
>   ids (<64 chars) and guarantees the identity pair `{id, name}` fits the JSON budget by
>   construction. *(Added during implementation; see §4.2.)*
> - Each entry's **serialized JSON is ≤ 2000 chars**. If an entry exceeds it, the bulky
>   members (`args`, `response`) are dropped and the entry is kept as its identity
>   (`{id, name}`) — never a truncated, unparseable JSON fragment. The tool *happened*; that
>   fact is the signal the dashboard needs, and it survives. The budget is then
>   **re-checked**, not assumed: an entry still over 2000 chars after the bulk is gone (only
>   reachable through a non-`str` `id`, which the 100-char truncation cannot touch) is
>   **dropped outright** rather than persisted over budget.
>
> The result is a bounded, shaped item: ≤10 entries × ≤2000 chars of serialized JSON, a
> 3-value `transport` key space, and an admin histogram whose transport keys can no longer
> be attacker-chosen. **Worst case, recomputed against the shipped sanitizer (2026-10-05):**
> ten maximal entries (`id` 100 chars, `name` 60 chars, `args` filling the rest of each
> entry's budget) serialize to **19 930 chars ≈ 20 KB** — **ERRATUM: 19 930 is wrong and is a
> measurement, not a bound; the checkable ceiling is `10 × 2 000 = 20 000` chars. See §5 A8** —
> the ≈20 KB figure holds, and the
> 100-char `id` cap does not lower it because `args`/`response` fill whatever identity
> leaves. Note the bound is **per turn**: `transcript_store.py:79-111` `list_append`s turns
> into one 400 KB DynamoDB item keyed by session id, so repeated worst-case turns on a
> single `sessionId` can still fill that item. Bounding the payload is not bounding the
> volume (M8).

**Rejected: reject the request (4xx) on an out-of-bounds payload.** It matches the
`too_many_messages` precedent on `/api/chat`, but this caller is a fire-and-forget beacon that
ignores the response; a 4xx would lose the legitimate half of the turn and tell the attacker
exactly where the boundary is. Sanitize-and-persist keeps the telemetry *and* the bound.
(This is about out-of-bounds **values**. A payload whose *types* do not match the model — a
non-list `toolCalls`, a non-dict entry — is still a 400, because Pydantic refuses it before
the route body runs; that pre-existing behaviour is unchanged and is what the sanitizer's
narrow signature leans on, §4.3.)

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

The shape both sides build to (the two lines at `main.py:1214-1215` — `:1215-1216` as shipped
— become the two calls). The ADR originally proposed *exporting* the constants so tests could
import them; what shipped keeps them module-private and has the tests assert each number from
the outside as behaviour, which is strictly better — a bound and the test that pins it can no
longer be changed in a single edit (§4.4):

```python
# docker/chat/app/turn_input.py — pure; no FastAPI, no boto3, no I/O
# AS SHIPPED. The bounds are module-PRIVATE constants, deliberately: the tests
# assert the numbers from the outside, as behaviour, so a bound and its test
# cannot be moved in one edit. (This ADR originally sketched them as exported
# names for tests to import — see §4.4.)
_KNOWN_TRANSPORTS        = frozenset({'live', 'relay', 'direct_google'})
_MAX_TOOL_CALLS          = 10
_MAX_NAME_LENGTH         = 60
_MAX_ID_LENGTH           = 100      # not in the original sketch; see §4.2
_MAX_ENTRY_JSON_LENGTH   = 2000
_KNOWN_TOOL_CALL_KEYS    = frozenset({'name', 'args', 'id', 'response'})

def clamp_transport(value: object) -> str: ...
def sanitize_tool_calls(value: list[dict]) -> list[dict]: ...
```

**Totality — stated precisely, because the original wording here overclaimed it (§4.3).** A
sanitizer that throws would turn a hostile payload into a 500 on a public endpoint, which is
a worse hole than the one being closed, so the requirement is real — but only one of the two
functions meets it unconditionally:

- `clamp_transport(value: object)` **is total.** Any input whatsoever returns a member of the
  known set; `None`, `''`, and a non-`str` all yield `'live'`.
- `sanitize_tool_calls(value: list[dict])` is **total only over its declared type.** It
  raises on `None`, on a bare `str`, on a list containing `None`, and on a value that will
  not JSON-serialize. The **typed signature is the honest statement of that contract**, and
  the gap is closed by the layer above rather than inside the function:
  `LiveTranscriptTurn.toolCalls` is `list[dict[str, Any]] | None`, so Pydantic answers a
  **400** `validation_error` on every one of those shapes before the route body runs, and the
  one call site passes `payload.toolCalls or []`, so `None` never arrives. **This is
  defence-in-depth missing, not a live hole** — no reachable public request reaches a raise
  today. The standing conditions: (a) this function must keep exactly one caller, behind that
  Pydantic bound — a second caller must either carry the same bound or the function must be
  made total first; (b) the 500-on-hostile-payload risk is borne by Pydantic here, so the
  `RequestValidationError` handler (`main.py:1266-1283`) is load-bearing for F1, not only for
  F1b.

**This ADR is the deliberate security review for the `main.py` edit.** The implementer is
cleared to edit `docker/chat/app/main.py` under `SECURITY_REVIEW=1` to *exactly* these three
changes, and to **nothing beyond them**:

1. Add `from app.turn_input import clamp_transport, sanitize_tool_calls`.
2. Replace the `transport = …` / `tool_calls = …` assignments at **`main.py:1214-1215`**
   (**`:1215-1216`** as shipped) with calls to those two functions (**F1**, D1).
3. Change **`main.py:162`** (**`:163`** as shipped) from `sessionId: str | None = None` to
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
- One new invariant (**#17**) enters `docs/tdd/project-invariants.md`, pinned by
  `docker/chat/tests/test_turn_input.py` (six helper-level cases), by
  `docker/chat/tests/test_turn_persistence.py` (`test_public_transcript_post_persists_a_bounded_turn`
  — the sanitizers are actually wired into the route — and
  `test_well_formed_voice_turn_persists_its_telemetry_untouched` — the "legitimate telemetry
  unaffected" bar), and by `docker/chat/tests/test_api.py::test_over_long_session_id_is_rejected_and_persists_nothing`
  for the F1b rejection. No prior invariant is edited. The exact proven-by list, including the
  cases that do **not** exist, lives with the invariant — §4.5.

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
  does not close it.** `aws/src/contact-admin.js:371-375` builds `toolHistogram` keyed by the
  persisted tool-call `name`, which arrives from the unauthenticated transcript endpoint. M0
  bounds each `name` to **60 chars** and each turn to **10 entries**, and drops any entry
  whose `name` is not a usable string (so the histogram's `'unknown'` bucket can no longer be
  driven from this sink at all) — but across many requests the key *space* of *usable* names
  is still caller-chosen, so the owner's dashboard can be made to render a long tail of junk
  tool names. Closing it properly means bucketing anything outside the known tool set to
  `'other'` on the read side, and `contact-admin.js` is a **gated** file — so it is deferred
  to M8.
  Recorded here explicitly so nobody reads "F1 is fixed" as "the histogram is clean."

### The new invariant: `docs/tdd/project-invariants.md` #17 is canonical

Invariant **#17** is appended to `docs/tdd/project-invariants.md`. **That file holds the
canonical wording; this ADR does not restate it.** An earlier revision of this section
carried a full copy of the proposed text, which then drifted from both the code and the
invariant in three ways now corrected in #17 and recorded in §4: it said `name` is
"coerced", it called both sanitizers "total", and its *Proven by* list named tests that were
never written. A second copy of a security invariant is a second thing to drift, so the copy
is gone.

The headline of #17, for readers of this ADR: *anything persisted from an unauthenticated
endpoint is bounded in count, size, and key space before it is written* — `transport`
clamped to a 3-value set, `toolCalls` ≤10 entries / known keys / `name` ≤60 chars or the
entry is dropped / `id` ≤100 chars / ≤2000 chars of serialized JSON per entry with a
re-check, and `sessionId` bounded by **rejection** (`max_length=128`, 400 `validation_error`)
on all three request models, because it becomes the DynamoDB partition key. #17 also carries
the *Implemented by* / *Proven by* / *Totality* / *Scope note* sub-bullets, where the scope
note states plainly that this bounds **payload shape and key space, not volume**, and that
M8's rate guard will be the *first* limit on `/api/chat` and `/api/live/session`.

## 4. Post-implementation reconciliation (2026-10-05)

M0 shipped over seven red/green cycles. Where the code and the decision text above disagree,
**the code is right and the text has been corrected in place**, each change pointed at from
the bullet it affects. Nothing here reverses a decision; it records where the decision was
imprecise, understated, or wrong about the tests.

1. **`name` is dropped, not coerced** (D1). The decision said "coerced to `str`, stripped,
   truncated"; the implementation drops any entry whose `name` is missing, non-`str`, or
   empty after stripping. This is the *stronger* behaviour and it is the right one for the
   same reason D1b rejects `sessionId`: `name` is the admin histogram's **key**, so coercing
   `['a'*100,'b'*100]` into `"['aaa…', 'bbb…']"` mints a 200-char dashboard row for a tool
   that never ran. "Clamp values, reject identities" applies at both levels of the payload.
2. **A 100-char `id` bound was added** (D1, D2). Not in the original sketch. `id` is a
   correlation value no consumer reads, so unlike `name` it is truncated rather than dropped
   — and the cap is what makes the identity pair `{id, name}` fit the 2000-char budget by
   construction, so the bulk-key drop never has to run just to make room for identity. The
   final re-check (drop an entry still over budget) exists because a **non-`str`** `id` —
   e.g. a large dict — is not reachable by a `str` truncation.
3. **Only `clamp_transport` is total** (D2). The original "both functions are total: any
   input … never raises" was false: `sanitize_tool_calls` raises on `None`, a bare `str`, a
   list containing `None`, and a non-JSON-serializable value. It is not a live hole —
   Pydantic's `list[dict[str, Any]] | None` answers 400 on all of those before the route body
   runs, and the call site passes `payload.toolCalls or []` — and the typed signature
   `(value: list[dict])` states that narrow contract honestly. D2 now says what is total,
   what is not, and the two conditions under which the gap stays acceptable.
4. **The bounds shipped as module-private constants** (D2), not as exported names for tests
   to import. Tests assert the numbers from the outside, as behaviour, so a bound and its
   test cannot be changed in one edit. Intentional; the sketch is corrected to match.
5. **The *Proven by* list was wrong, and that was the blocking defect.** Audited case by
   case against `docker/chat/tests/` on 2026-10-05:
   - **Real, but mis-cited.** The *behaviours* for the count cap, the oversized-entry
     identity keep, the `name` truncation, the **empty/whitespace `name` drop**, the key
     allowlist and the transport clamp all exist — the empty-name drop as one of four cases
     inside `test_tool_name_is_normalized_or_the_entry_is_dropped`, not as a test of its own.
     The list described behaviours in prose where it should have named functions, so a reader
     could not check it. #17 now names all nine functions exactly; all nine were verified to
     exist by `grep 'def <name>('`.
   - **Claimed and absent.** The four "totality" cases (`None`, a string, a list of nulls, a
     non-serializable value "each return a bounded result, never raise") did not exist — and
     the behaviour they asserted is **false** (§4.3). Removed, not relocated.
   - **Claimed in prose, now named.** "Pinned alongside the other request-validation cases
     (`test_api.py`): an over-long `sessionId` … answers 400 and persists nothing" is real;
     the test is
     `test_api.py::test_over_long_session_id_is_rejected_and_persists_nothing`, now cited by
     name.
   - **Under-cited.** Two route-level cases that genuinely prove the wiring were missing from
     the list entirely: `test_public_transcript_post_persists_a_bounded_turn` and
     `test_well_formed_voice_turn_persists_its_telemetry_untouched`. Added.
   - **Open gap, now recorded rather than claimed.** No test covers boundary refusal of a
     non-list / `None`-bearing / non-serializable `toolCalls`, nor `clamp_transport` on `''`
     / `None` / a non-`str`, nor the `'live'` and `'relay'` round-trips. #17 lists these as a
     gap.
   A security invariant that cites a test which does not exist is worse than no invariant:
   the next reader trusts it and stops checking.
6. **The ≈20 KB worst case holds.** **ERRATUM (§5 A8): the arithmetic below is wrong — 19 930
   is one hostile payload that fell 7 chars short on each of ten entries. The bound is
   `_MAX_TOOL_CALLS × _MAX_ENTRY_JSON_LENGTH` = 20 000 chars.** Recomputed against the shipped
   sanitizer: ten maximal
   entries serialize to **19 930 chars**. The `id` cap does not lower it (`args`/`response`
   fill whatever identity leaves). What the original figure left unsaid is that the bound is
   **per turn**, while `transcript_store.py:79-111` `list_append`s turns into one 400 KB
   item — now stated in D1 and in #17's scope note.
7. **Line numbers in §1–§3 are a snapshot of 2026-09-17** and `main.py` has since moved by
   one to three lines. Anchor by symbol, not by number. The load-bearing current values:
   the sanitizer import is `main.py:25`, the two call sites are `:1215-1216`, the three
   `sessionId` bounds are `:163` / `:167` / `:171`, and the `RequestValidationError` handler
   is `:1266-1283`. §1's table and §2/§3's findings are left as written — they are the
   pre-M0 state this ADR was reviewing, and F1/F1b are now closed.

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

---

## 5. Addendum — 2026-10-05: the central claim was false, and what replaces it

- Status of the addendum: **Accepted**. Decisions **A1–A8** below are additive to §"Decision";
  none reverses D1 / D1b / D2 / D3. Where a number or a claim in §1–§4 is now known wrong it is
  flagged inline with a pointer here rather than rewritten, so the original is still auditable.
- Trigger: a six-lens adversarial review of M0 refuted the headline of D1 — *"everything
  persisted from an unauthenticated endpoint is bounded in count, size and key space at the
  sink"*. It is bounded in **count** and in **serialized size per tool-call entry**. It is not
  bounded in **byte** size, in **shape**, in **turns per item**, or in key **cardinality**, and
  one caller-supplied field is a **storage sort key** that M0 never touched.
- **Every finding below was re-verified here before it was built on.** Three did not survive as
  stated; what replaced them is in §5.9. Method: the chat suite was copied to a scratch mirror
  (`docker/chat` + symlinked `data/`, `docs/`, `resume/`), baseline **124 passed**, and each
  claim exercised by mutation or by a probe through the real route with the `stub_store`
  fixture. The project tree was not modified by any probe.

### A1 — `capturedAt` is retired from the wire; the sink stamps the server's receive time

> **SHIPPED 2026-10-05, commit `2018a40`.** Within clearance and nothing more: `main.py`
> line 174 deleted, `captured_at = now_iso` at the renumbered `:1216` — two insertions, one
> deletion in the gated file. Pinned by the sort-key case in
> `docker/chat/tests/test_turn_persistence.py`, which posts the hostile `capturedAt`, asserts
> **204** (the field is *ignored*, not rejected) and brackets both the GSI sort key and the
> rendered value inside the request's own clock window. Chat suite 125 green.
> `js/chat-live.js:681` still sends the field harmlessly — settled in **A9**.

**Verified.** `POST /api/live/transcript` with `capturedAt: 'zzzzzzzzzzzzzzzz'` answers **204**
and persists that string verbatim, both as the turn's `capturedAt` and — via
`main.py:1249` `created_at=captured_at` — as the item's **`createdAt`**, which is the RANGE
key of the `byCreatedAt` GSI (`aws/template.yaml:161-166`) that the admin list queries
`ScanIndexForward: false` (`aws/src/contact-admin.js:481`). `max_length=64` (`main.py:174`)
bounds length and nothing else. `createdAt` is written `if_not_exists`
(`transcript_store.py:83`), so the first write per session id fixes it **permanently**;
`updatedAt` (`:84`, no `if_not_exists`) is re-stamped with the same caller value on every
later write.

> **Decision: `capturedAt` leaves the request model. The sink uses `datetime.now(timezone.utc)`
> and ignores any caller value.**

Why not the other two live options:

- **"Validate strict ISO-8601, fall back to server time" does not close the hole.**
  `9999-12-31T23:59:59Z` is valid ISO-8601 and sorts above every real timestamp
  lexicographically, so a format check leaves the caller in control of their own rank on
  page 1. A format check buys nothing a sort key cares about.
- **"Reject with 400" loses real turns.** The caller is
  `js/chat-live.js:671-702` — `fetch(..., { keepalive: true }).catch(() => {})`, response
  never read. A 400 is invisible to it. (This endpoint already rejects on the text fields:
  `userText` of 8 001 code points answers `400 validation_error` today, verified — an existing
  inconsistency with D1's "clamp, persist, move on", recorded under A2.)

**What the field is FOR: nothing that the server's receive time does not already supply.**
Every consumer was enumerated and each one only ever needs *when the turn happened, in
ISO-8601*: `js/admin.js:649` and `:823` render it; `aws/src/contact-admin.js:362` copies it
into `recentTurnErrors`; `contact-admin.js:755-759` sorts `recentFailures` by it
(*"lexicographic ISO-8601 works"*); `aws/src/common/daily-report.js:68` buckets a turn into an
owner-local day by it. The producer side settles it: the only client value is
`new Date().toISOString()` at send time (`js/chat-live.js:681`) — already an approximation of
receive time, differing by flight time plus an unbounded, unverifiable client clock skew — and
the **text** path has always used the server clock for the same field (`main.py:771-773`
`'capturedAt': now_iso`). A1 makes voice match text. **Nothing needs the client's capture
time; the field is retired.**

Three consequences worth naming, because each is a second blast radius of the same field:
`contact-admin.js:721-724` buckets the 30-day activity sparkline on
`String(item.updatedAt || item.createdAt).slice(0, 10)`, so junk mints a junk day bucket;
`daily-report.js:68-69` silently *excludes* a turn whose `capturedAt` does not resolve to the
report day, so a caller could make their own turns invisible to the daily digest; and an
attacker can mint unlimited new session ids, each pinning page 1, which pushes **every real
session** off the owner's first page rather than adding one junk row.

**Dependency for M8 (ADR-0021).** The retention TTL must be computed from the server clock.
Deriving `ttl` from a persisted `capturedAt` would reopen this hole one field over — a caller
who chooses the timestamp chooses the expiry.

### A2 — the free-text fields are bounded in BYTES at the sink, by clamping

**Verified.** `userText` / `assistantText` carry `max_length=8000` / `16000`
(`main.py:172-173`), which Pydantic counts in **code points**; DynamoDB charges **UTF-8
bytes**. Probed through the route: 8 000 astral-plane code points persist **32 000 bytes**.

> **Decision: `turn_input.py` gains `clamp_text(value: object, max_bytes: int) -> str` — a
> total function that truncates on a UTF-8 byte budget at a code-point boundary (never
> splitting a character) — and the sink applies it to both fields. Budgets: `userText`
> **8 000 bytes**, `assistantText` **16 000 bytes**. The existing Pydantic `max_length`
> code-point bounds stay exactly as they are, as a cheap outer guard.**

Clamping, not rejecting: these are telemetry **values**, so D1's rule applies — a truncated
transcript is a truthful weaker fact; a lost turn is not. Keeping the Pydantic numbers
unchanged means **no new 400 for any caller** and no wire-contract change at all.

Budget sizing, stated so it can be argued with: a real spoken turn is tens to hundreds of
characters, so 8 000 / 16 000 bytes is >10× headroom even for a 3-bytes-per-character script
(~2 600 characters), and the per-turn worst case falls from ~116 KB to ~44 KB. The regression,
honestly: a single voice turn carrying more than ~2 600 characters of CJK is truncated where
today it is stored whole.

**A2 is necessary and not sufficient.** At ~44 KB worst case, nine turns still exceed one
400 KB item. A3 is the part that actually closes the wedge.

### A3 — the wedge: make the refusal loud (A3.1), then make the item provably bounded (A3.2)

**Verified, with one correction.** `transcript_store.py:79-94` appends every turn with
`list_append` under **no `ConditionExpression`** and increments `turnCount` with no cap, and
`:140-144` swallows every exception into `writes_failed` + `last_error`, which surface only on
`/ready` (`main.py:519`) and the `ADMIN_API_KEY`-gated `/api/chat/host-status`. `fire_alert` is
wired **only** in `gemini_routing.py` — no persist failure has ever fired an alert. The route's
own 500 branch (`main.py:1256-1261`) is **dead code for the real store**, because
`persist_turn` never raises; the caller gets 204 either way.

The correction is the count. Measured against DynamoDB's own documented size accounting, one
maximal turn is **116 008 bytes** (`userText` 32 000 + `assistantText` 64 000 + `toolCalls`
19 723 + scaffolding), so: 3 turns = 348 421 bytes = **85 % of 409 600**, still writable;
the **4th** write is the one DynamoDB refuses. Either phrasing is true and the second is the
one to use — *three successful requests leave a session that can never accept another bounded
turn* — but "three requests exceed the limit" is arithmetically wrong, and the review's own
figure (116 318 bytes × 3 = 348 954) contradicted its own conclusion.

Severity, because it changes the priority order: the victim of a wedged session is mostly the
wedger. Session ids are `crypto.randomUUID()` (`js/chat.js:185-190`), so wedging a *stranger's*
session needs a leaked id; wedging your own at scale is a volume attack, which is M8's rate
guard, not a bounds defect. The non-adversarial case — a long or verbose legitimate voice
session losing every turn past the limit with no symptom — is the real motivation, and it is a
tail risk. So A3 ranks below A1.

> **Decision A3.1 (the part that must land): every persist failure fires an alert.**
> **AMENDED before green by §5.13 — the single shared event type specified below is
> self-defeating. Take the event-type contract from §5.13; everything else in this paragraph
> stands.**
> `transcript_store.py:140-144` calls `alerts.fire_alert` with a new event type
> `chat_transcript_write_failed` (P1 under M7's split), distinguishing
> `ConditionalCheckFailedException` ("session full" — expected, P2) from everything else
> ("writes are broken" — P1). `alerts.py`'s existing per-type cooldown
> (`CHAT_ALERT_COOLDOWN_SECONDS`, default 3600 s) makes this storm-proof, it ships dark unless
> configured (invariant #14), and `fire_alert` is safe here — it needs a running loop and
> `persist_turn`'s `except` is inside the coroutine. **This is the observability precondition
> for every other decision in this addendum**: A3.2's and A4's refusals are otherwise exactly
> as silent as the bug they replace.

> **Decision A3.2: the item is bounded by a byte budget held in the item, not by a turn count.**
> `_persist_sync` adds `bytesStored = if_not_exists(bytesStored, :zero) + :turnBytes` with
> `ConditionExpression: 'attribute_not_exists(bytesStored) OR bytesStored < :budget'`,
> `:budget` = **380 KiB**, `:turnBytes` = the serialized size of the turn being appended.
> DynamoDB evaluates `UpdateItem` atomically, so a refused write appends nothing and
> increments nothing — the item stays valid and the session simply stops accepting turns,
> loudly (A3.1).

A **count** cap was rejected as the primary bound: it cannot be both generous to real sessions
and sufficient against worst-case turns (at 44 KB/turn the count would have to be 8, which is
absurd for a conversation; at a generous 100 the size is unbounded again). A byte budget
auto-trades the two — a thrifty session gets ~150 turns, a maximal one gets ~8 — and the whole
change is inside `transcript_store.py`, which is **not** on `SECURITY_GLOB`. `bytesStored` is
an additive non-key attribute: no `AttributeDefinition`, no template change, and every existing
reader ignores it.

> **Deferred to ADR-0021 (M8): one DynamoDB item per turn.** The one-item-per-session design is
> what couples per-turn bounds to session length. Splitting it removes the coupling for good,
> but it changes the read contract (`normalizeChatItem`, the admin detail view,
> `daily-report.js`) in a gated file, so it belongs with the rest of the read-side work and not
> in a hotfix. A3.2 makes the invariant true without it.

### A4 — shape: `args` / `response` nesting depth is bounded at the sink

> **SHIPPED 2026-10-05, commit `bd84398`, chat suite 133 green — and INCOMPLETE on the identity
> key. A4 bounds `args` and `response` only, so the exact failure mode it exists to prevent is
> still reachable through a non-string `id`. That is closed by A4b, §5.14 — read it with this
> section.** Two wordings below are also reconciled with the shipped code there: constraint 1
> ("runs FIRST") and constraint 2 ("iterative, not recursive"), the second of which was
> over-specified by me.

**Verified, three ways.** `toolCalls: list[dict[str, Any]]` (`main.py:176`) constrains the
outer two levels and nothing below, and the sanitizer leaves `args` byte-identical. Probed
through the route: a **127-byte** request carrying 29 nested levels inside `args` answers
**204** and produces a persisted turn of depth 33 — depth **34** counted from the item's
`turns` attribute, against DynamoDB's documented **32**-level limit. boto3 has **no
client-side depth check** (it serialized 320 levels without complaint) and its own
`TypeSerializer` raises **`RecursionError` at depth 330** with no AWS call made. Both land in
`_persist_sync` inside `asyncio.to_thread`, and both are swallowed at `:140-144`. So there are
three silent bands: ≤33 writes; 34–~329 is refused by the service; ≥~330 never reaches it.

> **Decision: `turn_input.py` gains `_MAX_ARG_DEPTH = 6`. An entry whose `args` or `response`
> nests deeper than 6 levels gets the same treatment as an over-budget entry — the bulk keys
> are dropped and the entry is kept as its identity `{id, name}`. Depth is a shape property of
> a value, so clamp; do not drop the entry and do not reject the request.**

Two implementation constraints that are part of the decision, not details:

1. **The depth check runs BEFORE THE FIRST SERIALIZATION in `_bound_entry`.**
   *(Reconciled 2026-10-06: this originally said "runs FIRST in `_bound_entry`". As shipped it
   sits at `turn_input.py:105`, after the cheap `name` and `id` normalization and before the
   first `len(json.dumps(...))` at `:109`. Behaviour is identical — neither the `name` nor the
   `id` handling descends into the bulk keys — and "before the first serialization" is the
   constraint that is actually load-bearing, so the code is right and the wording is
   corrected.)* `json.dumps` is itself recursive, so a check placed after it can be skipped by
   the very payload it exists to stop.
2. **The walk must never descend past the limit**, so the depth bound cannot itself raise
   `RecursionError`. This is what keeps `sanitize_tool_calls` no *less* total than D2 records
   it to be.
   *(Reconciled 2026-10-06 — my own over-specification. This originally demanded an "iterative
   (explicit stack), not recursive" walk. That is **one** way to satisfy the constraint, not the
   constraint: a recursive walk that tests `depth > limit` **before** descending is bounded at
   `limit` frames and is equally safe. Verified by mutation — replacing the shipped iterative
   `_nests_deeper_than` with a depth-limited recursive one leaves the suite at **133 green**,
   including the past-the-recursion-limit case, because it bails at level 7 and never walks the
   payload. The shipped iterative version is fine and should stay; what the tests pin, correctly,
   is the property (**returns, bounded, without raising**) and not the mechanism. The shipped
   docstring at `turn_input.py:47-50` carries the same over-claim — "a recursive walk would
   raise `RecursionError`" — immediately contradicted by its own next sentence ("stops at the
   first level past the limit"). **Drift filed for the loop; it is source, so I have not touched
   it.**)*

**What survived here, recorded because it is good news:** D2's claim that no reachable public
request reaches a `raise` **holds for `args` and `response`**. Probing 29 → 20 000 levels
through the route never produced a 500 — body parsing starts refusing at ~940 levels, with
`400 {"detail":"There was an error parsing the body"}` (Starlette's own shape, not this app's
`{error, code}` envelope — a cosmetic nit, not a decision). But the margin is incidental: which
recursive step hits `sys.getrecursionlimit()` first depends on stack depth at call time, and a
`json.dumps` `RecursionError` *was* reproducible from a deeper call stack. A4 removes the
dependence on that ordering **for the two keys it walks**. ~~D2's claim holds.~~ **It does not
hold for `id` — see §5.14, where the 500 is now measured, not hypothesised.**

### A5 — `LiveTranscriptTurn.sessionId`'s bound gets a test (test-only)

> **SHIPPED 2026-10-05, commit `16eef30`** (with A6). **Independently re-verified 2026-10-06:**
> every mutation in the table under A6 now fails, including the two that previously survived —
> `_MAX_ENTRY_JSON_LENGTH` → 100 000 now fails 2, `_MAX_ID_LENGTH` → 1 966 now fails 1, the
> re-check deletion now fails 1, and deleting `max_length=128` from `LiveTranscriptTurn`
> (`main.py:171`) now fails 1. `_MAX_ARG_DEPTH` → 60 fails 2 as well. **The 50× slack is
> closed**, and the constants are deliberately not imported by the tests, so a bound and its
> test still cannot move in one edit.

**Verified by mutation:** deleting `max_length=128` from `main.py:171` leaves the suite at
**124 passed**. Deleting it from `LiveSessionRequest` (`:167`) or `ChatRequest` (`:163`) each
fail one test. So of the three bounds #17 claims, the one on the **public transcript sink** is
the unpinned one.

> **Decision: add one API-level case to `docker/chat/tests/test_api.py` — a 200-char
> `sessionId` on `POST /api/live/transcript` answers 400 `validation_error` and the recording
> store sees zero writes — the exact sibling of
> `test_over_long_session_id_is_rejected_and_persists_nothing`. No source change.**

**Did not survive as stated:** the finding called `/api/chat` "the authenticated-ish chat
path". It is not. `POST /api/chat` takes **no credential of any kind** (§1), which is precisely
why #17 caps all three models. The gap is test coverage of the transcript model, not a
misplaced bound.

### A6 — the final re-check and the two loose constants get boundary tests (test-only)

> **SHIPPED 2026-10-05, commit `16eef30`** (with A5), as
> `test_the_per_entry_json_budget_bounds_at_exactly_two_thousand_characters`,
> `test_the_tool_call_id_bounds_at_exactly_one_hundred_characters` and
> `test_an_entry_still_over_budget_after_the_bulk_drop_is_dropped_outright`. The table below is
> the **pre-fix** mutation result, kept as the record of what was wrong; see A5's note for the
> post-fix re-verification. (Minor drift for the loop: the re-check test's docstring still cites
> `turn_input.py:82-83`, which A4 moved to `:119-120`.)

**Verified by mutation**, with exact ceilings so the next reader can check them without
re-running anything:

| Mutation | Suite |
|---|---|
| delete the final re-check (`turn_input.py:82-83`) | **124 passed** |
| `_MAX_ENTRY_JSON_LENGTH` 2 000 → 100 000 | **124 passed** (fails at 100 200) |
| `_MAX_ID_LENGTH` 100 → 1 966 | **124 passed** (fails at 1 970) |
| `_MAX_NAME_LENGTH` 60 → 600 | 2 failed |
| `_MAX_TOOL_CALLS` 10 → 100 | 2 failed |
| `_KNOWN_TRANSPORTS` → accept-anything | 2 failed |

The cause is one choice: the hostile fixtures use **50 000-character** blobs — 25× the budget —
so they trip any budget below ~100 100, and the `id` ceiling is just the arithmetic of the
assertion (`{"id": "` + 1 966 + `", "name": "lookupResume"}` = exactly 2 000 chars). The two
loose constants are the two that D1 publishes a worst case from.

> **Decision: boundary cases, not magnitude cases. Three tests, all in
> `docker/chat/tests/test_turn_input.py`: (a) an entry constructed to serialize at exactly
> `2 000` chars is kept whole and one at `2 001` loses its bulk keys; (b) a 100-char `id`
> survives intact and a 101-char `id` comes back at 100; (c) the final re-check — an entry
> whose `id` is a non-`str` carrying bulk (so the 100-char truncation cannot reach it) and
> which is still over budget after `args`/`response` are gone — is **dropped**, returning an
> empty list. No source change.**

(c) is the one that matters most: it is the line that makes D1's worst case a **ceiling**
rather than an estimate, which is exactly what A8 now derives the published number from.

### A7 — key space: the cardinality half stays in ADR-0021 by construction; the collision is its own fix

**Verified.** Ten distinct 60-char tool names survive per request, and the read side re-bounds
nothing: `contact-admin.js:374` builds the per-session histogram and `:697-699` merges every
session's into `summary.voice.toolHistogram` with no cardinality cap.

> **Decision A7a: cardinality stays with ADR-0021 / M8, and the reason is structural, not
> scheduling.** Cardinality is a property *across* requests; the sink sees one request and
> cannot know the known-tool set (it is defined by the chat host's tool registry, and
> historical rows already hold free-form names). Bucketing at write time would also destroy the
> signal for a genuinely new tool. Only a reader can bound cardinality, so it belongs on the
> read side — `contact-admin.js:371-376`, bucket anything outside the known set to `'other'` —
> exactly where §"What this ADR does NOT cover" already put it. **#17's "key space" claim is
> narrowed accordingly** (A8 / §5.8): bounded in key **length**, **shape** and **count per
> request**; **not** in cardinality across requests.

> **Decision A7b: the two caller-keyed histograms are built on `Object.create(null)`.**
> Measured in node, reproducing `contact-admin.js:374` exactly: a tool `name` of `toString`
> (or `constructor`, `valueOf`, `hasOwnProperty`, …) makes the count the **string**
> `"function toString() { [native code] }11"`, and that garbage then **compounds** through the
> summary merge at `:697-699`; a name of `__proto__` **silently drops the bucket** instead.
> Two different wrong behaviours, both in a response the dashboard renders as a number.

**Did not survive as stated:** this is **not** prototype pollution. `Object.prototype` is
untouched (assigning a string to `__proto__` is a no-op), and nothing leaks between requests.
It is a key-collision bug with a wrong *value* type, scoped to the response being built.

Scope: `aws/src/contact-admin.js` is gated, so the clearance is in §5.10 — change only the four
initializers (`:327`, `:328`, `:612`, `:613`). `errorsByCode` (`:325`) and `transports`
(`:327`) are not caller-driven today (`transport` is clamped by D1; `errorCode` is
server-minted), but fixing all four is cheaper than maintaining the argument about which.

### A8 — the worst case: the later lens is right, and the number is now derived, not measured

Recomputed. **The earlier "19 930 chars, so the ≈20 KB worst case is CORRECT" pass is the
mistaken one; the docs-vs-code lens that called it arithmetically wrong is right.** 19 930 is
a measurement of one hostile payload that happened to fall 7 chars short of the budget on each
of ten entries (10 × 7 = the missing 70). It is not the bound, and publishing a measurement as
a bound is how the figure drifted in the first place.

> **Decision: the document states the bound as the arithmetic of the constants, not as a
> measurement.** For every entry the sanitizer keeps,
> `len(json.dumps(entry)) <= _MAX_ENTRY_JSON_LENGTH` — guaranteed by the final re-check at
> `turn_input.py:82-83` (pinned by A6c), not assumed. Therefore:
>
> **`toolCalls` per turn ≤ `_MAX_TOOL_CALLS × _MAX_ENTRY_JSON_LENGTH` = 10 × 2 000 =
> 20 000 characters**, and because `json.dumps` defaults to `ensure_ascii=True`, those
> characters are ASCII — so the same number is a **byte** ceiling. It is also a **DynamoDB**
> byte ceiling, because for every JSON type DynamoDB's documented accounting is ≤ its
> `json.dumps` character count: a string's UTF-8 bytes ≤ its escaped length (`\uXXXX` is 6
> chars for ≤3 bytes, a surrogate pair is 12 chars for 4 bytes); a map costs
> `3 + Σ(len(k) + 1 + v)` against JSON's `2 + Σ(len(k) + 4 + v)`; a list costs `3 + Σ(v + 1)`
> against JSON's `2 + Σ(v + 2)`; and `true` / `null` / any number literal each cost ≤ their
> printed length.
>
> **A reader checks that by multiplying two constants and reading three lines of
> `turn_input.py`. No measurement, and nothing left to drift.**

Corroboration, for the record only: a maximal payload measures 20 000 chars / **19 723**
DynamoDB bytes (≤ the ceiling, as derived), and four attempts to make nesting shape amplify
bytes past the character budget (flat lists of empty lists, of zeros, of empty maps) all came
out at **×0.99** — the derivation is tight, not lucky.

### A9 — the now-stale `capturedAt` send is removed from the frontend (added 2026-10-05, post-A1)

A1 has shipped, so `js/chat-live.js:681` sends `capturedAt: new Date().toISOString()` to a
server that ignores it.

> **Decision: remove the send. Do not keep it as proof that the ignore-unknown-fields path
> works.**

That proof is a test's job, and the test now exists: A1's sort-key case in
`docker/chat/tests/test_turn_persistence.py` posts `capturedAt` and asserts **204** plus a
server-stamped instant, which pins exactly the Pydantic tolerance that made A1 a
no-coordinated-deploy change and that **A2 and A4 will lean on again**. That test fails loudly
if anyone ever sets `model_config = ConfigDict(extra='forbid')`; a field sitting in production
code fails silently and is an active trap — the next reader of `:681` sees a timestamp being
sent and reasonably concludes it matters, which is the precise drift §4 was written to stop.
Weaker evidence, and a lie in the frontend, to keep a guarantee a test already holds.

Ungated (`js/` is unblocked by `SECURITY_GLOB`) and **bottom of the queue**: it is a tidy-up,
and leaving it costs ~30 bytes per beacon and nothing else. Bundle it with the next
`js/chat-live.js` touch rather than spending a slice on it.

### 5.9 — What did not survive verification

1. **"Three requests wedge a session"** → **four**. One maximal turn is 116 008 bytes; three
   fit at 85 % of 409 600 and the fourth write is the one refused. The defect is unchanged;
   state it as *three successful writes leave a session that can never take another turn*.
2. **"`capturedAt` is permanent because `updatedAt` is rewritten with no `if_not_exists`"** →
   the mechanism is backwards. Permanence comes from `createdAt = if_not_exists(createdAt, …)`
   (`transcript_store.py:83`): the **first** write fixes the GSI sort key forever. `updatedAt`
   (`:84`) is the one re-stamped on every write. Same conclusion, and both matter — the sort
   key is permanent *and* the displayed timestamp is re-poisoned.
3. **"`ChatRequest.sessionId` is the authenticated-ish chat path"** → `POST /api/chat` is fully
   public (§1). The finding's conclusion (the transcript model's bound is the unpinned one)
   verified exactly; its premise did not.
4. **"A tool `name` of `__proto__` corrupts the histogram"** → `__proto__` silently **drops**
   the bucket; `toString` / `constructor` / `valueOf` / `hasOwnProperty` are the ones that
   corrupt it, with a string where a number belongs, compounding through the summary merge.
   No prototype pollution anywhere.
5. **"29 levels in a 145-BYTE payload"** → reproduced at **127 bytes** with nested lists (219
   bytes with nested maps). The magnitude claim holds; the exact figure depends on the shape.
6. **"boto3's `TypeSerializer` raises `RecursionError` at roughly 330 levels with no AWS call"**
   → reproduced exactly (clean at 320, raises at 330, default `recursionlimit` 1000, no
   client-side depth check). **Survived.**
7. **D2's "no reachable public request reaches a raise today"** → **survived** (probed 29 →
   20 000 levels; body parsing refuses from ~940 before the sanitizer can recurse). A4 is
   taken anyway, because that ordering is incidental rather than designed.

### 5.10 — Clearance scope

The ungated work needs no clearance: **`docker/chat/app/turn_input.py`**,
**`docker/chat/app/transcript_store.py`**, **`docker/chat/app/alerts.py`**, every file under
`docker/chat/tests/`, and `js/chat-live.js`. Note that A3.1, A3.2 and A4 — the whole of
blocker 2 and the depth major — land **entirely ungated**.

**This addendum is the deliberate security review for the two gated files below.** The
implementer is cleared to edit them under `SECURITY_REVIEW=1` to *exactly* these changes and
nothing beyond them.

**`docker/chat/app/main.py`** (matches `SECURITY_GLOB`):

1. **A1** — **delete line 174** (`capturedAt: str | None = Field(default=None, max_length=64)`)
   and **replace line 1214** (`captured_at = (payload.capturedAt or now_iso).strip() or now_iso`)
   with `captured_at = now_iso`. Lines **1222** (`"capturedAt": captured_at`) and **1249**
   (`created_at=captured_at`) keep their current text.
2. **A2** — **lines 1208-1209 only**: wrap the two existing `.strip()` expressions in
   `clamp_text(...)` from `turn_input.py`, and extend the existing sanitizer import at
   **line 25**. Nothing else on either line.

Explicitly **not** cleared, and each needing its own review: the `max_length` values at
**171-173**, **175-176**; the route's `try` / `except` at **1246-1261**; the
`RequestValidationError` handler at **1266-1283**; the text path at **738-800**.

**`aws/src/contact-admin.js`** (matches `SECURITY_GLOB`):

3. **A7b** — four initializers, `{}` → `Object.create(null)`: **line 327** (`transports`),
   **line 328** (`toolHistogram`), **line 612** (`summary.voice.toolHistogram`), **line 613**
   (`summary.voice.transports`). **No logic change** at `:337`, `:374` or `:697-701` — the
   `(x || 0) + 1` increments are correct once the backing object has no inherited keys.

Explicitly **not** cleared here: the read-side cardinality bucketing at **371-376** (A7a — it
is ADR-0021's), the GSI query at **460-500**, and the `recentFailures` sort at **755-759**.

**`aws/template.yaml`** (gated): **no edit needed.** `bytesStored` is a non-key attribute, so
it needs no `AttributeDefinition`.

### 5.11 — Wire contract and stored rows

| Change | Breaks for the existing frontend | Old stored rows |
|---|---|---|
| **A1** retire `capturedAt` | **Nothing.** `LiveTranscriptTurn` does not forbid extra fields (verified: an unknown key answers 204), so `js/chat-live.js:681` keeps sending it and the server ignores it. No coordinated deploy, no version gate. Removing line 681 is an optional, ungated tidy-up afterwards. | No backfill needed for correctness. Any already-poisoned row keeps its junk `createdAt` and stays on page 1 until deleted — a one-time admin cleanup (delete rows whose `createdAt` does not parse as ISO-8601) is the owner's call, not a migration. |
| **A2** byte-bound the texts | **Nothing new rejects.** The Pydantic code-point `max_length` values are untouched, so every request that is accepted today is still accepted. A turn longer than the byte budget is stored truncated instead of whole. | Untouched. Rows already hold texts above the new byte budget; they stay as they are and still read fine. |
| **A3.2** `bytesStored` + condition | **Nothing.** Additive non-key attribute; no reader looks for it. | Pre-A3.2 rows have no `bytesStored`, which is why the condition is `attribute_not_exists(bytesStored) OR bytesStored < :budget` — an existing row's first post-deploy write seeds the counter from that write alone, so a row already near 400 KB can take one more turn before the budget engages. Accepted: the write is still atomic, so the worst case is one refused write that A3.1 reports. |
| **A4** depth bound | **Nothing.** No real producer nests `args` beyond 2 levels (`main.py:270-282`, `js/chat-live.js:986`). | Untouched. Rows holding deep `args` are readable; `aws/src/contact-admin.js` only reads `call.name`. |
| **A3.1** alerts | None (server-side). | None. |
| **A7b** `Object.create(null)` | **Nothing.** `JSON.stringify` of a null-prototype object is byte-identical for every well-formed name. | None — it changes how the rollup is *computed*, not what is stored. |

**No ADR-0020 decision is reversed and no migration is required.** The one breaking-ish change
is A1, and it breaks nothing because the field was never read from the caller by anything that
needed it.

### 5.12 — Priority order for implementation

Ranked by (exploitability × blast radius) ÷ cost, not by which finding was labelled a blocker.

1. ~~**A1 — `capturedAt` → server clock.**~~ **SHIPPED, commit `2018a40`.** Remote, one 204
   request, no auth, permanent, and it hit the owner's primary admin view, the GSI ordering,
   the activity sparkline and the daily digest at once. Smallest diff in the whole addendum.
2. **A3.1 — alert on persist failure**, one event type (`chat_transcript_write_failed`, P1 —
   §5.13). Ungated, tiny, and the **precondition** for the rest: without it, A3.2's and A4's
   refusals are as silent as the bug they replace. It also retroactively surfaces the depth and
   size failures already happening. **In flight (red written).**
3. ~~**A5 + A6 — the four missing tests.**~~ **SHIPPED, commit `16eef30`.** Test-only, ungated,
   no behaviour change, and A6c is what makes A8's published number a ceiling rather than a
   hope. All eight mutations re-verified failing on 2026-10-06.
4. ~~**A4 — depth bound.**~~ **SHIPPED, commit `bd84398`** — for `args` and `response`.
   Entirely inside `turn_input.py`, and it precedes A3.2 because A3.2 measures a turn's
   serialized size with `json.dumps`, which recurses on exactly the payloads A4 removes.
4b. **A4b — a non-`str` `id` drops the entry (§5.14). NEXT.** It jumps A2 and A3.2: it is the
   only remaining item that is remotely triggerable with no credential and one sub-2 KB
   request, and it is the one that currently yields a **500** on a public endpoint. Ungated,
   one early return, cannot regress a test.
5. **A2 — byte-bounded text clamp.** Shrinks the worst-case turn from ~116 KB to ~44 KB, which
   is what makes A3.2's budget generous in practice.
6. **A3.2 — the `bytesStored` condition**, plus the second event type
   (`chat_transcript_session_full`, P2) and its discriminator (§5.13). The decision that
   finally makes "bounded" true per item. Last of the bound work because it depends on 4 and is
   most useful after 5.
7. **A7b — the histogram collision.** Gated, but low exploitability (it needs a tool literally
   named `toString`) and a contained blast radius.
8. **A9 — delete the stale `capturedAt` send.** Ungated tidy-up; bundle it with the next
   `js/chat-live.js` touch rather than spending a slice.
9. **A7a — read-side cardinality bucketing.** No change now; carried by ADR-0021 / M8.
   **M7 note (§5.13):** `_PRIORITY` in `alerts.py` is a one-dict change and can land in M7 in
   any order relative to the above — nothing here waits on it, because every type this
   addendum introduces already carries exactly one priority.

Until item 6 lands, **#17 does not claim the item is bounded** — see the pending list in the
invariant. The claim and the code move together, or the invariant lies again.

### 5.13 — A3.1′ amendment (2026-10-05, pre-green): two event types, and priority belongs to the type

**The coordinator's reading is correct, and the defect is slightly worse than described.**
Verified in `docker/chat/app/alerts.py`:

- `_should_send(event_type, now)` (`:65-72`) keys `_last_sent` **on `event_type` alone**, under
  one global window from `_cooldown_seconds()` (`:57-62`, default 3600 s). One type, one
  bucket.
- **Priority does not exist in `alerts.py` at all.** It is not a parameter of `fire_alert`
  (`:80`), not in the throttle key, not in the subject (`:111` is
  `f'[chat alert · {env}] {event_type} — {summary}'`), and not in the body (`:113-120`). So
  A3.1's "`[P1]` for broken writes, `[P2]` for session full" could only have been realised by
  the *call site* baking the marker into `summary` — which is how the test came to pin it.

So a routine `session full` fire would own the bucket for an hour and silence the outage A3.1
exists to announce. Worse than masking: the P2 condition is the *frequent* one, so in steady
state the benign fire almost always wins the race.

> **Decision A3.1′ — two independently throttled event types.**
>
> | Event type | Priority | Fires on | Means |
> |---|---|---|---|
> | **`chat_transcript_write_failed`** | **P1** | any persist exception that is **not** the budget condition — the boto3-absent `RuntimeError` (`transcript_store.py:75-78`), a DynamoDB `ValidationException` (item > 400 KB, nesting > 32), `TypeSerializer` `RecursionError`, a `json.dumps` failure, IAM or throttling errors | *writes are broken* |
> | **`chat_transcript_session_full`** | **P2** | **only** `ConditionalCheckFailedException` from A3.2's `bytesStored` guard | *one session hit its byte budget; writes are healthy* |
>
> Because `_should_send` keys on the type, the two carry independent cooldowns: a session-full
> storm can never mask an outage, and an outage can never hide the fact that sessions are
> filling up.

**Discriminator constraint** (part of the decision, not a detail): branch on
`type(exc).__name__ == 'ConditionalCheckFailedException'`, **not** on
`botocore.exceptions`. `transcript_store.py` is deliberately written to survive boto3 being
absent — `:75-78` exists for exactly that — so the discriminator must not introduce an import
that can fail at module scope.

**Slice placement, which is what keeps both branches reachable: `chat_transcript_session_full`
ships with A3.2, not with A3.1.** Before the `ConditionExpression` exists there is no condition
to fail, so defining its type in A3.1 would be a branch no test can reach and the critic should
reject it. **A3.1 ships one type**; A3.2 adds the second plus the discriminator.

#### The prior-art question, settled for M7: priority is a static property OF the event type

> **One event type = one priority = one throttle bucket. If two conditions need different
> priorities, they are different event types.**

Priority and throttle key are therefore **not** independent dimensions, and must not become
them. What follows:

- **`alerts.py` needs no new dimension, and M7 is smaller than the plan's wording implied, not
  bigger.** M7 adds a module-level `_PRIORITY: dict[str, str]` and changes one f-string at
  `:111` so the subject reads `[chat alert · prod] [P1] chat_live_error — …`. No change to
  `fire_alert`'s signature, no change to `_should_send`, no change to the throttle key, and no
  call site learns its own priority. That is what "`alerts.py` subjects carry `[P1]/[P2]`"
  (`docs/plan-2026-09-port.md:250`) should mean.
- **Anti-rule, because it is the tempting alternative:** do **not** key the throttle on
  `(event_type, priority)`. One condition would get two independent cooldowns, quietly doubling
  every alert's storm budget and making invariant #14's "at most one email per event type per
  cooldown window" false.
- **Default for an unclassified type: P1 — fail loud.** A `fire_alert` added without a
  `_PRIORITY` row announces the omission in the subject line rather than filing a genuine P1 as
  routine, and the cost is bounded to one email per hour per type.
- **Verified against M7's own data, so nothing is being forced into a shape it resists.** Every
  type in the plan carries exactly one priority — `chat_live_error` P1,
  `contact_submit_error` P1, `voice_mint_failed` P1, `chat_cold_wait` P2, `chat_live_blocked`
  P2 (`docs/plan-2026-09-port.md:246-251`) — as does every type already live in
  `gemini_routing.py` (`chat_upstream_unavailable`, `chat_primary_timeout`, `chat_model_error`,
  `chat_primary_rate_limit`). The partition is **total** over the current and planned type set.
  Note that `contact_submit_error` lives on the contact side
  (`aws/src/common/site-alerts-core.js`, with its own cooldown persisted in the events table):
  the same rule must hold there, or the two halves of M7 disagree about what a priority is.
- The plan's own closing line for M7 — *"two different priorities, not one silent record"* —
  is about two different **conditions**. Under this rule that is two event types, which is
  exactly what it already lists.

#### Must the current red change? Yes — one assertion, not the structure

- **Keep exactly as written:** the event type `chat_transcript_write_failed`, and that two
  failing writes each fire it. `assert [] == ['chat_transcript_write_failed',
  'chat_transcript_write_failed']` is the right red and its expected value is **unchanged** —
  both failures in that test are generic, so both map to the P1 type.
- **Must change:** any assertion that `[P1]` (or any priority marker) appears in the `summary`
  handed to `fire_alert`. Under A3.1′ the call site does not know its own priority; `alerts.py`
  derives it from the type. Pinning it at the call site would pin the mechanism this amendment
  rejects, and M7 would then have to rewrite the test to land a one-dict change.
- **Pin instead, because this is what makes a P1 actionable:** the event type, and that
  `detail` carries the exception class name and the resolved session id. Leave the prose
  `summary` unpinned.
- **Must move, not just change:** the red as written also fabricates a
  `ConditionalCheckFailedException` and a second store to raise it. That is A3.2's condition,
  which does not exist yet — so the test currently spans two slices. **A3.1's red keeps only
  the broken-writes half**: one store, one generic exception, one fire of
  `chat_transcript_write_failed`, plus the two assertions that A3.1 is additive
  (`persist_turn` returned normally, `writes_failed == 1`). The session-full half moves to
  A3.2's red whole.
- **The free verifier, and it is a good one.** The red sets
  `CHAT_ALERT_COOLDOWN_SECONDS = '0'` "so both fires land" — which is itself a demonstration of
  the masking bug: with one shared type at the **default** 3600 s, the second fire is
  suppressed. So A3.2's two-type test must **not** zero the cooldown. Leaving it at the default
  and still seeing both alerts is exactly what proves the buckets are independent; if that test
  ever needs `'0'` to pass, the two types have been collapsed back into one and this amendment
  has been undone. Pin the decision with the default, not around it.

Also confirmed from the red run and worth recording: `persist_turn`'s swallow is intact (both
failing writes returned normally and logged at `transcript_store.py:144`), so **A3.1 is purely
additive** — it changes no existing behaviour and the `writes_failed` / `last_error` contract
is untouched. And `fire_alert` reached from nowhere in `transcript_store.py` independently
confirms §5's finding that no persist failure has ever alerted in this codebase.

### 5.14 — A4b: a non-string `id` costs the entry, decided on type and not on size

**The coordinator's gap is confirmed, and it is a live 500 on a public endpoint — not an
incidental-margin question.** `_bound_entry` keeps `id` whatever its type (it is on the
allowlist) and only touches it under `isinstance(entry_id, str)` (`turn_input.py:95-97`), while
the depth check walks `_BULK_KEYS` only (`:105`). So `id` reaches the first `json.dumps` at
`:109` with its shape intact. Reproduced against the shipped code, and then measured through
the real route with the `stub_store` fixture:

| `id` nesting | Request size | Result |
|---|---|---|
| 7 | 86 B | 204 — persisted, item depth **11** |
| 28 | 129 B | 204 — persisted, item depth **32** (at DynamoDB's documented limit) |
| 40 | 153 B | 204 — persisted, item depth **44**; the write is then **refused by DynamoDB** and swallowed |
| 330 | 734 B | 204 — persisted; `TypeSerializer` territory, **no AWS call made** |
| **500** | **1 074 B** | **`RecursionError` propagates out of the route — a 500 on an unauthenticated endpoint** |
| 900 | 1 874 B | same |
| 940+ | 1 954 B | 400 at body parsing (Starlette) |

The same depths with the payload in `args` all answer 204 at item depth **4** with the bulk
dropped — A4 working exactly as designed, one key over.

**So settle the reachability plainly, as asked: the raise IS reachable through the route, and
the margin is now demonstrably not a number.** `sanitize_tool_calls` is called at
`main.py:1218`, **outside** the route's `try` (`:1246`), so nothing catches it; under uvicorn
Starlette's `ServerErrorMiddleware` turns it into a 500. And the threshold moved between two of
my own probe harnesses — depth 500 in `args` answered **204** in the §5 A4 probe and the same
nominal depth in `id` **raises** here, because `json.dumps`'s remaining stack budget depends on
how deep the call stack already is. That is the definition of a margin you cannot rely on, and
D2 already states the stake: *"a sanitizer that throws would turn a hostile payload into a 500
on a public endpoint, which is a worse hole than the one being closed."* **The helper's
contract is what matters, and you are right about that** — but here it is not only the contract:
the ≥28-level band needs no recursion argument at all, since it is plainly persisted and then
refused by the service from a 129-byte request.

> **Decision A4b — RATIFIED as the coordinator read it: a non-`str` `id` drops the ENTRY.**
> One early return beside the `name` rule, before any serialization:
> `id` present and not a `str` ⇒ return `None`. Do **not** extend the depth walk to `id`.

**Why, with reason (1) kept, reason (2) overruled and reason (3) strengthened.**

1. **Right, and it is the whole argument: A4b chooses no new behaviour, it makes an
   already-chosen one unconditional.** `test_an_entry_still_over_budget_after_the_bulk_drop_is_dropped_outright`
   posts `{'id': {'blob': 'x'*50000}, 'name': 'lookupResume'}` and pins `[]`, and D1's own
   re-check text says an entry over budget via a non-`str` `id` "is **dropped outright**". So
   "non-`str` `id` ⇒ entry dropped" is the shipped, ADR-sanctioned outcome *whenever
   `json.dumps` survives long enough to measure it*. A4b deletes the condition. It therefore
   **cannot regress a test**: every currently-testable input gets the identical result, and the
   inputs that change are exactly the ones that today raise or over-nest.
2. **Overruled — the conclusion is right but the reason is not, and the reason is what the next
   reader will reuse.** "An identity that cannot be clamped is refused" does not apply, because
   **this ADR classifies `id` as a *value*, not an identity** — that classification (`:84-94`,
   and D1's "`id` is a correlation *value* … no consumer reads it") is the entire justification
   for truncating it instead of dropping the entry. Read literally, *clamp values* would argue
   for the third option nobody has named: **drop the `id` key and keep `{name}`**. That option
   is rejected for a concrete reason, not a definitional one — it would *change* the pinned
   behaviour in (1), requiring a shipped test to be rewritten, in order to retain a marginally
   richer histogram row for a payload **no real producer emits** (both producers always send a
   `str` `id`: `main.py:270-282`, `js/chat-live.js:986`). The correct statement of the rule is:
   **a non-`str` `id` is a value with no truthful clamp** — truncation is undefined for it,
   `str()` would mint a fake correlation id, and dropping the key alone contradicts the
   already-pinned outcome. And the symmetry that makes it obvious: **`name` is already total on
   type and therefore has no such hole** (`{'name': <3000 nested lists>}` returns `[]` cleanly,
   verified); `id` is the only allowlisted key that keeps a non-conforming type. A4b removes the
   hole by making the two identity-ish keys behave alike, not by adding a second shape check.
3. **Right, and stronger than stated: extending the walk does not even answer the question.**
   You cannot "drop the bulk" of an `id` — there is no bulk key to pop — so a depth-walked `id`
   would still force a choice between dropping the key and dropping the entry. The walk defers
   the decision instead of making it, and buys a second traversal per entry to do so. It would
   also leave the hole half-open: a depth-6 non-`str` `id` would still be persisted as a shape
   no reader expects.

**This needs a red first — run the cycle.** The case to pin, and the reason each half matters:
a non-`str` `id` nested past `sys.getrecursionlimit()` returns `[]` **without raising** (the
totality half, which is the hole), *and* a shallow non-`str` `id` with no bulk keys at all —
e.g. `{'id': {'a': 1}, 'name': 'probe'}` — also returns `[]` (the decided-on-type half, which
the existing 50 KB case cannot distinguish from decided-on-size). Both assertions are needed:
the first alone would pass if someone "fixed" it by walking `id`, and the second alone is
invisible to the recursion hole. **Ungated** — `turn_input.py` only, no `main.py` edit, so no
new clearance. **Priority: ahead of A2 and A3.2** (§5.12 item 4b) — it is the only item left in
this addendum that is remotely triggerable, needs no credential and costs one request.
