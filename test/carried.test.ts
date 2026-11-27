// What was carried over from the earlier products after the full check (docs/decisions.md, "Workflow usability"):
// the wall against other websites, the check-up and the Overview page, keys that know what uses them, runs with
// a start, a length, a filter and a row limit, lists with a key, rows out of a step, a webhook that reads a
// sender's own shape, a CSV that is safe in a spreadsheet, and the recipes, each run as it is written.
// Through the real command line against an honest fake provider and a FAKE model. Nothing is spent.
import assert from "node:assert/strict"
import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { after, before, test } from "node:test"
import { foreign } from "../src/core/server.ts"
import { toCsv } from "../src/plugins/csv.ts"
import { usesOf } from "../src/plugins/workflow-sdk/build.ts"
import { took } from "../src/plugins/workflow-sdk.ts"
import { fakeProvider, project, repo } from "./helpers.ts"

let provider: Awaited<ReturnType<typeof fakeProvider>>
let p: ReturnType<typeof project>
const SECRET = randomBytes(32).toString("hex")
const json = async (args: string) => JSON.parse(await p.fb(`${args} --json`))
const doctor = async (more = "") => (await json(`doctor ${more}`)) as { ok: boolean; needs: { what: string; fix: string; when?: string; page?: string; link?: string; from: string }[]; checked: string[] }
/** SQL with quotes in it, sent the way a page sends it (the command-line helper here splits on quotes). */
const sql = async (query: string) => {
  const out = await p.page("sql", { query })
  if (!out.ok) throw new Error(out.error)
  return out.result
}
const says = async (what: RegExp, more = "") => (await doctor(more)).needs.find((n) => what.test(n.what))
const done = async (run: number) => {
  await p.until(async () => (await json(`runs ${run}`)).state !== "running")
  return json(`runs ${run}`)
}
const recipes = fs.readFileSync(path.join(repo, "src", "plugins", "workflow-sdk", "recipes.md"), "utf8")
/** Every workflow file the recipes print, by its file name: the test runs the text the agent reads, not a copy of it. */
const recipeFiles = [...recipes.matchAll(/```ts\n\/\/ workflows\/([a-z0-9-]+\.ts)\n([\s\S]*?)```/g)].map((m) => ({ name: m[1]!, text: m[2]! }))

before(async () => {
  provider = await fakeProvider()
  p = project(provider.host)
  const dir = path.join(p.root, "workflows")
  for (const f of recipeFiles) fs.writeFileSync(path.join(dir, f.name), f.text)
  fs.writeFileSync(
    path.join(dir, "booked.ts"),
    `export const from = "bookings_list"\nexport const into = "booked"\nexport async function booked(lead) {\n  "use workflow"\n  return { seen: await note(lead) }\n}\nasync function note(lead) {\n  "use step"\n  return lead.email\n}\n`,
  )
  fs.writeFileSync(
    path.join(p.root, "plugins", "fakedata.ts"),
    `import { provider } from "flowbound"
const card = { host: "${provider.host}", key: { header: "x-api-key" }, docs: "${provider.host}/docs", price: { perCall: 0.002 } }
export const fakedata = () => provider({ ...card, name: "fakedata", label: "FakeData", check: "/v2/me" })
export const acme = () => provider({ ...card, name: "acme", label: "Acme" })
export const backup = () => provider({ ...card, name: "backup", label: "Backup" })
`,
  )
  fs.writeFileSync(
    path.join(p.root, "flowbound.config.ts"),
    `import { ai, hook, schedule } from "flowbound"
import { acme, backup, fakedata } from "./plugins/fakedata.ts"
export default {
  providers: [fakedata(), acme(), backup(), ai({ host: "${provider.host}" })],
  schedules: [
    schedule({ id: "weekly", workflow: "find-sales-heads", every: "monday 08:00", timezone: "Europe/Stockholm" }),
    hook({
      id: "bookings",
      workflow: "booked",
      key: "email",
      row: (event) => (event.type === "booking.created" ? { email: event.payload.attendee.email, name: event.payload.attendee.name } : null),
    }),
  ],
}
`,
  )
  await p.fb("import targets.csv")
})
after(async () => {
  await p.stop()
  await provider.close()
})

test("another website cannot reach a Flowbound on a person's own computer: not with a request of its own, not under a made-up name", async () => {
  const call = (headers: Record<string, string>, method = "POST") => fetch(`${p.url()}/api/tables`, { method, headers: { "content-type": "text/plain", ...headers }, body: method === "POST" ? "{}" : undefined })
  // What a page on any site can send with no questions asked by the browser: a plain POST that names where it comes from.
  const other = await call({ origin: "https://evil.example" })
  assert.equal(other.status, 403)
  assert.match((await other.json()).error, /comes from another website \(https:\/\/evil\.example\)/)
  assert.equal((await call({ "sec-fetch-site": "cross-site" })).status, 403, "no Origin, but the browser says it is from another site")
  assert.equal((await call({ origin: "http://localhost:3000" })).status, 403, "another app on this computer is another site too")
  assert.equal((await fetch(`${p.url()}/mcp`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403, "the MCP address is behind the same wall")
  // Its own pages, the command line and the MCP server pass.
  assert.equal((await call({ origin: new URL(p.url()).origin })).status, 200)
  assert.equal((await call({})).status, 200)
  // A read is not a change: the font a chat app loads from here still loads.
  assert.equal((await fetch(`${p.url()}/assets/geist.woff2`, { headers: { origin: "https://chat.example" } })).status, 200)
  // A made-up name pointed at 127.0.0.1 (DNS rebinding) is not this Flowbound's name.
  const rebound = await new Promise<number>((ok) => {
    const u = new URL(p.url())
    http
      .request({ host: "127.0.0.1", port: u.port, path: "/api/tables", method: "POST", headers: { host: `evil.example:${u.port}`, "content-type": "application/json" } }, (res) => (res.resume(), ok(res.statusCode ?? 0)))
      .end("{}")
  })
  assert.equal(rebound, 403)
  assert.doesNotMatch(await p.fb("tables"), /planted/)
})

test("the wall knows a private share: the name in FLOWBOUND_URL, a tailnet name, and what a private proxy says the browser used", () => {
  const fb = { url: "https://box.tail1234.ts.net/flowbound", local: "http://localhost:4111" }
  const req = (headers: Record<string, string>, method = "POST") => new Request("http://localhost:4111/api/sql", { method, headers })
  assert.equal(foreign(req({ host: "box.tail1234.ts.net", origin: "https://box.tail1234.ts.net" }), fb), undefined)
  assert.equal(foreign(req({ host: "localhost:4111", origin: "https://box.tail1234.ts.net" }), fb), undefined, "the proxy rewrote the name; the page is still the shared address")
  assert.equal(foreign(req({ host: "127.0.0.1:4111", origin: "https://laptop.tailnet.ts.net", "x-forwarded-host": "laptop.tailnet.ts.net" }), { url: "http://localhost:4111", local: "http://localhost:4111" }), undefined)
  assert.match(foreign(req({ host: "localhost:4111", origin: "https://evil.example" }), fb) ?? "", /another website/)
  assert.match(foreign(req({ host: "evil.example" }, "GET"), fb) ?? "", /does not answer to the name evil\.example/)
  assert.equal(foreign(req({ host: "192.168.1.20:4111" }, "GET"), fb), undefined, "an address is not a name anybody can point elsewhere")
})

test("Home says what needs a person, each with the one thing to do: here, the keys the workflows use and a webhook with no signing secret", async () => {
  const d = await doctor()
  assert.equal(d.ok, false)
  assert.deepEqual(d.checked, ["ledger", "workflow-sdk", "keys", "door", "schedules"])
  const fake = d.needs.find((n) => /^FakeData has no key/.test(n.what))!
  assert.equal(fake.what, "FakeData has no key, and Find sales heads needs it.")
  assert.match(fake.fix, /^Type it on the Connections page, never in a chat\./)
  assert.equal(fake.link, `${p.url()}/keys`)
  assert.equal((await says(/^Acme has no key/))!.what, "Acme has no key, and Find heads two sources, Find people and People emails need it.")
  // A model is a provider like any other: a workflow that asks it needs its key.
  assert.match((await says(/^AI model has no key/))!.what, /needs it/)
  assert.match((await says(/^The webhook "bookings"/))!.what, /has no signing secret, so every delivery is refused/)
  const out = await p.fb("doctor")
  assert.match(out, /^\d+ things need a person:\n1\. /)
  assert.match(out, /Do: Type it on the Connections page, never in a chat/)
  assert.match(out, /Looked at: ledger, workflow-sdk, keys, door, schedules\./)
})

test("which workflows use a key is read from the workflow files, also through a file of their own they import", async () => {
  const flows = (await json("workflows")) as { id: string; uses: string[] }[]
  assert.deepEqual(flows.find((w) => w.id === "find-sales-heads")!.uses, ["fakedata"])
  assert.deepEqual(flows.find((w) => w.id === "find-heads-two-sources")!.uses, ["acme", "backup"])
  assert.deepEqual(flows.find((w) => w.id === "score-fit")!.uses, ["ai"])
  assert.deepEqual(flows.find((w) => w.id === "find-people")!.uses, ["acme", "records"])
  const lib = path.join(p.root, "lib-probe")
  fs.mkdirSync(lib)
  fs.writeFileSync(path.join(lib, "find.ts"), `import { use } from "flowbound"\nexport const find = () => use<any>("deep-card").fetch("/x")\n`)
  fs.writeFileSync(path.join(lib, "wf.ts"), `import { find } from "./find.ts"\nimport { use } from "flowbound"\nconst a = use('one'), b = use(\`two\`), c = use(which)\n`)
  assert.deepEqual(usesOf(path.join(lib, "wf.ts")), ["deep-card", "one", "two"])
  fs.rmSync(lib, { recursive: true })
})

test("a saved key can be taken away on the page; the check-up then says which workflow waits for it, and a key the provider took back is found when asked to look deeper", async () => {
  for (const name of ["fakedata", "acme", "backup", "ai"]) assert.equal((await p.page("set-key", { name, value: "sk-test-123" })).result.hasKey, true)
  assert.equal(await says(/has no key/), undefined)
  assert.equal(await says(/no longer takes/, "--deep"), undefined)
  // The provider takes the key back (somebody rotated it in the provider's own dashboard).
  provider.state.revoked = true
  assert.equal(await says(/no longer takes/), undefined, "the plain check-up makes no calls")
  const gone = (await says(/no longer takes/, "--deep"))!
  assert.equal(gone.what, "FakeData no longer takes the saved key (it answered 401). Find sales heads will stop at its next call.")
  provider.state.revoked = false
  // Remove: the page's own call, an empty value. The agent's door cannot do it.
  assert.match(await p.fb("set-key fakedata", { fails: true }), /flowbound <command>/)
  assert.equal((await p.page("set-key", { name: "fakedata", value: "" })).result.hasKey, false)
  assert.match(await p.fb("keys"), /FakeData\s+no key yet/)
  assert.ok(await says(/^FakeData has no key, and Find sales heads needs it/))
  await p.page("set-key", { name: "fakedata", value: "sk-test-123" })
})

test("a run says when it started and how long it took, and --rows does only the next rows not done yet", async () => {
  assert.equal(took("2026-01-01T10:00:00Z", "2026-01-01T10:00:42Z"), "42 s")
  assert.equal(took("2026-01-01T10:00:00Z", "2026-01-01T10:03:12Z"), "3 min 12 s")
  assert.equal(took("2026-01-01T10:00:00Z", "2026-01-01T12:05:30Z"), "2 h 5 min")
  assert.equal(took("2026-01-01T10:00:00Z", "2026-01-03T13:00:00Z"), "2 d 3 h")
  const t = await json("run find-sales-heads --try 10")
  assert.equal(t.state, "done")
  assert.match(await p.fb("run find-sales-heads --max-usd 1 --rows 0", { fails: true }), /--rows is how many rows to do/)
  const r = await json("run find-sales-heads --max-usd 1 --rows 5 --wait")
  assert.deepEqual([r.state, r.rows.done + r.rows.failed, r.rows.of], ["done", 5, 5])
  assert.ok(Date.now() - new Date(r.started).getTime() < 120_000 && new Date(r.ended) >= new Date(r.started))
  assert.match(r.took, /^\d+ s$/)
  assert.match(await p.fb(`runs ${r.run}`), /Took\s+\d+ s/)
  // 10 tried, 5 run: 15 of the 30 have a result, in the order of the list.
  assert.deepEqual((await json("sql 'select count(*)::int as n, max(id)::int as last from sales_heads'")).rows[0], { n: 15, last: 15 })
})

test("runs are filtered by state and by workflow", async () => {
  const all = (await json("runs")) as { run: number; workflow: string; state: string }[]
  assert.equal(all.length, 2)
  assert.deepEqual(((await json("runs --state done")) as any[]).length, 2)
  assert.deepEqual(await json("runs --state paused"), [])
  assert.deepEqual(await json("runs --workflow score-fit"), [])
  assert.deepEqual(
    ((await json("runs --workflow find-sales-heads --state done")) as any[]).map((r) => r.run),
    all.map((r) => r.run),
  )
  // A filter is a value, never a piece of the SQL.
  assert.deepEqual((await p.page("runs", { state: "done' or '1'='1" })).result, [])
})

test("one run of a workflow at a time: a second start is refused with the number of the one that is going", async () => {
  provider.state.delay = 250
  const first = await json("run find-sales-heads --max-usd 1")
  assert.equal(first.state, "running")
  const second = await p.fb("run find-sales-heads --max-usd 1", { fails: true })
  assert.match(
    second,
    new RegExp(`Run ${first.run} of find-sales-heads is going now\\. One run of a workflow at a time: wait for it \\(npx flowbound runs ${first.run}\\) or stop it \\(npx flowbound stop ${first.run}\\)`),
  )
  assert.match(await p.fb("run find-sales-heads --try 3", { fails: true }), /is going now/)
  // Another workflow is not held up by it.
  assert.equal((await json("run score-fit --try 2")).state, "done")
  provider.state.delay = 0
  const r = await done(first.run)
  assert.deepEqual([r.state, r.rows.done + r.rows.failed], ["done", 15])
})

test("Home shows the yes a run paused at its cap waits for, and finds a run that says it is running while nothing moves", async () => {
  fs.writeFileSync(path.join(p.root, "more.csv"), p.csv(31, 60))
  await p.fb("import more.csv --as target_list --add")
  await p.fb("run find-sales-heads --try 2")
  const capped = await json("run find-sales-heads --max-usd 0.01 --wait")
  assert.equal(capped.state, "paused")
  assert.match(capped.why, /^Reached the \$0\.01 cap for this run after \d+ of \d+ rows, so it paused/)
  const cap = (await says(/^Go on with "Find sales heads" past the \$0\.01 cap for this run/))!
  assert.notEqual(cap.when, "soon", "a yes that waits is something to answer now")
  assert.match(cap.fix, /^Tell your agent yes \(it passes it on: npx flowbound yes \d+ --max-usd 0\.02\), or Not now\./)
  assert.equal(cap.link, `${p.url()}/runs?run=${capped.run}`)
  // While that yes waits, the workflow's schedule skips: one question at a time.
  assert.match(await p.fb("schedule-run weekly"), new RegExp(`Run ${capped.run} of "find-sales-heads" waits for a yes on Home, so this time was skipped`))
  // A run nobody is doing: it says running, and no row has moved for two hours.
  await sql(`update fb_workflow_sdk.rows set at = now() - interval '2 hours' where run = ${capped.run}`)
  await sql(`update fb_workflow_sdk.runs set state = 'running', code = null, reason = null, finished_at = null, started_at = now() - interval '2 hours' where id = ${capped.run}`)
  const stuck = (await says(/says it is running, but no row has moved for half an hour/))!
  assert.match(stuck.what, new RegExp(`run ${capped.run}`))
  assert.match(stuck.fix, /stop it on its page/)
  await p.fb(`stop ${capped.run}`)
  assert.equal(await says(/says it is running/), undefined)
})

test("Not now stops a run that waits for a yes; a schedule then runs again, under the permissions", async () => {
  const capped = await json("run find-sales-heads --max-usd 0.01 --wait")
  assert.equal(capped.state, "paused")
  const said = await p.page("no", { run: capped.run })
  assert.equal(said.result.state, "stopped")
  assert.equal(said.result.why, "Not now, said by you.")
  assert.equal(await says(/^Go on with/), undefined)
  const fired = await p.fb("schedule-run weekly")
  assert.match(fired, /^Started run \d+ for \d+ rows, under the permissions\.$/)
  const run = Number(/run (\d+)/.exec(fired)![1])
  const out = await done(run)
  assert.equal(out.startedBy, "schedule:weekly")
  assert.equal(out.yesBy, "not needed (auto inside caps)")
})

test("Home leads the menu and is where the address lands; the menu has a line before where you set things up; a list without Home still lands on the runs", async () => {
  const home = await fetch(`${p.url()}/`, { redirect: "manual" })
  assert.equal(home.headers.get("location"), "/home")
  const html = await (await fetch(`${p.url()}/home`)).text()
  const nav = html.slice(html.indexOf('<nav class="menu"'), html.indexOf("</nav>"))
  const tabs = [...nav.matchAll(/<hr class="sep">|<a href="([^"]+)"[^>]*>([^<]+)(?:<span class="count"[^>]*><\/span>)?<\/a>/g)].map((m) => (m[1] ? `${m[1]} ${m[2]}` : "--"))
  assert.deepEqual(tabs, ["/home Home", "/workflows Workflows", "/runs Runs", "/schedules Schedules", "/tables Data", "/context Context", "--", "/keys Connections", "/connect Agents", "/permissions Permissions"])
  // Changes is not in the menu: a line under it says how many are not live yet, once the page has asked.
  assert.match(nav, /<a class="publish" href="\/changes" data-go="\/changes" data-changes hidden><\/a>/)
  assert.match(html, /<section data-page="\/home" hidden>/)
  assert.match(html, /class="brand" href="\/" data-go="\/home"/)
  // Home's old address still opens Home, for links and agents that have it.
  const old = await (await fetch(`${p.url()}/needs`)).text()
  assert.match(old, /<title>Home · Flowbound<\/title>/)
  assert.match(old, /<a href="\/home" data-go="\/home" aria-current="page">Home/)
  assert.equal((await fetch(`${p.url()}/schedules`)).status, 200)
  // Gone: the page of every raw table, the lists page and the old overview; People is only live.
  for (const gone of ["/data", "/lists", "/standing", "/overview", "/people"]) assert.equal((await fetch(`${p.url()}${gone}`)).status, 404, gone)
  const { pages } = await import("../src/plugins/pages.ts")
  const { boot } = await import("../src/core/server.ts")
  const app = await boot([pages(), { name: "x", pages: { "/runs": { title: "Runs", file: path.join(repo, "src/plugins/workflow-sdk/runs.html"), menu: true } } }], { root: p.root, url: "http://localhost:1" })
  assert.equal((await app.fetch(new Request("http://localhost:1/"))).headers.get("location"), "/runs")
  await app.stop()
})

test("a list brought again with a key is brought up to date, not doubled", async () => {
  fs.writeFileSync(path.join(p.root, "people.csv"), "email,name,title\nana@corp.example,Ana,CEO\nbo@corp.example,Bo,CTO\ncy@corp.example,Cy,\n")
  assert.equal(await p.fb("import people.csv --key email"), "people_list   3 rows")
  fs.writeFileSync(path.join(p.root, "people.csv"), "email,name,title\n ANA@corp.example ,Ana Maria,\nbo@corp.example,Bo,VP Engineering\ndi@corp.example,Di,COO\n")
  assert.equal(await p.fb("import people.csv --add --key email"), "people_list   4 rows (1 added, 2 already there and brought up to date)")
  const rows = (await json("sql 'select email, name, title from people_list order by id'")).rows
  assert.deepEqual(rows, [
    { email: "ana@corp.example", name: "Ana Maria", title: "CEO" }, // an empty cell never wipes what the list has
    { email: "bo@corp.example", name: "Bo", title: "VP Engineering" },
    { email: "cy@corp.example", name: "Cy", title: "" },
    { email: "di@corp.example", name: "Di", title: "COO" },
  ])
  assert.match(await p.fb("import people.csv --add --key phone", { fails: true }), /The key column "phone" is not in these rows/)
  // Without a key, adding is adding, as before.
  assert.equal(await p.fb("import people.csv --add"), "people_list   7 rows (3 added)")
  await sql("drop table people_list")
})

test("a CSV made for a spreadsheet cannot run as a formula there; numbers and phone numbers stay as they are", async () => {
  const rows = [
    ["name", "note"],
    ["A", '=HYPERLINK("http://evil.example","click")'],
    ["B", "+46 70 123 45 67"],
    ["C", "-12.5"],
    ["D", "@handle"],
    ["E", "-nope"],
    ["F", "\tTab"],
    ["G", "plain"],
  ]
  assert.equal(toCsv(rows, { forSheets: true }), `name,note\nA,"'=HYPERLINK(""http://evil.example"",""click"")"\nB,+46 70 123 45 67\nC,-12.5\nD,'@handle\nE,'-nope\nF,'\tTab\nG,plain\n`)
  // What an agent reads on the command line is the cell as it is.
  assert.equal(toCsv([["=1+1"]]), "=1+1\n")
  fs.writeFileSync(path.join(p.root, "scraped.csv"), "company,about\nEvil Co,\"=cmd|' /C calc'!A0\"\n")
  await p.fb("import scraped.csv --as scraped")
  await p.fb("export scraped --csv")
  assert.equal(fs.readFileSync(path.join(p.root, "scraped.csv"), "utf8"), `company,about\nEvil Co,'=cmd|' /C calc'!A0\n`)
  assert.match(await p.fb("table scraped"), /Evil Co,=cmd/)
})

test("a webhook reads a sender's own shape: a nested event becomes a row, an event that is not a row is answered and left, and a wrong one is said", async () => {
  await p.page("set-key", { name: "bookings", value: SECRET })
  const post = async (payload: unknown) => {
    const body = JSON.stringify(payload)
    const res = await fetch(`${p.url()}/hooks/bookings`, { method: "POST", headers: { "content-type": "application/json", "x-flowbound-signature": createHmac("sha256", SECRET).update(body).digest("hex") }, body })
    return { status: res.status, ...(await res.json()) }
  }
  const made = await post({ type: "booking.created", id: "evt_1", payload: { attendee: { email: "Dana@Corp.example", name: "Dana Reyes" }, startsAt: "2026-12-01T09:00:00Z" } })
  assert.deepEqual([made.status, made.received, made.added], [200, 1, 1])
  assert.deepEqual((await json("sql 'select email, name from bookings_list'")).rows, [{ email: "Dana@Corp.example", name: "Dana Reyes" }])
  const cancelled = await post({ type: "booking.cancelled", id: "evt_2", payload: { attendee: { email: "dana@corp.example" } } })
  assert.deepEqual([cancelled.status, cancelled.added, cancelled.ignored], [200, 0, 1])
  // The same person booked again: the key says it is the same row.
  const again = await post({ type: "booking.created", id: "evt_3", payload: { attendee: { email: "dana@corp.example", name: "Dana" } } })
  assert.deepEqual([again.status, again.added, again.duplicates], [200, 0, 1])
  const wrong = await post({ type: "booking.created", id: "evt_4" })
  assert.equal(wrong.status, 422)
  assert.match(wrong.error, /The "row" function of hook\(\{ id: "bookings" \}\) could not read this delivery/)
  assert.equal((await json("sql 'select count(*)::int as n from bookings_list'")).rows[0].n, 1)
  // Unsigned, the reader never runs.
  assert.equal((await fetch(`${p.url()}/hooks/bookings`, { method: "POST", body: "{}" })).status, 401)
})

test("recipes are read only when asked for, and each one runs as it is written (FAKE provider, FAKE model)", async () => {
  assert.equal(recipeFiles.length, 4)
  assert.match(await p.fb("docs recipes"), /^## Recipes\n[\s\S]*### 1\. Ask a second provider when the first finds nothing/)
  const main = await p.fb("docs")
  assert.doesNotMatch(main, /### 1\. Ask a second provider/)
  assert.match(main, /`npx flowbound docs recipes` prints whole workflow files/)
  assert.match(await p.fb("docs nope"), /Topics: .*workflow-sdk.*recipes/)

  // 1. The second provider is asked only for the row the first one did not find (the fake has no head for Co7).
  const before = provider.state.times.filter((t) => t.path === "/v2/head-b").length
  const two = await json("run find-heads-two-sources --try 10")
  assert.deepEqual(
    two.fields.map((f: any) => [f.name, f.filled]),
    [
      ["head", 10],
      ["found_by", 10],
    ],
  )
  assert.equal(provider.state.times.filter((t) => t.path === "/v2/head-b").length - before, 1)
  const by = (await json("sql 'select id, head, found_by from heads_two_sources order by id'")).rows
  assert.deepEqual([by[5].found_by, by[6].found_by, by[6].head], ["acme", "backup", "Second Source Head Of Co7"])

  // 2. A verdict and its evidence, both from the one answer of the FAKE model.
  const fit = (await json("sql 'select fit, why, fit__fact = why__fact as same_fact from fit_scores order by id limit 1'")).rows[0]
  assert.equal(fit.fit, "possible")
  assert.match(fit.why, /^FAKE reason/)
  assert.equal(fit.same_fact, true)

  // 3. One row in, three rows out; doing a company again adds nobody twice; the next workflow reads the list it filled.
  const people = await json("run find-people --try 2")
  assert.deepEqual(
    people.fields.map((f: any) => [f.name, f.filled]),
    [["people", 2]],
  )
  assert.equal((await json("sql 'select count(*)::int as n from people_list'")).rows[0].n, 6)
  await sql("delete from people_found where id = 1")
  await p.fb("run find-people --try 1")
  assert.equal((await json("sql 'select count(*)::int as n from people_list'")).rows[0].n, 6, "the key kept the same three people from being added again")
  assert.match(await p.fb("tables"), /people_list\s+6 rows\s+added by a workflow/)
  const emails = await json("run people-emails --try 6")
  assert.equal(emails.state, "done")
  assert.equal(emails.fields[0].name, "email")
  assert.ok(emails.fields[0].filled >= 4)
})

test("the skill says what it is not for, and stays within what every agent app loads", () => {
  const skill = fs.readFileSync(path.join(repo, "skills", "flowbound", "SKILL.md"), "utf8")
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!
  const description = /^description: (.*)$/m.exec(front)![1]!
  assert.equal(/^name: (.*)$/m.exec(front)![1], "flowbound")
  // Agent apps cut or skip a description over 1,024 characters (the earlier product lost a skill to a 1,051-character one).
  assert.ok(description.length <= 1024, `the description is ${description.length} characters`)
  assert.match(description, /Use when/)
  assert.match(description, /Not for/)
  assert.ok(skill.split("\n").length <= 60, "the skill stays a stub: the instructions ship with the installed version")
})

test("init --example: a small made-up list and a workflow that needs no key, tried once for $0.00", async () => {
  const fresh = project(provider.host)
  try {
    const out = await fresh.fb("init --example")
    assert.match(out, /workflows\/tidy-companies\.ts\s+an example that needs no key and costs nothing/)
    assert.match(out, /The example ran: 8 made-up companies, tidied with plain code, \$0\.00\. See it at http:\/\/localhost:\d+\/runs/)
    const run = (prefix: string) => fresh.fb(prefix)
    assert.match(await run("runs"), /Tidy companies, try-out\s+8 of 8\s+failed 0\s+\$0\.00/)
    const rows = JSON.parse(await run("table example_tidy --json")).rows.map((r: any) => r.cells)
    // The list's first column, then the two answers: a domain from a messy address, a name without its company form.
    assert.deepEqual(rows[0].slice(1, 3), ["northwind.example", "Northwind Traders"])
    assert.deepEqual(rows[2].slice(1, 3), ["bluebird-logistics.example", "Bluebird Logistics"])
    assert.deepEqual(rows[7].slice(1, 3), [null, "Harbor & Pine"], "an empty website is not found, not a made-up domain")
    assert.equal(provider.state.models.length >= 0 && JSON.parse(await run("spend --json")).thisMonth.length, 0, "no provider was called")
    // Home's Get started ticked itself: Flowbound started, an agent (here the command line) reached it, the free sample
    // ran once. No key is saved yet, so the list stays on Home.
    const started = JSON.parse(await run("get-started --json"))
    assert.deepEqual(
      started.items.map((i: any) => [i.title, i.done]),
      [
        ["Set up Flowbound", true],
        ["Connect an agent", true],
        ["Run the free sample", true],
        ["Add a connection", false],
      ],
    )
    assert.equal(started.all, false)
    // Asked again, it changes nothing and runs nothing twice.
    assert.doesNotMatch(await fresh.fb("init --example"), /an example that needs no key/)
  } finally {
    await fresh.stop()
  }
})
