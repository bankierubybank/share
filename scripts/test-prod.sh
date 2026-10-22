#!/usr/bin/env bash
# Prod gate: system/security/E2E against the deployed Worker, through Cloudflare Access (service token).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.test ] && set -a && . ./.env.test && set +a
export TARGET_URL="${PROD_URL:-https://share.bankierubybank.workers.dev}"
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  export CF_ACCESS_EXPECTED=1   # also assert requests WITHOUT the token are blocked by Access
else
  echo "⚠ No Access service token in .env.test — testing without Access (see .env.test.example)."
fi

step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
step "health $TARGET_URL"
curl -sf -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID:-}" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:-}" "$TARGET_URL/api/health"; echo
step "system";   npm run -s test:system
step "security"; npm run -s test:security
step "e2e (chromium, mobile-safari)"; npx playwright test --project=chromium --project=mobile-safari

printf '\n\033[1;32m✔ prod tests passed\033[0m\n'
