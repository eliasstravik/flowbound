// Data and Context: every table in the folder of its workflow (a list in the folder it was imported into), then
// Flowbound's own, read-only; one step deeper with Drizzle Studio for real on your own computer, Neon's console live;
// and whatever files are in context/, listed, searched and read.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"
import { consoleOf } from "../src/plugins/postgres/studio.ts"
import { fakeProvider, project } from "./helpers.ts"

let provider: Awaited<ReturnType<typeof fakeProvider>>
let p: ReturnType<typeof project>
const json = async (args: string) => JSON.parse(await p.fb(`${args} --json`))
const page = async (tool: string, input: unknown = {}) => {
  const out = await p.page(tool, input)
  if (!out.ok) throw new Error(out.error)
  return out.result
}

before(async () => {
  provider = await fakeProvider()
  p = project(provider.host)
  // The workflow sits in a folder (a play): its results table is shown in that folder.
  fs.mkdirSync(path.join(p.root, "workflows", "tam-mapping"))
  fs.renameSync(path.join(p.root, "workflows", "find-sales-heads.ts"), path.join(p.root, "workflows", "tam-mapping", "find-sales-heads.ts"))
  fs.writeFileSync(path.join(p.root, "partners.csv"), "company\nNorthwind\nBluebird\n")
  fs.writeFileSync(path.join(p.root, "loose.csv"), "name\nA\n")
  fs.mkdirSync(path.join(p.root, "context", "market-research"), { recursive: true })
  fs.writeFileSync(path.join(p.root, "context", "company.md"), "# Acme\n\nWhat Acme sells and to whom.\n\n- payroll\n")
  fs.writeFileSync(path.join(p.root, "context", "market-research", "nordics.md"), "---\ndescription: The Nordic market\n---\n# Nordics\n\nFour countries, one language family.\n")
  fs.writeFileSync(path.join(p.root, "context", "notes.txt"), "plain text\nsecond line\n")
  fs.writeFileSync(path.join(p.root, "context", ".hidden.md"), "never listed")
  fs.writeFileSync(path.join(p.root, "context", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  await p.fb("import targets.csv")
  await p.fb("import partners.csv --folder champion-tracking")
  await p.fb("import loose.csv --as loose")
  await p.page("set-key", { name: "fakedata", value: "sk-test-123" })
  await p.fb("run tam-mapping/find-sales-heads --try 10 --wait")
})
after(async () => {
  await p.stop()
  await provider.close()
})

test("every table sits in a folder: results in their workflow's, a list where it was imported or with the workflows that read it", async () => {
  const d = await page("data")
  const by = Object.fromEntries(d.tables.map((t: any) => [t.name, t]))
  assert.deepEqual([by.sales_heads.folder, by.target_list.folder, by.partner_list.folder, by.loose.folder], ["tam-mapping", "tam-mapping", "champion-tracking", ""])
  assert.equal(by.sales_heads.kind, "results")
  // The database stays plain: the tables are in public, with no schema per folder.
  const schemas = await page("sql", { query: "select distinct table_schema as s from information_schema.tables where table_name in ('sales_heads', 'partner_list')" })
  assert.deepEqual(schemas.rows, [{ s: "public" }])
  // A folder that is not a path under workflows/ is refused.
  assert.match(await p.fb("import loose.csv --as other --folder ../x", { fails: true }), /not a folder Flowbound can use/)
  // Flowbound's own: runs, facts, calls and the rest, never sign-ins or keys.
  const own = d.own.map((t: any) => t.name)
  for (const t of ["fb_workflow_sdk.runs", "fb_workflow_sdk.rows", "fb_workflow_sdk.steps", "fb_ledger.facts", "fb_ledger.calls"]) assert.ok(own.includes(t), t)
  assert.ok(!own.some((t: string) => /fb_door|fb_keys|yeses|budgets/.test(t)))
  assert.equal(d.own.find((t: any) => t.name === "fb_ledger.facts").rows, 19)
  assert.deepEqual([d.open.kind, d.open.label], ["studio", "Open in Drizzle Studio"])
  assert.match(await p.fb("data"), /tam-mapping\/sales_heads\s+10 rows/)
})

test("one of Flowbound's own tables reads like yours: newest first, searched, 50 at a time; others are refused", async () => {
  const runs = await page("table", { name: "fb_workflow_sdk.runs", limit: 50 })
  assert.equal(runs.kind, "own")
  assert.ok(runs.columns.some((c: any) => c.name === "workflow"))
  assert.equal(runs.rows[0].cells[runs.columns.findIndex((c: any) => c.name === "workflow")], "tam-mapping/find-sales-heads")
  const facts = await page("table", { name: "fb_ledger.facts", limit: 5, search: "co1" })
  assert.ok(facts.found >= 1 && facts.rows.length <= 5)
  assert.match((await p.page("table", { name: "fb_door.people" })).error, /no table called fb_door\.people/)
  assert.match((await p.page("table", { name: "fb_keys.keys" })).error, /no table called/)
  // A CSV of it, like any table.
  assert.match((await page("export", { table: "fb_workflow_sdk.runs" })).save.text, /^id,workflow,/)
})

test("the Data page and a workflow's Data tab: the list, the grid, the kept fact behind a bought cell", async () => {
  const html = await (await fetch(`${p.url()}/tables`)).text()
  assert.match(html, /<a href="\/tables" data-go="\/tables" aria-current="page">Data<\/a><a href="\/context" data-go="\/context">Context<\/a><hr class="sep">/)
  const t = await page("table", { name: "sales_heads", limit: 50 })
  const at = t.columns.findIndex((c: any) => c.of === "result")
  const row = t.rows.find((r: any) => r.facts[at])
  assert.match(row.sources[at], /FakeData · today · \$0\.002/)
  const fact = await page("fact", { id: row.facts[at] })
  assert.deepEqual([fact.from, fact.cost, fact.age], ["FakeData", "$0.002", "today"])
})

test("context: any files and folders, listed with their first line, searched inside, read whole", async () => {
  const all = await page("context")
  assert.deepEqual(
    all.map((f: any) => [f.path, f.folder, f.line]),
    [
      ["company.md", "", "What Acme sells and to whom."],
      ["market-research/nordics.md", "market-research", "The Nordic market"],
      ["notes.txt", "", "plain text"],
    ],
  )
  assert.deepEqual(
    (await page("context", { search: "language" })).map((f: any) => f.path),
    ["market-research/nordics.md"],
  )
  const one = await page("context", { path: "market-research/nordics.md" })
  assert.deepEqual([one.file, one.kind], ["context/market-research/nordics.md", "markdown"])
  assert.match(one.text, /Four countries/)
  assert.equal((await page("context", { path: "notes.txt" })).kind, "text")
  assert.match((await p.page("context", { path: "../flowbound.config.ts" })).error, /not a file in context/)
  assert.match((await p.page("context", { path: "missing.md" })).error, /There is no context\/missing\.md/)
  // An agent reads it the same way, from the command line.
  assert.match(await p.fb("context"), /context\/company\.md\s+What Acme sells and to whom\./)
  assert.match(await p.fb("context --path company.md"), /^# Acme/)
  const html = await (await fetch(`${p.url()}/context`)).text()
  assert.match(html, /aria-current="page">Context<\/a>/)
})

test("one step deeper, live: Neon's console for the project the host names, nothing made up otherwise", () => {
  assert.deepEqual(consoleOf({ NEON_PROJECT_ID: "cool-forest-86753099", DATABASE_URL: "postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb" }), {
    label: "Open in Neon",
    href: "https://console.neon.tech/app/projects/cool-forest-86753099",
    where: "this database's project in Neon's own console: every table, its SQL editor, branches and backups",
  })
  assert.equal(consoleOf({ DATABASE_URL: "postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb" })?.href, "https://console.neon.tech/app/projects")
  assert.equal(consoleOf({ VERCEL: "1", DATABASE_URL: "postgres://u:p@db.example.com/x" }), undefined)
  assert.equal(consoleOf({ DATABASE_URL: "postgres://u:p@db.example.com/x" }), undefined)
})

test("one step deeper, on your own computer: Drizzle Studio for real, against the database Flowbound holds open, while Flowbound keeps using it", { timeout: 300_000 }, async () => {
  // The first time it is fetched with npm, beside the keys.
  const up = await json("data-open")
  assert.deepEqual([up.kind, up.label, up.href], ["studio", "Open in Drizzle Studio", `https://local.drizzle.studio/?port=${up.port}`])
  assert.match(up.note, /answers on this computer only \(127\.0\.0\.1:\d+\)/)
  // What Drizzle's own page asks of it, asked here: rows from your tables and from Flowbound's own.
  const ask = async (sql: string) =>
    (
      await fetch(`http://127.0.0.1:${up.port}/`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://local.drizzle.studio" },
        body: JSON.stringify({ type: "proxy", data: { sql, params: [], method: "all" } }),
      })
    ).json()
  assert.deepEqual(await ask("select count(*)::int as n from target_list"), [{ n: 30 }])
  assert.deepEqual(await ask("select count(*)::int as n from fb_ledger.facts"), [{ n: 19 }])
  // Flowbound goes on as before beside it.
  await p.fb("run tam-mapping/find-sales-heads --try 3 --wait")
  assert.deepEqual(await ask("select count(*)::int as n from sales_heads"), [{ n: 13 }])
  // Asked again it is the same Studio, not a second one.
  assert.equal((await json("data-open")).port, up.port)
  assert.equal(await p.fb("data-open --stop"), "Drizzle Studio is stopped.")
  await assert.rejects(ask("select 1"))
})
