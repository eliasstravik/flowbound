// The ledger: every paid fact kept (source, date, cost, age), and your permissions enforced: the mode and the caps.
// Caps are held here, in the store, by one atomic UPDATE each, so rows side by side can never pass one.
import { type Attention, type Flowbound, plugin, type Who } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import { age, clean, daysSince, inputsOf } from "./ledger/clean.ts"
import { asset, day, sha, sleep, stable, title, usd } from "./util.ts"

export type Answer = { status: number; headers: Record<string, string>; data: unknown }
/** A call that failed in a way worth trying again: the provider was busy or unreachable. */
export class Again extends Error {
  waitMs?: number
  constructor(message: string, waitMs?: number) {
    super(message)
    this.waitMs = waitMs
  }
}

/** How much the agent may do without asking, like your agent app's own permission modes. */
export type Mode = "ask" | "auto" | "skip"
/** Caps in dollars (`perRun`, `perMonth`), in calls for a card with no price, and in writes to other tools (counted by number). */
export type Caps = { perRun?: number; perMonth?: number; callsPerRun?: number; callsPerMonth?: number; writesPerRun?: number; writesPerMonth?: number }
/** A mode, caps, or both. Caps may sit in `caps: { ... }` or beside `mode`. */
export type Rule = Caps & { mode?: Mode; caps?: Caps }
/** `flowbound.config.ts`'s `permissions`: one mode and caps for everything, and a rule of its own for a workflow or a provider. The strictest wins. */
export type Permissions = Rule & { workflows?: Record<string, Rule>; providers?: Record<string, Rule> }
/** What a new install starts with: auto, inside $5 a run and $100 a month, and 500 writes to other tools a month. */
export const DEFAULT_PERMISSIONS: Permissions = { mode: "auto", caps: { perRun: 5, perMonth: 100, writesPerMonth: 500 } }
const MODES: Mode[] = ["skip", "auto", "ask"]
const CAP_KEYS: (keyof Caps)[] = ["perRun", "perMonth", "callsPerRun", "callsPerMonth", "writesPerRun", "writesPerMonth"]

/** What the calls made under a key (a workflow run's id) belong to. Set by the runner before each row. */
export type Scope = {
  run?: number
  row?: number
  workflow?: string
  title?: string
  into?: string
  /** The run's mode, worked out when it began: the strictest of every rule that holds for it. */
  mode?: Mode
  /** Caps a yes lifted for this run (a month's cap the person said to go past). */
  lifted?: string[]
  /** Extra tries for a busy or unreachable provider: the workflow's own habit (2 unless it says). */
  retries?: number
}
export type Paid = { answer: Answer; fact: number; cost: number; fromMemory: boolean }
export type Budget = { id: string; maxUsd: number | null; maxCalls: number | null; usd: number; calls: number; heldUsd: number }
/** A card's speed limit: calls to one provider are spaced out, across rows, runs and copies of Flowbound. */
export type Rate = { perSecond?: number; perMinute?: number }
/** Where a cell's answer came from, for the Tables page and agents: "BlitzAPI · bought 12 days ago for $0.004 · free now". */
export type Source = { fact: number; from: string; at: string; cost: number; ageDays: number; fresh: boolean; known: boolean; text: string }

export type Ledger = {
  /** Open a cap, or set it to exactly this. */
  budget: (id: string, cap: { maxUsd?: number | null; maxCalls?: number | null }) => Promise<void>
  spent: (id: string) => Promise<Budget | undefined>
  /** Say what the calls made under a key (a workflow run's id) belong to. */
  scope: (key: string, scope: Scope) => Promise<void>
  /** Answer from memory when the same cleaned request was bought inside its freshness window; otherwise hold, call, and keep. */
  call: (
    o: {
      provider: string
      request: { method: string; path: string; query: unknown; body: unknown }
      /** What the call is expected to cost at most: held against every cap before the call is made. */
      price?: number
      reported?: (a: Answer) => number | undefined
      freshDays?: number
      scopeKey?: string
      rate?: Rate
      /** A write to another tool: counted by number against the write caps, and never answered from memory. */
      write?: boolean
      /** How the answer is got, when a provider has more than one way: kept with the fact. */
      how?: string
    },
    go: () => Promise<Answer>,
  ) => Promise<Paid>
  /** The mode that holds for a workflow that calls these providers: the strictest of every rule. */
  modeFor: (workflow?: string, providers?: string[]) => Mode
  /** The cap in dollars and calls one run of a workflow gets, before any budget said in chat. */
  runCaps: (workflow?: string) => { maxUsd: number | null; maxCalls: number | null }
  /** Today's allowance for one-off calls an agent makes to look at a provider's answers: $1 and 100 unpriced calls. */
  today: () => Promise<string>
  /** A person's yes, saved with who, where and the file it was for. */
  yes: (o: { workflow: string; hash: string; run?: number; maxUsd?: number | null; who: Who }) => Promise<number>
  yesOf: (id: number) => Promise<{ id: number; who: string; checked: boolean; place: string; at: string; max_usd: number | null } | undefined>
  /** What a run's calls came to, and `worth`: what every answer cost when it was bought, also the ones answered from memory this time. */
  filled: (o: Scope) => Promise<{ calls: number; usd: number; unpriced: number; worth: number; writes: number }>
  /** The same, told apart by who was paid: one line per provider. */
  paidTo: (o: Scope) => Promise<{ from: string; how: string | null; calls: number; fromMemory: number; usd: number }[]>
  /** Where each answered cell of a results table came from, with its age and cost. Keyed "row:fact". */
  sources: (into: string, cells: { row: number; fact: number }[]) => Promise<Record<string, Source>>
  /** Every kept answer, from any provider, whose cleaned inputs hold this value: one lookup across providers. */
  lookup: (value: string) => Promise<{ fact: number; from: string; endpoint: string | null; at: string; age: string; fresh: boolean; cost: number; found: boolean; answer: unknown }[]>
  /** In words: "the $5.00 cap for one run". */
  capName: (budget: string, b?: Budget) => string
  permissions: () => Permissions
  freshDays: () => number
}

const tries = () => (process.env.FLOWBOUND_RETRY_MS ?? "1000,4000").split(",").map(Number)
/** How long a call waits for money that is only set aside for calls still in the air, before the cap is called. */
const holdWait = () => Number(process.env.FLOWBOUND_HOLD_WAIT_MS ?? 60_000)
/** Milliseconds between two calls that keep a card under its speed limit. */
export const gapOf = (rate?: Rate) => Math.ceil(Math.max(rate?.perSecond ? 1000 / rate.perSecond : 0, rate?.perMinute ? 60_000 / rate.perMinute : 0))
const month = (now = new Date()) => now.toISOString().slice(0, 7)
const min = (...v: (number | null | undefined)[]) => {
  const n = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x))
  return n.length ? Math.min(...n) : null
}

/** A rule's caps, whether written inside `caps` or beside `mode`. */
export const capsOf = (r?: Rule): Caps => {
  const out: Caps = {}
  for (const k of CAP_KEYS) {
    const v = r?.caps?.[k] ?? r?.[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/** The permissions as they would be written in flowbound.config.ts: { mode: "auto", caps: { perRun: 5 } }. */
export const literal = (v: unknown, pad = ""): string => {
  if (!v || typeof v !== "object") return JSON.stringify(v)
  const inner = Object.entries(v).map(([k, x]) => `${pad}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${literal(x, `${pad}  `)}`)
  const flat = `{ ${inner.map((l) => l.trim()).join(", ")} }`
  return flat.length + pad.length <= 60 ? flat : `{\n${inner.join(",\n")},\n${pad}}`
}

/** Read `permissions` as written, or say plainly what is wrong with it. */
export function checkPermissions(p: unknown): Permissions {
  const where = "permissions in flowbound.config.ts"
  const rule = (r: any, at: string) => {
    if (!r || typeof r !== "object") throw new Error(`${where}: ${at} must be an object like { mode: "ask" } or { perRun: 2 }.`)
    if (r.mode !== undefined && !MODES.includes(r.mode)) throw new Error(`${where}: ${at}.mode must be "ask", "auto" or "skip". Got "${r.mode}".`)
    for (const [k, v] of Object.entries(capsOf(r))) if (typeof v !== "number" || !(v >= 0)) throw new Error(`${where}: ${at}.${k} must be a number of 0 or more.`)
    for (const k of Object.keys(r))
      if (!["mode", "caps", "workflows", "providers", ...CAP_KEYS].includes(k)) throw new Error(`${where}: ${at} has "${k}", which is not a setting. Settings: mode, caps, ${CAP_KEYS.join(", ")}.`)
  }
  if (p === undefined) return DEFAULT_PERMISSIONS
  rule(p, "permissions")
  const q = p as Permissions
  for (const [k, r] of Object.entries(q.workflows ?? {})) rule(r, `workflows["${k}"]`)
  for (const [k, r] of Object.entries(q.providers ?? {})) rule(r, `providers["${k}"]`)
  return q
}

/** `freshDays`: how long a kept fact is answered from memory before it is bought again (30 unless set; a call may say otherwise). `oneOffUsdPerDay`, `oneOffCallsPerDay`: what an agent's one-off calls to a provider may spend in a day. */
export const ledger = (opts: { permissions?: Permissions; freshDays?: number; oneOffUsdPerDay?: number; oneOffCallsPerDay?: number } = {}) => {
  const perms = checkPermissions(opts.permissions)
  const FRESH = opts.freshDays ?? 30
  const DAY_USD = opts.oneOffUsdPerDay ?? 1
  const DAY_CALLS = opts.oneOffCallsPerDay ?? 100
  let fb: Flowbound
  const db = () => fb.use("records")
  const flying = new Map<string, Promise<Paid>>()
  const opened = new Map<string, string>()
  const q = async (sql: string, params?: unknown[]) => (await db().query(sql, params)).rows
  /** How people read a provider's name: the label on its card. */
  const label = (provider: string) => (fb.plugins.find((p) => p.name === provider)?.card as { label?: string } | undefined)?.label ?? provider

  const modeFor = (workflow?: string, providers: string[] = []): Mode => {
    const said = [perms.mode ?? "auto", workflow ? perms.workflows?.[workflow]?.mode : undefined, ...providers.map((p) => perms.providers?.[p]?.mode)].filter((m): m is Mode => !!m)
    return said.reduce((a, b) => (MODES.indexOf(b) > MODES.indexOf(a) ? b : a), "skip" as Mode)
  }
  const runCaps = (workflow?: string) => {
    const g = capsOf(perms)
    const w = capsOf(workflow ? perms.workflows?.[workflow] : undefined)
    return { maxUsd: min(g.perRun, w.perRun), maxCalls: min(g.callsPerRun, w.callsPerRun) }
  }

  /** The caps one call is held against, by the rules as written now. The run's own (`run:<id>`) is set when it begins. */
  const budgetsFor = (scope: Scope, provider: string, write: boolean): { id: string; maxUsd: number | null; maxCalls: number | null }[] => {
    const m = month()
    const out: { id: string; maxUsd: number | null; maxCalls: number | null }[] = []
    const add = (id: string, maxUsd?: number | null, maxCalls?: number | null) => {
      if ((maxUsd ?? null) !== null || (maxCalls ?? null) !== null) out.push({ id, maxUsd: maxUsd ?? null, maxCalls: maxCalls ?? null })
    }
    const g = capsOf(perms)
    const p = capsOf(perms.providers?.[provider])
    const w = capsOf(scope.workflow ? perms.workflows?.[scope.workflow] : undefined)
    const mode = scope.mode ?? modeFor(scope.workflow, [provider])
    if (scope.run === undefined) add(`oneoff:${new Date().toISOString().slice(0, 10)}`, DAY_USD, DAY_CALLS)
    if (mode !== "skip") {
      add(`month:${m}`, g.perMonth, g.callsPerMonth)
      if (scope.workflow) add(`month:${m}:workflow:${scope.workflow}`, w.perMonth, w.callsPerMonth)
      add(`month:${m}:provider:${provider}`, p.perMonth, p.callsPerMonth)
      if (scope.run !== undefined) add(`run:${scope.run}:provider:${provider}`, p.perRun, p.callsPerRun)
      if (write) {
        add(`month:${m}:writes`, null, min(g.writesPerMonth, w.writesPerMonth))
        add(`month:${m}:provider:${provider}:writes`, null, p.writesPerMonth)
        if (scope.run !== undefined) {
          add(`run:${scope.run}:writes`, null, min(g.writesPerRun, w.writesPerRun))
          add(`run:${scope.run}:provider:${provider}:writes`, null, p.writesPerRun)
        }
      }
    }
    const lifted = new Set(scope.lifted ?? [])
    return out.filter((b) => !lifted.has(b.id))
  }

  const capName = (id: string, b?: Budget) => {
    const amount = b ? (b.maxUsd !== null ? usd(b.maxUsd) : `${b.maxCalls}-${/writes$/.test(id) ? "write" : "call"}`) : ""
    const prov = /:provider:([^:]+)/.exec(id)?.[1]
    const of = prov ? ` for ${label(prov)}` : /:workflow:([^:]+)/.test(id) ? ` for ${/:workflow:([^:]+)/.exec(id)![1]}` : ""
    if (id.startsWith("oneoff:")) return `today's ${amount} allowance for one-off calls`
    if (id.startsWith("month:")) return `this month's ${amount} cap${of}`
    if (/^run:\d+:/.test(id)) return `the ${amount} cap per run${of}`
    return `the ${amount} cap for this run`
  }

  const hold = async (budget: string, price: number, priced: boolean): Promise<number | undefined> => {
    const take = () =>
      q(
        `with ok as (update fb_ledger.budgets set held_usd = held_usd + $2, held_calls = held_calls + 1 where id = $1
           and (max_usd is null or spent_usd + held_usd + $2 <= max_usd + 1e-9) and (max_calls is null or calls + held_calls + 1 <= max_calls)
           and ($3 or max_calls is not null) returning id)
         insert into fb_ledger.holds (budget, usd) select id, $2 from ok returning id`,
        [budget, price, priced],
      )
    let got = await take()
    if (!got.length) {
      // A crash between hold and settle leaves a hold behind. Clear old ones, then look once more.
      await q(
        `with dead as (delete from fb_ledger.holds where budget = $1 and at < now() - interval '15 minutes' returning usd)
         update fb_ledger.budgets set held_usd = greatest(0, held_usd - (select coalesce(sum(usd), 0) from dead)), held_calls = greatest(0, held_calls - (select count(*) from dead)::int) where id = $1`,
        [budget],
      )
      got = await take()
    }
    // Money set aside for calls still in the air comes back when they cost less than was held (a model call is held
    // at its worst case). So when this call does not fit only because of those, wait for them rather than call the cap.
    for (const until = Date.now() + holdWait(); !got.length && Date.now() < until; ) {
      const b = (await q("select * from fb_ledger.budgets where id = $1", [budget]))[0]
      const inTheAir = b && (b.held_usd > 1e-9 || b.held_calls > 0)
      const fitsWithoutThem = b && (b.max_usd === null || b.spent_usd + price <= b.max_usd + 1e-9) && (b.max_calls === null || b.calls + 1 <= b.max_calls) && (priced || b.max_calls !== null)
      if (!inTheAir || !fitsWithoutThem) break
      await sleep(250)
      got = await take()
    }
    return got[0]?.id
  }
  const settle = (budget: string, holdId: number, held: number, cost: number | null) =>
    q(
      `with gone as (delete from fb_ledger.holds where id = $2 returning id)
       update fb_ledger.budgets set held_usd = greatest(0, held_usd - $3), held_calls = greatest(0, held_calls - 1),
         spent_usd = spent_usd + $4, calls = calls + $5 where id = $1 and exists (select 1 from gone)`,
      [budget, holdId, held, cost ?? 0, cost === null ? 0 : 1],
    )
  const refuse = async (budget: string, priced: boolean, price: number): Promise<never> => {
    const b = (await api.spent(budget))!
    if (!priced && b.maxCalls === null)
      throw new Refused(
        `This provider has no price on its card, so ${capName(budget, b).replace(/ cap.*/, " cap")} cannot hold it: add a cap in calls (callsPerRun, callsPerMonth) to permissions, or a price to the card.`,
        {
          code: "cap",
          budget,
        },
      )
    // A cap below what one call could cost at the worst buys nothing: say so, or "$0.00 of the cap" reads like a fault.
    const tooSmall = b.maxUsd !== null && price > b.maxUsd + 1e-9 ? ` (one call could cost up to ${usd(price)})` : ""
    const name = capName(budget, b)
    throw new Refused(budget.startsWith("oneoff:") ? `One-off calls have used ${name}. A workflow run has caps of its own.` : `Reached ${name}${tooSmall}.`, { code: "cap", budget })
  }
  /** The card's speed limit: each call takes the next free moment, kept in the database so every copy of Flowbound shares it. */
  const pace = async (provider: string, rate?: Rate) => {
    const gap = gapOf(rate)
    if (!gap) return
    const r = (
      await q(
        `insert into fb_ledger.rate (provider, next_at) values ($1, now() + $2 * interval '1 millisecond')
         on conflict (provider) do update set next_at = greatest(fb_ledger.rate.next_at, now()) + $2 * interval '1 millisecond'
         returning (extract(epoch from next_at) * 1000 - $2 - extract(epoch from now()) * 1000)::float8 as wait`,
        [provider, gap],
      )
    )[0]
    if (r.wait > 0) await sleep(r.wait)
  }
  /** A month's or a rule's cap follows the rules as written now: opened when first needed, changed when they change. */
  const open = async (b: { id: string; maxUsd: number | null; maxCalls: number | null }) => {
    const mark = `${b.maxUsd}|${b.maxCalls}`
    if (opened.get(b.id) === mark) return
    await api.budget(b.id, b)
    opened.set(b.id, mark)
  }

  const api: Ledger = {
    async budget(id, cap) {
      await q(
        `insert into fb_ledger.budgets (id, max_usd, max_calls) values ($1, $2, $3)
         on conflict (id) do update set max_usd = $2, max_calls = $3`,
        [id, cap.maxUsd ?? null, cap.maxCalls ?? null],
      )
    },
    async spent(id) {
      const b = (await q("select * from fb_ledger.budgets where id = $1", [id]))[0]
      return b && { id, maxUsd: b.max_usd, maxCalls: b.max_calls, usd: b.spent_usd, calls: b.calls, heldUsd: b.held_usd }
    },
    async scope(key, scope) {
      await q("insert into fb_ledger.scopes (key, budgets, scope) values ($1, '{}', $2) on conflict (key) do update set scope = $2", [key, JSON.stringify(scope)])
    },
    modeFor,
    runCaps,
    capName,
    permissions: () => perms,
    freshDays: () => FRESH,
    async today() {
      const id = `oneoff:${new Date().toISOString().slice(0, 10)}`
      await open({ id, maxUsd: DAY_USD, maxCalls: DAY_CALLS })
      return id
    },
    async call(o, go) {
      const request = { method: o.request.method, path: o.request.path, query: clean(o.request.query), body: clean(o.request.body) }
      const key = sha(`${o.provider}\n${stable(request)}`)
      const s = o.scopeKey ? (await q("select scope from fb_ledger.scopes where key = $1", [o.scopeKey]))[0] : undefined
      const scope: Scope = s?.scope ?? {}
      const write = !!o.write
      const priced = o.price !== undefined || !!o.reported
      const budgets = [...(scope.run !== undefined ? [`run:${scope.run}`] : []), ...budgetsFor(scope, o.provider, write).map((b) => b.id)]
      for (const b of budgetsFor(scope, o.provider, write)) await open(b)
      const log = (fact: number, cost: number, fromMemory: boolean) =>
        q("insert into fb_ledger.calls (fact, provider, cost_usd, from_memory, priced, budgets, scope, write) values ($1, $2, $3, $4, $5, $6, $7, $8)", [
          fact,
          o.provider,
          cost,
          fromMemory,
          priced,
          budgets,
          JSON.stringify({ ...scope, lifted: undefined, mode: undefined, retries: undefined }),
          write,
        ])
      // A write is an act, not a question: it is done every time, never answered from memory.
      const remembered = async (): Promise<Paid | undefined> => {
        if (write) return undefined
        const f = (await q(`select * from fb_ledger.facts where key = $1 and not write and at > now() - make_interval(days => $2) order by at desc limit 1`, [key, o.freshDays ?? FRESH]))[0]
        if (!f) return undefined
        await log(f.id, 0, true)
        return { answer: { status: f.status, headers: {}, data: f.answer }, fact: f.id, cost: 0, fromMemory: true }
      }
      const before = (await remembered()) ?? (!write && flying.has(key) ? await flying.get(key)!.then(remembered, () => undefined) : undefined)
      if (before) return before

      const pay = async (): Promise<Paid> => {
        // The price check: a provider that reported a higher price for this endpoint before is held at that price from then on.
        const seen = (await q("select usd from fb_ledger.prices where provider = $1 and endpoint = $2", [o.provider, o.request.path]))[0]?.usd
        const price = Math.max(o.price ?? 0, seen ?? 0)
        const held: [string, number][] = []
        const release = () => Promise.all(held.map(([b, h]) => settle(b, h, price, null)))
        for (const b of budgets) {
          // The run's own cap is opened when the run begins; with none (skip, and no budget said in chat) it holds nothing.
          if (b.startsWith("run:") && !b.includes(":provider:") && !b.endsWith(":writes")) {
            const own = await api.spent(b)
            if (!own || (own.maxUsd === null && own.maxCalls === null)) continue
          }
          const h = await hold(b, price, priced)
          if (h === undefined) {
            await release()
            await refuse(b, priced, price)
          }
          held.push([b, h!])
        }
        let answer: Answer | undefined
        let last: unknown
        const waits = tries().slice(0, Math.max(0, scope.retries ?? 2))
        for (let n = 0; n <= waits.length && !answer; n++) {
          try {
            await pace(o.provider, o.rate)
            answer = await go()
          } catch (e) {
            last = e
            if (!(e instanceof Again) || n === waits.length) break
            await sleep(Math.max(e.waitMs ?? 0, waits[n] ?? 1000))
          }
        }
        if (!answer) {
          await release()
          if (last instanceof Again) throw new Refused(`${last.message} Tried ${waits.length + 1} ${waits.length ? "times" : "time"}. Nothing was spent on it.`, { code: "failed" })
          throw last
        }
        const said = o.reported?.(answer)
        const cost = said ?? o.price ?? 0
        if (said !== undefined)
          await q(
            `insert into fb_ledger.prices (provider, endpoint, usd, expected) values ($1, $2, $3, $4)
             on conflict (provider, endpoint) do update set usd = excluded.usd, expected = excluded.expected, at = now() where excluded.usd > fb_ledger.prices.usd`,
            [o.provider, o.request.path, said, o.price ?? null],
          )
        const fact = (
          await q("insert into fb_ledger.facts (key, provider, request, status, answer, cost_usd, by, how, endpoint, inputs, write) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id", [
            key,
            o.provider,
            JSON.stringify(request),
            answer.status,
            JSON.stringify(answer.data ?? null),
            cost,
            scope.title ?? null,
            o.how ?? null,
            `${o.request.method} ${o.request.path}`,
            write ? [] : inputsOf([request.query, request.body]),
            write,
          ])
        )[0].id
        await Promise.all(held.map(([b, h]) => settle(b, h, price, cost)))
        await log(fact, cost, false)
        return { answer, fact, cost, fromMemory: false }
      }
      const p = pay()
      if (write) return p
      flying.set(key, p)
      return p.finally(() => flying.delete(key))
    },
    async yes(o) {
      const place = o.who.via === "page" ? "page" : o.who.via === "cli" || o.who.via === "mcp" ? "chat" : o.who.via
      const r = await q("insert into fb_ledger.yeses (workflow, file_hash, max_usd, who, checked, place, run) values ($1, $2, $3, $4, $5, $6, $7) returning id", [
        o.workflow,
        o.hash,
        o.maxUsd ?? null,
        o.who.name,
        o.who.checked !== false,
        place,
        o.run ?? null,
      ])
      if (fb.has("door")) await fb.use("door").wrote(o.who, "said yes", o.workflow, undefined, { maxUsd: o.maxUsd ?? null, run: o.run ?? null, yes: r[0].id })
      return r[0].id
    },
    yesOf: async (id) => (await q("select * from fb_ledger.yeses where id = $1", [id]))[0],
    async filled(scope) {
      return (
        await q(
          `select count(*) filter (where not c.from_memory)::int as calls, coalesce(sum(c.cost_usd) filter (where not c.from_memory), 0)::float8 as usd,
             count(*) filter (where not c.priced)::int as unpriced, coalesce(sum(f.cost_usd), 0)::float8 as worth, count(*) filter (where c.write)::int as writes
           from fb_ledger.calls c left join fb_ledger.facts f on f.id = c.fact where c.scope @> $1::jsonb`,
          [JSON.stringify(scope)],
        )
      )[0]
    },
    async paidTo(scope) {
      const rows = await q(
        `select c.provider, f.how, count(*) filter (where not c.from_memory)::int as calls, count(*) filter (where c.from_memory)::int as "fromMemory",
           coalesce(sum(c.cost_usd) filter (where not c.from_memory), 0)::float8 as usd
         from fb_ledger.calls c left join fb_ledger.facts f on f.id = c.fact where c.scope @> $1::jsonb group by c.provider, f.how order by c.provider, f.how`,
        [JSON.stringify(scope)],
      )
      return rows.map((r: any) => ({ from: label(r.provider), how: r.how ?? null, calls: r.calls, fromMemory: r.fromMemory, usd: r.usd }))
    },
    async sources(into, cells) {
      if (!cells.length) return {}
      const ids = [...new Set(cells.map((c) => c.fact))]
      const facts = await q(
        `select f.id, f.provider, f.at, f.cost_usd, f.status, f.write, (select max(p.at) from fb_ledger.facts p where p.key = f.key and p.id < f.id) as prev_at
         from fb_ledger.facts f where f.id = any($1::bigint[])`,
        [ids],
      )
      // Whether the row got it from memory: the newest call for that row and fact says.
      const known = await q(
        `select distinct on (row, fact) (scope->>'row')::bigint as row, fact, from_memory from fb_ledger.calls
         where scope @> $1::jsonb and fact = any($2::bigint[]) order by row, fact, id desc`,
        [JSON.stringify({ into }), ids],
      )
      const mem = new Map<string, boolean>(known.map((k: any) => [`${k.row}:${k.fact}`, !!k.from_memory]))
      const byId = new Map<number, any>(facts.map((f: any) => [Number(f.id), f]))
      const out: Record<string, Source> = {}
      for (const c of cells) {
        const f = byId.get(Number(c.fact))
        if (!f) continue
        const days = daysSince(f.at)
        const fresh = days < FRESH
        const isKnown = mem.get(`${c.row}:${c.fact}`) ?? false
        const from = label(f.provider)
        const cost = usd(f.cost_usd)
        // A write is an act, not a kept answer: it says when it was written, never "free now".
        const text = f.write
          ? `${from} · written ${days ? `${age(f.at)} ago` : "today"}`
          : isKnown
            ? `already known${days ? ` · ${age(f.at)} old` : ""} · free`
            : f.prev_at
              ? `${from} · bought again ${days ? `${age(f.at)} ago` : "today"} for ${cost} · the last answer was ${age(f.prev_at, new Date(f.at).getTime())} old`
              : days
                ? `${from} · bought ${age(f.at)} ago for ${cost} · ${fresh ? "free now" : `older than ${FRESH} days: bought again next time`}`
                : `${from} · today · ${cost}`
        out[`${c.row}:${c.fact}`] = { fact: Number(c.fact), from, at: new Date(f.at).toISOString(), cost: f.cost_usd, ageDays: days, fresh, known: isKnown, text }
      }
      return out
    },
    async lookup(value) {
      const v = inputsOf(value)[0] ?? String(value).trim()
      const rows = await q(`select id, provider, endpoint, at, cost_usd, status, answer from fb_ledger.facts where inputs @> array[$1]::text[] and not write order by at desc limit 50`, [v])
      return rows.map((f: any) => ({
        fact: Number(f.id),
        from: label(f.provider),
        endpoint: f.endpoint,
        at: new Date(f.at).toISOString(),
        age: daysSince(f.at) ? `${age(f.at)} old` : "today",
        fresh: daysSince(f.at) < FRESH,
        cost: f.cost_usd,
        found: f.status !== 404,
        answer: f.answer,
      }))
    },
  }

  /** The permissions as they hold now, with what each month's cap has used: for the Permissions page and agents. */
  async function shown() {
    const m = month()
    const g = capsOf(perms)
    const used = async (id: string) => (await api.spent(id)) ?? { usd: 0, calls: 0 }
    const rules = async (kind: "workflows" | "providers") =>
      Promise.all(
        Object.entries(perms[kind] ?? {}).map(async ([name, r]) => ({
          name,
          title: kind === "providers" ? label(name) : title(name),
          mode: r.mode ?? null,
          caps: capsOf(r),
          thisMonth: kind === "providers" ? await used(`month:${m}:provider:${name}`) : await used(`month:${m}:workflow:${name}`),
        })),
      )
    const all = await used(`month:${m}`)
    const writes = await used(`month:${m}:writes`)
    const spentMonth = (await q("select coalesce(sum(cost_usd), 0)::float8 as usd, count(*) filter (where write)::int as writes from fb_ledger.calls where not from_memory and at >= date_trunc('month', now())"))[0]
    return {
      mode: perms.mode ?? "auto",
      caps: g,
      thisMonth: { usd: Math.max(all.usd, spentMonth.usd), writes: Math.max(writes.calls, spentMonth.writes) },
      workflows: await rules("workflows"),
      providers: await rules("providers"),
      freshDays: FRESH,
      oneOffPerDay: { usd: DAY_USD, calls: DAY_CALLS },
      written: `permissions: ${literal(opts.permissions ?? DEFAULT_PERMISSIONS)}`,
    }
  }

  return plugin({
    name: "ledger",
    provides: "ledger",
    needs: ["records"],
    migrations: [
      `create table fb_ledger.facts (id bigserial primary key, key text not null, provider text not null, request jsonb not null, status int not null,
         answer jsonb, cost_usd double precision not null default 0, by text, at timestamptz not null default now());
       create index facts_key on fb_ledger.facts (key, at desc);
       create table fb_ledger.budgets (id text primary key, max_usd double precision, max_calls int, spent_usd double precision not null default 0,
         held_usd double precision not null default 0, calls int not null default 0, held_calls int not null default 0);
       create table fb_ledger.holds (id bigserial primary key, budget text not null, usd double precision not null, at timestamptz not null default now());
       create table fb_ledger.calls (id bigserial primary key, fact bigint, provider text not null, cost_usd double precision not null default 0,
         from_memory boolean not null default false, priced boolean not null default true, budgets text[] not null default '{}', scope jsonb not null default '{}', at timestamptz not null default now());
       create index calls_scope on fb_ledger.calls using gin (scope);
       create table fb_ledger.scopes (key text primary key, budgets text[] not null, scope jsonb not null, at timestamptz not null default now());
       create table fb_ledger.yeses (id bigserial primary key, workflow text not null, file_hash text not null, max_usd double precision, max_calls int,
         who text not null, checked boolean not null default true, place text not null, at timestamptz not null default now())`,
      `create table fb_ledger.rate (provider text primary key, next_at timestamptz not null);
       create table fb_ledger.prices (provider text not null, endpoint text not null, usd double precision not null, expected double precision,
         at timestamptz not null default now(), primary key (provider, endpoint))`,
      "alter table fb_ledger.facts add column how text",
      // Kept facts by exact inputs: the endpoint, the cleaned inputs one lookup searches across providers, and writes kept apart.
      `alter table fb_ledger.facts add column endpoint text, add column inputs text[] not null default '{}', add column write boolean not null default false;
       create index facts_inputs on fb_ledger.facts using gin (inputs);
       alter table fb_ledger.calls add column write boolean not null default false;
       alter table fb_ledger.yeses add column run bigint`,
    ],
    async start(f) {
      fb = f
      // On your own computer one process owns the database: anything still held was left by a crash.
      if (!fb.live) await q("with gone as (delete from fb_ledger.holds returning 1) update fb_ledger.budgets set held_usd = 0, held_calls = 0 where held_calls > 0 or held_usd > 0 or exists (select 1 from gone)")
      return api
    },
    tools: {
      fact: {
        about: "Where a field came from: the kept fact behind it (provider, date, age, cost, the request). Or, for a field the workflow worked out itself, the calls made for that row.",
        role: "viewer",
        input: {
          id: { type: "number", about: "the fact's id (from the table tool)" },
          into: { about: "instead of id: the results table" },
          row: { type: "number", about: "with into: the row's id" },
        },
        run: async (i) => {
          if (i.id) {
            const f = (await q("select id, provider, request, status, answer, cost_usd, by, at, how, endpoint, write from fb_ledger.facts where id = $1", [i.id]))[0]
            if (!f) throw new Refused(`There is no fact ${i.id}.`)
            const asked = f.request ?? {}
            return {
              fact: f.id,
              from: f.how ? `${label(f.provider)}, through ${f.how}` : label(f.provider),
              endpoint: f.endpoint,
              /** The exact question it is filed under, cleaned up first: what one lookup finds it by. */
              question:
                [asked.query, asked.body]
                  .filter((x: unknown) => x !== null && x !== undefined)
                  .map((x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)))
                  .join(" ") || null,
              boughtOn: day(f.at),
              age: daysSince(f.at) ? `${age(f.at)} old` : "today",
              fresh: !f.write && daysSince(f.at) < FRESH,
              /** A write to another tool: done every time, never answered from memory. */
              write: !!f.write,
              cost: usd(f.cost_usd),
              by: f.by ?? "a one-off call",
              found: f.status !== 404,
              request: f.request,
              answer: f.answer,
            }
          }
          const calls = await q(
            `select c.provider, c.cost_usd, c.from_memory, c.at, c.scope->>'title' as by, f.request, f.how from fb_ledger.calls c left join fb_ledger.facts f on f.id = c.fact
             where c.scope @> $1::jsonb order by c.id`,
            [JSON.stringify({ into: i.into, row: i.row })],
          )
          return {
            workedOutBy: calls[0]?.by ?? null,
            calls: calls.map((c: any) => ({ from: c.how ? `${label(c.provider)}, through ${c.how}` : label(c.provider), cost: c.from_memory ? "already known, $0" : usd(c.cost_usd), at: day(c.at), request: c.request })),
          }
        },
      },
      lookup: {
        about:
          'What is already known about a value (an email, a web address, a LinkedIn address, a name), from every provider: each kept answer whose cleaned inputs hold it, with its age and whether it is still fresh. Free. Matching "Acme Inc" to acme.com is yours to do: this finds exact inputs only.',
        role: "viewer",
        input: { value: { about: "the value, like acme.com or maya@acme.com", required: true } },
        run: (i) => api.lookup(String(i.value)),
        print: (r: Awaited<ReturnType<Ledger["lookup"]>>) =>
          r.length
            ? r.map((f) => `fact ${f.fact}   ${f.from} ${f.endpoint ?? ""}   ${f.age}${f.fresh ? ", fresh" : ", older than the freshness window"}   ${usd(f.cost)}${f.found ? "" : "   (not found)"}`).join("\n")
            : "Nothing is known about that yet.",
      },
      spend: {
        about: "What has been spent: each provider this month, writes to other tools, and today's one-off calls.",
        role: "viewer",
        run: async () => {
          const t = (await api.spent(await api.today()))!
          const rows = await q(
            "select provider, count(*)::int as calls, count(*) filter (where write)::int as writes, coalesce(sum(cost_usd), 0)::float8 as usd from fb_ledger.calls where not from_memory and at >= date_trunc('month', now()) group by provider order by provider",
          )
          const saved = (await q("select count(*)::int as n from fb_ledger.calls where from_memory and at >= date_trunc('month', now())"))[0].n
          const surprises = await q("select provider, endpoint, usd, expected, at from fb_ledger.prices where expected is not null and usd > expected + 1e-9 order by at desc limit 20")
          return {
            oneOffToday: `${usd(t.usd)} of ${usd(DAY_USD)}`,
            thisMonth: rows.map((m: any) => ({ provider: label(m.provider), calls: m.calls, writes: m.writes, spent: usd(m.usd) })),
            alreadyKnown: saved,
            priceSurprises: surprises.map((x: any) => ({ provider: label(x.provider), endpoint: x.endpoint, reportedUsd: x.usd, expectedUsd: x.expected, seen: day(x.at) })),
          }
        },
        print: (r) =>
          [
            ...r.thisMonth.map((m: any) => `${m.provider} this month   ${m.spent} for ${m.calls} calls${m.writes ? `, ${m.writes} of them writes` : ""}`),
            `Already known this month   ${r.alreadyKnown} answers, at no cost`,
            `One-off calls today   ${r.oneOffToday}`,
            ...r.priceSurprises.map((x: any) => `Price check: ${x.provider} ${x.endpoint} reported ${usd(x.reportedUsd)} a call where ${usd(x.expectedUsd)} was expected. ${usd(x.reportedUsd)} is held from now on.`),
          ].join("\n"),
      },
      permissions: {
        about: "The permission mode and caps as they hold now (from flowbound.config.ts), each workflow's and provider's own rule, and what this month has used. The strictest rule wins.",
        role: "viewer",
        run: () => shown(),
        print: (r: Awaited<ReturnType<typeof shown>>) =>
          [
            `Mode   ${r.mode === "ask" ? "Ask every time" : r.mode === "auto" ? "Auto inside caps" : "Skip asking (no caps)"}`,
            ...Object.entries(r.caps).map(([k, v]) => `${k}   ${/^writes|^calls/.test(k) ? v : usd(v as number)}`),
            `This month   ${usd(r.thisMonth.usd)}${r.caps.perMonth !== undefined ? ` of ${usd(r.caps.perMonth)}` : ""}, ${r.thisMonth.writes} writes`,
            ...r.workflows.map((w) => `Workflow ${w.name}   ${w.mode ?? ""} ${JSON.stringify(w.caps)}`),
            ...r.providers.map((p) => `Provider ${p.title}   ${p.mode ?? ""} ${JSON.stringify(p.caps)}`),
            `Kept facts are fresh for ${r.freshDays} days`,
          ].join("\n"),
      },
    },
    /** For Needs you: a provider that reported a higher price for an endpoint than its card says. */
    async attention() {
      const rows = await q("select provider, endpoint, usd, expected from fb_ledger.prices where expected is not null and usd > expected + 1e-9 order by at desc limit 10")
      return rows.map(
        (x: any): Attention => ({
          what: `${label(x.provider)} reported ${usd(x.usd)} a call for ${x.endpoint}, where its card says ${usd(x.expected)}. ${usd(x.usd)} is set aside for each call from now on.`,
          fix: "Tell the person, and put the right price on the card or on the call.",
          when: "soon",
        }),
      )
    },
    pages: { "/permissions": { title: "Permissions", file: asset("ledger/permissions.html"), menu: true, order: 6 } },
    docs: asset("ledger/ledger.md"),
  })
}
