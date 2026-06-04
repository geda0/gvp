# Divide and conquer — the default working mechanism

The first question at **every step**, in **every command**, is:
**can this be decomposed into independent sub-tasks that run concurrently and reconcile
through tics?** Decompose by default; stay serial only when the work is *atomic*. The tic
protocol (`docs/tics/tic-protocol.md`) is the substrate — `scope` is the partition key, and
`delegate`/`handoff`/`contract`/`need`/`claim`/`note` are the fork/join/dependency/result edges.

## The one rule
**Parallelize *around* the write-gate; serialize *through* it.**
The edits that flip red→green run one at a time through the phase×layer gate — that is TDD's
serial heart, and the gate is single-writer by construction (its identity is the working
directory). Everything *around* the edits — exploring, reading, planning, designing,
reviewing, synthesizing — is read-only or disjoint and **fans out on the main repo, no worktree.**

## Pick the shape by conflict class
At each step, classify the work and choose how to run it:

| conflict class | examples | shape | where |
|---|---|---|---|
| **read-only** | explore, read, review, audit, understand, plan-analysis | fan out → synthesize | main repo, no isolation |
| **disjoint writes** | N independent files / modules / tests | fan out, one `claim` per target | main repo + claims |
| **overlapping writes** | two pairs need one file | serialize (claim queue), split the file, or worktree | — |
| **ordered deps** | contract→consumers, red→green | pipeline (stage-parallel across items) | — |
| **atomic** | one behavior's red→green; a call that needs one mind | **don't** fan out | serial |

## Read-side fan-out — the default for exploring & reviewing
The biggest, safest win; reach for it first. Instead of reading a codebase serially,
**partition and fan out, then synthesize** — nothing is written, so there is no conflict and
no isolation:
- **Understand** a codebase → one reader per module/subsystem → merge into one map.
- **Review** a change → one agent per dimension (correctness / security / perf / style) →
  collect verdicts, then verify the real ones.
- **Plan** → analyze several slices or options in parallel → choose.
Each branch emits findings as `note`/`verdict` tics scoped to its slice; a final step reads
the scope and synthesizes. (The `Agent` and `Workflow` tools already do this fan-out.)

## Write-side fan-out — disjoint only
Two writers are safe on the main repo **only** if their files don't overlap. Each pair
`claim`s its targets; `tics conductor` / `tics claims` surface any collision. Overlap →
serialize (one holds the claim, the other waits), split the file (fix the seam), or — last
resort — give the concurrent writers separate **worktrees** (a per-worker gate identity,
sharing one bus via `TICS_DIR`; see `docs/tdd/sectioning.md`, full-team preset).

## When NOT to decompose
- **Atomic work:** one behavior's red→green is a feedback loop — don't split it.
- **Coordination > benefit:** fanning out trivially small tasks costs more in tics + claims +
  synthesis than it saves. Decompose only *substantial, independent* sub-tasks.
- **Coherence:** some judgments need one mind with full context, not a committee plus a merge.

## How tics carries it
- `scope` (hierarchical `task/sub`) — the partition key and the divide-and-conquer tree path.
- `delegate` / `handoff` — fork a sub-task / join its result.
- `contract` / `need` — dependency edges (B needs A's output).
- `claim` / `release` — the write-coordination signal for disjoint targets.
- `note` / `signal` / `verdict` — each branch's result, for the synthesis step.
- `tics conductor` / `tics claims` / `tics sections` — the live coordination graph.
