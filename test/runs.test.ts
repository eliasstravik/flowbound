// Steps 2 to 5 of the build order, through the real command line against an honest fake provider:
// records, runs that survive a kill, keys that are used and never read, kept facts, the caps and the yes.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"
import { fakeProvider, project } from "./helpers.ts"

let provider: Awaited<ReturnType<typeof fakeProvider>>
let p: ReturnType<typeof project>
const json = async (args: string) => JSON.parse(await p.fb(`${args} --json`))
const api = async (tool: string, input: unknown) => (await fetch(`${p.url()}/api/${tool}`, { method: "POST", body: JSON.stringify(input) })).json()
const facts = async () => (await json("sql 'select count(*)::int as facts, count(distinct key)::int as different from fb_ledger.facts'")).rows[0] as { facts: number; different: number }

before(async () => {
  provider = await fakeProvider()
  p = project(provider.host)
})
after(async () => {
  await p.stop()
  await provider.close()
})

test("records: a CSV becomes a list table, in a database inside the project folder", async () => {
  assert.equal(await p.fb("import targets.csv"), "target_list   30 rows")
  assert.match(await p.fb("tables"), /target_list\s+30 rows\s+imported from targets\.csv/)
  assert.match(await p.fb("import targets.csv", { fails: true }), /target_list is already there with 30 rows/)
  assert.ok(fs.existsSync(path.join(p.root, ".flowbound", "pg")))
  assert.match(await p.fb("sql 'select company from target_list where id = 2'"), /Co2/)
})

test("keys: a missing key stops the run before anything is spent", async () => {
  const out = await p.fb("run find-sales-heads --try 10")
  assert.match(out, /stopped/)
  assert.match(out, /FakeData has no key yet\. Add it on the Connections page/)
  assert.equal(provider.state.calls, 0)
})

test("keys: only a person on a page can save one; it is kept outside the project and nothing prints it", async () => {
  assert.match(await p.fb("set-key fakedata sk-test-123", { fails: true }), /flowbound <command>/)
  assert.match((await api("set-key", { name: "fakedata", value: "sk-test-123" })).error, /for a person on a page, not for an agent/)
  assert.deepEqual((await p.page("set-key", { name: "fakedata", value: "sk-test-123" })).result, { name: "fakedata", hasKey: true })
  assert.match(await p.fb("keys"), /FakeData\s+key is in/)
  assert.doesNotMatch(await p.fb("keys --json"), /sk-test/)
  const inProject = fs
    .readdirSync(p.root, { recursive: true })
    .filter((f) => !String(f).startsWith(".home") && !String(f).includes("node_modules"))
    .map((f) => path.join(p.root, String(f)))
  for (const f of inProject) if (fs.statSync(f).isFile() && fs.statSync(f).size < 2_000_000) assert.ok(!fs.readFileSync(f).includes("sk-test-123"), `the key is in ${f}`)
  const [dir] = fs.readdirSync(p.home)
  assert.equal(fs.statSync(path.join(p.home, dir!, "keys.json")).mode & 0o777, 0o600)
})

test("keys: whatever path is asked for, the key only ever travels to the card's own address", async () => {
  const before = provider.state.calls
  for (const path of ["//evil.example/steal", "https://evil.example/steal", "/@evil.example/steal"]) assert.match((await api("fakedata", { path })).error, /FakeData did not accept the request: 400/)
  assert.equal(provider.state.calls - before, 3, "all three went to the card's host, where the fake provider refused them")
})

test("a full run is refused before a try-out", async () => {
  assert.match(await p.fb("run find-sales-heads --max-usd 1", { fails: true }), /Try it first: npx flowbound run find-sales-heads --try 10/)
})

test("the try-out: 10 rows, auto inside the caps (no yes), the card's numbers", async () => {
  const before = provider.state.calls
  const out = await p.fb("run find-sales-heads --try 10")
  assert.match(out, /Find sales heads, try-out\nhead\s+9 of 10\nemail\s+7 of 10\nSpent on 10\s+\$0\.038 of \$5\.00\nAll 30, about\s+\$0\.11/)
  assert.match(out, /To run all 20 that are left: npx flowbound run find-sales-heads\. A budget the person said in chat is --max-usd\./)
  assert.equal(provider.state.calls - before, 19)
})

test("a run's rows and each row's steps: names, cost, who was paid, or why it failed", async () => {
  const [run] = await json("runs")
  const r = await api("runs", { run: run.run, rows: 1 })
  const page = r.result.rowsPage
  assert.equal(page.total, 10)
  assert.equal(page.list.length, 10)
  assert.deepEqual(page.list[0], { row: 1, name: "Co1", state: "done", cost: "$0.004" })
  assert.equal(r.result.how, "try-out")
  assert.equal(r.result.folder, "")
  const steps = (await api("steps", { run: run.run, row: 1 })).result
  assert.deepEqual(
    steps.steps.map((s: any) => [s.fn, s.state, s.text]),
    [
      ["findHead", "done", "FakeData · $0.002"],
      ["findEmail", "done", "FakeData · $0.002"],
    ],
  )
  assert.ok(steps.steps[1].at >= steps.steps[0].at + steps.steps[0].ms - 5, "the second step begins after the first")
  assert.match(await p.fb(`steps --run ${run.run} --row 1`), /findHead\s+\d+ ms\s+FakeData · \$0\.002/)
})

test('ledger: the same call again is answered from memory, and "not found" is remembered too', async () => {
  const before = provider.state.calls
  const again = (await api("fakedata", { path: "/v2/head", body: { company: "Co1" } })).result
  assert.equal(again.fromMemory, true)
  assert.equal(again.cost, 0)
  const notFound = (await api("fakedata", { path: "/v2/head", body: { company: "Co7" } })).result
  assert.equal(notFound.status, 404)
  assert.equal(notFound.fromMemory, true)
  assert.equal(provider.state.calls, before)
})

test("a budget said in chat is the run's cap: the run pauses at it, nothing more is spent, and a yes waits on Home", async () => {
  const out = await p.fb("run find-sales-heads --max-usd 0.02 --wait")
  assert.match(out, /\(waits for a yes\)/)
  assert.match(out, /Spent\s+\$0\.02 of \$0\.02/)
  // How many rows fit under the cap depends on which calls came first: lanes that had bought a head when the cap came
  // leave their row not done, and the head stays known for the next run.
  const [, done] = /Reached the \$0\.02 cap for this run after (\d) of 20 rows, so it paused\. Nothing more was spent\. A yes carries it on\./.exec(out) ?? []
  assert.ok(Number(done) >= 1 && Number(done) <= 5, out)
  assert.match(out, /Pass their answer on: npx flowbound yes \d+ --max-usd 0\.04/)
  const [run] = await json("runs")
  assert.match(await p.fb(`resume ${run.run}`, { fails: true }), /paused at a cap: going on is the person's yes/)
  assert.match(await p.fb("doctor"), /Go on with "Find sales heads" past the \$0\.02 cap for this run, for the \d+ rows left, up to \$0\.04\?/)
})

test("the agent passes the person's yes on: the run carries on with the new cap, and the yes is saved with who, where and the file", async () => {
  const [run] = await json("runs")
  const out = await json(`yes ${run.run} --max-usd 0.5`)
  assert.equal(out.state, "running")
  await p.until(async () => (await json(`runs ${run.run}`)).state === "done")
  const done = await json(`runs ${run.run}`)
  assert.equal(done.rows.done, done.rows.of)
  assert.equal(done.yesBy, "You, in chat")
  const yes = (await json("sql 'select workflow, max_usd, who, place, run, length(file_hash) as hash from fb_ledger.yeses order by id desc limit 1'")).rows[0]
  assert.deepEqual(yes, { workflow: "find-sales-heads", max_usd: 0.5, who: "You", place: "chat", run: run.run, hash: 64 })
  assert.match(await p.fb("run find-sales-heads --try 10", { fails: true }), /Every one of the 30 rows in target_list already has a result/)
})

test("results sit beside the list's columns; a field says where it came from and what it cost", async () => {
  const t = await json("table sales_heads --limit 3")
  assert.deepEqual(
    t.columns.map((c: any) => `${c.of}:${c.name}`),
    ["list:company", "result:head", "result:email", "list:domain"],
  )
  assert.deepEqual(t.rows[0].cells, ["Co1", "Head Of Co1", "co1@corp.example", "co1.example"])
  // Every answered cell says where it came from, how old it is and what it cost.
  assert.deepEqual(t.rows[0].sources.slice(1, 3), ["FakeData · today · $0.002", "FakeData · today · $0.002"])
  const fact = await json(`fact ${t.rows[0].facts[2]}`)
  assert.equal(fact.question, '{"linkedin_url":"linkedin.example/in/co1"}', "filed under the exact question, cleaned up first")
  assert.equal(fact.from, "FakeData")
  assert.equal(fact.age, "today")
  assert.equal(fact.fresh, true)
  assert.equal(fact.cost, "$0.002")
  assert.equal(fact.by, "Find sales heads")
  assert.equal(await p.fb("export sales_heads --csv"), "sales_heads.csv   30 rows")
  assert.match(fs.readFileSync(path.join(p.root, "sales_heads.csv"), "utf8"), /^company,head,email,domain\nCo1,Head Of Co1,co1@corp\.example,co1\.example\n/)
  assert.match(await p.fb("tables"), /sales_heads\s+30 rows\s+made by Find sales heads/)
})

test("a big table stays out of the chat: the table tool answers a part at a time, and an agent's export gets the way to the file", async () => {
  fs.writeFileSync(path.join(p.root, "bigs.csv"), `company,domain\n${Array.from({ length: 3000 }, (_, i) => `Big${i + 1},big${i + 1}.example`).join("\n")}\n`)
  assert.equal(await p.fb("import bigs.csv"), "big_list   3000 rows")
  const all = await json("table big_list --limit 10000")
  assert.deepEqual([all.rows.length, all.total], [500, 3000])
  assert.equal((await json("table big_list --limit 10 --offset 2995")).rows.length, 5)
  // The same export, asked for by an agent in a chat (MCP) and by a person on the page.
  const ask = async (via: string, table: string) => (await (await fetch(`${p.url()}/api/export`, { method: "POST", headers: { "x-flowbound-via": via }, body: JSON.stringify({ table }) })).json()).result
  const chat = await ask("mcp", "big_list")
  assert.match(chat.tooBigForChat, /big_list\.csv is 3000 rows .* too big to send into a chat\. The person downloads it at http.*\/tables\?table=big_list/)
  assert.equal(chat.save, undefined)
  assert.equal((await ask("page", "big_list")).save.text.trim().split("\n").length, 3001)
  assert.equal((await ask("mcp", "target_list")).save.name, "target_list.csv", "a small table still comes as it is")
})

test("SQL on a results field: the answer says how to compare JSON", async () => {
  assert.match(
    (await api("sql", { query: "select count(*) from sales_heads where head = 'Head Of Co1'" })).error,
    /A results field is stored as JSON: compare it as a number with .* or as text with title #>> '\{\}' = 'VP Sales'/,
  )
  assert.equal((await api("sql", { query: "select count(*)::int as n from sales_heads where head #>> '{}' = 'Head Of Co1'" })).result.rows[0].n, 1)
})

test("nothing was paid twice: one paid fact per different request, one provider call per fact", async () => {
  const f = await facts()
  assert.equal(f.facts, f.different)
  assert.equal(provider.state.calls - 3, f.facts, "every call the provider answered is one fact (the three refused ones are none)")
})

test("a changed workflow file needs a new try-out", async () => {
  fs.writeFileSync(path.join(p.root, "more.csv"), p.csv(31, 60))
  await p.fb("import more.csv --as target_list --add")
  const file = path.join(p.root, "workflows", "find-sales-heads.ts")
  await p.restarted(() => fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n// changed\n`))
  assert.match(await p.fb("run find-sales-heads --max-usd 1", { fails: true }), /Try it first/)
})

test("a try-out that fills no field blocks the full run until the person says run anyway", async () => {
  provider.state.mode = "empty"
  const out = await p.fb("run find-sales-heads --try 10")
  assert.match(out, /head\s+0 of 10\nemail\s+0 of 10/)
  assert.match(out, /It filled no field, so a full run is blocked/)
  assert.match(await p.fb("run find-sales-heads --max-usd 1", { fails: true }), /filled no field, so the full run is blocked.*add --anyway/s)
  provider.state.mode = "ok"
})

test("when 11 of the last 20 rows fail the run pauses and says why; a failed call is not counted as spent", async () => {
  provider.state.mode = "busy"
  const before = provider.state.calls
  const out = await p.fb("run find-sales-heads --max-usd 1 --anyway --wait")
  assert.match(out, /\(paused\)/)
  assert.match(out, /Paused at row \d+ of 20: \d+ of the last \d+ rows failed\. Most often: FakeData refused the call with 429 "too many requests"\. Tried 3 times\. Nothing was spent on it\./)
  assert.match(out, /Spent\s+\$0\.00 of \$1\.00/)
  const [run] = await json("runs")
  assert.ok(run.rows.failed > 10 && run.rows.failed <= 16, `${run.rows.failed} rows failed before the pause`)
  assert.equal((provider.state.calls - before) % 3, 0, "each failed call was tried 3 times")
  assert.match((await json(`runs ${run.run}`)).failedRows[0].reason, /too many requests/)
  provider.state.mode = "ok"
  await p.fb(`resume ${run.run}`)
  await p.until(async () => (await json(`runs ${run.run}`)).state === "done")
  assert.ok((await json(`runs ${run.run}`)).rows.done > 0)
})

test("an edited workflow file is the one that runs, also when the editor saved it by replacing the file", async () => {
  const file = path.join(p.root, "workflows", "find-sales-heads.ts")
  const edited = fs.readFileSync(file, "utf8").replace('return res.pick("email")', 'const e = res.pick("email")\n  return { value: String(e.value).toUpperCase(), fact: e.fact }')
  await p.restarted(() => {
    fs.writeFileSync(`${file}.tmp`, edited)
    fs.renameSync(`${file}.tmp`, file)
  })
  await p.fb("sql 'delete from sales_heads where id in (1, 2)'")
  const before = provider.state.calls
  const out = await p.fb("run find-sales-heads --try 2")
  assert.match(out, /email\s+2 of 2/)
  assert.equal(provider.state.calls, before, "the calls were paid for before: answered from memory")
  assert.match(out, /All \d+, about\s+\$0\.[0-9]*[1-9]/, "the estimate counts remembered answers at what they cost")
  assert.match(await p.fb("sql 'select email from sales_heads where id = 1'"), /CO1@CORP\.EXAMPLE/)
})

test("a run that is killed halfway carries on by itself when Flowbound is back, and pays for nothing twice", async () => {
  fs.writeFileSync(path.join(p.root, "big.csv"), p.csv(100, 219))
  await p.fb("import big.csv --as target_list --add")
  await p.fb("run find-sales-heads --try 10")
  provider.state.delay = 60
  const before = { calls: provider.state.calls, facts: (await facts()).facts }
  const started = await json("run find-sales-heads --max-usd 2")
  await p.until(async () => (await json(`runs ${started.run}`)).rows.done >= 20)
  p.kill()
  const atKill = (await json(`runs ${started.run}`)).rows // this command starts Flowbound again
  assert.ok(atKill.done < atKill.of, "the kill came before the end")
  await p.until(async () => (await json(`runs ${started.run}`)).state === "done", 120_000)
  provider.state.delay = 0
  const done = await json(`runs ${started.run}`)
  assert.equal(done.rows.done + done.rows.failed, done.rows.of)
  assert.match(fs.readFileSync(path.join(p.root, ".flowbound", "dev.log"), "utf8"), new RegExp(`Picked up run ${started.run} \\(Find sales heads\\) where it stopped`))
  const f = await facts()
  assert.equal(f.facts, f.different, "every paid fact is for a different request")
  // Only calls that were in the air at the instant of the kill can have been made again: at most one per row in flight.
  const again = provider.state.calls - before.calls - (f.facts - before.facts)
  assert.ok(again >= 0 && again <= 5, `${again} calls were made again`)
})
