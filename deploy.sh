#!/usr/bin/env bash
# Build the web app and deploy the whole stack to AWS.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building web app"
(cd web && npm ci && npm run build)

echo "==> Deploying"
(cd infra && cdk deploy --all --require-approval never "$@")
