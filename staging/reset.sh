#!/bin/bash
# Empty staging: every list, table, run, cap and remembered paid fact. Keys and connected apps stay.
#   FLOWBOUND_STAGING_PROJECT=<project> staging/reset.sh          the data
#   FLOWBOUND_STAGING_PROJECT=<project> staging/reset.sh --all    keys and tokens too (Claude must then be connected again)
# Needs the Vercel command signed in to the team that owns the staging project. Its name is kept out of this repo:
# the owner has it. Once this folder is linked (.vercel/project.json, not in git) the name is not needed again.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .vercel/project.json ] || npx --yes vercel link --yes --project "${FLOWBOUND_STAGING_PROJECT:?Say which Vercel project is staging: FLOWBOUND_STAGING_PROJECT=<its name> staging/reset.sh}" >/dev/null
env=$(mktemp)
trap 'rm -f "$env"' EXIT
npx --yes vercel env pull "$env" --environment production --yes >/dev/null
KEEP=""
[ "${1:-}" = "--all" ] || KEEP="fb_keys,fb_door"
node --env-file="$env" --input-type=module -e '
import pg from "pg"
const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL })
await db.connect()
const keep = process.argv[1].split(",")
const schemas = (await db.query("select nspname from pg_namespace where nspname like $1", ["fb\\_%"])).rows.map((r) => r.nspname).filter((s) => !keep.includes(s))
// fb_postgres.migrations is the note of which table changes are applied: it stays, or they would run twice.
for (const s of schemas) for (const t of (await db.query("select tablename from pg_tables where schemaname = $1 and tablename <> $2", [s, "migrations"])).rows) await db.query(`truncate "${s}"."${t.tablename}" restart identity cascade`)
const tables = (await db.query("select tablename from pg_tables where schemaname = $1", ["public"])).rows.map((r) => r.tablename)
for (const t of tables) await db.query(`drop table public."${t}" cascade`)
console.log(`Emptied ${schemas.join(", ")}; dropped ${tables.length} table(s) of lists and results.`)
await db.end()
' "$KEEP"
