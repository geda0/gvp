# Plan — port the 2026-08 sandbox session into gvp

**Source:** `~/Downloads/9.txt` — a 36k-line transcript of an 8-turn session run against a
snapshot of this repo (`portfolio.zip`) inside a sandbox. **None of that work is in this
repo.** The sandbox produced 54 commits, took the app suite 186 → 311 and pytest ~114 → 158,
and added a headless-Chromium journey harness (37 journeys) plus an admin screenshot preview.

This document reconciles that work with the *current* state of `main` and `agent`, and
sequences it into shippable milestones for the ttics loop.

---

## 0. Baseline reconciliation

| | state |
|---|---|
| `main` | app `node --test` **189 tests / 188 pass**, chat `pytest` **114 pass** |
| `agent` | main + 12 commits; net FE delta = **starfield dust-GC only** (`collectDustBand` + 2 test files) |
| ttics harness | already installed here (`.claude/tdd.config`, layers `app` + `chat`) — sandbox turn 3 item 1 is **done** |
| ADRs | repo stops at **ADR-0014**; the sandbox used **0015–0021** → we can reuse those numbers verbatim, keeping traceability with the transcript |
| `scripts/qa/` | **absent** — the journey/preview harness is new infrastructure |

Every one of the sandbox's ~23 new app test files and 7 new pytest files is absent here.

### The one real conflict: the starfield trail

Both the sandbox (turn 1) and `agent` fixed the *same* root cause, differently:

- **Root cause (agreed):** night fades trails with `destination-out rgba(0,0,0,0.22)`. Canvas
  alpha is 8-bit, so each frame does `round(a × 0.78)` — which has a fixed point:
  `round(2×0.78)=2`, `round(1×0.78)=1`. Alpha 1–2/255 **never reaches 0**, so every pixel a
  star ever crossed keeps a permanent veil that accumulates screen-wide.
- **Sandbox fix:** route the erase alpha through `starfield-prefs.js`
  (`nightTrailEraseAlphaForPreference` → `0.59`, the same tier `drawSpace()` uses), plus a pure
  `trailFramesToClear8Bit()` predicate that *proves* 0.22 stalls (`=== Infinity`) and 0.59
  clears. Free at runtime — but **it shortens night trails, i.e. it changes the look.**
- **`agent` fix (shipped there):** keep `0.22` and prod's exact look; add a rolling-band
  garbage collector (`collectDustBand` → `getImageData` over `DUST_SWEEP_ROWS` rows/frame,
  zero the stalled 1–2/255 band, `putImageData` back). Preserves the look, but adds a
  per-frame **readback** (measured ~0.2 ms in software raster; a GPU-backed canvas pays a
  pipeline sync that is not free).

The `agent` history shows two explicit reverts *because a change altered the render*
(`2d079aa`, `bf853d7`) — so "look untouched" is a settled constraint, and the sandbox's alpha
change contradicts it. **Recommendation:** keep `agent`'s GC as the shipped fix; import only
the sandbox's *test* idea (`trailFramesToClear8Bit` as a regression predicate on the stall);
then let the perf pass (M1) decide whether the readback can be narrowed or dropped.

---

## Milestones

Ordering is dependency- and risk-driven, not the sandbox's chronological order.
Each milestone = one ttics outer-loop cycle (product-owner acceptance → architect/ADR →
planner slices → red/green → tdd-critic → record).

### M0 — F1 hotfix: bound the public transcript sink  ·  ~1 slice  ·  layer `chat`

**Live vulnerability, present on `main` today.** `POST /api/live/transcript` is public and
`docker/chat/app/main.py:1215` does `tool_calls = payload.toolCalls or []` — arbitrary,
unbounded JSON straight into DynamoDB (item bloat, admin-rollup poisoning, unbounded
histogram keys); `transport` is a free string.

- Red: `docker/chat/tests/test_turn_input.py` — caps and clamps.
- Green: cap `toolCalls` to 10 entries, name ≤ 60 chars, per-entry JSON ≤ 2000 chars, known
  keys only; clamp `transport` to the known set.
- Acceptance: oversized/hostile payload persists a bounded, shaped item; existing voice
  telemetry unaffected. Ships alone, independent of everything below.

### M1 — Starfield: settle the trail fix + the pixel-identical perf pass  ·  ~6 slices  ·  `app`

Depends on: the decision in §0. Assumes "keep `agent`'s look".

1. Merge `agent`'s dust-GC into the working branch as the shipped trail fix.
2. Add the sandbox's pure predicate `trailFramesToClear8Bit(eraseAlpha, start)` to
   `js/starfield-prefs.js` + `test/starfield-reduced-motion.test.mjs`: pin that 0.22 stalls
   (`Infinity`) so the stall can never silently return, and that the GC's floor is what
   collects it.
3. **Cull off-canvas stars** — new `js/starfield-geom.js` + `test/starfield-geom.test.mjs`:
   `starIsOffCanvas` over the bounding box of the glow disc + streak segment, padded 1 px for
   AA/round caps. The sandbox measured **~36 % of stars drawn entirely off-screen** at 1080p;
   the canvas clipped every one of those pixels anyway, so this is exact.
4. **One cached unit radial gradient per palette colour**, scaled into place with
   `setTransform`, instead of `createRadialGradient` per star per frame.
5. **Precompute streak colour strings** in the palette (was 2 `String.replace` allocations per
   star per frame); **drop per-star `save()/restore()`**, set `lineWidth`/`lineCap` once in a
   shared `drawStars()` used by all three draw paths; move `move`/`show` to `Star.prototype`
   (no per-star closures).
6. Re-measure the dust-GC readback with the star pass ~50 % cheaper; decide whether
   `DUST_SWEEP_ROWS` can shrink.

**Sandbox evidence to reuse:** the perf pass was verified **pixel-identical** — deterministic
`Math.random`, N frames, `getImageData` diff of old vs new at hours 2/7/12/19/23 and
reduced-motion: **0 differing pixels**. That is exactly the bar the two `agent` reverts were
protecting, so this work is safe where the alpha change was not.

**Measured deltas (sandbox A/B, medians):** night 1080p/4-core JS 3.15 → 1.59 ms/frame
(−49 %), 1440p/8-core 9.42 → 4.15 (−56 %), dusk 3.19 → 1.85 (−42 %), reduced-motion 1.14 →
0.32 (−72 %), day unchanged (noise). Main-thread gains are diluted by the full-screen
composite, which is inherent and stays.

**Deliberately not applied** (documented, not built): cached unit *linear* gradient for
streaks (another ~0.5 ms but ±1–2/255 on fringe pixels — not pixel-identical); batching
streaks-then-discs (changes blend order); sprite stars, dirty-rect clears, `desynchronized`.

### M2 — Assistant yields the stage + site awareness  ·  ~16 slices  ·  `app` + `chat`  ·  ADR-0015

The big one. Today the chat is a modal that blocks the site, and the assistant's own tools
close it.

**Root cause (confirmed in the transcript):** `app.js` calls `collapseChatDialog()` on every
navigation, and `contact.js`/`projects.js` fire a collapse event; `closePanel → snapClose →
stopVoice`. So `navigate_to_section` / `open_contact_form` tore down the window *and the live
voice session* that had just promised the action.

- `js/site-state.js` — one observable store (section / project / contactOpen / chatLayout /
  voiceActive) fed by nav, projects, contact, chat. Replaces the `site-chat-collapse` event.
- `js/chat-dock.js` — pure reducer `closed | modal | docked | minimized`. First open = focused
  panel; `navigate` / `project-open` → docked bottom-right (≥768 px) or minimized pill
  (<768 px); `contact-open` → pill; Escape while docked minimizes. Docked card: no backdrop,
  no scroll lock, `aria-modal=false` → **the site stays operable.**
- **"Confirmed but never executed" — three causes, all fixed:** (a) the teardown above;
  (b) `navigateToSection` exact-matched ids, so `"Portfolio"` / legacy `playground` silently
  failed *after* the model said "taking you there" → `resolveNavTarget` normalises + legacy
  map; (c) the Live-mode path. Plus `inferPromisedNavigation` as a safety net, and tool
  results that carry the resulting `siteState` so the model can self-verify.
- **Site awareness:** `/api/chat` and `/api/live/session` accept `siteState`; one "Current site
  state" system line folds into the model input / live instruction; visitor-driven changes
  during a live session push a `clientContent` note (`turnComplete:false`, deduped — the
  journey suite caught the double-notify).
- New tests: `site-state`, `chat-dock`, `chat-navigation`, `voice-navigation-intent`,
  `chat-site-context` (app); `test_site_state`, `test_site_state_api`, `test_live_site_state`,
  `test_guide_tool_contract` (chat).
- **Includes the journey harness** (`scripts/qa/chat-stage-journeys.py`, headless Chromium):
  dock/minimize/pill, contact/project, "site events never call stopVoice", request-body
  assertions, live context notes. It starts here and grows every later milestone — most of
  this plan's UX claims are only checkable through it.

### M3 — Daytime precipitation by season  ·  ~4 slices  ·  `app`  ·  ADR-0016

Independent of M2 — **can run in parallel.** Today the daytime theme only has snow, but snow
is a winter thing.

- `js/precipitation.js`: `seasonFor`, `isHailDay` (deterministic 1-in-9 shoulder-season days),
  `precipitationFor` (winter → snow, spring/autumn → hail-or-rain, summer → rain,
  hemisphere-aware).
- Tiers in `starfield-prefs.js` (`precipitationCountForPreference`); `starfield.js` draws rain
  as batched streaks and hail as pellets + tails beside the existing snow.
- Tests: `test/precipitation.test.mjs` + prefs tiers; clock-pinned screenshots per kind.

### M4 — Assistant everywhere  ·  ~11 slices  ·  `app` + `chat`  ·  ADR-0017

Depends on M2.

| Symptom | Cause | Fix |
|---|---|---|
| Assistant unreachable with a project open | project dialog `z 1100` > chat `1095` | chat `1105` / pill `1106`; ≥1100 px the dialog shifts left beside the docked card (`hasRoomBesideDialog`), else pill |
| No project context or offers | state carried only a title | `siteState.project {id,title}` → `projectId` on the wire; backend attaches the knowledge-pack summary |
| Tools stop at sections | — | `open_project` / `close_project` (id/title fuzzy via `project-ref.js`) on text **and** voice; prompt **1.7.0** |
| Mic prompt cuts the greeting | cold path attached the mic right after sending the greeting | `micAttachPlan`: cold + assistant-speaks-first ⇒ attach after the first `turnComplete` (15 s fallback); warm ⇒ now |
| Dead top-bar input while a chat is active | — | launcher renders an "Assistant active / Voice live" chip that restores + focuses |

- Voice-first **project chips** (`🔊 Summarize · 🔊 Tell me more · 🔊 Just talk about it`) with
  an explicit audio affordance, a quote-selection toggle, and a text-chat option; **selection
  offers** on highlighted text (quote goes to the model only on an explicit tap).
- **Admin re-visualised, not extended**: a new "Assistant" tab — KPI strip (conversations with
  voice split, turns split, toned failure rate, review queue) → "Assistant in the site"
  4-step journey with conversion %, facets (opened-from, voice-from, mic outcomes, tools,
  content) → voice & tools → failures. New route
  `GET /api/contact/admin/assistant-usage?days=` over an SDK-free core.
- New tracking: `chat_open{surface}`, `chat_live_start{source,intent}`,
  `chat_mic_permission{state}`, `chat_tool_call{tool,ok,source}`, `project_assistant_chip`,
  `selection_assistant_offer|chip`, `chat_launcher_resume`.
- Adds `scripts/qa/admin-dashboard-preview.py` (screenshot checks of the dashboard).

### M5 — Component split, FE + BE  ·  ~4 slices  ·  both layers  ·  ADR-0018

Depends on M2–M4 (it relocates their files). Mirrors ttics' own libs → components → harness
shape:

```
js/lib/          physics (projection/cull + kinematics), rain (engine, prefs)
js/components/   assistant/ · theme/ · hero/ · admin/
js/             app.js + shell (navigation, projects, contact, site-state, analytics, …)

docker/chat/app/ models/ (switchable model layer) · voice/ (Live) · assistant/ (knowledge,
                 site_state, providers) · main.py + lambda_handler.py (harness) · leaf infra
aws/src/admin/   SDK-free cores; Lambda entries only wire
```

Enforced by `test/component-boundaries.test.mjs` + `docker/chat/tests/test_component_boundaries.py`
(lib → lib only; components never import each other except at declared seams; `app/models`
never imports assistant/voice/main; admin stands alone).

> **Sequencing option:** because we are re-implementing rather than replaying, M2/M4 could
> create their files directly at their M5 addresses, turning M5 into docs + boundary tests.
> Cheaper, but it front-loads a layout decision before the modules exist. See decisions.

### M6 — Chat host scale-to-zero + activation  ·  ~5 slices  ·  `app` + infra  ·  ADR-0019

Independent of M2–M5 — **can run in parallel.** The ECS Express chat host runs 24/7
(`MinTaskCount` default `1`) though it is stateless and idle most hours.

- Pure policy `aws/src/common/chat-warm-core.js`: `decideActivation` (cold → pin min 1 +
  desired 1; running-unpinned → pin), `decideIdleScaleIn` (no heartbeat ≥ 20 min → min 0 +
  desired 0), `readinessFrom`, `runActivation` / `runIdleSweep` with injected clients.
- Lambda `aws/src/chat-warm.js` + template: `POST|GET /api/warm` (public, throttled), idle
  sweep every 10 min, **pre-warm at 11:50 UTC** so the 12:00 daily report's deep probe meets a
  warm host; IAM scoped to `service/*/portfolio-chat-*`; service discovered via SSM.
- FE cold path (`js/lib/warm/warm-client.js`): activation beacon on page load (direct, not
  through the 4 s event buffer) + 5-min heartbeat while chat/voice is live; 502/503/504 →
  "Assistant is waking up (~1 min)" and the message resends automatically.
- Admin Health card shows host state (always-on / scaled-to-zero / starting / warm); "Run deep
  probe" warms and waits first.
- **Blast radius (investigate before building, per the transcript):** FE text chat and the
  voice mint see ALB 503 while a task starts; admin/report probes fail on an idle host;
  Express's own autoscaler can scale an *active* low-CPU conversation back to 0 → activation
  **must pin `MinCapacity=1`**; cold start ≈ 60–90 s.
- **Ships opt-in** (`CHAT_SCALE_TO_ZERO=1`); rollback = redeploy without the flag.

### M7 — Prioritised alerts  ·  ~4 slices  ·  `app` + `chat`  ·  ADR-0020

Depends on M6 (for `chat_cold_wait`). Today visitor-side failures are *recorded* silently and
only surface in the daily report.

- `aws/src/common/site-alerts-core.js`, wired into events-ingress → existing alarm SNS topic:
  **P1** `chat_live_error` (voice failed to start), **P1** `contact_submit_error`;
  **P2** `chat_cold_wait` (visitor waited on a waking host), **P2** `chat_live_blocked`.
  Per-type cooldown (default 1 h, persisted in the events table) so a storm is one ping.
- `alerts.py` subjects carry `[P1]/[P2]`; `/api/live/session` mint failures/timeouts fire a
  **P1 `voice_mint_failed`** (previously only model-fallback paths alerted).
- New FE event `chat_cold_wait`; journey J8d pins it.

This is precisely the "voice requested and the user waits" vs "voice failed to start" split
asked for in the source session — two different priorities, not one silent record.

### M8 — Hardening backlog + admin attention strip  ·  ~8 slices  ·  both  ·  ADR-0021

1. **H3/S1 — Gemini key via SSM SecureString `Secrets`** on the ECS task instead of a readable
   env literal; scoped execution-role read; default on, `CHAT_GEMINI_KEY_VIA_SSM=0` to opt out
   while validating on stage.
2. **H2/S3 — cost guard** (`app/rate_guard.py`): **global** sliding-window caps only by default
   (120 chat/min, 30 paid mints/10 min) → `429 + Retry-After` + a P2 alert when engaged; stats
   in `/ready`. **Per-IP limits exist but default 0 (OFF)** and are tested to never touch a NAT
   neighbour or an empty IP — the shared-NAT / ALB lockout concern from the source session is
   honoured by construction, not by tuning.
3. **H1/S4 — transcript retention**: every write refreshes a `ttl` (180 d after the *last*
   turn; `0` disables); DynamoDB TTL on the table.
4. **H4/S2 — CSP + security headers** via Amplify `customHttp.yml` (site + admin), pinned by
   `test/security-headers.test.mjs`. *Residual:* `script-src 'unsafe-inline'` stays while the
   site has no build step.
5. **H5/S5 — public privacy note**: footer link → plain-words dialog (what the assistant
   stores, 180-day retention, no audio stored, mic only when needed, hashed-IP analytics).
6. **H6/S6 — optional read-only admin key** (`ADMIN_READONLY_KEY`, timing-safe): sees every
   dashboard; every POST mutation answers 403 without the full key.
7. **H7 — admin "Attention" strip**: a pure `attentionItems()` view-model above the tabs,
   ranked bad → warn → info, built from data already loaded (contact failures & DLQ, pipeline
   alarm, failing chat turns + latest error code, review queue, mic denials, tool errors, host
   scale state, usage context), each row with an "Open" button that jumps to the owning tab;
   "All clear" when nothing needs attention. Concise and actionable **above** the analysed
   detail, per the brief.

---

## Cross-cutting

- **ADRs:** reuse 0015–0021 as numbered above; invariants #17–#26 land with their milestones.
- **Docs:** `docs/architecture.md` (stage, site-awareness, precipitation, alerts, perf note),
  `docs/components.md` (M5), `docs/review-2026-08.md` + `docs/security-review-2026-08.md`
  (port as records), runbook sections for scale-to-zero and the new env knobs, and
  `secrets.example/deploy.env.example` for every new knob.
- **Suites:** expect app 189 → ~310 and pytest 114 → ~158 when the whole plan lands.
- **Branch:** build on `agent` (staging hosts), promote with the documented safe sequence —
  merge `--no-ff`, re-pin prod hosts with `scripts/sync-site-api-urls.mjs`, then
  `GVP_EXPECTED_ENV=prod node --test test/frontend-api-url-env-guard.test.mjs` **before** push.
  Never `--ff-only` (Amplify serves `main`'s HTML as-is → staging-host leak).

## What cannot be verified here (carry as gated)

- **A real Gemini Live voice pass** — greeting uninterrupted by the deferred mic prompt, voice
  chips, navigation while speaking. Human, on staging. Gates M2/M4 to prod.
- **ECS Express with `MinTaskCount=0`** — that desired-count 0 is accepted and that
  `RegisterScalableTarget` on its scalable target is permitted. Gates M6 to prod.
- **The `Secrets` reference on an Express service** + real cold-start UX timing. Gates M8.1.

## Accepted residuals (from the source session, still true here)

- CSP `script-src 'unsafe-inline'` — the no-build site ships inline boot scripts; removing it
  needs a build step or nonces.
- No IP allowlisting on admin — same lockout concern; throttles + a high-entropy key instead.
- `chat.js` (~2k lines) — splitting it is cosmetic; deferred, and journey-covered either way.

## Decisions — resolved 2026-09-17 (navigator)

1. **Starfield look: keep `agent`'s dust-GC.** 0.22 and prod's exact render stay. The sandbox's
   erase-alpha change is **not** taken; only its `trailFramesToClear8Bit` predicate lands, as a
   regression test that the stall can never return. M1 is therefore perf-only on top of the GC.
2. **Scope: all of M0–M8.**
3. **M5: address-first.** M2/M4/M6 write their files directly at their `js/lib`,
   `js/components`, `app/models|voice|assistant` and `aws/src/admin` addresses; M5 shrinks to
   ADR-0018, `docs/components.md` and the two boundary tests.
4. **Parked cosmetics stay as proposed** — chat opens focused-then-yields; hail cadence 1-in-9.

Baseline at plan time, on `agent`: app **203 tests / 202 pass**, chat **114 pass**.
