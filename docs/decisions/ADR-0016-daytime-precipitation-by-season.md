# ADR-0016 — Daytime precipitation by season: one decision leaf, one root attribute, one homogeneous pool

- Status: Accepted
- Date: 2026-10-23
- Seam owner: architect
- Cited by: **M3** (`docs/plan-2026-09-port.md` § *M3 — Daytime precipitation by season*).
- Extends: **ADR-0015** (§3 here is the same decide/draw split as ADR-0015 §4.2, applied to a
  renderer instead of a dialog — the argument for *why* is in §3.1, not assumed).
- Touches: project invariant **#6** (reduced motion, canvas) — one clause added, §8.
  Project invariant **#12** (living theme) is **not** touched; §3.2 says why.
- Supersedes: nothing. §10 **refutes six claims** in the plan's M3 text and **one** in plan §0.
  §11 files four pre-existing defects found while verifying. Refutations are recorded, not deleted.

---

## 0. How to read this ADR

Facts labelled **MEASURED** were read out of the repo on branch `agent` on 2026-10-23 and are cited
to `file:line`, or were produced by running something named here. **DERIVED** facts follow from a
MEASURED fact by argument, not by observation. **UNVERIFIED** facts come from the 2026-08 transcript
via `docs/plan-2026-09-port.md` and could not be checked here. Line numbers drift; the cited symbol
is the anchor.

Suite baseline, MEASURED by running `node --test` at repo root: **377 tests / 376 pass / 1 skipped**
at `fd0eff6`, and **382 / 381 pass / 1 skipped** forty minutes later at `5ff6c39` — another track
landed three commits (including a real-browser journey harness) *while this ADR was being written*,
which is why §10.2 corrects itself. (The plan's "baseline at plan time" of 203/202 is stale by two
milestones.)

Render baseline, MEASURED by running `node scripts/qa/starfield-ab-draws.mjs HEAD 12 120`:
`identical: true`, **21 960 draw calls over 120 frames = 183 per frame, all of them snowflakes.**
183 is exactly `defaultExperienceSnowflakeCount()` at the harness viewport, and `sp.star` is `0` at
noon, so **the entire daytime draw stream today is the snow pool and nothing else.** That number is
the before-picture M3 is measured against.

---

## 1. Context

The claim M3 ships is one sentence: **the weather outside matches the season outside.** Today it
snows every day of the year.

MEASURED, `js/starfield.js:605-611` — the only daytime precipitation in the app:

```js
if (snowflakes.length && sp.sun > 0.01) {
  c.save()
  c.globalAlpha = Math.min(1, sp.sun)
  drawSnowParticles()
  c.restore()
}
```

M3 adds two kinds beside it and a rule for choosing between the three. That rule is a **calendar**
decision landing inside the **hottest file in the repo** — `js/starfield.js` has just had six
slices of perf work applied to it (M1) and the branch carries two explicit reverts *because a
change altered the render* (plan §0, `2d079aa`, `bf853d7`). So the shape of this ADR is almost
entirely about keeping the calendar out of the renderer and keeping the renderer's existing output
provably unchanged on the snow kind.

Four things make that harder here than the plan assumes, all MEASURED:

1. **No test in this repo has ever booted the starfield at a daytime hour.** Every stub-canvas test
   pins `timeHours: '22'` — `test/starfield-cull-wiring.test.mjs:71`, and the defaults at
   `test/starfield-perf.test.mjs:57` and `test/starfield-depth-wiring.test.mjs:62`. The branch M3 is
   about to rewrite has **zero** wiring coverage. The only snow coverage anywhere is the pure count
   tier in `test/starfield-reduced-motion.test.mjs:47-57`.
2. **The repo's only render-identity tool cannot see a stroked line.**
   `scripts/qa/starfield-ab-draws.mjs:71` has `stroke () {}` — a no-op that logs nothing — and only
   `drawImage` is recorded (`:85-95`). Rain drawn as strokes is *invisible* to the harness.
3. **Two test files classify sprites by `img.height === 4`** — `test/starfield-cull-wiring.test.mjs:40`
   and `test/starfield-perf.test.mjs:32`, plus the harness at `:89`. MEASURED: that is the star
   streak strip (`STREAK_SPRITE_H = 4`, `js/starfield.js:311`). It is an undeclared contract, and a
   new 4-pixel-tall sprite silently breaks three files.
4. **The renderer must not acquire a `new Date()`.** The harness pins `Date.now` and says so at
   `:136-141` ("Snow drift and the firefly wander read `Date.now()` directly … without this, hours
   12 and 19 reported a difference that was the wall clock, not the renderer"). DERIVED: `new Date()`
   does **not** route through `Date.now`, so a calendar read inside `js/starfield.js` would be
   un-pinned by that fake — and the harness would start reporting a different draw stream depending
   on **what day you run it**.

Everything below falls out of those four.

---

## 2. Decision — `js/precipitation.js`, the decision leaf

### 2.1 The address

`js/precipitation.js`, flat, beside `js/theme-time.js` and `js/starfield-prefs.js`. **Not**
`js/lib/rain/`.

The plan's M5 context map assigns rain to `js/lib/ … rain (engine, prefs)` and plan decision 3
("M5: address-first") says later milestones write directly at their `js/lib` addresses. MEASURED:
**no milestone has done this.** M1 shipped its pure leaf at `js/starfield-geom.js`, and M2 shipped
`js/site-state.js`, `js/chat-stage.js`, `js/site-state-notes.js`, `js/nav-promise-gap.js` — all
flat. Address-first has been stated twice and honoured zero times.

Decision: **flat, consistent with every shipped leaf**, and §10.6 refutes the M5 address so that
M5's boundary test is not written against a directory nothing uses. A `js/lib/` reorganisation is a
mechanical move whenever M5 actually wants it; writing one module there now produces a repo with
one file in `js/lib/` and twenty beside it, which is worse than either answer.

**Hard constraint, same bar as `js/theme-time.js:8-9`: zero imports, zero DOM, zero side effects,
and no reads of ambient globals** (§2.4 on `Intl`). That is what makes every decision below
testable with no canvas, no jsdom and no clock-faking, in a repo with zero test dependencies.

### 2.2 The signatures and the one return shape

```js
export const PRECIPITATION_KINDS  = ['snow', 'rain', 'hail']
export const SEASONS              = ['winter', 'spring', 'summer', 'autumn']
export const SHOULDER_SEASONS     = ['spring', 'autumn']
export const HAIL_ONE_IN          = 9
export const FALLBACK_KIND        = 'rain'

export function hemisphereFor (timeZone)                // → 'north' | 'south'
export function dayKeyFor (date)                        // → integer, local calendar
export function seasonFor (date, hemisphere)            // → a member of SEASONS
export function isHailDay (date)                        // → boolean
export function precipitationFor (date, opts)           // → frozen descriptor (below)
export function parsePrecipitationKind (raw)            // → a member of PRECIPITATION_KINDS
```

`precipitationFor` returns a **frozen three-field descriptor, not a bare string**:

```js
Object.freeze({
  kind:       'snow' | 'rain' | 'hail',
  season:     'winter' | 'spring' | 'summer' | 'autumn',
  hemisphere: 'north' | 'south'
})
```

**Why not a bare string.** The renderer genuinely needs only `kind`, and the smallest contract is
the house preference — so this needs an argument. It is this: the decision has **two inputs the
caller cannot recover from the answer**. `'rain'` does not tell you whether it is spring, summer or
autumn, nor which hemisphere was assumed. Three consumers want exactly that: a QA run pinning
"rain, because southern summer" rather than "rain, somehow"; the `landmark`/diagnostic line an
operator reads when a visitor in Sydney reports snow in January; and any later feature that wants
to say "it's autumn" (a seasonal tint, an assistant line). With a bare string, every one of them
re-calls `seasonFor` and `hemisphereFor` and **re-derives the decision outside the leaf** — which
is precisely the drift this ADR exists to prevent. A three-field frozen object is the smallest
thing that closes that door.

**Why it carries nothing else.** No counts, no speeds, no radii, no colours. `js/starfield-prefs.js`
is the single source of truth for counts and tiers — that is invariant #6's stated
implemented-by — and a descriptor that carried render parameters would make it the *second* source.
`precipitationFor` answers *what*, `precipitationCountForPreference` answers *how much* (§5),
`sceneParamsAt` answers *how bright* (`js/theme-time.js:80`). Three questions, three owners, no
overlap.

**Why frozen.** Same reason `getSiteState()` freezes (ADR-0015 §3.2): a renderer that mutates the
descriptor it was handed would be a decision-maker, quietly. One `Object.freeze` per *change* (§3.3
memoises), not per frame.

### 2.3 `seasonFor` — meteorological, month-granular, one table and a rotation

```
northern:  Dec Jan Feb → winter   Mar Apr May → spring   Jun Jul Aug → summer   Sep Oct Nov → autumn
southern:  seasonFor(d, 'south') === the northern season of the month six months away
```

i.e. one 12-entry table indexed by `date.getMonth()`, and the southern answer is the same table at
`(month + 6) % 12`.

**Why meteorological and not astronomical.** Astronomical seasons start at solstices and equinoxes,
which move by a day or two per year and need either an ephemeris or a hardcoded approximation that
is wrong in some years. The WMO/meteorological boundaries are month-aligned, standard, exact, and
need only `getMonth()`. The entire user-visible difference is *which of two adjacent days* flips
snow to rain — nobody can see it, and the astronomical version buys that invisible accuracy at the
price of a calculation that is wrong on a schedule.

**Why the 6-month rotation and not two tables.** Two tables is 24 facts that can disagree. The
rotation is one table plus one identity, and the identity is a **property test over all 12 months**
(`seasonFor(month, 'south') === seasonFor((month+6)%12, 'north')`) rather than 24 golden rows. A
southern-hemisphere typo becomes structurally impossible instead of merely untested.

**Why local month and not UTC.** `js/theme-time.js:38` reads `getHours()` — the shipped clock is
local wall-clock, and invariant #12 is written in those terms. A UTC month would put the
December→January season flip at a different instant from the midnight the sky already wraps at.
Consistency with the shipped clock is the whole argument.

### 2.4 Hemisphere — resolved, with the ambiguity in exactly one place

The plan says "hemisphere-aware" and nothing more. Four mechanisms were considered:

| mechanism | verdict |
|---|---|
| Geolocation API | **Rejected.** A permission prompt for a decoration, async, and denial is the common case. |
| IP geolocation (server) | **Rejected.** A new network dependency and a new privacy claim, for snow-vs-rain. |
| `getTimezoneOffset()` | **Rejected — it does not work.** The offset is a longitude fact. Sydney and Vladivostok share it. |
| IANA zone id from `Intl` | **Accepted.** Synchronous, no permission, no network, already in the browser. |

Decision:

- **`hemisphereFor(timeZone)` is a pure string→string function with a southern allowlist and
  `'north'` as the default.** There is **no `'unknown'` return value.** ~30 entries:
  `Australia/*`, `Antarctica/*`, the southern `Pacific/*` (`Auckland`, `Chatham`, `Fiji`,
  `Port_Moresby`, `Noumea`, `Tongatapu`, `Apia`), `America/Argentina/*` plus `America/Sao_Paulo |
  Santiago | Montevideo | Asuncion | La_Paz | Lima | Punta_Arenas`, and the southern `Africa/*`
  (`Johannesburg`, `Windhoek`, `Gaborone`, `Harare`, `Lusaka`, `Maputo`, `Maseru`, `Mbabane`,
  `Luanda`, `Antananarivo`). Everything else, including an empty or unparseable string, is `'north'`.
- **The leaf never touches `Intl`.** The DOM layer (§3) resolves the zone —
  `try { Intl.DateTimeFormat().resolvedOptions().timeZone } catch { '' }` — and passes it in.
  This is the same injection trick as ADR-0015 §4.2's `ctx.wide`: the reducer never reads `window`,
  so the breakpoint is testable without a browser. Here it means `precipitationFor` is a pure
  function of its arguments even on a Node build without full ICU (where `resolvedOptions().timeZone`
  answers `'UTC'`), so the test suite can never go red because of the host's locale data.
- **`opts.hemisphere` overrides everything** when it is a member of `{north, south}`. Resolution
  order: `opts.hemisphere` → `hemisphereFor(opts.timeZone)` → `'north'`.

**"Unknown" is therefore resolved as: it collapses to `'north'` at the seam, deliberately, and the
guess is reported back in the descriptor.** The alternative — a third `'unknown'` state that renders
something neutral — was rejected because the two populations that produce it are opposites. A
visitor whose browser has no `Intl` is overwhelmingly northern (that is where the browsers are);
a visitor whose zone is simply missing from a 30-entry allowlist is probably in a country the
allowlist does not need. Telling both of them "no season" is worse for both than guessing the
majority and saying so in the descriptor.

**Equatorial zones are NOT special-cased, and this is a named residual.** Singapore, Nairobi and
Bogotá will see snow in December under the northern table, which is wrong. It is *less* wrong than
today, where they see snow in all twelve months. A third `'tropic'` value would need a bigger table
than the southern one, with a per-city judgement call at every boundary (Lima is 12°S and famously
never rains). Deferred, and **additive when wanted**: `hemisphereFor` starts returning `'tropic'`
and the §2.5 table gains one row. The seam does not change, so this needs no new ADR.

**The timezone is not a new sink.** It never leaves the browser. It must **not** be added to
`siteState`, to the `/api/chat` body, or to any analytics payload — that would be a new field on an
unauthenticated route under invariant #17 and ADR-0015 §6.3's bound. Same for `kind`: it is
decoration, not state the model needs.

### 2.5 `isHailDay` — a function of the local calendar day, hashed

```js
isHailDay(date)  ===  mix32(dayKeyFor(date)) % HAIL_ONE_IN === 0
dayKeyFor(date)  ===  y * 10000 + (m + 1) * 100 + d      // LOCAL getFullYear/getMonth/getDate
```

with the splitmix32 finaliser, constants pinned here so a later "harmless" refactor cannot re-roll
everyone's calendar:

```js
x ^= x >>> 16;  x = Math.imul(x, 0x7feb352d)
x ^= x >>> 15;  x = Math.imul(x, 0x846ca68b)
x ^= x >>> 16;  return x >>> 0
```

**A function of what, exactly: the local calendar triple, nothing else.** Not the hour, not the
hemisphere, not the season.

- **Not the hour**, so the weather does not change under a visitor who is watching, and so the
  time slider (`js/theme.js:93`) cannot re-roll it by dragging.
- **Not UTC**, because a UTC day boundary flips at mid-afternoon in Sydney and 7pm in Los Angeles.
  "Per day" has to mean *the visitor's* day; local midnight is also where the sky already wraps.
- **Not the hemisphere**, so a northern and a southern visitor on the same date both get hail — one
  in spring, one in autumn. The lottery is a global fact about the day; the season decides whether
  that day's weather is a kind that hails.
- **Not the season.** `isHailDay` is the *lottery*, not the *forecast*: it returns `true` on a
  January day where it will in fact snow. The alternative (fold the season check inside) duplicates
  §2.3 in two functions and makes the distribution untestable in isolation — you would have to hunt
  for nine consecutive shoulder-season days to probe a 1-in-9 rate. Keeping the name `isHailDay`
  (the plan's name — traceability, the same reason ADR-0015 kept `docked`) is a deliberate small
  imprecision, paid for by making `precipitationFor` the **only** caller and saying so in the JSDoc.

**Why a hash beats `dayKey % 9` — this is arithmetic, not taste.** `10000 ≡ 1` and `100 ≡ 1 (mod 9)`,
so `dayKey % 9 ≡ (y + m + d) % 9`. Consecutive days increment `d` by one, so the residue increments
by one, so **hail lands on exactly every ninth day, forever**, with a phase jump at each month
boundary. MEASURED over 3 653 days from 2026-01-01:

| | hail days | rate | distinct gaps between hail days |
|---|---|---|---|
| `dayKey % 9` | 404 | 1/9.04 | **8 distinct values**: 2, 3, 5, 9, 10, 11, 12, 14 |
| `mix32(dayKey) % 9` | 393 | 1/9.30 | **37 distinct values**, min 1, max 52 |

The naive version has the right *rate* and a visible *lattice*: hail every 9th day, learnable in a
month. The hash has no structure — adjacent days are uncorrelated, short hail spells happen (longest
run MEASURED: 3 days, expected ~5 times a decade), and over the northern shoulder seasons alone the
rate is 1/9.06. (`% 9` over a 32-bit range is biased by ~2.3 × 10⁻¹⁰, because `2³² ≡ 4 (mod 9)` —
eleven orders of magnitude inside any test tolerance.)

**Why not `Math.random()` — four distinct failure modes, each sufficient on its own.**

1. **It re-rolls on every call.** MEASURED: `applyThemeTime` runs at boot (`js/theme.js:102`), once a
   minute on the auto tick (`:82`, `AUTO_TICK_MS = 60000`), and on every slider input (`:97`). With
   `Math.random` the kind would flip between hail and rain about every nine minutes, all day. The
   weather would strobe.
2. **Two tabs would disagree**, and a reload would change the weather. "Today's weather" stops being
   a property of today.
3. **It is untestable here.** Zero test dependencies, no mocking library; the only way to test a
   `Math.random` branch is to monkeypatch the global.
4. **It would poison the render-identity harness.** MEASURED, `scripts/qa/starfield-ab-draws.mjs:133-135`:
   sprite baking and star seeding both draw on `Math.random` and "both runs must see the same
   sequence from the same point." Any new consumer of the global stream in the render path shifts
   **every subsequent star**, and the harness reports a whole-stream difference for a one-line
   change. §3 keeps the decision out of `starfield.js` entirely, which neutralises this — but the
   leaf must still be hash-based so it is callable from anywhere without perturbing anyone's RNG.

**Pins the test should carry** (three, cheap, and they catch different things): the rate over
3 650 days within ±10%; the **anti-lattice** assertion (the gap set over a decade contains a 1 and
contains something > 20 — i.e. it is not periodic), which is the one that fails if someone
"simplifies" the mixer away; and golden day pins, MEASURED: `2026-03-20` → `true`, `2026-04-03` →
`true`, `2026-01-15` → `true` (a *winter* hail-lottery day, so `precipitationFor` must still answer
`snow` — that single row proves the lottery is consulted only in shoulder seasons), `2026-10-23` →
`false`, `2026-11-07` → `false`.

### 2.6 The decision table, and totality

| season | kind |
|---|---|
| winter | `snow` |
| spring | `isHailDay(date) ? 'hail' : 'rain'` |
| summer | `rain` |
| autumn | `isHailDay(date) ? 'hail' : 'rain'` |

**No exported function throws, ever.** A renderer is driven by `requestAnimationFrame`; an exception
in the decision path does not produce a wrong colour, it **stops the animation loop for the rest of
the session**. So the leaf follows invariant #12's posture verbatim ("out-of-range / nullish inputs
are clamped, never thrown"): a nullish, non-`Date` or `Invalid Date` input falls back.

**The fallback is `rain`, and there is exactly one of them.** Three candidates were weighed:

- **`snow`** — today's behaviour, and the *only* wrong answer. Snow in July is the bug M3 exists to
  fix; a fallback that reproduces it would make the bug survive its own fix in the one case nobody
  tests.
- **nothing / empty sky** — rejected on the same asymmetry `js/starfield-geom.js:9-13` argues for
  the cull: drawing something invisible costs one clipped `drawImage`; *not* drawing deletes a
  visible feature, and a blank daytime sky is indistinguishable from a dead renderer.
- **`rain`** — unseasonal at worst, never absurd, plausible in nine months of twelve, and the same
  answer the (deferred) tropical case will want. Chosen.

`parsePrecipitationKind(raw)` returns the same `FALLBACK_KIND` for anything unrecognised, so the
leaf's fallback and the renderer's fallback are **the same constant in the same module** rather than
two defaults that drift (§3.4).

---

## 3. Decision — where it is DECIDED versus DRAWN

### 3.1 Yes, the same split as M2's stage reducer — and here is why it is not just symmetry

The orchestrator asked whether M3 should mirror ADR-0015 §4.2 (one pure function decides, a thin
layer applies). It should, and the reasons are *stronger* here than they were there:

- The decision's inputs are a **calendar and a timezone**. Both are environment. A pure leaf that
  takes them as arguments is testable in `node --test`; a renderer that reads them is testable only
  by faking globals — and §1.4 shows the existing fake (`Date.now`) does not even cover the one it
  would need (`new Date`).
- The decision changes **once a day**; the renderer runs **sixty times a second**. Those are not the
  same cadence and should not be the same code.
- M2's split existed so an a11y contract could be asserted as data. M3's exists so a *calendar* can
  be asserted as data. Same shape, same reason: the alternative puts the milestone's headline claim
  in the most expensive venue the repo has.

### 3.2 The seam is one root attribute, written by `js/theme.js`

```
js/precipitation.js   precipitationFor(new Date(), { timeZone })  →  { kind, season, hemisphere }
       ↓ (imported by)
js/theme.js           applyThemeTime(hours)  →  root.dataset.precipitation = kind
       ↓ (read from the DOM, per frame, like the hour already is)
js/starfield.js       drawTime() → the pool for that kind
```

`data-precipitation` on `<html>`, i.e. `document.documentElement.dataset.precipitation`.

**Why `theme.js` and not `starfield.js`.** Five reasons, in order of how much they cost if ignored:

1. **The `new Date()` trap, MEASURED.** `scripts/qa/starfield-ab-draws.mjs:144-145` fakes `Date.now`
   only. `new Date()` does not consult `Date.now`. A calendar read inside `js/starfield.js` is
   therefore invisible to the harness's clock pin, and the harness — whose own comment says "a
   harness that cries wolf on the daytime scenes is a harness nobody runs" (`:140`) — would start
   producing different results depending on the date you ran it.
2. **`theme.js` already owns the clock, and `starfield.js` already reads its output from the root.**
   MEASURED: `js/theme.js:64` writes `root.dataset.timeHours`; `js/starfield.js:109-112`
   (`currentTimeHours`) reads it, per frame, at `:585`. This is not a new pattern, it is *the*
   pattern, and `theme.js` is already the module that calls `new Date()` (`:82, :88, :102`).
3. **It makes the QA override free.** Pinning a kind is one attribute — in a devtools console, in
   the AB harness's `documentElement` stub, in a wiring test. MEASURED: every stub-canvas test
   already supplies `documentElement: { hasAttribute, dataset: { timeHours } }`
   (`test/starfield-perf.test.mjs:72-75`), so reading one more `dataset` key costs those files
   nothing and gives M3 the "per kind" coverage the plan asked for — without the screenshot harness
   the plan assumes and §10.2 refutes.
4. **It keeps `precipitationFor` off the per-frame path** without a memo cache in the renderer. One
   decision per `applyThemeTime` (boot, once a minute, per slider input), and `applyThemeTime`
   writes the attribute **only when the value differs from what is already there** — so a slider
   drag does not thrash the DOM.
5. **Invariant #12 stays untouched.** `js/theme-time.js` remains "no DOM, no imports, no side
   effects" and remains a function of one scalar. `js/precipitation.js` is its **sibling**, not an
   extension: the hour and the date are different inputs with different cadences, and folding the
   calendar into `theme-time.js` would break the single-scalar claim invariant #12 is written
   around. `theme.js` — the thin DOM layer — is where the two meet, which is exactly its stated job
   (`js/theme.js:3-4`).

**Why not the `themechange` event** (which `starfield.js` already listens to, `:679`): an
event-driven re-seed goes stale the moment anything sets the attribute without dispatching —
a QA harness, devtools, a future module. A per-frame read of a string is self-healing and costs one
property access per frame, against the 183-plus `drawImage` calls that frame already makes. The
renderer compares the attribute with the kind its pool currently holds and re-seeds on mismatch
(§4.1), which is the same work `resizeCanvas` already does.

### 3.3 What the renderer is allowed to know — and a grep that enforces it

`js/starfield.js` may know: a kind string, counts and speeds from `starfield-prefs.js`, and
`sceneParamsAt`'s weights. It may **not** know about months, dates, hemispheres, timezones or hail
odds.

That is enforceable mechanically, the same way ADR-0015 §10 pinned a removed event: a source-scan
assertion that `js/starfield.js` contains no `new Date(`, no `getMonth`, no `getFullYear`, no
`Intl`, and does not import `js/precipitation.js`. `test/starfield-trail-stall.test.mjs:3-9` already
reads `js/starfield.js` as text for exactly this class of check, so the venue exists. M5's
`test/component-boundaries.test.mjs` is the long-term home; until it exists, one assertion in the
M3 wiring test. **No new invariant for this** — §8.

### 3.4 `index.html`'s boot script is **not** changed

MEASURED: the inline script at `index.html:24-43` pre-paints `data-time`, `data-theme` and
`--time-sky` to avoid a flash of the wrong sky before `theme.js` loads. It does **not** need
`data-precipitation`, because precipitation has no CSS: the attribute is read only by
`js/starfield.js`, and MEASURED `js/app.js:36-37` runs `initTheme()` **before**
`initStarfield(...)`, so the attribute is always present before the first frame exists.

Two bonuses: the boot script's duplicated day-window logic does not acquire a second copy (it
already has a defect — §11.1), and M3 touches no file outside `SRC_GLOB_app`
(`(^|/)(js|scripts|aws)/`, MEASURED `.claude/tdd.config:25`), so no slice needs an out-of-scope
edit. MEASURED: `SECURITY_GLOB` does not cover `js/` — **M3 needs no security clearance.**

---

## 4. Decision — one homogeneous pool, three draw functions

### 4.1 Rain and hail reuse the array and its init/draw path. They do not get their own.

The pool is **renamed** `snowflakes` → `precipitation` and becomes **homogeneous**: every particle
in it is the current kind. `initSnow()` becomes `initPrecipitation(kind)` and seeds per kind;
`drawSnowParticles()` becomes a dispatch to one of three per-kind movers/drawers, chosen **once per
frame**, not per particle.

Three options were weighed against the per-frame loop M1 just finished optimising:

| option | cost |
|---|---|
| One array, each particle tagged `kind`, one loop with a per-particle branch | **Rejected.** An unpredictable branch and a polymorphic property read, 183–260 times per frame, on a tag that is *constant across the whole array*. M1 spent six slices removing exactly this class of per-particle work — per-star closures → `Star.prototype` (`js/starfield.js:279-282`), per-frame gradients → baked sprites (`:218-222`), four transform calls → two (`:364-369`). Re-introducing it contradicts M1's entire thesis. |
| Three arrays, two always empty | **Rejected.** Three `if (arr.length)` guards per frame forever, three init functions to keep in sync with three prefs rows, and the allocation churn on a kind change happens anyway. Two of the three are dead at all times, and dead code still has to stay correct. |
| **One array, homogeneous, three draw functions** | **Accepted.** The branch is hoisted out of the loop — which is what the existing code already does for its loop-invariant decisions: `drift` and `snowSpeedScale` are computed once *before* the flake loop (`js/starfield.js:533-534`), not per flake. Each per-kind loop sees one object shape, so each stays monomorphic. |

**Cost of the rename, accounted:** MEASURED references to `snowflakes` at `js/starfield.js:132, 445, 448, 536-537, 562, 590, 605,
684, 689, 695`. All inside one module, all mechanical. Paid deliberately: a
variable named `snowflakes` holding raindrops is the kind of lie that makes the next reader wrong,
and the `themechange` handler's comment at `:682-683` ("snow is always on") stops being true.

**Re-seeding on a kind change is almost always invisible, DERIVED.** The daytime branch requires
`sp.sun >= sp.star`, which (from `js/theme-time.js:17-21`) holds only for hours ≈7.5–18.33. The kind
can only change at local midnight, when the daytime branch is not running and nothing is drawn. A
mid-day change happens only under a deliberate override, where a teleport is expected.

### 4.2 The RNG draw order on the snow path must not change. This is the constraint that bites.

MEASURED, `js/starfield.js:447-455`: `initSnow` draws **five** `Math.random()` values per flake, in
the order `x, y, r, phase, speed`; and `resizeCanvas` calls `initStars` → `initFireflies` →
`initSnow` (`:488-491`).

DERIVED, and this is the sharp edge of M3: **if `initPrecipitation('snow')` changes the number or
the order of `Math.random()` calls — even by adding one unused field — every subsequent particle
differs, and `scripts/qa/starfield-ab-draws.mjs` reports a full-stream difference for a change that
is visually nothing.** So:

- The `snow` branch keeps its five draws in that exact order, and the snow particle keeps its exact
  five fields. Rain and hail seed in **separate branches**, after the snow branch, so they consume
  from the stream only when they are the active kind.
- `initPrecipitation` must not draw any random value *before* the per-kind branch (no shared
  pre-roll).
- Per-kind object literals, not one union shape with unused fields. Each draw loop then sees one
  hidden class. (A union shape would also force the snow literal to change, which violates the
  bullet above.)

**The acceptance bar that follows:** `node scripts/qa/starfield-ab-draws.mjs HEAD 12 400` with the
kind forced to `snow` must report `identical: true` against pre-M3 `HEAD`. That is the whole of
M3's no-regression story for the existing look, and it is free.

### 4.3 Rain is one path and one stroke; hail is pellets plus derived tails

The plan says "batched streaks" and "pellets + tails" without defining either. Defined here, because
the definitions are what the wiring test asserts:

- **Rain:** one `beginPath()`, N × (`moveTo` + `lineTo`), **one** `stroke()` per frame, with
  `strokeStyle` / `lineWidth` set once outside the loop. Zero `drawImage`. This is the right
  technique precisely because rain is *uniform* — one colour, one width — which is why the star
  streak could **not** use it (every star has its own colour, hence a per-colour baked sprite,
  `js/starfield.js:253-264`). Note that plan M1 listed "batching streaks-then-discs" as
  *deliberately not applied* because it changes blend order; that objection does not transfer, since
  rain and the star field never draw in the same branch (§4.2's hour window).
- **Hail:** one batched `stroke()` pass for the tails (shorter, brighter than rain) **plus** one
  `drawImage` per pellet from a baked sprite, same trick as the snowflake (`:139-159`).
- **Snow:** unchanged — N × `drawImage` of the existing 6 × 6 `snowSprite`, zero strokes.

**Tail length is derived from the per-frame displacement, never a separate knob.** Reuse the
existing derivation: `streakLength(frameDelta, tailFrames)` (`js/starfield.js:87-89`). One knob
(speed) then controls both how fast a drop falls and how long its streak is, so they cannot
disagree — and §6's reduced-motion speed cut shortens the streaks automatically, with no second
tier to maintain.

**Zero gradients per frame is a standing constraint.** MEASURED `test/starfield-perf.test.mjs:111-120`
asserts `createRadialGradient === 0` and `createLinearGradient === 0` on a drawing frame. A rain
streak must therefore be a solid stroke colour, not a per-drop linear gradient. (That test runs only
at hour 22 — §10.5 and §12 fix that.)

This yields the per-frame draw-call signature, which **is** the renderer-side contract and is
assertable with the counting stub the repo already has:

| kind | `drawImage` / frame | `stroke` / frame | gradients / frame |
|---|---|---|---|
| `snow` | N (6 × 6 sprite) | 0 | 0 |
| `rain` | 0 | 1 | 0 |
| `hail` | N (pellet sprite) | 1 | 0 |

### 4.4 The sprite-height classifier is an undeclared contract — do not break it

MEASURED: three places identify a sprite by `img.height === 4` — `test/starfield-cull-wiring.test.mjs:40`,
`test/starfield-perf.test.mjs:32` (feeding the `streakDraws` counter that pins invariant #6's live
clause at `:140-153`), and `scripts/qa/starfield-ab-draws.mjs:89`. All three mean "this is a star
motion streak", because `STREAK_SPRITE_H = 4` (`js/starfield.js:311`).

**A hail pellet sprite baked 4 pixels tall would be counted as a star streak in all three.** The
cheap fix: bake the hail sprite at any height other than 4 (8 × 8 is the natural size), and add one
assertion that no two sprite kinds share a height, so the next sprite cannot re-open this silently.
If a third sprite ever genuinely needs height 4, the classifier has to become an explicit tag rather
than a dimension — but that is a bigger change than M3 needs, and converting it now would touch
three test files for no present benefit.

---

## 5. Decision — the tiers in `js/starfield-prefs.js`

### 5.1 `precipitationCountForPreference` **wraps** `snowflakeCountForPreference`

Not *replaces*, not *beside*.

```js
export function precipitationCountForPreference (kind, prefersReducedMotion)  // → integer > 0
export function precipitationSpeedMultiplierForPreference (kind, prefersReducedMotion)  // → number in (0, 1]
export function defaultExperiencePrecipitationCount (kind)                    // → integer > 0
```

- **Not replace.** MEASURED: `snowflakeCountForPreference` is named in invariant #6's
  implemented-by list (`docs/tdd/project-invariants.md`, invariant 6) and asserted by name with the
  literal `84` at `test/starfield-reduced-motion.test.mjs:47-57`; `defaultExperienceSnowflakeCount`
  likewise with `183`. Deleting it means editing an invariant and a green test to buy nothing.
- **Not beside.** Two entry points means two things the renderer could call and two places a kind
  can be forgotten.
- **Wrap.** `precipitationCountForPreference('snow', rm)` **is** `snowflakeCountForPreference(rm)`,
  by delegation — so the snow number is byte-identical, the existing tests stay green unedited, and
  `snowflakeCountForPreference` is still *called*, which matters in a repo whose scar tissue is a
  defined-but-never-called helper (`test/starfield-depth-wiring.test.mjs:5-16`).

### 5.2 What is contract and what is tunable

**Contract** (this ADR owns it):

- `STARFIELD_DEFAULT_EXPERIENCE` gains `rainCount` and `hailCount` beside the existing `snowCount:
  200`; `STARFIELD_REDUCED_MOTION` gains `rainMult`/`rainMin`/`rainSpeedMult` and
  `hailMult`/`hailMin`/`hailSpeedMult` beside `snowMult: 0.42`/`snowMin: 28`. One constants block
  stays the single source of truth — invariant #6 points at `js/starfield-prefs.js:6-31`.
- **Every kind in `PRECIPITATION_KINDS` has a row**, and the test iterates the kind list rather
  than naming three kinds. Adding a fourth kind without a tier then fails a test instead of
  rendering nothing.
- **Relational invariants**, which are the testable part and do not move when someone tunes a
  number: for every kind, reduced count < default count; reduced count ≥ a floor that is **strictly
  greater than zero**; reduced speed multiplier ≤ default; and the function never returns `0`,
  `NaN`, or a negative.
- An unknown kind resolves through `parsePrecipitationKind` to `FALLBACK_KIND`'s row rather than
  returning `undefined`.

**Tunable** (the implementer may move these; they are DERIVED starting points, not measurements):
`rainCount ≈ 260`, `hailCount ≈ 90`. Rain is denser than snow because a drop crosses an 800 px
viewport in ~60 frames against snow's ~600, so the eye reads individual streaks rather than a field;
hail is sparser and larger because a pellet is a hard, high-contrast object and a dense field of
them is visually violent. Both are subject to the same absolute-ceiling reasoning as
`test/starfield-star-budget.test.mjs:11-31` — if a count ever scales with viewport area or core
count, it needs that test's clamp, and **neither should** (183 flakes at a fixed count is the
shipped design and it is fine).

**The floor is non-zero on purpose.** A reduced-motion visitor who sees *no* precipitation has not
had the feature softened, they have had it deleted — the same asymmetry `js/starfield-geom.js:9-13`
argues for the cull.

### 5.3 Speed, not only count — and the shipped reduced tier does not do this today

MEASURED, `js/starfield-prefs.js:101-105`:

```js
export function snowSpeedMultiplierForPreference (prefersReducedMotion) {
  if (prefersReducedMotion) return 1
  ...
}
```

**Under `prefers-reduced-motion`, snow speed is not reduced at all.** The reduced tier cuts *count*
(200 → 84) and trail alpha; the speed multiplier exists only to ease the *default* experience
toward the reduced target (`js/starfield-prefs.js:24-34`). For snow at 0.6–1.8 px/frame that is
defensible — the motion is already gentle.

For rain at roughly an order of magnitude more displacement per frame, and for hail pellets with
tails, it is not: **the thing a reduced-motion visitor is reacting to is the speed.** A rain tier
that cuts only the count ships fast streaks to the people who asked for less motion, while being
fully compliant with invariant #6's current wording — which is marked *(PROVEN)* and would stay
green. That is why §8 adds a clause rather than leaving #6 alone.

So `precipitationSpeedMultiplierForPreference(kind, prefersReducedMotion)` returns a value **< 1**
for `rain` and `hail` under reduced motion, and preserves `snowSpeedMultiplierForPreference`'s exact
current behaviour for `snow` (including the `return 1`). Because §4.3 derives tail length from
displacement, cutting the speed shortens the streaks for free.

---

## 6. Decision — reduced motion, per kind

| kind | count | speed | streak / tail | other |
|---|---|---|---|---|
| `snow` | **unchanged**: 183 → 84 | **unchanged** (multiplier `1`, §5.3) | n/a | drift already forced to `0` under reduced motion, MEASURED `js/starfield.js:533` |
| `rain` | hard cut via `rainMult`/`rainMin` | **reduced**, multiplier < 1 | shortens automatically (§4.3) | one stroke pass, so no per-drop work is added |
| `hail` | cut hardest (pellets are the most salient object) | **reduced**, multiplier < 1 | shortens automatically | pellet size unchanged — size is not motion |

Three things reduced motion explicitly does **not** do:

1. **It does not change the kind.** A reduced-motion visitor is asking for less motion, not for
   different information about the season. Making the kind a function of a media query would also
   mean the *renderer* overrides the *decision*, which breaks §3's seam. This is guaranteed
   structurally, not by a test: `precipitationFor` has no reduced-motion parameter and cannot acquire
   one without changing its signature — the same trick as ADR-0015 §4.3's "voice is not an input to,
   nor an output of, this reducer".
2. **It does not reduce the count to zero** (§5.2's floor).
3. **It does not fall back to snow as "the gentle kind."** Tempting and wrong: it tells a
   reduced-motion visitor in July that it is winter.

---

## 7. Decision — how M3 uses the render-identity harness

`scripts/qa/starfield-ab-draws.mjs` compares the *visible draw stream* between a git revision and
the working tree. Rain and hail change that stream **legitimately**, so the harness cannot be an
identity gate for M3 as a whole. It is used two ways, and extended once.

**(a) As a no-regression gate on the snow kind — unchanged semantics, and this is the valuable one.**
With the kind forced to `snow`, `node scripts/qa/starfield-ab-draws.mjs <pre-M3-rev> 12 400` must
report `identical: true`. MEASURED today at `HEAD 12 120`: `identical: true`, 183 draws/frame, all
snow. §4.2 is what keeps that true, and it is the only automated proof M3 has that the shipped
daytime look survived. **Run it on every slice that touches `js/starfield.js`.**

**(b) As a before/after census for rain and hail** — not `identical`, but the printed
`drawCalls` / `visibleDrawCalls` numbers, read by a human against §4.3's table. A rain frame that
reports thousands of visible draws, or zero, is wrong in a way the number shows immediately.

> **LANDED 2026-10-23 (`981ee12`), while this ADR was being written — read the three items
> below as the rationale that produced the change, not as outstanding work.** All three are
> in `scripts/qa/starfield-ab-draws.mjs`: the kind argument (`argv[5]`, fed to the
> `documentElement.dataset` stub), `stroke()` logging with accumulated paths plus an
> `invisible()` branch that measures stroked extents, and the height-table classifier with a
> `sprite<h>` fallback. Re-measured after: `HEAD 12 200 0 snow` → `identical: true`, and
> night at `HEAD 22 200` unchanged.

**Three extensions M3 must make, all small, all in `scripts/qa/starfield-ab-draws.mjs`:**

1. **A kind argument** (`argv[5]`, default `''` = whatever the date gives), fed into the
   `documentElement.dataset` stub at `:119` as `precipitation`. Without this, use (a) is impossible:
   run the harness in December and you compare snow against snow; run it in July and you compare
   snow against rain and call it a regression.
2. **`stroke()` must be logged.** MEASURED `:71`: `stroke () {}`. Rain emits **zero** `drawImage`
   calls (§4.3), so today the harness would record a rain frame as *drawing nothing at all* — and
   report `identical: true` between a working rain renderer and a deleted one. The fix is to record
   the accumulated path on `stroke()` (`moveTo`/`lineTo` are already no-ops at `:72` and must
   accumulate instead) with the transform, and extend `invisible()` at `:159-174` to test segment
   extents. **This is a precondition for the rain slice being verifiable at all, not a nicety.**
3. **The `k:` classifier at `:89`** (`img.height === 4 ? 'streak' : 'glow'`) gains the hail pellet,
   per §4.4.

**On the plan's "clock-pinned screenshots per kind": a real browser driver now exists
(`scripts/qa/cdp.mjs`, landed mid-write — §10.2), but there is still no screenshot capability and a
*comparative* screenshot is the wrong instrument for an animated canvas.** The stub-canvas wiring
test at a daytime hour, asserting §4.3's draw-call table, is the automated substitute: strictly
cheaper, deterministic, and no committed baseline. A **non-comparative** screenshot per kind, for a
human to look at once, is worth one slice-tail if someone wants it — §10.2 sizes it.

---

## 8. Invariants — one clause on #6, and no new number

**Next free number is #23** (MEASURED: `docs/tdd/project-invariants.md` runs #1 … #22).

### 8.1 Extend invariant #6 with one clause and one proof

Invariant #6 today reads: *"Reduced motion is honored by the canvas animation. When
`prefers-reduced-motion: reduce` is set, star/snow counts and trail alpha shift to the reduced tier
…"*, and it is marked **(PROVEN)**.

Add:

> **Every precipitation kind has a reduced tier, and for a kind whose motion cue is its speed, the
> tier reduces speed, not only count.** No kind's reduced count is zero.
> *Pin:* iterate `PRECIPITATION_KINDS` — each kind has a count row and a speed row;
> `precipitationCountForPreference(k, true) < precipitationCountForPreference(k, false)` and
> `> 0` for every kind; `precipitationSpeedMultiplierForPreference(k, true) < 1` for `rain` and
> `hail`, and `=== 1` for `snow` (preserving the shipped value exactly).

**Why widen #6 rather than mint #23 — and why this does not contradict ADR-0015 §4.4**, which
refused to widen #6 for chat chrome. The reason given there was that chat chrome is a *different
subsystem*, and widening #6 to cover it would make #6 mean "the site honours reduced motion
everywhere", i.e. unfalsifiable. Rain and hail are not a different subsystem: they are **the canvas
animation #6 already names**, drawn by the same file, counted by the same prefs module #6 already
cites. Widening here keeps the invariant complete; refusing would leave one property split across
two numbers with neither covering the whole of it. §5.3 is the concrete hazard: without the clause,
a count-only rain tier is compliant with #6's letter and green.

#6's implemented-by list also gains `js/starfield-prefs.js`'s new rows and
`js/precipitation.js`'s `PRECIPITATION_KINDS`; its proven-by list gains the new prefs test and the
daytime wiring test.

### 8.2 No new invariant for the determinism, and here is why

The obvious candidate — *"the precipitation kind is a deterministic, side-effect-free function of
the local calendar day and the hemisphere"* — is **not promoted.**

- **The file's own bar excludes it.** `docs/tdd/project-invariants.md:70-75` reserves the list for
  durability, safety, secret and correctness defects, and on that ground explicitly **declined** to
  promote the voice-résumé net and the empty-reply derivation, because "a regression there degrades
  a single reply's copy". A wrong *precipitation kind* is strictly less consequential than a wrong
  reply: it is decoration. ADR-0015 §8 promoted #22 against that bar, but with an argument M3 cannot
  make — #22 is an accessibility regression that is invisible in a diff. M3's accessibility clause
  is already covered, by #6.
- **The property is already fenced more cheaply, in three places.** The *signature* fences it
  (`precipitationFor` takes no RNG and the module has zero imports); the *grep* fences the renderer
  (§3.3); and the *golden day pins* fence the hash (§2.5). An invariant is the right tool when a
  property can regress in many places; this one can regress in one, and that one has a test.
- **It would be the first invariant about something nobody is harmed by.** That dilutes the list,
  which is the thing that makes the other twenty-two worth reading.

**Hand §3.3's boundary rule to M5 instead.** "The renderer contains no calendar" is a *boundary*
assertion, and M5 (ADR-0018, `test/component-boundaries.test.mjs`) is the milestone whose whole job
is boundary assertions. M3 lands it as one source-scan assertion in its own wiring test; M5 adopts
it. No invariant number spent.

---

## 9. Consequences

**Enabling.** Three sides of M3 can be built in parallel against the contracts above: the leaf
(§2 — pure, no DOM, no canvas), the tiers (§5 — pure), and the renderer (§4 — consumes a kind
string it cannot derive). The decision table and the draw-call table are both assertable in
`node --test` with the stubs that already exist, which is what makes M3 *done*-able without a
browser, and without a committed pixel baseline (§10.2).

**Costs and risks.**

- `js/starfield.js` grows two more draw paths in a file that already has four (`drawSpace`,
  `drawSnow`, `drawStudio`, `drawTime`) plus `drawFireflies`. §4.1's homogeneous pool keeps the
  per-frame cost flat, but the file gets longer. Splitting it is not in M3's scope and should not be
  smuggled in — the M1 reverts are what happens when renderer changes get bundled.
- The RNG-order constraint (§4.2) is invisible in a diff review and will be discovered by the
  harness, not by reading. It must be in the slice's acceptance, not in a comment.
- The `height === 4` classifier (§4.4) is a shared convention across three files with no declaration
  anywhere. M3 makes it slightly worse (one more sprite) and adds the one assertion that stops it
  getting worse again.
- The 30-entry southern allowlist is data that goes stale slowly (zone renames, new zones). Failure
  mode: one country's visitors see the wrong season. Acceptable, and fixed by a data edit.
- Equatorial visitors still see winter (§2.4, named residual).

**Migration notes.**

1. **Nothing to migrate.** No stored preference, no wire field, no HTML, no CSS. The `gvp-theme`
   localStorage format (`js/theme-time.js:117-138`) is unchanged — the slider pins an *hour*, and
   nothing pins a date or a season.
2. **No coordinated deploy.** Static site; `theme.js` and `starfield.js` ship together.
3. **The attribute is additive.** A root `data-precipitation` that nobody reads is inert; an older
   `starfield.js` ignores it.
4. **Rollback is one line:** `applyThemeTime` writes `'snow'` unconditionally, and the renderer
   behaves exactly as it does today. Worth keeping that true — it is why the kind is a string on an
   attribute rather than a structural change to the draw path.
5. **Not added to `siteState`, not added to the wire, not added to analytics** (§2.4).

---

## 10. Verification of the plan's M3 text

The orchestrator asked whether the M3 description is current, given that plan §0's M1 baseline turned
out to be stale. **It is not current. Six claims are wrong or under-specified, and §0's starfield
baseline is wrong in a way that matters to M3's gate.**

### 10.1 Plan §0 — the dust-GC does not exist. **REFUTED.**

Plan §0 says `agent`'s net FE delta is the "starfield dust-GC only (`collectDustBand` + 2 test
files)", and plan §0's decision 1 says "keep `agent`'s dust-GC … 0.22 and prod's exact render stay".
MEASURED: `grep -rn 'collectDustBand|getImageData|DUST_SWEEP' js/ test/ scripts/` returns **nothing
in `js/`, nothing in `test/`** — the only hits are this plan's own prose and one comment in
`test/starfield-star-budget.test.mjs:26`. What shipped instead is a **full `clearRect` every frame on
both branches** (`js/starfield.js:592, 621`) with the whole comet tail redrawn per frame from a baked
sprite (`:25-27, :355-382`), and `test/starfield-perf.test.mjs:122-136` now *pins* `fillRect === 0`
and no `destination-out` on a night frame. The 0.22 erase and the GC are both gone.

**Why this matters to M3 and not just to tidiness:** the "look untouched" constraint M3 inherits is
*the post-M1 look*, and the referee is the **draw-stream** harness, not a `getImageData` pixel diff
(plan M1 slice 0 specified pixels; `scripts/qa/starfield-ab-draws.mjs:18-23` explains why it is
draws). A slice written against plan §0 would go looking for a readback to narrow and a 0.22 alpha to
preserve, and find neither.

### 10.2 "clock-pinned screenshots per kind" — **HALF REFUTED, and the half that survives changed
under this ADR while it was being written.**

**Refuted when this ADR started; true by the time it finished.** MEASURED at session start
(`fd0eff6`): `scripts/qa/` contained exactly one file, and `CLAUDE.md` still said *"No browser E2E
suite; verify UI manually"*. MEASURED three commits later, mid-write: `d16393d` and `5ff6c39` landed
**`scripts/qa/cdp.mjs`** — a Chrome DevTools Protocol client in ~150 lines over Node 22's global
`WebSocket` — plus `scripts/qa/chat-stage-journeys.mjs` and an `npm run test:journeys` script.
`package.json` still declares **zero dependencies and zero devDependencies**, MEASURED. So **a real
browser driver now exists in this repo**, and ADR-0015 §11.6's deferral has been discharged.
(It landed as `.mjs`, not the plan's `scripts/qa/chat-stage-journeys.py`.)

**Still refuted:** there is no screenshot capability — MEASURED, `grep -n captureScreenshot
scripts/qa/` returns nothing; `cdp.mjs` exports `launch/evaluate/goto/clickAt/pressKey` and uses
`Emulation.setDeviceMetricsOverride`, nothing more. And the reason a *comparative* screenshot is the
wrong instrument here survives the browser landing, so it is now the whole of the objection:

- A screenshot comparison needs **committed baseline PNGs** (three kinds × a few hours), a **pixel
  tolerance**, and determinism the canvas does not have — real `Date.now`, real `Math.random`,
  GPU-dependent antialiasing. Every one of those is a flake source or a maintenance liability, and
  the repo's one existing render tool rejected pixels for exactly this reason
  (`scripts/qa/starfield-ab-draws.mjs:18-23`: comparing the visible draw stream is *"a STRONGER
  statement than sampling pixels, not a weaker one"*).
- `Page.captureScreenshot` is one CDP method away, though, so the **cheap half is now worth taking**:
  a **non-comparative** screenshot per kind at a pinned hour, written to a scratch directory for a
  human to look at once — no baseline, no tolerance, no assertion, no flake. That is what "clock-pinned
  screenshots per kind" should become.

So §7 stands as the automated story (kind-pinned stub-canvas wiring tests asserting §4.3's draw-call
table, plus the draw-stream harness as the snow no-regression gate), and the screenshot becomes a
review artifact rather than a gate. **Note for whoever cuts the slices: `scripts/qa/` is now under
active development by another track; re-read it before extending it (§7).**

### 10.3 "`starfield.js` draws rain as batched streaks" — **UNDER-SPECIFIED, and invisible to the
only tool that could check it.**

"Batched" has at least three meanings (one path/one stroke; sprite batching; z-ordered batching), and
plan M1 explicitly listed batching as *deliberately not applied* because it changes blend order —
so the word arrives already carrying a rejection. §4.3 defines it: one path, one `stroke()`, solid
colour. And MEASURED `scripts/qa/starfield-ab-draws.mjs:71`: `stroke()` is a no-op that logs nothing,
so **a correctly-batched rain renderer and a rain renderer that draws nothing are indistinguishable
to the harness today.** §7.2 is the required fix.

### 10.4 "hemisphere-aware" — **UNDER-SPECIFIED to the point of being undecidable.** §2.4 resolves
it: `Intl` zone → 30-entry southern allowlist → `'north'` default, resolved in the DOM layer and
injected into the leaf, with no `'unknown'` value and the guess reported back in the descriptor.

### 10.5 "Tiers in `starfield-prefs.js` (`precipitationCountForPreference`)" — **INCOMPLETE in a way
that would ship a reduced-motion defect.** The plan names a *count* function only, and MEASURED
(`js/starfield-prefs.js:101-105`) the shipped reduced tier does not reduce **speed** at all. §5.3
and §8.1 close it. Also MEASURED: no test in the repo boots the starfield at a daytime hour
(`'22'` everywhere — `test/starfield-cull-wiring.test.mjs:71`, and the defaults at
`test/starfield-perf.test.mjs:57`, `test/starfield-depth-wiring.test.mjs:62`), so the zero-gradients
and clearing assertions never see the branch M3 rewrites. A daytime variant of
`test/starfield-perf.test.mjs`'s zero-gradients test is a one-line parameterisation and belongs in
M3.

### 10.6 `js/precipitation.js` versus M5's `js/lib/rain/` — **the plan contradicts itself**, and
MEASURED, neither M1 nor M2 honoured the address-first decision (`js/starfield-geom.js`,
`js/site-state.js`, `js/chat-stage.js` are all flat). §2.1 keeps flat and refutes the `js/lib/rain/`
address so M5 does not fence a directory nothing uses.

### 10.7 "~4 slices" — **under-counted; six, and one of them is a precondition.** §12.

### 10.8 "beside the existing snow" — **two corrections.**

- MEASURED: the legacy garden path `drawSnow()` (`js/starfield.js:555-558`) is reachable only when
  `data-time` is **absent** (`isTimeMode()`, `:104-106`), and both writers of that attribute set it
  unconditionally — `js/theme.js:62` on every `applyThemeTime`, and `index.html:36` in the boot
  script. DERIVED: **`drawSnow()` is dead in the shipped app.** M3 must leave it alone (changing a
  dead path risks the look for zero benefit) and should say so in a comment rather than silently
  extending it. Filed in §11.4.
- Precipitation therefore lands in **`drawTime`'s daytime branch only**, which is also where the
  plan's own description points. Correct, as far as it goes — see §11.2 for what the branch's hour
  window actually is.

### 10.9 "strictly after M1" — **CONFIRMED and already satisfied.** M1 has landed (`js/starfield-geom.js`,
`Star.prototype`, the single `setTransform` at `js/starfield.js:372-375`, and the harness). M3's
dependency is discharged.

### 10.10 "Today the daytime theme only has snow, but snow is a winter thing" — **CONFIRMED.**
MEASURED `js/starfield.js:605-611`, and the noon draw-stream census in §0 (183 draws/frame, all
snow, no stars).

---

## 11. Collateral drift found while verifying — filed for the loop, not fixed here

### 11.1 The `index.html` boot script disagrees with `chromeThemeAt` for about 70 minutes a day

MEASURED: `index.html:34` decides day/night as `h >= 7 && h < 19`. `chromeThemeAt` decides it as
`sun >= star` (`js/theme-time.js:112-115`). DERIVED from the keyframes (`:17-21`): the real crossover
is **h ≈ 7.5** in the morning (star and sun both 0.2625) and **h ≈ 18.33** in the evening (both
≈ 0.265). So between 07:00–07:30 and between 18:20–19:00 the boot script pre-paints the **garden**
sky and `theme.js` immediately repaints it to **space** — a flash of the wrong sky, which is the one
thing the boot script exists to prevent (`index.html:26-27`). Pre-existing, unrelated to M3, and
`index.html` is outside `SRC_GLOB_app`. One slice, whenever.

### 11.2 `js/starfield.js:605`'s `sp.sun > 0.01` guard is dead code

DERIVED: the guard sits inside the `dayScene` branch, which is entered only when `sp.sun >= sp.star`,
and at the earliest such hour both are 0.2625. The guard can never be false where it is written.
Harmless, but it is the line the plan's own description quotes as the precipitation gate, so it
reads as meaningful and is not. M3 should either delete it or replace it with the real window in a
comment: **precipitation is drawn for local hours ≈ 7.5 → 18.33 only.**

### 11.3 Precipitation pops out of existence at the day/night crossover

DERIVED: at h ≈ 18.33 the branch flips from day to night, and the night branch draws no
precipitation. The last daytime frame draws the pool at `globalAlpha = Math.min(1, sp.sun)` ≈ 0.265;
the next frame draws none. Snow at alpha 0.265 vanishing in one frame is already a visible pop, and
rain — brighter, faster, higher contrast — will make it more noticeable. **M3 should not fix this.**
The fix (also drawing precipitation in the night branch, fading on `sp.sun` to ≈ 0 by h ≈ 20.8) is
three lines, but it **adds precipitation to a 2.5-hour window that has none today**, i.e. it changes
the night look — and this branch has reverted twice for exactly that. Filed as a product decision,
not an implementation detail.

### 11.4 `drawSnow()` is dead (§10.8) and the `themechange` handler's comments are now wrong

MEASURED `js/starfield.js:680-684`: *"Time mode fires themechange as the chrome flips garden/space at
dawn/dusk. Keep the pools … snow is always on"*. After M3, "snow is always on" is false and the pool
is kind-dependent. Also `:131` (`// Snow state (garden theme)`) and `:486-487` (*"soft snow during
daylight"*). All three are comments M3's rename will walk past; they should be corrected in the same
slice, because a stale comment beside a renamed variable is worse than no comment.

---

## 12. Recommended changes to M3's slice list

The plan says ~4 slices. Six, and the order is load-bearing because slice 1 is a precondition for
slices 4–5 being verifiable at all.

1. **Extend `scripts/qa/starfield-ab-draws.mjs`: the kind argument, the logged `stroke()`, the
   classifier (§7). DONE 2026-10-23 in `981ee12` — see §7's status note; do not re-cut it.**
   First, not last. Without the kind argument, the snow no-regression gate
   compares whatever today's date gives; without logged strokes, a rain renderer that draws nothing
   reports `identical: true`. Not a `node --test` file, so it carries no suite cost.
2. **`js/precipitation.js` + `test/precipitation.test.mjs` (§2).** Pure leaf. The test carries the
   season table, the 6-month southern rotation identity, the hemisphere allowlist plus the `'north'`
   default, the hail rate over 3 650 days, the **anti-lattice** gap assertion, the five golden day
   pins, and the totality cases (`null`, `'nope'`, `new Date('x')` → `FALLBACK_KIND`, never a throw).
3. **The tiers in `js/starfield-prefs.js` (§5).** Pure. Includes the **completeness** test that
   iterates `PRECIPITATION_KINDS`, the relational assertions, and the proof that
   `precipitationCountForPreference('snow', rm)` is identical to `snowflakeCountForPreference(rm)`
   for both values of `rm`.
4. **`js/theme.js` writes `data-precipitation` (§3.2) + a wiring test.** The test boots the
   starfield at **hour 12** — the first test in this repo to do so — and asserts the renderer honours
   the attribute, plus the source-scan fence from §3.3 (no `new Date(`, no `getMonth`, no `Intl` in
   `js/starfield.js`). This is the slice that stops M3 being a defined-but-never-called leaf, which
   is the failure this repo has already shipped once (`test/starfield-depth-wiring.test.mjs:5-16`).
5. **Rain in `js/starfield.js`** — the pool rename, `initPrecipitation(kind)` honouring §4.2's RNG
   order, the batched stroke pass, and §4.3's draw-call table asserted with the counting stub.
   **Acceptance includes `node scripts/qa/starfield-ab-draws.mjs <pre-M3> 12 400` with the kind
   forced to `snow` reporting `identical: true`.**
6. **Hail** — pellets plus derived tails, the non-4-pixel sprite height and the
   no-two-sprites-share-a-height assertion (§4.4), and the same snow identity re-run.

Plus, cheaply, inside slice 5 or 6: the **daytime** variant of
`test/starfield-perf.test.mjs`'s zero-gradients assertion (§10.5), and the stale comments in §11.4.

**Not in M3:** the day/night crossover pop (§11.3 — product decision), the boot-script flash (§11.1),
a tropical hemisphere (§2.4), seasonal CSS or a seasonal `siteState` field (§2.4 — additive later,
no ADR needed), and splitting `js/starfield.js` (§9).
