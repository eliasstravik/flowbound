#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
pack="$root/.flowbound/hosted-package"
mkdir -p "$pack"
npm run build
archive=$(npm pack --silent --pack-destination "$pack")
cd hosted
npm install --no-save --no-package-lock --no-fund --no-audit "$pack/$archive"
../node_modules/.bin/tsc --noEmit -p tsconfig.json
npx --no flowbound deploy --build-only
if [ "${FLOWBOUND_DEMO:-}" = 1 ]; then
  node --input-type=module <<'JS'
import fs from "node:fs"
const path = ".vercel/output/config.json"
const config = JSON.parse(fs.readFileSync(path, "utf8"))
config.crons = [{ path: "/demo/reset", schedule: "0 2 * * *" }]
fs.writeFileSync(path, JSON.stringify(config, null, 2))
JS
fi
mkdir -p "$root/.vercel"
rm -rf "$root/.vercel/output"
mv .vercel/output "$root/.vercel/output"
