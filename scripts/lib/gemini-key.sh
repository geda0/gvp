# shellcheck shell=bash
#
# Per-environment Gemini API key resolution.
#
# WHY THIS EXISTS. Until 2026-10-14 both environments shared one GEMINI_API_KEY (verified:
# identical sha256 on the prod and stage stream functions). The free-tier quota
# `GenerateContentInputTokensPerModelPerMinute-FreeTier` = 16,000 input tokens/minute is
# scoped PER PROJECT, PER MODEL, so that is a single shared budget — and load on staging
# therefore degrades production chat for real visitors.
#
# That was not theoretical. On 2026-10-14, verifying a cache fix on stage (9 turns) exhausted
# the primary model, and a 4-turn check against PROD minutes later returned HTTP 429 on turns
# 3 and 4, with prod's telemetry showing every turn falling to the cold fallback. Nothing in
# the deploy path mentioned the coupling.
#
# WARN, DO NOT REFUSE — and the distinction is deliberate. The sibling guard on
# CHAT_SAM_STACK_NAME *refuses* when both arms resolve to one stack, because that is
# CORRUPTION: a prod deploy would write prod parameters into the stage stack. A shared API
# key only costs CAPACITY. Refusing would break every existing deploy on day one over a
# problem that degrades rather than destroys, so this resolves and warns instead.
#
# Sourced by scripts/integrate-and-deploy.sh. Kept in its own file so the resolution can be
# driven by a test without sourcing the monolith, which would execute a deploy
# (test/gemini-key-per-env.test.mjs).

# resolve_gemini_key <deploy_env>
#
# Sets GEMINI_API_KEY_RESOLVED to the key for <deploy_env> ("prod" or "stage"), preferring
# GEMINI_API_KEY_{PROD,STAGE} and falling back to the shared GEMINI_API_KEY. Warns on stderr
# when both environments would end up on the same key. Never exits non-zero on its own.
resolve_gemini_key() {
  local deploy_env="${1:-prod}"
  local mine other

  if [[ "${deploy_env}" == "stage" ]]; then
    mine="${GEMINI_API_KEY_STAGE:-${GEMINI_API_KEY:-}}"
    other="${GEMINI_API_KEY_PROD:-${GEMINI_API_KEY:-}}"
  else
    mine="${GEMINI_API_KEY_PROD:-${GEMINI_API_KEY:-}}"
    other="${GEMINI_API_KEY_STAGE:-${GEMINI_API_KEY:-}}"
  fi

  GEMINI_API_KEY_RESOLVED="${mine}"

  # The Secrets Manager ARN follows the SAME per-environment shape, deliberately: putting
  # both environments behind one secret would re-create the shared-credential coupling in a
  # new place. Empty is normal and means "keep using the plaintext env var".
  if [[ "${deploy_env}" == "stage" ]]; then
    GEMINI_API_KEY_SECRET_ARN_RESOLVED="${GEMINI_API_KEY_SECRET_ARN_STAGE:-${GEMINI_API_KEY_SECRET_ARN:-}}"
  else
    GEMINI_API_KEY_SECRET_ARN_RESOLVED="${GEMINI_API_KEY_SECRET_ARN_PROD:-${GEMINI_API_KEY_SECRET_ARN:-}}"
  fi

  if [[ -n "${mine}" && "${mine}" == "${other}" ]]; then
    echo "warning: prod and stage resolve to the SAME Gemini API key." >&2
    echo "  The free-tier quota (16,000 input tokens per minute) is per PROJECT per MODEL, so" >&2
    echo "  the two environments share one budget — load on stage degrades prod chat for real" >&2
    echo "  visitors, and a stage soak can 429 production." >&2
    echo "  Fix: mint a second key in AI Studio and set GEMINI_API_KEY_STAGE (prod can keep" >&2
    echo "  GEMINI_API_KEY, or set GEMINI_API_KEY_PROD explicitly)." >&2
  fi
}
