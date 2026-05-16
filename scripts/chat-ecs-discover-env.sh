#!/usr/bin/env bash
# Discover CHAT_ECS_VPC_ID + CHAT_ECS_SUBNET_IDS for SAM ECS (ALB + Fargate).
# Prefers default VPC; otherwise first VPC with ≥2 subnets in distinct AZs (public subnets first).
#
# Usage:
#   eval "$(bash scripts/chat-ecs-discover-env.sh)"
#   bash scripts/chat-ecs-discover-env.sh >> .secrets/chat-deploy.env   # then chmod 600; review before commit
# Sourced by scripts/integrate-and-deploy.sh for SAM ECS deploy and the default voice ECS bootstrap (CHAT_VOICE_ECS_BOOTSTRAP=0 to opt out).
#
# Env: AWS_REGION or AWS_DEFAULT_REGION (default us-east-2); optional CHAT_ECR_REPO_NAME (default gvp-chat).
# CHAT_ECS_CREATE_DEFAULT_VPC=1|true|yes|on: if describe finds no usable VPC, run aws ec2 create-default-vpc (needs ec2:CreateDefaultVpc), then pick subnets.

chat_ecs_pick_subnets_two_azs() {
  local region="$1" vpc="$2"
  local public tmp n sid1 sid2
  for public in 1 0; do
    tmp="$(mktemp "${TMPDIR:-/tmp}/gvp-chat-ecs.XXXXXX")"
    local filter=(--filters "Name=vpc-id,Values=${vpc}")
    [[ "${public}" == 1 ]] && filter+=( "Name=map-public-ip-on-launch,Values=true" )

    aws ec2 describe-subnets --region "${region}" "${filter[@]}" \
      --query 'Subnets[].[AvailabilityZone,SubnetId]' --output text 2>/dev/null \
      | sort -t "$(printf '\t')" -k1,1 -k2,2 \
      | awk -F '\t' '!seen[$1]++' > "${tmp}" || true

    n="$(wc -l < "${tmp}" | tr -d ' ')"
    if [[ "${n}" -ge 2 ]]; then
      sid1="$(sed -n '1p' "${tmp}" | cut -f2)"
      sid2="$(sed -n '2p' "${tmp}" | cut -f2)"
      rm -f "${tmp}"
      echo "${sid1},${sid2}"
      return 0
    fi
    rm -f "${tmp}"
  done
  return 1
}

# Exports CHAT_ECS_VPC_ID and CHAT_ECS_SUBNET_IDS on success; returns 1 if none found.
gvp_chat_ecs_resolve_vpc_subnets() {
  local region="${1:?region}"
  local vpc subnets

  vpc="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text --region "${region}" 2>/dev/null || true)"
  if [[ -n "${vpc}" && "${vpc}" != "None" ]]; then
    subnets="$(chat_ecs_pick_subnets_two_azs "${region}" "${vpc}")" && {
      export CHAT_ECS_VPC_ID="${vpc}"
      export CHAT_ECS_SUBNET_IDS="${subnets}"
      return 0
    }
  fi

  for vpc in $(aws ec2 describe-vpcs --query 'Vpcs[].VpcId' --output text --region "${region}" 2>/dev/null | tr '\t' '\n' | sort -u); do
    subnets="$(chat_ecs_pick_subnets_two_azs "${region}" "${vpc}" 2>/dev/null)" || subnets=""
    [[ -z "${subnets}" ]] && continue
    export CHAT_ECS_VPC_ID="${vpc}"
    export CHAT_ECS_SUBNET_IDS="${subnets}"
    return 0
  done

  return 1
}

# CHAT_ECS_VPC_ID must be set; fills CHAT_ECS_SUBNET_IDS only.
gvp_chat_ecs_fill_subnets_for_set_vpc() {
  local region="${1:?region}"
  [[ -n "${CHAT_ECS_VPC_ID:-}" && -z "${CHAT_ECS_SUBNET_IDS:-}" ]] || return 1
  local subnets
  subnets="$(chat_ecs_pick_subnets_two_azs "${region}" "${CHAT_ECS_VPC_ID}")" || return 1
  export CHAT_ECS_SUBNET_IDS="${subnets}"
  return 0
}

# Returns 0 only after a successful create-default-vpc + subnet pick (exports CHAT_ECS_*).
_gvp_chat_ecs_create_default_vpc_if_enabled() {
  local region="${1:?region}"
  case "${CHAT_ECS_CREATE_DEFAULT_VPC:-}" in
    1|true|TRUE|True|yes|YES|Yes|on|ON) ;;
    *) return 1 ;;
  esac
  local dv out nv subnets i
  dv="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text --region "${region}" 2>/dev/null || true)"
  if [[ -n "${dv}" && "${dv}" != "None" ]]; then
    return 1
  fi
  echo "note: CHAT_ECS_CREATE_DEFAULT_VPC — aws ec2 create-default-vpc (${region}; IAM ec2:CreateDefaultVpc)…" >&2
  out="$(aws ec2 create-default-vpc --region "${region}" --output json 2>&1)" || true
  if echo "${out}" | grep -qiE 'DefaultVpcAlreadyExists|already exists|VpcLimitExceeded'; then
    echo "note: create-default-vpc not needed or limit hit; re-describing… (${out})" >&2
    gvp_chat_ecs_resolve_vpc_subnets "${region}" && return 0
    return 1
  fi
  nv="$(echo "${out}" | python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  print(d.get('Vpc',{}).get('VpcId','') or '')
except Exception:
  print('')" 2>/dev/null || true)"
  if [[ -z "${nv}" ]]; then
    echo "warning: create-default-vpc did not return a VpcId: ${out}" >&2
    return 1
  fi
  echo "  new default VPC ${nv}; waiting for subnets…" >&2
  for i in $(seq 1 40); do
    if subnets="$(chat_ecs_pick_subnets_two_azs "${region}" "${nv}" 2>/dev/null)"; then
      export CHAT_ECS_VPC_ID="${nv}"
      export CHAT_ECS_SUBNET_IDS="${subnets}"
      echo "  default VPC subnets ready (poll ${i})" >&2
      return 0
    fi
    sleep 2
  done
  echo "error: default VPC ${nv} created but no two-AZ subnet pair in time (check console)." >&2
  return 1
}

# Describe existing VPCs; optionally create regional default VPC once, then describe again.
gvp_chat_ecs_resolve_vpc_subnets_maybe_create() {
  local region="${1:?region}"
  if gvp_chat_ecs_resolve_vpc_subnets "${region}"; then
    return 0
  fi
  if _gvp_chat_ecs_create_default_vpc_if_enabled "${region}"; then
    return 0
  fi
  return 1
}

_chat_ecs_discover_print_exports() {
  local region="${1:?}"
  local acct repo uri
  acct="$(aws sts get-caller-identity --query Account --output text --region "${region}" 2>/dev/null || true)"
  if [[ -z "${acct}" || "${acct}" == "None" ]]; then
    echo "error: aws sts get-caller-identity failed; configure AWS CLI credentials." >&2
    return 1
  fi
  repo="${CHAT_ECR_REPO_NAME:-gvp-chat}"
  uri="${acct}.dkr.ecr.${region}.amazonaws.com/${repo}"

  if ! gvp_chat_ecs_resolve_vpc_subnets_maybe_create "${region}"; then
    echo "error: no VPC found with ≥2 subnets in distinct AZs (try public subnets in one VPC)." >&2
    echo "  Or set CHAT_ECS_CREATE_DEFAULT_VPC=1 and re-run (runs aws ec2 create-default-vpc in this region)." >&2
    echo "  Or set CHAT_ECS_VPC_ID and CHAT_ECS_SUBNET_IDS manually." >&2
    return 1
  fi

  echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/chat-ecs-discover-env.sh (review before relying in prod)."
  echo "export CHAT_ECS_VPC_ID=${CHAT_ECS_VPC_ID}"
  echo "export CHAT_ECS_SUBNET_IDS=${CHAT_ECS_SUBNET_IDS}"
  echo "export CHAT_ECR_REPOSITORY_URI=${uri}"
}

_main_chat_ecs_discover() {
  set -euo pipefail
  case "${1:-}" in
    -h|--help)
      echo "usage: bash scripts/chat-ecs-discover-env.sh"
      echo "  Prints export lines for CHAT_ECS_VPC_ID, CHAT_ECS_SUBNET_IDS, CHAT_ECR_REPOSITORY_URI"
      echo "  Uses AWS_REGION or AWS_DEFAULT_REGION (default us-east-2)."
      echo "  Optional: CHAT_ECS_CREATE_DEFAULT_VPC=1 runs create-default-vpc when describe finds nothing usable."
      exit 0
      ;;
  esac
  local region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
  _chat_ecs_discover_print_exports "${region}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _main_chat_ecs_discover "$@"
fi
