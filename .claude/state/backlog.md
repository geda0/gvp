# Backlog

_Owned by the product-owner. Prioritized top-down; the top ready item is built next.
Each item: a short title, its value, the layer tag, and acceptance criteria (observable
behaviors — never "implement X"). Move accepted items down to "Shipped"._

---

## MILESTONE — Work-showcase reframe + agent guide (ACTIVE)

> **Owner direction (firm, 2026-06-17).** The site should feel like a **portfolio, not a résumé**,
> and the chat agent should **guide visitors around the site**. Three direction calls:
> 1. **Merge into one "Work" showcase** — drop the Portfolio/Labs split entirely; one projects-first
>    "Work" section showcasing everything; résumé demoted.
> 2. **Render the résumé inline as a section** — an on-page experience/résumé section; the agent
>    scrolls there instead of opening a new tab; the PDF becomes a quiet download, not the main path.
> 3. **Guided-tour agent** — the text agent gets navigation parity with voice AND a "show me around"
>    tour that scrolls through sections with narration; navigates to specific work on request; NEVER
>    just dumps the résumé PDF.
>
> **The IA inversion this fixes (diagnosis, confirmed by code + screenshots).** The data model is
> mislabeled against the owner's intent: `data/projects.json` has TWO arrays — `playground` (the
> REAL project showcases: Team Tactics, AI assistant & chatbot, Monday Rover, GVP) and `portfolio`
> (the EXPERIENCE/résumé entries: Apptio, JumpCloud, HP, AT&T + hidden MIU/Sunrise/CampusParty/5d/
> early). The nav (`index.html` lines 60–61, `js/navigation.js`) surfaces "Portfolio" (résumé blurb +
> a focal **Resume (PDF)** link, ZERO projects in `#portfolioProjects`) and downplays "Labs" (where
> the good visual project cards live). The hero (`index.html` 98–183) leads with résumé credentials
> ("Senior Software Engineer · 15+ years" eyebrow + skills subtitle + a mic), not work. The text
> agent (`docker/chat/app/providers.py` `chat_tools()`) has only `open_resume` + `open_contact_form`;
> the voice path (`docker/chat/app/live_gemini.py`) additionally has `navigate_to_section`. Richer,
> portfolio-grade copy already exists in `data/chat-knowledge/projects.json` ("what it demonstrates" /
> "why it matters") and in the experience entries' `problem`/`work`/`outcome` triads.
>
> **Copy/brand direction** (the new "Work" intro, project-piece template, experience framing, hero
> reframe, agent posture) lives in `design-notes.md` — read it before building any copy slice. The
> navigator/owner must make the sub-decisions flagged there (older_projects fate, hero treatment
> specifics, agent default-greeting) before the slices that depend on them.
>
> **Layer tags:** `[app node:test]` (js/, aws/src/ pure cores), `[chat pytest]` (docker/chat),
> `[frontend-manual]` (browser-verified UX — qa-verifier signs the UX bullet), `[CI]` (workflow/yml).
> Most of this milestone is `[frontend-manual]` (IA, copy, polish) with `[app node:test]` guards on the
> data/route contracts, and `[chat pytest]` for the agent tool surface.
>
> **Calibration.** This is a single-author personal portfolio. "Polish the cheap spots" means
> proportionate craft (rhythm, transitions, card treatment) — NOT a redesign. Prefer reusing existing
> visual cards (good) and existing rich copy (`chat-knowledge`) over inventing new surfaces.

### Track A — IA merge → one "Work" showcase

1. **Nav presents one "Work" entry, not Portfolio + Labs** — `[frontend-manual]` `[app node:test]` —
   _the split is the owner's #1 complaint; one entry is the structural commitment._
   - [ ] The top nav shows a single **Work** link (no separate "Portfolio" and "Labs" links).
   - [ ] Activating **Work** lands on a single section that is **projects-first** — the real project
         cards (Team Tactics, AI assistant & chatbot, Monday Rover, GVP) are the first thing in view.
   - [ ] Legacy `#portfolio`, `#labs`, and `#playground` hashes/bookmarks resolve into the new Work
         section (no dead route, no 404, no blank section).
   - [ ] A node:test pins the route/section contract (the section-name normalizer maps the legacy
         buckets to the new "work" target; no nav link resolves to an empty grid).
   - _Top of the milestone: every other Track-A/B item assumes this one section exists. Decision: the
     exact label is **"Work"** unless the owner overrides (design-notes)._

2. **The Work section showcases every project, projects-first** — `[frontend-manual]` `[app node:test]` —
   _"one section showcasing everything" — the project cards lead, nothing real is hidden under a former
   sub-bucket._
   - [ ] All currently-visible project showcases render as cards in the Work section in a deliberate
         order (featured first), with their existing card visuals/images intact.
   - [ ] No visible project card is filed under a "Labs / personal builds" sub-heading that downplays
         it; if builds are grouped, the grouping does not bury them below the résumé.
   - [ ] A node:test asserts every non-hidden entry in the project showcase array renders a card in the
         Work section (no showcase silently dropped by the merge).
   - _Decision (design-notes): whether to keep ONE flat grid or a light "Selected work" + "Builds &
     experiments" grouping within the single section — owner's call; default is one grid, featured-first._

### Track B — inline experience/résumé section + résumé demotion

3. **Experience renders inline as an on-page section (no new tab for the agent)** —
   `[frontend-manual]` `[app node:test]` — _owner #2: the experience/résumé is part of the page, so the
   agent can scroll to it instead of opening a PDF._
   - [ ] The experience entries (Apptio, JumpCloud, HP, AT&T) render as an on-page **Experience**
         section within (or directly below) the Work showcase — visible without leaving the site.
   - [ ] Each experience entry reads as a portfolio piece, not a one-line résumé blurb (problem →
         approach → outcome is legible from the entry; see Track D / design-notes template).
   - [ ] The Experience section has a stable in-page anchor the agent can scroll to (item 7 depends on
         this), and a node:test pins the anchor/contract.
   - _Decision (design-notes): is Experience a distinct titled section below the projects, or a clearly
     labeled band within Work? Default: a distinct **Experience** section below the project cards._

4. **Résumé PDF is a quiet download, not the focal path** — `[frontend-manual]` —
   _owner #2/#3: the PDF stops being the main CTA; it's there for those who want it._
   - [ ] The Resume (PDF) link is present but visually demoted — it is not the focal/most-prominent
         element of the experience area (no longer a standalone hero-weight link with nothing else
         around it).
   - [ ] The inline Experience section (item 3), not the PDF, is the primary way to read the work
         history on the page.
   - [ ] qa-verifier confirms in a browser that the PDF is reachable (download works) but is clearly
         secondary to the on-page experience.
   - _No external-rights or pricing decision here; purely visual demotion. Calibrated: keep it, just
     stop leading with it._

### Track C — guided-tour agent + navigation parity + stop defaulting to résumé

5. **Text agent has navigation parity with voice** — `[chat pytest]` `[frontend-manual]` —
   _owner #3: the text agent can move the visitor around the site like voice already can._
   - [ ] The text-chat tool surface includes a navigation tool (parity with voice's
         `navigate_to_section`), targeting the new Work / Experience / Home destinations.
   - [ ] When the visitor asks to "go to / show me your work / experience / projects," the text agent
         navigates the page to that section (the page actually moves), not just describes it in text.
   - [ ] A chat pytest pins that the text tool surface now declares the navigation tool (closes the
         `providers.chat_tools()` gap vs `live_gemini` having `navigate_to_section`).
   - [ ] qa-verifier confirms in a browser that a text request to navigate actually scrolls/switches
         the page.
   - _Decision (design-notes): the navigation enum must be updated to the new section ids (work /
     experience / home), and the legacy `portfolio`/`playground` enum values kept as aliases so older
     model behavior still resolves. Owner to confirm the destination set._

6. **"Show me around" triggers a guided tour that scrolls with narration** — `[chat pytest]`
   `[frontend-manual]` — _owner #3: the headline new behavior — a narrated tour._
   - [ ] When the visitor asks for a tour ("show me around," "give me a tour," "walk me through the
         site"), the agent runs a guided tour: it moves the page through the sections in order and
         narrates each stop (a line or two per section), rather than dumping one wall of text.
   - [ ] The tour ends in a clear, non-dead-end state (e.g. back at the work/contact area with an
         offer to go deeper or get in touch).
   - [ ] The tour works from the text agent (parity is the point); if voice also supports it, that's a
         bonus, not required for this item.
   - [ ] A test pins the tour contract (the agent emits an ordered sequence of navigate-and-narrate
         steps for a tour request), and qa-verifier confirms the scroll-through-with-narration UX in a
         browser.
   - _Decision (design-notes): tour step ORDER and the per-stop narration lines are copy the owner
     should bless (the agent's voice). Default order: Work (projects) → a standout project →
     Experience → Contact. Escalation: is the tour auto-paced (timed scroll) or step-on-confirm
     ("ready for the next one?"). Default: step-on-confirm (less jarring, accessible)._

7. **Agent leads with the work and never defaults to dumping the résumé PDF** — `[chat pytest]`
   `[frontend-manual]` — _owner #3: the agent is a guide who shows the work; the PDF is mentioned only
   when explicitly asked._
   - [ ] When asked an open question about Marwan's background/experience (not specifically "the
         resume PDF"), the agent answers with the work and offers to scroll to the on-page Experience
         section or a relevant project — it does NOT open/recommend the PDF as the default.
   - [ ] `open_resume` (the PDF) only fires when the visitor explicitly asks for the resume/CV file or
         a download — not for general "tell me about your experience" asks.
   - [ ] When asked about a specific piece of work, the agent navigates to that specific project/
         experience entry (item 5's navigation), leading with what it demonstrates.
   - [ ] qa-verifier confirms in a browser: "tell me about your experience" scrolls to / surfaces the
         on-page Experience, not a new PDF tab; "open your resume PDF" still works.
   - _This is the agent-posture change. The system-instruction copy (the guide posture) is in
     design-notes; the owner should bless the agent's new voice. Decision: keep the PDF tool, just
     re-scope WHEN it fires (explicit-ask only)._

### Track D — project copy reframe (portfolio pieces, not résumé bullets)

8. **Project showcase cards/dialogs read as portfolio pieces (problem → approach → outcome/impact)** —
   `[frontend-manual]` `[app node:test]` — _owner intent: make it feel like a portfolio. The project
   cards' `cardDescription` is terse/résumé-like; the richer "what it demonstrates / why it matters"
   copy already exists in `data/chat-knowledge/projects.json` and the dialog `description`._
   - [ ] Each visible project's on-card and in-dialog copy leads with the problem/intent and lands on
         the outcome/impact or "what it demonstrates" — not a tech-spec bullet list as the headline.
   - [ ] The richer existing copy (dialog `description`, chat-knowledge "what it demonstrates") is the
         source of truth — the card teaser is a portfolio hook, not a résumé line.
   - [ ] A node:test pins that each visible project still has the required copy fields after the
         reframe (no card ships with an empty/placeholder description).
   - _Calibrated to the template in design-notes. Decision: this is a COPY edit to existing fields, not
     a schema change; the dialog already renders rich HTML. Owner blesses the new card teasers if they
     want a specific voice._

9. **Experience entries read as portfolio pieces, not résumé blurbs** — `[frontend-manual]`
   `[app node:test]` — _owner #1/#2: the demoted experience should still read like work you'd showcase._
   - [ ] Each inline Experience entry (item 3) surfaces its problem → approach → outcome (the
         `problem`/`work`/`outcome` triad already in the data) rather than only the terse
         `cardDescription`.
   - [ ] A node:test pins the experience entries expose the problem/work/outcome content used by the
         inline section.
   - _Reuses existing `problem`/`work`/`outcome` fields (already authored well). Mostly a rendering +
     light copy pass, not new authoring._

### Track E — polish the "cheap" spots (calibrated to a personal portfolio)

10. **Hero leads with the work, not credentials** — `[frontend-manual]` — _owner intent + diagnosis:
    the hero opens with "Senior SWE · 15+ yrs" + a skills tagline + a mic, which reads as a résumé
    header. Lead with the work / an invitation into it._
    - [ ] The hero's lead element is about the work / an invitation to explore it (e.g. a line that
          frames "here's what I build" and routes into the Work showcase or the agent), not a résumé
          credential eyebrow as the first thing read.
    - [ ] The chat/agent entry stays available in the hero (it's a core feature), but the hero no
          longer reads primarily as a résumé header.
    - [ ] qa-verifier confirms the hero reads as "portfolio, lead-with-work" on desktop and mobile,
          theme-consistent across space/garden/studio, reduced-motion respected.
    - _Decision (design-notes): exact hero copy + whether the credential line moves down (e.g. into
      Experience) or is reworded. Default: rework the lead to an invitation; relocate the bare
      credential into the Experience section. Escalation: this is the most visible copy change — owner
      should bless the hero line._

11. **Section transitions and the merged section don't feel sparse/cheap** — `[frontend-manual]` —
    _diagnosis: sparse hero, abrupt transitions, thin card treatment were called out as the "cheap"
    spots; the merge is the moment to tighten them._
    - [ ] Moving between Home → Work → Experience reads as one coherent flow (the reveal/transition is
          smooth, not an abrupt blank-then-pop; reduced-motion still respected).
    - [ ] The merged Work section does not look empty/sparse at the top (the projects-first content
          fills the fold; no large dead whitespace where the résumé blurb used to be).
    - [ ] Card treatment is consistent across all project cards in the one grid (no visible
          first-class vs second-class styling split left over from the Portfolio/Labs divide).
    - [ ] qa-verifier confirms the polish across themes + breakpoints + reduced-motion.
    - _Calibrated: tighten existing transitions/spacing/card styles — NOT a redesign. Bundle the
      lowest-risk CSS-only refinements; escalate anything that needs a new visual direction._

### Acceptance gate for the milestone (what "done" means)
- [ ] Track A (1–2): one "Work" entry, projects-first, every showcase visible, legacy routes resolve.
- [ ] Track B (3–4): experience inline on-page, PDF demoted to a quiet download.
- [ ] Track C (5–7): text-agent navigation parity, "show me around" guided tour, agent leads with the
      work and never defaults to the résumé PDF.
- [ ] Track D (8–9): project + experience copy reads as portfolio pieces (problem → approach →
      outcome).
- [ ] Track E (10–11): hero leads with work; transitions/card treatment no longer read as cheap.
- [ ] Full `node --test` app suite GREEN; chat pytest GREEN (items 5–7 touch chat).
- [ ] `tdd-critic` = PASS on the milestone.
- [ ] qa-verifier has confirmed the UX bullets (nav/Work IA, hero reframe, agent tour + posture in a
      browser, experience-inline, PDF-demoted, transitions/cards across themes + breakpoints).
- [ ] The sub-decisions flagged in design-notes are resolved by the owner/navigator (or the documented
      defaults are explicitly accepted).

### Open sub-decisions (escalate to owner/navigator — do NOT silently choose)
- **older_projects fate** — `data/older_projects.json` (DDA, OIG OS, QREO) is terse one-liners,
  separate from the main showcase. Keep as a quiet "earlier work" footnote in Experience, fold into
  the existing "Earlier:" line, or drop? _Default: keep as the existing earlier-career footnote, not
  promoted into the Work grid._
- **Hidden experience entries** — MIU, Sunrise, Campus Party, 5d-agency, "early" are `hidden:true`
  today. Surface any in the new inline Experience, or keep the visible four (Apptio/JumpCloud/HP/AT&T)
  + the earlier-career line? _Default: keep the current visible set; do not un-hide without owner say._
- **Work label** — "Work" vs "Projects" vs "Selected work" for the single nav entry. _Default: "Work."_
- **Work internal grouping** — one flat featured-first grid vs a light "Selected work" + "Builds &
  experiments" split within the one section. _Default: one grid, featured-first (no résumé-style
  downplaying of any card)._
- **Tour pacing** — auto-paced timed scroll vs step-on-confirm ("ready for the next?"). _Default:
  step-on-confirm (accessible, less jarring)._
- **Hero lead copy** — the exact new hero line and where the bare credential moves. _Owner should
  bless; default in design-notes._

---

## Previous milestone — Pre-prod hardening → stage/prod (SHIPPED)

> All 31 slices done (S16 AWS Budget = owner runbook, S30 per-IP WAF = ADR-deferred). Shipped to
> staging (`agent` d242979) AND prod (`main` d45e18d), qa PASS both. Consent gate later REMOVED per
> owner (no consent needed; `js/consent.js` 404 both envs); HMAC ipHash (SEC-2) retained. Full
> per-finding detail in progress.md / releases.md / memory `prod-promotion-procedure`. Suite 115/0/1.
> OPEN owner items carried forward (not part of the new milestone): set `GVP_EXPECTED_ENV=prod` on the
> Amplify prod app; verify the positive `/api/chat/smoke` path with the prod `SMOKE_PROBE_KEY`;
> deferred S16 budget alarm + S30 WAF.

## In progress
- _see `design-notes.md` + `progress.md`_

### `starfield-perf` — PO verdict CONCERNS (2026-07-08). AC-1 + AC-3 accepted, AC-2 open.
Staging push approved as the review instrument. **Prod promotion blocked** until the navigator rules on
the night sky. Ordered follow-ups:

1. **[navigator, blocking prod] Eyeball the night sky on staging and rule on brightness.**
   Observable: owner views the staging night sky (hour ~22) side-by-side against prod and says either
   "this is the sky" or gives a direction (brighter / longer tails / tighter stars). Mean luminance is
   53% of old; the "it was all haze" rationale does not survive the coverage evidence (see
   design-notes). Retune knobs, one line each in `js/starfield.js`: `STAR_GLOW_SCALE` (2.2),
   `STREAK_ALPHA` (0.62), `STREAK_TAIL_FRAMES` (8). Do not tune before he looks — nobody has data.

2. **[defect, small] `STAR_GLOW_SCALE=2.2` is applied on render paths that never had accumulation.**
   Observable: with `prefers-reduced-motion: reduce`, night stars render at the same radius as the old
   build (not 2.2x). Old reduced-motion night erased at alpha 1 — a **full clear**, no streaks, no
   accumulation — so there was never any brightness debt to repay on that path. Same for the `drawTime`
   *daytime* branch (`sp.star > 0.01` at dawn/dusk), which already `clearRect`'d. All A/B evidence was
   captured with motion ON at hour 22, so both paths are unmeasured. Either scope the glow scale to the
   accumulating path or confirm the enlargement is wanted. Guard with a test.

3. **[nit] `streakLength()` clamps where the old code skipped.**
   Old: `if (dist < 150)` → no streak at all for a big projected jump. New: `min(dist*8, 150)` → draws a
   full 150px comet. Consequence: any star moving ≥18.75 px/frame now gets a *maximum-length* tail where
   it used to get a `dist`-length one (a 20px/frame star: 20px → 150px). Mostly at the viewport edge
   where near-camera stars race out, so likely benign — but `test/starfield-streak.test.mjs` enshrines
   the clamp as if it were the preserved invariant. Confirm intent; if the skip mattered, restore it.

4. **[code health, non-blocking] Dead `drawSpace()` still carries the old accumulating trail wash —
   and it makes an invariant test vacuous.** `initTheme()` → `applyThemeTime()` sets `data-time`
   unconditionally and nothing ever removes it, so `isTimeMode()` is always true and `draw()` only ever
   reaches `drawTime()`. `drawSpace()` / `drawSnow()` / `drawStudio()` are unreachable at runtime.
   `drawSpace()` still does a per-frame full-canvas `fillRect` wash and would now compound it with 2.2x
   glows + 8x tails. Not a live defect (the "fillRect 60/sec → 0" claim is true of the live path). But
   per tdd-critic #784, `spaceTrailAlphaForPreference` now has **no live consumer**, so invariant #6's
   "trail alpha" clause is **vacuous while `test/starfield-reduced-motion.test.mjs` stays green**. A
   green test that asserts nothing is a worse state than no test. Delete the dead path or re-point the
   invariant at the live one.

5. **[prod gate, from tdd-critic #784] Test-strength gaps that must close before prod, not staging.**
   Observable: each is a test that fails if the behavior regresses. (a) `starfield.js:239`
   reduced-motion ⇒ no streaks is the *live half of invariant #6* and is **untested** — boot with
   `matchMedia matches:true`, assert `ctx.translate` calls `=== 0` (and `> 0` when false). (b) the perf
   test's `clearRect()` stub **discards its args**, so "fully clears" is never actually asserted —
   record args, assert `[0,0,1200,800]` and `fillRect === 0` on the night frame. (c) no seam at
   `starfield.js:245-257`: a sign flip at `:251` leaves all four streak tests green — extract
   `streakAnchor(x,y,px,py)` and test that the head lands at `(x,y)`. Nit: `:193`'s `hsl`→`hsla` string
   surgery **fails silently** (canvas ignores an invalid `fillStyle`) — extract `streakColor()`.

## Shipped

_Adoption baseline (2026-06-03): invariant #6 (reduced motion) proven by
`test/starfield-reduced-motion.test.mjs`; app 10/10 · chat 70/70 green._

**Pre-prod hardening milestone (signed off 2026-06-17).** 23 unique confirmed pre-prod findings fixed
TDD-first across P0/P1/P2; HMAC ipHash, DailyReport/ContactFailureReport alarms, events body-cap +
amplification reduction, daily-report idempotency, session-id fallback, chat deep-probe cooldown +
split smoke key, avgFirstToken label consistency, contact terminal-event coverage, DR retain/PITR
policies, plus the test-quality tail. Amplify env-guard (`amplify.yml`). Deployed staging + prod,
qa PASS. (Consent gate built then removed per owner.) See progress.md / releases.md for full detail.

**Release: Team Tactics private-repo contact CTA (signed off 2026-06-06).** `[app]` UX — Labs card
`link` → `#contact`, CTA **Request access**, `contactPrefill` opens contact dialog.
`test/team-tactics-project.test.mjs`; app **42/42** green.

**Invariant-completion + characterization releases (2026-06-03 → 2026-06-04).** All ten
project-invariants proven via `node --test` (app) + pytest (chat): contact durability/honeypot/sender
(#3/#4/#5), chat turn-persistence (#7), bounded timeout (#8), model fallback (#9), Gemini Live
voice-timbre lock (#10), frontend bundle/host guards (#1/#2), reduced motion (#6). Canonical CI bar
(`node --test` on every push + chat pytest gate). Full per-release detail preserved in progress.md
cycle log and releases.md.

## Out of scope (not regressions; documented in project-invariants.md)
- **Infra-only halves of invariants** are asserted by review against the ADRs, not unit tests
  (SQS→DLQ→alarm topology, Secrets-Manager/SAM-param injection).
- **Best-effort persistence when unconfigured** (no `CHAT_TRANSCRIPTS_TABLE` → turns skip persistence).
- **Token-by-token wire streaming is ECS-only** (Lambda/Mangum buffers SSE).
- **Voice working end-to-end is a deployment-topology property** (API Gateway can't upgrade WebSockets).
- **Exact model ids, theme cosmetics, CORS allowlist contents** are configuration, not invariants.

---

# MILESTONE — 2026-08 sandbox port (M0–M8) · queued 2026-09-17

> **Source of truth:** [`docs/plan-2026-09-port.md`](../../docs/plan-2026-09-port.md) — read it before
> picking up any item here. These items are the *acceptance* view of that plan; the plan carries the
> root causes, the module lists and the evidence carried over from the source session.
>
> **Navigator decisions already resolved (2026-09-17) — do NOT relitigate.** (1) Starfield look is
> frozen to prod's current render; `agent`'s dust-GC stays, the sandbox's erase-alpha change is
> rejected, only its `trailFramesToClear8Bit` predicate lands as a regression test. (2) Scope is all
> of M0–M8. (3) **Address-first** — M2/M4/M6 write files directly at their final `js/lib`,
> `js/components/`, `app/models|voice|assistant/` and `aws/src/admin/` addresses; M5 shrinks to
> ADR-0018 + `docs/components.md` + two boundary tests. (4) Parked cosmetics stay as proposed — chat
> opens focused-then-yields, hail cadence 1-in-9. The reasoning behind each lives in `design-notes.md`.
>
> **Where this sits in the queue — navigator call.** The Work-showcase milestone above is still marked
> ACTIVE. **M0 is a live vulnerability on `main` today and should ship immediately regardless of that
> question** (one slice, one layer, no dependencies). For M1–M8 vs. the Work-showcase tracks, the
> navigator picks the order; this PO does not silently reprioritise a milestone the owner marked
> active. Note that M2/M4 (assistant stage + site awareness) and Work-showcase Track C (agent
> navigation parity + guided tour) **touch the same navigation tool surface** — building them in
> opposite orders means one of them reworks the other. Flagged, not decided.
>
> **Layer tags** (same vocabulary as the milestone above, two additions):
> `[app node:test]` · `[chat pytest]` · `[frontend-manual]` (qa-verifier signs it in a browser) ·
> `[infra]` (SAM/template/IAM — reviewed against the ADR, not unit-tested) ·
> `[journey]` (the new headless-Chromium harness under `scripts/qa/`, born in M2) ·
> `[human-staging GATED]` (**cannot be verified in this repo — a named human check on staging gates
> the item to prod. These NEVER pass silently and NEVER get ticked by a green suite.**)
>
> **Baseline at queue time, on `agent`, measured:** app `node --test` **203 tests / 202 pass / 0 fail /
> 1 skip** (the plan's "203/202" is that skip, not a failure — the bar is green). Chat pytest **114
> pass**. The plan's projected suite sizes (app ~310, pytest ~158) are **sandbox counts, not targets** —
> nobody should pad tests to hit them.

## Dependency graph (stated by the plan; binding)

```
M0 ──────────────────────────────────────────────  independent, ships alone
M1 ──────────────────────────────────────────────  independent  (but see file contention with M3)
M2 ──┬── M4 ───────────────────────────────────── M4 depends on M2
     └── (M5 fences M2/M4/M6's addresses)
M3 ──────────────────────────────────────────────  independent of M2 · PARALLELISABLE
M5 ──────────────────────────────────────────────  docs + boundary tests (decision 3)
M6 ──┬── M7 ───────────────────────────────────── M7 depends on M6 (for `chat_cold_wait`)
     └──────────────────────────────────────────  independent of M2–M5 · PARALLELISABLE
M8 ──────────────────────────────────────────────  independent, except H7 reads M4 + M6 data
```

**Parallel pairs the plan blesses:** (M2 ‖ M3), (M2 ‖ M6), (M3 ‖ M6).
**Contention the plan does NOT state (PO flag):** M1 and M3 both rewrite `js/starfield.js` +
`js/starfield-prefs.js`. They are *not* safely parallel with each other — sequence M1 → M3, or section
them with one named owner for the starfield files.

## Human-gated acceptance (the three the plan says cannot be verified here)

These stay **open** until a named human runs them on staging. A green suite does not tick them.

| # | Check | Gates |
|---|---|---|
| G1 | A **real Gemini Live voice pass** — greeting uninterrupted by the deferred mic prompt, voice chips work, navigation works while the assistant is speaking | M2 and M4 → prod |
| G2 | **ECS Express accepts `MinTaskCount=0`** (desired-count 0 accepted) **and `RegisterScalableTarget`** on its scalable target is permitted | M6 → prod |
| G3 | The **SSM `Secrets` reference on an Express service** resolves, plus real cold-start UX timing | M8.1 → prod |

---

### M0. **A stranger cannot bloat my database through the public transcript endpoint** — `[chat pytest]` — ~1 slice
_Live vulnerability, present on `main` today: `POST /api/live/transcript` is public and
`docker/chat/app/main.py:1215` does `tool_calls = payload.toolCalls or []` — arbitrary unbounded JSON
straight into DynamoDB. `transport` is a free string (`max_length=32`, no value clamp). Confirmed
against the code this cycle. **Ships alone; blocks nothing and is blocked by nothing.**_

- [ ] A request carrying 500 `toolCalls` entries persists an item with **at most 10** entries — the
      turn is still recorded, the excess is dropped (a hostile payload does not cost us the real turn).
- [ ] A tool-call name of 5,000 characters persists at **≤ 60 characters**; an entry whose serialised
      JSON exceeds **2,000 characters** is clamped so the stored entry is within that bound.
- [ ] Unknown keys inside a tool-call entry **do not reach the stored item** — only the known key set
      persists, so the admin tool histogram can never grow an unbounded key space from the public wire.
- [ ] A `transport` value outside the known set is **clamped to a known value**; no attacker-chosen
      string reaches the item or the admin rollup's group-by.
- [ ] **Existing voice telemetry is unaffected, observably:** a representative payload captured from
      the current frontend persists with the *same fields and same status code* before and after the
      change (a before/after assertion, not an assurance).
- [ ] The full chat pytest suite stays green (114 pass baseline).

---

### M1. **The night sky looks exactly as it does today, and costs the visitor's laptop about half as much** — `[app node:test]` `[frontend-manual]` — ~6 slices
_Decision 1 settled the conflict: `agent`'s dust-GC is the shipped trail fix, prod's render is frozen.
M1 is therefore **perf-only on top of the GC**, plus the sandbox's stall predicate as a regression
guard. The two reverts in `agent`'s history (`2d079aa`, `bf853d7`) exist because a change altered the
render — pixel-identity is the bar those reverts were protecting._

- [ ] **Pixel-identical, proven in this repo.** With `Math.random` pinned deterministically, N frames
      rendered at hours **2 / 7 / 12 / 19 / 23** and under `prefers-reduced-motion` produce **0
      differing pixels** against the pre-change build. Any non-zero diff fails the item.
- [ ] **The 8-bit stall can never silently return.** A pure predicate pins that an erase alpha of
      `0.22` never drains (`trailFramesToClear8Bit(0.22, start) === Infinity`) and that the GC's floor
      is what collects the residue. The test goes RED if someone re-introduces a fade that only
      "clears" on paper.
- [ ] **Off-canvas stars are not drawn.** A star whose glow-disc + streak-segment bounding box (padded
      1 px for AA/round caps) lies entirely outside the canvas produces **zero** draw calls — asserted
      by counting calls on a frame seeded with known off-canvas stars. (Sandbox measured ~36 % of stars
      at 1080p; the canvas clipped every one of those pixels anyway, so this is exact, not approximate.)
- [ ] **Zero per-star, per-frame allocations** during a pumped night frame: no `createRadialGradient`
      and no `String.replace` for streak colours, counted in the test. (Gradients become one cached
      unit radial per palette colour, placed with `setTransform`; streak colour strings are precomputed
      in the palette.)
- [ ] **Median JS frame time drops by at least 35 %** at night on a recorded reference profile, with
      **day unchanged within noise** — recorded as a measurement in the cycle log, not asserted as a
      unit test. (Sandbox A/B medians: night 1080p/4-core 3.15 → 1.59 ms (−49 %), 1440p/8-core 9.42 →
      4.15 (−56 %), dusk 3.19 → 1.85 (−42 %), reduced-motion 1.14 → 0.32 (−72 %).)
- [ ] `[frontend-manual]` qa-verifier confirms in a browser at hours 2 / 12 / 19 / 23, both themes,
      reduced-motion on **and** off: the sky is **visually unchanged from prod**, and the grey veil does
      **not** accumulate over 60 seconds of watching.
- [ ] **The dust-GC readback decision is recorded either way:** with the star pass ~50 % cheaper,
      `DUST_SWEEP_ROWS` either shrinks *with a measurement* or a one-line note says why it stays.
- [ ] **Deliberately not built, and documented as such** (each breaks pixel-identity or blend order):
      cached unit *linear* gradient for streaks (±1–2/255 on fringe pixels), batching streaks-then-discs,
      sprite stars, dirty-rect clears, `desynchronized`.

---

### M2. **When I ask the assistant to take me somewhere, it takes me there, keeps talking, and the site stays usable with the conversation still on screen** — `[app node:test]` `[chat pytest]` `[frontend-manual]` `[journey]` · ADR-0015 — ~16 slices
_The big one. Today the chat is a modal that blocks the site and the assistant's own tools close it:
`app.js` calls `collapseChatDialog()` on every navigation, `contact.js`/`projects.js` fire a collapse
event, and `closePanel → snapClose → stopVoice` — so `navigate_to_section` tore down the window **and
the live voice session** that had just promised the action._

- [ ] **The assistant survives its own action.** Asking it to go to a section moves the page there AND
      the conversation is still on screen afterwards; a live voice session is **not** stopped by that
      navigation — a test asserts site events never reach `stopVoice`.
- [ ] **The site stays operable behind the conversation.** After a navigation or a project opening, the
      chat is a docked card bottom-right at ≥ 768 px (a minimized pill below that) with **no backdrop,
      no scroll lock, `aria-modal=false`** — the visitor can scroll and click the site behind it.
- [ ] Opening the contact form leaves the assistant **reachable as a pill**, not closed.
- [ ] **Escape while docked minimizes** — it does not destroy the conversation.
- [ ] **"Confirmed but never executed" is gone.** A request naming `"Portfolio"` (cased differently),
      the legacy `playground`, or a near-miss section name resolves to the right destination — the model
      never says "taking you there" while nothing happens. Both the text path and the Live path.
- [ ] **The assistant knows where you are.** A turn started from the playground section carries the
      current section/project into the model input as one "Current site state" line, and the **tool
      result reports the resulting site state back** so the model can self-verify what it just did.
- [ ] **Exactly one context note per change during a live session.** A visitor-driven navigation mid-call
      pushes a single `clientContent` note (`turnComplete:false`, deduped). The double-notify is a known
      caught defect — pin it, don't rediscover it.
- [ ] **Keyboard and assistive tech are not broken by going non-modal.** With the chat docked, Tab
      order reaches both the site controls and the conversation, and nothing tells a screen reader the
      page is inert. _(PO-added: going `aria-modal=false` is the point of this milestone, but it also
      releases the focus trap — that's a behaviour change a reasonable owner wants checked.)_
- [ ] **The journey harness exists and runs here.** `scripts/qa/chat-stage-journeys.py` (headless
      Chromium) covers dock/minimize/pill, contact/project, "site events never call `stopVoice`",
      request-body assertions and live context notes — and it is the **standing instrument** for every
      later milestone's UX claims. `scripts/qa/` does not exist in this repo today; this is new
      infrastructure, budget it as such.
- [ ] `[human-staging GATED]` **G1 — a real Gemini Live voice pass on staging:** the greeting is not
      cut by the mic prompt, navigation works while the assistant is speaking, the session survives it.
      **Gates M2 to prod. This bullet does not get ticked by a green suite.**

_Files land at their **final** M5 addresses (decision 3): `js/site-state.js` + `js/chat-dock.js` per the
plan's shell/component split, chat-side under `app/assistant/` and `app/voice/`._

---

### M3. **In July the daytime weather is rain, not snow — the sky matches the season I'm actually in** — `[app node:test]` `[frontend-manual]` · ADR-0016 — ~4 slices
_Independent of M2 and parallelisable with it. Today the daytime theme only has snow, but snow is a
winter thing. **Hail cadence is settled at 1-in-9 (decision 4) — do not retune it mid-build.**_

- [ ] A **winter** date gives snow; a **summer** date gives rain; a **spring/autumn** date gives rain or
      hail — all with the clock pinned, so the check is deterministic.
- [ ] Hail falls on a **deterministic 1-in-9 of shoulder-season days**: the same date always produces
      the same answer, and it does **not** reroll on reload, on resize, or on a theme change.
- [ ] A **southern-hemisphere** visitor gets the opposite season — a July date reads as winter.
- [ ] Rain renders as **batched streaks** and hail as **pellets + tails**; each kind has a clock-pinned
      screenshot, and the **existing snow path is unchanged** for winter dates (no regression on the
      one thing that already worked).
- [ ] **Every new kind honours the motion tiers.** A reduced-motion visitor does not get a dense fast
      downpour — a count-per-preference tier exists for rain and hail exactly as it does for snow.
- [ ] `[frontend-manual]` qa-verifier confirms each precipitation kind in a browser across both themes,
      both breakpoints, reduced-motion on and off.
- [ ] **Contention note (binding):** this item edits `js/starfield.js` and `js/starfield-prefs.js` —
      the same two files as M1. Do not run M1 and M3 concurrently without sectioning those files to one
      owner.

---

### M4. **With a project open, the assistant is still reachable, still knows which project I'm looking at, and can open and close projects for me — by voice or text** — `[app node:test]` `[chat pytest]` `[frontend-manual]` `[journey]` · ADR-0017 — ~11 slices
_**Depends on M2.** Five distinct symptoms with five distinct causes; the plan tabulates them._

- [ ] **Reachable behind a project dialog.** With a project detail open, the assistant is visible and
      clickable (today the dialog at `z 1100` covers the chat at `1095`). At ≥ 1100 px the dialog
      shifts left beside the docked card; below that the assistant is a pill. The site stays operable.
- [ ] `[frontend-manual]` **On a phone, the pill does not cover the project dialog's close button or
      the contact form's submit button.** _(PO-added: the plan specifies the pill for < 768 px but never
      says it must not occlude the control the visitor needs to escape. A reasonable owner wants this.)_
- [ ] **Grounded in the project you're actually looking at.** Asking about "this project" gets an answer
      about THAT project — the project id travels on the wire and the backend attaches its
      knowledge-pack summary. A generic answer fails the bullet.
- [ ] **Open and close projects on request, on both modalities.** "Open the Monday Rover project", a
      fuzzy or partial title, and "close that" all work from **text and voice** (prompt 1.7.0).
- [ ] **The greeting is not cut off by the mic prompt.** On a cold session where the assistant speaks
      first, the mic permission prompt appears **after the first turn completes** (15 s fallback); a
      warm session prompts immediately.
- [ ] **No dead top-bar input.** With a chat active, the launcher shows an "Assistant active" /
      "Voice live" chip that restores and focuses the existing conversation.
- [ ] **Voice-first project chips with an honest audio affordance** — `🔊 Summarize · 🔊 Tell me more ·
      🔊 Just talk about it` — plus a text-chat option and a quote-selection toggle. **A highlighted
      quote reaches the model only after an explicit tap** — never silently.
- [ ] **The owner can answer "is the assistant working for visitors?" from one place.** A new admin
      **Assistant** tab opens on a KPI strip (conversations with voice split, turns split, toned failure
      rate, review queue), then an "Assistant in the site" 4-step journey with conversion %, then facets
      (opened-from, voice-from, mic outcomes, tools, content), then failures. Served by
      `GET /api/contact/admin/assistant-usage?days=` over an **SDK-free core**.
- [ ] **The new events actually move the dashboard.** `chat_open{surface}`, `chat_live_start{source,
      intent}`, `chat_mic_permission{state}`, `chat_tool_call{tool,ok,source}`, `project_assistant_chip`,
      `selection_assistant_offer|chip`, `chat_launcher_resume` are emitted, and a journey that exercises
      them changes the numbers on the tab — declared-but-never-emitted fails this bullet.
- [ ] `scripts/qa/admin-dashboard-preview.py` produces screenshot checks that **catch a blank or broken
      tab** (a preview that passes on an empty page is worthless).
- [ ] `[human-staging GATED]` **G1 re-run against M4's surface:** voice chips, open/close a project by
      voice, navigate while the assistant is speaking. **Gates M4 to prod.**

---

### M5. **A year from now I can still find where anything lives, and a stray import can't quietly re-tangle the modules** — `[app node:test]` `[chat pytest]` · ADR-0018 — ~4 slices → now ~2
_**Decision 3 shrank this to docs + boundary tests.** M2/M4/M6 write at their final addresses, so there
is no big-bang relocation. **PO flag: the two boundary tests are worth landing EARLY — see the
sequencing note at the end of this milestone.**_

- [ ] `docs/components.md` describes the shipped layout and **matches what is on disk** — a reader can
      locate any module from it: `js/lib/` (physics: projection/cull + kinematics; rain: engine, prefs),
      `js/components/` (`assistant/ · theme/ · hero/ · admin/`), `js/` shell (app.js, navigation,
      projects, contact, site-state, analytics); `docker/chat/app/` (`models/ · voice/ · assistant/` +
      `main.py`/`lambda_handler.py` harness + leaf infra); `aws/src/admin/` SDK-free cores with Lambda
      entries that only wire.
- [ ] `test/component-boundaries.test.mjs` goes **RED** if a `lib` imports a component, or if a
      component imports another component outside a declared seam.
- [ ] `docker/chat/tests/test_component_boundaries.py` goes **RED** if `app/models` imports
      assistant/voice/main, or if an admin core imports an AWS SDK.
- [ ] **The declared seams are enumerated in the test as data** — adding a seam is an explicit,
      reviewable one-line edit, not an invisible exception buried in a regex.
- [ ] **ADR-0018 records the address-first decision** and why the big-bang relocation was not done, so
      a future reader doesn't "finish" a refactor that was deliberately descoped.

> **PO sequencing flag (raised, not decided):** the plan places M5 *after* M2–M4 because it originally
> relocated their files. Under decision 3 it no longer relocates anything — it **fences** addresses that
> M2/M4/M6 are about to write. Landing the two boundary tests *before* M2 makes address-first
> enforceable; landing them after makes M5 a retrofit of whatever happened to be written. Recommend
> splitting: boundary tests + a docs skeleton right after M0; ADR + full `docs/components.md` once the
> addresses are populated. **Navigator/architect call.**

---

### M6. **I stop paying for a chat host that idles all night, and a visitor who arrives cold still gets an answer — with an honest "waking up" message instead of an error** — `[app node:test]` `[infra]` `[frontend-manual]` · ADR-0019 — ~5 slices
_Independent of M2–M5, parallelisable. The ECS Express chat host runs 24/7 (`MinTaskCount` default `1`)
though it is stateless and idle most hours. **Ships opt-in behind `CHAT_SCALE_TO_ZERO=1`.**_

- [ ] **It sleeps.** With no heartbeat for 20 minutes the host scales to zero (min 0, desired 0) — the
      decision is observable in the pure policy core, and the admin Health card reads "scaled to zero".
- [ ] **It wakes, and stays awake while someone is talking.** A page load beacons activation; a cold
      host is pinned to **`MinCapacity=1`** plus desired 1. A test covers the dangerous case the
      transcript names: Express's own autoscaler must **never** scale an *active, low-CPU* conversation
      back to zero.
- [ ] **A cold visitor is told the truth and does not retype.** A message that hits a waking host shows
      "Assistant is waking up (~1 min)" and is **resent automatically** when the host is up — no raw
      502/503/504 reaches the visitor.
- [ ] **The wake beacon goes direct, not through the 4 s event buffer** — pinned by a test, because
      routing it through the buffer starts the 60–90 s wake four seconds late for no reason.
- [ ] **The daily report stops crying wolf.** A pre-warm at **11:50 UTC** means the 12:00 report's deep
      probe meets a warm host, so an idle host is no longer reported as a chat failure.
- [ ] **The owner can see and control host state.** The admin Health card shows always-on /
      scaled-to-zero / starting / warm, and "Run deep probe" **warms and waits first** rather than
      failing on an idle host.
- [ ] **Blast radius is bounded by IAM:** the warm Lambda's permissions are scoped to
      `service/*/portfolio-chat-*` — it cannot touch any other ECS service in the account.
- [ ] **Rollback is rehearsed, not assumed:** redeploying without `CHAT_SCALE_TO_ZERO=1` restores
      always-on, and that path is exercised once before the flag is turned on anywhere real.
- [ ] `[human-staging GATED]` **G2 — on staging: ECS Express accepts `MinTaskCount=0` / desired-count 0,
      and `RegisterScalableTarget` on its scalable target is permitted.** **Gates M6 to prod.** If
      either is refused, M6 does not ship as designed and the host story needs rework — see the PO flag
      below.
- [ ] `[human-staging GATED]` **Real cold-start time is measured on staging and recorded.** The plan
      estimates 60–90 s; if reality differs, the visitor-facing "~1 min" copy changes to match. Copy
      that lies to the visitor is a defect, not a nit.

> **PO flag (raised, not decided):** G2 is a **go/no-go on the design**, not a polish gate. If Express
> refuses `MinTaskCount=0` or the permission is denied, ~5 slices are already sunk *and* M7 loses its
> `chat_cold_wait` trigger. Recommend running G2 as a short spike on staging **before** M6's slices are
> built, not as an acceptance gate after them.

---

### M7. **When a visitor's voice fails to start or their message doesn't send, I hear about it within the hour — and a storm is one ping, not a hundred** — `[app node:test]` `[chat pytest]` `[journey]` · ADR-0020 — ~4 slices
_**Depends on M6** (for the `chat_cold_wait` signal). Today visitor-side failures are recorded silently
and only surface in the next daily report. This is exactly the "voice requested and the user waits" vs.
"voice failed to start" split the source session asked for — two priorities, not one silent record._

- [ ] **P1 means broken.** `chat_live_error` (voice failed to start) and `contact_submit_error` each
      raise a **P1** to the existing alarm SNS topic, subject line carrying **`[P1]`**.
- [ ] **P2 means degraded.** `chat_cold_wait` (a visitor waited on a waking host) and
      `chat_live_blocked` raise **P2**, subject **`[P2]`** — "waited" is distinguishable from "failed"
      at a glance in the inbox, without opening the mail.
- [ ] **A storm is one ping.** 100 failures of the same type inside 5 minutes produce **one**
      notification — per-type cooldown, default 1 hour, **persisted in the events table** so it survives
      a Lambda recycle.
- [ ] **The mint path alerts at all.** A `/api/live/session` mint failure or timeout fires a **P1
      `voice_mint_failed`** — today only model-fallback paths alert, so a total voice outage is silent.
- [ ] **The FE actually emits the new signal.** Journey **J8d** pins that a visitor who genuinely waits
      on a waking host produces `chat_cold_wait` (a declared-but-unemitted event fails this bullet).
- [ ] **The cooldown cannot silently swallow a real outage.** The owner can see, per alert type, when it
      last fired and whether it is currently in cooldown — surfaced on the admin health/alerts area.
      _(PO-added: a persisted 1-hour cooldown with a bad clock or a failed write suppresses **every**
      alert of that type, indefinitely, with no symptom. Nothing in the plan lets the owner notice.)_
- [ ] Every new knob (cooldown window, per-type enablement) appears in
      `secrets.example/deploy.env.example` with its default.

---

### M8. **The assistant is cheap to abuse, honest about what it keeps, and the admin tells me in one line whether anything needs me** — `[app node:test]` `[chat pytest]` `[infra]` `[frontend-manual]` · ADR-0021 — ~8 slices
_Independent of M0–M7 except H7, which reads data produced by M4 and M6. **PO recommendation: split
this into 7 independently-shippable items when it reaches the top of the queue** — only H7 has a
dependency, and one 8-slice item at the top of a backlog is exactly what "keep the top small" forbids._

- [ ] **H3/S1 — the Gemini key is not a readable env literal.** It resolves from an **SSM SecureString**
      via the ECS task's `Secrets`, the execution role's read is scoped to that one parameter, and chat
      still answers normally. `CHAT_GEMINI_KEY_VIA_SSM=0` restores the old path while validating.
- [ ] `[human-staging GATED]` **G3 — the `Secrets` reference resolves on an Express service** on
      staging, with real cold-start timing observed. **Gates M8.1 to prod.**
- [ ] **H2/S3 — a burst costs money once, not forever.** Above **120 chat requests/min** or **30 paid
      voice mints/10 min**, the API answers **`429` with `Retry-After`**, one **P2** alert fires when
      the guard engages, and `/ready` reports the guard's stats. **Global sliding windows only, by
      default.**
- [ ] **H2/S3 — a shared NAT can never be locked out, by construction.** Per-IP limits exist but
      **default to `0` (OFF)**, and tests prove that with them off a flood from one IP behind a shared
      NAT never 429s a different visitor on that IP, and that an **empty or absent** IP is never rate
      limited. _(Settled product decision — see design-notes. Not a tuning exercise.)_
- [ ] **H1/S4 — transcripts age out from the last turn, not the first.** Every write refreshes a `ttl`
      of **180 days after the most recent turn** (`0` disables); DynamoDB TTL is enabled on the table.
      Observable: an untouched old session expires; a session still being used does not.
- [ ] **H4/S2 — the site ships security headers.** CSP + security headers are served for the site and
      the admin via Amplify `customHttp.yml`, pinned by `test/security-headers.test.mjs`. The accepted
      residual **`script-src 'unsafe-inline'`** is recorded as a residual (the no-build site has inline
      boot scripts) — not silently dropped from the policy.
- [ ] **H5/S5 — a visitor can find out what the assistant keeps, in plain words.** A footer link opens a
      privacy note covering: what the assistant stores, **180-day retention**, **no audio stored**, mic
      used only when needed, hashed-IP analytics — and every claim in it **matches what the code
      actually does**.
- [ ] **H6/S6 — a read-only admin key.** `ADMIN_READONLY_KEY` (timing-safe compare) sees every
      dashboard; **every POST mutation answers 403** without the full key.
- [ ] **H7 — the admin opens with "does anything need me?"** A ranked **Attention** strip sits above the
      tabs (bad → warn → info), built **only from data already loaded** (contact failures & DLQ,
      pipeline alarm, failing chat turns + latest error code, review queue, mic denials, tool errors,
      host scale state, usage context). Each row has an **Open** button that jumps to the owning tab,
      and it reads **"All clear"** when nothing needs attention.
- [ ] `[frontend-manual]` qa-verifier confirms the Attention strip on a dashboard with **real failures
      present** and on a **clean** one — "All clear" must be earned, not the default render.

---

### Acceptance gate for the milestone (what "done" means)
- [ ] M0 shipped (the public sink is bounded) — and shipped **first**, ahead of everything else here.
- [ ] M1 pixel-identity proven **in this repo** (0 differing pixels at 5 hours + reduced motion) with a
      recorded frame-time measurement.
- [ ] M2 + M4: the assistant yields the stage, knows where the visitor is, is reachable behind a project
      dialog, and never again confirms an action it doesn't perform. **G1 signed by a human on staging.**
- [ ] M3: daytime precipitation matches the season, hail at 1-in-9, snow unchanged in winter.
- [ ] M5: `docs/components.md` matches disk; both boundary tests go RED on a violation.
- [ ] M6 + M7: host sleeps and wakes honestly; P1/P2 alerts fire with cooldown and are visible.
      **G2 signed by a human on staging** (and ideally spiked before the build).
- [ ] M8: hardening landed; per-IP limits **OFF** by default and proven harmless; Attention strip earns
      its "All clear". **G3 signed by a human on staging.**
- [ ] ADRs **0015–0021** written (numbers reused from the transcript for traceability); invariants
      **#17–#26** land with their milestones.
- [ ] Docs updated: `docs/architecture.md` (stage, site-awareness, precipitation, alerts, perf note),
      `docs/components.md`, `docs/review-2026-08.md` + `docs/security-review-2026-08.md` ported as
      records, runbook sections for scale-to-zero, and every new knob in
      `secrets.example/deploy.env.example`.
- [ ] Full `node --test` app suite GREEN and chat pytest GREEN at every milestone boundary (baseline
      203/202/0 fail/1 skip · 114 pass — **counts are a floor, not a target**).
- [ ] `tdd-critic` = PASS on each milestone.
- [ ] qa-verifier has signed every `[frontend-manual]` bullet.
- [ ] **All three `[human-staging GATED]` checks (G1, G2, G3) are signed by a named human on staging
      before anything they gate reaches prod. A green suite does not tick them.**
- [ ] Promotion follows the documented safe sequence: build on `agent`, merge **`--no-ff`**, re-pin prod
      hosts with `scripts/sync-site-api-urls.mjs`, then `GVP_EXPECTED_ENV=prod node --test
      test/frontend-api-url-env-guard.test.mjs` **before** push. **Never `--ff-only`** (Amplify serves
      `main`'s HTML as-is → staging-host leak).

### Accepted residuals (carried from the source session; do NOT re-open as defects)
- CSP `script-src 'unsafe-inline'` — the no-build site ships inline boot scripts; removing it needs a
  build step or nonces.
- No IP allowlisting on admin — same lockout concern as the per-IP limits; throttles + a high-entropy
  key instead.
- `chat.js` (~2k lines) stays unsplit — splitting it is cosmetic; deferred, and journey-covered either
  way.
