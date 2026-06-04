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

## Viewing
- `tics log` — the full thread.
- `tics inbox <role>` — your inbox: tics where `to ∈ {<role>, *}`. Read it at the start of your
  turn and address any directed `msg`.
- `tics report` — process metrics aggregated from the `signal` tics.

## Why it stays faithful to "never through chat"
- `signal`/`block` are produced by the hooks — agents cannot forge an objective fact.
- Every handoff is still gated by the RED/GREEN suite; tics **record** the handoff, they do not
  replace the gate.
- The channel is a structured, append-only, durable file — auditable, not ephemeral chat.
