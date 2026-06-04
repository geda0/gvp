# TDD pairing workflow

The method this kit installs. The orchestrator runs it; the hooks enforce it.

## The principle
The pair coordinates **through the test suite and the files, never through
chat**. Every handoff is gated by an objective signal — the suite is RED or
GREEN. No agent decides "this looks done." The suite decides.

## Roles
- **orchestrator** (main session, `CLAUDE.md`): runs the loop, sets phase+layer,
  delegates, reads results, records state. Writes no code.
- **test-writer** (`.claude/agents/test-writer.md`): one failing test (RED).
- **implementer** (`.claude/agents/implementer.md`): minimal code to GREEN.
- **tdd-critic** (`.claude/agents/tdd-critic.md`): read-only quality audit.
- **human navigator**: defines features + acceptance criteria, resolves design
  questions, approves "done."

## Two state dimensions: phase × layer
The orchestrator writes both before each delegation (the hooks read them).

**Phase** (`.claude/state/phase`):
- `red` — only the active layer's **test** files may be edited.
- `green` — only the active layer's **source** files may be edited.
- `refactor` — anything in the layer; the suite must stay green.
- `off` — gate disarmed (for manual / non-TDD edits). This is the seeded default.

The gate is **fail-closed**: any unrecognized or missing phase blocks edits, so a
forgotten phase can't silently bypass the referee. Set `off` deliberately when
you're not in a cycle.

**Layer** (`.claude/state/layer`): one of the layers you declared in
`.claude/tdd.config`. **If your project has a single layer** (the default
`app`), the layer never changes and you can ignore the layer talk — the phase
loop is identical.

## Plan before you loop
Each feature starts with a **planner** pass that writes an ordered queue of
one-behavior slices to `.claude/state/plan.md` (layer-tagged, invariant-aware).
The loop then executes the queue one slice per cycle. Planning where it's cheap
(before code exists) is what prevents over-building and wrong-layer tests; it
also gives the critic something concrete to review — the slicing, not just the
tests.

## The loop (per slice)
```
echo <layer> > .claude/state/layer      # choose the slice (often just "app")
echo red     > .claude/state/phase
# delegate to test-writer  -> one failing test; hook runs the suite -> RED
echo green   > .claude/state/phase
# delegate to implementer  -> minimal code; hook runs the suite -> GREEN
echo refactor > .claude/state/phase
# optional cleanup; suite must stay GREEN
# update .claude/state/progress.md and tick design-notes.md
# every ~3-5 cycles: delegate to tdd-critic
```
Done when every bullet is ticked, the full suite is green, and the critic
returns PASS.

## The hooks (the referee)
Configured in `.claude/settings.json`:
- `guard-edit-scope.sh` (PreToolUse): blocks out-of-scope edits by phase × layer.
- `run-suite.sh` (PostToolUse): runs the active layer's suite, records green/red.
- `require-green-to-stop.sh` (Stop/SubagentStop): refuses to end on a red bar
  when phase is green/refactor.
- `session-green-check.sh` (SessionStart): warns if the baseline suite is red
  when a session starts — don't begin new cycles on a broken floor.

Verify the gate works in your environment any time with
`npx tics selftest` (fires synthetic payloads at the installed
hooks and asserts the exit codes).

If a hook blocks you, comply. Routing around the referee defeats the method.

## Anti-patterns the critic watches for
- Tests that assert implementation (mock call counts, private state).
- Weakening or deleting a test to force green.
- Over-implementing beyond the failing test.
- Hardcoded returns never triangulated into real logic.

## Process telemetry
Every suite run appends a JSON event to `.claude/state/telemetry.jsonl`
(timestamp, layer, phase, result, duration). `npx tics report`
summarizes it: cycles and retries per layer, suite durations, pass rates. A high
retries-per-cycle number in a layer means the test-writer's contracts there are
underspecified — a process signal you can act on. Add `telemetry.jsonl` and
`suite-status` to `.gitignore` (they're transient); commit the other state files.

## Variants
- **Driver/navigator:** one author (implementer) + a navigator/critic steering;
  skip ping-pong alternation.
- **Two peer sessions:** two Claude Code sessions in separate `git worktree`s on
  a shared branch, using the same `phase`/`layer`/`suite-status` files as the
  lock. Fully symmetric; heavier to operate.
