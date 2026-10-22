#!/usr/bin/env bash
# Local gate: typecheck → unit → build → integration → (wrangler dev) system/security/E2E-compat.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8787
export TARGET_URL="http://localhost:$PORT"
# Firefox excluded by default: Playwright's Firefox fails to launch on this macOS (see docs/ISSUES.md #1).
COMPAT_PROJECTS=${COMPAT_PROJECTS:-"chromium webkit mobile-chrome mobile-safari"}

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

step "typecheck";   npm run -s typecheck
step "unit";        npm run -s test:unit
step "build";       npm run -s build
step "integration"; npm run -s test:integration
step "migrate local D1"; npx wrangler d1 migrations apply share-db --local >/dev/null

STARTED=""
if ! curl -sf "$TARGET_URL/api/health" >/dev/null; then
  step "start wrangler dev"
  npx wrangler dev --port "$PORT" >.wrangler-dev.log 2>&1 &
  STARTED=$!
  trap '[ -n "$STARTED" ] && kill $STARTED 2>/dev/null || true' EXIT
  for _ in $(seq 1 60); do curl -sf "$TARGET_URL/api/health" >/dev/null && break; sleep 1; done
fi

step "system";   npm run -s test:system
step "security"; npm run -s test:security
args=(); for p in $COMPAT_PROJECTS; do args+=(--project="$p"); done
step "e2e + compatibility ($COMPAT_PROJECTS)"; npx playwright test "${args[@]}"

printf '\n\033[1;32m✔ local tests passed\033[0m\n'
