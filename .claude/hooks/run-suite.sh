#!/usr/bin/env bash
# run-suite.sh — PostToolUse (matcher: Edit|Write|MultiEdit)
# The arbiter. Runs the ACTIVE LAYER's suite after an edit, records green/red, surfaces
# the result, and emits one SIGNAL tic per run (.claude/state/tics.jsonl) so the PROCESS
# can be measured (cycles, retries, durations, per-layer pass rates).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"
mkdir -p "$ROOT/.claude/state"
STATUS="$ROOT/.claude/state/suite-status"
LAYER="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
PHASE="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
resolve_layer "$LAYER"

# P2-10: skip the suite for an edit that matches no layer glob — a README/config/doc edit
# must not trigger a test run. Empty stdin (manual invocation) yields no path, so it runs.
INPUT="$(cat)"
if command -v jq >/dev/null 2>&1; then
  EDITED="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
else
  EDITED="$(printf '%s' "$INPUT" | grep -oE '"(file_)?path"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
fi
if [ -n "${EDITED:-}" ] && ! printf '%s' "$EDITED" | grep -qE "$TEST_GLOB" && ! printf '%s' "$EDITED" | grep -qE "$SRC_GLOB"; then
  exit 0
fi

START="$(date +%s)"
OUT="$(cd "$ROOT" && eval "$TEST_CMD" 2>&1)"; CODE=$?
DUR=$(( $(date +%s) - START ))

if [ "$CODE" -eq 0 ]; then
  echo "green" > "$STATUS"; RESULT="green"
  echo "[OK] [$LAYER] SUITE GREEN — all tests pass."
else
  echo "red" > "$STATUS"; RESULT="red"
  echo "[X] [$LAYER] SUITE RED (exit $CODE). Last ${TAIL_LINES:-40} lines:"
  printf '%s\n' "$OUT" | tail -n "${TAIL_LINES:-40}"
fi

# Tic: record the suite SIGNAL (subsumes the old telemetry event) — one per run, hook-emitted
# (agents cannot forge a signal). 'tics report' aggregates these; 'tics log' shows the thread.
emit_tic run-suite "*" signal "[$LAYER] suite $RESULT" "${EDITED:-}" "$RESULT" ",\"exit\":$CODE,\"durationSec\":$DUR"
exit 0
