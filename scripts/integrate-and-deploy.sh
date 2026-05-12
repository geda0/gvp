#!/usr/bin/env bash
# One-shot: optional AWS Secrets Manager upsert for BigQuery reader SA, then SAM build + deploy.
# Optional: write Contact/Admin/Traffic API URLs from stack outputs into index.html + admin/index.html.
#
# Required env: RESEND_API_KEY, CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL, ALARM_EMAIL, ADMIN_API_KEY
# Optional traffic: TRAFFIC_GCP_PROJECT_ID, TRAFFIC_BIGQUERY_DATASET,
#   either TRAFFIC_SERVICE_ACCOUNT_SECRET_ARN or (GCP_SERVICE_ACCOUNT_JSON + TRAFFIC_SECRET_NAME)
# Optional: SAM_STACK_NAME (default page), AWS_REGION, SYNC_API_URLS=1

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_DIR="${ROOT}/aws"
STACK_NAME="${SAM_STACK_NAME:-page}"
REGION="${AWS_REGION:-us-east-2}"

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "error: missing required env ${name}" >&2
    exit 1
  fi
}

require RESEND_API_KEY
require CONTACT_TO_EMAIL
require CONTACT_FROM_EMAIL
require ALARM_EMAIL
require ADMIN_API_KEY

export AWS_DEFAULT_REGION="${REGION}"

TRAFFIC_ARN="${TRAFFIC_SERVICE_ACCOUNT_SECRET_ARN:-}"

if [[ -n "${GCP_SERVICE_ACCOUNT_JSON:-}" && -z "${TRAFFIC_ARN}" ]]; then
  SECRET_NAME="${TRAFFIC_SECRET_NAME:-gvp/ga4-bq-reader}"
  echo "Upserting Secrets Manager secret: ${SECRET_NAME}"
  if aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --secret-id "${SECRET_NAME}" \
      --secret-string "${GCP_SERVICE_ACCOUNT_JSON}"
  else
    aws secretsmanager create-secret \
      --name "${SECRET_NAME}" \
      --secret-string "${GCP_SERVICE_ACCOUNT_JSON}"
  fi
  TRAFFIC_ARN="$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --query ARN --output text)"
  echo "Using TRAFFIC_SERVICE_ACCOUNT_SECRET_ARN=${TRAFFIC_ARN}"
fi

TRAFFIC_GCP="${TRAFFIC_GCP_PROJECT_ID:-}"
TRAFFIC_DS="${TRAFFIC_BIGQUERY_DATASET:-}"

PO=(
  "ResendApiKey=${RESEND_API_KEY}"
  "ContactToEmail=${CONTACT_TO_EMAIL}"
  "ContactFromEmail=${CONTACT_FROM_EMAIL}"
  "AlarmEmail=${ALARM_EMAIL}"
  "AdminApiKey=${ADMIN_API_KEY}"
  "TrafficGcpProjectId=${TRAFFIC_GCP}"
  "TrafficBigQueryDataset=${TRAFFIC_DS}"
  "TrafficServiceAccountSecretArn=${TRAFFIC_ARN}"
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

if [[ "${SYNC_API_URLS:-0}" == "1" || "${SYNC_API_URLS:-}" == "true" ]]; then
  ADMIN_URL="${CONTACT_URL}/admin"
  TRAFFIC_URL="${CONTACT_URL}/admin/traffic"
  node "${ROOT}/scripts/sync-site-api-urls.mjs" "${CONTACT_URL}" "${ADMIN_URL}" "${TRAFFIC_URL}"
  echo "Patched index.html and admin/index.html with deployed API URLs."
fi

echo "Done."
