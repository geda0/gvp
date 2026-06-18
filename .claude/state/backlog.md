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
