// A table read a page at a time, searched and sorted in the database: what the Tables page shows of 10,000 rows.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"
import { fakeProvider, project } from "./helpers.ts"

let provider: Awaited<ReturnType<typeof fakeProvider>>
let p: ReturnType<typeof project>
const table = async (input: Record<string, unknown>) => {
  const out = await p.page("table", input)
  if (!out.ok) throw new Error(out.error)
  return out.result as { total: number; found?: number; columns: { name: string }[]; rows: { cells: unknown[] }[] }
}
const first = (v: { rows: { cells: unknown[] }[] }, n = 3) => v.rows.slice(0, n).map((r) => r.cells[0])

before(async () => {
  provider = await fakeProvider()
  p = project(provider.host)
  fs.writeFileSync(path.join(p.root, "sizes.csv"), "company,employees,note\nKestrel North,9,\nBluebird,100,big\nkestrel South,20,\nIronclad,n/a,unknown\nRedwood,1500,big\n")
})
after(async () => {
  await p.stop()
  await provider.close()
})

test("a list is searched in any column, whatever the capitals, and says how many it found", async () => {
  await p.fb("import sizes.csv --as sizes")
  const all = await table({ name: "sizes" })
  assert.deepEqual([all.total, all.found, all.rows.length], [5, undefined, 5])
  const kestrel = await table({ name: "sizes", search: "KESTREL" })
  assert.deepEqual([kestrel.total, kestrel.found, first(kestrel)], [5, 2, ["Kestrel North", "kestrel South"]])
  assert.deepEqual(first(await table({ name: "sizes", search: "big" })), ["Bluebird", "Redwood"])
  assert.deepEqual([(await table({ name: "sizes", search: "100%" })).found, (await table({ name: "sizes", search: "nobody" })).found], [0, 0])
})

test("a column of numbers sorts as numbers, not as text, and what is not a number comes after", async () => {
  assert.deepEqual(first(await table({ name: "sizes", sort: "employees" }), 5), ["Kestrel North", "kestrel South", "Bluebird", "Redwood", "Ironclad"])
  assert.deepEqual(first(await table({ name: "sizes", sort: "employees", desc: true }), 2), ["Redwood", "Bluebird"])
  assert.deepEqual(first(await table({ name: "sizes", sort: "company", desc: true }), 2), ["kestrel South", "Redwood"])
  // A page of it: the second two of the same order.
  assert.deepEqual(first(await table({ name: "sizes", sort: "employees", limit: 2, offset: 2 })), ["Bluebird", "Redwood"])
  await assert.rejects(table({ name: "sizes", sort: "nope" }), /sizes has no column called nope\. It has: company, employees, note\./)
  await assert.rejects(table({ name: "sizes", sort: 'x"; drop table sizes; --' }), /has no column called/)
})

test("results beside their list are searched and sorted the same way, across both", async () => {
  await p.page("set-key", { name: "fakedata", value: "sk-test-123" })
  await p.fb("import targets.csv")
  await p.fb("run find-sales-heads --try 10 --wait")
  const found = await table({ name: "sales_heads", search: "co4@corp.example" })
  assert.deepEqual([found.total, found.found, found.rows[0]!.cells[0]], [10, 1, "Co4"])
  // The list's own column and a result column, each in order.
  assert.deepEqual(first(await table({ name: "sales_heads", sort: "company", desc: true }), 2), ["Co9", "Co8"])
  const byEmail = await table({ name: "sales_heads", sort: "email", desc: true })
  const email = byEmail.columns.findIndex((c) => c.name === "email")
  assert.equal(byEmail.rows[0]!.cells[email], "co9@corp.example")
  assert.match(await p.fb("table sales_heads --search co4@corp.example"), /\(1 of 1 rows found in 10, made by Find sales heads/)
})

test("the build for Vercel carries what the pages are drawn with: the style sheet, the script and the fonts", async () => {
  assert.match(await p.fb("deploy --build-only"), /Built 1 workflow for Vercel/)
  const found = (fs.readdirSync(path.join(p.root, ".vercel", "output"), { recursive: true }) as string[]).filter((f) => f.includes(path.join("pages", "built"))).map((f) => path.basename(f))
  for (const file of ["page.css", "page.js", "geist.woff2", "geist-ext.woff2", "geist-mono.woff2"]) assert.ok(found.includes(file), `${file} is missing from the build`)
})

test("the build for Vercel carries execute's sandbox engine beside each function that boots Flowbound", () => {
  // Without it, every execute call live answered "no such file ... emscripten-module.wasm".
  const fns = path.join(p.root, ".vercel", "output", "functions")
  for (const dir of ["__app.func", ".well-known/workflow/v1/flow.func/app"]) assert.ok(fs.existsSync(path.join(fns, dir, "emscripten-module.wasm")), `the sandbox engine is missing from ${dir}`)
})

test("every live function carries the same starting guide as the installed command", () => {
  const fns = path.join(p.root, ".vercel", "output", "functions")
  for (const dir of ["__app.func", ".well-known/workflow/v1/flow.func/app"]) {
    assert.equal(fs.readFileSync(path.join(fns, dir, "start.md"), "utf8"), fs.readFileSync(path.join(p.root, "node_modules", "flowbound", "docs", "start.md"), "utf8"))
  }
})
