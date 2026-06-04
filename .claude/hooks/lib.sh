#!/usr/bin/env bash
# lib.sh — shared MECHANISM for the TDD pairing hooks. REFRESHED on every update;
# do NOT edit. Your settings live in .claude/tdd.config (DATA only).
# Sourced by guard-edit-scope / run-suite / session-green-check: loads your config
# data, applies mechanism defaults, then defines resolve_layer LAST — so the resolver
# is always the current kit version, even if an older tdd.config still inlines one.
_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${ROOT:=$(cd "$_lib_dir/../.." && pwd)}"

# 1) Project DATA (layers, commands, globs, knobs).
# shellcheck disable=SC1091
[ -f "$ROOT/.claude/tdd.config" ] && . "$ROOT/.claude/tdd.config"

# 2) Mechanism defaults (only if the config didn't set them).
: "${DEFAULT_TEST_GLOB:=(\.test\.|\.spec\.|(^|/)tests?/|(^|/)__tests__/)}"
: "${DEFAULT_SRC_GLOB:=(^|/)src/}"
: "${ALL_TEST_CMD:=npm test}"
: "${TAIL_LINES:=40}"
: "${TELEMETRY:=1}"
: "${TICS:=1}"
: "${SESSION_BASELINE_CHECK:=1}"
: "${BASELINE_CMD:=$ALL_TEST_CMD}"

# 3) Resolver (bash 3.2 safe). Defined LAST -> always the current kit version.
# Per layer L: TEST_CMD_<L> -> pre-0.4 legacy alias (BE_/FE_/E2E_) -> ALL_TEST_CMD.
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

# 4) Tic protocol — append one structured agent-to-agent communication unit (a "tic") to
# .claude/state/tics.jsonl. Hooks emit signal/block; agents emit delegate/handoff/verdict/msg
# via .claude/hooks/tic.sh. Append-only + JSON-escaped; a logging failure never breaks a hook.
#   emit_tic FROM TO KIND MSG [REF] [RESULT] [EXTRA_JSON]
_tic_esc() { printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
emit_tic() {
  [ "${TICS:-1}" = "1" ] || return 0
  _tf="${TICS_FILE:-$ROOT/.claude/state/tics.jsonl}"
  mkdir -p "$(dirname "$_tf")" 2>/dev/null || true
  _seq=1; [ -f "$_tf" ] && _seq=$(( $(wc -l < "$_tf" 2>/dev/null) + 1 ))
  _ph="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
  _ly="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
  printf '{"ts":"%s","seq":%s,"kind":"%s","from":"%s","to":"%s","phase":"%s","layer":"%s","msg":"%s","ref":"%s","result":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_seq" \
    "$(_tic_esc "${3:-note}")" "$(_tic_esc "${1:-?}")" "$(_tic_esc "${2:-*}")" \
    "$(_tic_esc "$_ph")" "$(_tic_esc "$_ly")" \
    "$(_tic_esc "${4:-}")" "$(_tic_esc "${5:-}")" "$(_tic_esc "${6:-}")" "${7:-}" \
    >> "$_tf" 2>/dev/null || true
}

# Project extension point: source hooks/local.d/*.sh LAST, so a project can override
# the resolver/defaults or add helpers WITHOUT editing this (refreshed) file.
for _f in "$ROOT"/.claude/hooks/local.d/*.sh; do [ -f "$_f" ] && . "$_f"; done
