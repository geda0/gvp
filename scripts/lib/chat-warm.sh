# shellcheck shell=bash
#
# Post-deploy chat warm (ADR-0026 §5.4; design-notes "2026-10-24", L3).
#
# After the stream stack deploys, ONE `POST /api/chat {"warm":true}` goes through the CloudFront
# front door the browser uses, so the deploy (not the first visitor) pays the cold start. The
# status and elapsed ms are echoed: that number IS the post-deploy cold-start measurement.
#
# FAILS THE DEPLOY on anything but 204, or on a timeout. That is the product-owner's acceptance
# ("a non-2xx or timeout fails the job with a message naming the environment"), chosen by the
# orchestrator over the ADR's "warning only"; the warm contract answers exactly 204.
#
# The front door is CloudFront + OAC to a Lambda Function URL, which refuses a POST whose
# `x-amz-content-sha256` is not sha256(body) (403 InvalidSignatureException, ADR-0022 §7.7). The
# body is a fixed string and its hash is computed from that same string, never hand-written.
#
# Sourced by scripts/integrate-and-deploy.sh; kept in its own file so a test can drive it against
# a local server without executing a deploy (test/chat-post-deploy-warm.test.mjs).

# chat_front_door_url <index.html>
#
# Prints the committed gvp:chat-api-url (the URL the browser posts chat to), or nothing. Under
# CHAT_DEPLOY_TARGET=stream that meta is never repointed by the deploy (invariant 11), and the
# deploy workflows guard that `agent` carries the stage host and `main` the prod host — so it is
# the environment's own front door.
chat_front_door_url() {
  local html="$1"
  [[ -f "${html}" ]] || return 0
  sed -n 's/.*<meta name="gvp:chat-api-url" content="\([^"]*\)".*/\1/p' "${html}" | head -n 1
}

# chat_post_deploy_warm <deploy_env> <chat_url>
#
# Sends the warm to <chat_url> (…/api/chat). Returns 0 on 204; otherwise prints an error naming
# <deploy_env> on stderr and returns 1. Timeout: CHAT_WARM_TIMEOUT_S (default 60 — a cold start
# with a lazy image-layer pull measured 9–11 s; 60 s is far outside that, not a tight budget).
chat_post_deploy_warm() {
  local deploy_env="$1" url="$2"
  local timeout_s="${CHAT_WARM_TIMEOUT_S:-60}"
  local body='{"warm":true}'
  local digest out status secs ms

  if [[ -z "${url}" ]]; then
    echo "error: chat warm (${deploy_env}): no chat front-door URL to warm (gvp:chat-api-url is empty) — the ${deploy_env} deploy cannot prove chat answers." >&2
    return 1
  fi

  digest="$(printf '%s' "${body}" | shasum -a 256 | cut -d' ' -f1)"
  # -w prints even when curl fails (timeout → 000), so capture it and keep curl's own exit quiet.
  out="$(curl -s -o /dev/null -m "${timeout_s}" -X POST \
    -H 'Content-Type: application/json' \
    -H "x-amz-content-sha256: ${digest}" \
    --data-binary "${body}" \
    -w '%{http_code} %{time_total}' \
    "${url}" 2>/dev/null)" || true
  status="${out%% *}"
  secs="${out#* }"
  [[ -n "${status}" ]] || status=000
  ms="$(awk -v s="${secs:-0}" 'BEGIN { printf "%d", s * 1000 }')"

  echo "chat warm (${deploy_env}): POST ${url} {\"warm\":true} -> ${status} in ${ms} ms"
  if [[ "${status}" == "204" ]]; then
    return 0
  fi
  if [[ "${status}" == "000" ]]; then
    echo "error: chat warm (${deploy_env}) timed out or got no response after ${ms} ms (limit ${timeout_s} s) from ${url} — the ${deploy_env} deploy FAILED its post-deploy warm." >&2
  else
    echo "error: chat warm (${deploy_env}) returned ${status} (expected 204) from ${url} — the ${deploy_env} deploy FAILED its post-deploy warm." >&2
  fi
  return 1
}
