#!/usr/bin/env bash
# session-green-check.sh — SessionStart hook.
# Warns (does NOT block) when the baseline suite is RED at session start. A red
# floor makes every new failing test look like progress, so the loop should not
# start on a broken baseline. Set SESSION_BASELINE_CHECK=0 to disable, or point
# BASELINE_CMD at a fast smoke subset for large suites.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"

# Worktree bus check: parallel git worktrees but an unshared tic bus -> fragmented coordination.
if [ -z "${TICS_DIR:-}" ] && [ "${TIC_STORE:-jsonl}" != "spool" ]; then
  _wt=$(cd "$ROOT" 2>/dev/null && git worktree list 2>/dev/null | wc -l | tr -d ' ')
  if [ "${_wt:-0}" -gt 1 ]; then
    echo "NOTE: $_wt git worktrees but the tic bus is not shared — each writes its own .claude/state, so claims/needs can't correlate across them. Share one bus: set TIC_STORE=spool + TICS_DIR in .claude/tdd.config (see the 'Parallel worktrees' block). See docs/tdd/sectioning.md."
  fi
fi

[ "${SESSION_BASELINE_CHECK:-1}" = "1" ] || exit 0
CMD="${BASELINE_CMD:-$ALL_TEST_CMD}"

OUT="$(cd "$ROOT" && eval "$CMD" 2>&1)"; CODE=$?
if [ "$CODE" -ne 0 ]; then
  echo "BASELINE RED at session start (\`$CMD\` exited $CODE)."
  echo "Fix the baseline to green BEFORE starting new TDD cycles — on a red floor,"
  echo "every new red looks like progress. If this is a fresh clone, install deps"
  echo "and re-run the suite first. Last lines:"
  printf '%s\n' "$OUT" | tail -n "${TAIL_LINES:-40}"
fi
exit 0
