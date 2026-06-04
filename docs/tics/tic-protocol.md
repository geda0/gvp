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
| `scope` | auto | `.claude/state/scope` if set (e.g. `pair:S2`), else the active layer, else `*` |
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
session like phase/layer: `echo pair:S2 > .claude/state/scope`). A **pairing-tic** is scoped to
its pair (`pair:S2`) — signal to that pair, noise to others. A **coupling-tic** uses a broader
scope (`feature:auth`, `contract:RankedFeed`, `*`) and reaches everyone coupled to it — so a
pairing-tic is just a tightly-scoped coupling-tic. Filtering by scope keeps a view 100% signal:
`tics log --scope pair:S2` shows that pair plus global (`*`) tics and hides the rest.

## Viewing
Use the installed reader `.claude/hooks/tics <cmd>` (agents) or `npx team-tactics <cmd>` (shell); `tic.sh` only EMITS.
- `tics log [--scope <s>]` — the thread; with --scope, just that scope + global (`*`).
- `tics inbox <role> [--scope <s>]` — your inbox: tics where `to ∈ {<role>, *}` (and scope, if given). Read it at the start of your
  turn and address any directed `msg`.
- `tics report` — process metrics aggregated from the `signal` tics.
- `tics conductor` — the cross-pair coupling tics only (claim/release/contract/need/msg).
- `tics claims` — active file/module claims (claim minus release), by scope.

## Parallel pairs (the coupling kit)
Run independent slices as **parallel pairs**, coordinated by coupling-tics:
- `claim` / `release` — a pair claims a file/module (`ref`) so two pairs don't edit the same
  thing; release when done. `tics claims` lists what's owned (claim minus release), by scope.
- `contract` — the architect publishes a seam (a coupling-tic) that unblocks dependent pairs.
- `need` — a pair signals a dependency ("need contract C").

The **conductor** (orchestrator) watches `tics conductor` — only the cross-pair coupling tics,
with each pair's high-frequency pairing-tics filtered out as noise — and assigns conflict-free
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

## Why it stays faithful to "never through chat"
- `signal`/`block` are produced by the hooks — agents cannot forge an objective fact.
- Every handoff is still gated by the RED/GREEN suite; tics **record** the handoff, they do not
  replace the gate.
- The channel is a structured, append-only, durable file — auditable, not ephemeral chat.
