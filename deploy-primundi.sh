#!/usr/bin/env bash
# Build and deploy Primundi, primundi.bill.computer (wrangler.primundi.toml). Same build as Mundi;
# the copy in dist-primundi/ serves primundi.html as its front page. Never touches mundi.bill.computer.
set -euo pipefail
cd "$(dirname "$0")"
npm run build
rm -rf dist-primundi
cp -r dist dist-primundi
cp dist-primundi/primundi.html dist-primundi/index.html
CLOUDFLARE_API_TOKEN=$(tr -d ' \r\n' < "$HOME/.config/cloudflare/api-token") \
  npx --yes wrangler@4 deploy --config wrangler.primundi.toml
