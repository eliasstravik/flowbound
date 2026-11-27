#!/bin/bash
# The "any server of your own" home: the same project with workflowSdk({ on: "postgres" }), started with
# FLOWBOUND_LIVE=1 against a real Postgres, then the live walk-through, then a kill in the middle of a run.
# Needs: a Postgres at $DATABASE_URL with the runner's tables (npx --package=@workflow/world-postgres bootstrap),
# and the fake provider of test/fake-provider.mjs on port 4999.
#   usage: own-server.sh <project folder>   (a project as test/helpers.ts makes it, with targets.csv)
set -u
PROJECT=$1
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$PROJECT"
sed -i 's/workflowSdk()/workflowSdk({ on: "postgres" })/' flowbound.config.ts
export FLOWBOUND_LIVE=1 FLOWBOUND_SECRET=host-secret-for-test FLOWBOUND_PASSWORD=team-pass-1 FLOWBOUND_PORT=4140 FLOWBOUND_URL=http://localhost:4140 FLOWBOUND_RETRY_MS=50,100
export PORT=4140 WORKFLOW_POSTGRES_JOB_PREFIX=fbtest_
nohup node node_modules/flowbound/dist/core/bin.js dev > own-server.log 2>&1 &
for i in $(seq 1 80); do sleep 0.5; curl -s -o /dev/null http://localhost:4140/door && break; done
echo "started: $(grep -m1 'pages at' own-server.log)"
U=http://localhost:4140 bash "$HERE/walk-through.sh" "$PROJECT"
