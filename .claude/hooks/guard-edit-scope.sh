#!/usr/bin/env bash
# guard-edit-scope.sh — PreToolUse (matcher: Edit|Write|MultiEdit)
# Enforces the TDD contract by phase x layer. The orchestrator writes
# .claude/state/{phase,layer} before each delegation.
#   red      -> only the active layer's TEST files may be edited
#   green    -> the active layer's TEST files may NOT be edited (source only)
#   refactor -> anything; the Stop hook keeps the bar green
# Exit 2 blocks the tool and returns the stderr message to the model; a 'block' tic
# is recorded so the refusal appears in the agent-to-agent thread.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"

PHASE="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
LAYER="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
resolve_layer "$LAYER"

INPUT="$(cat)"
if command -v jq >/dev/null 2>&1; then
  P="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')"
else
  P="$(printf '%s' "$INPUT" | grep -oE '"(file_)?path"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
fi
[ -z "${P:-}" ] && exit 0

is_test() { printf '%s' "$1" | grep -qE "$TEST_GLOB"; }
# Docs/ADRs aren't code-under-test — there's no failing test to write first, so the phase gate
# must not block them (esp. in red). Markdown anywhere, or anything under a docs/ tree.
is_doc() { printf '%s' "$1" | grep -qE '\.(md|mdx|markdown)$|(^|/)docs/'; }
# An ADR (architecture decision record) is a published seam — see auto-contract below.
is_adr() { printf '%s' "$1" | grep -qE '(^|/)docs/decisions/'; }

# P1: enforced claims — block an edit to a path held by ANOTHER scope, and AUTO-CLAIM a
# still-unclaimed path for the editing scope, so disjoint-write fan-out is collision-safe
# with zero manual bookkeeping (the first toucher owns it; rivals are then blocked).
claim_guard() {
  [ "${CLAIMS_ENFORCE:-1}" = "1" ] || return 0
  [ -x "$ROOT/.claude/hooks/tics" ] || return 0          # no reader -> fail-open
  _ms="$(cat "$ROOT/.claude/state/scope" 2>/dev/null)"
  [ -n "$_ms" ] || return 0                               # unscoped editor -> not partitioned, no enforcement
  _hold="$("$ROOT/.claude/hooks/tics" claim-check "$1" "$_ms" 2>/dev/null)"; _rc=$?
  if [ "$_rc" = "3" ]; then                              # genuine cross-scope conflict -> block
    echo "BLOCKED (claim): $1 is held by $_hold. Release it, coordinate via a need tic, or set CLAIMS_ENFORCE=0 to disarm." >&2
    emit_tic guard "*" need "claim conflict on $1 (held by: $_hold)" "$1" blocked
    exit 2
  fi
  # No conflict. Auto-open the section (scope's first component) on first scoped activity,
  # so the partition map (`tics sections`) populates itself — once, never re-opened.
  _sec="${_ms%%/*}"
  _sst="$("$ROOT/.claude/hooks/tics" section-status "$_sec" 2>/dev/null)"
  [ -n "$_sst" ] || emit_tic guard "*" section "auto-open on first edit" "$_sec" open
  # Auto-claim only if still unclaimed — skip if already held (by us) so we
  # don't re-claim on every edit and spam the bus (the telemetry must stay meaningful).
  _own="$("$ROOT/.claude/hooks/tics" claim-owner "$1" 2>/dev/null)"
  [ -n "$_own" ] || emit_tic guard "*" claim "auto-claim on edit" "$1" ""
  return 0
}

# Docs/ADRs are never code-under-test, so the TDD phase gate must not block them in ANY phase
# (red especially — there's no failing test to write first). Claims still apply (parallel doc
# edits can collide). This is the single source of the docs exemption.
if is_doc "$P"; then
  # An ADR is a published seam: auto-emit a `contract` when one is first CREATED (the file doesn't
  # exist yet), so the coupling view reflects decisions even in solo/serial work — no scope or
  # parallelism needed. Once only — a later edit of an existing ADR doesn't re-publish.
  if is_adr "$P" && ! { [ -f "$P" ] || [ -f "$ROOT/$P" ]; }; then
    emit_tic architect "*" contract "ADR: $(basename "$P")" "$P"
  fi
  claim_guard "$P"; exit 0
fi

case "$PHASE" in
  red)
    if is_test "$P"; then claim_guard "$P"; exit 0; fi
    echo "BLOCKED (phase=red, layer=$LAYER): only $LAYER TEST files may be edited now, not $P. Write the failing test; the implementer makes it pass next." >&2
    emit_tic guard orchestrator block "phase=red layer=$LAYER: source edit refused ($P) — write the failing test first" "$P" blocked
    exit 2 ;;
  green)
    if is_test "$P"; then
      echo "BLOCKED (phase=green, layer=$LAYER): tests are frozen. Do NOT edit $P. Change source to satisfy the existing test. Never weaken a test to reach green." >&2
      emit_tic guard orchestrator block "phase=green layer=$LAYER: test edit refused ($P) — tests are frozen" "$P" blocked
      exit 2
    fi
    claim_guard "$P"; exit 0 ;;
  refactor)
    # refactor: anything in the layer; claims still enforced (Stop hook keeps the bar green).
    claim_guard "$P"; exit 0 ;;
  off)
    # off: gate disarmed for manual / non-TDD edits (claims not enforced).
    exit 0 ;;
  *)
    # Fail-closed: empty, typo'd, or corrupted phase. We do NOT silently allow,
    # because a missing phase is exactly how the gate would be bypassed.
    echo "BLOCKED: phase='$PHASE' is not recognized, so the TDD gate is failing closed. Set .claude/state/phase to one of: red | green | refactor (during a cycle), or 'off' to disarm for manual edits." >&2
    emit_tic guard orchestrator block "phase='$PHASE' unrecognized — gate fail-closed ($P)" "$P" blocked
    exit 2 ;;
esac
