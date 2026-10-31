#!/usr/bin/env bash
# Build and deploy mundi.bill.computer.
set -euo pipefail
cd "$(dirname "$0")"
npm run build
CLOUDFLARE_API_TOKEN=$(tr -d ' \r\n' < "$HOME/.config/cloudflare/api-token") \
  npx --yes wrangler@4 deploy
