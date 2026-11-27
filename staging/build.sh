#!/bin/bash
# Vercel runs this on every new commit (see docs/staging.md). It installs Flowbound the way a user gets it,
# from a packed tarball of this commit, and builds this folder for Vercel with Flowbound's own deploy step.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
npm pack --silent
cd staging
npm install --no-save --no-audit --no-fund ../flowbound-*.tgz
../node_modules/.bin/tsc --noEmit -p tsconfig.json
npx flowbound workflow-check
if [[ "${1:-}" != --check ]]; then
  npx flowbound deploy --build-only
fi
