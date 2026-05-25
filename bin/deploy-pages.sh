#!/usr/bin/env zsh
# Build tac-twin-dev and deploy to Cloudflare Pages.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR/tac-twin-dev"

echo "→ building tac-twin-dev/"
npm install --silent
npm run build

echo "→ deploying dist/ to Cloudflare Pages project 'tac-twin'"
cd "$PROJECT_DIR"
npx wrangler pages deploy tac-twin-dev/dist \
  --project-name tac-twin \
  --commit-dirty=true

echo
echo "✓ Deployed. URL printed above."
