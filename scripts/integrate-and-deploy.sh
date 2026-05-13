#!/usr/bin/env bash
# One-shot: SAM build + deploy for the contact stack; optional patch of contact API meta in HTML.
# Prefer: scripts/orchestrate-deploy.sh (seeds config, pushes file secrets to SM, then runs this script).
#
# Env var names and optional flags are documented in secrets.example/deploy.env.example
# (copy to .secrets/deploy.env). CI sets the same names as GitHub Actions secrets.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_DIR="${ROOT}/aws"
SECRETS_DIR="${SECRETS_DIR:-$ROOT/.secrets}"

# When not already exported (e.g. GitHub Actions exports secrets), load local .secrets/deploy.env
if [[ -z "${RESEND_API_KEY:-}" && -f "$SECRETS_DIR/deploy.env" ]]; then
  echo "Loading $SECRETS_DIR/deploy.env (and generated env if present)…"
  set -a
  # shellcheck source=/dev/null
  source "$SECRETS_DIR/deploy.env"
  if [[ -f "$SECRETS_DIR/config.generated.env" ]]; then
    # shellcheck source=/dev/null
    source "$SECRETS_DIR/config.generated.env"
  fi
  if [[ -f "$SECRETS_DIR/deploy.generated.env" ]]; then
    # shellcheck source=/dev/null
    source "$SECRETS_DIR/deploy.generated.env"
  fi
  set +a
fi

STACK_NAME="${SAM_STACK_NAME:-page}"
REGION="${AWS_REGION:-us-east-2}"

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "error: missing required env ${name}" >&2
    echo "  Set it in the shell, or add it to ${SECRETS_DIR}/deploy.env (see secrets.example/deploy.env.example), or configure GitHub Actions secrets with the same name." >&2
    exit 1
  fi
}

require RESEND_API_KEY
require CONTACT_TO_EMAIL
require CONTACT_FROM_EMAIL
require ALARM_EMAIL
require ADMIN_API_KEY

export AWS_DEFAULT_REGION="${REGION}"

PO=(
  "ResendApiKey=${RESEND_API_KEY}"
  "ContactToEmail=${CONTACT_TO_EMAIL}"
  "ContactFromEmail=${CONTACT_FROM_EMAIL}"
  "AlarmEmail=${ALARM_EMAIL}"
  "AdminApiKey=${ADMIN_API_KEY}"
)

if [[ -n "${CONTACT_REPORT_EMAIL:-}" ]]; then
  PO+=("ContactReportEmail=${CONTACT_REPORT_EMAIL}")
fi

echo "sam build (${AWS_DIR})"
(
  cd "${AWS_DIR}"
  sam build --template-file template.yaml
)

echo "sam deploy stack=${STACK_NAME} region=${REGION}"
(
  cd "${AWS_DIR}"
  sam deploy \
    --template-file .aws-sam/build/template.yaml \
    --stack-name "${STACK_NAME}" \
    --capabilities CAPABILITY_IAM \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset \
    --resolve-s3 \
    --region "${REGION}" \
    --parameter-overrides "${PO[@]}"
)

CONTACT_URL="$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ContactApiUrl'].OutputValue | [0]" \
  --output text)"

echo "ContactApiUrl=${CONTACT_URL}"

if [[ "${SYNC_API_URLS:-1}" == "1" || "${SYNC_API_URLS:-}" == "true" ]]; then
  node "${ROOT}/scripts/sync-site-api-urls.mjs" "${CONTACT_URL}"
  echo "Patched index.html and admin/index.html (gvp:contact-api-url meta)."
fi

echo "Done."
