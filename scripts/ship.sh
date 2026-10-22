#!/usr/bin/env bash
# Default workflow: local tests → deploy → prod tests. Docs + commit are done after this passes (see CLAUDE.md).
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/test-local.sh
printf '\n\033[1;36m▶ deploy\033[0m\n'
npm run -s deploy
bash scripts/test-prod.sh
echo
echo "Next: update docs/CHANGELOG.md, docs/PROGRESS.md, docs/ISSUES.md → git commit → git push (when remote exists)."
