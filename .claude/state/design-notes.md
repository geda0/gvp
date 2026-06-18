# Design notes (durable intent across cycles)

> Orchestrator maintains this. Subagents start fresh; anything that must survive
> between cycles lives here. Copy/brand direction for the active milestone is below —
> read it before building any copy or IA slice.

## Feature in flight (outer loop — full-team)

**MILESTONE: Work-showcase reframe + agent guide.** Turn the site from a résumé-shaped page into a
**portfolio** that leads with the work, and turn the chat agent into a **guide** that walks visitors
around the site. Five tracks (A IA merge → "Work"; B inline experience + résumé demotion; C guided-tour
agent + nav parity + stop-defaulting-to-résumé; D portfolio-piece copy; E polish). Backlog items 1–11 in
`backlog.md`; this file holds the copy/brand direction, the decisions, and the navigator/owner
escalations.

### The IA fact every builder must know first
The data is mislabeled against the owner's intent. In `data/projects.json`:
- **`playground`** array = the REAL project showcases (Team Tactics, AI assistant & chatbot, Monday
  Rover, GVP). These are the cards that should LEAD the site.
- **`portfolio`** array = the EXPERIENCE / résumé entries (Apptio, JumpCloud, HP, AT&T visible; MIU,
  Sunrise, Campus Party, 5d-agency, "early" hidden). This is the work HISTORY that gets DEMOTED to an
  inline section.

So the owner's "drop the Portfolio/Labs split" = collapse the two nav buckets into ONE **Work** section
that renders the `playground` showcases first, with the `portfolio` experience entries rendered inline
below (not behind a "Portfolio" nav link, not as a PDF-first blurb). Do not confuse "portfolio array"
(the data key = experience) with the new "Work" section (the merged showcase). When in doubt: **Work
section leads with projects; Experience section is the demoted résumé.**

---

## COPY / BRAND DIRECTION (the owner's voice — bless or override per the escalations)

> Through-line: **show, don't claim.** The old site asserts seniority ("Senior SWE · 15+ yrs") then
> backs it with a PDF. The new site shows the work first and lets the depth speak; the credential
> becomes context you find AFTER the work, not the headline. The voice is confident, plain, specific —
> "here is what I built and why it was hard," never "here are my years and my skill tags." This matches
> the existing strong copy already in the project `description`s and the experience `problem`/`work`/
> `outcome` triads — we're propagating that voice to the surfaces that still read as a résumé (hero,
> card teasers, the agent's default posture).

### 1. The new "Work" section intro line
- **Lead with what the work IS, invite the visitor in.** Recommended intro:
  > **Work** — _"Things I've built — production systems and the experiments that feed them. Open any
  > one to see the problem, the approach, and what it actually demonstrates."_
- The intro sets the reading contract for the cards below (problem → approach → outcome). It does NOT
  recap a résumé ("15+ years of…"). Keep it short — one or two lines, then the cards.
- If the owner wants a flat grid (default), no sub-headers needed. If grouped (escalation), use neutral
  framing — **"Selected work"** then **"Builds & experiments"** — never "Labs / personal builds &
  explorations" (the downplaying language the owner is removing).

### 2. How a project PIECE should read (the template)
Every project card + dialog should follow this arc (the copy mostly EXISTS — propagate it, don't invent):
1. **Hook (card teaser):** one line that names the problem or the intent, not the tech stack.
   - _Bad (résumé/spec):_ "SSE-streaming text chat, Gemini Live voice, automatic model fallback, and
     durable per-turn telemetry behind an admin dashboard."
   - _Good (portfolio hook):_ "The AI you can talk to on this site — built around the parts of
     production AI that are actually hard: latency, cost, rate-limits, and knowing when it failed."
2. **Problem / why it was hard** (dialog opens here — the existing dialogs already do this well).
3. **Approach** (what I did — the interesting decision, not a tool list).
4. **Outcome / impact OR "what it demonstrates"** (the landing — already present as the closing
   `<strong>What it demonstrates.</strong>` paragraph and in `chat-knowledge/projects.json`).
- **Tech list stays**, but as supporting detail (it already lives in `tech[]` + the dialog tech-wrap),
  NOT as the headline.
- **Source of truth for the rich copy:** the dialog `description` HTML and `data/chat-knowledge/
  projects.json` ("what it demonstrates" / "why it matters"). The card teaser is a derived hook, not a
  new essay. Track D item 8 = mostly tightening `cardDescription` into a hook; the depth is already there.

### 3. The experience / résumé section framing
- **Title it "Experience"** (not "Portfolio" — that label is retired with the nav merge). One short
  framing line above the entries:
  > **Experience** — _"Fifteen years of shipping production systems. The same way I read a project:
  > here's the problem each role handed me, what I did, and how it landed."_
- Each entry uses its existing **problem → work → outcome** triad (already authored well in the data —
  Apptio's reconciliation harness, JumpCloud's hybrid data layer, HP's DDD migration, AT&T's TQL). Make
  that triad legible in the inline render — don't collapse it back to the one-line `cardDescription`.
- The **bare credential** ("Senior Software Engineer · 15+ years") belongs HERE as context, not in the
  hero. The résumé PDF link lives here too, quiet — a "Download the full résumé (PDF)" affordance, not a
  focal CTA.

### 4. The hero reframe (lead with work, not credentials)
- **Drop the credential eyebrow as the lead.** Today: eyebrow "Senior Software Engineer · 15+ years" →
  name → skills subtitle → mic. New lead: an invitation into the work.
- Recommended hero lead (owner to bless — this is the most visible change):
  > **Marwan Elgendy** — _"I build production systems — and the experiments that feed them. Take a look
  > at the work, or just ask."_
  > (the agent / "Ask anything" entry stays right here as the "or just ask" path; a "See the work" cue
  > routes into the Work section.)
- The chat/voice entry is a CORE feature — keep it in the hero. The change is the FRAMING around it:
  from "here are my credentials, and a mic" to "here's an invitation into the work, and a guide who'll
  walk you through it."
- The three highlight tiles (Platform Architecture / End-to-End Delivery / Data-Intensive SaaS) can
  stay as a quiet "what I'm good at" band, but they should not be the hero's lead and should read as
  capability-framing, not résumé skill-tags.

### 5. The agent's new posture (a guide who leads with the work)
- **Persona:** a knowledgeable guide to Marwan's work — not a résumé-reader. It leads with the work,
  offers to show people around, and navigates the page on request.
- **Default behavior on "tell me about Marwan / his experience / his background":** answer with the
  WORK (a specific project or the relevant experience), then OFFER to scroll there ("want me to take
  you to it?") or offer a tour. **Never** open the résumé PDF as the default answer.
- **The résumé PDF (`open_resume`) is explicit-ask only:** fires only when the visitor literally asks
  for "the resume PDF / CV file / a download." For "tell me about your experience," the agent scrolls to
  the inline Experience section instead (item 7).
- **"Show me around" → guided tour:** the agent moves the page through the sections in order and
  narrates each stop in a line or two. Recommended tour order (owner to bless):
  1. **Work (projects)** — "Here's the work — start here."
  2. **A standout project** (e.g. the on-site AI assistant, since it's literally what they're talking
     to) — one line on why it's interesting.
  3. **Experience** — "And here's the fifteen years behind it."
  4. **Contact / "or just ask"** — end with a way to go deeper or get in touch (no dead end).
  - Pacing default: **step-on-confirm** ("ready for the next one?") rather than an auto-timed scroll —
    accessible and less jarring. Escalation if owner prefers auto-pacing.
- **Navigation parity:** the text agent gets a navigation tool matching voice's `navigate_to_section`;
  destinations become the new section ids (work / experience / home), with legacy `portfolio` /
  `playground` kept as aliases so prior model behavior still resolves.
- **System-instruction tone:** warm, specific, brief. "I can show you around, or take you straight to a
  project — what are you curious about?" The agent should sound like it's standing next to the work,
  not reading a CV aloud.

---

## DECISIONS (recommend; owner/navigator to confirm — do NOT silently choose)

### Decision A — "Work" is the single merged section/label ✅ (default)
One nav entry **Work**; it renders the project showcases first, Experience inline below. Alternatives
("Projects", "Selected work") are fine if the owner prefers; default is **Work** for breadth (it covers
projects + experiments + the experience that follows).

### Decision B — Experience is a distinct on-page section below the projects ✅ (default)
Render the experience entries as an **Experience** section directly below the Work project grid (one
page, one flow), NOT behind a separate nav link and NOT PDF-first. The agent scrolls to its anchor.
Alternative (a labeled band WITHIN Work) is acceptable; default keeps a clear titled section so the
agent has a clean scroll target.

### Decision C — résumé PDF kept, demoted to a quiet download; `open_resume` re-scoped ✅ (default)
Keep the PDF (some visitors/recruiters want it) but (a) demote it visually to a quiet "Download résumé
(PDF)" in the Experience section, and (b) re-scope the agent's `open_resume` tool to fire only on an
explicit file/download request — never as the default answer to "tell me about your experience."

### Decision D — copy reframe is an edit to EXISTING fields, not a schema change ✅ (default)
Tracks D items 8–9 tighten `cardDescription` into portfolio hooks and surface the existing
`problem`/`work`/`outcome` + dialog `description` — no new data fields, no schema migration. The depth
already exists; we're propagating voice, not authoring from scratch.

### Decision E — polish is calibrated refinement, NOT a redesign ✅ (default)
Track E tightens existing transitions, spacing, and card styling and reframes hero copy. Anything that
needs a genuinely new visual direction is escalated, not assumed. Reuse the existing good project-card
visuals; do not invent new card chrome.

---

## ESCALATIONS — open owner/navigator calls (block the dependent slices until resolved or default-accepted)
1. **older_projects fate** (`data/older_projects.json`: DDA, OIG OS, QREO). Keep as the existing
   earlier-career footnote / fold into the "Earlier:" line / drop? _Default: keep as the earlier-career
   footnote in Experience; do NOT promote into the Work grid._
2. **Hidden experience entries** (MIU, Sunrise, Campus Party, 5d-agency, "early" — `hidden:true`).
   Surface any in the inline Experience, or keep the visible four + earlier-career line? _Default: keep
   the current visible set; do not un-hide without owner say-so._
3. **Hero lead copy + where the credential moves.** The recommended hero line (§4) is the most visible
   change — owner should bless. _Default: rework the lead to an invitation; relocate the bare credential
   into Experience._
4. **Work internal grouping** — one flat featured-first grid (default) vs a light "Selected work" +
   "Builds & experiments" split. _Default: one grid; never downplaying language._
5. **Tour order + per-stop narration lines** are the agent's voice — owner should bless the script.
   _Default order in §5; default pacing step-on-confirm._
6. **Tour pacing** — step-on-confirm (default) vs auto-timed scroll.
7. **Navigation destination set** for the text agent's nav tool (work / experience / home + legacy
   aliases). _Default: those three + aliases._

---

## Item → track map (traceability)
A (IA merge): 1 = one "Work" nav entry; 2 = Work shows every project, projects-first.
B (inline experience + demote PDF): 3 = inline Experience section; 4 = PDF quiet download.
C (guided-tour agent): 5 = text nav parity; 6 = "show me around" tour; 7 = lead-with-work, PDF
explicit-ask-only.
D (portfolio-piece copy): 8 = project cards/dialogs as pieces; 9 = experience entries as pieces.
E (polish): 10 = hero leads with work; 11 = transitions/card treatment not cheap.

## Key source touchpoints (for the orchestrator/planner)
- IA / hero / sections: `index.html` (nav lines 60–61; hero 98–183; `#portfolioContent` 185–198;
  `#labsContent` 200–208), `js/navigation.js`, `js/section-names.js` (`normalizeSection`).
- Project data + render: `data/projects.json` (`playground` = showcases, `portfolio` = experience),
  `data/older_projects.json`, `js/projects.js` / `js/project-link.js`, `data/chat-knowledge/projects.json`.
- Agent tools: `docker/chat/app/providers.py` (`chat_tools()` — text path, needs nav parity),
  `docker/chat/app/live_gemini.py` (voice `navigate_to_section` enum), `js/chat.js`
  (`applyVoiceToolCall` ~1474, text action handler ~1437 — `open-resume`/`open-contact`/navigate).
- Résumé: `resume/Marwan_Elgendy_Resume_public.pdf` (the demoted download).

---

## Prior milestone (Pre-prod hardening → stage/prod — SHIPPED) — decisions kept for the record
> The three judgment calls (SEC-2 HMAC+pepper, SEC-1 consent banner, FE-2 split probe key) were built;
> consent (SEC-1) was later REVERSED per owner (no consent needed; `js/consent.js` removed); HMAC ipHash
> (SEC-2) and the split smoke key (FE-2) are LIVE in staging + prod. Full decision text in git history /
> releases.md / memory `prod-promotion-procedure`. OPEN owner items carried forward (not part of the new
> milestone): set `GVP_EXPECTED_ENV=prod` on the Amplify prod app; verify the positive `/api/chat/smoke`
> path with the prod `SMOKE_PROBE_KEY`; deferred S16 budget alarm + S30 per-IP WAF.

## Prior shipped (see backlog Shipped + progress.md)
Contact durability, chat invariants #7–#10, frontend guards #1/#2, invariant-completion pins, Team
Tactics contact CTA, pre-prod hardening (staging + prod).
