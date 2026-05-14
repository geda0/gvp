#!/usr/bin/env bash
set -euo pipefail

BASE="${DOCKER_SMOKE_URL:-http://localhost:8080}"

code_root="$(curl -fsS -o /dev/null -w '%{http_code}' "${BASE}/")"
if [[ "${code_root}" != '200' ]]; then
  echo "smoke: expected 200 from GET ${BASE}/, got ${code_root}" >&2
  exit 1
fi

contact_body="$(
  curl -fsS "${BASE}/api/contact" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"email":"a@b.co","message":"hi"}'
)"
if ! echo "${contact_body}" | grep -q '"ok"'; then
  echo "smoke: contact response missing ok: ${contact_body}" >&2
  exit 1
fi
if ! echo "${contact_body}" | grep -q '"persisted"'; then
  echo "smoke: contact response missing persisted: ${contact_body}" >&2
  exit 1
fi

chat_body="$(
  curl -fsS "${BASE}/api/chat" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"ping"}]}'
)"
if ! echo "${chat_body}" | grep -q '"reply"'; then
  echo "smoke: chat response missing reply: ${chat_body}" >&2
  exit 1
fi
if ! echo "${chat_body}" | grep -q '"model"'; then
  echo "smoke: chat response missing model: ${chat_body}" >&2
  exit 1
fi

echo 'docker-smoke: ok'
