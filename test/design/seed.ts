// Every screen and state, for looking at the pages: three throwaway Flowbounds against a fake provider on this
// machine. Nothing here costs anything or leaves the machine. After `npm run build`:
//   node test/design/seed.ts            starts them, prints their addresses and stays up until it is stopped
// "full"  : runs in every state (asked first, done with failed rows, paused at its cap with a yes waiting, in
//           progress), a 10,000-row list, schedules and a webhook, keys saved and missing, the agent's summary and diagram.
// "empty" : a first-time user with no data.
// "live"  : a shared Flowbound behind its door (work login and the team password), for sign-in, People and Connect.
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { boot, listen } from "../../src/core/server.ts"
import { door, keys, ledger, mcp, overview, pages, plugin } from "../../src/index.ts"
import { project } from "../helpers.ts"

const PORTS = { full: Number(process.env.FULL_PORT ?? 4611), empty: Number(process.env.EMPTY_PORT ?? 4612), live: Number(process.env.LIVE_PORT ?? 4613) }
const KEY = "sk-design-123"
const say = (line: string) => console.log(line)

/** The fake provider: finds most people, fails some rows for a reason, and has one slow path so a run stays in progress. */
async function fake() {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {}
    const send = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json))
    if (req.headers["x-api-key"] !== KEY) return send(401, { message: "bad key" })
    if (req.url === "/v2/me") return send(200, { account: "fake" })
    // A CRM that takes people in: each call is a write.
    if (req.url === "/v2/crm/add") return send(200, { added: true, id: `c${Date.now()}` })
    const n = Number(String(body.company ?? body.linkedin_url ?? "").replace(/\D/g, ""))
    if (req.url === "/v2/slow") await new Promise((r) => setTimeout(r, 6000))
    if (req.url === "/v2/head" || req.url === "/v2/slow") {
      if (n % 9 === 4) return send(422, { message: `no company called "${body.company}" at this provider` })
      return n % 10 === 7
        ? send(404, { found: false })
        : send(200, {
            found: true,
            person: { full_name: ["Maya Lindqvist", "Jonas Berg", "Sara Holm", "Erik Nyström", "Lena Åkesson"][n % 5], title: n % 3 ? "VP Sales" : "Head of Sales", linkedin_url: `https://linkedin.example/in/co${n}` },
          })
    }
    if (req.url === "/v2/email") return n % 5 === 3 ? send(200, { found: false, email: null }) : send(200, { found: true, email: `sales${n}@co${n}.example` })
    send(400, { message: "unknown path" })
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

const workflow = (o: { from: string; into: string; fn: string; path?: string }) => `import { use } from "flowbound"

export const from = "${o.from}"
export const into = "${o.into}"

export async function ${o.fn}(company) {
  "use workflow"
  const head = await findHead(company)
  const email = await findEmail(head)
  return { head: head.name, title: head.title, email }
}

async function findHead(company) {
  "use step"
  const res = await use("fakedata").fetch("${o.path ?? "/v2/head"}", { body: { company: company.company } })
  return { name: res.pick("person.full_name"), title: res.pick("person.title"), linkedin: res.data.person?.linkedin_url ?? null }
}

async function findEmail(head) {
  "use step"
  if (!head.linkedin) return null
  const res = await use("fakedata").fetch("/v2/email", { body: { linkedin_url: head.linkedin } })
  return res.pick("email")
}
`
const NAMES = ["Northwind", "Bluebird", "Ironclad", "Lakeshore", "Redwood", "Silverline", "Brightwater", "Stonebridge", "Fairview", "Kestrel"]
const INDUSTRIES = ["software", "logistics", "retail", "healthcare", "finance", "manufacturing", "media", "energy"]
/** `first` keeps the companies of one list apart from another's, so no list is free because another paid for it. */
const csv = (rows: number, first: number) =>
  `company,domain,industry,employees,country\n${Array.from({ length: rows }, (_, i) => i + first)
    .map((k) => `${NAMES[k % 10]} ${k + 1},${NAMES[k % 10].toLowerCase()}${k + 1}.example,${INDUSTRIES[k % 8]},${20 + ((k * 37) % 4000)},${["SE", "NO", "DK", "FI", "DE", "NL", "UK", "US"][k % 8]}`)
    .join("\n")}\n`

function make(host: string, name: keyof typeof PORTS, more: string, env: Record<string, string> = {}) {
  const p = project(host)
  Object.assign(p.env, { FLOWBOUND_PORT: String(PORTS[name]), ...env })
  fs.writeFileSync(
    path.join(p.root, "flowbound.config.ts"),
    `import { firecrawl, hook, schedule } from "flowbound"\nimport { fakedata } from "./plugins/fakedata.ts"\nimport { crm } from "./plugins/crm.ts"\nexport default {\n  providers: [fakedata(), crm(), firecrawl()],\n${more}\n}\n`,
  )
  // A CRM card that can write, under the same permissions (a HubSpot or sequencer card works the same way).
  fs.writeFileSync(
    path.join(p.root, "plugins", "crm.ts"),
    `import { provider } from "flowbound"\nexport const crm = () => provider({ name: "crm", label: "FakeCRM", host: "${host}", key: { header: "x-api-key" }, docs: "${host}/docs", price: { perCall: 0 }, writes: ({ method }) => method !== "GET" })\n`,
  )
  fs.rmSync(path.join(p.root, "workflows", "find-sales-heads.ts"))
  return p
}

const host = await fake()
// A first-time user: the project as it is right after `init`, with nothing in it.
const empty = make(host, "empty", '  permissions: { mode: "auto", caps: { perRun: 5, perMonth: 100, writesPerMonth: 500 } },')
await empty.start()
say(`empty  ${empty.url()}`)

// Behind the door: a work login (never reached here: the sign-in page only shows its button) and the team password.
// In this process and in memory, as test/door.test.ts does: a live Flowbound's own postgres plugin wants a real database.
Object.assign(process.env, { FLOWBOUND_SECRET: "host-secret-for-design", FLOWBOUND_LOGIN_CLIENT_ID: "design", FLOWBOUND_LOGIN_CLIENT_SECRET: "design" })
const db = new PGlite()
const records = plugin({
  name: "records",
  provides: "records",
  async start(f) {
    for (const p of f.plugins) for (const sql of p.migrations ?? []) await db.exec(`create schema if not exists fb_${p.name}; ${sql}`)
    return { query: async (sql: string, params?: unknown[]) => ((r) => ({ rows: r.rows, count: r.affectedRows ?? r.rows.length, columns: r.fields.map((x) => x.name) }))(await db.query(sql, params as any[])) }
  },
})
const liveUrl = `http://localhost:${PORTS.live}`
const liveApp = await boot([records, keys(), ledger(), overview(), pages(), mcp(), door({ login: "google", domain: "acme.example", managers: ["maya@acme.example"], password: "team-pass-1" })], {
  root: fs.mkdtempSync(path.join(os.tmpdir(), "fb-design-")),
  url: liveUrl,
  live: true,
})
const liveServer = await listen(PORTS.live, async () => liveApp.fetch)
// Someone who came in with the team password, a few colleagues and one agent's token, so People and Connect have something to show.
const form = { "content-type": "application/x-www-form-urlencoded", origin: liveUrl, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }
const entered = await fetch(`${liveUrl}/door/password`, { method: "POST", redirect: "manual", headers: form, body: new URLSearchParams({ name: "Maya", password: "team-pass-1", to: "/people" }) })
const cookie = entered.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ")
await fetch(liveUrl + entered.headers.get("location"), { redirect: "manual", headers: { cookie } })
const asMaya = (tool: string, input: unknown) =>
  fetch(`${liveUrl}/api/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-flowbound-via": "page", origin: liveUrl, cookie }, body: JSON.stringify(input) })
for (const [email, rights] of [
  ["jonas@acme.example", "approve"],
  ["sara@acme.example", "edit"],
  ["erik@acme.example", "view"],
  ["lena@acme.example", "none"],
])
  await asMaya("set-rights", { email, rights })
await asMaya("make-token", { label: "Nightly enrichment script" })
say(`live   ${liveUrl}   (team password: team-pass-1)`)

const full = make(
  host,
  "full",
  `  permissions: {
    mode: "auto",
    caps: { perRun: 5, perMonth: 100, writesPerMonth: 500 },
    workflows: { "find-buyers": { mode: "ask" } },
    providers: { fakedata: { perMonth: 50 }, crm: { writesPerRun: 25 } },
  },
  schedules: [
    schedule({ id: "weekly-heads", workflow: "find-sales-heads", every: "monday 08:00", timezone: "Europe/Stockholm" }),
    schedule({ id: "daily-accounts", workflow: "score-accounts", every: "day 07:30", timezone: "Europe/Stockholm" }),
    hook({ id: "new-leads", workflow: "enrich-leads", key: "domain" }),
  ],`,
  // FULL_URL: the address it is looked at from when it is shared under a path on a private network.
  process.env.FULL_URL ? { FLOWBOUND_URL: process.env.FULL_URL } : {},
)
const w = (file: string, o: Parameters<typeof workflow>[0]) => fs.writeFileSync(path.join(full.root, "workflows", `${file}.ts`), workflow(o))
w("find-sales-heads", { from: "target_list", into: "sales_heads", fn: "findSalesHeads" })
// The agent's own summary and diagram for people, in the file beside the code (the prototype's "Find sales heads").
fs.appendFileSync(
  path.join(full.root, "workflows", "find-sales-heads.ts"),
  `
export const summary = "For each company: find its head of sales, then a work email for them. If nobody is found, the email is skipped. Companies we already know cost nothing."
export const diagram = \`<svg viewBox="0 0 320 196" aria-label="Diagram drawn by the agent">
<g font-size="12" fill="currentColor" font-family="system-ui, sans-serif">
<rect x="70" y="6" width="180" height="36" rx="8" fill="none" stroke="currentColor" opacity=".5"/><text x="160" y="29" text-anchor="middle">A company from your list</text>
<path d="M160 42v18" stroke="currentColor" opacity=".5"/>
<rect x="50" y="60" width="220" height="36" rx="8" fill="none" stroke="currentColor"/><text x="160" y="83" text-anchor="middle">Find the head of sales (FakeData)</text>
<path d="M160 96v18" stroke="currentColor" opacity=".5"/><text x="168" y="110" opacity=".6">nobody? skip</text>
<rect x="50" y="114" width="220" height="36" rx="8" fill="none" stroke="currentColor"/><text x="160" y="137" text-anchor="middle">Find a work email (FakeData)</text>
<path d="M160 150v18" stroke="currentColor" opacity=".5"/>
<text x="160" y="182" text-anchor="middle" opacity=".7">Name, title and email in your table</text>
</g></svg>\`
`,
)
w("score-accounts", { from: "accounts", into: "account_scores", fn: "scoreAccounts" })
w("check-partners", { from: "partners", into: "partner_contacts", fn: "checkPartners" })
w("enrich-leads", { from: "posted_leads", into: "leads", fn: "enrichLeads" })
w("research-companies", { from: "company_list", into: "company_research", fn: "researchCompanies", path: "/v2/slow" })
w("find-buyers", { from: "prospects", into: "buyers", fn: "findBuyers" })
// Add the heads found to the CRM: every call a write, counted against the CRM's own 25 writes a run.
fs.writeFileSync(
  path.join(full.root, "workflows", "add-to-crm.ts"),
  `import { use } from "flowbound"\n\nexport const from = "crm_list"\nexport const into = "crm_added"\nexport const summary = "Add each person to the CRM list \\"Q1 heads\\"."\n\nexport async function addToCrm(person) {\n  "use workflow"\n  return { added: await add(person) }\n}\n\nasync function add(person) {\n  "use step"\n  const res = await use("crm").fetch("/v2/crm/add", { body: { list: "Q1 heads", name: person.name, email: person.email } })\n  return res.pick("id")\n}\n`,
)
fs.writeFileSync(path.join(full.root, "crm_list.csv"), `name,email\n${Array.from({ length: 40 }, (_, i) => `Person ${i + 1},p${i + 1}@co${i + 1}.example`).join("\n")}\n`)
// One that reaches a card with no key (Firecrawl), never run: the keys page and the check-up say which workflow waits for it.
fs.writeFileSync(
  path.join(full.root, "workflows", "read-websites.ts"),
  `import { use } from "flowbound"\n\nexport const from = "prospects"\nexport const into = "website_notes"\n\nexport async function readWebsites(company) {\n  "use workflow"\n  return { about: await read(company) }\n}\n\nasync function read(company) {\n  "use step"\n  const res = await use("firecrawl").fetch("/v2/scrape", { body: { url: "https://" + company.domain } })\n  return res.pick("data.markdown")\n}\n`,
)
for (const [i, [file, rows]] of Object.entries({ target_list: 30, accounts: 60, partners: 12, company_list: 10_000, prospects: 240 }).entries())
  fs.writeFileSync(path.join(full.root, `${file}.csv`), csv(rows, i * 20_000))
await full.start()
const fb = async (args: string, o: { fails?: boolean } = {}) => {
  const out = await full.fb(args, o)
  say(`$ flowbound ${args}\n${out.split("\n").slice(0, 3).join("\n")}`)
  return out
}
await fb(`keys set fakedata ${KEY}`).catch(async () => full.page("set-key", { name: "fakedata", value: KEY }))
for (const list of ["target_list", "accounts", "partners", "company_list", "prospects", "crm_list"]) await fb(`import ${list}.csv --as ${list}`)
await full.page("set-key", { name: "crm", value: KEY })

// Done, with rows that failed and why.
await fb("run find-sales-heads --try 10 --wait")
await fb("run find-sales-heads --wait")
// Kept facts with an age: some bought 12 days ago (still fresh), some 140 days ago (past the window, bought again),
// and some rows asked again and answered from what is already known.
const sql = async (query: string) => {
  const out = await full.page("sql", { query })
  if (!out.ok) throw new Error(out.error)
}
const factsOf = (rows: string) => `select fact from fb_ledger.calls where scope->>'into' = 'sales_heads' and (scope->>'row')::int ${rows}`
await sql(`update fb_ledger.facts set at = now() - interval '12 days' where id in (${factsOf("between 1 and 5")})`)
await sql(`update fb_ledger.facts set at = now() - interval '140 days' where id in (${factsOf("between 6 and 8")})`)
await sql("delete from sales_heads where id in (1, 2, 3, 6, 7, 8)")
await fb("run find-sales-heads --wait")
// Writes to the CRM: the run pauses at the CRM's own 25 writes, with a yes waiting.
await fb("run add-to-crm --try 5 --wait")
await fb("run add-to-crm --wait")
// Paused at its cap, with a yes waiting under Needs you.
await fb("run score-accounts --try 10 --wait")
await fb("run score-accounts --max-usd 0.05 --wait")
// Asked first (its workflow's own rule is ask): the try-out is passed a yes, then the full run waits for one, with its estimate.
const asked = JSON.parse(await full.fb("run find-buyers --try 10 --json"))
await fb(`yes ${asked.run}`)
await full.until(async () => JSON.parse(await full.fb(`runs ${asked.run} --json`)).state !== "running")
await fb("run find-buyers")
await fb("run check-partners --try 10 --wait")
// In progress: a slow provider and a long list.
await fb("run research-companies --try 10 --wait")
await fb("run research-companies --max-usd 4")
say(`full   ${full.url()}`)
say("ready")
process.on("SIGTERM", async () => (await Promise.all([full.stop(), empty.stop(), liveServer.close()]), process.exit(0)))
setInterval(() => {}, 1 << 30)
