#!/usr/bin/env bash
# tics-lib.sh — the TIC PROTOCOL mechanism (emit_tic + the store). Method-agnostic coordination
# substrate; sourced by tic.sh and by tdd-pairing's lib.sh. REFRESHED on update; do NOT edit.
_tics_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${ROOT:=$(cd "$_tics_lib_dir/../.." && pwd)}"
# shellcheck disable=SC1091
[ -f "$ROOT/.claude/tdd.config" ] && . "$ROOT/.claude/tdd.config"
: "${TICS:=1}"
: "${TIC_STORE:=jsonl}"
# Append one structured agent-to-agent communication unit. Store = .claude/state/tics.jsonl
# (append) or, with TIC_STORE=spool, one file per tic under .claude/state/tics.d/ (concurrency-safe).
# scope is ambient: TICS_SCOPE (per-call, for fan-out) else .claude/state/scope, else the active
# LAYER, else "*". TICS_DIR shares one spool across worktrees; TICS_FILE overrides the jsonl path.
# emit_tic FROM TO KIND MSG [REF] [RESULT] [EXTRA_JSON]
_tic_esc() { printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
emit_tic() {
  [ "${TICS:-1}" = "1" ] || return 0
  _tf="${TICS_FILE:-$ROOT/.claude/state/tics.jsonl}"
  _td="${TICS_DIR:-$ROOT/.claude/state/tics.d}"
  mkdir -p "$ROOT/.claude/state" 2>/dev/null || true
  # ADR 0026: hook-identity telemetry stays local (jsonl), never touching the git bus.
  _ts="${TIC_STORE:-jsonl}"
  case "$1" in subagent|run-suite|guard|witness) [ "$_ts" = "git" ] && _ts=jsonl ;; esac
  [ "$_ts" = "git" ] && { _tic_git_open; _td="$_gd/tics.d"; }
  _seq=$(( $({ cat "$_tf" 2>/dev/null; cat "$_td"/*.json 2>/dev/null; } | wc -l) + 1 ))
  _ph="$(cat "$ROOT/.claude/state/phase" 2>/dev/null || echo unknown)"
  _ly="$(cat "$ROOT/.claude/state/layer" 2>/dev/null || echo unknown)"
  _sc="${TICS_SCOPE:-$(cat "$ROOT/.claude/state/scope" 2>/dev/null)}"
  if [ -z "$_sc" ]; then
    if [ -n "$_ly" ] && [ "$_ly" != "unknown" ]; then _sc="$_ly"; else _sc="*"; fi
  fi
  # session identity (ADR 0002): which session emitted this tic — TICS_SESSION (per-process) else
  # .claude/state/session, else empty. Lets claims/commits tell which LIVE session owns what.
  _se="${TICS_SESSION:-$(cat "$ROOT/.claude/state/session" 2>/dev/null)}"
  _tic_line="$(printf '{"ts":"%s","seq":%s,"kind":"%s","from":"%s","to":"%s","phase":"%s","layer":"%s","scope":"%s","session":"%s","msg":"%s","ref":"%s","result":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_seq" \
    "$(_tic_esc "${3:-note}")" "$(_tic_esc "${1:-?}")" "$(_tic_esc "${2:-*}")" \
    "$(_tic_esc "$_ph")" "$(_tic_esc "$_ly")" "$(_tic_esc "$_sc")" "$(_tic_esc "$_se")" \
    "$(_tic_esc "${4:-}")" "$(_tic_esc "${5:-}")" "$(_tic_esc "${6:-}")" "${7:-}")"
  if [ "$_ts" = "git" ] || [ "$_ts" = "spool" ]; then
    mkdir -p "$_td" 2>/dev/null || true
    _TIC_N=$(( ${_TIC_N:-0} + 1 ))
    _stamp="$(date -u +%Y%m%dT%H%M%SZ)"; _org="${_se:-$(hostname -s 2>/dev/null || echo host)}"
    _try=0
    while :; do
      _out="$_td/$_stamp-$_org-$$-$(printf '%04d' "$_TIC_N")-${RANDOM:-0}.json"
      ( set -C; printf '%s\n' "$_tic_line" > "$_out" ) 2>/dev/null && break
      [ -e "$_out" ] || break
      _try=$(( _try + 1 )); [ "$_try" -ge 32 ] && break
      _TIC_N=$(( _TIC_N + 1 ))
    done
  else
    _out="$_tf"
    printf '%s\n' "$_tic_line" >> "$_out" 2>/dev/null || true
  fi
  [ "$_ts" = "git" ] && _tic_git_publish "$_out"
  return 0
}

# TIC_STORE=git (ADR 0026): the bus is a branch (TICS_BRANCH, default tics-bus) of TICS_REMOTE, checked out in
# TICS_GIT_DIR (default .claude/state/tics.git), never the project's own tree. Each tic is one NEW spool file, so
# commits from different hosts touch disjoint paths: a rebase cannot conflict and a retried push loses nothing.
_tic_git() { env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX -u GIT_COMMON_DIR \
  git -C "$_gd" -c user.name=tics -c user.email=tics@localhost "$@"; }
# A record-less legacy checkout adopts its current origin as the remote it was created for (idempotent).
_tic_git_record() {
  [ -e "$_gd/.git/tics-remote" ] || _tic_git remote get-url origin > "$_gd/.git/tics-remote" 2>/dev/null
}
_tic_git_open() {
  _gd="${TICS_GIT_DIR:-$ROOT/.claude/state/tics.git}"; _gb="${TICS_BRANCH:-tics-bus}"
  if [ -d "$_gd/.git" ]; then   # a legacy checkout with no record adopts its current origin
    _tic_git_record
    return 0
  fi
  mkdir -p "$_gd" 2>/dev/null || true
  _tic_git init -q 2>/dev/null
  _tic_git_hide
  _tic_git remote add origin "${TICS_REMOTE:-}" 2>/dev/null
  printf '%s\n' "${TICS_REMOTE:-}" > "$_gd/.git/tics-remote" 2>/dev/null
  # P3 local first: no fetch here. The tic is committed before any network call; a remote bus branch is
  # integrated by the push's non-fast-forward retry (rebase), and the reader unions the tracking tree.
  _tic_git checkout -q --orphan "$_gb" 2>/dev/null
}
# P5: when the bus checkout sits inside the project's own git tree, list it in the project's info/exclude
# (never a tracked .gitignore), so emits leave the project's status and HEAD untouched.
_tic_git_hide() {
  case "$_gd" in "$ROOT"/*) ;; *) return 0 ;; esac
  _tic_git_proj() { env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX -u GIT_COMMON_DIR git -C "$ROOT" "$@"; }
  _pp="$(_tic_git_proj rev-parse --show-prefix 2>/dev/null)" || return 0
  _ex="$(_tic_git_proj rev-parse --git-path info/exclude 2>/dev/null)" || return 0
  case "$_ex" in /*) ;; *) _ex="$ROOT/$_ex" ;; esac
  _rel="/$_pp${_gd#"$ROOT"/}/"
  mkdir -p "$(dirname "$_ex")" 2>/dev/null || true
  grep -qxF "$_rel" "$_ex" 2>/dev/null || printf '%s\n' "$_rel" >> "$_ex" 2>/dev/null || true
  _old="${_rel%/}.old-*/"   # the checkout `tics rebind` keeps aside
  grep -qxF "$_old" "$_ex" 2>/dev/null || printf '%s\n' "$_old" >> "$_ex" 2>/dev/null || true
}
# Commit the new tic file, then publish it (P3: bounded, never hangs, never drops the tic). Emits sharing one
# checkout serialize their LOCAL steps (add, commit; the rebase after a rejected push) on a short per-checkout lock
# that is never held across the push itself. Each stages ALL of tics.d, so a file left uncommitted by an earlier
# emit (lock not had in time, or a failed commit) rides with this one or with the next `tics sync`.
_tic_git_publish() {
  _tic_git_lock || return 0
  _tic_git add -A -- tics.d 2>/dev/null
  if _tic_git diff --cached --quiet 2>/dev/null || ! _tic_git commit -q -m "tic" 2>/dev/null; then
    _tic_git_unlock; return 0   # nothing new: a concurrent emit already committed (and publishes) this file
  fi
  _tic_git_unlock
  _tic_git_moved && return 0   # ADR 0026: a moved bus is not a network failure; keep the commit, push nothing
  _tic_net_backoff || _tic_git_push || true
  return 0
}
# True when the configured TICS_REMOTE differs from the remote the checkout was created for (the record in
# .git/tics-remote; one trailing "/" trimmed, no other normalization). A deliberate `git remote set-url` is an
# operator act, not a mismatch. A record-less legacy checkout adopts its current origin. `tics rebind` moves it.
_tic_git_moved() {
  _tic_git_record
  _mr="$(cat "$_gd/.git/tics-remote" 2>/dev/null)"
  _cr="${TICS_REMOTE:-}"
  [ "${_mr%/}" != "${_cr%/}" ]
}
# Portable per-checkout mutex (macOS has no flock(1)): mkdir is atomic. The holder's pid is recorded; a lock is
# stale when that pid is dead OR the lock is older than 2 x TICS_NET_TIMEOUT (no holder keeps it longer). Only a
# waiter holding the reclaim mutex (<lock>.reclaim, itself mkdir) may break the lock, and only after RE-CHECKING,
# under that mutex, that it is still stale: so no waiter ever removes a fresh lock another waiter just took. The
# reclaim mutex is held for microseconds; one older than 3 s is a crashed reclaimer's and is removed.
# Waits at most TICS_LOCK_WAIT seconds (default 3 x TICS_NET_TIMEOUT).
_tic_git_lock() {
  _lk="$_gd/.git/tics-emit.lock"; _lr="$_lk.reclaim"
  _lw=$(( ${TICS_LOCK_WAIT:-$(( 3 * ${TICS_NET_TIMEOUT:-5} ))} * 20 ))
  while ! mkdir "$_lk" 2>/dev/null; do
    if _tic_git_lock_stale; then
      if mkdir "$_lr" 2>/dev/null; then
        _tic_git_lock_stale && rm -rf "$_lk" 2>/dev/null   # re-read pid and age under the reclaim mutex
        rmdir "$_lr" 2>/dev/null
        continue
      fi
      _tic_age_over "$_lr" 3 && rmdir "$_lr" 2>/dev/null
    fi
    _lw=$((_lw - 1)); [ "$_lw" -gt 0 ] || return 1
    sleep 0.05
  done
  echo "$$" > "$_lk/pid" 2>/dev/null
  return 0
}
# True when the lock at $_lk is stale: its recorded pid is dead, or its age exceeds 2 x TICS_NET_TIMEOUT.
_tic_git_lock_stale() {
  _lp="$(cat "$_lk/pid" 2>/dev/null)"
  [ -n "$_lp" ] && ! kill -0 "$_lp" 2>/dev/null && return 0
  _tic_age_over "$_lk" $(( 2 * ${TICS_NET_TIMEOUT:-5} ))
}
# True when PATH exists and its mtime is more than SECONDS ago (GNU stat, else BSD/macOS stat).
_tic_age_over() {
  _lm="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)"
  case "$_lm" in '' | *[!0-9]*) return 1 ;; esac
  [ $(( $(date +%s) - _lm )) -gt "$2" ]
}
# Release the lock only if this process still holds it (a lock broken as stale may now be another emit's).
_tic_git_unlock() {
  [ "$(cat "$_gd/.git/tics-emit.lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$_gd/.git/tics-emit.lock" 2>/dev/null
  return 0
}
# Push HEAD to the bus branch, unlocked. Only a non-fast-forward rejection is retried (fetch + rebase under the
# lock, then push again unlocked; bounded by TICS_PUSH_TRIES, jittered); a failed rebase is always aborted. A
# timeout or network error is not retried, and records the failure (attempt stamp + fail marker) so emits and
# reads inside TICS_FETCH_TTL skip the network. Unpublished tics stay committed locally and ride out with the
# next push or `tics sync`. Returns 0 when published.
_tic_git_push() {
  _n=0
  while :; do
    _tic_net push origin "HEAD:refs/heads/$_gb"; _rc=$?
    [ "$_rc" -eq 0 ] && { _tic_net_ok; return 0; }
    [ "$_rc" -eq 2 ] || { _tic_net_fail; return 1; }
    _n=$((_n + 1)); [ "$_n" -ge "${TICS_PUSH_TRIES:-8}" ] && return 1
    _tic_git_lock || return 1
    if ! _tic_net fetch -q origin "$_gb"; then _tic_git_unlock; _tic_net_fail; return 1; fi
    _tic_git rebase -q FETCH_HEAD >/dev/null 2>&1 || _tic_git_rebase_abort
    _tic_git_unlock
    sleep "0.$(( (RANDOM % 4) + 1 ))"
  done
}
# Abort a failed rebase. The rebase runs only under the lock, but should a lock ever be double-held (broken as
# stale while its holder still ran), `rebase --abort` resets to ORIG_HEAD and would delete a tic another process
# committed meanwhile. So before aborting, note the in-rebase HEAD; afterwards, put back from the object store every
# tics.d file it has that is missing from the worktree and not on the remote. It is left for the next emit or
# `tics sync` to stage and commit (self-healing staging).
_tic_git_rebase_abort() {
  _rh="$(_tic_git rev-parse -q --verify HEAD 2>/dev/null)"
  _tic_git rebase --abort >/dev/null 2>&1
  [ -n "$_rh" ] || return 0
  _tic_git ls-tree -r --name-only "$_rh" -- tics.d 2>/dev/null | while IFS= read -r _rf; do
    [ -e "$_gd/$_rf" ] && continue
    _tic_git cat-file -e "FETCH_HEAD:$_rf" 2>/dev/null && continue
    _tic_git show "$_rh:$_rf" > "$_gd/$_rf" 2>/dev/null || rm -f "$_gd/$_rf" 2>/dev/null
  done
  return 0
}
# Run one networked git command under a watchdog: TICS_NET_TIMEOUT seconds (default 5), pure bash (macOS has no
# timeout(1)). git and the sleeper each run in their own process group (set -m), so expiry kills git with its
# ssh/helper children, and a git that finishes first takes the sleeper down with it. Nothing is left running.
# Returns 0 ok, 2 rejected (non-fast-forward or a lost ref race), 1 timeout or any other failure.
_tic_net() {
  _ne="$_gd/.git/tics-net.$$.err"; _om=; case $- in *m*) _om=1 ;; esac
  {
    set -m
    GIT_TERMINAL_PROMPT=0 _tic_git "$@" >/dev/null 2>"$_ne" </dev/null & _np=$!
    ( sleep "${TICS_NET_TIMEOUT:-5}"; kill -KILL -- -"$_np" ) </dev/null >/dev/null 2>&1 & _wp=$!
    wait "$_np"; _nrc=$?
    kill -KILL -- -"$_wp"; wait "$_wp"
    [ -n "$_om" ] || set +m
  } 2>/dev/null
  _nrc2=1
  # a lost race on the remote ref (another emitter updated it mid-push) is a rejection too, not a network error
  if [ "$_nrc" -eq 0 ]; then _nrc2=0
  elif grep -qE '\[rejected\]|non-fast-forward|fetch first|cannot lock ref|failed to update ref' "$_ne" 2>/dev/null; then _nrc2=2
  elif grep -qE "couldn't find remote ref" "$_ne" 2>/dev/null; then _nrc2=3   # reachable, no bus branch yet
  fi
  rm -f "$_ne" 2>/dev/null
  return "$_nrc2"
}
# The reader's fetch (tics-view.cjs, ADR 0026): refresh origin/<branch> in the bus at BUS_DIR under the same
# watchdog as the writer, so a hanging transport helper is killed with git. tics_fetch BUS_DIR BRANCH; returns
# _tic_net's code. It keeps the one shared failure record (rule 4): a failed fetch marks it, so emits inside the
# TTL skip the network too (the reader keeps its own attempt stamp); a successful one clears it. A reachable remote with no bus branch yet clears the
# fail marker but never sets the success stamp.
tics_fetch() {
  _gd="$1"; _gb="$2"
  _tic_net -c gc.auto=0 -c maintenance.auto=false fetch -q origin "+$_gb:refs/remotes/origin/$_gb"; _frc=$?
  case "$_frc" in
    0) _tic_net_ok ;;
    3) rm -f "$_gd/.git/tics-net-failed" 2>/dev/null ;;
    *) _tic_net_mark ;;   # the reader already wrote its own attempt stamp
  esac
  return "$_frc"
}
# The network-failure record, shared with the reader (tics-view.cjs gitStore): the attempt stamp drives the
# reader's fetch TTL; the fail marker (epoch seconds) tells emits the last attempt failed.
_tic_net_fail() {
  date -u +%Y-%m-%dT%H:%M:%SZ > "$_gd/.git/tics-fetch-attempt" 2>/dev/null
  _tic_net_mark
}
_tic_net_mark() { date +%s > "$_gd/.git/tics-net-failed" 2>/dev/null; return 0; }
# A successful push leaves origin/<branch> equal to what was pushed, so it also refreshes the success stamp.
_tic_net_ok() {
  rm -f "$_gd/.git/tics-net-failed" 2>/dev/null
  date -u +%Y-%m-%dT%H:%M:%SZ > "$_gd/.git/tics-fetch-stamp" 2>/dev/null
  return 0
}
# True (skip the network) when the last attempt failed less than TICS_FETCH_TTL seconds ago (default 60).
_tic_net_backoff() {
  _nf="$(cat "$_gd/.git/tics-net-failed" 2>/dev/null)"
  case "$_nf" in '' | *[!0-9]*) return 1 ;; esac
  [ $(( $(date +%s) - _nf )) -lt "${TICS_FETCH_TTL:-60}" ]
}
# `tics sync` (ADR 0026 P3): publish every unpushed local tic, ignoring the TTL (an explicit request), then
# refresh the remote-tracking ref for the reader. Idempotent; always returns 0.
tics_sync() {
  [ "${TIC_STORE:-jsonl}" = "git" ] || { echo "tics sync: TIC_STORE is not git; nothing to publish"; return 0; }
  _tic_git_open
  # the same per-checkout lock as an emit, for the LOCAL steps only (add, commit); the push runs unlocked
  _tic_git_lock || { echo "tics sync: the bus checkout is busy; retry shortly"; return 0; }
  if [ -d "$_gd/tics.d" ]; then
    _tic_git add -A -- tics.d 2>/dev/null
    _tic_git diff --cached --quiet 2>/dev/null || _tic_git commit -q -m "tic" 2>/dev/null
  fi
  _tic_git_unlock
  _tic_git rev-parse -q --verify HEAD >/dev/null 2>&1 || { echo "tics sync: no local tics"; return 0; }
  _tic_git_moved && { echo "tics sync: bus remote mismatch: checkout=$(cat "$_gd/.git/tics-remote" 2>/dev/null) config=${TICS_REMOTE:-} — run tics rebind"; return 0; }
  _tic_git_push || { echo "tics sync: remote unreachable; local tics kept, retry later"; return 0; }
  date -u +%Y-%m-%dT%H:%M:%SZ > "$_gd/.git/tics-fetch-attempt" 2>/dev/null
  _tic_net fetch -q origin "+$_gb:refs/remotes/origin/$_gb" && _tic_net_ok
  echo "tics sync: published to origin/$_gb"
  return 0
}
# `tics rebind` (ADR 0026): move the bus to the configured TICS_REMOTE, carrying only the tics the OLD remote
# does not have. The old checkout is set aside (<dir>.old-<epoch>), a fresh one is opened for the new remote
# (its bus branch fetched if it exists), and the unpushed tic files are copied in, committed and pushed.
tics_rebind() {
  [ "${TIC_STORE:-jsonl}" = "git" ] || { echo "tics rebind: TIC_STORE is not git; nothing to move"; return 0; }
  _gd="${TICS_GIT_DIR:-$ROOT/.claude/state/tics.git}"; _gb="${TICS_BRANCH:-tics-bus}"
  [ -d "$_gd/.git" ] || { echo "tics rebind: no bus checkout yet; nothing to move"; return 0; }
  _tic_git_moved || { echo "tics rebind: bus already on ${TICS_REMOTE:-}"; return 0; }
  # the lock serializes rebind against other emits' commits; a tic FILE written after the listing below can still land
  # only in the kept old checkout (emits write before they lock) — never lost, recoverable from tics.git.old-*
  _tic_git_lock || { echo "tics rebind: the bus checkout is busy; retry shortly"; return 0; }
  _rbt="$_gd.rebind-$$"; rm -rf "$_rbt"; mkdir -p "$_rbt"
  { _tic_git ls-files -- tics.d; _tic_git ls-files -o --exclude-standard -- tics.d; } 2>/dev/null | sort -u | while IFS= read -r _rf; do
    [ -f "$_gd/$_rf" ] || continue
    _tic_git cat-file -e "refs/remotes/origin/$_gb:$_rf" 2>/dev/null && continue
    mkdir -p "$_rbt/$(dirname "$_rf")"; cp "$_gd/$_rf" "$_rbt/$_rf"
  done
  _rbo="$_gd.old-$(date +%s)-$$"
  mv "$_gd" "$_rbo" || { _tic_git_unlock; echo "tics rebind: cannot move the old checkout"; return 0; }   # the lock moves with the old checkout
  _tic_git_open
  if _tic_net fetch -q origin "+$_gb:refs/remotes/origin/$_gb"; then
    _tic_git checkout -q -B "$_gb" "refs/remotes/origin/$_gb" 2>/dev/null
  fi
  if [ -d "$_rbt/tics.d" ]; then mkdir -p "$_gd/tics.d"; cp -R "$_rbt/tics.d/." "$_gd/tics.d/"; fi
  rm -rf "$_rbt"
  _tic_git_publish
  echo "tics rebind: bus moved to ${TICS_REMOTE:-}; old checkout kept at $_rbo"
  return 0
}
