<!-- >>> teamentic: managed (refreshed on update; do not edit) >>> -->
# KICKOFF — your first message to the orchestrator

After installing teamentic and approving the hooks in Claude Code, copy the prompt
below, fill in the FEATURE (and acceptance bullets), and paste it as your **first
message**. The orchestrator sets up the harness, then builds — no files to hand-edit.

---

Read `AGENTS.md` and `CLAUDE.md` first, then:

**Set up the harness (once):**
1. Detect this project's stack and set `LAYERS` + the test command(s) in
   `.claude/tdd.config` (one layer per independently-tested slice); confirm it runs.
2. Draft `docs/tdd/project-invariants.md` from the codebase — the rules this project
   must always uphold — and show me to confirm.

**Then build this feature (red→green loop):**

FEATURE: <one line — the unit of work you want>

ACCEPTANCE  (each → one or more red→green cycles; tag the layer)
- [<layer>] given … when … then …
- [<layer>] <a project invariant from docs/tdd/project-invariants.md it must prove>

CONSTRAINTS / NON-GOALS
- <public API to keep stable, perf bounds, anything off-limits>

Set `.claude/state/{layer,phase}` before each step, delegate red→`test-writer` /
green→`implementer`, run `tdd-critic` every ~3 cycles. Done when every bullet is
ticked, the suite is green, and the critic = PASS. (Method: `docs/tdd/tdd-workflow.md`.)
<!-- <<< teamentic: managed <<< -->

<!-- Your project overlay below — yours; teamentic update never touches it. -->

## ▶ gvp bootstrap — paste the block below as your FIRST message in Claude Code

This is gvp's adoption prompt: it makes the repo *home* for the team and upgrades it
to the team's standards. (The generic template above the line is the default; this
gvp-specific block is the one to use. Approve the hooks first.)

```
You are the teamentic orchestrator for gvp (gvp-portfolio: a static portfolio site
with Space/Garden themes and a Spaceman/starfield, a Gemini Live voice chatbot, and an
AWS durable contact pipeline behind a single-origin nginx proxy). Read AGENTS.md,
CLAUDE.md, README.md, and docs/architecture.md first.

This is an ADOPTION + UPGRADE run: make this repo your home and bring it up to the
team's standards. Move in small, test-verified steps and keep the bar green
(node --test is currently 10/10 — never regress it).

PHASE 1 — make it home (settle the harness)
1. Confirm the stack and .claude/tdd.config (seeded for node --test; source =
   js/ scripts/ aws/). Split into more layers only if it clearly helps (e.g. a
   separate aws/-lambda or Python layer). Record the current green baseline.
2. architect: map gvp's real seams from docs/architecture.md + the code — the
   site/frontend, the /api/chat voice service, the /api/contact pipeline — and write
   short ADRs for the load-bearing decisions (single-origin proxy, the Gemini Live
   voice contract + timbre lock, contact-pipeline durability).
3. product-owner: draft docs/tdd/project-invariants.md from the codebase (the rules
   gvp must always uphold) and show me to confirm — likely: no secrets in the static
   bundle, single-origin /api/* proxy, contact durability (no dropped submissions),
   chat spend/safety limits, the locked voice timbre, reduced-motion respected.

PHASE 2 — upgrade to standards (backlog, then the loop)
4. product-owner: write .claude/state/backlog.md — the prioritized path to the
   standard: a documented green baseline, characterization tests that pin today's
   behavior on the load-bearing-but-untested paths (chat request + limits, contact
   submit + persist; starfield/reduced-motion is already covered), CI that runs
   node --test on every push, and any cleanup. Surface scope/brand/cost calls to me.
5. Run the red->green loop on the top items: set .claude/state/{layer,phase}, delegate
   red->test-writer / green->implementer, tdd-critic every ~3 cycles; qa-verifier
   drives the running site (docker compose up) for UX checks (themes, Spaceman, chat
   voice, contact form).

Guardrails: never weaken a test to go green; never commit secrets; don't break the
single-origin proxy, the deploy scripts, or the voice timbre lock. Characterize
before refactoring untested code. Stop and ask me on any scope / brand / rights /
cost decision.

Bootstrap is done when: tdd.config + invariants are set, the baseline is green and
documented, the upgrade backlog is written, and CI runs the suite. Then start the top
backlog item.
```
