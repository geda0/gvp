# Tool support — what's automatic, what's manual

team-tactics has two halves: the **method** (TDD pairing, the tic protocol, the state files,
the docs) which is **tool-agnostic**, and the **referee** (the gate that enforces it) which is
**Claude Code's hooks**. Know which half your agent gets.

## Claude Code — full enforcement
`.claude/settings.json` wires the hooks to Claude Code's events; they fire automatically:
- **guard-edit-scope** (PreToolUse) blocks edits outside the active phase×layer, and edits to a
  file another scope has `claim`ed.
- **run-suite** (PostToolUse) runs the active layer's suite and emits a `signal` tic — an
  **unforgeable** objective fact (an agent can't fake green).
- **require-green-to-stop** (Stop) refuses to finish on a red bar.
- **subagent-handoff / session-green-check** auto-emit handoff tics + warn on a red baseline.

## Cursor and other agents — method only; you are the referee
These tools do **not** run Claude Code's `settings.json` hooks (Cursor's `.cursor/` has no
equivalent). So **nothing fires automatically — the gate fails *open*.** What you still get:
- **AGENTS.md + `docs/`** — the full method, readable by any agent.
- **`.claude/hooks/tic.sh` / `.claude/hooks/tics`** — plain scripts you can call by hand to
  emit/read tics.
- `npx tics selftest` confirms the hooks are *installed* — but NOT that your edits are *gated*
  (your tool isn't running them).

**Because the referee is gone, you self-enforce. Per edit:**
- [ ] Read `.claude/state/{phase,layer}`. red → edit only the layer's **tests**; green → only
      **source**; refactor → anything but keep green; off → ungated.
- [ ] Run the layer's test command yourself after each edit; treat red as a stop.
- [ ] Emit the tics the hooks would have — a `signal` after a run, `delegate`/`handoff`/`verdict`
      at the boundaries: `.claude/hooks/tic.sh <from> <to> <kind> "<msg>" <ref> <result>`.
- [ ] **Never** hand-emit a green `signal`/`handoff` while the suite is red — that breaks the
      one invariant the protocol rests on (signals are objective fact).
- [ ] **Parallel worktrees:** share one bus — set `TIC_STORE=spool` + `TICS_DIR` in
      `.claude/tdd.config` (see its "Parallel worktrees" block), or claims/needs fragment per
      worktree and the conductor can't see across them.

## Making it more automatic elsewhere
- **The portable referee (any tool):** CI (`.github/workflows/tdd-verify.yml`, seeded) runs the
  suite on every push/PR — the always-on gate. For local enforcement run **`npx tics install-hooks`**:
  it installs a **pre-commit green-bar gate** (a red suite blocks the commit) AND a **post-commit `commit`-tic emitter** (every commit lands on the bus) into the repo's git hooks — so discipline AND cross-tool visibility hold no matter which agent made the commit (covers every worktree). Bypass once with `git commit
  --no-verify`; disable with `PRECOMMIT_GATE=0`.
- If your tool has its own hook/rules system, wire it to the same scripts.
