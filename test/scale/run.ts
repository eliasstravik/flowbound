// The big run: a list of 10,000 companies through a four-step workflow (find a person, find an email, a model step,
// a score), against the honest fake provider and FAKE model of ./provider.ts. It spends nothing and calls nobody.
// Not part of `npm run check`: it takes many minutes. Run it by itself, after `npm run build`:
//   npm run test:scale                          10,000 rows, the database in the folder (PGlite), as on a laptop
//   DB=postgres npm run test:scale              a real Postgres in Docker (at most 1 GB of memory) and the Postgres world, as a server of your own
//   ROWS=500 SPEED=0.2 KILLS=0.5 npm run test:scale    a quick look
// Settings (environment): ROWS, DB, LANES (rows at a time), RATE (the card's speed limit, calls a second),
// KILLS (kill and restart at these shares of the run), ARRIVE (rows added while it runs), SPEED (scales the fake's
// waits), CAP (the first run stops at this many dollars), OUT (where the numbers go, as JSON), KEEP=1 (leave it running),
// PG_MEMORY (the Postgres container's limit). One at a time: it holds about 1 GB, and the database's container up to 1 GB more.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { project, repo } from "../helpers.ts"
import { KEY, scaleProvider } from "./provider.ts"

const env = (name: string, otherwise: string) => process.env[name] ?? otherwise
const ROWS = Number(env("ROWS", "10000"))
const DB = env("DB", "pglite") as "pglite" | "postgres"
const LANES = Number(env("LANES", "25"))
const RATE = Number(env("RATE", "40"))
const KILLS = env("KILLS", "0.2,0.5,0.8").split(",").filter(Boolean).map(Number)
const ARRIVE = Number(env("ARRIVE", "500"))
const SPEED = Number(env("SPEED", "1"))
const CAP = Number(env("CAP", "3"))
const PG = "flowbound-scale-pg"
/** The most memory the Postgres container may take: it is stopped by Docker before it can fill this machine. */
const PG_MEMORY = env("PG_MEMORY", "1g")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const say = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`)
const usd = (n: number) => `$${n.toFixed(4)}`

const WORKFLOW = `import { use } from "flowbound"

export const from = "company_list"
export const into = "leads"
export const concurrency = ${LANES}

export async function enrichCompanies(company) {
  "use workflow"
  const head = await findHead(company)
  const email = await findEmail(head)
  const opener = await writeOpener(company, head)
  const score = await scoreLead(company, head, email)
  return { head: head.name, title: head.title, email, opener, score }
}

async function findHead(company) {
  "use step"
  const res = await use("fakedata").fetch("/v2/head", { body: { company: company.company } })
  return { name: res.pick("person.full_name"), title: res.pick("person.title"), linkedin: res.data.person?.linkedin_url ?? null }
}

async function findEmail(head) {
  "use step"
  if (!head.linkedin) return null
  const res = await use("fakedata").fetch("/v2/email", { body: { linkedin_url: head.linkedin }, price: 0.004 })
  return res.pick("email")
}

async function writeOpener(company, head) {
  "use step"
  if (!head.linkedin) return null
  const about = { company: company.company, industry: company.industry, person: head.name.value, title: head.title.value }
  return use("ai").pick("Write one opening line for a cold email to this person.", about, { maxTokens: 300 })
}

async function scoreLead(company, head, email) {
  "use step"
  if (!head.linkedin) return 0
  return (head.title.value === "VP Sales" ? 50 : 30) + (email?.value ? 30 : 0) + (Number(company.employees) > 500 ? 20 : 5)
}
`
const NAMES = ["Northwind", "Bluebird", "Ironclad", "Lakeshore", "Redwood", "Silverline", "Brightwater", "Stonebridge", "Fairview", "Kestrel"]
const INDUSTRIES = ["software", "logistics", "retail", "healthcare", "finance", "manufacturing", "media", "energy"]
const COUNTRIES = ["SE", "NO", "DK", "FI", "DE", "NL", "UK", "US"]
const csv = (from: number, to: number) =>
  `company,domain,industry,employees,country\n${Array.from({ length: to - from + 1 }, (_, k) => {
    const i = from + k
    return `${NAMES[i % 10]} ${i},${NAMES[i % 10]!.toLowerCase()}${i}.example,${INDUSTRIES[i % 8]},${10 + ((i * 37) % 4000)},${COUNTRIES[(i * 7) % 8]}`
  }).join("\n")}\n`

const provider = await scaleProvider({ perSecond: RATE, speed: SPEED })
const p = project(provider.host)
delete (p.env as Record<string, string | undefined>).FLOWBOUND_RETRY_MS // the real waits between tries: 1 s, then 4 s
fs.rmSync(path.join(p.root, "workflows", "find-sales-heads.ts"))
fs.writeFileSync(path.join(p.root, "workflows", "enrich-companies.ts"), WORKFLOW)
fs.writeFileSync(
  path.join(p.root, "plugins", "fakedata.ts"),
  `import { provider } from "flowbound"\nexport const fakedata = () => provider({ name: "fakedata", label: "FakeData", host: "${provider.host}", key: { header: "x-api-key" }, docs: "${provider.host}/docs", price: { perCall: 0.002 }, rate: { perSecond: ${RATE} } })\n`,
)
fs.writeFileSync(
  path.join(p.root, "flowbound.config.ts"),
  `import { ai, cli, door, keys, ledger, mcp, pages, postgres, workflowSdk } from "flowbound"\nimport { fakedata } from "./plugins/fakedata.ts"\nexport default [postgres(), workflowSdk(${DB === "postgres" ? '{ on: "postgres" }' : ""}), keys(), ledger(), pages(), mcp(), cli(), door(), fakedata(), ai({ host: "${provider.host}" })]\n`,
)

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
/** A real Postgres in a local Docker container, with the runner's own tables: what stands in for the live database. */
function startPostgres() {
  try {
    docker("rm", "-f", PG)
  } catch {}
  docker("run", "-d", "--name", PG, "--memory", PG_MEMORY, "-e", "POSTGRES_PASSWORD=scale", "-e", "POSTGRES_DB=flowbound", "-p", "127.0.0.1::5432", "postgres:17-alpine")
  const port = docker("port", PG, "5432").split(":").pop()
  const url = `postgres://postgres:scale@127.0.0.1:${port}/flowbound`
  for (let i = 0; i < 60; i++) {
    try {
      docker("exec", PG, "psql", "-U", "postgres", "-d", "flowbound", "-c", "select 1")
      break
    } catch {
      execFileSync("sleep", ["0.5"])
    }
  }
  execFileSync(path.join(repo, "node_modules", ".bin", "bootstrap"), [], { cwd: p.root, env: { ...process.env, DATABASE_URL: url, WORKFLOW_POSTGRES_URL: url }, stdio: "ignore" })
  return url
}
let cookie = ""
if (DB === "postgres") {
  const port = p.env.FLOWBOUND_PORT!
  Object.assign(p.env, {
    DATABASE_URL: startPostgres(),
    FLOWBOUND_LIVE: "1",
    FLOWBOUND_SECRET: "host-secret-for-the-big-run",
    FLOWBOUND_PASSWORD: "team-pass-1",
    FLOWBOUND_URL: `http://localhost:${port}`,
    PORT: port,
    WORKFLOW_POSTGRES_JOB_PREFIX: "fbscale_",
  })
}
/** Sign in as a person, where there is a door: the team password of a first try-out. */
async function signIn() {
  if (DB !== "postgres") return
  const jar = new Map<string, string>()
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) jar.set(c.split("=")[0]!, c.split(";")[0]!)
  }
  keep(await fetch(`${p.url()}/door/password`, { method: "POST", body: new URLSearchParams({ password: "team-pass-1", name: "Dana" }), redirect: "manual" }))
  keep(await fetch(`${p.url()}/door/in?to=/runs`, { headers: { cookie: [...jar.values()].join("; ") }, redirect: "manual" }))
  cookie = [...jar.values()].join("; ")
}
/** Call a tool the way a page does, as a person. Returns the answer and how long it took. */
async function timed(tool: string, input: unknown = {}) {
  const t = performance.now()
  const res = await fetch(`${p.url()}/api/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-flowbound-via": "page", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(input) })
  const text = await res.text()
  const out = JSON.parse(text)
  if (!out.ok) throw new Error(`${tool}: ${out.error}`)
  return { result: out.result, ms: performance.now() - t, bytes: text.length }
}
const call = async (tool: string, input: unknown = {}) => (await timed(tool, input)).result
const sql = async (query: string) => (await call("sql", { query })).rows as any[]
const one = async (query: string) => (await sql(query))[0]

const serverPid = () => JSON.parse(fs.readFileSync(path.join(p.root, ".flowbound", "server.json"), "utf8")).pid as number
/** The most memory the Flowbound process held at any moment (the kernel's own high-water mark), over every restart. */
const memory = { mostMb: 0 }
const sample = () => {
  try {
    const kb = Number(/VmHWM:\s+(\d+)/.exec(fs.readFileSync(`/proc/${serverPid()}/status`, "utf8"))?.[1])
    memory.mostMb = Math.max(memory.mostMb, Math.round(kb / 1024))
  } catch {}
}
const waits: Record<string, number[]> = {}
/** Ask for what a page shows and keep how long the answer took. */
async function look(name: string, tool: string, input: unknown = {}) {
  const t = await timed(tool, input).catch(() => undefined)
  if (t) (waits[name] ??= []).push(t.ms)
}
const middle = (list: number[]) => Math.round([...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0)
const most = (list: number[]) => Math.round(Math.max(0, ...list))

/** Follow a run until it stops, killing and restarting Flowbound at the given shares, and adding rows once. */
async function follow(run: number, o: { kills?: number[]; arrive?: number } = {}) {
  const kills = [...(o.kills ?? [])]
  let arrive = o.arrive ?? 0
  const began = Date.now()
  let down = 0
  let resumed = 0
  for (let n = 0; ; n++) {
    await sleep(1000)
    sample()
    const t = await timed("runs", { run }).catch(() => undefined)
    if (!t) continue
    const v = t.result
    ;(waits["one run"] ??= []).push(t.ms)
    if (n % 10 === 5) {
      await look("all runs", "runs")
      await look("the results table, first 100 rows", "table", { name: "leads", limit: 100 })
      await look("the list of tables", "tables")
    }
    const share = (v.rows.done + v.rows.failed) / v.rows.of
    if (n % 30 === 0) say(`  run ${run}: ${v.rows.done + v.rows.failed} of ${v.rows.of} (${v.state}), ${provider.seen.atOnce} calls in the air, ${memory.mostMb} MB`)
    if (v.state === "paused" && resumed++ < 20) {
      say(`  paused (${v.why}); carrying on`)
      await call("resume", { run })
      continue
    }
    if (v.state !== "running") return { view: v, seconds: (Date.now() - began) / 1000, downSeconds: down / 1000, kills: (o.kills ?? []).length - kills.length }
    if (arrive && share >= 0.3) {
      const added = await call("import", { csv: csv(ROWS + 1, ROWS + arrive), csvName: "companies.csv", as: "company_list", add: true })
      say(`  ${added.added} new rows arrived while it runs (at ${Math.round(share * 100)}%)`)
      arrive = 0
    }
    if (kills.length && share >= kills[0]!) {
      const at = Date.now()
      say(`  kill at ${Math.round(share * 100)}% (${provider.seen.atOnce} calls in the air)`)
      kills.shift()
      p.kill()
      await sleep(1500)
      await p.start()
      await signIn()
      down += Date.now() - at
    }
  }
}
/** Say yes to a full run with a cap, as the person, and follow it. */
async function fullRun(maxUsd: number, o: Parameters<typeof follow>[1] & { anyway?: boolean } = {}) {
  let made = await call("run", { workflow: "enrich-companies", maxUsd, anyway: o.anyway })
  if (made.state === "waiting") made = await call("yes", { run: made.run, maxUsd })
  return { run: made.run as number, ...(await follow(made.run, o)) }
}
const ledgerNow = async () =>
  one("select coalesce(sum(cost_usd) filter (where not from_memory), 0)::float8 as usd, count(*) filter (where not from_memory)::int as calls, count(*) filter (where from_memory)::int as memory from fb_ledger.calls")
const sizeOf = (dir: string) => (fs.existsSync(dir) ? Number(execFileSync("du", ["-sb", dir], { encoding: "utf8" }).split("\t")[0]) : 0)
const filesIn = (dir: string) => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).length : 0)
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10

const checks: { what: string; ok: boolean; saw: string }[] = []
const check = (what: string, ok: boolean, saw: string) => {
  checks.push({ what, ok, saw })
  say(`  ${ok ? "ok " : "NOT OK"}  ${what}: ${saw}`)
}
const out: Record<string, any> = { rows: ROWS, db: DB, rowsAtATime: LANES, speedLimitPerSecond: RATE, kills: KILLS, arrive: ARRIVE, started: new Date().toISOString() }
try {
  let t = Date.now()
  await p.start()
  await signIn()
  for (const name of ["fakedata", "ai"]) await call("set-key", { name, value: KEY })
  out.startSeconds = (Date.now() - t) / 1000

  t = Date.now()
  await call("import", { csv: csv(1, ROWS), csvName: "companies.csv", as: "company_list" })
  out.importSeconds = (Date.now() - t) / 1000
  say(`imported ${ROWS} rows in ${out.importSeconds.toFixed(1)} s (${DB})`)

  t = Date.now()
  const tried = await call("run", { workflow: "enrich-companies", try: 10 })
  out.tryoutSeconds = (Date.now() - t) / 1000
  say(`try-out: ${tried.state}, ${tried.spent.text}; estimate for all ${usd(tried.tryout.estimateUsd)}`)

  // 1. A cap far below the list's cost: with ${LANES} rows at a time it must stop at it, never over.
  say(`a run with a ${usd(CAP)} cap`)
  const capped = await fullRun(CAP)
  const cap = await one(`select max_usd, spent_usd, held_usd, calls from fb_ledger.budgets where id = 'run:${capped.run}'`)
  check("the cap holds", capped.view.state === "stopped" && cap.spent_usd <= cap.max_usd + 1e-9 && cap.spent_usd > cap.max_usd * 0.9, `${capped.view.state}; spent ${usd(cap.spent_usd)} of ${usd(cap.max_usd)}`)

  // 2. The rest of the list, killed and restarted on the way, with new rows arriving.
  say(`the full run: ${ROWS} rows, ${LANES} at a time, kills at ${KILLS.join(", ") || "none"}`)
  const before = { requests: provider.seen.requests, done: (await one("select count(*)::int as n from leads")).n }
  const main = await fullRun(Math.max(10, ROWS * 0.02), { kills: KILLS, arrive: ARRIVE })
  const worked = main.seconds - main.downSeconds
  out.fullRun = {
    state: main.view.state,
    rows: main.view.rows,
    seconds: Math.round(main.seconds),
    secondsDown: Math.round(main.downSeconds),
    rowsPerSecond: Math.round(((main.view.rows.done + main.view.rows.failed) / worked) * 10) / 10,
    callsPerSecond: Math.round(((provider.seen.requests - before.requests) / worked) * 10) / 10,
    kills: main.kills,
  }
  say(`  ${main.view.state} in ${Math.round(main.seconds)} s (${Math.round(main.downSeconds)} s of that down): ${out.fullRun.rowsPerSecond} rows a second`)
  check("the run finished", main.view.state === "done", `${main.view.state}${main.view.why ? `: ${main.view.why}` : ""}`)

  // 3. Rows that arrived while it ran: taken by that run, or left for the next one. Either way none is lost.
  let list = (await one("select count(*)::int as n from company_list")).n
  let leads = (await one("select count(*)::int as n from leads")).n
  let failed = (await one(`select count(distinct row)::int as n from fb_workflow_sdk.rows where state = 'failed' and row not in (select id from leads)`)).n
  out.arrivals = { arrived: ARRIVE, takenByTheSameRun: Math.max(leads + failed - ROWS, 0) }
  if (leads + failed < list) {
    say(`  ${list - leads - failed} rows are not done yet (the ones that arrived): one more run`)
    const rest = await fullRun(Math.max(10, ROWS * 0.02))
    out.arrivals.nextRun = { state: rest.view.state, rows: rest.view.rows, seconds: Math.round(rest.seconds) }
    list = (await one("select count(*)::int as n from company_list")).n
    leads = (await one("select count(*)::int as n from leads")).n
    failed = (await one(`select count(distinct row)::int as n from fb_workflow_sdk.rows where state = 'failed' and row not in (select id from leads)`)).n
  }
  // Rows still in the air when the run said it was done: wait for them, and say how long that took.
  let stuck = 0
  const settling = Date.now()
  for (let i = 0; i < 90; i++, await sleep(1000)) if (!(stuck = (await one("select count(*)::int as n from fb_workflow_sdk.rows where state = 'running'")).n)) break
  out.secondsUntilTheLastRowLanded = Math.round((Date.now() - settling) / 1000)
  leads = (await one("select count(*)::int as n from leads")).n
  failed = (await one(`select count(distinct row)::int as n from fb_workflow_sdk.rows where state = 'failed' and row not in (select id from leads)`)).n
  check("no row is lost", leads + failed === list && stuck === 0, `${list} in the list = ${leads} with a result + ${failed} failed; ${stuck} left hanging`)
  out.rowsDone = leads
  out.rowsFailed = failed
  out.whyFailed = await sql("select regexp_replace(reason, '[0-9]+', 'N', 'g') as why, count(*)::int as rows from fb_workflow_sdk.rows where state = 'failed' group by 1 order by 2 desc limit 6")

  // 4. The money: the ledger against the provider's own bill.
  const led = await ledgerNow()
  const billed = provider.bill.nano / 1e9
  const lost = provider.bill.lostNano / 1e9
  const twice = provider.twice()
  out.money = {
    providerBilledUsd: billed,
    providerBilledCalls: provider.bill.calls,
    ledgerUsd: led.usd,
    ledgerCalls: led.calls,
    answeredFromMemory: led.memory,
    differenceUsd: Math.round((billed - led.usd) * 1e9) / 1e9,
    differenceCalls: provider.bill.calls - led.calls,
    chargedWithNobodyListening: { calls: provider.bill.lostCalls, usd: lost },
    boughtTwice: twice,
  }
  say(`  the provider billed ${usd(billed)} for ${provider.bill.calls} calls; the ledger says ${usd(led.usd)} for ${led.calls}`)
  if (!main.kills) check("the ledger equals the provider's bill, to the cent", Math.abs(billed - led.usd) < 0.005 && provider.bill.calls === led.calls, `difference ${usd(billed - led.usd)}`)
  else
    check(
      "the ledger equals the provider's bill, but for calls in the air at a kill",
      provider.bill.calls - led.calls <= main.kills * LANES && billed - led.usd >= -1e-6 && billed - led.usd <= main.kills * LANES * 0.004 + 1e-6,
      `difference ${usd(billed - led.usd)} over ${provider.bill.calls - led.calls} calls in ${main.kills} kills (at most ${LANES} can be in the air)`,
    )
  check("nothing recorded was bought twice", twice <= provider.bill.calls - led.calls, `${twice} requests charged twice, all of them calls in the air at a kill`)
  const facts = await one("select count(*)::int as facts, count(distinct key)::int as different from fb_ledger.facts")
  check("one paid fact per different request", facts.facts === facts.different, `${facts.facts} facts, ${facts.different} different requests`)
  const budgets = await sql(
    `select b.id, b.max_usd, b.spent_usd, b.held_usd, b.held_calls, (select coalesce(sum(c.cost_usd), 0)::float8 from fb_ledger.calls c where not c.from_memory and b.id = any(c.budgets)) as calls_usd from fb_ledger.budgets b order by b.id`,
  )
  const wrong = budgets.filter((b) => Math.abs(b.spent_usd - b.calls_usd) > 1e-6 || (b.max_usd !== null && b.spent_usd > b.max_usd + 1e-9))
  check("every cap's total is the sum of its calls, and under its cap", !wrong.length, wrong.length ? JSON.stringify(wrong) : `${budgets.length} caps`)
  const held = budgets.filter((b) => b.held_usd > 1e-9 || b.held_calls > 0)
  out.moneyStillSetAside = held.map((b) => ({ cap: b.id, usd: b.held_usd, calls: b.held_calls }))
  if (DB === "pglite") check("no money is left set aside", !held.length, held.length ? JSON.stringify(out.moneyStillSetAside) : "0 held")

  // 5. Sizes.
  out.memoryMostMb = memory.mostMb
  out.callsAtOnceMost = provider.seen.mostAtOnce
  out.dataCallsInOneSecondMost = provider.seen.mostDataPerSecond
  out.refusedForSpeed = provider.seen.tooFast
  out.slowAnswers = provider.seen.slow
  out.providerAnswers = provider.seen.by
  check(
    "the speed limit on the card held",
    provider.seen.tooFast === 0 && provider.seen.mostDataPerSecond <= RATE * 1.25,
    `most in one second ${provider.seen.mostDataPerSecond} (limit ${RATE}); refused for speed ${provider.seen.tooFast}`,
  )
  if (DB === "pglite") {
    out.databaseMb = mb(sizeOf(path.join(p.root, ".flowbound", "pg")))
    out.runnerHistoryMb = mb(sizeOf(path.join(p.root, ".flowbound", "workflow")))
    out.runnerHistoryFiles = filesIn(path.join(p.root, ".flowbound", "workflow"))
    // What the runner itself wrote down: its runs and the events in them (Vercel bills its hosted runner by the event).
    const world = new DatabaseSync(path.join(p.root, ".flowbound", "workflow", "world.db"), { readOnly: true })
    const n = (table: string) => (world.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n
    out.runnerHistory = { runs: n("runs"), events: n("events"), steps: n("steps"), mostEventsInOneRun: (world.prepare("select max(seq) as n from runs").get() as { n: number }).n }
    world.close()
  } else {
    const size = await one(
      "select pg_database_size(current_database())::float8 as all, (select coalesce(sum(pg_total_relation_size(c.oid)), 0)::float8 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('workflow', 'graphile_worker') and c.relkind = 'r') as runner",
    )
    out.databaseMb = mb(size.all - size.runner)
    out.runnerHistoryMb = mb(size.runner)
    out.runnerHistory = Object.fromEntries(
      await Promise.all((await sql("select tablename as t from pg_tables where schemaname = 'workflow' order by 1")).map(async (r) => [r.t, (await one(`select count(*)::int as n from workflow."${r.t}"`)).n])),
    )
    out.runnerHistory = {
      ...out.runnerHistory,
      runs: out.runnerHistory.workflow_runs,
      events: out.runnerHistory.workflow_events,
      steps: out.runnerHistory.workflow_steps,
      mostEventsInOneRun: (await one("select coalesce(max(n), 0)::int as n from (select count(*) as n from workflow.workflow_events group by run_id) e")).n,
    }
    // The most memory the database's container held at any moment, as Docker counted it.
    out.databaseMemoryMostMb = Math.round(Number(docker("exec", PG, "cat", "/sys/fs/cgroup/memory.peak")) / 1024 / 1024)
  }
  out.tablesMb = Object.fromEntries(
    (
      await sql(
        "select n.nspname || '.' || c.relname as t, pg_total_relation_size(c.oid)::float8 as b from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') order by 2 desc limit 8",
      )
    ).map((r) => [r.t, mb(r.b)]),
  )

  // 6. What the pages and an agent's tools answer with 10,000 rows there.
  for (let i = 0; i < 5; i++) {
    await look("all runs", "runs")
    await look("one run", "runs", { run: main.run })
    await look("the results table, first 100 rows", "table", { name: "leads", limit: 100 })
    await look("the list of tables", "tables")
  }
  out.answersMs = Object.fromEntries(Object.entries(waits).map(([k, v]) => [k, { usual: middle(v), slowest: most(v) }]))
  // The page's "Download CSV" comes as one answer. A host can cap how big one answer may be (Vercel: 4.5 MB).
  const csvFile = await timed("export", { table: "leads" })
  out.csvDownload = { rows: csvFile.result.rows, mb: mb(csvFile.bytes), ms: Math.round(csvFile.ms) }
  const upload = csv(1, ROWS)
  out.csvUploadMb = mb(upload.length)
  // Where there is a door, an agent comes in with a token a signed-in person made for it.
  const token = DB === "postgres" ? ((await call("make-token", { label: "the big run's agent" })).token as string) : ""
  const mcp = async (name: string, args: unknown) => {
    const t = performance.now()
    const res = await fetch(`${p.url()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
    const text = await res.text()
    return { kb: Math.round(text.length / 102.4) / 10, ms: Math.round(performance.now() - t), error: !res.ok || text.includes('"isError":true') ? text.slice(0, 300) : undefined }
  }
  out.agentTools = {
    "search (every tool)": await mcp("search", {}),
    "run: tables": await mcp("run", { tool: "tables" }),
    "run: runs": await mcp("run", { tool: "runs" }),
    "run: runs, one run": await mcp("run", { tool: "runs", input: { run: main.run } }),
    "run: table leads (as asked, no limit)": await mcp("run", { tool: "table", input: { name: "leads" } }),
    "run: table leads, limit 10000": await mcp("run", { tool: "table", input: { name: "leads", limit: 10000 } }),
    "run: sql select * from leads": await mcp("run", { tool: "sql", input: { query: "select * from leads" } }),
    "run: export leads": await mcp("run", { tool: "export", input: { table: "leads" } }),
    "show: the results table": await mcp("show", { page: "tables", table: "leads" }),
  }

  // 7. Results in SQL: sort and filter on the answers.
  const tryQuery = async (query: string) => {
    const t = performance.now()
    try {
      const rows = await sql(query)
      return { ok: true, ms: Math.round(performance.now() - t), first: rows[0] }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
    }
  }
  out.sql = {
    columns: await sql("select column_name, data_type from information_schema.columns where table_name = 'leads' order by ordinal_position"),
    "order by score desc limit 3": await tryQuery("select id, score from leads order by score desc limit 3"),
    "where score > 70": await tryQuery("select count(*)::int as n from leads where score > 70"),
    "where score::int > 70": await tryQuery("select count(*)::int as n from leads where score::int > 70"),
    "where title = 'VP Sales'": await tryQuery("select count(*)::int as n from leads where title = 'VP Sales'"),
    "where title #>> '{}' = 'VP Sales'": await tryQuery("select count(*)::int as n from leads where title #>> '{}' = 'VP Sales'"),
    "where email like '%corp.example'": await tryQuery("select count(*)::int as n from leads where email like '%corp.example'"),
    "join with the list, by industry": await tryQuery("select l.industry, count(*)::int as n, round(avg(r.score::int)) as score from leads r join company_list l on l.id = r.id group by 1 order by 3 desc limit 3"),
  }

  // 8. The same list again: every answer is in memory, so it costs nothing, and it shows how fast the runner alone is.
  if (env("AGAIN", "1") === "1") {
    say("the same list again: everything from memory")
    const billBefore = provider.bill.nano
    await sql("delete from leads")
    // The try-out's card counts the fields in the results table, which is empty now: the person says "run anyway".
    const again = await fullRun(1, { anyway: true })
    const spent = await one(`select spent_usd, calls from fb_ledger.budgets where id = 'run:${again.run}'`)
    out.secondRun = {
      state: again.view.state,
      rows: again.view.rows,
      seconds: Math.round(again.seconds),
      rowsPerSecond: Math.round(((again.view.rows.done + again.view.rows.failed) / again.seconds) * 10) / 10,
      spentUsd: spent.spent_usd,
      paidCalls: spent.calls,
    }
    say(`  ${again.view.state} in ${Math.round(again.seconds)} s: ${out.secondRun.rowsPerSecond} rows a second, spent ${usd(spent.spent_usd)}`)
    check(
      "a second run over the same list costs $0",
      provider.bill.nano === billBefore && spent.spent_usd === 0 && again.view.rows.done === leads,
      `the provider's bill grew by ${usd((provider.bill.nano - billBefore) / 1e9)}; ${again.view.rows.done} rows filled again`,
    )
    out.memoryMostMb = memory.mostMb
  }
  out.spentRealMoney = 0
} catch (e: any) {
  out.error = String(e?.stack ?? e)
  say(`STOPPED: ${out.error}`)
} finally {
  out.checks = checks
  out.finished = new Date().toISOString()
  const file = env("OUT", path.join(repo, ".flowbound", `scale-${DB}-${ROWS}.json`))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  say(`numbers: ${file}`)
  if (env("KEEP", "") === "1") {
    say(`left running at ${p.url()} in ${p.root} (kill it yourself)`)
    await new Promise(() => {})
  }
  p.kill()
  await sleep(500)
  await p.stop()
  await provider.close()
  if (DB === "postgres")
    try {
      execFileSync("docker", ["rm", "-f", PG], { stdio: "ignore" })
    } catch {}
}
const bad = checks.filter((c) => !c.ok)
console.log(bad.length || out.error ? `\n${bad.length} of ${checks.length} checks NOT OK${out.error ? ", and it stopped early" : ""}` : `\nAll ${checks.length} checks ok. Nothing was spent.`)
process.exit(bad.length || out.error ? 1 : 0)
