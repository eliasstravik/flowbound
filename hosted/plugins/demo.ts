import { timingSafeEqual } from "node:crypto"
import { type Flowbound, flowbound, mcp, type Plugin, plugin, type Records, Refused } from "flowbound"

const companies = [
  { company: "Northwind Works", domain: "northwind.example", contact: "Maya Lind" },
  { company: "Kestrel Labs", domain: "kestrel.example", contact: "Sam Berg" },
  { company: "Fjord Studio", domain: "fjord.example", contact: "Noor Rao" },
  { company: "Juniper Works", domain: "juniper.example", contact: "Lee Cole" },
]

export function samples() {
  return plugin({
    name: "sample-data",
    needs: ["records"],
    async start(fb) {
      const records = fb.use<Records>("records")
      const found = await records.query("select to_regclass('public.sample_companies') as present")
      if (!found.rows[0]?.present) {
        await records.add("sample_companies", companies.map(({ company, domain }) => ({ company, domain })), { key: "domain", origin: "Sample data" })
      }
      return {
        lookup(domain: string) {
          const row = companies.find((item) => item.domain === domain)
          return row ? { contact: row.contact, email: `hello@${row.domain}` } : { contact: null, email: null }
        },
      }
    },
  })
}

const tools = new Set(["docs", "execute", "doctor", "tables", "table", "workflows", "workflow", "runs", "run"])
const pages = new Set(["/needs", "/workflows", "/runs", "/tables"])
const window = "(now() at time zone 'UTC' - interval '2 hours')::date"

// A demo run starts fresh even when a previous visitor finished every row.
const fresh = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(fresh)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    key === "rows" && typeof item === "string" ? [key, "ready: every demo run starts fresh"] : [key, fresh(item)]))
}

const hidden = () => new Response("Not found", { status: 404 })

function scheduled(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const got = Buffer.from(req.headers.get("authorization") ?? "")
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export function demo() {
  let fb: Flowbound
  const db = () => fb.use<Records>("records")
  const allow = async (kind: string, cap: number) => {
    const { rows } = await db().query(
      `insert into fb_demo.usage (day, kind, used) values (${window}, $1, 1)
       on conflict (day, kind) do update set used = fb_demo.usage.used + 1 where fb_demo.usage.used < $2
       returning used`,
      [kind, cap],
    )
    if (!rows.length) throw new Refused("The shared demo has reached its limit for today. It resets at 02:00 UTC.", undefined, 429)
  }
  const reset = () => db().query(`
    do $demo$
    declare today date := ${window};
    begin
      perform pg_advisory_xact_lock(hashtext('flowbound demo nightly reset'));
      if exists (select 1 from fb_demo.resets where day = today) then return; end if;
      if exists (select 1 from fb_workflow_sdk.runs where state = 'running' and started_at > now() - interval '10 minutes') then return; end if;
      delete from fb_workflow_sdk.rows;
      delete from fb_workflow_sdk.runs;
      if to_regclass('public.sample_contacts') is not null then delete from public.sample_contacts; end if;
      delete from fb_demo.usage where day < today;
      delete from fb_demo.resets;
      insert into fb_demo.resets (day) values (today);
    end
    $demo$
  `)
  const access = plugin({
    name: "demo",
    needs: ["records", "runs"],
    migrations: [
      "create table fb_demo.usage(day date, kind text, used integer not null, primary key(day, kind)); create table fb_demo.resets(day date primary key)",
    ],
    async start(project) {
      fb = project
      await reset()
    },
    async guard(req, url) {
      const route = url.pathname.replace(/\/$/, "") || "/"
      const demoReset = route === "/demo/reset" && req.method === "GET" && scheduled(req)
      const apiTool = req.method === "POST" && route.startsWith("/api/") && tools.has(route.slice("/api/".length))
      const read = req.method === "GET" && (route === "/" || route === "/api" || route.startsWith("/assets/") || pages.has(route))
      if (!(demoReset || apiTool || read || route === "/mcp" || (!fb.live && route === "/.well-known/workflow/v1/flow"))) return hidden()
      if (apiTool || (route === "/mcp" && req.method === "POST")) {
        if (Number(req.headers.get("content-length")) > 16_384) return new Response("The demo only accepts small requests.", { status: 413 })
        try {
          await allow("requests", 400)
        } catch (error) {
          if (error instanceof Refused) return new Response(error.message, { status: error.status })
          throw error
        }
      }
      return { kind: "person", name: "Demo visitor", checked: false, role: "member", via: "demo" }
    },
    routes: {
      "GET /demo/reset": async () => {
        await reset()
        return new Response(null, { status: 204 })
      },
    },
    docs: "## Public demo\nRun sample-contacts on made-up companies whenever asked. Each run starts fresh, even when the rows already show as done. Use show with the run number for progress or with table sample_contacts for finished results. Show is read-only. The demo uses no keys and costs $0. Results are shared and reset at 02:00 UTC. The demo allows 20 runs and 400 chat requests per day.",
  })
  const list: Plugin[] = flowbound({
    changes: false,
    permissions: { mode: "auto", caps: { perRun: 0, perMonth: 0, writesPerMonth: 0 } },
    parts: { door: access },
    providers: [samples()],
  }).map((part) => part.name === "mcp" ? mcp({ timeoutMs: 2000 }) : part)
  for (const part of list) {
    if (part.pages) part.pages = Object.fromEntries(Object.entries(part.pages).filter(([page]) => pages.has(page)))
    if (!part.tools) continue
    part.tools = Object.fromEntries(Object.entries(part.tools).filter(([name]) => tools.has(name)))
    for (const name of ["workflow", "workflows"]) {
      const tool = part.tools[name]
      if (tool) part.tools[name] = { ...tool, run: async (input, who) => fresh(await tool.run(input, who)) }
    }
    const run = part.tools.run
    if (!run) continue
    part.tools.run = {
      ...run,
      async run(input, who) {
        if (input.workflow !== "sample-contacts") throw new Refused("Use the sample-contacts workflow in this demo.")
        await reset()
        const ready = await db().query(`select day from fb_demo.resets where day = ${window}`)
        if (!ready.rows.length) throw new Refused("The demo reset is waiting for the last run to finish. Try again in a minute.")
        await allow("run", 20)
        await db().query("do $fresh$ begin if to_regclass('public.sample_contacts') is not null then delete from public.sample_contacts; end if; end $fresh$")
        return run.run({ workflow: "sample-contacts", try: companies.length, maxUsd: 0, wait: false }, who)
      },
    }
  }
  return list
}
