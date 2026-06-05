# The tic protocol

A **tic** is a single unit of agent-to-agent **in-session communication** — a structured,
append-only, file-mediated record. It is *not* a chat box: agents still coordinate through the
files, the suite, and the hooks. The tic protocol **names and records** those gated handoffs
(and adds a slack-like message channel) as one auditable log.

## The record
One JSON object per line in `.claude/state/tics.jsonl` (transient — gitignored, like
`suite-status`):

| field | filled by | meaning |
|-------|-----------|---------|
| `ts` | auto | UTC ISO-8601 |
| `seq` | auto | monotonic per-file counter |
| `kind` | caller | one of the kinds below |
| `from` / `to` | caller | emitter role / addressee role (`*` = broadcast) |
| `phase` / `layer` | auto | from `.claude/state/{phase,layer}` |
| `scope` | auto | `TICS_SCOPE` (per-call override) if set, else `.claude/state/scope` (e.g. `pair:S2`), else the active layer, else `*` |
| `msg` | caller | one-line summary |
| `ref` | caller | pointer to the objective artifact (slice id / file / test) |
| `result` | caller | `green`/`red`/`pass`/`concerns`/`block`/`blocked` |

## The kinds
| kind | from → to | meaning |
|------|-----------|---------|
| `delegate` | orchestrator → subagent | hands a slice down (before delegating) |
| `handoff` | subagent → orchestrator | returns control (carries the observed result) |
| `signal` | run-suite / guard → `*` | machine fact (suite green/red); **hook-emitted, unforgeable** |
| `block` | guard → orchestrator | a scope refusal (why an edit was stopped) |
| `verdict` | tdd-critic / qa-verifier → orchestrator | a review / acceptance ruling |
| `msg` | any → role or `*` | **slack-like in-session message** — contact/update another agent |
| `note` | any → `*` | a log-only annotation |

`signal` subsumes the old suite-telemetry event (it carries `exit` + `durationSec`), so
`tics.jsonl` is the single process log.

## Emitting
Hooks emit automatically: `run-suite` → `signal`, `guard` → `block`. Agents emit one line via
the wrapper (mechanism is `emit_tic` in `.claude/hooks/lib.sh`; gated by `TICS=1`):

```
.claude/hooks/tic.sh FROM TO KIND MSG [REF] [RESULT]
```

- orchestrator, before delegating: `tic.sh orchestrator test-writer delegate "slice S2" S2`
- a subagent, on return:           `tic.sh test-writer orchestrator handoff "added failing test" live.test.ts red`
- anyone, to contact an agent:     `tic.sh navigator architect msg "use option B for the seam"`

## Scope — the signal/noise + coupling axis
Every tic carries a `scope`, read ambiently from `.claude/state/scope` (set it per pairing
session like phase/layer: `echo pair:S2 > .claude/state/scope`). For a **fan-out**, each branch sets `TICS_SCOPE=<task>/<branch>` per call (highest precedence) so concurrent branches self-scope onto one shared bus without touching the global file. A **pairing-tic** is scoped to
its pair (`pair:S2`) — signal to that pair, noise to others. A **coupling-tic** uses a broader
scope (`feature:auth`, `contract:RankedFeed`, `*`) and reaches everyone coupled to it — so a
pairing-tic is just a tightly-scoped coupling-tic. Filtering by scope keeps a view 100% signal:
`tics log --scope pair:S2` shows that pair plus global (`*`) tics and hides the rest.

## Viewing
Use the installed reader `.claude/hooks/tics <cmd>` (agents) or `npx team-tactics <cmd>` (shell); `tic.sh` only EMITS.
- `tics log [--scope <s>]` — the thread. **Merges every git worktree's bus BY DEFAULT** (whole picture — a detached worktree's tics aren't invisible from the main checkout); pass `--here` to restrict to the local bus. With `--scope`, just that scope + global (`*`). (Same default for `conductor`/`claims`/`sections`/`gate`.)
- `tics inbox <role> [--scope <s>]` — your inbox: tics where `to ∈ {<role>, *}` (and scope, if given). Read it at the start of your
  turn and address any directed `msg`.
- `tics report` — process metrics aggregated from the `signal` tics.
- `tics conductor` — the cross-pair coupling tics only (claim/release/contract/need/msg).
- `tics claims` — active file/module claims (claim minus release), by scope.
- `tics cycle` — inner-loop dashboard: phase/layer/scope + last suite signal + cycles since the last tdd-critic verdict (nudges a critic pass when overdue).
- `tics gate` — release gate: exits non-zero unless the required outer-loop verdicts (product-owner accept + tdd-critic PASS) are on the bus; the project-manager runs it before tagging.

## Parallel pairs (the coupling kit)
Run independent slices as **parallel pairs**, coordinated by coupling-tics:
- `claim` / `release` — a pair claims a file/module (`ref`) so two pairs don't edit the same
  thing; release when done. With `CLAIMS_ENFORCE` (default on) the guard blocks an edit to a file held by another scope and emits a `need`. **Claiming is automatic:** when a scope is set, the guard auto-claims a still-unclaimed file on first edit (first toucher owns it; rivals are then blocked) — no manual bookkeeping. `tics claims` lists what's owned (claim minus release), by scope; `tics claim-owner <file>` reports who holds one (empty if free).
- `commit` — a VCS landing event from the post-commit git hook; git runs it under ANY tool, so commits land on the bus even where the Claude Code hooks don't fire (e.g. Cursor) — the cross-tool visibility bridge.
- `section` — the lifecycle of a partition (the scope's first component, `ref`). **Opening is automatic:** the guard auto-opens a section on first scoped edit, so the partition map fills itself — mark it shipped with `tic.sh <pair> '*' section done <name> done`, which **auto-releases that section's claims** (release-on-done) so the partition frees up for reassignment. `tics sections` is the live map (each section's `[open|active|done]` status + tics/claims/contracts/needs); `tics section-status <name>` reports one section's latest status (empty if unopened).
- `contract` — the architect publishes a seam (a coupling-tic) that unblocks dependent pairs. **Auto-published:** creating an ADR (`docs/decisions/*.md`) auto-emits a `contract`, so design decisions surface as coupling telemetry even in solo/serial work — no scope or parallel pairs required.
- `need` — a pair signals a dependency ("need contract C").

The **conductor** (orchestrator) watches `tics conductor` — a per-scope summary (each working
unit's section `[open|active|done]` status, its active claims, needs, and contracts — claims read
`(freed)` once the section is done) over the cross-pair coupling thread, with each pair's
high-frequency pairing-tics filtered out as noise — and assigns conflict-free
scopes. Each pair works in its scope (`echo pair:S2 > .claude/state/scope`) and reads its own
thread via `tics log --scope pair:S2`.

### Sections (DDD bounded contexts)
For large projects the architect maps **sections** (bounded contexts) in
`.claude/state/sections.md` and scopes work hierarchically: `echo ranking/S2 > .claude/state/scope`.
Then `tics log --scope ranking` shows the whole section (all its pairs), `--scope ranking/S2` one
pair, and a pair also sees its section-level + global tics. `tics sections` summarizes per-section
live activity (tics, open claims, contracts, needs). Sections coordinate across their seams with
`contract`/`need`/`claim` tics — opt-in; small projects stay single-section.

### The shared bus (store)
For parallel writers sharing one log, set `TIC_STORE=spool` in `.claude/tdd.config`: each tic
becomes its own file under `.claude/state/tics.d/` — concurrency-safe (no shared-file append or
seq race). Default `TIC_STORE=jsonl` (one append-only file) suits a single session; the views
merge either store transparently. SQLite is intentionally avoided — it would break the zero-dep
/ Node>=16 / bash-hook portability invariants for wins not needed at session scale.

## Multiple sessions on one repo — COMBINE forces (ADR 0003, supersedes 0002's worktree advice)
Multiple sessions exist to combine power on ONE shared tree — horizontal scaling, where a new
session is a new worker on the team — NOT to isolate into separate worktrees (that forks the team
and splits its power). Sessions share `.claude/state/tics.jsonl`, so the bus IS the cooperation
medium. First, the substrate that keeps cooperation from double-working or clobbering:
1. **Identify + scope each session.** `echo <id> > .claude/state/session` (or `TICS_SESSION`) + a
   distinct `echo <id>/<area> > .claude/state/scope`. Every tic carries the session; edits auto-claim;
   `tics sessions` shows who's active where.
2. **Fail-closed:** `MULTI_SESSION=1` — the guard refuses an *unscoped* edit (unscoped is how two
   sessions silently collide; scoping makes claims engage).
3. **The bus enforces disjoint writes:** a rival session's claim blocks your edit (`claim-check`);
   the **pre-commit** blocks committing a file — or a release (the **`RELEASE` lock**) — held by
   another live session (the git choke-point the edit-guard can't see).

On that substrate, two cooperation patterns — same primitives, no new kinds:
- **Master/worker.** A worker JOINS: `tic.sh <id> '*' session open available` (now `[active]` in
  `tics sessions`). The lead ASSIGNS: `tic.sh lead <id> delegate "<slice>" <id>/<area>`. The worker
  loops: `tics todo` (your open assignments + the pool) → `echo <id>/<area> > .claude/state/scope`
  → edit (files auto-claim; rivals blocked) → `tic.sh <id> lead handoff "done" <ref> green` →
  `tic.sh <id> '*' section done <area>` (frees the lane) → pull the next. Scale out by adding workers.
- **Joint-forces (peers, no fixed lead).** Offer work to the pool with `delegate to '*'`, pass a
  slice you can't finish with `handoff to '*'`, summon help with `need`; first toucher claims it.
  `tics todo` shows what's open for you + the pool to grab; `tics conductor` is the live picture.
  `tics conductor` is the shared live picture.

Worktree-per-session is only a niche escape valve for genuinely INDEPENDENT efforts (which isn't
cooperation); `tics … --all` (default) still unions their buses when `TIC_STORE=spool`.

## Red-storm breaker
A long run of red suites usually means the failing TEST is over-constrained or contradictory,
not that the code is wrong. `run-suite` counts consecutive reds (reset on green); at
`RED_STREAK_LIMIT` (default 5) it emits a `stuck` tic, `tics cycle` flags the streak, and the Stop
hook escalates from "keep going" to "reconsider the test (route to test-writer) or ask the
navigator." Stops the loop grinding on an impossible test instead of surfacing the suspicion.

## Why it stays faithful to "never through chat"
- `signal`/`block` are produced by the hooks — agents cannot forge an objective fact.
- Every handoff is still gated by the RED/GREEN suite; tics **record** the handoff, they do not
  replace the gate.
- The channel is a structured, append-only, durable file — auditable, not ephemeral chat.
