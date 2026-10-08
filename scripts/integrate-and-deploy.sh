#!/usr/bin/env bash
# Build + deploy contact SAM stack, chat (ECS Express Mode by default, or Lambda), optional HTML meta sync.
# Usage: bash scripts/integrate-and-deploy.sh [prod|stage]
#   prod  — default when omitted; stack from SAM_STACK_NAME (default page). Chat meta: CHAT_PROD_CHAT_API_URL, else Chat SAM output.
#   stage — SAM_STACK_NAME_STAGE (default page-staging). Chat meta: CHAT_STAGE_CHAT_API_URL, else ChatPostApiUrl when chat SAM deploy runs (CHAT_SAM_STACK_NAME_* + GEMINI_API_KEY).
#
# Secrets Manager (local): when .secrets/manifest.json AND .secrets/config.manifest.json exist, runs
#   seed_local_configs.py + push_local_secrets_to_sm.py then sources deploy.env (+ generated files).
# Skip with SKIP_SECRETS_MANAGER=1 (e.g. quick redeploy, or CI where secrets are already in the environment).
#
# Env var names: secrets.example/deploy.env.example; optional chat/ECR: secrets.example/chat-deploy.env.example
# (auto-sourced from .secrets/chat-deploy.env when present). CI injects the same names.
# Voice (browser mic) is always on in the FE and is browser-direct: POST /api/live/session mints an
# ephemeral Gemini Live token and the browser opens Google's Live API itself (no server WebSocket /
# relay), so voice works from any HTTPS chat host.
#
# Chat host target — CHAT_DEPLOY_TARGET, default `express`. An unrecognized value EXITS 1; it is
# never a silent no-op (ADR-0022 §27.4 / drift 19).
#   express  — ECS Express Mode: aws/chat-express-template.yaml → gvp-chat-express-{stage,prod}.
#              Express provisions the ALB/TLS itself. This is the host serving prod today.
#   stream   — Lambda RESPONSE_STREAM behind a Function URL + a CloudFront/OAC front door
#              (ADR-0022): aws/chat-stream-template.yaml     → gvp-chat-lambda-stream-{stage,prod}
#              then        aws/chat-stream-cdn-template.yaml → gvp-chat-stream-cdn-{stage,prod}.
#              NEVER repoints the committed gvp:chat-api-url meta — invariant 11 pins those hosts
#              and test/frontend-api-url-env-guard.test.mjs enforces them; a host repoint is a
#              separate, deliberate commit.
# Chat on Lambda behind the throttled HttpApi (Gemini): set CHAT_SAM_STACK_NAME (legacy fallback), or CHAT_SAM_STACK_NAME_STAGE / CHAT_SAM_STACK_NAME_PROD per deploy env, plus GEMINI_API_KEY; template aws/chat-template.yaml

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
  echo "  Voice is browser-direct (POST /api/live/session mints a token; the browser opens Google's Live API) — any HTTPS chat host works." >&2
  echo "  CHAT_DEPLOY_TARGET=express (default) — ECS Express Mode, aws/chat-express-template.yaml → gvp-chat-express-<env>; the host serving prod today." >&2
  echo "  CHAT_DEPLOY_TARGET=stream            — Lambda RESPONSE_STREAM + CloudFront/OAC (ADR-0022), aws/chat-stream-template.yaml → gvp-chat-lambda-stream-<env> then aws/chat-stream-cdn-template.yaml → gvp-chat-stream-cdn-<env>." >&2
  echo "  Any other CHAT_DEPLOY_TARGET value exits 1 — it never silently deploys nothing. The stream target never repoints gvp:chat-api-url (invariant 11)." >&2
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

# Validated HERE, before the sam/docker builds and the ECR push — not at the deploy branch — so an
# unimplemented target costs nothing. Until now anything but `express` fell through the branch at
# the bottom of this script and deployed NO chat host at all while exiting 0 (ADR-0022 drift 19).
CHAT_DEPLOY_TARGET="$(printf '%s' "${CHAT_DEPLOY_TARGET:-express}" | tr '[:upper:]' '[:lower:]')"
case "${CHAT_DEPLOY_TARGET}" in
  express|stream) ;;
  *)
    echo "error: unsupported CHAT_DEPLOY_TARGET='${CHAT_DEPLOY_TARGET}' (accepted: express, stream)" >&2
    echo "  express — ECS Express Mode (aws/chat-express-template.yaml); the default and the prod chat host." >&2
    echo "  stream  — Lambda RESPONSE_STREAM + CloudFront/OAC (aws/chat-stream-template.yaml + aws/chat-stream-cdn-template.yaml, ADR-0022)." >&2
    exit 1
    ;;
esac

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

# One stack output, '' when the stack or the output does not exist (describe-stacks prints the
# literal "None" for a missing output, and fails outright for a missing stack).
stack_output() {
  local stack="$1"
  local key="$2"
  local value
  value="$(aws cloudformation describe-stacks \
    --stack-name "${stack}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text 2>/dev/null || true)"
  if [[ "${value}" == "None" ]]; then
    value=""
  fi
  printf '%s' "${value}"
}

# Host only — no scheme, no path, no trailing slash. A CloudFront origin takes a DomainName,
# and aws/chat-stream-template.yaml's ChatStreamFunctionUrl output is a full URL with a trailing /.
url_host() {
  local u="${1#*://}"
  printf '%s' "${u%%/*}"
}

require RESEND_API_KEY
require CONTACT_TO_EMAIL
require CONTACT_FROM_EMAIL
require ALARM_EMAIL
require ADMIN_API_KEY

if [[ "${CONTACT_FROM_EMAIL}" != *@* ]]; then
  echo "error: CONTACT_FROM_EMAIL must include an address (e.g. noreply@yourdomain.com or 'Site <noreply@yourdomain.com>')." >&2
  echo "  Current value looks truncated — if it contains spaces, redeploy with an updated integrate-and-deploy.sh (SAM splits unquoted values on spaces)." >&2
  exit 1
fi

# SAM shorthand splits Key=Value on spaces unless the value is double-quoted.
sam_param_override() {
  local key="$1"
  local value="$2"
  if [[ "${value}" == *" "* || "${value}" == *$'\t'* ]]; then
    local escaped="${value//\"/\\\"}"
    printf '%s="%s"' "${key}" "${escaped}"
  else
    printf '%s=%s' "${key}" "${value}"
  fi
}

export AWS_DEFAULT_REGION="${REGION}"

PO=(
  "$(sam_param_override ResendApiKey "${RESEND_API_KEY}")"
  "$(sam_param_override ContactToEmail "${CONTACT_TO_EMAIL}")"
  "$(sam_param_override ContactFromEmail "${CONTACT_FROM_EMAIL}")"
  "$(sam_param_override AlarmEmail "${ALARM_EMAIL}")"
  "$(sam_param_override AdminApiKey "${ADMIN_API_KEY}")"
)

# IpHashPepper and SmokeProbeKey are OPTIONAL and were passed unconditionally, which made this
# script unable to deploy at all whenever they are unset — their default state in this repo:
# neither is in .secrets/*, in either manifest, or anywhere else in the tree, so
# `sam_param_override` emitted a bare `IpHashPepper=` and SAM rejected the whole
# --parameter-overrides list ("is not a valid format"), before reaching any chat stack. MEASURED
# 2026-10-07, exit 2.
# Conditional is strictly better than empty, never worse: CloudFormation reuses the PREVIOUS value
# of any parameter a deploy omits, so on the live stacks (page / page-staging both hold a real
# NoEcho pepper) this preserves it instead of trying to blank it, and on a brand-new stack the
# template's own `Default: ''` applies exactly as before. Same shape the adjacent
# ContactReportEmail / ContactCorsOrigins blocks already use.
if [[ -n "${IP_HASH_PEPPER:-}" ]]; then
  PO+=("$(sam_param_override IpHashPepper "${IP_HASH_PEPPER}")")
fi

if [[ -n "${SMOKE_PROBE_KEY:-}" ]]; then
  PO+=("$(sam_param_override SmokeProbeKey "${SMOKE_PROBE_KEY}")")
fi

if [[ -n "${CONTACT_REPORT_EMAIL:-}" ]]; then
  PO+=("$(sam_param_override ContactReportEmail "${CONTACT_REPORT_EMAIL}")")
fi

if [[ -n "${CONTACT_CORS_ORIGINS:-}" ]]; then
  PO+=("$(sam_param_override ContactCorsOrigins "${CONTACT_CORS_ORIGINS}")")
fi

# ---- Instant chat-degradation alerts (model switch / timeout / rate-limit / breakage) ----
# ONE resolution, shared by EVERY chat host (ECS Express, Lambda HttpApi, Lambda stream) — it used
# to live inside the express branch, so the two Lambda hosts were deployed with the parameters left
# at their '' defaults. Reuses the contact email config so it activates without extra setup.
#
# alerts_enabled() (docker/chat/app/alerts.py:53-54) needs ALL THREE non-empty: the key, a recipient
# AND a from-address. The templates declaring these env vars means a deploy can no longer omit a
# KEY; it says nothing about the VALUE. An empty value reproduces, exactly, the state measured
# 2026-10-07: six alert types across twelve call sites dropped with no log line. So resolve once,
# here, and hand the same values to every host.
CHAT_ALERT_TO="${CHAT_ALERT_EMAIL:-${CONTACT_REPORT_EMAIL:-${CONTACT_TO_EMAIL:-}}}"
CHAT_ALERT_FROM="${CHAT_ALERT_FROM_EMAIL:-${CONTACT_FROM_EMAIL:-}}"
CHAT_ALERTS_LIT=false
if [[ -n "${RESEND_API_KEY:-}" && -n "${CHAT_ALERT_TO}" && -n "${CHAT_ALERT_FROM}" ]]; then
  CHAT_ALERTS_LIT=true
fi

# Named per HOST, because one run can now light more than one of them. Prints the destination
# address only — RESEND_API_KEY is never echoed.
chat_alerts_echo() {
  local host="$1"
  if [[ "${CHAT_ALERTS_LIT}" == "true" ]]; then
    echo "chat instant alerts [${host}]: ON -> ${CHAT_ALERT_TO}"
  else
    echo "chat instant alerts [${host}]: dark (set RESEND_API_KEY + CHAT_ALERT_EMAIL/CONTACT_REPORT_EMAIL + a from address to enable)"
  fi
}

SHORT_SHA="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || echo local)"
CHAT_IMAGE_LOCAL="gvp-chat:${DEPLOY_ENV}-${SHORT_SHA}"

# docker/chat/Dockerfile is the ECS Express image. CHAT_DEPLOY_TARGET=stream builds a DIFFERENT
# image (docker/chat/Dockerfile.lambda-stream, via `sam build`), so building and pushing this one
# for that target is pure waste. For `express` — the default, and what CI sets — the condition is
# unchanged. CHAT_ALWAYS_BUILD=1 still forces a local build whatever the target.
run_chat_docker=false
if [[ "${CHAT_DEPLOY_TARGET}" == "express" && -n "${CHAT_ECR_REPOSITORY_URI:-}" ]]; then
  run_chat_docker=true
fi
if [[ "${CHAT_ALWAYS_BUILD:-0}" == "1" ]]; then
  run_chat_docker=true
fi

run_chat_sam=false
if [[ -n "${CHAT_STACK_RESOLVED}" ]]; then
  run_chat_sam=true
  require GEMINI_API_KEY
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
    # StageName is NOT cosmetic: aws/chat-template.yaml maps it to CHAT_ENV, which _env_label()
    # (docker/chat/app/alerts.py:97-103) puts in every alert subject as "[chat alert · {env}]".
    # The template default is `stage`, so a prod deploy that omits it labels PROD alerts as stage —
    # confidently wrong, and worse than the 'unknown' it replaced.
    "$(sam_param_override StageName "${DEPLOY_ENV}")"
    "GeminiApiKey=${GEMINI_API_KEY}"
    "ChatCorsOrigins=${CHAT_CORS_ORIGINS:-https://chat.marwanelgendy.link,https://marwanelgendy.link,https://www.marwanelgendy.link}"
    "GeminiModel=${GEMINI_MODEL:-gemini-3.1-flash-lite}"
    "GeminiFallbackModel=${GEMINI_FALLBACK_MODEL:-gemma-4-26b-a4b-it}"
    "GeminiLiveModel=${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}"
    "ChatVoiceModel=${CHAT_VOICE_MODEL:-gemini-3.1-flash-live-preview}"
  )
  # Conditional for the same reason as IpHashPepper above, and it matters HERE and not in the
  # express or CDN arrays because this stack goes through `sam deploy` (PackageType: Image) and SAM
  # rejects a bare `SmokeProbeKey=` outright, where awscli's `deploy` accepts it. SMOKE_PROBE_KEY is
  # unset in this repo's .secrets/*, so passing it unconditionally fails the whole deploy.
  if [[ -n "${SMOKE_PROBE_KEY:-}" ]]; then
    CHAT_PO+=("SmokeProbeKey=${SMOKE_PROBE_KEY}")
  fi
  if [[ -n "${CHAT_TRANSCRIPTS_TABLE_NAME:-}" ]]; then
    CHAT_PO+=("ChatTranscriptsTableName=${CHAT_TRANSCRIPTS_TABLE_NAME}")
  else
    echo "warning: contact stack output ChatTranscriptsTableName missing or empty; chat Lambda will not write transcripts (admin transcript tab stays empty)." >&2
  fi
  CHAT_ALARM_EMAIL="${CHAT_ERROR_ALARM_EMAIL:-${ALARM_EMAIL:-}}"
  if [[ -n "${CHAT_ALARM_EMAIL}" ]]; then
    CHAT_PO+=("ChatErrorAlarmEmail=${CHAT_ALARM_EMAIL}")
  fi
  # Same alert values as every other chat host (resolved once, far above). sam_param_override
  # because a from-address may legitimately contain spaces ("Site <noreply@…>") and the SAM
  # shorthand splits unquoted values on them.
  if [[ "${CHAT_ALERTS_LIT}" == "true" ]]; then
    CHAT_PO+=("$(sam_param_override ResendApiKey "${RESEND_API_KEY}")")
    CHAT_PO+=("$(sam_param_override ChatAlertEmail "${CHAT_ALERT_TO}")")
    CHAT_PO+=("$(sam_param_override ChatAlertFromEmail "${CHAT_ALERT_FROM}")")
  fi
  # No ChatAlertCooldownSeconds here: aws/chat-template.yaml declares no such parameter and an
  # unknown parameter key fails the whole deploy. Cooldown is an ECS-Express-only knob.
  chat_alerts_echo "lambda-httpapi ${CHAT_STACK_RESOLVED}"
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

  # ECS Express Mode is the only path that uses THIS image (ECS+ALB and App Runner retired,
  # ADR-0007). CHAT_DEPLOY_TARGET=stream is handled in its own top-level block below — it builds a
  # different image — and any other value already exited 1 near the top of this script.
  if [[ "${CHAT_DEPLOY_TARGET}" == "express" ]]; then
    # ---- ECS Express Mode chat (aws/chat-express-template.yaml) — ADR-0007 Phase 3 ----
    # App Runner is in maintenance mode (no new customers from 2026-04-30); ECS Express
    # Mode is AWS's managed successor. Same "image + port -> HTTPS" model (Fargate + an
    # ECS-managed ALB/TLS/autoscaling/SGs) on the supported platform. Like the App Runner
    # path: a plain stateless container (Phase 1 voice is browser-direct), the frontend
    # chat meta is pinned per-env in committed HTML, and CFN deploy is create-or-update
    # (an image-only change rolls the service).
    CHAT_EXPRESS_STACK="${CHAT_EXPRESS_STACK_NAME:-gvp-chat-express-${DEPLOY_ENV}}"
    if [[ -z "${GEMINI_API_KEY:-}" ]]; then
      echo "ERROR: GEMINI_API_KEY required for chat ECS Express deploy." >&2
      exit 1
    fi
    echo "cfn deploy chat ECS Express stack=${CHAT_EXPRESS_STACK} env=${DEPLOY_ENV} image=${REMOTE_SHA}"
    CHAT_EX_PO=(
      "StageName=${DEPLOY_ENV}"
      "ImageUri=${REMOTE_SHA}"
      "GeminiApiKey=${GEMINI_API_KEY}"
      "GeminiModel=${GEMINI_MODEL:-gemini-3.1-flash-lite}"
      "GeminiFallbackModel=${GEMINI_FALLBACK_MODEL:-gemma-4-26b-a4b-it}"
      "GeminiLiveModel=${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}"
      "ChatVoiceModel=${CHAT_VOICE_MODEL:-${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}}"
      "ChatCorsOrigins=${CHAT_CORS_ORIGINS:-https://chat.marwanelgendy.link,https://marwanelgendy.link,https://www.marwanelgendy.link}"
      "SmokeProbeKey=${SMOKE_PROBE_KEY:-}"
    )
    if [[ -n "${CHAT_TRANSCRIPTS_TABLE_NAME:-}" ]]; then
      CHAT_EX_PO+=("ChatTranscriptsTableName=${CHAT_TRANSCRIPTS_TABLE_NAME}")
    fi
    # Instant chat-degradation alerts (model switch / timeout / rate-limit / breakage).
    # Values resolved once far above and shared with the Lambda hosts; same inputs, same result
    # here as before the hoist. ChatAlertCooldownSeconds exists ONLY on this template.
    if [[ "${CHAT_ALERTS_LIT}" == "true" ]]; then
      CHAT_EX_PO+=("ResendApiKey=${RESEND_API_KEY}")
      CHAT_EX_PO+=("ChatAlertEmail=${CHAT_ALERT_TO}")
      CHAT_EX_PO+=("ChatAlertFromEmail=${CHAT_ALERT_FROM}")
      if [[ -n "${CHAT_ALERT_COOLDOWN_SECONDS:-}" ]]; then
        CHAT_EX_PO+=("ChatAlertCooldownSeconds=${CHAT_ALERT_COOLDOWN_SECONDS}")
      fi
    fi
    chat_alerts_echo "ecs-express ${CHAT_EXPRESS_STACK}"
    aws cloudformation deploy \
      --template-file "${AWS_DIR}/chat-express-template.yaml" \
      --stack-name "${CHAT_EXPRESS_STACK}" \
      --region "${REGION}" \
      --capabilities CAPABILITY_NAMED_IAM \
      --no-fail-on-empty-changeset \
      --parameter-overrides "${CHAT_EX_PO[@]}"
    CHAT_EXPRESS_URL="$(aws cloudformation describe-stacks \
      --stack-name "${CHAT_EXPRESS_STACK}" \
      --region "${REGION}" \
      --query "Stacks[0].Outputs[?OutputKey=='ServiceUrl'].OutputValue | [0]" \
      --output text 2>/dev/null || true)"
    echo "chat ECS Express ServiceUrl=${CHAT_EXPRESS_URL}"
    CLUSTER=""
    SERVICE=""

  fi  # chat ECS Express deploy
elif [[ "${CHAT_ALWAYS_BUILD:-0}" == "1" ]]; then
  echo "CHAT_ECR_REPOSITORY_URI unset — chat image built locally as ${CHAT_IMAGE_LOCAL} only."
fi

# ---- CHAT_DEPLOY_TARGET=stream — Lambda RESPONSE_STREAM + CloudFront/OAC (ADR-0022 §16, §20.5) ----
# A separate TOP-LEVEL block, deliberately not an arm of the Express image block above:
#   * it is a DIFFERENT image (docker/chat/Dockerfile.lambda-stream, named in the template's
#     Metadata), so it must not be gated on the Express docker push, on CHAT_ECR_REPOSITORY_URI,
#     or on run_chat_docker — gating it there would recreate the silent no-op this replaces;
#   * `aws cloudformation deploy` CANNOT deploy it: PackageType: Image means the ImageUri only
#     exists after `sam build`, and the plain CFN deploy fails with "Image not found for ImageUri".
# These two stacks were previously deployed BY HAND, which is how hand-rolled --parameter-overrides
# left the alert parameters empty on this host in the first place.
if [[ "${CHAT_DEPLOY_TARGET}" == "stream" ]]; then
  CHAT_STREAM_STACK="${CHAT_STREAM_STACK_NAME:-gvp-chat-lambda-stream-${DEPLOY_ENV}}"
  CHAT_STREAM_CDN_STACK="${CHAT_STREAM_CDN_STACK_NAME:-gvp-chat-stream-cdn-${DEPLOY_ENV}}"
  require GEMINI_API_KEY

  # aws/chat-stream-template.yaml defaults ChatTranscriptsTableName to a STAGE-SPECIFIC table
  # name, so an unresolved value would silently point PROD at the staging table (and the IAM
  # policy at the wrong ARN). Refuse rather than deploy that.
  if [[ -z "${CHAT_TRANSCRIPTS_TABLE_NAME:-}" ]]; then
    echo "error: contact stack ${STACK_NAME} returned no ChatTranscriptsTableName output — refusing the stream deploy." >&2
    echo "  aws/chat-stream-template.yaml defaults that parameter to a stage table name, so deploying ${DEPLOY_ENV} without it would write transcripts to the wrong table." >&2
    exit 1
  fi

  # AWS_IAM, NOT the template's NONE default. Anonymous Function URLs are blocked account-wide on
  # this account (ADR-0022 §23.1 — measured 403 AccessDeniedException in two regions), and the CDN
  # stack's lambda:InvokeFunctionUrl grant is conditioned on FunctionUrlAuthType: AWS_IAM. Letting
  # the template default stand would deploy a host that cannot answer a single request.
  CHAT_STREAM_AUTH_TYPE="${CHAT_STREAM_FUNCTION_URL_AUTH_TYPE:-AWS_IAM}"

  CHAT_STREAM_PO=(
    # StageName → CHAT_ENV → the "[chat alert · {env}]" subject (alerts.py:97-103). The template
    # default is `stage`; omitting it on a prod deploy labels prod alerts as stage.
    "$(sam_param_override StageName "${DEPLOY_ENV}")"
    "$(sam_param_override GeminiApiKey "${GEMINI_API_KEY}")"
    "$(sam_param_override GeminiModel "${GEMINI_MODEL:-gemini-3.1-flash-lite}")"
    "$(sam_param_override GeminiFallbackModel "${GEMINI_FALLBACK_MODEL:-gemma-4-26b-a4b-it}")"
    "$(sam_param_override GeminiLiveModel "${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}")"
    "$(sam_param_override ChatCorsOrigins "${CHAT_CORS_ORIGINS:-https://chat.marwanelgendy.link,https://marwanelgendy.link,https://www.marwanelgendy.link}")"
    "$(sam_param_override ChatTranscriptsTableName "${CHAT_TRANSCRIPTS_TABLE_NAME}")"
    "$(sam_param_override FunctionUrlAuthType "${CHAT_STREAM_AUTH_TYPE}")"
  )
  if [[ "${CHAT_ALERTS_LIT}" == "true" ]]; then
    CHAT_STREAM_PO+=("$(sam_param_override ResendApiKey "${RESEND_API_KEY}")")
    CHAT_STREAM_PO+=("$(sam_param_override ChatAlertEmail "${CHAT_ALERT_TO}")")
    CHAT_STREAM_PO+=("$(sam_param_override ChatAlertFromEmail "${CHAT_ALERT_FROM}")")
  fi

  # Tier 2 (ADR-0022 §29.4, invariant 19). SEPARATE from the three above and not gated on
  # CHAT_ALERTS_LIT, because the two tiers fail independently: those three feed the in-process
  # Resend send, which §25.3-M MEASURED as LOST on Lambda, while this one feeds the metric
  # filter alarm that is the only path which actually delivers there. Gating Tier 2 on the
  # Tier-1 email config would make the working channel depend on the broken one.
  # The log group and the metric filter deploy unconditionally; an empty value here skips only
  # the topic and the alarm, leaving a complete, queryable Tier-1 record.
  # Reuses the same resolved recipient as the email tier so it needs no extra setup.
  CHAT_STREAM_ALARM_EMAIL="${CHAT_ALERT_ALARM_EMAIL:-${CHAT_ALERT_TO:-${ALARM_EMAIL:-}}}"
  if [[ -n "${CHAT_STREAM_ALARM_EMAIL}" ]]; then
    CHAT_STREAM_PO+=("$(sam_param_override ChatAlertAlarmEmail "${CHAT_STREAM_ALARM_EMAIL}")")
    echo "chat tier-2 alert alarm [lambda-stream ${CHAT_STREAM_STACK}]: ON -> ${CHAT_STREAM_ALARM_EMAIL}"
    echo "  NOTE: an SNS email subscription must be CONFIRMED before it delivers. Verify with:"
    echo "    aws sns list-subscriptions --region ${REGION} --query \"Subscriptions[?SubscriptionArn=='PendingConfirmation'].[TopicArn,Endpoint]\" --output table"
  else
    echo "chat tier-2 alert alarm [lambda-stream ${CHAT_STREAM_STACK}]: no topic (set CHAT_ALERT_ALARM_EMAIL or ALARM_EMAIL) — log group and metric still created" >&2
  fi
  # Reconciled against the template's Parameters: block. NOT passed, because it declares no such
  # parameter and an unknown parameter key fails the whole deploy: ChatAlertCooldownSeconds (ECS
  # Express only, refused here by the architect), ChatVoiceModel, SmokeProbeKey,
  # ChatErrorAlarmEmail. /api/chat/smoke therefore stays a default-behavior (HttpApi) route.
  chat_alerts_echo "lambda-stream ${CHAT_STREAM_STACK}"

  # ReservedConcurrency is NOT passed by default: the template's own default (5) is the intended
  # value and a second hardcoded copy here is how the two drift apart. 0 is REFUSED — to this
  # template 0 means "do not reserve" (UNBOUNDED, via HasReservedConcurrency), the opposite of the
  # Lambda API's "disabled", so it is not a kill switch. The kill switch is out of band:
  #   aws lambda put-function-concurrency --function-name <fn> --reserved-concurrent-executions 0
  if [[ -n "${CHAT_STREAM_RESERVED_CONCURRENCY:-}" ]]; then
    if ! [[ "${CHAT_STREAM_RESERVED_CONCURRENCY}" =~ ^[1-9][0-9]*$ ]]; then
      echo "error: CHAT_STREAM_RESERVED_CONCURRENCY must be a positive integer (got '${CHAT_STREAM_RESERVED_CONCURRENCY}')." >&2
      echo "  0 means 'do not reserve' (unbounded) to aws/chat-stream-template.yaml, not 'disabled'. To stop the function, use: aws lambda put-function-concurrency --reserved-concurrent-executions 0" >&2
      exit 1
    fi
    CHAT_STREAM_PO+=("$(sam_param_override ReservedConcurrency "${CHAT_STREAM_RESERVED_CONCURRENCY}")")
  else
    # CloudFormation reuses the PREVIOUS value of any parameter a deploy does not override, so on
    # an already-deployed stack the template default does not apply. Say so when the live value is
    # the overloaded 0, instead of letting an unbounded host look capped.
    CHAT_STREAM_PREV_RC="$(aws cloudformation describe-stacks \
      --stack-name "${CHAT_STREAM_STACK}" \
      --region "${REGION}" \
      --query "Stacks[0].Parameters[?ParameterKey=='ReservedConcurrency'].ParameterValue | [0]" \
      --output text 2>/dev/null || true)"
    if [[ "${CHAT_STREAM_PREV_RC}" == "0" ]]; then
      echo "warning: ${CHAT_STREAM_STACK} currently has ReservedConcurrency=0 — NOT reserved, i.e. unbounded." >&2
      echo "  CloudFormation keeps the previous value for parameters this deploy does not override, so the template default of 5 will NOT take effect on its own." >&2
      echo "  Adopt the cap once with CHAT_STREAM_RESERVED_CONCURRENCY=5 (ADR-0022 M-4)." >&2
    fi
  fi

  echo "sam build chat stream (${AWS_DIR}/chat-stream-template.yaml → .aws-sam/build-chat-stream)"
  (
    cd "${AWS_DIR}"
    # Dedicated --build-dir: .aws-sam/build-chat belongs to chat-template.yaml / npm run sam:build:chat.
    sam build --template-file chat-stream-template.yaml --build-dir .aws-sam/build-chat-stream
  )

  # An image package needs somewhere to push to. --resolve-image-repos is the default because it is
  # what the existing stacks were deployed with (SAM's managed <stack>-*-CompanionStack holds their
  # ECR repo); pointing this at CHAT_ECR_REPOSITORY_URI would relocate the images into the ECS
  # Express repo, which is a different image for a different host.
  CHAT_STREAM_IMAGE_ARGS=(--resolve-image-repos)
  if [[ -n "${CHAT_STREAM_IMAGE_REPOSITORY:-}" ]]; then
    CHAT_STREAM_IMAGE_ARGS=(--image-repository "${CHAT_STREAM_IMAGE_REPOSITORY}")
  fi

  echo "sam deploy chat stream stack=${CHAT_STREAM_STACK} env=${DEPLOY_ENV} region=${REGION} auth=${CHAT_STREAM_AUTH_TYPE}"
  (
    cd "${AWS_DIR}"
    sam deploy \
      --template-file .aws-sam/build-chat-stream/template.yaml \
      --stack-name "${CHAT_STREAM_STACK}" \
      --capabilities CAPABILITY_IAM \
      --no-confirm-changeset \
      --no-fail-on-empty-changeset \
      --resolve-s3 \
      "${CHAT_STREAM_IMAGE_ARGS[@]}" \
      --region "${REGION}" \
      --parameter-overrides "${CHAT_STREAM_PO[@]}"
  )

  CHAT_STREAM_FN_NAME="$(stack_output "${CHAT_STREAM_STACK}" ChatStreamFunctionName)"
  CHAT_STREAM_FN_HOST="$(url_host "$(stack_output "${CHAT_STREAM_STACK}" ChatStreamFunctionUrl)")"
  if [[ -z "${CHAT_STREAM_FN_NAME}" || -z "${CHAT_STREAM_FN_HOST}" ]]; then
    echo "error: ${CHAT_STREAM_STACK} returned no ChatStreamFunctionName / ChatStreamFunctionUrl — cannot wire ${CHAT_STREAM_CDN_STACK}." >&2
    exit 1
  fi
  echo "ChatStreamFunctionName=${CHAT_STREAM_FN_NAME}"
  echo "ChatStreamFunctionUrlDomain=${CHAT_STREAM_FN_HOST}"

  # DEFAULT cache behavior origin: the chat HttpApi host for THIS env, so every non-streaming route
  # — POST /api/live/session above all, which mints a paid Live token — keeps API Gateway's
  # 5 rps / burst 10 throttle. Empty is the template's documented "gate mode": the default behavior
  # also targets the Function URL, which has no gateway in front of it.
  CHAT_STREAM_DEFAULT_ORIGIN="${CHAT_STREAM_DEFAULT_ORIGIN_DOMAIN:-}"
  if [[ -z "${CHAT_STREAM_DEFAULT_ORIGIN}" && -n "${CHAT_SAM_CHAT_URL}" && "${CHAT_SAM_CHAT_URL}" != "None" ]]; then
    CHAT_STREAM_DEFAULT_ORIGIN="$(url_host "${CHAT_SAM_CHAT_URL}")"
  fi
  if [[ -z "${CHAT_STREAM_DEFAULT_ORIGIN}" && -n "${CHAT_STACK_RESOLVED}" ]]; then
    CHAT_STREAM_DEFAULT_ORIGIN="$(url_host "$(stack_output "${CHAT_STACK_RESOLVED}" ChatApiBaseUrl)")"
  fi
  if [[ -z "${CHAT_STREAM_DEFAULT_ORIGIN}" ]]; then
    echo "note: no chat HttpApi host found for the CloudFront DEFAULT behavior — deploying ${CHAT_STREAM_CDN_STACK} in gate mode, where every route (including POST /api/live/session) goes straight to the Function URL and loses the API Gateway throttle." >&2
    echo "  Set CHAT_SAM_STACK_NAME_STAGE / CHAT_SAM_STACK_NAME_PROD (so aws/chat-template.yaml deploys and exports ChatApiBaseUrl), or pass CHAT_STREAM_DEFAULT_ORIGIN_DOMAIN explicitly." >&2
  fi

  CHAT_STREAM_CDN_PO=(
    "StreamFunctionName=${CHAT_STREAM_FN_NAME}"
    "StreamFunctionUrlDomain=${CHAT_STREAM_FN_HOST}"
    "DefaultOriginDomainName=${CHAT_STREAM_DEFAULT_ORIGIN}"
    "DefaultOriginPath=${CHAT_STREAM_DEFAULT_ORIGIN_PATH:-}"
  )
  echo "cfn deploy chat stream CDN stack=${CHAT_STREAM_CDN_STACK} default-origin=${CHAT_STREAM_DEFAULT_ORIGIN:-<gate mode: the function url itself>}"
  # Plain CFN deploy, not sam: no image, no transform.
  aws cloudformation deploy \
    --template-file "${AWS_DIR}/chat-stream-cdn-template.yaml" \
    --stack-name "${CHAT_STREAM_CDN_STACK}" \
    --region "${REGION}" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides "${CHAT_STREAM_CDN_PO[@]}"

  CHAT_STREAM_CDN_DOMAIN="$(stack_output "${CHAT_STREAM_CDN_STACK}" DistributionDomainName)"
  echo "chat stream DistributionDomainName=${CHAT_STREAM_CDN_DOMAIN}"
  if [[ -n "${CHAT_STREAM_CDN_DOMAIN}" ]]; then
    # One throwaway request (ADR-0022 §20.5) so the deploy pays the ~11 s image-layer pull instead
    # of a visitor — and it doubles as the post-deploy health read. Best effort: a brand-new
    # distribution takes minutes to propagate, so a non-200 here is reported, not fatal.
    CHAT_STREAM_HEALTH="$(curl -s -o /dev/null -m 90 -w '%{http_code}' "https://${CHAT_STREAM_CDN_DOMAIN}/health" 2>/dev/null || echo 000)"
    echo "chat stream health: GET https://${CHAT_STREAM_CDN_DOMAIN}/health -> ${CHAT_STREAM_HEALTH}"
    if [[ "${CHAT_STREAM_HEALTH}" != "200" ]]; then
      echo "warning: chat stream /health returned ${CHAT_STREAM_HEALTH} (000 = no response at all). A fresh CloudFront distribution needs several minutes to propagate; re-check before sending traffic." >&2
    fi
  fi
  echo "note: gvp:chat-api-url in index.html / admin/index.html is NOT repointed by this target. Invariant 11 pins those hosts and test/frontend-api-url-env-guard.test.mjs enforces them — repointing is a separate, deliberate commit."
  # Liveness of the alert gate is NOT provable from here (presence of the keys is pinned by
  # test/chat-alert-gate-env.test.mjs; the VALUES are deploy-time). Verify on the deployed
  # function per ADR-0022 §27.1 B-5, e.g. GET /api/chat/host-status with the admin key.
fi

# Under CHAT_DEPLOY_TARGET=stream the operative chat host is the CloudFront front door, and
# repointing gvp:chat-api-url is a separate, deliberate commit (invariant 11 +
# test/frontend-api-url-env-guard.test.mjs). So that target NEVER auto-derives the meta: neither the
# CDN domain nor this run's HttpApi URL feeds it — only an explicit CHAT_{PROD,STAGE}_CHAT_API_URL,
# exactly as a hand-set override always did. For `express` this is CHAT_SAM_CHAT_URL unchanged.
CHAT_META_AUTO_CHAT_URL="${CHAT_SAM_CHAT_URL}"
if [[ "${CHAT_DEPLOY_TARGET}" == "stream" ]]; then
  CHAT_META_AUTO_CHAT_URL=""
fi
if [[ "${DEPLOY_ENV}" == "stage" ]]; then
  CHAT_SYNC_CHAT_URL="${CHAT_STAGE_CHAT_API_URL:-${CHAT_META_AUTO_CHAT_URL}}"
else
  CHAT_SYNC_CHAT_URL="${CHAT_PROD_CHAT_API_URL:-${CHAT_META_AUTO_CHAT_URL}}"
fi

if [[ "${SYNC_API_URLS:-1}" == "1" || "${SYNC_API_URLS:-}" == "true" ]]; then
  if [[ -n "${CHAT_SYNC_CHAT_URL}" ]]; then
    node "${ROOT}/scripts/sync-site-api-urls.mjs" "${CONTACT_URL}" "${CHAT_SYNC_CHAT_URL}"
    echo "Patched index.html and admin/index.html (gvp:contact-api-url, gvp:chat-api-url)."
  else
    node "${ROOT}/scripts/sync-site-api-urls.mjs" "${CONTACT_URL}"
    echo "Patched index.html and admin/index.html (gvp:contact-api-url)."
  fi
  if [[ "${DEPLOY_ENV}" == "stage" && -z "${CHAT_SYNC_CHAT_URL}" ]]; then
    if [[ "${CHAT_DEPLOY_TARGET}" == "stream" ]]; then
      echo "note: gvp:chat-api-url left exactly as committed — by design for CHAT_DEPLOY_TARGET=stream (invariant 11). Set CHAT_STAGE_CHAT_API_URL only when you deliberately mean to repoint the host." >&2
    else
      echo "note: no chat URL for meta — set CHAT_STAGE_CHAT_API_URL, or deploy ECS Express chat (CHAT_DEPLOY_TARGET=express + GEMINI + ECR URI), or Lambda chat (CHAT_SAM_STACK_NAME_* + GEMINI_API_KEY)." >&2
    fi
  fi
fi

echo
echo "=== Voice readiness (${DEPLOY_ENV}) ==="
echo "  chat URL          : ${CHAT_SYNC_CHAT_URL:-<unset>}"
if [[ -z "${CHAT_SYNC_CHAT_URL:-}" && "${CHAT_DEPLOY_TARGET}" == "stream" ]]; then
  # Not a warning: the stream target deliberately never derives the meta, so the committed
  # gvp:chat-api-url (the CloudFront front door) is still the live value.
  echo "  status            : OK — meta untouched by design; the committed gvp:chat-api-url still points at the chat host for this env"
elif [[ -z "${CHAT_SYNC_CHAT_URL:-}" ]]; then
  echo "  status            : WARN no chat URL — text chat fails until gvp:chat-api-url is patched"
else
  # Voice is browser-direct: the browser opens the Google Live API itself after
  # POST /api/live/session mints an ephemeral token, so any HTTPS chat host works
  # (no server WebSocket / relay; ADR-0007 Phase 1).
  echo "  status            : OK — text + browser-direct voice (no server WebSocket needed)"
fi

if [[ -n "${CHAT_SYNC_CHAT_URL:-}" ]] && { [[ "${SYNC_API_URLS:-1}" == "1" ]] || [[ "${SYNC_API_URLS:-}" == true ]]; }; then
  echo "  publish           : push/sync patched index.html + admin to hosting (Amplify, etc.) — browsers need gvp:chat-api-url on the live static site"
fi

echo "Done (deploy env=${DEPLOY_ENV})."
