// An agent's read-only SQL sees the person's own tables and none of Flowbound's: the database refuses them, however
// the query is written. On PGlite always; on a real Postgres when FLOWBOUND_TEST_DATABASE_URL points at a throwaway one
// (its login needs the right to make roles), e.g. a Docker postgres:17-alpine.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type TestContext, test } from "node:test"
import type { Who } from "../src/core/plugin.ts"
import { boot } from "../src/core/server.ts"
import { door } from "../src/plugins/door.ts"
import { keys } from "../src/plugins/keys.ts"
import { ledger } from "../src/plugins/ledger.ts"
import { postgres } from "../src/plugins/postgres.ts"
import { schedules } from "../src/plugins/schedules.ts"
import { workflowSdk } from "../src/plugins/workflow-sdk.ts"
import { repo } from "./helpers.ts"

const agent: Who = { kind: "token", name: "an agent, for Sam", via: "mcp", role: "member" }
const editor: Who = { kind: "person", name: "Ed, who may edit but not manage", via: "api", role: "member" }
const you: Who = { kind: "local", name: "You", via: "api" }

/** Every way in that was tried. Each must be refused or come back empty, never with a secret in it. */
const TRICKS = [
  "select * from fb_door.people",
  'select * from "fb_door"."people"',
  "table fb_door.people",
  "select * from fb_door.tokens",
  "select * from fb_door.history",
  "select * from fb_ledger.yeses",
  "select * from fb_schedules.fired",
  "select * from fb_keys.keys",
  "with p as (select * from fb_door.people) select * from p",
  "select (select string_agg(email, ',') from fb_door.people) as e",
  "select * from target_list where exists (select 1 from fb_door.people)",
  "select query_to_xml('select * from fb_door.people', true, false, '')",
  "select table_to_xml('fb_door.people', true, false, '')",
  "select 1; reset role; select * from fb_door.people",
  "select 1; commit; select * from fb_door.people",
  "create view leak as select * from fb_door.people",
  "create temp table leak as select * from fb_door.people",
  "copy fb_door.people to stdout",
  "select * from pg_statistic",
  // Switching back to the login Flowbound itself uses: from a select (set_config) or a DO block (plpgsql).
  "select set_config('role', '{owner}', true), query_to_xml('select * from fb_door.people', true, false, '')",
  "select set_config('role', session_user, true), query_to_xml('select * from fb_door.people', true, false, '')",
  "do $$ begin execute 'set role {owner}'; raise exception '%', (select string_agg(email, ',') from fb_door.people); end $$",
  "do $$ begin execute 'set role ' || session_user; raise exception '%', (select string_agg(email, ',') from fb_door.people); end $$",
  "select pg_read_file('postgresql.conf')",
]
/** Allowed to run, but must not hold anything of Flowbound's own. */
const EMPTY = [
  "select table_schema, table_name from information_schema.tables where table_schema like 'fb\\_%'",
  "select table_name, column_name from information_schema.columns where table_schema like 'fb\\_%'",
  "select * from pg_stats where schemaname like 'fb\\_%'",
  "select * from information_schema.column_privileges where table_schema like 'fb\\_%'",
]
const SECRET = "sam.secret@acme.example"

async function wall(t: TestContext, url?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-wall-"))
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"))
  const app = await boot([postgres(url ? { url } : {}), ledger(), workflowSdk(), schedules(), keys(), door()], { root, url: "http://localhost:4999" })
  const fb = app.fb
  const sql = (query: string, who: Who): Promise<{ rows: any[] }> => fb.call("sql", { query }, who) as Promise<{ rows: any[] }>
  try {
    await sql("drop table if exists made_later, target_list", you)
    await fb.call("import", { csv: "company,domain\nStripe,stripe.com\nLinear,linear.app", csvName: "targets.csv" }, you)
    await sql(`insert into fb_door.people (email, name, role) values ('${SECRET}', 'Sam', 'manage') on conflict do nothing`, you)

    await t.test("the person's own tables still read, made before or after the start", async () => {
      assert.deepEqual((await sql("select company from target_list order by company", agent)).rows, [{ company: "Linear" }, { company: "Stripe" }])
      await sql("create table made_later (n int)", you)
      await sql("insert into made_later values (7)", you)
      assert.deepEqual((await sql("select n from made_later", agent)).rows, [{ n: 7 }])
      assert.deepEqual((await sql("select count(*)::int as n from public.target_list", editor)).rows, [{ n: 2 }])
    })

    await t.test("every one of Flowbound's own tables is refused", async () => {
      const own = (await sql("select schemaname || '.' || tablename as t from pg_tables where schemaname like 'fb\\_%' order by 1", you)).rows.map((r: any) => r.t)
      assert.ok(own.includes("fb_door.people") && own.includes("fb_door.history") && own.includes("fb_ledger.yeses") && own.length > 15, own.join(", "))
      for (const t of own) {
        for (const who of [agent, editor]) {
          await assert.rejects(sql(`select * from ${t}`, who), /permission denied/, `${t} as ${who.kind}`)
        }
      }
    })

    await t.test("no trick reads them", async (s) => {
      const owner = (await sql("select current_user as u", you)).rows[0].u
      for (const q of TRICKS.map((x) => x.replaceAll("{owner}", owner))) {
        const got = await sql(q, agent).then(
          (r) => JSON.stringify(r),
          (e) => `refused: ${e.message}`,
        )
        s.diagnostic(`${q}  →  ${got.slice(0, 110)}`)
        assert.ok(!got.includes(SECRET), `${q} leaked: ${got}`)
        assert.ok(got.startsWith("refused: "), `${q} ran: ${got}`)
      }
      for (const q of EMPTY) assert.deepEqual((await sql(q, agent)).rows, [], q)
    })

    await t.test("the trick left nothing behind: the next call is still the reader", async () => {
      await sql("set role postgres", agent).catch(() => {})
      await sql("reset role", agent).catch(() => {})
      await assert.rejects(sql("select * from fb_door.people", agent), /permission denied/)
      await assert.rejects(sql("insert into target_list (company) values ('x')", agent), /can read with SQL, not change/)
    })

    await t.test("on your own computer you still reach everything with SQL", async () => {
      assert.deepEqual((await sql(`select email from fb_door.people where email = '${SECRET}'`, you)).rows, [{ email: SECRET }])
    })
  } finally {
    if (url) await fb.call("sql", { query: "drop table if exists made_later, target_list" }, you).catch(() => {})
    await app.stop()
  }
}

test("PGlite: an agent's SQL sees only the person's tables", (t) => wall(t))
test("Postgres: an agent's SQL sees only the person's tables", { skip: !process.env.FLOWBOUND_TEST_DATABASE_URL && "no FLOWBOUND_TEST_DATABASE_URL" }, (t) => wall(t, process.env.FLOWBOUND_TEST_DATABASE_URL))
