#!/usr/bin/env bash
# Render and apply the CI deploy roles' chat policy, per environment.
#
# WHY THIS FILE EXISTS. The inline policy `gvp-<env>-chat-deploy` was scoped to
# `stack/gvp-chat-express-<env>/*` — a stack that no longer exists (ECS Express was deleted;
# chat runs on Lambda + CloudFront). So every CI chat deploy was denied on the real stacks,
# and nothing in the repo recorded what the policy was supposed to say. Now it is a file.
#
# WHAT IT GRANTS, and why each line is here:
#   ChatCfnStacks   the stacks the deploy script actually creates — gvp-chat-<env> and its SAM
#                   CompanionStack, gvp-chat-lambda-stream-<env> and its CompanionStack,
#                   gvp-chat-stream-cdn-<env>, and gvp-chat-waf-<env> IN US-EAST-1 (WAFv2 for
#                   CloudFront is only ever us-east-1).
#   EcrPublicPull   ecr-public:GetAuthorizationToken + sts:GetServiceBearerToken. This is the
#                   ECR Public throttle blocker: without them `docker login public.ecr.aws`
#                   fails and the build falls back to an ANONYMOUS pull, which shares a tiny
#                   account-wide quota. A fallback that usually succeeds looks exactly like a
#                   step that worked — which is why this was invisible until it throttled.
#   EcrRepos        gvp-chat plus the `gvpchat*` repos SAM's --resolve-image-repos creates for
#                   the two PackageType: Image functions.
#   ChatCloudFront  the CDN stack: Distribution, Function, OriginAccessControl,
#                   ResponseHeadersPolicy. Scoped action list rather than cloudfront:*.
#   ChatWafv2       the prod per-IP rate ceiling (CHAT_STREAM_WAF defaults on for prod).
#   ChatBudgets     the stream stack's two AWS::Budgets::Budget guardrails (gvp-* only).
#   ChatIam         the function roles the two SAM stacks create.
#   NoEcsRevival    an explicit DENY on ecs / elasticloadbalancing / application-autoscaling /
#                   apprunner. ECS Express cost ~$41/mo and is retired; the deploy script still
#                   carries the `CHAT_DEPLOY_TARGET=express` branch for rollback. A Deny cannot
#                   be overridden by another policy on the role, so CI cannot restart that bill
#                   by accident or by a stale workflow input. Remove this statement — on purpose
#                   — if the Express path is ever deliberately revived.
#
# Everything else the chat deploy needs (lambda, logs, cloudwatch, sns, apigateway, the SAM S3
# bucket, cloudformation's global reads and the Serverless transform) is already granted by the
# sibling inline policy `gvp-<env>-deploy` on the same role; inline policies are additive.
#
# Usage:  bash aws/iam/apply-ci-policies.sh [--dry-run]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${HERE}/chat-deploy-policy.json"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "account ${ACCOUNT}"

# role name : env token used in resource ARNs : inline policy name
apply_one () {
  local role="$1" env="$2" policy="$3" rendered
  rendered="$(sed -e "s/__ACCOUNT__/${ACCOUNT}/g" -e "s/__ENV__/${env}/g" "${TEMPLATE}")"
  # Fail before the API call if the render left a placeholder or broke the JSON.
  printf '%s' "${rendered}" | python3 -c 'import json,sys; d=sys.stdin.read(); assert "__" not in d, "unrendered placeholder"; json.loads(d)'
  local bytes
  bytes="$(printf '%s' "${rendered}" | python3 -c 'import json,sys; print(len(json.dumps(json.load(sys.stdin),separators=(",",":"))))')"
  echo "  ${role} / ${policy} : ${bytes} bytes minified (inline limit 10240)"
  if (( DRY_RUN )); then
    echo "  --dry-run: not applied"
    return
  fi
  aws iam put-role-policy \
    --role-name "${role}" \
    --policy-name "${policy}" \
    --policy-document "${rendered}"
  echo "  applied"
}

apply_one gvp-prod-ci-deploy    prod  gvp-prod-chat-deploy
apply_one gvp-staging-ci-deploy stage gvp-staging-chat-deploy
