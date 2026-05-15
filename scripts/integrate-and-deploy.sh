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
# When GVP_CHAT_VOICE=1 (explicit, before auto-resolve): bootstraps ECR repo
#   name gvp-chat (or CHAT_ECR_REPO_NAME), CHAT_ECR_REPOSITORY_URI, default CHAT_ECS_SAM_STACK_NAME_* when unset,
#   and CHAT_ECS_VPC_ID / CHAT_ECS_SUBNET_IDS via EC2 describe, then optional aws ec2 create-default-vpc when unset
#   CHAT_ECS_CREATE_DEFAULT_VPC defaults to 1 here (set CHAT_ECS_CREATE_DEFAULT_VPC=0 to forbid create; needs ec2:CreateDefaultVpc).
# SAM-managed ECS (CHAT_ECS_SAM_STACK_NAME_* + image push): same describe + optional create when CHAT_ECS_CREATE_DEFAULT_VPC=1.
# Chat on Lambda (Gemini): set CHAT_SAM_STACK_NAME (legacy fallback), or CHAT_SAM_STACK_NAME_STAGE / CHAT_SAM_STACK_NAME_PROD per deploy env, plus GEMINI_API_KEY; template aws/chat-template.yaml

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_DIR="${ROOT}/aws"
CHAT_DIR="${ROOT}/docker/chat"
SECRETS_DIR="${SECRETS_DIR:-$ROOT/.secrets}"
# shellcheck source=chat-ecs-discover-env.sh
source "${ROOT}/scripts/chat-ecs-discover-env.sh"

usage() {
  echo "usage: bash scripts/integrate-and-deploy.sh [prod|stage]" >&2
  echo "  prod  — production contact stack (SAM_STACK_NAME, default page)" >&2
  echo "  stage — staging contact stack; optional CHAT_SAM_STACK_NAME_STAGE (or CHAT_SAM_STACK_NAME) + GEMINI_API_KEY for Lambda chat (Gemini)" >&2
  echo "  Auto-runs Secrets Manager seed/push when .secrets/manifest.json + config.manifest.json exist (SKIP_SECRETS_MANAGER=1 to skip)." >&2
  echo "  When CHAT_PROD_CHAT_API_URL / CHAT_STAGE_CHAT_API_URL are unset, derives gvp:chat-api-url from ECS ALB DNS (CHAT_ECS_* cluster+service). Opt out: CHAT_ECS_AUTO_SYNC_CHAT_URL=0." >&2
  echo "  Optional GVP_CHAT_VOICE=1|true|yes: sets HTML meta gvp:chat-voice-enabled=1 (browser mic); default off." >&2
  echo "  SAM-managed ECS: CHAT_ECS_SAM_STACK_NAME_* + GEMINI + ECR; VPC/subnets via describe + optional create-default-vpc (CHAT_ECS_CREATE_DEFAULT_VPC=1, IAM ec2:CreateDefaultVpc). GVP_CHAT_VOICE=1 bootstraps ECR + default stack names and defaults CHAT_ECS_CREATE_DEFAULT_VPC=1. CHAT_VOICE_ECS_BOOTSTRAP=0 disables auto networking." >&2
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

# EC2 describe + optional create-default-vpc (CHAT_ECS_CREATE_DEFAULT_VPC). Opt out: CHAT_VOICE_ECS_BOOTSTRAP=0.
_chat_ecs_resolve_missing_vpc_subnets() {
  local region="${1:?region}"
  [[ -n "${CHAT_ECS_VPC_ID:-}" && -n "${CHAT_ECS_SUBNET_IDS:-}" ]] && return 0
  [[ "${CHAT_VOICE_ECS_BOOTSTRAP:-1}" == "0" ]] && return 1
  if ! command -v aws >/dev/null 2>&1; then
    return 1
  fi
  if [[ -n "${CHAT_ECS_VPC_ID:-}" && -z "${CHAT_ECS_SUBNET_IDS:-}" ]]; then
    gvp_chat_ecs_fill_subnets_for_set_vpc "${region}" && return 0
  fi
  gvp_chat_ecs_resolve_vpc_subnets_maybe_create "${region}"
}

_chat_ecs_require_two_az_subnets_or_exit() {
  local ctx="$1"
  local _sn_count=0 _s
  IFS=',' read -ra _sns <<< "${CHAT_ECS_SUBNET_IDS// /}"
  for _s in "${_sns[@]}"; do
    [[ -n "${_s}" ]] && _sn_count=$((_sn_count + 1))
  done
  if [[ "${_sn_count}" -lt 2 ]]; then
    echo "error: ${ctx}: ALB needs subnets in at least 2 AZs (got ${_sn_count} id(s) in CHAT_ECS_SUBNET_IDS)." >&2
    exit 1
  fi
}

# When GVP_CHAT_VOICE=1 is set explicitly in env (e.g. chat-deploy.env), wire boring ECS prereqs so the
# SAM-managed path (CHAT_ECS_SAM_STACK_NAME_*) is not skipped for lack of VPC/ECR/stack name.
_chat_voice_prereq_bootstrap() {
  [[ "${CHAT_VOICE_ECS_BOOTSTRAP:-1}" == "0" ]] && return 0
  case "${GVP_CHAT_VOICE:-}" in
    1|true|TRUE|True|yes|YES|Yes|on|ON) ;;
    *) return 0 ;;
  esac
  if ! command -v aws >/dev/null 2>&1; then
    echo "warning: GVP_CHAT_VOICE=1 but aws CLI missing; cannot auto-bootstrap VPC/ECR." >&2
    return 0
  fi
  echo "note: GVP_CHAT_VOICE=1 — bootstrapping ECS chat prereqs (VPC/subnets: describe or create-default-vpc, ECR, SAM stack name when unset)…" >&2
  if [[ -z "${CHAT_ECS_CREATE_DEFAULT_VPC+x}" ]]; then
    export CHAT_ECS_CREATE_DEFAULT_VPC=1
  fi
  local acct repo uri
  acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  if [[ -z "${acct}" || "${acct}" == "None" ]]; then
    echo "warning: cannot read AWS account (sts); skip ECR/VPC bootstrap." >&2
    return 0
  fi
  repo="${CHAT_ECR_REPO_NAME:-gvp-chat}"
  uri="${acct}.dkr.ecr.${REGION}.amazonaws.com/${repo}"
  if [[ -z "${CHAT_ECR_REPOSITORY_URI:-}" ]]; then
    if ! aws ecr describe-repositories --repository-names "${repo}" --region "${REGION}" &>/dev/null; then
      echo "  creating ECR repository ${repo}…" >&2
      aws ecr create-repository --repository-name "${repo}" --region "${REGION}" \
        --image-scanning-configuration scanOnPush=true &>/dev/null
    fi
    export CHAT_ECR_REPOSITORY_URI="${uri}"
    echo "  CHAT_ECR_REPOSITORY_URI=${CHAT_ECR_REPOSITORY_URI}" >&2
  fi
  if [[ -z "${CHAT_ECS_VPC_ID:-}" || -z "${CHAT_ECS_SUBNET_IDS:-}" ]]; then
    if ! _chat_ecs_resolve_missing_vpc_subnets "${REGION}"; then
      echo "error: GVP_CHAT_VOICE=1 could not resolve CHAT_ECS_VPC_ID / CHAT_ECS_SUBNET_IDS in ${REGION}." >&2
      echo "       Describe found no VPC with ≥2 subnets in different AZs, and create-default-vpc did not help or is disabled (CHAT_ECS_CREATE_DEFAULT_VPC=0)." >&2
      echo "       IAM needs ec2:CreateDefaultVpc when auto-create is on; some orgs block default VPC creation." >&2
      echo "       Fix: set CHAT_ECS_VPC_ID + CHAT_ECS_SUBNET_IDS in chat-deploy.env, or bash scripts/chat-ecs-discover-env.sh with CHAT_ECS_CREATE_DEFAULT_VPC=1." >&2
      exit 1
    fi
    echo "  CHAT_ECS_VPC_ID=${CHAT_ECS_VPC_ID}" >&2
    echo "  CHAT_ECS_SUBNET_IDS=${CHAT_ECS_SUBNET_IDS}" >&2
  fi
  _chat_ecs_require_two_az_subnets_or_exit "GVP_CHAT_VOICE=1 bootstrap"
  if [[ "${DEPLOY_ENV}" == "stage" ]]; then
    export CHAT_ECS_SAM_STACK_NAME_STAGE="${CHAT_ECS_SAM_STACK_NAME_STAGE:-gvp-chat-ecs-stage}"
    echo "  CHAT_ECS_SAM_STACK_NAME_STAGE=${CHAT_ECS_SAM_STACK_NAME_STAGE}" >&2
  else
    export CHAT_ECS_SAM_STACK_NAME_PROD="${CHAT_ECS_SAM_STACK_NAME_PROD:-gvp-chat-ecs-prod}"
    echo "  CHAT_ECS_SAM_STACK_NAME_PROD=${CHAT_ECS_SAM_STACK_NAME_PROD}" >&2
  fi
  if [[ -z "${GEMINI_API_KEY:-}" ]]; then
    echo "warning: GEMINI_API_KEY unset — chat-ecs SAM deploy will fail until you add it (deploy.env or chat-deploy.env)." >&2
  fi
}

require RESEND_API_KEY
require CONTACT_TO_EMAIL
require CONTACT_FROM_EMAIL
require ALARM_EMAIL
require ADMIN_API_KEY

export AWS_DEFAULT_REGION="${REGION}"

_chat_voice_prereq_bootstrap

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
  CHAT_ECS_SERVICE="${CHAT_ECS_SERVICE_PROD:-${CHAT_ECS_SERVICE:-}}"
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

  # ---- Optional: SAM-managed ECS chat stack (aws/chat-ecs-template.yaml) ----
  # When CHAT_ECS_SAM_STACK_NAME_<ENV> is set we deploy/update the ECS+ALB stack
  # with the freshly-pushed image. The stack update creates a new TaskDefinition
  # revision and CloudFormation rolls the service. Outputs ClusterName/ServiceName
  # are exported so the existing ALB-DNS auto-derive below still works unchanged.
  CHAT_ECS_SAM_STACK_NAME=""
  CHAT_ECS_CERT_ARN=""
  CHAT_ECS_ALB_LOG_BUCKET=""
  if [[ "${DEPLOY_ENV}" == "stage" ]]; then
    CHAT_ECS_SAM_STACK_NAME="${CHAT_ECS_SAM_STACK_NAME_STAGE:-}"
    CHAT_ECS_CERT_ARN="${CHAT_ECS_CERT_ARN_STAGE:-${CHAT_ECS_CERT_ARN:-}}"
    CHAT_ECS_ALB_LOG_BUCKET="${CHAT_ECS_ALB_LOG_BUCKET_STAGE:-${CHAT_ECS_ALB_LOG_BUCKET:-}}"
  else
    CHAT_ECS_SAM_STACK_NAME="${CHAT_ECS_SAM_STACK_NAME_PROD:-}"
    CHAT_ECS_CERT_ARN="${CHAT_ECS_CERT_ARN_PROD:-${CHAT_ECS_CERT_ARN:-}}"
    CHAT_ECS_ALB_LOG_BUCKET="${CHAT_ECS_ALB_LOG_BUCKET_PROD:-${CHAT_ECS_ALB_LOG_BUCKET:-}}"
  fi

  if [[ -n "${CHAT_ECS_SAM_STACK_NAME}" ]]; then
    if [[ -z "${CHAT_ECS_VPC_ID:-}" || -z "${CHAT_ECS_SUBNET_IDS:-}" ]]; then
      echo "note: CHAT_ECS_VPC_ID / CHAT_ECS_SUBNET_IDS unset — resolving for SAM ECS (describe; optional CHAT_ECS_CREATE_DEFAULT_VPC=1 create-default-vpc; CHAT_VOICE_ECS_BOOTSTRAP=0 skips)…" >&2
      if ! _chat_ecs_resolve_missing_vpc_subnets "${REGION}"; then
        echo "ERROR: SAM ECS stack is set but CHAT_ECS_VPC_ID / CHAT_ECS_SUBNET_IDS could not be resolved." >&2
        echo "       Set both in chat-deploy.env, or export CHAT_ECS_CREATE_DEFAULT_VPC=1 for aws ec2 create-default-vpc when describe fails (IAM ec2:CreateDefaultVpc). GVP_CHAT_VOICE=1 defaults CHAT_ECS_CREATE_DEFAULT_VPC=1 during its bootstrap." >&2
        exit 1
      fi
      echo "  CHAT_ECS_VPC_ID=${CHAT_ECS_VPC_ID}" >&2
      echo "  CHAT_ECS_SUBNET_IDS=${CHAT_ECS_SUBNET_IDS}" >&2
    fi
    _chat_ecs_require_two_az_subnets_or_exit "SAM ECS deploy"
    if [[ -z "${GEMINI_API_KEY:-}" ]]; then
      echo "ERROR: GEMINI_API_KEY required for chat-ecs SAM deploy." >&2
      exit 1
    fi
    echo "sam deploy chat-ecs stack=${CHAT_ECS_SAM_STACK_NAME} env=${DEPLOY_ENV} image=${REMOTE_SHA}"
    CHAT_ECS_PO=(
      "StageName=${DEPLOY_ENV}"
      "VpcId=${CHAT_ECS_VPC_ID}"
      "SubnetIds=${CHAT_ECS_SUBNET_IDS}"
      "ImageUri=${REMOTE_SHA}"
      "GeminiApiKey=${GEMINI_API_KEY}"
      "GeminiModel=${GEMINI_MODEL:-gemini-3.1-flash-lite}"
      "GeminiFallbackModel=${GEMINI_FALLBACK_MODEL:-gemma-4-26b-a4b-it}"
      "GeminiLiveModel=${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}"
      "ChatVoiceModel=${CHAT_VOICE_MODEL:-${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}}"
      "ChatCorsOrigins=${CHAT_CORS_ORIGINS:-https://chat.marwanelgendy.link,https://marwanelgendy.link,https://www.marwanelgendy.link}"
    )
    if [[ -n "${CHAT_TRANSCRIPTS_TABLE_NAME:-}" ]]; then
      CHAT_ECS_PO+=("ChatTranscriptsTableName=${CHAT_TRANSCRIPTS_TABLE_NAME}")
    fi
    if [[ -n "${CHAT_ECS_CERT_ARN:-}" ]]; then
      CHAT_ECS_PO+=("CertificateArn=${CHAT_ECS_CERT_ARN}")
    fi
    if [[ -n "${CHAT_ECS_ALB_LOG_BUCKET:-}" ]]; then
      CHAT_ECS_PO+=("AlbLogBucket=${CHAT_ECS_ALB_LOG_BUCKET}")
    fi
    sam deploy \
      --template-file "${AWS_DIR}/chat-ecs-template.yaml" \
      --stack-name "${CHAT_ECS_SAM_STACK_NAME}" \
      --region "${REGION}" \
      --capabilities CAPABILITY_IAM \
      --no-confirm-changeset \
      --no-fail-on-empty-changeset \
      --resolve-s3 \
      --s3-prefix "${CHAT_ECS_SAM_STACK_NAME}" \
      --parameter-overrides "${CHAT_ECS_PO[@]}"

    # Read outputs and feed back into the existing CHAT_ECS_CLUSTER / _SERVICE
    # vars so the ALB-DNS discovery further down works without extra config.
    _ECS_OUTPUTS_JSON="$(aws cloudformation describe-stacks \
      --stack-name "${CHAT_ECS_SAM_STACK_NAME}" \
      --region "${REGION}" \
      --query 'Stacks[0].Outputs' \
      --output json 2>/dev/null || echo '[]')"
    _ECS_CLUSTER_FROM_STACK="$(echo "${_ECS_OUTPUTS_JSON}" | python3 -c "import json,sys; xs=json.load(sys.stdin); print(next((x['OutputValue'] for x in xs if x['OutputKey']=='ClusterName'),''))" 2>/dev/null || true)"
    _ECS_SERVICE_FROM_STACK="$(echo "${_ECS_OUTPUTS_JSON}" | python3 -c "import json,sys; xs=json.load(sys.stdin); print(next((x['OutputValue'] for x in xs if x['OutputKey']=='ServiceName'),''))" 2>/dev/null || true)"
    if [[ -n "${_ECS_CLUSTER_FROM_STACK}" && -n "${_ECS_SERVICE_FROM_STACK}" ]]; then
      CHAT_ECS_CLUSTER="${_ECS_CLUSTER_FROM_STACK}"
      CHAT_ECS_SERVICE="${_ECS_SERVICE_FROM_STACK}"
      echo "chat-ecs outputs: cluster=${CHAT_ECS_CLUSTER} service=${CHAT_ECS_SERVICE}"
    fi
    # When SAM owns the service, the CloudFormation update already rolled the
    # TaskDefinition. Skip the legacy aws-ecs-update-service path below.
    CLUSTER=""
    SERVICE=""
  else
    CLUSTER="${CHAT_ECS_CLUSTER}"
    SERVICE="${CHAT_ECS_SERVICE}"
  fi

  if [[ -n "${CLUSTER}" && -n "${SERVICE}" ]]; then
    echo "ECS force deploy cluster=${CLUSTER} service=${SERVICE}"
    aws ecs update-service \
      --cluster "${CLUSTER}" \
      --service "${SERVICE}" \
      --force-new-deployment \
      --region "${REGION}" \
      --no-cli-pager
    echo "note: ECS chat image defaults CHAT_LIVE_RELAY=1 (docker/chat/Dockerfile). gvp:chat-api-url is patched from CHAT_*_CHAT_API_URL when set, else derived from this ECS service’s ALB/NLB DNS when CHAT_ECS_AUTO_SYNC_CHAT_URL is enabled."
  elif [[ -z "${CHAT_ECS_SAM_STACK_NAME}" ]]; then
    if [[ "${DEPLOY_ENV}" == "stage" ]]; then
      echo "note: CHAT_ECS_SAM_STACK_NAME_STAGE unset — skipped SAM-managed ECS deploy (image pushed to ECR)." >&2
      echo "      For Fargate+ALB in one step: set CHAT_ECS_SAM_STACK_NAME_STAGE + GEMINI_API_KEY (+ CHAT_ECR_REPOSITORY_URI); VPC/subnets auto-resolve unless CHAT_VOICE_ECS_BOOTSTRAP=0." >&2
      echo "      Or set CHAT_ECS_CLUSTER_STAGE + CHAT_ECS_SERVICE_STAGE for aws ecs update-service only (no SAM ECS stack)." >&2
    else
      echo "note: CHAT_ECS_SAM_STACK_NAME_PROD unset — skipped SAM-managed ECS deploy (image pushed to ECR)." >&2
      echo "      For Fargate+ALB in one step: set CHAT_ECS_SAM_STACK_NAME_PROD + GEMINI_API_KEY (+ CHAT_ECR_REPOSITORY_URI); VPC/subnets auto-resolve unless CHAT_VOICE_ECS_BOOTSTRAP=0." >&2
      echo "      Or set CHAT_ECS_CLUSTER_PROD + CHAT_ECS_SERVICE_PROD for aws ecs update-service only (no SAM ECS stack)." >&2
    fi
  fi
elif [[ "${CHAT_ALWAYS_BUILD:-0}" == "1" ]]; then
  echo "CHAT_ECR_REPOSITORY_URI unset — chat image built locally as ${CHAT_IMAGE_LOCAL} only."
fi

# Build https://<alb-or-nlb-dns><path> from ECS service's first target group's load balancer (for HTML meta sync).
# Scheme is inferred from what the ALB actually listens on: prefer HTTPS:443
# when present, fall back to HTTP:80 otherwise. CHAT_ECS_CHAT_API_SCHEME
# overrides. Defaulting to https blindly burned a stage deploy: meta was
# https://… but the ALB had no cert, so the browser POST sat hanging on a
# port-443 TCP connect that nothing was listening on, surfacing as a
# DevTools "canceled" with no useful console error.
discover_ecs_chat_sync_url_from_aws() {
  local cluster="$1" service="$2"
  local tg_arn lb_arn dns path scheme listener_count
  path="${CHAT_ECS_CHAT_API_PATH:-/api/chat}"
  case "${path}" in
    /*) ;;
    *) path="/${path}" ;;
  esac
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
  if [[ -n "${CHAT_ECS_CHAT_API_SCHEME:-}" ]]; then
    scheme="${CHAT_ECS_CHAT_API_SCHEME}"
  else
    listener_count="$(aws elbv2 describe-listeners --load-balancer-arn "${lb_arn}" --region "${REGION}" \
      --query 'length(Listeners[?Port==`443`])' --output text 2>/dev/null || echo 0)"
    if [[ "${listener_count}" =~ ^[0-9]+$ ]] && (( listener_count > 0 )); then
      scheme="https"
    else
      scheme="http"
      echo "  note: ALB has no HTTPS:443 listener — using http:// for derived chat URL. Browsers WILL block this URL from HTTPS pages (mixed content). Add CHAT_ECS_CERT_ARN_${DEPLOY_ENV^^} (ACM cert ARN) and redeploy to get HTTPS." >&2
    fi
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

# Is the chat URL hosted on Lambda HttpApi (no browser WebSocket upgrade possible)?
# Match the public AWS execute-api hostname; everything else (ECS/ALB, custom domain
# fronting ECS, etc.) is assumed WSS-capable. Used to auto-decide the voice meta flag.
_chat_url_is_lambda_only() {
  case "${1:-}" in
    https://*.execute-api.*.amazonaws.com*|http://*.execute-api.*.amazonaws.com*) return 0 ;;
    *) return 1 ;;
  esac
}

# GET /health on chat API base → reports liveRelay (ECS task CHAT_LIVE_RELAY).
_voice_probe_chat_health() {
  local sync_url="$1"
  local base health lr
  [[ -n "${sync_url}" ]] || return 0
  _chat_url_is_lambda_only "${sync_url}" && return 0
  command -v curl >/dev/null 2>&1 || return 0
  base="${sync_url%/}"
  base="${base%/api/chat}"
  health=""
  if ! health="$(curl -fsS -m 25 "${base}/health" 2>/dev/null)"; then
    echo "  voice probe       : could not GET ${base}/health (curl failed — SG/TLS/DNS or tasks not ready)"
    return 0
  fi
  lr="$(python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.stdout.write('')
else:
    v = d.get('liveRelay')
    if isinstance(v, bool):
        sys.stdout.write('relay' if v else 'off')
    else:
        sys.stdout.write('legacy')
" <<< "${health}" 2>/dev/null)"
  case "${lr}" in
    relay)
      echo "  voice probe       : GET ${base}/health → liveRelay=true"
      ;;
    off)
      echo "  voice probe       : ⚠ GET ${base}/health → liveRelay=false (CHAT_LIVE_RELAY off on task)" >&2
      ;;
    legacy)
      echo "  voice probe       : GET ${base}/health missing liveRelay — redeploy chat image with latest app"
      ;;
    *)
      echo "  voice probe       : unexpected /health JSON from ${base}"
      ;;
  esac
}

# Voice meta flag: explicit GVP_CHAT_VOICE wins (1/true/yes → on, anything else → off).
# When unset, auto-decide from CHAT_SYNC_CHAT_URL:
#   - WSS-capable host (ECS/ALB)  → gvp:chat-voice-enabled=1
#   - Lambda execute-api host     → gvp:chat-voice-enabled=0 (FE blocks direct_google)
# Warn loudly when the user explicitly enabled voice but pointed at a Lambda host.
if [[ -z "${GVP_CHAT_VOICE:-}" ]]; then
  if [[ -n "${CHAT_SYNC_CHAT_URL}" ]] && ! _chat_url_is_lambda_only "${CHAT_SYNC_CHAT_URL}"; then
    GVP_CHAT_VOICE=1
    CHAT_VOICE_REASON="auto (chat URL is WSS-capable)"
  else
    GVP_CHAT_VOICE=0
    if [[ -z "${CHAT_SYNC_CHAT_URL}" ]]; then
      CHAT_VOICE_REASON="auto (no chat URL)"
    else
      CHAT_VOICE_REASON="auto (chat URL is Lambda execute-api)"
    fi
  fi
else
  CHAT_VOICE_REASON="explicit GVP_CHAT_VOICE=${GVP_CHAT_VOICE}"
fi

CHAT_VOICE_META=0
case "${GVP_CHAT_VOICE:-0}" in
  1|true|TRUE|True|yes|YES|Yes) CHAT_VOICE_META=1 ;;
esac

if [[ "${CHAT_VOICE_META}" == "1" ]] && _chat_url_is_lambda_only "${CHAT_SYNC_CHAT_URL:-}"; then
  echo "WARNING: gvp:chat-voice-enabled=1 but chat URL is Lambda execute-api; the browser FE will refuse voice (direct_google blocked)." >&2
  if [[ "${DEPLOY_ENV}" == "stage" ]]; then
    echo "         Fix: set CHAT_STAGE_CHAT_API_URL to your ECS/ALB host, or CHAT_ECS_SAM_STACK_NAME_STAGE (+ GEMINI) for SAM ECS, or CHAT_ECS_CLUSTER_STAGE+CHAT_ECS_SERVICE_STAGE for ALB URL auto-derive." >&2
  else
    echo "         Fix: set CHAT_PROD_CHAT_API_URL to your ECS/ALB host, or CHAT_ECS_SAM_STACK_NAME_PROD (+ GEMINI) for SAM ECS, or CHAT_ECS_CLUSTER_PROD+CHAT_ECS_SERVICE_PROD for ALB URL auto-derive." >&2
  fi
fi

if [[ "${SYNC_API_URLS:-1}" == "1" || "${SYNC_API_URLS:-}" == "true" ]]; then
  if [[ -n "${CHAT_SYNC_CHAT_URL}" ]]; then
    env GVP_CHAT_VOICE="${CHAT_VOICE_META}" node "${ROOT}/scripts/sync-site-api-urls.mjs" "${CONTACT_URL}" "${CHAT_SYNC_CHAT_URL}"
    echo "Patched index.html and admin/index.html (gvp:contact-api-url, gvp:chat-api-url, gvp:chat-voice-enabled=${CHAT_VOICE_META})."
  else
    env GVP_CHAT_VOICE="${CHAT_VOICE_META}" node "${ROOT}/scripts/sync-site-api-urls.mjs" "${CONTACT_URL}"
    echo "Patched index.html and admin/index.html (gvp:contact-api-url; gvp:chat-voice-enabled=${CHAT_VOICE_META})."
  fi
  if [[ "${DEPLOY_ENV}" == "stage" && -z "${CHAT_SYNC_CHAT_URL}" ]]; then
    echo "note: no chat URL for meta — set CHAT_STAGE_CHAT_API_URL, or CHAT_ECS_SAM_STACK_NAME_STAGE + GEMINI (+ ECR URI; VPC/subnets auto-resolve in deploy), or CHAT_ECS_CLUSTER_STAGE+CHAT_ECS_SERVICE_STAGE for ALB discovery, or Lambda chat (CHAT_SAM_STACK_NAME_* + GEMINI_API_KEY)." >&2
  fi
fi

echo
echo "=== Voice readiness (${DEPLOY_ENV}) ==="
echo "  chat URL          : ${CHAT_SYNC_CHAT_URL:-<unset>}"
echo "  gvp:chat-voice    : ${CHAT_VOICE_META}  (${CHAT_VOICE_REASON})"
if [[ "${CHAT_VOICE_META}" == "1" ]]; then
  if _chat_url_is_lambda_only "${CHAT_SYNC_CHAT_URL:-}"; then
    echo "  status            : ⚠ chat URL is Lambda; browser voice will be blocked by FE"
  else
    echo "  status            : OK — ECS image defaults CHAT_LIVE_RELAY=1, FE will accept relay transport"
  fi
else
  echo "  status            : voice OFF — mic UI hidden on the static site"
fi

_voice_probe_chat_health "${CHAT_SYNC_CHAT_URL:-}"

if [[ "${CHAT_VOICE_META}" == "1" ]] && [[ -n "${CHAT_SYNC_CHAT_URL:-}" ]] && { [[ "${SYNC_API_URLS:-1}" == "1" ]] || [[ "${SYNC_API_URLS:-}" == true ]]; }; then
  echo "  publish           : push/sync patched index.html + admin to hosting (Amplify, etc.) — browsers need gvp:chat-api-url on the live static site"
fi

echo "Done (deploy env=${DEPLOY_ENV})."
