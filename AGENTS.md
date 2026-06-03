<!-- >>> teamentic: managed (refreshed on update; do not edit) >>> -->
# AGENTS.md - start here, every agent, every session

This project is built by **test-driven agent pairing** (the `teamentic` kit).
The method is single-sourced in `docs/tdd/` - read it; don't re-document it here.

- **Read first:** `docs/tdd/tdd-workflow.md` (the loop), `docs/tdd/testing-philosophy.md`,
  and `docs/tdd/project-invariants.md` (the rules this project must uphold).
- **Continue prior work** from `.claude/state/progress.md` (+ `design-notes.md`); run the
  suite for ground truth. State lives in files, never memory.
- **Roles:** `test-writer` (one failing test), `implementer` (minimal green), `tdd-critic`
  (read-only audit), the orchestrator (`CLAUDE.md`), and the human navigator.
- **The rails** (hooks): phase is `red`/`green`/`refactor` during a cycle, or `off` for
  manual work - **never empty** (empty fails closed). Edits are scoped by layer; you can't
  finish on a red bar. If a hook blocks you, it's doing its job.
<!-- <<< teamentic: managed <<< -->

<!-- Your project overlay below - yours; update never touches it. -->
## Project notes
