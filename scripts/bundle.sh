#!/usr/bin/env bash
# Builds dist/dex.tar.gz, which DEX hosts download and run with node:22-alpine.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd web && npm ci && NODE_ENV=production npm run build)
(cd server && npm ci --omit=dev)

rm -rf dist
mkdir -p dist/dex/web
cp -R server dist/dex/server
rm -rf dist/dex/server/.data dist/dex/server/test
cp -R web/out dist/dex/web/out
cp -R artifacts dist/dex/artifacts
cp run.sh dist/dex/run.sh
tar -czf dist/dex.tar.gz -C dist dex
echo "Built $(pwd)/dist/dex.tar.gz"
