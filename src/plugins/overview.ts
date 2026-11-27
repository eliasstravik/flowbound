// Home: the page a person opens first, and the check-up an agent runs first. Neither knows any other plug-in:
// each plug-in says what needs a person (its `attention`: a yes that waits, a key), and this one only gathers it.
// On a first day Home also shows Get started: four things that tick themselves when they happen.
import { hasClients } from "../core/local.ts"
import { type Attention, type Flowbound, plugin } from "../core/plugin.ts"
import { asset } from "./util.ts"

export type Need = Attention & { from: string; link?: string }
export type Checkup = {
  /** True when nothing is stopped or broken now. Things that only come due soon do not make it false. */
  ok: boolean
  needs: Need[]
  /** The plug-ins that were asked. */
  checked: string[]
  page: string
}
export type Overview = {
  checkup: (o?: { deep?: boolean }) => Promise<Checkup>
  /** An agent reached this Flowbound (a token, the MCP server or the command line): Get started ticks "Connect an agent". */
  agent: () => void
}
/** Get started, in order. Each ticks itself the first time it happens, and stays ticked. */
const FIRSTS = [
  { id: "setup", title: "Set up Flowbound", text: "Done when Flowbound first starts.", page: null },
  { id: "agent", title: "Connect an agent", text: "Done when an agent first connects.", page: "/connect" },
  { id: "sample", title: "Run the free sample", text: "Done when the sample workflow has run once: made-up companies, $0.", page: "/workflows" },
  { id: "key", title: "Add a connection", text: "Done when you save your first key.", page: "/keys" },
] as const
/** The free sample workflows `flowbound init --example` writes. */
const SAMPLES = ["sample-contacts", "tidy-companies"]

export const overview = () => {
  let fb: Flowbound
  let agentSeen = false
  const S = "fb_overview"
  const q = async (sql: string, params?: unknown[]) => (fb.has("records") ? (await fb.use("records").query(sql, params)).rows : [])
  const tick = (id: string) => q(`insert into ${S}.firsts (id) values ($1) on conflict do nothing`, [id])

  /** Get started: what has happened at least once. Ticked here the first time it is seen, so it stays ticked. */
  async function started() {
    const done = new Set<string>((await q(`select id from ${S}.firsts`)).map((r: any) => r.id))
    const now: Record<string, () => Promise<boolean>> = {
      setup: async () => true,
      agent: async () =>
        agentSeen || (!fb.live && hasClients(fb.root)) || (fb.live && fb.tools.tokens ? ((await fb.call("tokens", {}, { kind: "system", name: "Flowbound", via: "page" })) as unknown[]).length > 0 : false),
      sample: async () => (await q("select 1 from fb_workflow_sdk.runs where workflow = any($1) and state = 'done' limit 1", [SAMPLES]).catch(() => [])).length > 0,
      key: async () => (fb.tools.keys ? ((await fb.call("keys", {}, { kind: "system", name: "Flowbound", via: "page" })) as { cards: { hasKey?: boolean }[] }).cards.some((k) => k.hasKey) : false),
    }
    for (const f of FIRSTS)
      if (!done.has(f.id) && (await now[f.id]!().catch(() => false))) {
        await tick(f.id)
        done.add(f.id)
      }
    const items = FIRSTS.map((f) => ({ ...f, done: done.has(f.id) }))
    return { items, all: items.every((i) => i.done) }
  }

  const checkup: Overview["checkup"] = async ({ deep } = {}) => {
    const needs: Need[] = []
    const checked: string[] = []
    for (const p of fb.plugins) {
      if (typeof p.attention !== "function") continue
      checked.push(p.name)
      try {
        for (const a of await p.attention({ deep })) {
          const query = a.params && Object.keys(a.params).length ? `?${new URLSearchParams(Object.entries(a.params).map(([k, v]) => [k, String(v)]))}` : ""
          needs.push({ ...a, from: p.name, ...(a.page ? { link: `${fb.url}${a.page}${query}` } : {}) })
        }
      } catch (e: any) {
        // One plug-in that cannot answer must not hide what the others found.
        needs.push({ from: p.name, what: `The ${p.name} plugin could not say how it is: ${String(e?.message ?? e).split("\n")[0]}`, fix: "Run the check-up again. If it stays, look at .flowbound/dev.log." })
      }
    }
    // What is stopped now comes before what only comes due soon; within each, as the plug-ins are listed.
    needs.sort((a, b) => Number(a.when === "soon") - Number(b.when === "soon"))
    return { ok: !needs.some((n) => n.when !== "soon"), needs, checked, page: `${fb.url}/home` }
  }

  return plugin({
    name: "overview",
    provides: "overview",
    migrations: [`create table ${S}.firsts (id text primary key, at timestamptz not null default now())`],
    start(f) {
      fb = f
      return {
        checkup,
        agent: () => {
          if (agentSeen) return
          agentSeen = true
          tick("agent").catch(() => (agentSeen = false))
        },
      } satisfies Overview
    },
    tools: {
      doctor: {
        about:
          "Home's Needs attention: everything that needs a person or is not right, each with the one thing to do about it. A yes that waits (ask mode, or a run paused at a cap), a key a workflow needs, a workflow file that is not well formed, a run that stopped short or seems stuck, a webhook with no signing secret. Run it first when something seems off, and before telling the person all is well.",
        role: "viewer",
        input: { deep: { type: "boolean", about: "also try every saved key again at its provider (a free call each)" } },
        run: (i) => checkup({ deep: i.deep === true }),
        print: (r: Checkup) => {
          const line = (n: Need, i: number) => `${i + 1}. ${n.what}\n   Do: ${n.fix}${n.link ? `\n   ${n.link}` : ""}`
          const now = r.needs.filter((n) => n.when !== "soon")
          const soon = r.needs.filter((n) => n.when === "soon")
          return [
            now.length ? `${now.length} ${now.length === 1 ? "thing needs" : "things need"} a person:` : "Nothing is stopped or broken.",
            ...now.map(line),
            ...(soon.length ? ["", "Coming up:", ...soon.map(line)] : []),
            "",
            `Looked at: ${r.checked.join(", ") || "nothing (no plugin in the list says how it is)"}.`,
            `Page: ${r.page}`,
          ].join("\n")
        },
      },
      "get-started": {
        about: "Home's Get started list on a first day: set up Flowbound, connect an agent, run the free sample, add a connection. Each ticks itself the first time it happens.",
        role: "viewer",
        run: () => started(),
        print: (r: Awaited<ReturnType<typeof started>>) => r.items.map((i) => `${i.done ? "[x]" : "[ ]"} ${i.title}: ${i.text}`).join("\n"),
      },
    },
    pages: {
      "/home": { title: "Home", file: asset("overview/overview.html"), menu: true, first: true, order: 1 },
      // Home's old address, for links and agents that still have it.
      "/needs": { title: "Home", file: asset("overview/overview.html") },
    },
    docs: asset("overview/overview.md"),
  })
}
