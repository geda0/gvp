# The outer loop (full-team preset)

The inner loop (`docs/tdd/tdd-workflow.md`) turns one behavior into tested code.
The **outer loop** turns intent into accepted, released features, and is run by the
orchestrator with the roles below. Install/refresh them with
`npx tics --preset full-team`.

## Roles
| Role | Owns | Writes |
|------|------|--------|
| product-owner | the prioritized backlog + acceptance | backlog.md, design-notes.md |
| architect | contract seams + ADRs | docs/decisions/*, architecture docs |
| qa-verifier | experience-level acceptance (the running app) | a verdict (files defects) |
| project-manager | the milestone→release pipeline | releases.md |
| dev-ops | git + deploy mechanics + infra/ | infra/, the deploy |
| orchestrator | runs the loop, delegates, records | progress.md |
| navigator (human) | final authority on scope/brand/risk | decisions |

## The loop, per feature
1. **PLAN** — product-owner selects the next backlog item and writes its acceptance
   criteria (observable behaviors) into `design-notes.md`. Surface decisions to the
   navigator.
2. **DESIGN** — if the feature adds/changes a contract or crosses a layer, the
   architect confirms/extends the seam and records an ADR. Skip for additive work on
   an existing contract.
3. **BUILD** — run the inner red→green→refactor loop for each acceptance bullet
   (for cross-layer features: backend contract → frontend → one e2e journey).
4. **ACCEPT** — for UX features, qa-verifier drives the running app; then the
   product-owner signs off against acceptance, or files follow-ups/defects.
5. **RECORD** — product-owner updates `backlog.md`; orchestrator updates
   `progress.md`.
6. **RELEASE** — at a milestone boundary (accepted, bar green), the project-manager
   (with dev-ops) commits, git-tags, and deploys the milestone, verifies health, and
   records it in `releases.md`. Surface release blockers; then take the next feature.

## Parallel sections (large projects)
When the domain has clear bounded contexts and more than one pair/role can work at once,
the architect (called by the product-owner) **sections** the project: each section is a
bounded context built in parallel, scoped `section/pair`, coordinating across seams with
`contract`/`need`/`claim` tics on a shared spool bus. The PO/PM/architect can work one
section while a dev pair finishes another. Opt-in — small projects stay single-section.
Full guide: `docs/tdd/sectioning.md`; the live map is `.claude/state/sections.md`.

## Invariants
- The product-owner accepts; the project-manager ships. Never release on a red bar
  or unaccepted work.
- Acceptance criteria are observable behavior, never "implement X".
- The files are the source of truth (backlog / design-notes / progress / releases);
  every role reads them before acting and writes only its own.
- Sectioning (large projects) is a *coordination* boundary, not a quality one: every
  section keeps the whole suite green and runs the full red→green loop.
