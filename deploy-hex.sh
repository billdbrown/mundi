#!/usr/bin/env bash
# Build this checkout and deploy it as the hex preview, mundi-hex.bill.computer (wrangler.hex.toml).
# Never touches mundi.bill.computer. Kept out of search engines.
set -euo pipefail
cd "$(dirname "$0")"
npm run build
printf '/*\n  X-Robots-Tag: noindex\n' > dist/_headers
CLOUDFLARE_API_TOKEN=$(tr -d ' \r\n' < "$HOME/.config/cloudflare/api-token") \
  npx --yes wrangler@4 deploy --config wrangler.hex.toml
