#!/usr/bin/env bash
# tic.sh — EMIT one tic. Not a wired hook; call from Bash:
#   .claude/hooks/tic.sh FROM TO KIND MSG [REF] [RESULT]
# To READ tics, use the reader: .claude/hooks/tics inbox <role> [--scope <s>]  (or log/conductor/claims)
# Kinds: delegate handoff signal block verdict msg note claim release contract need.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"
case "${3:-}" in
  delegate|handoff|signal|block|verdict|msg|note|claim|release|contract|need|"")
    emit_tic "$@" ;;
  log|inbox|conductor|claims|report|-*)
    echo "tic.sh EMITS tics; it does not read them. To READ, run: .claude/hooks/tics ${3} ... (e.g. .claude/hooks/tics inbox <role> --scope <scope>). Nothing recorded." >&2 ;;
  *)
    echo "tic.sh: warning — unknown kind '${3}' (known: delegate handoff signal block verdict msg note claim release contract need). Recording anyway. Usage: tic.sh FROM TO KIND MSG [REF] [RESULT]" >&2
    emit_tic "$@" ;;
esac
