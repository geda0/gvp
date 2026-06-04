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
  delegate|handoff|signal|block|verdict|msg|note|claim|release|contract|need)
    emit_tic "$@" ;;
  log|inbox|conductor|claims|sections|report|-*)
    echo "tic.sh EMITS tics; it does not read them. To READ, run the reader: .claude/hooks/tics <log | inbox <role> | conductor | claims | sections> [--scope <scope>]. Nothing recorded." >&2
    exit 2 ;;
  *)
    echo "tic.sh: '${3:-}' is not a tic kind. Valid: delegate handoff signal block verdict msg note claim release contract need. Nothing recorded. Usage: tic.sh FROM TO KIND MSG [REF] [RESULT]" >&2
    exit 2 ;;
esac
