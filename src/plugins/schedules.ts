// Running without you: a schedule or a webhook is one line in flowbound.config.ts (schedules: [...]). A run it
// starts is a run like any other, under the same permissions: in ask mode it waits for the person's yes under Needs
// you, in auto it runs inside the caps, in skip it just runs. While a yes waits for a workflow, its schedule skips.
import crypto from "node:crypto"
import { type Attention, type Flowbound, plugin } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import type { KeyCard, Keys } from "./keys.ts"
import type { Records } from "./postgres.ts"
import { asset, sha, stable, title } from "./util.ts"
import { nextAfter, starts, toCron, when } from "./workflow-sdk/every.ts"
import type { Auto } from "./workflow-sdk.ts"

export type ScheduleLine = {
  /** Its name: how people and agents call it. */
  id: string
  /** The workflow's id: its file name without .ts. */
  workflow: string
  /** "monday 08:00", "day 08:00", "weekday 08:00", "hour", "2 hours", "15 minutes". */
  every: string
  /** Whose clock "08:00" is, like "Europe/Stockholm". Without it, the clock of the machine Flowbound runs on (UTC when live). */
  timezone?: string
}
export type HookLine = {
  id: string
  workflow: string
  /** The column that says two deliveries are the same row, like "email". Without it the whole row is compared. */
  key?: string
  /** How the sender signs: HMAC-SHA256 of the exact body with the shared secret. Hex in "x-flowbound-signature" unless said otherwise. */
  signature?: { header?: string; prefix?: string; encoding?: "hex" | "base64" }
  /**
   * Turn what the sender posts into a row, for senders with a shape of their own (a booking, a CRM event):
   * `row: (event) => ({ email: event.payload.attendee.email, name: event.payload.attendee.name })`.
   * Return nothing (null, undefined) for an event that is not a row, like a cancellation: it is answered 200 and
   * nothing is taken in. Return a list for an event that carries several rows. It only runs on a signed delivery.
   */
  row?: (event: any) => Record<string, unknown> | Record<string, unknown>[] | null | undefined
}
type Declared = { name: string; kind: "schedule" | "webhook"; workflow: string; when: string; schedule?: ScheduleLine; hook?: HookLine }
type Fired = { name: string; outcome: string; note: string; run?: number }

const S = "fb_schedules"
const KEPT = 50
const MAX_ROWS = 100
const HEADER = "x-flowbound-signature"
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const named = (kind: string, o: { id: string; workflow: string }) => {
  if (!NAME.test(String(o?.id))) throw new Error(`${kind}({ id }) must be a short name in lower-case letters, digits and dashes, like "weekly-heads". Got "${o?.id}".`)
  if (!o.workflow || typeof o.workflow !== "string") throw new Error(`${kind}({ id: "${o.id}" }) must name its workflow: workflow: "<the file name in workflows/ without .ts>".`)
}

/** One line in flowbound.config.ts's schedules: run a workflow on a schedule, under the permissions. */
export const schedule = (o: ScheduleLine) => {
  named("schedule", o)
  nextAfter(o.every, new Date(), o.timezone) // a form or a timezone Flowbound does not know is said when the list is read
  return plugin({ name: o.id, needs: ["schedules"], schedule: { ...o } })
}

/** One line in flowbound.config.ts's schedules: an address that takes rows in, /hooks/<id>. Every delivery must be signed; rows run under the permissions. */
export const hook = (o: HookLine) => {
  named("hook", o)
  const card: KeyCard = {
    name: o.id,
    label: `${title(o.id)} webhook: signing secret`,
    host: "",
    key: { header: o.signature?.header ?? HEADER },
    incoming: true,
    hint: `The secret the sender signs each delivery to /hooks/${o.id} with. Type the one the sender shows you, or make up a long random one and give the sender the same. Until it is here, every delivery is refused.`,
  }
  return plugin({ name: o.id, needs: ["schedules", "keys"], hook: { ...o }, card })
}

export const schedules = () => {
  let fb: Flowbound
  const db = () => fb.use<Records>("records")
  const auto = () => fb.use<{ auto: Auto }>("runs").auto
  const q = async <T = any>(sql: string, params?: unknown[]) => (await db().query<T>(sql, params)).rows
  const turns = new Map<string, Promise<unknown>>()

  const declared = (): Declared[] =>
    fb.plugins.flatMap((p): Declared[] => {
      const s = p.schedule as ScheduleLine | undefined
      const h = p.hook as HookLine | undefined
      if (s) return [{ name: p.name, kind: "schedule", workflow: s.workflow, when: when(s.every, s.timezone), schedule: s }]
      if (h) return [{ name: p.name, kind: "webhook", workflow: h.workflow, when: "each time a row arrives", hook: h }]
      return []
    })
  const one = (name: string): Declared => {
    const d = declared().find((x) => x.name === name)
    if (d) return d
    const all = declared().map((x) => x.name)
    throw new Refused(
      `There is no schedule or webhook called "${name}". ${all.length ? `There ${all.length === 1 ? "is" : "are"}: ${all.join(", ")}.` : 'None is in flowbound.config.ts yet. Add a line to its schedules, like schedule({ id: "weekly-heads", workflow: "<workflow id>", every: "monday 08:00" }).'}`,
      undefined,
      404,
    )
  }
  const by = (d: Declared) => `${d.kind}:${d.name}`

  /** Say what a firing did, for the page and for agents. The last 50 a name are kept. */
  const noted = async (f: Fired): Promise<Fired> => {
    await q(`insert into ${S}.fired (name, outcome, note, run) values ($1, $2, $3, $4)`, [f.name, f.outcome, f.note, f.run ?? null])
    await q(`delete from ${S}.fired where name = $1 and id <= (select max(id) from ${S}.fired where name = $1) - $2`, [f.name, KEPT])
    return f
  }

  /** A schedule came due, or a webhook row arrived: start a run under the permissions, or say why not. */
  const launch = (name: string, arrived = 0): Promise<Fired> => {
    const turn = (turns.get(name) ?? Promise.resolve()).then(() => launchNow(name, arrived))
    turns.set(
      name,
      turn.catch(() => {}),
    )
    return turn
  }
  async function launchNow(name: string, arrived: number): Promise<Fired> {
    const d = one(name)
    const say = (outcome: string, note: string, run?: number) => noted({ name, outcome, note, ...(run ? { run } : {}) })
    let wf: ReturnType<Auto["workflow"]>
    try {
      wf = auto().workflow(d.workflow)
    } catch (e: any) {
      return say("refused", `${String(e?.message ?? e)} Nothing ran.`)
    }
    const going = await auto().going(wf.id)
    if (going) {
      // A run this webhook started takes the new rows too; any other run of the workflow leaves them for the next time.
      const mine = d.kind === "webhook" && going.by === by(d) && arrived > 0
      if (mine && (await auto().absorb(by(d), arrived))) return say("waiting", `Run ${going.run} is going: it takes the new ${arrived === 1 ? "row" : "rows"} too.`)
      if (!mine)
        return say(
          "waiting",
          d.kind === "webhook" ? `Run ${going.run} of "${wf.id}" is going. The new rows are kept and run with the next delivery.` : `Run ${going.run} of "${wf.id}" is still going, so this time was skipped.`,
        )
    }
    // While a yes waits for this workflow (asked first, or paused at a cap), its schedule skips: one question at a time.
    const waits = await auto().waitingYes(wf.id)
    if (waits) return say("skipped", `Run ${waits} of "${wf.id}" waits for a yes on Home, so this time was skipped. Rows are kept.`, waits)
    const rows = await auto().rowsLeft(wf)
    if (rows <= 0) return say("nothing", `No rows are left to do in ${wf.from}.`)
    const r = await auto().launch({ wf, kind: d.kind, by: by(d) })
    if (!r) return say("waiting", `A run of "${wf.id}" started in the same moment, so this time was skipped.`)
    if (r.state === "waiting") return say("asked", `Run ${r.run} for ${rows} ${rows === 1 ? "row" : "rows"} waits for a yes on Home (ask mode).`, r.run)
    return say("ran", `Started run ${r.run} for ${rows} ${rows === 1 ? "row" : "rows"}, under the permissions.`, r.run)
  }

  /** The sender's signature: HMAC-SHA256 of the exact bytes with the shared secret, compared in constant time. */
  async function signed(h: HookLine, name: string, raw: Uint8Array, headers: Headers): Promise<"ok" | "no secret" | "wrong"> {
    const want = fb.has("keys") ? await fb.use<Keys>("keys").mac(name, raw) : undefined
    if (!want) return "no secret"
    const sig = h.signature ?? {}
    let given = (headers.get(sig.header ?? HEADER) ?? "").trim()
    const prefix = sig.prefix ?? "sha256="
    if (given.startsWith(prefix)) given = given.slice(prefix.length)
    else if (sig.prefix) return "wrong"
    const ok = (sig.encoding ?? "hex") === "hex" ? /^([0-9a-f]{2})+$/i.test(given) : /^[A-Za-z0-9+/]+=*$/.test(given)
    const got = ok ? Buffer.from(given, sig.encoding ?? "hex") : Buffer.alloc(0)
    return got.length === want.length && crypto.timingSafeEqual(got, want) ? "ok" : "wrong"
  }
  const reply = (status: number, body: unknown) => Response.json(body, { status })
  const tidy = (row: unknown): Record<string, string> => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Each row is a JSON object.")
    const out = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)]))
    if (!Object.keys(out).length) throw new Error("A row needs at least one field.")
    return out
  }

  /** A delivery to /hooks/<id>: the signature first, then the rows that are new, then a run under the permissions. */
  async function receive(req: Request, id: string): Promise<Response> {
    const d = declared().find((x) => x.name === id && x.kind === "webhook")
    if (!d) return reply(404, { error: `There is no webhook at /hooks/${id}.` })
    const h = d.hook!
    const header = h.signature?.header ?? HEADER
    const raw = new Uint8Array(await req.arrayBuffer())
    // The rule: the sender's signature first, over the raw bytes, before anything is parsed or done.
    const sig = await signed(h, d.name, raw, req.headers)
    if (sig !== "ok") {
      if (sig === "no secret") await noted({ name: d.name, outcome: "refused", note: `A delivery was refused: no signing secret is saved for this webhook yet. A person types it on the Connections page.` })
      return reply(401, { error: `The signature in "${header}" is missing or wrong. Nothing was taken in.` })
    }
    let rows: Record<string, string>[]
    try {
      const body = JSON.parse(new TextDecoder().decode(raw))
      let list = Array.isArray(body) ? body : [body]
      if (!list.length || list.length > MAX_ROWS) throw new Error(`Send 1 to ${MAX_ROWS} rows in one delivery.`)
      if (h.row) {
        // The line's own reader: the sender's shape in, a row out, or nothing for an event that is not a row.
        const sent = list.length
        try {
          list = list.flatMap((event) => {
            const out = h.row!(event)
            return out === null || out === undefined ? [] : Array.isArray(out) ? out : [out]
          })
        } catch (e: any) {
          return reply(422, { error: `The "row" function of hook({ id: "${d.name}" }) could not read this delivery: ${String(e?.message ?? e).slice(0, 200)}. Nothing was taken in.` })
        }
        if (!list.length) return reply(200, { received: sent, added: 0, ignored: sent, started: null, note: "Not a row for this webhook: nothing was taken in." })
        if (list.length > MAX_ROWS) throw new Error(`One delivery became ${list.length} rows; ${MAX_ROWS} is the most.`)
      }
      rows = list.map(tidy)
      if (h.key && rows.some((r) => !r[h.key!]?.trim())) throw new Error(`Each row needs "${h.key}".`)
    } catch (e: any) {
      return reply(400, { error: `The body must be a JSON object, or a list of them. ${String(e?.message ?? e).slice(0, 200)}` })
    }
    let wf: ReturnType<Auto["workflow"]>
    try {
      wf = auto().workflow(d.workflow)
    } catch (e: any) {
      return reply(409, { error: String(e?.message ?? e) })
    }
    let added = 0
    for (const row of rows) {
      const key = h.key ? row[h.key]!.trim().toLowerCase() : sha(stable(row))
      // The same row is taken in once: whoever claims its key first adds it.
      const mine = await q(`insert into ${S}.arrived (hook, key) values ($1, $2) on conflict do nothing returning key`, [d.name, key])
      if (!mine.length) continue
      try {
        const rowId = await db().addRow(wf.from, row, `rows posted to /hooks/${d.name}`)
        await q(`update ${S}.arrived set row_id = $3 where hook = $1 and key = $2`, [d.name, key, rowId])
        added++
      } catch (e) {
        await q(`delete from ${S}.arrived where hook = $1 and key = $2`, [d.name, key])
        throw e
      }
    }
    const duplicates = rows.length - added
    if (!added) {
      const f = await noted({
        name: d.name,
        outcome: "duplicate",
        note: `${rows.length === 1 ? "A row" : `${rows.length} rows`} arrived that ${rows.length === 1 ? "is" : "are"} already in ${wf.from}: nothing added, nothing bought.`,
      })
      return reply(200, { received: rows.length, added: 0, duplicates, started: null, note: f.note })
    }
    const f = await launch(d.name, added)
    return reply(200, { received: rows.length, added, duplicates, started: f.run ?? null, note: f.note })
  }

  /** One schedule or webhook as people and agents see it: when it runs, and what it last did. */
  async function shown(d: Declared) {
    const recent = (await q(`select at, outcome, note, run from ${S}.fired where name = $1 order by id desc limit 5`, [d.name])).map((x) => ({
      at: new Date(x.at).toISOString(),
      outcome: x.outcome as string,
      note: x.note as string,
      ...(x.run ? { run: x.run as number } : {}),
    }))
    const keys = d.kind === "webhook" && fb.has("keys") ? (await fb.use<Keys>("keys").cards()).find((c) => c.name === d.name) : undefined
    const last = (await auto().last(by(d))) as any
    return {
      name: d.name,
      kind: d.kind,
      title: title(d.name),
      workflow: d.workflow,
      when: d.when,
      /** When it starts, as people read it on the pages. */
      starts: d.schedule ? starts(d.schedule.every, d.schedule.timezone) : `Webhook ${d.name}`,
      ...(d.kind === "webhook"
        ? { webhook: { address: `${fb.url}/hooks/${d.name}`, signatureHeader: d.hook!.signature?.header ?? HEADER, secretSaved: !!keys?.hasKey, ...(d.hook!.key ? { sameRowBy: d.hook!.key } : {}) } }
        : {}),
      ...(d.kind === "schedule" ? { nextDue: nextAfter(d.schedule!.every, new Date(), d.schedule!.timezone).toISOString() } : {}),
      ...(last ? { lastRun: { run: last.run, state: last.state, rows: last.rows, spent: last.spent.text, ...(last.why ? { why: last.why } : {}) } } : {}),
      recent,
    }
  }

  /** The clock ticked: start every schedule whose time has come, each at most once for that time. */
  async function tick(): Promise<Fired[]> {
    const now = Date.now()
    const out: Fired[] = []
    for (const d of declared()) {
      if (!d.schedule) continue
      // The newest time that has come due. One more than an hour old was missed while Flowbound was down: skip it.
      let slot = nextAfter(d.schedule.every, new Date(now - 3600_000 - 1000), d.schedule.timezone)
      if (slot.getTime() > now) continue
      for (let next = nextAfter(d.schedule.every, slot, d.schedule.timezone); next.getTime() <= now; next = nextAfter(d.schedule.every, slot, d.schedule.timezone)) slot = next
      const fresh = await q(`insert into ${S}.slots (name, at) values ($1, $2) on conflict (name) do update set at = $2 where ${S}.slots.at < $2 returning name`, [d.name, slot.toISOString()])
      if (fresh.length) out.push(await launch(d.name).catch((e): Fired => ({ name: d.name, outcome: "failed", note: `It did not start: ${e?.message ?? e}` })))
    }
    return out
  }

  return plugin({
    name: "schedules",
    provides: "schedules",
    needs: ["records", "ledger", "runs"],
    own: { [`${S}.fired`]: "each start by a schedule or webhook" },
    migrations: [
      `create table ${S}.fired (id bigserial primary key, name text not null, at timestamptz not null default now(), outcome text not null, note text not null, run bigint);
       create index fired_name on ${S}.fired (name, id);
       create table ${S}.slots (name text primary key, at timestamptz not null);
       create table ${S}.arrived (hook text not null, key text not null, row_id bigint, at timestamptz not null default now(), primary key (hook, key))`,
    ],
    start(f) {
      fb = f
      const flows = fb.use<{ workflows: () => Record<string, { id: string }> }>("runs").workflows()
      for (const d of declared()) if (!flows[d.workflow]) console.log(`The ${d.kind} "${d.name}" names the workflow "${d.workflow}", and there is no workflows/${d.workflow}.ts.`)
      return {
        /** When the next schedule comes due, for the clock. */
        nextDue: (): string | null => {
          const times = declared()
            .filter((d) => d.schedule)
            .map((d) => nextAfter(d.schedule!.every, new Date(), d.schedule!.timezone).getTime())
          return times.length ? new Date(Math.min(...times)).toISOString() : null
        },
        tick,
        launch,
        lines: declared,
      }
    },
    routes: {
      // The signature is this address's door: no token, no login. Unsigned, it takes nothing in.
      "POST /hooks/:id": Object.assign((req: Request, at: { params: Record<string, string> }) => receive(req, at.params.id!), { open: "all" as const }),
      // For a host with its own clock (Vercel's schedules) or any cron: it only ticks for whoever holds the host's CRON_SECRET.
      "ANY /clock": Object.assign(
        async (req: Request) => {
          const secret = process.env.CRON_SECRET ?? ""
          const given = Buffer.from(req.headers.get("authorization") ?? "")
          const want = Buffer.from(`Bearer ${secret}`)
          if (secret.length < 16 || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return reply(401, { error: "The clock only ticks for the host's own scheduler (CRON_SECRET)." })
          return reply(200, { fired: await tick() })
        },
        { open: "all" as const },
      ),
    },
    tools: {
      schedules: {
        about:
          "The schedules and webhooks in flowbound.config.ts: when each runs, its webhook address and signing secret, its last run and what each firing did. Runs they start are under the same permissions as any run.",
        role: "viewer",
        input: { name: { about: "one schedule or webhook, by name" } },
        run: async (i) => (i.name ? shown(one(i.name)) : Promise.all(declared().map(shown))),
        print: (r: any) => {
          const one = (s: Awaited<ReturnType<typeof shown>>) =>
            [
              `${s.title} (${s.kind}): "${s.workflow}", ${s.when}`,
              s.webhook ? `  address ${s.webhook.address}, signing secret ${s.webhook.secretSaved ? "saved" : "not saved yet (typed on the Connections page)"}` : "",
              s.recent[0] ? `  last: ${s.recent[0].note}` : "  has not fired yet",
            ]
              .filter(Boolean)
              .join("\n")
          return Array.isArray(r) ? (r.length ? r.map(one).join("\n") : "No schedules or webhooks. Add one to schedules in flowbound.config.ts.") : one(r)
        },
      },
      "schedule-run": {
        about: "Run a schedule or webhook now, as its clock or a delivery would: under the permissions, and it says what it did.",
        input: { name: { about: "the schedule's or webhook's name", required: true } },
        run: async (i) => launch(one(i.name).name),
        print: (f: Fired) => f.note,
      },
    },
    /** For Home: a webhook with no signing secret. */
    async attention() {
      const out: Attention[] = []
      const cards = fb.has("keys") ? await fb.use<Keys>("keys").cards() : []
      for (const d of declared())
        if (d.kind === "webhook" && !cards.find((c) => c.name === d.name)?.hasKey)
          out.push({
            name: title(d.workflow.split("/").pop()!),
            why: `The webhook ${d.name} has no signing secret`,
            what: `The webhook "${d.name}" has no signing secret, so every delivery is refused.`,
            fix: "Type the secret the sender signs with on the Connections page, never in a chat.",
            page: "/keys",
          })
      return out
    },
    docs: asset("schedules/schedules.md"),
    /** What a host with its own clock needs: one schedule per line, calling /clock. */
    hostSchedules: (list: { name: string; schedule?: unknown }[]) =>
      Object.fromEntries(
        list
          .filter((p) => p.schedule)
          .map((p) => {
            const s = p.schedule as ScheduleLine
            return [`flowbound-${p.name}`, { schedule: toCron(s.every), ...(s.timezone ? { timezone: s.timezone } : {}), path: "/clock" }]
          }),
      ),
  })
}
