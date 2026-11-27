// The end of a run, step by step, inside this process: a run that starts by itself does not end while a row that
// arrived in the last moment is waiting. The moment is a few milliseconds wide, so it is set up by hand here.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boot } from "../src/core/server.ts"
import { keys, ledger, postgres, workflowSdk } from "../src/index.ts"
import { project } from "./helpers.ts"

let p: ReturnType<typeof project>
let app: Awaited<ReturnType<typeof boot>>

before(async () => {
  p = project("http://127.0.0.1:9")
  process.env.FLOWBOUND_HOME = p.home
  app = await boot([postgres(), workflowSdk({ on: "local" }), keys(), ledger()], { root: p.root, url: "http://localhost:0" })
})
after(async () => {
  await new Promise((r) => setTimeout(r, 300)) // let the runner finish starting before it is stopped
  await app.stop()
  await p.stop()
  // The runner's own queue keeps this process awake; the test is over.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref()
})

test("a run does not end while a row that arrived in the last moment is waiting", async () => {
  const db = app.fb.use("records")
  const runs = app.fb.use("runs")
  const one = async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows[0]
  const wf = runs.workflows()["find-sales-heads"]
  await db.query("create table target_list (id bigserial primary key, company text)")
  await db.query("insert into target_list (company) values ('Co1')")
  await db.query("create table sales_heads (id bigint primary key)")
  const run = (
    await one(
      `insert into fb_workflow_sdk.runs (workflow, title, kind, state, file_hash, list, into_table, total, standing, started_by)
       values ($1, 'Find sales heads', 'webhook', 'running', $2, 'target_list', 'sales_heads', 1, 1, 'webhook:new-leads') returning id`,
      [wf.id, wf.hash],
    )
  ).id as number
  const state = async () => (await one("select state from fb_workflow_sdk.runs where id = $1", [run])).state
  // The run does its one row. Its driver looks for another and finds none.
  assert.deepEqual(await runs.steps.claim(run, 25), [1])
  await runs.steps.saveRow(run, 1, { head: "Head Of Co1" })
  assert.deepEqual(await runs.steps.claim(run, 25), [])
  // In that moment a signed row arrives, and the webhook hands it to the run that is still going.
  await db.query("insert into target_list (company) values ('Co2')")
  assert.equal(await runs.auto.absorb("webhook:new-leads", 1), run)
  // The run was about to end. It does not: it says there is more, and takes the row.
  assert.equal(await runs.steps.finish(run), true)
  assert.equal(await state(), "running")
  assert.deepEqual(await runs.steps.claim(run, 25), [2])
  await runs.steps.saveRow(run, 2, { head: "Head Of Co2" })
  // Nothing is waiting now: it ends. A row that arrives after that starts a new run instead.
  assert.equal(await runs.steps.finish(run), false)
  assert.equal(await state(), "done")
  assert.equal(await runs.auto.absorb("webhook:new-leads", 1), undefined)
})

test("rows taken twice under the same name are the same rows: a kill between taking them and writing that down leaves none behind", async () => {
  const db = app.fb.use("records")
  const runs = app.fb.use("runs")
  const one = async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows[0]
  const wf = runs.workflows()["find-sales-heads"]
  await db.query("create table more_list (id bigserial primary key, company text)")
  await db.query("insert into more_list (company) select 'Co' || n from generate_series(1, 6) n")
  await db.query("create table more_heads (id bigint primary key)")
  const run = (
    await one(
      `insert into fb_workflow_sdk.runs (workflow, title, kind, state, file_hash, list, into_table, total, lanes) values ($1, 'Find sales heads', 'run', 'running', $2, 'more_list', 'more_heads', 6, 3) returning id`,
      [wf.id, wf.hash],
    )
  ).id as number
  // A lane takes its batch. Flowbound is killed before the runner has written the answer down, so it asks again.
  const first = await runs.steps.claim(run, 2, "driver-1:0:0")
  assert.deepEqual(first, [1, 2])
  assert.deepEqual(await runs.steps.claim(run, 2, "driver-1:0:0"), [1, 2])
  // Another lane's claim, and this lane's next one, get rows of their own (the last few are shared out between the lanes).
  assert.deepEqual(await runs.steps.claim(run, 2, "driver-1:1:0"), [3, 4])
  assert.deepEqual(await runs.steps.claim(run, 2, "driver-1:0:1"), [5])
  assert.deepEqual(await runs.steps.claim(run, 2, "driver-1:2:0"), [6])
  assert.deepEqual(await runs.steps.claim(run, 2, "driver-1:1:1"), [])
  const taken = await one("select count(*)::int as rows, (select claimed from fb_workflow_sdk.runs where id = $1) as claimed from fb_workflow_sdk.rows where run = $1 and state = 'running'", [run])
  assert.deepEqual(taken, { rows: 6, claimed: 6 }, "each row is taken once, and counted once")
  await db.query("update fb_workflow_sdk.runs set state = 'stopped' where id = $1", [run])
})
