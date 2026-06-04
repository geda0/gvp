#!/usr/bin/env bash
# tic.sh — emit ONE tic (agent-to-agent communication unit). Not a wired hook; call from Bash:
#   .claude/hooks/tic.sh FROM TO KIND MSG [REF] [RESULT]
# e.g.  .claude/hooks/tic.sh orchestrator test-writer delegate "slice S2: audio-only frame" S2
#       .claude/hooks/tic.sh navigator architect msg "use option B for the seam"
# Read your inbox with:  tics inbox <role>   (or: tics log)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/.claude/hooks/lib.sh"
emit_tic "$@"
