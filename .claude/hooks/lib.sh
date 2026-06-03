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

# Project extension point: source hooks/local.d/*.sh LAST, so a project can override
# the resolver/defaults or add helpers WITHOUT editing this (refreshed) file.
for _f in "$ROOT"/.claude/hooks/local.d/*.sh; do [ -f "$_f" ] && . "$_f"; done
