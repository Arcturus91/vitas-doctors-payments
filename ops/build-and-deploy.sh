#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# vitas-payments-module — build & deploy script
#
# Usage (Vitas — defaults apply, no extra args needed):
#   ENVIRONMENT=dev ./ops/build-and-deploy.sh
#   ENVIRONMENT=prod ./ops/build-and-deploy.sh
#
# Usage (other project — pass the target API Gateway IDs):
#   ENVIRONMENT=dev REST_API_ID=abc123 ROOT_RESOURCE_ID=xyz789 ./ops/build-and-deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENVIRONMENT=${ENVIRONMENT:-dev}
REST_API_ID=${REST_API_ID:-}           # optional — falls back to CDK context default (Vitas)
ROOT_RESOURCE_ID=${ROOT_RESOURCE_ID:-} # optional — falls back to CDK context default (Vitas)
AWS_PROFILE=${AWS_PROFILE:-}           # optional — e.g. AWS_PROFILE=cloudforge-vitas
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " vitas-payments-module deploy"
echo " Environment:     $ENVIRONMENT"
[[ -n "$REST_API_ID" ]]      && echo " REST_API_ID:      $REST_API_ID"      || echo " REST_API_ID:      (default)"
[[ -n "$ROOT_RESOURCE_ID" ]] && echo " ROOT_RESOURCE_ID: $ROOT_RESOURCE_ID" || echo " ROOT_RESOURCE_ID: (default)"
[[ -n "$AWS_PROFILE" ]]      && echo " AWS_PROFILE:      $AWS_PROFILE"      || echo " AWS_PROFILE:      (default)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Install CDK dependencies ────────────────────────────────────────────
echo ""
echo "==> [1/4] Installing CDK dependencies..."
cd "$ROOT_DIR/cdk"
npm ci

# ── 2. Install lambda + authorizer dependencies (skip 'shared' — no package-lock) ──
echo ""
echo "==> [2/4] Installing lambda dependencies..."
for lambda_dir in "$ROOT_DIR/lambda"/*/; do
  dir_name="$(basename "$lambda_dir")"
  if [[ -f "$lambda_dir/package.json" ]] && [[ "$dir_name" != "shared" ]]; then
    echo "  -> lambda/$dir_name"
    (cd "$lambda_dir" && npm ci)
  fi
done

# Authorizer has its own package-lock (jsonwebtoken must be bundled by esbuild)
if [[ -f "$ROOT_DIR/authorizer/package-lock.json" ]]; then
  echo "  -> authorizer"
  (cd "$ROOT_DIR/authorizer" && npm ci)
fi

# ── Build CDK context + profile flags ───────────────────────────────────────
CDK_CONTEXT="-c stage=$ENVIRONMENT"
[[ -n "$REST_API_ID" ]]      && CDK_CONTEXT="$CDK_CONTEXT -c restApiId=$REST_API_ID"
[[ -n "$ROOT_RESOURCE_ID" ]] && CDK_CONTEXT="$CDK_CONTEXT -c rootResourceId=$ROOT_RESOURCE_ID"

CDK_PROFILE=""
[[ -n "$AWS_PROFILE" ]] && CDK_PROFILE="--profile $AWS_PROFILE"

# ── 3. CDK synth ────────────────────────────────────────────────────────────
echo ""
echo "==> [3/4] Synthesizing CDK stack..."
cd "$ROOT_DIR/cdk"
# shellcheck disable=SC2086
ENVIRONMENT="$ENVIRONMENT" npx cdk synth $CDK_CONTEXT $CDK_PROFILE

# ── 4. CDK deploy ──────────────────────────────────────────────────────────
echo ""
echo "==> [4/4] Deploying to AWS (environment: $ENVIRONMENT)..."
# Prod requires explicit approval for any IAM/security-group changes (broadening permissions).
# Dev deploys silently (--require-approval never) to speed up iteration.
APPROVAL_FLAG="--require-approval never"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  APPROVAL_FLAG="--require-approval broadening"
fi
# shellcheck disable=SC2086
ENVIRONMENT="$ENVIRONMENT" npx cdk deploy $APPROVAL_FLAG --all $CDK_CONTEXT $CDK_PROFILE

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Deploy complete — environment: $ENVIRONMENT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
