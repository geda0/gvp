#!/usr/bin/env bash
# Local CI/CD: seed local config + push file secrets to AWS Secrets Manager, then SAM deploy.
#
# Prereq: aws CLI + SAM CLI; copy secrets.example → .secrets and fill
#   - deploy.env (from secrets.example/deploy.env.example — canonical list of deploy var names)
#   - manifest.json (optional file secrets)
#   - config.manifest.json (optional non-secret config exports)
# See secrets.example/README.md
#
# Optional: SECRETS_DIR=/path/to/.secrets bash scripts/orchestrate-deploy.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="${SECRETS_DIR:-$ROOT/.secrets}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"

if [[ ! -f "$SECRETS_DIR/manifest.json" ]]; then
  echo "error: missing $SECRETS_DIR/manifest.json" >&2
  echo "  cp -R \"$ROOT/secrets.example\" \"$ROOT/.secrets\" && edit files (see secrets.example/README.md)" >&2
  exit 1
fi

if [[ ! -f "$SECRETS_DIR/config.manifest.json" ]]; then
  echo "error: missing $SECRETS_DIR/config.manifest.json" >&2
  echo "  cp -R \"$ROOT/secrets.example\" \"$ROOT/.secrets\" && edit files (see secrets.example/README.md)" >&2
  exit 1
fi

if [[ ! -f "$SECRETS_DIR/deploy.env" ]]; then
  echo "error: missing $SECRETS_DIR/deploy.env (copy from secrets.example/deploy.env.example)" >&2
  exit 1
fi

export AWS_DEFAULT_REGION="${REGION}"

echo "Seeding local config exports (config.manifest.json)…"
python3 "$ROOT/scripts/seed_local_configs.py" --secrets-dir "$SECRETS_DIR"

echo "Pushing local files to Secrets Manager (manifest)…"
python3 "$ROOT/scripts/push_local_secrets_to_sm.py" --secrets-dir "$SECRETS_DIR" --region "${REGION}"

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

echo "Running SAM integrate + deploy…"
bash "$ROOT/scripts/integrate-and-deploy.sh"
