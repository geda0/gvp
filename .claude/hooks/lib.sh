#!/usr/bin/env bash
# lib.sh — shared MECHANISM for the TDD pairing hooks. REFRESHED on every update; do NOT edit.
# Your settings live in .claude/tdd.config (DATA only).
_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${ROOT:=$(cd "$_lib_dir/../.." && pwd)}"

# 1) Project DATA.
# shellcheck disable=SC1091
[ -f "$ROOT/.claude/tdd.config" ] && . "$ROOT/.claude/tdd.config"

# 2) Mechanism defaults.
: "${DEFAULT_TEST_GLOB:=(\.test\.|\.spec\.|(^|/)tests?/|(^|/)__tests__/)}"
: "${DEFAULT_SRC_GLOB:=(^|/)src/}"
: "${ALL_TEST_CMD:=npm test}"
: "${TAIL_LINES:=40}"
: "${TELEMETRY:=1}"
: "${TICS:=1}"
: "${TIC_STORE:=jsonl}"
: "${SESSION_BASELINE_CHECK:=1}"
: "${BASELINE_CMD:=$ALL_TEST_CMD}"

# 3) Resolver (bash 3.2 safe). Defined LAST.
resolve_layer() {
  _l="$1"
  eval "TEST_CMD=\"\${TEST_CMD_${_l}:-}\""
  eval "TEST_GLOB=\"\${TEST_GLOB_${_l}:-}\""
  eval "SRC_GLOB=\"\${SRC_GLOB_${_l}:-}\""
  if [ -z "$TEST_CMD" ]; then
    case "$_l" in
      backend)  TEST_CMD="${BE_TEST_CMD:-}" ;;
      frontend) TEST_CMD="${FE_TEST_CMD:-}" ;;
      e2e)      TEST_CMD="${E2E_TEST_CMD:-}" ;;
    esac
  fi
  [ -n "$TEST_CMD" ]  || TEST_CMD="$ALL_TEST_CMD"
  [ -n "$TEST_GLOB" ] || TEST_GLOB="$DEFAULT_TEST_GLOB"
  [ -n "$SRC_GLOB" ]  || SRC_GLOB="$DEFAULT_SRC_GLOB"
}

# 4) Tic protocol — append one structured agent-to-agent communication unit to the tic store.
# Default store = .claude/state/tics.jsonl (append). TIC_STORE=spool writes one file per tic to
# .claude/state/tics.d/ — concurrency-safe for PARALLEL writers. `scope` is ambient: explicit
# .claude/state/scope wins, else it defaults to the active LAYER (so tics auto-scope per layer
# with zero effort), else "*".  Set TICS_DIR to share one spool across git worktrees (parallel
# sections -> one bus); TICS_FILE overrides the jsonl path.  emit_tic FROM TO KIND MSG [REF] [RESULT] [EXTRA_JSON]
_tic_esc() { printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
emit_tic() {
  [ "${TICS:-1}" = "1" ] || return 0
  _tf="${TICS_FILE:-$ROOT/.claude/state/tics.jsonl}"
  _td="${TICS_DIR:-$ROOT/.claude/state/tics.d}"
  mkdir -p "$ROOT/.claude/state" 2>/dev/null || true
  _seq=$(( $({ cat "$_tf" 2>/dev/null; cat "$_td"/*.json 2>/dev/null; } | wc -l) + 1 ))
  _ph="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
  _ly="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
  _sc="$(cat "$ROOT/.claude/state/scope" 2>/dev/null)"
  if [ -z "$_sc" ]; then
    if [ -n "$_ly" ] && [ "$_ly" != "unknown" ]; then _sc="$_ly"; else _sc="*"; fi
  fi
  if [ "${TIC_STORE:-jsonl}" = "spool" ]; then
    mkdir -p "$_td" 2>/dev/null || true
    _out="$_td/$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM:-0}.json"
  else
    _out="$_tf"
  fi
  printf '{"ts":"%s","seq":%s,"kind":"%s","from":"%s","to":"%s","phase":"%s","layer":"%s","scope":"%s","msg":"%s","ref":"%s","result":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_seq" \
    "$(_tic_esc "${3:-note}")" "$(_tic_esc "${1:-?}")" "$(_tic_esc "${2:-*}")" \
    "$(_tic_esc "$_ph")" "$(_tic_esc "$_ly")" "$(_tic_esc "$_sc")" \
    "$(_tic_esc "${4:-}")" "$(_tic_esc "${5:-}")" "$(_tic_esc "${6:-}")" "${7:-}" \
    >> "$_out" 2>/dev/null || true
}

# Project extension point.
for _f in "$ROOT"/.claude/hooks/local.d/*.sh; do [ -f "$_f" ] && . "$_f"; done
