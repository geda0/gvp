#!/usr/bin/env bash
# Build + deploy contact SAM stack, optional Lambda chat, optional ECS chat image, optional HTML meta sync.
# Usage: bash scripts/integrate-and-deploy.sh [prod|stage]
#   prod  — default when omitted; stack from SAM_STACK_NAME (default page). Chat meta: CHAT_PROD_CHAT_API_URL, else URL derived from ECS (CHAT_ECS_* + ALB DNS), else Chat SAM output.
#   stage — SAM_STACK_NAME_STAGE (default page-staging). Chat meta: CHAT_STAGE_CHAT_API_URL, else ECS-derived URL, else ChatPostApiUrl when chat SAM deploy runs (CHAT_SAM_STACK_NAME_* + GEMINI_API_KEY).
#
# Secrets Manager (local): when .secrets/manifest.json AND .secrets/config.manifest.json exist, runs
#   seed_local_configs.py + push_local_secrets_to_sm.py then sources deploy.env (+ generated files).
# Skip with SKIP_SECRETS_MANAGER=1 (e.g. quick redeploy, or CI where secrets are already in the environment).
#
# Env var names: secrets.example/deploy.env.example; optional chat/ECR: secrets.example/chat-deploy.env.example
# (auto-sourced from .secrets/chat-deploy.env when present). CI injects the same names.
# HTML chat voice (browser mic): optional GVP_CHAT_VOICE=1|true|yes during meta sync sets
#   <meta name="gvp:chat-voice-enabled" content="1">; otherwise content=0. Unset defaults to off.
# Chat on Lambda (Gemini): set CHAT_SAM_STACK_NAME (legacy fallback), or CHAT_SAM_STACK_NAME_STAGE / CHAT_SAM_STACK_NAME_PROD per deploy env, plus GEMINI_API_KEY; template aws/chat-template.yaml

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_DIR="${ROOT}/aws"
CHAT_DIR="${ROOT}/docker/chat"
SECRETS_DIR="${SECRETS_DIR:-$ROOT/.secrets}"

usage() {
  echo "usage: bash scripts/integrate-and-deploy.sh [prod|stage]" >&2
  echo "  prod  — production contact stack (SAM_STACK_NAME, default page)" >&2
  echo "  stage — staging contact stack; optional CHAT_SAM_STACK_NAME_STAGE (or CHAT_SAM_STACK_NAME) + GEMINI_API_KEY for Lambda chat (Gemini)" >&2
  echo "  Auto-runs Secrets Manager seed/push when .secrets/manifest.json + config.manifest.json exist (SKIP_SECRETS_MANAGER=1 to skip)." >&2
  echo "  When CHAT_PROD_CHAT_API_URL / CHAT_STAGE_CHAT_API_URL are unset, derives gvp:chat-api-url from ECS ALB DNS (CHAT_ECS_* cluster+service). Opt out: CHAT_ECS_AUTO_SYNC_CHAT_URL=0." >&2
  echo "  Optional GVP_CHAT_VOICE=1|true|yes: sets HTML meta gvp:chat-voice-enabled=1 (browser mic); default off." >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi
if [[ $# -gt 1 ]]; then
  usage
fi

DEPLOY_ENV="${1:-prod}"
DEPLOY_ENV="$(printf '%s' "${DEPLOY_ENV}" | tr '[:upper:]' '[:lower:]')"
if [[ "${DEPLOY_ENV}" != "prod" && "${DEPLOY_ENV}" != "stage" ]]; then
  usage
fi

if [[ "${SKIP_SECRETS_MANAGER:-0}" != "1" && -f "$SECRETS_DIR/manifest.json" && -f "$SECRETS_DIR/config.manifest.json" ]]; then
  if [[ ! -f "$SECRETS_DIR/deploy.env" ]]; then
    echo "error: $SECRETS_DIR/deploy.env missing (required with manifest.json + config.manifest.json)" >&2
    echo "  cp \"$ROOT/secrets.example/deploy.env.example\" \"$SECRETS_DIR/deploy.env\" && edit" >&2
    exit 1
  fi
  ORCH_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
  export AWS_DEFAULT_REGION="${ORCH_REGION}"
  echo "Secrets prep: seeding config exports (config.manifest.json)…"
  python3 "$ROOT/scripts/seed_local_configs.py" --secrets-dir "$SECRETS_DIR"
  echo "Secrets prep: pushing manifest files to AWS Secrets Manager…"
  python3 "$ROOT/scripts/push_local_secrets_to_sm.py" --secrets-dir "$SECRETS_DIR" --region "${ORCH_REGION}"
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

if [[ -f "${SECRETS_DIR}/chat-deploy.env" ]]; then
  echo "Loading ${SECRETS_DIR}/chat-deploy.env…"
  set -a
  # shellcheck source=/dev/null
  source "${SECRETS_DIR}/chat-deploy.env"
  set +a
fi

REGION="${AWS_REGION:-us-east-2}"
if [[ "${DEPLOY_ENV}" == "stage" ]]; then
  STACK_NAME="${SAM_STACK_NAME_STAGE:-page-staging}"
else
  STACK_NAME="${SAM_STACK_NAME:-page}"
fi

# Resolve chat SAM stack name: prefer per-environment vars to avoid prod/stage overwriting the same stack.
CHAT_STACK_RESOLVED=""
if [[ "${DEPLOY_ENV}" == "stage" ]]; then
  CHAT_STACK_RESOLVED="${CHAT_SAM_STACK_NAME_STAGE:-${CHAT_SAM_STACK_NAME:-}}"
else
  CHAT_STACK_RESOLVED="${CHAT_SAM_STACK_NAME_PROD:-${CHAT_SAM_STACK_NAME:-}}"
fi

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

if [[ -n "${CONTACT_CORS_ORIGINS:-}" ]]; then
  PO+=("ContactCorsOrigins=${CONTACT_CORS_ORIGINS}")
fi

SHORT_SHA="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || echo local)"
CHAT_IMAGE_LOCAL="gvp-chat:${DEPLOY_ENV}-${SHORT_SHA}"

run_chat_docker=false
if [[ -n "${CHAT_ECR_REPOSITORY_URI:-}" || "${CHAT_ALWAYS_BUILD:-0}" == "1" ]]; then
  run_chat_docker=true
fi

run_chat_sam=false
if [[ -n "${CHAT_STACK_RESOLVED}" ]]; then
  run_chat_sam=true
  require GEMINI_API_KEY
fi

CHAT_ECS_CLUSTER=""
CHAT_ECS_SERVICE=""
if [[ "${DEPLOY_ENV}" == "stage" ]]; then
  CHAT_ECS_CLUSTER="${CHAT_ECS_CLUSTER_STAGE:-${CHAT_ECS_CLUSTER:-}}"
  CHAT_ECS_SERVICE="${CHAT_ECS_SERVICE_STAGE:-${CHAT_ECS_SERVICE:-}}"
else
  CHAT_ECS_CLUSTER="${CHAT_ECS_CLUSTER_PROD:-${CHAT_ECS_CLUSTER:-}}"
  CHAT_ECS_SERVICE="${CHAT_ECS_SERVICE_PROD:-}"
fi

test_pid=""
if [[ "${CHAT_PARALLEL_TEST:-0}" == "1" && "${SKIP_CHAT_TESTS:-0}" != "1" && "${run_chat_docker}" == "true" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    (
      cd "${CHAT_DIR}"
      python3 -m pip install -q -r requirements.txt -r requirements-dev.txt
      PYTHONPATH=. python3 -m pytest tests/ -q --tb=no
    ) &
    test_pid=$!
    echo "Parallel pytest (pid ${test_pid}) alongside sam build / docker build…"
  fi
fi

echo "sam build contact (${AWS_DIR}) env=${DEPLOY_ENV} stack=${STACK_NAME} (parallel ECS chat docker: ${run_chat_docker})"
sam_pid=""
( cd "${AWS_DIR}" && sam build --template-file template.yaml ) &
sam_pid=$!

docker_pid=""
if [[ "${run_chat_docker}" == "true" ]]; then
  (
    DOCKER_BUILDKIT=1 docker build -f "${ROOT}/docker/chat/Dockerfile" -t "${CHAT_IMAGE_LOCAL}" "${ROOT}"
  ) &
  docker_pid=$!
fi

wait "${sam_pid}"
if [[ -n "${docker_pid}" ]]; then
  wait "${docker_pid}"
fi

if [[ "${run_chat_sam}" == "true" ]]; then
  echo "sam build chat Lambda image (${AWS_DIR}/chat-template.yaml → .aws-sam/build-chat)"
  (
    cd "${AWS_DIR}"
    sam build --template-file chat-template.yaml --build-dir .aws-sam/build-chat
  )
fi

if [[ -n "${test_pid}" ]]; then
  echo "Waiting for parallel pytest…"
  wait "${test_pid}"
fi

echo "sam deploy contact stack=${STACK_NAME} region=${REGION}"
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

CHAT_TRANSCRIPTS_TABLE_NAME="$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ChatTranscriptsTableName'].OutputValue | [0]" \
  --output text)"
if [[ "${CHAT_TRANSCRIPTS_TABLE_NAME:-}" == "None" ]]; then
  CHAT_TRANSCRIPTS_TABLE_NAME=""
fi
echo "ChatTranscriptsTableName=${CHAT_TRANSCRIPTS_TABLE_NAME:-}"

CHAT_SAM_CHAT_URL=""
if [[ "${run_chat_sam}" == "true" ]]; then
  CHAT_PO=(
    "GeminiApiKey=${GEMINI_API_KEY}"
    "ChatCorsOrigins=${CHAT_CORS_ORIGINS:-https://chat.marwanelgendy.link,https://marwanelgendy.link,https://www.marwanelgendy.link}"
    "GeminiModel=${GEMINI_MODEL:-gemini-3.1-flash-lite}"
    "GeminiFallbackModel=${GEMINI_FALLBACK_MODEL:-gemma-4-26b-a4b-it}"
    "GeminiLiveModel=${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}"
    "ChatVoiceModel=${CHAT_VOICE_MODEL:-gemini-3.1-flash-live-preview}"
  )
  if [[ -n "${CHAT_TRANSCRIPTS_TABLE_NAME:-}" ]]; then
    CHAT_PO+=("ChatTranscriptsTableName=${CHAT_TRANSCRIPTS_TABLE_NAME}")
  else
    echo "warning: contact stack output ChatTranscriptsTableName missing or empty; chat Lambda will not write transcripts (admin transcript tab stays empty)." >&2
  fi
  CHAT_ALARM_EMAIL="${CHAT_ERROR_ALARM_EMAIL:-${ALARM_EMAIL:-}}"
  if [[ -n "${CHAT_ALARM_EMAIL}" ]]; then
    CHAT_PO+=("ChatErrorAlarmEmail=${CHAT_ALARM_EMAIL}")
  fi
  echo "sam deploy chat stack=${CHAT_STACK_RESOLVED} region=${REGION}"
  (
    cd "${AWS_DIR}"
    sam deploy \
      --template-file .aws-sam/build-chat/template.yaml \
      --stack-name "${CHAT_STACK_RESOLVED}" \
      --capabilities CAPABILITY_IAM \
      --no-confirm-changeset \
      --no-fail-on-empty-changeset \
      --resolve-s3 \
      --resolve-image-repos \
      --region "${REGION}" \
      --parameter-overrides "${CHAT_PO[@]}"
  )
  CHAT_SAM_CHAT_URL="$(aws cloudformation describe-stacks \
    --stack-name "${CHAT_STACK_RESOLVED}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='ChatPostApiUrl'].OutputValue | [0]" \
    --output text)"
  echo "ChatPostApiUrl=${CHAT_SAM_CHAT_URL}"
fi

if [[ -n "${CHAT_ECR_REPOSITORY_URI:-}" && "${run_chat_docker}" == "true" ]]; then
  ECR_HOST="${CHAT_ECR_REPOSITORY_URI%%/*}"
  echo "Chat image push → ${CHAT_ECR_REPOSITORY_URI} (${DEPLOY_ENV})"
  aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${ECR_HOST}"
  TAG_SHA="${DEPLOY_ENV}-${SHORT_SHA}"
  REMOTE_SHA="${CHAT_ECR_REPOSITORY_URI}:${TAG_SHA}"
  REMOTE_LATEST="${CHAT_ECR_REPOSITORY_URI}:${DEPLOY_ENV}-latest"
  docker tag "${CHAT_IMAGE_LOCAL}" "${REMOTE_SHA}"
  docker tag "${CHAT_IMAGE_LOCAL}" "${REMOTE_LATEST}"
  docker push "${REMOTE_SHA}"
  docker push "${REMOTE_LATEST}"

  CLUSTER="${CHAT_ECS_CLUSTER}"
  SERVICE="${CHAT_ECS_SERVICE}"

  if [[ -n "${CLUSTER}" && -n "${SERVICE}" ]]; then
    echo "ECS force deploy cluster=${CLUSTER} service=${SERVICE}"
    aws ecs update-service \
      --cluster "${CLUSTER}" \
      --service "${SERVICE}" \
      --force-new-deployment \
      --region "${REGION}" \
      --no-cli-pager
    echo "note: ECS chat image defaults CHAT_LIVE_RELAY=1 (docker/chat/Dockerfile). gvp:chat-api-url is patched from CHAT_*_CHAT_API_URL when set, else derived from this ECS service’s ALB/NLB DNS when CHAT_ECS_AUTO_SYNC_CHAT_URL is enabled."
  else
    echo "CHAT_ECS_CLUSTER_* / CHAT_ECS_SERVICE_* unset — skip ECS roll (image pushed)."
  fi
elif [[ "${CHAT_ALWAYS_BUILD:-0}" == "1" ]]; then
  echo "CHAT_ECR_REPOSITORY_URI unset — chat image built locally as ${CHAT_IMAGE_LOCAL} only."
fi

# Build https://<alb-or-nlb-dns><path> from ECS service's first target group's load balancer (for HTML meta sync).
discover_ecs_chat_sync_url_from_aws() {
  local cluster="$1" service="$2"
  local tg_arn lb_arn dns path scheme
  path="${CHAT_ECS_CHAT_API_PATH:-/api/chat}"
  case "${path}" in
    /*) ;;
    *) path="/${path}" ;;
  esac
  scheme="${CHAT_ECS_CHAT_API_SCHEME:-https}"
  tg_arn="$(aws ecs describe-services --cluster "${cluster}" --services "${service}" --region "${REGION}" \
    --query 'services[0].loadBalancers[0].targetGroupArn' --output text 2>/dev/null)" || return 1
  if [[ -z "${tg_arn}" || "${tg_arn}" == "None" ]]; then
    return 1
  fi
  lb_arn="$(aws elbv2 describe-target-groups --target-group-arns "${tg_arn}" --region "${REGION}" \
    --query 'TargetGroups[0].LoadBalancerArns[0]' --output text 2>/dev/null)" || return 1
  if [[ -z "${lb_arn}" || "${lb_arn}" == "None" ]]; then
    return 1
  fi
  dns="$(aws elbv2 describe-load-balancers --load-balancer-arns "${lb_arn}" --region "${REGION}" \
    --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null)" || return 1
  if [[ -z "${dns}" || "${dns}" == "None" ]]; then
    return 1
  fi
  printf '%s://%s%s' "${scheme}" "${dns}" "${path}"
  return 0
}

CHAT_ECS_DISCOVERED_URL=""
_auto_ecs_meta="${CHAT_ECS_AUTO_SYNC_CHAT_URL:-1}"
if [[ "${_auto_ecs_meta}" != "0" && "${_auto_ecs_meta}" != "false" ]]; then
  _need_ecs_meta=false
  if [[ "${DEPLOY_ENV}" == "stage" && -z "${CHAT_STAGE_CHAT_API_URL:-}" ]]; then
    _need_ecs_meta=true
  fi
  if [[ "${DEPLOY_ENV}" == "prod" && -z "${CHAT_PROD_CHAT_API_URL:-}" ]]; then
    _need_ecs_meta=true
  fi
  if [[ "${_need_ecs_meta}" == true ]] && [[ -n "${CHAT_ECS_CLUSTER:-}" && -n "${CHAT_ECS_SERVICE:-}" ]]; then
    if CHAT_ECS_DISCOVERED_URL="$(discover_ecs_chat_sync_url_from_aws "${CHAT_ECS_CLUSTER}" "${CHAT_ECS_SERVICE}")"; then
      echo "Derived gvp:chat-api-url from ECS (${CHAT_ECS_CLUSTER}/${CHAT_ECS_SERVICE}) → ${CHAT_ECS_DISCOVERED_URL}"
    else
      CHAT_ECS_DISCOVERED_URL=""
      echo "note: CHAT_*_CHAT_API_URL unset — could not derive chat URL from ECS (no load balancer on service, or wrong cluster/service?)." >&2
    fi
  fi
fi

if [[ "${DEPLOY_ENV}" == "stage" ]]; then
  CHAT_SYNC_CHAT_URL="${CHAT_STAGE_CHAT_API_URL:-${CHAT_ECS_DISCOVERED_URL:-${CHAT_SAM_CHAT_URL}}}"
else
  CHAT_SYNC_CHAT_URL="${CHAT_PROD_CHAT_API_URL:-${CHAT_ECS_DISCOVERED_URL:-${CHAT_SAM_CHAT_URL}}}"
fi

CHAT_VOICE_META=0
case "${GVP_CHAT_VOICE:-0}" in
  1|true|TRUE|True|yes|YES|Yes) CHAT_VOICE_META=1 ;;
esac

if [[ "${SYNC_API_URLS:-1}" == "1" || "${SYNC_API_URLS:-}" == "true" ]]; then
  if [[ -n "${CHAT_SYNC_CHAT_URL}" ]]; then
    env GVP_CHAT_VOICE="${CHAT_VOICE_META}" node "${ROOT}/scripts/sync-site-api-urls.mjs" "${CONTACT_URL}" "${CHAT_SYNC_CHAT_URL}"
    echo "Patched index.html and admin/index.html (gvp:contact-api-url, gvp:chat-api-url, gvp:chat-voice-enabled=${CHAT_VOICE_META})."
  else
    env GVP_CHAT_VOICE="${CHAT_VOICE_META}" node "${ROOT}/scripts/sync-site-api-urls.mjs" "${CONTACT_URL}"
    echo "Patched index.html and admin/index.html (gvp:contact-api-url; gvp:chat-voice-enabled=${CHAT_VOICE_META})."
  fi
  if [[ "${DEPLOY_ENV}" == "stage" && -z "${CHAT_SYNC_CHAT_URL}" ]]; then
    echo "note: no chat URL for meta — set CHAT_STAGE_CHAT_API_URL, or CHAT_ECS_CLUSTER_STAGE+CHAT_ECS_SERVICE_STAGE for ALB discovery, or deploy Lambda chat (CHAT_SAM_STACK_NAME_* + GEMINI_API_KEY) for ChatPostApiUrl." >&2
  fi
fi

echo "Done (deploy env=${DEPLOY_ENV})."
