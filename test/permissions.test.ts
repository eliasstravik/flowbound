// The reshape: permission modes over caps (ask, auto, skip), a rule per workflow or provider where the strictest
// wins, writes to other tools counted by number, a month's cap a yes can lift for one run, kept facts with an age and
// one lookup across providers, and the agent's own summary and diagram. Through the real command line, against an
// honest fake provider. Nothing is spent.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"
import { fakeProvider, project } from "./helpers.ts"

let provider: Awaited<ReturnType<typeof fakeProvider>>
let p: ReturnType<typeof project>
const json = async (args: string) => JSON.parse(await p.fb(`${args} --json`))
const done = async (run: number) => {
  await p.until(async () => (await json(`runs ${run}`)).state !== "running")
  return json(`runs ${run}`)
}
const config = (permissions: string) =>
  p.restarted(() =>
    fs.writeFileSync(path.join(p.root, "flowbound.config.ts"), `import { fakedata, crm, other } from "./plugins/fakedata.ts"\nexport default { providers: [fakedata(), crm(), other()], permissions: ${permissions} }\n`),
  )

// A workflow that writes each head it finds to a CRM: a write, counted by number. It sits in a folder: its id is crm/sync-heads.
const SYNC = `import { use } from "flowbound"
export const from = "target_list"
export const into = "synced"
export const summary = "For each company: find its head of sales, then add them to the CRM."
export const diagram = \`
%%{init: {"securityLevel": "loose"}}%%
flowchart TD
  a[A company] --> b[Add the head to the CRM]
  click b add
  click a href "javascript:alert(1)"
\`
export async function syncHeads(company) {
  "use workflow"
  return { added: await add(company) }
}
async function add(company) {
  "use step"
  const res = await use("crm").fetch("/v2/head-b", { body: { company: company.company } })
  return res.pick("person.full_name")
}
`

before(async () => {
  provider = await fakeProvider()
  p = project(provider.host, { permissions: '{ mode: "ask", caps: { perRun: 5, perMonth: 100 } }' })
  fs.writeFileSync(
    path.join(p.root, "plugins", "fakedata.ts"),
    `import { provider } from "flowbound"
const card = { host: "${provider.host}", key: { header: "x-api-key" }, docs: "${provider.host}/docs" }
export const fakedata = () => provider({ ...card, name: "fakedata", label: "FakeData", price: { perCall: 0.002 } })
export const other = () => provider({ ...card, name: "other", label: "OtherData", price: { perCall: 0.003 } })
export const crm = () => provider({ ...card, name: "crm", label: "FakeCRM", price: { perCall: 0 }, writes: ({ method }) => method !== "GET" })
`,
  )
  fs.writeFileSync(path.join(p.root, "flowbound.config.ts"), `import { fakedata, crm, other } from "./plugins/fakedata.ts"\nexport default { providers: [fakedata(), crm(), other()], permissions: { mode: "ask" } }\n`)
  fs.mkdirSync(path.join(p.root, "workflows", "crm", "lib"), { recursive: true })
  fs.writeFileSync(path.join(p.root, "workflows", "crm", "sync-heads.ts"), SYNC)
  // A helper beside it, with no "use workflow": not a workflow.
  fs.writeFileSync(path.join(p.root, "workflows", "crm", "lib", "names.ts"), "export const clean = (s: string) => s.trim()\n")
  await p.fb("import targets.csv")
  for (const name of ["fakedata", "crm", "other"]) await p.page("set-key", { name, value: "sk-test-123" })
})
after(async () => {
  await p.stop()
  await provider.close()
})

test("ask: every paid run asks first, even a 10-row try; the yes is the person's, passed on by the agent", async () => {
  const before = provider.state.calls
  const tryout = await json("run find-sales-heads --try 10")
  assert.equal(tryout.state, "waiting")
  assert.equal(tryout.asks.question, 'Try "Find sales heads" on 10 rows first?')
  assert.equal(provider.state.calls, before, "nothing was called before the yes")
  const needs = (await json("doctor")).needs.find((n: any) => n.yes)
  assert.equal(needs.what, 'Try "Find sales heads" on 10 rows first?')
  assert.match(await p.fb(`runs ${tryout.run}`), /It waits for the person's yes: Try "Find sales heads" on 10 rows first\? Pass their answer on: npx flowbound yes \d+/)
  const ran = await json(`yes ${tryout.run}`)
  assert.equal(ran.state, "running")
  const out = await done(tryout.run)
  assert.equal(out.state, "done")
  assert.equal(out.yesBy, "You, in chat")
  assert.equal(out.mode, "ask")
})

test("auto: a run spends freely up to the caps; skip: no asking and no caps, but a budget said in chat still holds", async () => {
  await config('{ mode: "auto", caps: { perRun: 5, perMonth: 100 } }')
  const auto = await json("run find-sales-heads --rows 5 --wait")
  assert.equal(auto.state, "done")
  assert.equal(auto.yesBy, "not needed (auto inside caps)")
  assert.deepEqual(auto.cap, { usd: 5, calls: null })
  await config('{ mode: "skip" }')
  const skip = await json("run find-sales-heads --rows 5 --wait")
  assert.equal(skip.yesBy, "not asked (skip asking)")
  assert.equal(skip.cap, undefined)
  const budget = await json("run find-sales-heads --max-usd 0.004 --wait")
  assert.equal(budget.state, "paused", "a budget said in chat is the run's cap in every mode, skip too")
  assert.match(budget.why, /^Reached the \$0\.004 cap for this run/)
  await p.page("no", { run: budget.run })
})

test("a workflow or provider can have its own mode or caps; the strictest one wins", async () => {
  await config('{ mode: "auto", caps: { perRun: 5 }, workflows: { "find-sales-heads": { mode: "ask" } }, providers: { crm: { mode: "skip" } } }')
  const asked = await json("run find-sales-heads --try 3")
  assert.equal(asked.state, "waiting", "the workflow's own ask beats auto")
  await p.page("no", { run: asked.run })
  const sync = await json("run crm/sync-heads --try 2")
  assert.equal(sync.mode, "auto", "a provider's skip does not loosen the project's auto")
  await config('{ mode: "auto", caps: { perRun: 5 }, providers: { other: { mode: "ask" } } }')
  assert.equal((await json("workflows")).find((w: any) => w.id === "find-sales-heads").mode, "auto", "a rule for a provider the workflow does not use is not its rule")
})

test("writes to other tools count by number: a hit write cap pauses the run with a yes on Home, and a write is never answered from memory", async () => {
  await config('{ mode: "auto", caps: { perRun: 5, writesPerRun: 4 } }')
  const before = provider.state.calls
  const first = await json("run crm/sync-heads --try 2")
  assert.equal(first.state, "done")
  assert.equal(first.spent.writes, 2)
  const run = await json("run crm/sync-heads --wait")
  assert.equal(run.state, "paused")
  assert.match(run.why, /^Reached the 4-write cap per run after \d+ of \d+ rows, so it paused\./)
  assert.equal(run.spent.writes, 4)
  assert.match(run.asks.question, /past the 4-write cap per run/)
  // The same company written twice is two writes: nothing is "already known" about an act.
  const again = (await p.page("crm", { path: "/v2/head-b", body: { company: "Co1" } })).result
  assert.equal(again.fromMemory, false)
  assert.ok(provider.state.calls - before >= 7)
  assert.match(await p.fb("spend"), /FakeCRM this month\s+\$0\.00 for \d+ calls, \d+ of them writes/)
  await p.page("no", { run: run.run })
})

test("this month's cap pauses a run; the person's yes lifts it for that run only", async () => {
  const spent = (await json("permissions")).thisMonth.usd
  await config(`{ mode: "auto", caps: { perRun: 5, perMonth: ${(spent + 0.004).toFixed(4)} } }`)
  fs.writeFileSync(path.join(p.root, "more.csv"), p.csv(31, 45))
  await p.fb("import more.csv --as target_list --add")
  const run = await json("run find-sales-heads --wait")
  assert.equal(run.state, "paused")
  assert.match(run.why, /^Reached this month's \$[\d.]+ cap after/)
  assert.match(run.asks.question, /past this month's \$[\d.]+ cap/)
  const going = await json(`yes ${run.run}`)
  assert.equal(going.state, "running")
  const out = await done(run.run)
  assert.equal(out.state, "done", "the month's cap is lifted for this run only")
  const lifted = (await json(`sql 'select lifted from fb_workflow_sdk.runs where id = ${run.run}'`)).rows[0].lifted
  assert.equal(lifted.length, 1)
  assert.match(lifted[0], /^month:\d{4}-\d{2}$/)
})

test("kept facts: an answer is filed under its provider and its cleaned inputs, one lookup finds it from any provider, and every cell says its age", async () => {
  await config('{ mode: "auto", caps: { perRun: 5, perMonth: 100 } }')
  const before = provider.state.calls
  // The same question in other capitals and with spaces is the same question: already known, free.
  const known = (await p.page("fakedata", { path: "/v2/head", body: { company: "  Co1 " } })).result
  assert.equal(known.fromMemory, true)
  assert.equal(provider.state.calls, before)
  await p.page("other", { path: "/v2/head-b", body: { company: "Co1" } })
  const found = await json("lookup Co1")
  // Writes to the CRM were acts, not answers: they are not in it.
  assert.deepEqual([...new Set(found.map((f: any) => f.from))].sort(), ["FakeData", "OtherData"])
  assert.ok(found.every((f: any) => f.age === "today" && f.fresh))
  // An answer bought 140 days ago is past the window: bought again, and the cell says how old the last one was.
  const sql = async (query: string) => assert.equal((await p.page("sql", { query })).ok, true)
  await sql(`update fb_ledger.facts set at = now() - interval '140 days' where id in (select fact from fb_ledger.calls where scope @> '{"into":"sales_heads","row":2}')`)
  await sql("delete from sales_heads where id = 2")
  await done((await json("run find-sales-heads --try 1")).run)
  const t = await json("table sales_heads --limit 2")
  assert.match(t.rows[1].sources[1], /^FakeData · bought again today for \$0\.002 · the last answer was 140 days old$/)
  // A row answered from what was already known says so.
  await sql("delete from sales_heads where id = 2")
  await done((await json("run find-sales-heads --try 1")).run)
  assert.match((await json("table sales_heads --limit 2")).rows[1].sources[1], /^already known · free$/)
})

test("a workflow in a folder: its id is its path, and its page has the summary and the Mermaid diagram the agent wrote, without lines that could run; with none it says so", async () => {
  const listed = await json("workflows")
  assert.deepEqual(
    listed.map((w: any) => [w.id, w.folder, w.title]),
    [
      ["crm/sync-heads", "crm", "Sync heads"],
      ["find-sales-heads", "", "Find sales heads"],
    ],
    "the helper in crm/lib is not a workflow",
  )
  const sync = await json("workflow crm/sync-heads")
  assert.equal(sync.file, "workflows/crm/sync-heads.ts")
  assert.equal(sync.summary, "For each company: find its head of sales, then add them to the CRM.")
  assert.equal(sync.diagram, "flowchart TD\n  a[A company] --> b[Add the head to the CRM]")
  assert.deepEqual(sync.clicks, [{ node: "b", fn: "add" }])
  assert.deepEqual([sync.steps, sync.notDrawn], [["add"], []])
  assert.match(sync.code, /export async function syncHeads/)
  assert.match(sync.lastRun.text, /^\d+ rows · \d+ written$/, "writes are counted as writes")
  const none = await json("workflow find-sales-heads")
  assert.equal(none.summary, null)
  assert.match(await p.fb("workflow find-sales-heads"), /No summary yet: ask your agent to write one\./)
  assert.match(await p.fb("workflows"), /find-sales-heads .*\n {2}no summary yet: write export const summary for people\n {2}no diagram yet: write export const diagram, a Mermaid flowchart/)
})

test("run habits are defaults the workflow file may change: rows at a time, tries for a busy provider, when to pause", async () => {
  const file = path.join(p.root, "workflows", "find-sales-heads.ts")
  await p.restarted(() => fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\nexport const retries = 0\nexport const pauseAfter = { failed: 2, of: 5 }\n`))
  fs.writeFileSync(path.join(p.root, "busy.csv"), p.csv(200, 215))
  await p.fb("import busy.csv --as target_list --add")
  provider.state.mode = "busy"
  const before = provider.state.calls
  const out = await json("run find-sales-heads --try 10")
  provider.state.mode = "ok"
  assert.equal(out.state, "paused")
  assert.match(out.why, /^Paused at row \d+ of 10: 2 of the last \d rows failed\. Most often: FakeData refused the call with 429 "too many requests"\. Tried 1 time\./)
  assert.ok(provider.state.calls - before <= 6, "no extra tries")
})

test("execute: an agent's few lines call several tools at once and return only what it needs", async () => {
  const out = await p.fb(`execute 'const [runs, perms] = await Promise.all([flowbound.runs({}), flowbound.permissions({})]); console.log(perms.mode); return runs.filter((r) => r.state === "done").length > 0'`)
  assert.equal(out, "auto\ntrue")
  assert.match(await p.fb(`execute 'return await flowbound.nothing({})'`, { fails: true }), /No tool is called "nothing"/)
})
