# Progress / handoff log (READ THIS to continue work)

> Updated by the orchestrator every cycle. This is how any agent resumes cold.

## Current status

- **2026-10-23 — PROMOTION BLOCKER, verified: the privacy note must not reach `main` yet.**
  ADR-0021 D4 states the rule; this is the measurement behind it.

  `aws dynamodb describe-time-to-live` on both transcript tables, just now:
  ```
  page-ChatTranscriptsTable-19J8X0K9P03AJ          TimeToLiveStatus = DISABLED
  page-staging-ChatTranscriptsTable-1XSZI611F4WDM  TimeToLiveStatus = DISABLED
  ```
  So **TTL is off in prod and in stage**. M8 item 3 adds a `ttl` attribute on new writes
  (`transcript_store.py`, via `#ttl` because TTL is a DynamoDB reserved word) and enables
  TTL on the table — but until BOTH are deployed to prod, the footer's privacy note would
  tell visitors their transcripts are kept 180 days while DynamoDB keeps them forever.
  A promise the system does not keep is worse than no promise, and this one is about
  people's conversations.

  **UPDATE, same day, after M8's deploy to stage — the two environments have diverged:**
  ```
  page-staging-ChatTranscriptsTable-1XSZI611F4WDM   ENABLED   attribute `ttl`
  page-ChatTranscriptsTable-19J8X0K9P03AJ           DISABLED  (unchanged)
  ```
  Stage's TABLE now honours `ttl`; prod's does not. But stage's chat functions still do not
  WRITE the attribute, because that deploy died on the IAM deny — so stage is currently a
  table that would expire rows nobody is stamping. Harmless (nothing expires), and worth
  knowing: a table showing ENABLED is NOT evidence the retention promise is kept. Both
  halves are needed, and on prod neither is there yet.

  **The rule, for the promotion checklist:** `js/privacy-note.js` and its footer entry may
  not reach `main` until (1) the `#ttl` writer is deployed to the prod chat host AND
  (2) `TimeToLiveStatus` reads `ENABLED` on `page-ChatTranscriptsTable-*`. Re-run the
  describe-time-to-live above as the check; do not take a green suite or a successful
  deploy as evidence, because the table setting is not in the suite's reach.

  Note the ordering trap: the TTL attribute is written on NEW rows only, with no backfill
  (D3), so enabling TTL does not retroactively bound the rows already there. The note's
  wording should be true of the data that exists, not only of the data written after the
  deploy — worth a second look at the copy before promotion.

- **2026-10-23 — STAGE IS DEPLOYED AND VERIFIED (frontend + backend). Two CI deploy roles
  are broken and need the user; nothing is on prod.** `agent` @ `c8910ba`, `main` @
  `33a514c`. App **415 / 414 pass / 1 skip**, chat **213**, journeys **17/17**.

  **Verified live on stage, not inferred:**
  - Frontend: Amplify serves `agent` HEAD. New CSP / HSTS / X-Frame-Options /
    Permissions-Policy all present, **zero CSP violations** on the real page, and the
    journey harness run against `https://agent.marwanelgendy.link` itself holds **17/17**,
    hit-test included.
  - Backend: both stage chat functions moved **2026-10-15 → 2026-10-23** with new
    `CodeSha256`s (`319bd231→fbe35285`, `7d1b1adf→9b577fa6`). Checked as before/after
    markers, because the task-completion notification reported **exit 0 for a failed run
    twice today** — read the `.rc` file, never the notification.
  - ADR-0015 §6, end to end against the deployed CloudFront endpoint: `siteState` present →
    *"looking at the labs section, specifically the Team Tactics project"*; absent → the
    model falls back to home (correct: absent asserts nothing); `section: "Labs"` → **400
    validation_error** with the pattern, i.e. reject-not-clamp for identities, on real
    infrastructure.

  **THREE SEPARATE BLOCKERS stood between the push and a deployed backend. Only the first
  was known, and two of them are still open:**
  1. **CI IAM — OPEN, needs the user.** `gvp-staging-ci-deploy` was denied
     `cloudformation:ListStackResources`, but the real fault is bigger: the whole
     `gvp-<env>-chat-deploy` inline policy still describes the **deleted ECS Express**
     architecture — `cloudformation:*` on `stack/gvp-chat-express-<env>/*`, IAM on
     `role/gvp-chat-express-<env>-*`, plus `ecs`/`elb`/`ec2` on `*`. So every WRITE to the
     stream and CDN stacks is denied too; the read action was just the first deny hit.
     **Both roles are affected** — prod run `38822614809` (Oct 15) failed identically — so
     **neither CI role has deployed chat since the Express teardown.** Note
     `gvp-<env>-deploy` (the CONTACT policy) is fine and must be left alone; its
     `CfnGlobalRead` already grants `DescribeStacks` on `*`, so that one is NOT missing.
     A peer session has a repoint-and-narrow draft in `~/workspace/gvp/iam-draft/`;
     nothing applied.
  2. **`integrate-and-deploy.sh` use-before-define — FIXED (`c8910ba`).** It called
     `gvp_restore_operator_intent` at line 115 and defined it at 138, so a local deploy died
     at **exit 127 after writing `.secrets/config.generated.env` and pushing a secret to
     Secrets Manager**. On `main` since 2026-10-13, fires only on the Secrets-Manager branch
     CI never takes. The crash was also masking that the snapshot loop ran AFTER the
     `source .secrets/*` it defends against. Pinned as a class by
     `test/deploy-script-no-use-before-define.test.mjs`.
  3. **`.secrets/chat-deploy.env` sets only the legacy `CHAT_SAM_STACK_NAME` — STILL OPEN.**
     It resolves to `gvp-chat-stage` for BOTH envs, so the script correctly REFUSED rather
     than write stage parameters into the stack prod uses. Workaround used for this run:
     `CHAT_SAM_STACK_NAME_PROD=gvp-chat-prod CHAT_SAM_STACK_NAME_STAGE=gvp-chat-stage`.
     Every local deploy hits this until the file sets both.

  **Still true and still unfixed:** prod and stage resolve to the SAME Gemini API key, so
  stage load draws down prod's per-project quota. Voice on stage is unverified.

- **2026-10-23 (later) — M3 COMPLETE, all six slices. M1 and M2 complete. M8 item 4 done
  opportunistically.** `main` @ `33a514c` (untouched), `agent` ahead by 40. App **413 / 412
  pass / 1 skip**, chat **213 passed**, browser journeys **17/17**. STILL NOTHING DEPLOYED.

  **M3 (ADR-0016, architect-authored, 958 lines).** The daytime sky had snow in all twelve
  months everywhere; now `js/precipitation.js` decides and `js/starfield.js` obeys. Today
  (2026-10-23, northern autumn, not a hail day) renders rain.
  - **The constraint that bites, and it is invisible in a diff:**
    `initPrecipitation('snow')` keeps `initSnow`'s exact FIVE `Math.random()` draws in the
    order `x, y, r, phase, speed`, with NO shared pre-roll before the per-kind branch. The
    A/B harness replays the render under a seeded `Math.random`, so one extra or reordered
    draw shifts every subsequent particle and reports a full-stream difference for a change
    that is visually nothing. **Gate, run it on every starfield change:**
    `node scripts/qa/starfield-ab-draws.mjs HEAD 12 400 0 snow` → `identical: true`.
  - **The hail sprite is 8px, not 4.** Three places in this repo identify a sprite by
    `img.height === 4` and all three mean "star motion streak". A 4px pellet would have
    been counted as one by the perf test's reduced-motion clause (which pins invariant #6's
    live clause), the cull wiring test and the A/B harness.
  - **The decision lives in `theme.js`, not the renderer**, for a MEASURED reason: the A/B
    harness pins `Date.now` and `new Date()` does not consult it, so a calendar read inside
    `starfield.js` would make the harness answer differently depending on the day you ran
    it. A grep enforces the renderer knows no months, dates, hemispheres or hail odds.
  - **Reduced motion now cuts SPEED as well as count** for rain and hail.
    `snowSpeedMultiplierForPreference` returns exactly `1` under reduced motion — the
    shipped tier cuts count only, which is fine for snow at 0.6-1.8px/frame and not for
    rain at ten times that. Snow's behaviour is preserved byte-for-byte.
  - Census at hour 12 / 120 frames: snow identical, rain 120 visible draws (one stroke per
    frame), hail ~91/frame. Verified visually in headless Chrome over the real garden scene.

  **M8 item 4 (CSP + security headers) landed out of order** while M3's ADR was being
  written — `customHttp.yml`, verified against the running site with the policy served as a
  real header and the violation listener installed BEFORE any page script. Zero violations;
  positive control reports six. The API hosts are WILDCARDS because they differ per
  environment and the 2026-06-04 incident is what a committed per-environment literal
  produces — with a worse failure mode here, since a blocked `connect-src` is silent in the
  UI. `wss://generativelanguage.googleapis.com` is the origin nobody guesses: voice is
  browser-direct, so omitting it kills voice while text chat keeps working.

  **Next:** M4 (ADR-0017, not written), M5, M6, M7, the rest of M8. And the promotion
  question is now 40 commits deep — stage has seen none of it.

- **2026-10-23 — M2 COMPLETE (journey harness included) and M1 COMPLETE. M3 blocked on
  ADR-0016 (architect drafting).** `main` @ `33a514c` (unchanged), `agent` ahead by 33.
  App suite **377 / 376 pass / 1 skip**, chat **213 passed**, browser journeys **17/17**.
  NOTHING IS DEPLOYED — stage has not seen any of this.

  **M2 shipped, then was audited by tdd-critic, which returned BLOCK. Ten real defects
  found and fixed; four of them were introduced earlier in the same session.** Read these
  before touching the chat again:
  - **The site-state line was killing the implicit cache prefix.** It was folded in as a
    SYSTEM message on the reasoning that gemini_routing appends those to the end of the
    system instruction. That is true but irrelevant: `providers._inject_retrieved` puts the
    ~4,000-token knowledge blob in `contents[0]`, NOT in the system instruction, which
    precedes contents entirely. So the volatile line landed AHEAD of the blob and truncated
    the cacheable prefix below the 4,096 minimum — the measured ~2.8x input-token / 429
    regression this project already diagnosed on prod once. It is now a HUMAN turn placed
    immediately before the visitor's newest message: after the blob, and inside the
    twelve-message window `compact_history` keeps (at the front it was simply pruned, and
    `summarize_pruned_messages` reads `type == 'human'` only, so a pruned system message
    contributed nothing).
  - **Escape while yielded ended the live call.** The document handler is guarded by
    `isOpen()` = `!dialog.hidden`, and stageChrome keeps the dialog in the DOM for docked
    and minimized — so pressing Escape to dismiss a PROJECT DIALOG closed the chat and
    stopped voice. Invariant #20, by one keystroke. Escape now goes through the reducer and
    does not `preventDefault` while yielded, because the key was aimed at the dialog.
  - **7 of 13 reducer events had no caller.** A coverage row now asserts every event in
    `CHAT_STAGE_EVENTS` is reachable from `js/chat.js`, with `minimize` exempted on the
    record (no affordance until M4). That check immediately found the viewport rows unwired.
  - **`setVoiceActive` was imported and never called**, so the wire carried `false` always
    and §6.4 persisted that on every turn as the admin panel's "was this during a call".
  - **`js/contact.js` hardcoded `origin: 'visitor'`**, so the agent's own
    `open_contact_form` was read back to it — defeating §7.1's dedupe at the call site.
    `navigate_to_section` was threaded correctly, which is why the existing dedupe row
    passed: one tool covered, the other not, by the mechanism meant to cover both.
  - **The browser could send a `siteState` the server 400s.** The producer bounded LENGTH,
    the validator rejects on CHARSET. One project id with a space in `data/projects.json`
    would have taken text chat AND voice down for every visitor who opened that card, both
    suites green. Closed from both ends, and the patterns are read out of the Python.
  - Plus: `resolveNavTarget('constructor')` returned a function; the notifier scheduled on
    off-wire fields; `open_contact_form` reported success unconditionally (invariant #21's
    error clause had no reachable case); two assertions passed against deleted code
    (`pointerEvents || 'none'`, and the app.js guard anchored to a line start).

  **M1 is done**, and the plan's §0 baseline for it is STALE — it describes a dust-GC
  (`collectDustBand` / `DUST_SWEEP_ROWS`) that does not exist here; the night path does a
  full `clearRect` and `drawSpace()`'s wash is `source-over`. Slices 1 and 6 are superseded.
  Landed: the 8-bit trail-stall predicate (`trailFramesToClear8Bit`, pinning that 0.22 is
  `Infinity`), off-canvas culling (`js/starfield-geom.js`, **44.3% fewer draw calls**), and
  `Star.prototype` + one `setTransform` per streak. Slice 4 was already shipped (baked
  sprites, not per-frame gradients).

  **Two harnesses now exist and both are worth knowing about:**
  - `scripts/qa/starfield-ab-draws.mjs` — renders a git revision and the working tree under
    the same seeded `Math.random`, **pinned clock** and viewport, and compares the visible
    draw stream. Stronger than a pixel diff and needs no browser. Clock pinning is not
    optional: snow drift and firefly wander read `Date.now()`.
  - `scripts/qa/chat-stage-journeys.mjs` + `scripts/qa/cdp.mjs` — the M2 journey harness,
    real headless Chrome driven over CDP with **no dependencies** (Node 22 has a global
    `WebSocket`). Only claims that need a compositor live here; everything a stub can settle
    stays in `node --test`. Two flakes were fixed at the cause: a fragment-only URL change
    is a SAME-DOCUMENT navigation (so state leaked between journeys), and `readyState`
    complete is not "the app is wired" (initChat runs from DOMContentLoaded) — `goto` now
    waits for `data-chat-stage`.

  **Next:** M3 needs ADR-0016 (architect drafting; the plan's M3 text should be checked
  against the repo the way §0 had to be). Then M4–M8. And `agent` is 33 commits ahead of
  `main` with nothing on stage — the standing rule is stage must confirm before prod.

- **2026-10-15 — M2 STARTED (slice 1 in flight). M0 + M1 done. A long credential/cost
  detour between them is finished and verified.** `main` @ `33a514c`, `agent` @ `4617d27`.
  App suite 255/254/1-skip, chat 174.

  **M2 (`docs/plan-2026-09-port.md:118`, ADR-0015) — unblocked and begun.**
  - ADR-0015 is now TRACKED (`4617d27`, 816 lines). It corrects the plan in four places and
    adds a fifth cause. **Two corrections change how M2 must be tested:** (a) the plan's "on
    every navigation" is FALSE — `js/app.js:243` guards the teardown with
    `state === 'portfolio' || state === 'labs'`, so navigating HOME does not tear down and a
    journey exercising only `→ home` passes against unfixed code; (b) `open_contact_form` and
    `navigate_to_section` fail DIFFERENTLY — contact closes the panel synchronously so the
    toolResponse is DROPPED, while navigation queues `hashchange` so the response IS sent and
    then the socket dies mid-sentence. Do not merge them.
  - ADR-0015 §2's BLOCKER is RESOLVED: ADR-0011 → `Reverted` (its `Supersedes:` line claimed
    authority over a GREEN test — `test/labs-restructure.test.mjs`, 4/4 — which is how an
    Accepted ADR came to say a passing test pinned obsolete behaviour); ADR-0010 §1 amended,
    its enum having been explicitly conditional on that reverted merge. Shipped vocabulary
    stays `home | portfolio | labs`; **M2 must not add a third** (§2.1: the registry becomes
    data in `js/section-names.js`).
  - ADR-0015 §6.7 is the SCOPED SECURITY_GLOB review for M2's chat half — it clears exactly
    four edits on `main.py` / `live_gemini.py` and nothing else.
  - **Slice 1 (in flight):** invariant #20, "a site-layout or navigation change never
    terminates a live voice session", as a plain `node --test` with a `stopVoice` spy —
    deliberately NOT inside the browser journey harness the plan buried it in. Root cause
    verified in code: site event → `collapseChatDialog()` / `EV_COLLAPSE` →
    `closePanel({immediate:true})` → `snapClose` → `js/chat.js:908 stopVoice`.
  - Architect's slice reordering (ADR-0015 §11): the `stopVoice` spy goes FIRST; ADD a slice
    aligning the `live_gemini.py` enum with `providers.py` (they have drifted —
    `['home','portfolio','playground']` vs `['home','portfolio','labs']`, so the voice model
    cannot emit `labs` at all and works only via the legacy alias); DROP
    `inferPromisedNavigation` in favour of a `chat_nav_promise_gap` counter; SPLIT "confirmed
    but never executed" into the five causes actually found; MOVE the journey harness to the
    END and let no acceptance bullet depend on it alone (there is no browser E2E in this repo
    and zero test dependencies).

  **M1 — DONE and on prod.** Dust GC dropped, baked sprites restored, star count clamped
  (a faster CPU is not a reason to draw a denser sky), manta-ray depth fix. See
  [[starfield-revert-collateral]].

  **The detour, all verified — see `docs/decisions/ADR-0025-...md` and the memory entries:**
  - 429s were a measured ~3-turns/min *input-token* ceiling (per-MODEL quota), fixed by
    ordering the knowledge blob so Gemini's implicit cache matches an identical PREFIX:
    **2.4 → 5.3 turns/min measured ON PROD** (57% cached). Trimming was measured and REJECTED.
  - Per-model token telemetry added, because the fix was otherwise unobservable:
    `16000/billable` IS turns-per-minute, and `cached_pct` → 0 is the alarm.
  - Voice barge-in: `interrupted` was a one-shot flush, not a cancellation. Turn-epoch gate
    landed; it also caught a regression that would have left the NEXT session completely dead.
  - Retrieval vocabulary closed: 20 of 39 record tags were unreachable by any question.
  - Gemini key now resolves from Secrets Manager; **no chat function carries it in env**. The
    leaked key is REVOKED (verified HTTP 400) and purged from AWS, including 69 ECS
    task-definition revisions.
  - **ECS Express is actually gone this time.** It kept returning because BOTH deploy
    workflows hardcoded `CHAT_DEPLOY_TARGET: express` and fire on every push — so the
    ~$41/mo I reported as saved on 2026-10-13 was never saved, and the cost line proved it
    (flat ~$1.13/day across the "deletion"). Teardown now survives a CI run.
  - `SECURITY_GLOB` widened from two of five credential surfaces to all of them.

  **Open, not blocking M2:** `.secrets/chat-deploy.env` still holds the dead key (inert, should
  become `GEMINI_API_KEY_SECRET_ARN_{PROD,STAGE}`); ECR Public rate-limits the Lambda Web
  Adapter pull on shared runners (mirror it); ADR-0025's filed-forward list (lazy
  re-resolution, dead `ADMIN_API_KEY`/`SMOKE_PROBE_KEY` diagnostics, deploys running as
  account ROOT while a scoped CI role exists).

---

## Older entries (historical)

- **2026-07-13 — night-trail fade fix on top of the prod-restored starfield (app, suite 194/0/1). UNCOMMITTED.**
  Navigator: "once the star is out of the view and gone, the trails should fade... preferably back to front."
  MEASURED on the restored prod build: `destination-out` rgba(0,0,0,0.22) fades ALPHA, which rounds at the bottom
  (2×0.78=1.56→2) — every touched pixel stalls at alpha 2 forever; stalled veil grew 37%→43% of the canvas in 10s.
  Back-to-front comes FREE from the exponential fade (oldest deposits faded most); only the stall is the bug.
  FIX (cherry-picked the e20446e architecture, NOT its faster fade — prod's 0.22 curve is preserved exactly):
  night canvas opaque black, fade on COLOUR (truncates → reaches exactly 0) via source-over, canvas
  `mix-blend-mode: screen` at night (black=identity, CSS sky shows through); day/legacy `normal`.
  3 TDD cycles: (1) pure contract `test/starfield-trail.test.mjs` (TRAIL_FADE_ALPHA===0.22, trailFramesToClear
  terminates, blend modes); (2) stub-DOM wiring `test/starfield-night-wiring.test.mjs` (no destination-out, base
  painted once not per frame, per-frame 0.22 colour fade, screen at night); (3) characterization pin: day restores
  normal+clearRect, re-entering night re-primes base once. Browser-verified: residue 12.1→16.1→**0.1%** (transient,
  not stalled — broken build grew monotonically), blend screen/normal per scene, dusk fireflies + day snow intact.
- **2026-07-13 (earlier) — starfield RESTORED to prod (`2d079aa` on agent): js/starfield.js + starfield-prefs.js
  byte-identical to main; agent-only tests removed; experiments preserved on `wip/starfield-seasons` (92065a0) +
  `feat/daylight-glints` (d7510d2) + agent history (e20446e..fe9fcfa). index.html left on staging hosts.**
- 2026-07-10 — starfield scene reconception: two populations (light + occasional shooters), lit + calm (app, phase off, suite 216/1/0). SUPERSEDED — reverted by 2d079aa; kept for the record.
  Navigator vs original: original sky felt LIT (many background stars) + CALM (not fast); wanted "stars there for light,
  occasionally shooting randomly", + perf cleanup to afford more stars.
  DIAGNOSIS (measured): the original's lit feel was partly the ACCUMULATION HAZE (now removed) smearing sub-pixel stars
  into visibility. A far background star projects ~0.38px radius = invisible. And the shimmer build streaked EVERY star
  (busy/fast feel). Speed far 0.073 / near 3.76 px/frame (perspective already makes close stars fast).
  BUILT (all TDD, pure seams in `test/starfield-scene.test.mjs`): (1) **isShooting(frameDist)** gate — only stars whose
  per-frame motion >= SHOOT_SPEED_THRESHOLD(1.35) get the coloured wake; the calm majority are just points (cheaper +
  quieter). (2) **starPointRadius()** — floors every star to STAR_MIN_RADIUS(1.15px) so the dense field is VISIBLE
  ("way more stars lighting the sky"); this was the key lever — litPct 0.062 -> **0.22** (3.5x). (3) **star-point twinkle**
  — twinkle() gained a floor param; background stars breathe gently at STAR_TWINKLE_MIN(0.62) vs the wake's 0.1 sparkle.
  (4) **off-screen cull** — a star projecting past the edge (+margin) skips its drawImage. TUNED (refactor): baseStars
  717->1500 (updated the 1 prefs reference test), perspective speed factor 4->2.2, baseSpeed 0.1->0.08.
  MEASURED: 1472 stars, ~1058 drawn/frame (rest culled), **0 gradient allocs/frame**, 6.4% shooting at once (~68 short
  tails). Reads calm + densely lit; day/garden + snow intact; 0 console errors.
  **SHOOTING REDESIGNED per navigator ("rare + dramatic meteors"):** the speed-threshold gate could never give "a few" —
  fast stars are the close ones and there are always many (raising the threshold + speed gave ~73 shooters, WORSE). And
  "shooting RANDOMLY" is not what a deterministic speed gate does. Replaced with **random designation**: `makeShooter()`
  flags SHOOTER_FRACTION(0.008) of stars at spawn/respawn; a shooter's drift is boosted SHOOTER_SPEED_BOOST(3.4x) via the
  new pure seam `starFrameSpeed(depthRatio, isShooter, base, scale)`; ONLY shooters draw the wake. Background drift stays
  calm (BG_SPEED_FACTOR 1.5; closest bg star ~1.45px/frame). `isShooting`/SHOOT_SPEED_THRESHOLD removed with their tests;
  `test/starfield-scene.test.mjs` now pins: shooters random + rare (statistical, N=20k), boosted vs background at equal
  depth, background calm (<2px/frame), speedScale honoured. Node-stub measurement: ~1040 stars drawn/frame, **~8 meteors
  on screen avg (min 6 max 11)** at desktop viewport; tails STREAK_LENGTH_MULT=26 (clamped 420px) so each reads as a meteor.
  **TOOLING GOTCHA (cost an hour): the Browser pane keeps the tab `visibilityState:hidden`, so rAF NEVER fires — the
  canvas reads litPct 0 and screenshots show an empty sky while the code is fine (node stub draws 1040/frame).**
  Workaround for verification: `Object.defineProperty(document,'visibilityState',{value:'visible'})` + shim
  `requestAnimationFrame` to setTimeout + dispatch `visibilitychange`; then the field renders and screenshots work.
  Verified after shim: night opaque+screen, lit calm field; day normal+transparent+snow (0.288); round-trip clean; 0
  console errors. Suite 218/1/0. UNCOMMITTED — navigator should eyeball the meteor character (ideally on stage at full
  viewport; the pane viewport is 800x450 = only ~370 stars). Prod still gated on PO AC-2.
- **2026-07-10 — p75 + "true form" of the wake: shimmering colored threads (app, phase off, suite 210/1/0). UNCOMMITTED — awaiting navigator intensity call.**
  The accepted accumulation-trail fix is COMMITTED (`e20446e`). On top of it, per the navigator: "try p75 with the true
  form — the dust is the result of interaction with the gravitational layers of spacetime; make it a line thin, magic
  colorful like the stars glowing, random like fairies being."
  Built: (1) **p75** — `DEPOSIT_FRAMES` 3 -> 6, so the derived fade is 0.578 (clears in 6 frames, keeps more smear);
  invariant "wake never outlives deposit" still holds (6<=6). (2) **twinkle** — NEW pure seams `twinkle(phase,speed,t)`,
  `makeTwinklePhase/Speed`, `TWINKLE_MIN`; each Star gets a random phase+speed (reassigned on respawn), and the streak
  deposit's globalAlpha is modulated by `twinkle(...)` on `nowSeconds` (set once/frame in drawTime) — so each wake
  shimmers on its own clock ("fairies"). (3) **magic colorful** — `streakColor` now boosts saturation (muted star * 2.3,
  capped) + alpha 0.85, and screen-blend blooms overlaps; the STAR stays desaturated (distant sun), only the WAKE is vivid.
  Also removes the last of the silent hsl->hsla string-surgery bug (parses components, throws on unknown form).
  TDD: NEW `test/starfield-twinkle.test.mjs` (5 tests: range [TWINKLE_MIN,1], varies over time, hits both extremes,
  two stars independent, random phase covers [0,2pi) + positive speed spread). Suite 210/1/0.
  **Measured in-browser (dialed values TWINKLE_MIN=0.18, sat*2.3, alpha0.85):** ~76% of lit pixels are saturated/colored
  (meanSat 0.26) — the "magic colorful" is real and measurable. Day/garden `normal`+snow intact, 0 console errors.
  **DIALED UP per navigator ("push it more magical/visible"):** `TWINKLE_MIN` 0.32->0.18->0.10 (more sparkle contrast),
  `streakColor` alpha 0.7->0.85->0.95 + saturation *1.9->*2.3->*2.8, `STREAK_MAX_DIST` 150->260. The real visibility lever
  was thread LENGTH: constant-tuning barely moved it (coloredPct 0.048->0.057), because a streak was one frame of motion.
  Added `STREAK_LENGTH_MULT = 4` — the streak is now drawn `dist*4` long (clamped to STREAK_MAX_DIST), head-at-star,
  tapering at the tail. LENGTH ONLY, never width (width scaling was the "mantis ray"). coloredPct jumped 0.057->0.081,
  meanSat ->0.34. Now reads at page scale: thin colored shooting-star threads, star-palette hued, shimmering per-star.
  Magnified a bright thread: a clean thin periwinkle line (rgb 127,145,181), head-at-star, soft tail — exactly the spec.
  Day/garden `normal`+snow intact, 0 console errors, suite 210/1/0.
  **AWAITING navigator accept of THIS intensity, then commit + push to stage.** Prod still gated on product-owner AC-2.
  Uncommitted files: `js/starfield.js`, NEW `test/starfield-twinkle.test.mjs`.
- **2026-07-10 — trail fade DERIVED from a deposit budget: wake may not outlive its build (app, phase off, suite 205/1/0). UNCOMMITTED.**
  Navigator: "collect the garbage faster, I need the accumulation not to exist beyond as much time as it took to build."
  That is a SYMMETRY SPEC, not a taste knob — so it is now an invariant, and the fade is derived from it.
  **Measured the deposit** (how long a star's glow paints one pixel = 2*glowRadius / screen-speed) by replicating the real
  projection over ~10k sampled visible stars: **p25 1.5, median 3.1, p75 6.6, p90 13.1 frames**.
  **The accumulation, quantified:** at the original 0.22 the wake took **18 frames** to clear against a **~3-frame deposit**
  — glow piled up ~6x faster than it drained. THAT is the buildup.
  NEW seams: `DEPOSIT_FRAMES = 3` (the median), `fadeAlphaForClearFrames(frames)` = the GENTLEST fade meeting the budget
  (searching for the minimum keeps the longest smear the rule allows, instead of over-fading), and
  `TRAIL_FADE_ALPHA = fadeAlphaForClearFrames(DEPOSIT_FRAMES)` = **0.834**, clearing in exactly **3 frames** (keeps 16.6%/frame).
  Tests pin the RULE, not the number: "the trail never outlives the deposit that made it", "the fade is DERIVED, not
  hand-tuned", "the derived fade is the gentlest that meets the budget", plus monotonicity. Break-checked BOTH directions:
  a slower fade (0.45) fails the outlives-deposit guard; a harsher one (0.95) fails the derived-not-hand-tuned guard.
  **Verified in-browser:** pure-black pixels hold FLAT at **99.9%** (zero growth — accumulation eliminated); mean canvas
  luminance **0.345 (orig) -> 0.081 (0.45) -> 0.020 (now)**. Day/garden `normal`+transparent, night `screen`+opaque,
  round-trip clean, 0 console errors.
  **HONEST TRADEOFF — the navigator must judge:** enforcing clear<=3 frames REMOVES the visible radial smear. What remains
  is a clean starfield + the 1-frame streak line. The smear the navigator called "the professionalized original design"
  IS the accumulation; the rule and the look are in direct tension.
  **The single lever is `DEPOSIT_FRAMES`** (the deposit is a DISTRIBUTION, and p50 was a choice):
    p50=3 -> fade 0.834, clears 3f (now; no smear) | p75=6 -> fade 0.578, clears 6f (some smear, still <= most stars' deposit)
    p90=13 -> fade 0.308, clears 13f (near-original smear) | original 0.22 -> 18f (violates the rule)
  Not pushed. Prod still gated on product-owner AC-2.
- **2026-07-10 — trail fade doubled: `TRAIL_FADE_ALPHA` 0.22 -> 0.45 (app, phase off, suite 201/1/0). UNCOMMITTED.**
  Navigator: "clean the dust faster, so it is less intense in the build up, a lot faster." ("dust" = the trail smear;
  the particle system is already gone.) The knob is how much of the trail is erased per frame.
  NEW pure seam `trailFramesToClear(fadeAlpha, start=255)` models the canvas exactly (colour channel TRUNCATES, so it
  always terminates — unlike alpha, which rounds up and stalls at 2). Model validated against the browser: predicts 18
  frames at 0.22, browser measured colour reaching 0 at frame 19 (off-by-one from the initial fill).
  **0.22 -> 0.45 halves the trail: 18 frames-to-black -> 9.**
  Measured in-browser at steady state: pure-black pixels **80% -> 95%**, mean canvas luminance **0.345 -> ~0.08**
  (~4x less residual glow). Rays still read as the original's continuous radial smear, just fainter/shorter.
  **Test honesty:** the old test pinned `TRAIL_FADE_ALPHA === 0.22` and called the look dependent on it — the navigator
  falsified that. Re-pinned the BEHAVIOUR instead (a bigger fade clears in strictly fewer frames; every fade in (0,1]
  reaches pure black; the drawn fillStyle follows the exported knob), leaving the value free to tune. `ORIGINAL_TRAIL_FADE_ALPHA`
  is kept purely as the reference the guard compares against. Break-checked: reverting the knob to 0.22 fails
  "the trail clears a lot faster than the original 0.22 curve".
  Day/garden + reduced-motion untouched (the fade only governs the night trail). 0 console errors. NOT pushed.
- **2026-07-10 — starfield REVERTED to the original look; residue killed at the root (app, phase off, suite 198/1/0). UNCOMMITTED.**
  Navigator, side-by-side vs prod: "looks like fireworks compared to the professionalized original design."
  **They were right, and the diagnosis was mine to own:** the original trail is a CONTINUOUS motion-blur smear (the star's
  glow convolved along its path by the accumulation buffer). Dust motes are a SAMPLED approximation of that smear, and
  sampling it every 4 frames gives speckle = fireworks. Worse, the earlier "beach ball" was ALSO self-inflicted — I added
  `STAR_GLOW_SCALE=2.1` + a solid glow core to replace the brightness the accumulation used to supply, which turned a soft
  bloom into a hard ball; the depth guards then "fixed" damage I had caused. (Probe: the ORIGINAL draws stars with arc
  radius up to 26,043px and looks fine.)
  **THE ROOT CAUSE OF THE RESIDUE — browser-verified, and it is NOT what I claimed for three rounds:** the fade
  `destination-out` + rgba(0,0,0,0.22) multiplies the **ALPHA** channel by 0.78, and 8-bit alpha ROUNDS UP at the bottom
  (2*0.78=1.56 -> 2), so alpha stalls at 2 forever. The IDENTICAL 0.78 fade applied to a **COLOUR** channel TRUNCATES and
  reaches exactly 0 (frame 19). Measured live on the original: pixels stuck at alpha 2 grew 39% -> 58% in 24s.
  **FIX:** paint the night canvas opaque black, fade the trail on COLOUR with the same 0.22 curve, and set
  `canvas.style.mixBlendMode = 'screen'` (black is the identity under screen, so the CSS sky shows through). Day/garden
  flips back to `normal` (screen would blow out the snow). `ensureOpaqueBackdrop()` repaints the base only on entry to
  night + after resize — never per frame, or it would erase the trail it exists to hold.
  New: pure seams `trailFadeAlpha()`, `blendModeForScene()`, `TRAIL_FADE_ALPHA=0.22`, `NIGHT_BLEND_MODE='screen'`.
  **VERIFIED:** trail decays to pure black (pureBlackPct 48->82%, meanLum 1.06->0.345 FALLING; the original grew instead).
  night->day->night round-trip repaints the backdrop correctly. Garden/snow unchanged. 0 console errors.
  **PERF (the original brief) — kept, via faithful sprite caching (identical gradient stops):**
  radial gradients/sec 67,920 -> **0**; linear gradients/sec 63,536 -> **0**; strokes/sec 63,536 -> **0**.
  **ALSO FIXED the latent silent bug:** `streakColor()` now PARSES the hsl components and throws on an unknown form,
  instead of `hsl(`->`hsla(` string surgery that fails silently (canvas ignores an invalid fillStyle) the day
  `randomColor()` emits modern `hsl(210 40% 80%)` syntax.
  **REMOVED (reverted subsystems + their tests):** stardust particle pool, depth guards (near plane / depth fade /
  radius clamp), comet streak, glow-scale + solid-core brightness compensation. Deleted `test/starfield-{dust,depth,streak}.test.mjs`
  — the behaviour they pinned no longer exists. NEW `test/starfield-trail.test.mjs`; `test/starfield-perf.test.mjs` rewritten
  to pin: zero gradients/frame, fade is source-over on colour + never `destination-out`, night=screen/day=normal,
  opaque base painted ONCE not per frame, reduced motion = stars but zero streaks. All four break-checked (each guard
  fails when its mechanism is reverted).
  **A CORRECTION I OWE THE RECORD:** the earlier "110M px/frame, ~1020x overdraw" claim was WRONG — canvas clips draws to
  the canvas bounds, so a 37k-px sprite does not rasterise 37k^2 px. I measured requested area, not rasterised area. The
  real cost was always the ~131k gradient allocations/sec. Also do not quote ms/frame from this session: the preview tab
  suspends rAF between tool calls.
  NOT pushed. Prod still gated on product-owner AC-2.
- **2026-07-10 — starfield depth guards: no more beach-ball stars (app, phase off, suite 224/1/0). UNCOMMITTED.**
  Navigator on staging: "stars scale massively when they come close, looks like a big ball... best to avoid the stars
  hitting the user in the face." **Root cause:** perspective is `size * (focalLength/z)` with `fl = canvas.width`, and
  stars were recycled only at `z <= 0` — so a star aimed near screen centre kept closing on the camera and its radius
  diverged. Measured table: at `z=0.32W` radius <= 8.3px; at `z=0.01W` radius = **313px**.
  **Three guards (bluntest last), all in `js/starfield.js`:** (1) NEAR PLANE `STAR_NEAR_PLANE_RATIO=0.15` —
  `starShouldRecycle()` retires a star before it can reach the camera; (2) DEPTH FADE `STAR_FADE_START_RATIO=0.32` —
  `starDepthFade()` dissolves it on the way in so it never POPS (multiplies globalAlpha for that star's glow+streak);
  (3) hard clamp `STAR_MAX_RADIUS=9` via `clampStarRadius()`. Star `z` is now seeded in front of the near plane.
  **Verified in-browser:** biggest star on screen 3-8px diameter (mean 4.3) vs **70-104px before**.
  **Fill-rate collapse (deterministic node stub, 30 frames after 200-frame warmup, same draw-call count ~6950/frame):**
  max single drawImage height **37,129px -> 18px**; pixel area per frame **110,622,077 -> 108,418** (~1020x less
  overdraw; the old frame was rasterising 45x the whole canvas). So this is a large PERF win as well as the visual fix.
  **Could NOT get a trustworthy ms/frame this session** — the preview tab suspends rAF between tool calls (captured 2
  frames); do not quote a ms number until re-measured on a visible tab. Prior committed build measured 5.06 ms/frame.
  **TDD + break-checks:** NEW `test/starfield-depth.test.mjs` (7 pure-seam tests). CRUCIALLY the pure seams did NOT guard
  the WIRING — reverting the recycle to `z<=0` or deleting the clamp left all 222 tests green. So the canvas stub now
  records drawImage geometry + globalAlpha, and `test/starfield-perf.test.mjs` gained two wiring tests. Break-checked
  each guard independently: delete clamp -> "no star renders as a ball" fails; delete fade -> "stars dissolve..." fails;
  revert recycle to z<=0 -> "stars dissolve..." fails (draws collapse as stars linger invisible near the camera).
  Day/garden snow path intact, 0 console errors. Not yet pushed; prod still gated on product-owner AC-2.
- **2026-07-09 — starfield stardust: navigator-driven redesign of the trail (app, phase off, suite 215/1/0).**
  Navigator reviewed the previous build ON STAGING and rejected it: close stars showed a "lollipop" (thin stick under a
  fat round glow); after I widened the head to the glow DIAMETER it became a "mantis ray" (triangular wings). Their key
  insight: the lingering glow must NOT be welded to the star — it should be dust deposited across the sky that fades out.
  **Root realization:** the old uncleared canvas was doing TWO jobs at once — (a) a thin one-frame motion line per star,
  (b) a sky-wide lingering glow. Stretching the streak to do (b) is why both artifacts appeared. Split them:
  **STREAK** reverted to the ORIGINAL (`STREAK_TAIL_FRAMES=1`, thin, clamped by `STREAK_MAX_THICKNESS=3` via
  `streakThickness()`). **STARDUST** = new bounded particle system: each star sheds a mote every `DUST_SPAWN_INTERVAL`
  frames (staggered by star index); a mote is FROZEN at its spawn point (does not follow the star), keeps that star's
  palette colour, and its alpha comes from `dustAlpha(age,life)=(1-age/life)^2` which is EXACTLY 0 at end of life.
  Alpha is derived from age and NEVER read back off the canvas, so the 8-bit rounding that stranded the old
  `destination-out` fade at ~2/255 (the permanent haze) is impossible by construction. `createDustPool` is a fixed-size
  ring over typed arrays — spawning forever recycles, never grows. Small per-colour dust sprite baked once (navigator's
  "alternating sprites" hint) instead of downscaling the 64px star glow ~5k times a frame.
  **Navigator flipped the brightness knob:** `DUST_MIN_STAR_RADIUS 1 -> 0` (whole field sheds; brighter, denser sky).
  `shedsDust(radius, threshold)` is parameterized so the SEAM stays pinned while the VALUE is free tuning.
  **Measured (quiet machine, rAF-wrap, same method as baseline): 5.06 ms/frame, p95 5.4, busy 301 ms/s** vs the ORIGINAL
  buggy build 6.57/7.2/391. Zero gradient allocations per frame (was 132k/sec). No accumulation, proven empirically:
  fully-transparent pixel share holds 99.4-99.7% over 18s, residue band (alpha 1-4) flat at 0.03-0.08%.
  NOTE: the dim-but-fastest build was 2.03 ms — dust is NOT free; ~3 ms/frame buys the sky the navigator wants.
  **tdd-critic = PASS-WITH-NITS** (ref `starfield-dust`): verified the ring is provably safe (a slot is reused only after
  `capacity` spawns, which takes >= `life` frames of aging, so it is already dead — no mote pops mid-fade), every alive
  mote is aged 1:1 with frames, `dustAlpha` handles Infinity/NaN, per-resize pool realloc is churn not a leak. It judged
  my two self-corrected tests HONEST (I had pinned falsified hypotheses: `STREAK_TAIL_FRAMES>1` and
  `DUST_MIN_STAR_RADIUS>0` — both were taste/obsolete, re-pinned as behaviour against explicit params).
  **All 3 nits FIXED before push:** (1) reduced-motion-sheds-no-dust was UNTESTED — added a count-independent guard
  (dust makes per-frame drawImage RISE as the pool fills; no dust => flat), and my FIRST attempt at it was NOT red-capable
  (it compared modes, but reduced motion also renders far fewer stars, masking leaked dust) — rewrote to compare a mode
  against ITSELF over time, then BREAK-CHECKED it: removing the guard makes reduced-motion draws climb 210->966 and the
  test fails. (2) day<->night crossover thawed stale mid-life motes at old positions (pool not aged while not drawn) —
  added `resetDust(pool)` + a single `setDustEnabled()` edge-trigger that retires the pool on true->false, wired at all
  4 call sites incl. the `sp.star <= 0.01` branch. (3) dropped a tautological `dustCapacity` assertion.
  STILL OPEN (backlog, from the earlier critic pass): `streakAnchor()` seam (a sign flip at the streak draw leaves all
  streak tests green), `streakColor()` (hsl->hsla string surgery fails SILENTLY on modern `hsl(210 40% 80%)` syntax),
  and `drawSpace()` is DEAD (`js/theme.js:62` sets `data-time` unconditionally) making invariant #6's trail-alpha clause
  vacuous while its test stays green.
- **2026-07-08 — starfield: trail residue fixed + ~1.8× faster draw (app layer, phase off, suite 194/1/0).**
  Navigator: "front end is heavy, the stars trail never clears — clean the trail, perf should be better." Feature WIP
  parked in `stash@{0}` first (restructure + content-depth); ttics 0.67.1 kit update kept in tree.
  **Two real defects, both measured in-browser before touching code:**
  (1) `drawTime` night used `globalCompositeOperation='destination-out'` + `fillRect(alpha 0.22)` as a partial erase —
  multiplying 8-bit alpha by 0.78 leaves pixels STUCK at alpha 1 forever, so trails never drained (permanent ghosts).
  (2) The real cost was NOT the trail: `Star.show()` built a `createRadialGradient` **per star per frame** AND a
  `createLinearGradient` per streak — measured **67,903 + 64,197 gradient objects/sec (~1132 stars/frame)**, ~90ms/sec
  in gradient *creation* alone. (The file already documented this exact fix for SNOW at ~6k/sec; stars were 20× worse.)
  **Fix:** bake one radial-glow sprite + one linear streak-strip sprite per palette colour ONCE (the repo's own sprite
  pattern), `drawImage` them; replace the partial erase with `clearRect` (deterministic, matches the day path).
  **Gotcha found:** clearing removed the accumulation that was silently supplying ~4.5× brightness → sky looked dead
  (litPixel 0.25%→0.04%). Fixed by drawing the WHOLE comet tail every frame from `STREAK_TAIL_FRAMES=8` of motion back
  (deterministic, no accumulation), plus `STAR_GLOW_SCALE=2.2` + solid glow core (sub-pixel stars must read in ONE pass)
  + `STREAK_ALPHA=0.62`. Lit-pixel coverage now matches old exactly (0.253 vs 0.250).
  **Verified A/B, same viewport/hour:** draw callback 6.57ms → **3.61ms/frame**; main-thread busy 391 → **215 ms/sec**;
  gradients/sec 132k → **0**; full-canvas composite `fillRect` 60/sec → 0 (now `clearRect`). Day/garden snow path + 0
  console errors confirmed. Mean *luminance* is ~53% of old on purpose — the missing half was the accumulated smear haze.
  TDD: NEW `test/starfield-perf.test.mjs` (canvas-stub: frames allocate ZERO gradients; night frame clears, never
  `destination-out`) + NEW `test/starfield-streak.test.mjs` (pure `streakLength()`: tail spans >1 frame, clamps at
  `STREAK_MAX_DIST`, 0 when motionless). Both RED-proven first. UNCOMMITTED.
  NOTE (dev only): python `http.server` heuristic-caches `/js/*.js` + `/data/*.json`; a stale entry can serve OLD code
  through a plain reload. Bump the `launch.json` port (new origin = new cache keys) to force fresh, or cache-bust fetch.
  **OUTER LOOP (ran before the stage push) — it caught a real defect I shipped into the working tree:**
  `tdd-critic` = **PASS-WITH-NITS** (#784, clear for staging, not prod). `product-owner` = **CONCERNS** (#786):
  AC-1 (trail clears) ACCEPT, AC-3 (faster) ACCEPT, **AC-2 (clean/aesthetic) NOT SIGNED OFF** — coverage was restored by
  spreading light wider (`STAR_GLOW_SCALE`), so each lit pixel is ~half as bright; "the missing light is haze" is
  undecidable from the numbers (and the old baseline is a moving reference, since its brightness grew with tab uptime).
  PO ruling: **staging = yes (for review), prod = no** until the NAVIGATOR eyeballs the sky. Aesthetics are navigator-owned
  (his brand). **DEFECT FOUND + FIXED:** `STAR_GLOW_SCALE=2.2` + the 8-frame tail were applied to EVERY path, but only the
  default-motion night path ever accumulated — old reduced-motion night erased at **alpha 1 (a full clear)** and the day
  path already `clearRect`ed. So a11y + day/dawn paths were silently over-brightened/over-streaked. Fixed via red→green:
  NEW pure seam `compensateForClearedTrail(prefersReducedMotion, dayScene)` + per-frame `starGlowScale`/`starTailFrames`
  (mirrors the existing `starSpeedScale` pattern); `streakLength(dist, tailFrames)`. Default-motion night look preserved
  (lit 0.249 vs old 0.250). Also hardened per critic: perf test now asserts `clearRect` ARGS (full canvas, not a sub-rect)
  + `fillRect === 0`, and NEW test pins invariant #6's live clause (reduced motion → stars but ZERO streaks).
  **Clean A/B (rAF-wrap only, same method both runs): 6.57 → 2.03 ms/frame, p95 7.2 → 2.2, busy 391 → 122 ms/sec.**
  (An earlier "3.61ms" figure was inflated by instrumenting `drawImage`, which fires 126k/sec — discarded.)
  Suite 196/1/0. **Known, NOT fixed (backlog):** `drawSpace()`/`drawSnow()`/`drawStudio()` are DEAD — `js/theme.js:62` sets
  `data-time` unconditionally, so `isTimeMode()` is always true; `spaceTrailAlphaForPreference` therefore has NO live
  consumer and invariant #6's trail-alpha clause is **vacuous while its test stays green**. Also `STREAK_MAX_DIST` kept its
  name/value but changed meaning (per-frame skip threshold → tail cap), moving the saturation knee 150 → 18.75 px/frame.
  Also unpinned: `streakColor` plumbing (`hsl(`→`hsla(` string replace) fails SILENTLY if `randomColor()` ever emits
  modern `hsl(210 40% 80%)` syntax. See `.claude/state/backlog.md` (PO wrote 5 ordered follow-ups).
- **2026-07-07 — ttics kit bumped 0.67.0 → 0.67.1 (latest).** Safe in-place update via the LOCAL monorepo checkout
  (`node ~/workspace/tdd-pair/team-tactics/packages/team-tactics/bin/cli.js update <abs gvp path>`, NO --force) — GitHub
  releases lag (latest published = v0.66.0), local `main` HEAD = v0.67.1 (ADR 0022/0023 speculative-draft lanes). All data
  files `keep` (progress/plan/design-notes/invariants/tdd.config untouched), feature files byte-identical (md5-verified),
  suite green 195/1/0 through refreshed hooks, gate behaviorally proven live this session (blocked a red-phase source edit,
  passed the green ones). CLAUDE.md managed block + docs/tdd/outer-loop.md refreshed by the update. See [[ttics-install-topology]].
- **2026-07-07 — content-depth slice #2: structured Work-card narratives (navigator-approved copy, suite 199/1/0).**
  The two content-rich Work projects (team-tactics, ai-assistant-chatbot) now carry `problem`/`work`/`outcome` in
  `data/projects.json` (faithfully re-shaped from their EXISTING approved copy — no invented claims), so their cards render
  the Problem→Approach→Demonstrates narrative that Experience roles use (createProjectCard's `isStructured` branch — no code
  change needed beyond the data). The two one-liner builds (monday-rover, gvp) deliberately stay FLAT to avoid padding.
  TDD'd: NEW `test/work-card-structure.test.mjs` (DOM-stub behavior — asserts the two are structured + non-empty, the two
  stay flat). Browser-verified end-to-end (fresh fetch + real render fns). NOTE: python `http.server` heuristic-caches
  `/data/projects.json`, so a plain browser reload can render STALE flat cards after a data edit — not a code bug; force a
  cache-bust fetch to see edits. Copy is navigator-approved wording; UNCOMMITTED. NEXT (optional): og:image/JSON-LD SEO,
  or a11y polish — see the earlier direction menu.
- **2026-07-07 — Work/Experience restructure: slop-audited + first content-depth slice (app layer, phase off, suite 195/1/0).**
  Navigator asked to "take it to the next level; deepen content, but treat any uncommitted work as slop." qa-verifier +
  tdd-critic pass over the in-flight (uncommitted) Portfolio/Labs→Experience/Work restructure via the running site +
  full diff. Restructure is sound EXCEPT one confirmed slop bug: `renderProjectsSectionError` was called in `js/app.js`
  (projects-load-failure path) but dropped from its import list → `ReferenceError` on that path (invisible to happy-path
  browsing + existing tests). Fixed via red→green + NEW guard `test/app-projects-imports.test.mjs` (asserts app.js imports
  every projects.js export it calls). Cleaned trivial cruft (dead `orderWorkProjects` import + stray blank line in
  projects.js). Then content-depth slice #1: Work cards never rendered their `tech` tags (tags were gated behind the
  `isStructured` branch) — lifted the tech-tag render out so structured roles AND flat build cards both surface their
  stack; exported `createProjectCard`; NEW `test/project-card-tech.test.mjs` (DOM-stub behavior test, 3 cases).
  Browser-verified both themes, zero console errors. UNCOMMITTED (navigator has not asked to commit). NEXT depth (needs
  navigator: voice/fact-sensitive): give Work projects the structured problem→approach→demonstrates narrative that
  Experience roles have, drafted from each project's existing truthful `description`/`chatSummary` — do NOT invent claims.
- **ALL SHIPPED — staging + PROD live & verified (2026-06-17).** Sequence this session: pre-prod review → fix-everything
  hardening milestone → staging (`agent` d242979, qa PASS) → PROD (`main` d45e18d, deploy-prod 27722767780, qa PASS;
  keyed ipHash live, prod IAM widened page-Contact*→page-* owner-authorized) → then per owner the analytics **CONSENT
  gate was removed** + deployed (`agent` 473fcb8 → `main` merge da62cad; `js/consent.js` 404 on staging+prod; ipHash
  HMAC SEC-2 retained; ADR-0008 status=SEC-1 reversed). Live www green, PROD hosts (no leak). Suite 115/0/1, gate ARMED.
  `agent`=working branch (staging hosts); `main`=prod (prod hosts). OPEN owner items: set `GVP_EXPECTED_ENV=prod` on
  Amplify app `d2ey3rf8zwq2lv`; verify positive `/api/chat/smoke` with prod `SMOKE_PROBE_KEY`; deferred S16 budget +
  S30 WAF. Older "IN FLIGHT" notes below are superseded. See `releases.md` + memory `prod-promotion-procedure`.
- **2026-06-17 — MILESTONE "Pre-prod hardening → stage" IN FLIGHT.** Goal: TDD-fix all confirmed
  pre-prod review findings, then deploy `agent`→staging (NOT prod). 37-agent adversarial review of the
  22-commit `agent`→`main` diff found 28 confirmed issues; the only 2 "blockers" are ONE promotion-procedure
  hazard (staging API hosts → Amplify, no guard — see memory `prod-promotion-procedure`), rest medium/low.
  Planned: product-owner backlog (`.claude/state/backlog.md`) + 3 decisions (`design-notes.md`); architect
  **ADR-0008** (HMAC ipHash pepper + consent gate) + **ADR-0009** (amplify guard / DLQ-alarm / abuse / DR /
  cron); planner **31-slice queue in `plan.md`** (P0 S1–S7+S31, P1 S8–S20, P2 S21–S29; S30 per-IP WAF DEFERRED).
  **PROMOTED TO PROD — GREEN + qa PASS (2026-06-17): `main` @ d45e18d, deploy-prod run 27722767780.** FF + re-pin
  prod hosts (no leak, env-guard 3/3) → new `page` resources created clean (SiteEventsTable, EventsIngress/DailyReport
  Lambdas, 12:00-UTC cron LIVE, alarms) + `gvp-chat-express-prod` updated; prod IAM widened page-Contact*→page-*
  (owner-authorized) for the new Lambda roles. qa on prod: keyed ipHash live (5ac3d2dd…, not inert), smoke split 401/401,
  consent served, prod metas. `agent` keeps staging hosts (main +1 = the prod re-pin). OPEN (owner): set
  GVP_EXPECTED_ENV=prod on Amplify app d2ey3rf8zwq2lv to arm the amplify.yml guard; verify positive smoke path w/ prod
  SMOKE_PROBE_KEY. Deferred: S16 budget alarm, S30 WAF. See releases.md + memory prod-promotion-procedure.
  ---
  **SHIPPED TO STAGING — GREEN + qa PASS (2026-06-17): `agent` @ d242979, deploy-staging run 27720539158.** Both
  stacks UPDATE_COMPLETE with IpHashPepper+SmokeProbeKey; qa-verifier PASS (live keyed ipHash 22cabe9f…, honest event
  counts, smoke trust-split 401/401, consent served; test data cleaned). CI test gate 120/120/0. app `node --test`
  120/0/1, chat (.venv) pytest 102/0, gate RE-ARMED. Prereq secrets now mapped in both deploy workflows.
  All 31 slices done except S16 (AWS Budget = owner runbook/account-level per ADR-0009) and S30 (per-IP WAF = ADR-deferred).
  Parallel-track workflow landed the gated batch under a navigator-authorized SECURITY_GLOB disarm window (re-armed after).
  Integration-closure batch wired the connective tissue: FE MAX_BUFFER→25; contact-daily-report uses x-smoke-key+report=1
  + day-derived Idempotency-Key; SAM params/env IpHashPepper(IP_HASH_PEPPER) + SmokeProbeKey(SMOKE_PROBE_KEY) across
  template.yaml + chat-template.yaml + deploy seeding. tdd-critic = CONCERNS→addressed (3 loose text-guards tightened;
  security behaviors genuinely proven). FE qa-manual browser-verified: consent banner (first-visit→accept persists+inits GA,
  no reappear, 0 console errors), admin avgFirstToken relabels, admin x-smoke-key probe field (deep btn disabled w/o key).
  **REMAINING = the stage DEPLOY only**, gated on TWO owner actions: provide `IP_HASH_PEPPER` + `SMOKE_PROBE_KEY` secret
  values for staging (else those features deploy INERT: ipHash='' / smoke locked), and confirm the outward push (agent→
  staging CI + Amplify). Then qa-verifier E2E on staging. Detail of the earlier slices ↓.
  ---
  **Done so far (suite 93/0/1):** kit→**0.61.0** (gate re-verified 8/8). **ipHash track** S1/S2/S3 + S3b —
  `hashIp(ip,pepper)` HMAC-SHA256-keyed, returns `''` (never reversible unkeyed) when no pepper; events + contact
  callers thread `process.env.IP_HASH_PEPPER` and hash the leftmost XFF client IP (contact dedupes-match events).
  **Consent gate** S4/S5 — `js/consent.js` `hasAnalyticsConsent()` default-deny; `flushEvents()` buffer-preserves
  when denied, `initAnalytics()` skips `gtag('config')` when denied. **tdd-critic = PASS-with-1-gap** (the contact
  end-to-end coverage gap; closed via S3b). Active layer **app** · phase **off** (clean boundary).
  **RESUME at remaining P0:** S7 (DailyReport+ContactFailureReport Errors alarm — `aws/template.yaml`, GATED → run
  under `SECURITY_REVIEW=1`, cleared by ADR-0009), S31 (`amplify.yml` env-guard, CI — per-app `GVP_EXPECTED_ENV`),
  S6 (consent banner UX — qa-verifier/browser). Then P1 (S8–S20) + P2 (S21–S29; S30 deferred). NEEDED before P1
  gated slices: architect clearance addendum for events-ingress-core / resend.js / report-queries-core / chat main.py
  (planner flagged — not ADR-cleared yet). Owner deploy-time actions: `IP_HASH_PEPPER` secret + per-Amplify-app
  `GVP_EXPECTED_ENV`. Earlier reporting-feature history below ↓.
- **2026-06-16 — ttics reinstall recovered + reporting fixes (app layer).** A fresh Cursor 0.56.0
  reinstall had reset the data files to stubs; restored backlog/progress/invariants/releases/plan/
  design-notes from `main` and merged `tdd.config` (LAYERS="app chat", `node --test`, chat pytest layer;
  kept the new 0.56 knobs). Then fixed the new **reporting** feature via the red→green loop: #1 chat
  day-bucketing (`aggregateChat` buckets each turn by its TRUE UTC day from `capturedAt`/`utcDayOf`;
  `queryDay` now half-open via the shared `utcDayBounds` + `lookbackDays:1`, wired into both report
  consumers), #2 BatchWrite **UnprocessedItems** drain (`persistEventRows` extracted, tested, wired),
  plus HTML-escaping + queryDay-pagination regression tests. Suites GREEN: **app `node --test` 74 pass /
  1 skip · chat pytest 91**. tdd-critic = CONCERNS, top one addressed (UTC parse). Backlogged follow-ups:
  handler-level look-back test (needs ddb injection), `capturedAt`-less fallback-day test, and the
  security/infra hardening tail (WAF/per-IP rate limit, body-size cap, HMAC IP hash, DailyReport DLQ/alarm,
  dual-cron consolidation, idempotency). Active layer: **app** · phase: **off**.
- Feature in flight: **none**. **ALL TEN INVARIANTS NOW FULLY PROVEN** — the last open clause
  (#8's 55s API-Gateway cap) shipped 2026-06-04, plus two contact-core tdd-critic pins (Obs A
  `markSending` order, Obs C enqueued `idempotencyKey`) and the #7 non-stream-OK cell
  (`turn['status']=='ok'`, closing the milestone tdd-critic finding). Active layer: **app** ·
  phase: **off**.
- Harness: **team-tactics 0.32.0** (`--preset full-team`; refreshed 2026-06-06 via
  `npx github:geda0/team-tactics@latest update --preset full-team`). selftest **15/15**; tic
  protocol live; `docs/tdd/tool-support.md` present.
- Suites: **app `node --test` 43 pass / 1 skipped (44 total)** · **chat pytest 86/86** (last recorded).
- tdd-critic milestone audit = **PASS-on-substance** (all pins honest/RED-capable). Two CONCERNS
  were pre-existing soft spots: #7 ok-cell (now CLOSED) and #10 coupling/allowlist (OPTIONAL,
  backlogged). Plus a minor non-blocking note: pin-1 order could deep-equal the full call sequence.
- **DEPLOYED to STAGING + PROD (2026-06-06), both GREEN.** Team Tactics contact CTA promoted
  agent→main (`d9ce997`) with prod API metas preserved. Staging deploy `27051135017` · prod deploy
  `27051407724`. Amplify: `agent`→chat.marwanelgendy.link · `main`→www.marwanelgendy.link.
  ⚠ CI actions on Node20 (GitHub deprecation 2026-06-16).
- Next backlog: only the LOW-priority / OPTIONAL tdd-critic hardening tail remains (#9 cross-turn
  fallback-first + `last_model_id`; OPTIONAL #10 voice allowlist + preset/cadence coupling). None
  blocks an invariant. Reasonable checkpoint with the navigator on whether to grind these or stop.

## Bootstrap deliverables (done this session)
- **Harness:** `.claude/tdd.config` now has TWO layers — `app` (node:test over
  js/ scripts/ aws/) and `chat` (pytest over docker/chat/app). resolve_layer + globs
  verified.
- **Architecture:** `docs/decisions/ADR-0001..0005` (single-origin proxy is LOCAL-ONLY;
  split chat hosting; Gemini Live timbre lock = `Charon`; contact durability; two-layer
  harness). ADR-0005 flags `tdd-verify.yml` as broken scaffold.
- **Invariants:** `docs/tdd/project-invariants.md` — 10 load-bearing invariants, each
  cited to file:line. **Only #6 (reduced motion) is proven today**; #1–#5,#7–#10 are
  UNPROVEN and drive the backlog.
- **Backlog:** `.claude/state/backlog.md` — 11 prioritized items (CI → contact
  durability → chat coverage gaps → frontend guards → cleanup), with a per-invariant
  coverage audit of the existing 70-test pytest suite.

## Open navigator decisions (block nothing but item framing)
- (a) Confirm the single-origin **reframing** of invariant #2 (production is cross-origin
  via CORS; same-origin `/api/*` is local-dev only). Default: accept.
- (b) `tdd-verify.yml`: repurpose-in-place vs delete-and-fold. Default: repurpose. Item 1
  acceptance is identical either way.

## How to resume
1. Read AGENTS.md, then this file, then state/backlog.md + design-notes.md + the ADRs.
2. Run BOTH layer suites for ground truth (commands above).
3. Build the top "Next up" backlog item via the red→green loop: set
   `.claude/state/{layer,phase}`, planner → ordered slices in plan.md, then
   red→test-writer / green→implementer; tdd-critic every ~3 cycles.

## Cycle log (newest first)
- 2026-06-06 — **PRODUCTION release: Team Tactics contact CTA.** Merged `origin/agent` → `main`
  (`d9ce997`), prod API metas kept (`index.html`/`admin` staging hosts rejected). deploy-prod run
  `27051407724` GREEN. qa-verifier PASS on staging before promote; navigator confirmed prod path.
  Recorded in `releases.md`.
- 2026-06-06 — **SHIPPED Team Tactics contact CTA** (`[app]`). Private repo: `link` → `#contact`,
  `linkText` → **Request access**, `contactPrefill` with subject/message. [`js/project-link.js`](js/project-link.js)
  + [`js/projects.js`](js/projects.js) closes project dialog and lazy-opens contact form on CTA click.
  Guards in `test/team-tactics-project.test.mjs`. `chatSummary` on team-tactics + ai-assistant
  prevents rebuild regression. app 43 pass / 1 skipped; tdd-critic PASS; product-owner ACCEPTED.
  **Committed** `0f4ab64` (product) · harness `46d938a`. **Pushed** to `origin/agent`
  2026-06-06; CI deploy-staging run 27051135017 GREEN.
- 2026-06-06 — **Adopted team-tactics 0.32.0 (full-team preset).** Ran
  `npx github:geda0/team-tactics@latest update --preset full-team` — already on 0.32.0; refreshed
  mechanism files + merged settings hooks; data preserved (`tdd.config`, invariants, state).
  validate OK (app + chat layers). selftest **15/15**; app **36/36**. Manifest timestamp only in
  git diff unless uncommitted kit files differ from HEAD.
- 2026-06-04 — **FEATURE: enhance project dialog text** (phase `off`). Root cause: dialog used
  regex-stripped `textContent` (blob + literal `&ldquo;`). Now renders trusted HTML via
  `innerHTML`; `htmlToPlainText` for card/spaceman plain paths. CSS: paragraph spacing, section
  labels from `<strong>`, code + list styling. Cleaned entities in `projects.json`; chat
  `stripHtml` decodes entities. `test/project-description-format.test.mjs`. app 34/34.
- 2026-06-04 — **FEATURE: Team Tactics featured on website** (phase `off`). Polished playground
  entry (`label: Open kit`, tighter card + dialog copy, ties to this repo). Rebuilt
  `team-tactics.svg` for card-scale legibility (title, tic bus, hooks, orchestrator, agents;
  XML entities for arrows). `test/team-tactics-project.test.mjs` pins featured id + clean SVG.
  Regenerated chat-knowledge. app 32/32. Not yet committed.
- 2026-06-04 — **SHIPPED frontend bundle guards (#1 + #2)** — formal close. Acceptance mapped:
  invariant **#1** ← `test/frontend-no-secrets.test.mjs` (bundle scan + index/admin meta/GA);
  invariant **#2** ← `test/frontend-api-config.test.mjs` (no remote hosts in `js/`, site-config
  imports/fallbacks, session `websocketUrl`). app **30/30**; tdd-critic **PASS** (behavior-level
  characterization, green-on-write). Invariants #1/#2 → PROVEN. Not yet committed.
- 2026-06-04 — **Adopted team-tactics 0.9.2 + SHIPPED chat voice-timbre lock (#10).** 0.9.2 (tagged
  `v0.9.2`) adds enforced write-claims to guard-edit-scope (P1 sectioning) — gated + NO-OP without a
  `.claude/state/scope` file, so the gate is unchanged here (selftest 13/13); committed `66c08e6`.
  Then ran the chat red→green loop for **#10**: planner sliced S1–S4 (pure functions); test-writer
  added 4 characterization tests to `docker/chat/tests/test_live_voice_timbre.py` (default→Charon,
  override honored, connect-config prebuilt voice, cadence directive) — all green-on-write (lock
  pre-existed, ADR-0003). chat 80→84. tdd-critic PASS-on-substance (2 by-design advisories →
  optional follow-ups); product-owner accepted → Shipped; invariant **#10 PROVEN**. **Milestone:
  all chat-layer invariants proven; remaining = #1/#2 (`[app]` frontend guards) + #8 cap.** Not yet
  committed (this feature).
- 2026-06-04 — **Adopted team-tactics 0.9.0 + SHIPPED chat model fallback (#9).** 0.9.0 (untagged
  on main; navigator pushed `v0.9.0` @ `6073ec1`) adds divide-and-conquer + sectioning docs +
  local `tics` viewer; gate unchanged (selftest 13/13); committed `dfece9f`. Then ran the chat
  red→green loop for **#9** (model fallback): planner sliced S1–S5; test-writer added 5
  characterization tests to `docker/chat/tests/test_gemini_routing.py` (astream + ainvoke
  rate-limit→fallback, committed-midstream propagation, non-rate-limit-not-retried, distinct-model
  guard) — all green-on-write (logic pre-existed). Seam: construct `GeminiRoutingChain` directly +
  class-level `_build_chain` monkeypatch (chain has `__slots__`), assert routed-output/propagation
  (not call counts). chat 75→80. tdd-critic = PASS; product-owner accepted → Shipped; invariant
  **#9 PROVEN**. Follow-ups filed (cross-turn fallback-first persistence; `last_model_id`). Not
  yet committed (this feature).
- 2026-06-04 — **PRODUCTION DEPLOY — GREEN.** Per navigator (Go, full prod deploy), gated on a
  staging E2E contact submission (qa-verifier **PASS**: persist→sent in ~2.8s, honeypot no-IO,
  400 on invalid). Built the prod CI pipeline: OIDC role `gvp-prod-ci-deploy` (main-only trust,
  contact-only policy scoped to `page`; no IAM iteration needed — preloaded the staging-learned
  perms), `AWS_DEPLOY_ROLE_ARN_PROD` secret, `deploy-prod.yml` (push→main path-filtered +
  dispatch, test-gated, `integrate-and-deploy.sh prod`). FF-pushed `main` (639eea8→`fda626f`, 16
  commits) → auto-triggered `deploy-prod` run **26938125929** (test ✅ + deploy ✅, 1m23s) +
  Amplify www rebuild. Health: `page` UPDATE_COMPLETE, contact `lwi0vmdpb5` OPTIONS 204 (matches
  FE prod meta), `www.marwanelgendy.link` 200, prod chat ECS `chat-api.marwanelgendy.link` 200
  (untouched). Frontend visually unchanged (work is backend/tooling). 1 staging QA item to clean
  (`cfe4b88e…` in page-staging-ContactMessagesTable).
- 2026-06-04 — **Adopted team-tactics 0.8.5 + DEPLOYED to STAGE (contact-only, GREEN).** 0.8.5 was
  untagged on `main`; navigator pushed `v0.8.5` (commit `7badc88`), then `npx …#v0.8.5 update`:
  tics-view `.js`→`.cjs` (CommonJS) + new `sections.md` context-map seed; gate unchanged (settings
  untouched), selftest 13/13, app 23/23, chat 75/75; committed `63e0a5b`. Merged → `agent`
  (`8f4584c`, staging URLs intact) + pushed. Triggered `deploy-staging` (run **26936642631**):
  **test ✅ + deploy ✅** (55s, CONTACT-ONLY — first run after CHAT_SAM_STACK_NAME removal + IAM
  tighten, so it also verified that config). Health: contact `fvfqpef8kb` OPTIONS 204 (matches FE
  meta), frontend `chat.marwanelgendy.link` 200, ECS chat `chat-api-stage` 200 (untouched).
  Note: CI actions run on Node20 (GitHub deprecation 2026-06-16 — bump action versions later).
- 2026-06-04 — **Adopted team-tactics 0.8.3 + finalized staging CI/CD (contact-only).** 0.8.3 was
  untagged (only on `main`); navigator pushed `v0.8.3` (commit `35a1c6c`), then
  `npx github:geda0/team-tactics#v0.8.3 update`: adds local `tics` viewer CLI
  (`.claude/hooks/tics` + `tics-view.js`) + per-layer tic auto-scope; gate unchanged (settings
  untouched), selftest 13/13, app 23/23, chat 75/75; committed `16b423f`. Then per navigator
  (contact-only CI): removed `CHAT_SAM_STACK_NAME` var, tightened the OIDC role to contact-only,
  and **tore down the orphaned chat** — deleted CFN `gvp-chat-stage` + `*-CompanionStack` + the
  companion ECR repo; **preserved** `gvp-chat` (ECS voice repo), `page-staging`, SAM bucket.
  Final staging CI/CD: push→`agent` → test gate → contact-only `integrate-and-deploy.sh stage`;
  chat stays manual (ECS at `chat-api-stage…`). (IAM ops used ambient root creds — flagged.)
- 2026-06-04 — **Staging CI/CD pipeline COMPLETED + verified GREEN.** Built
  `.github/workflows/deploy-staging.yml` (push→`agent`, path-filtered, test-gated, runs
  `integrate-and-deploy.sh stage`; frontend=Amplify, SYNC=0). Root cause of "not complete": repo
  had 0 secrets/vars (local deploys use ambient AWS creds + `.secrets/`). Seeded 6 secrets + 6
  vars from `.secrets/` (piped, never printed); `CHAT_VOICE_ECS_BOOTSTRAP=0`. Existing OIDC role
  was for `geda0/Based`; created **`gvp-staging-ci-deploy`** (OIDC, trust `repo:geda0/gvp:*`,
  SCOPED policy; dev-ops added 2 in-scope perms: SAM transform changeset + `--resolve-image-repos`
  CompanionStack). Deploy run **26929994505 SUCCESS** (3m29s): contact `page-staging`
  (`fvfqpef8kb…` matches FE meta ✓) + chat Lambda `gvp-chat-stage` (`m7qmz78kb6…`); health 200/204.
  **CAVEAT:** FE chat meta → `chat-api-stage.marwanelgendy.link` (ECS/ALB voice, separate) so the
  CI chat Lambda is orphaned — chat-deploy-via-CI needs a navigator decision (ECS vs Lambda+repoint
  vs contact-only). IAM role created via ambient **root** creds (flagged). See releases.md.
- 2026-06-04 — **Adopted team-tactics 0.8.0 + deployed to STAGING.** `npx github:geda0/team-tactics#v0.8.0
  update` (pinned git tag — NOT `npx tics`, which is an unrelated npm pkg): non-blocking
  `subagent-handoff.sh` SubagentStop hook + scoped/spool tics; referee unchanged (selftest 13/13),
  data preserved; committed `cb2317b`. Then per navigator: merged `claude/compassionate-dubinsky-de3583`
  → `agent` (the Amplify staging-deploy branch) in a throwaway worktree — conflict-free (`514f938`),
  staging URLs preserved (contact `fvfqpef8kb…`, chat `chat-api-stage…`); verified app 23/23 + chat
  75/75 green, then `git push origin agent` (6771384..514f938) → Amplify staging build.
  `chat.marwanelgendy.link` reachable. Recorded in `releases.md`.
- 2026-06-04 — **Chat turn-persistence (items 1–2) SHIPPED** under team-tactics 0.7.0. Ran the
  red→green loop on the `chat` layer: planner sliced S1–S5; test-writer added 5 characterization
  tests (non-stream error/timeout + streaming ok/error/timeout) to
  `docker/chat/tests/test_turn_persistence.py` — all green-on-write (the persistence behavior
  pre-existed in `main.py`; we pinned it). chat 70→75 green. Emitted `delegate` tics per the new
  protocol; hooks logged `signal` tics (`.claude/state/tics.jsonl`). tdd-critic = PASS;
  product-owner accepted → Shipped; invariants #7 PROVEN, #8 timeout-row proven (cap clause
  backlogged). Not yet committed.
- 2026-06-04 — Adopted **team-tactics 0.7.0** (rename from teamentic 0.5.0; adds tic protocol).
  Ran `npx github:geda0/team-tactics#v0.7.0 update` — NOT `npx tics` (that resolves to an
  unrelated npm package `tics@3.x`; team-tactics ships from the git repo only). Refreshed
  mechanism files + AGENTS/CLAUDE/KICKOFF managed blocks; manifest dir `.teamentic`→`.team-tactics`;
  added `tic.sh` + `docs/tics/tic-protocol.md`; `.gitignore` now ignores `tics.jsonl`. Data files
  preserved (configSchema still 2). selftest **13/13 PASS**, suite **23/23**. Committed the whole
  session (bootstrap + contact + kit) as 5 logical commits. Next: chat coverage (items 1–2).
- 2026-06-03 — Contact sender (item 4) + FEATURE ACCEPTANCE: S6–S9 green, 23/23 `node --test`.
  Drove `aws/src/contact-sender-core.js` (success→markSent · skip already-sent/missing ·
  fail→markFailed+rethrow; NO @aws-sdk) red→green; S9 rewrote `contact-sender.js` → thin
  composition root (real Get/Update store + `sendViaResend`, `node --check` OK, reviewed by
  orchestrator). Final tdd-critic = **PASS** (3 non-blocking obs → 2 logged as follow-ups).
  product-owner accepted items 1,2,3,4,11 → Shipped; project-invariants.md #3/#4/#5 → PROVEN.
  **Milestone boundary** — paused for navigator (commit / deploy / continue to chat items).
- 2026-06-03 — Contact ingress (items 2–3): S1–S5 green, 20/20 `node --test`. Drove
  `contact-ingress-core.js` (full handler, NO @aws-sdk) via red→green:
  valid·persist-fail·enqueue-fail·honeypot·honeypot-decoy·parse-400·validate-400·
  missing-env-500·method-gate. Added `test/contact-core-no-aws-sdk.test.mjs` guard. S5
  rewrote `contact-ingress.js` → thin composition root wiring real PutCommand
  (attribute_not_exists) + SQS (node --check OK, behavior identical, reviewed by
  orchestrator). tdd-critic after S4 = PASS on S1–S4; flagged S5-readiness → drove the
  S4a–S4e branch-parity slices. Deferred: core now logs in its catch (could inject a
  logger). Next: sender S6–S9 (inv #5).
- 2026-06-03 — CI fixed (items 1 + 11): dev-ops repurposed `tdd-verify.yml` → `node --test`
  on every push/PR (no install step); chat pytest still gated by
  `docker-compose-chat-ci.yml`; no broken workflow remains. Navigator chose repurpose-in-place.
- 2026-06-03 — Bootstrap: added `chat` pytest layer to tdd.config; recorded green
  baseline (app 10/10 · chat 70/70); architect wrote ADR-0001..0005; product-owner
  wrote project-invariants.md (1/10 proven) + backlog.md (11 items). Phase held `off`
  (doc/config work). Next: navigator sign-off, then fix CI (item 1) + start contact
  durability (item 2).
- (seed) Kit installed. Define the first feature via KICKOFF.md.
