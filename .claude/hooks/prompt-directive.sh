#!/usr/bin/env bash
# prompt-directive.sh — UserPromptSubmit hook (ADR 0005, amended). OPT-IN proactive reinforcement:
# OFF by default; enable with PROMPT_DIRECTIVE=1. When enabled, injects the full-framework operating
# directive every prompt so usage stays salient turn-over-turn (gvp: obeyed 0/2 with SessionStart only).
# The DEFAULT accountability is the reactive solo-drift backstop (solo-drift-check.sh, ADR 0006).
# Auto-silent in CI even when enabled. REFRESHED on update; do NOT edit (local tweaks -> hooks/local.d/).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/.claude/tdd.config" ] && . "$ROOT/.claude/tdd.config"
[ "${PROMPT_DIRECTIVE:-0}" = "1" ] || exit 0
[ -n "${CI:-}" ] && exit 0   # context-aware: no every-prompt injection in CI / automated / non-interactive runs

printf '%s\n' "[team-tactics] Operate the FULL framework by default, scaled to the task (don't ceremony trivial asks — but reach for the team, not a solo edit, when the work is real):"
if [ -f "$ROOT/.claude/agents/product-owner.md" ]; then
  printf '%s\n' "- Outer loop: product-owner selects/accepts vs the brief, architect owns the §seams + ADRs, qa-verifier drives the running app, project-manager + dev-ops cut the release."
fi
printf '%s\n' "- Inner loop: set phase+layer, then delegate red->test-writer / green->implementer; tdd-critic every few cycles. The gate is the referee; the suite decides done, not you."
printf '%s\n' "- Coordinate through the tic bus (delegate/handoff/claim/need/contract). Parallel work? One git worktree per track on the shared spool bus (ADR 0015) — claim/need keep peers disjoint; don't work blind or double up."
exit 0
