// A data provider is a small card: where it lives, how its key attaches, where its manual is. The agent writes the calls.
import { type Plugin, plugin, use } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import type { Keys } from "./keys.ts"
import { Again, type Answer, type Ledger } from "./ledger.ts"
import { usd } from "./util.ts"

export type Card = {
  name: string
  /** How people read its name: "BlitzAPI". */
  label?: string
  /** Where it lives: "api.blitz-api.ai". Add http:// for a server on your own machine. */
  host: string
  /** How the key attaches, or false when a proxy at `host` adds it. `name`: the connection its key is kept under (BISNODE_KEY). Default: the card's name in capitals, then _KEY. */
  key: false | { header: string; prefix?: string; name?: string }
  /** The manual your agent reads before it writes a call. */
  docs: string
  /** From the provider's price page. A price the provider reports with its answer wins. No price: runs are capped by calls. */
  price?: { perCall?: number; reported?: (answer: Answer) => number | undefined }
  /** The provider's speed limit, kept across all rows, runs and copies of Flowbound. */
  rate?: { perSecond?: number; perMinute?: number }
  /** A path that answers a good key with 2xx and a bad one with 401 or 403, at no cost: a typed key is tried there before it is saved. */
  check?: string
  /** Why the key is needed, shown under its field on the Connections page. */
  hint?: string
  /** For a card that also works with no key on a person's own computer: one line saying how. A missing key is then not a problem there. */
  without?: string
  /**
   * Whether a call writes to another tool (a CRM, a sequencer) rather than asking it something. A write is counted by
   * number against the write caps, under the same permissions, and is never answered from memory. True: every call
   * writes. A function: decide per call, like ({ method }) => method !== "GET".
   */
  writes?: boolean | ((call: { method: string; path: string }) => boolean)
  /** One line for the agent: what it is good for, or a catch worth knowing. */
  about?: string
}

export type CallOptions = {
  method?: string
  body?: unknown
  query?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  /** What this one call costs in USD, when the manual gives a price per endpoint. */
  price?: number
  /** Days a kept answer is good for this one call, instead of the project's freshness window. */
  freshDays?: number
  /** This call writes to the other tool (or, false, only reads), whatever the card says. */
  write?: boolean
  /** How the answer is got, when a card has more than one way: kept with the paid fact and shown with it. */
  how?: string
}
export type Picked = { value: unknown; fact: number }
export type Result = {
  status: number
  /** False when the provider answered "not found". */
  ok: boolean
  data: any
  /** USD this call cost. 0 when it was answered from memory. */
  cost: number
  /** The id of the paid fact: where this answer is remembered. */
  fact: number
  fromMemory: boolean
  /** A value from the answer that carries its source: pick("data.email") -> { value, fact }. */
  pick: (path: string) => Picked
}
export type Provider = { card: Card; fetch: (path: string, opts?: CallOptions) => Promise<Result> }

const dig = (data: unknown, path: string): unknown =>
  path
    .replace(/\[(\w+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<any>((v, k) => (v === null || v === undefined ? undefined : v[k]), data)

/** The workflow run this code is a step of, if any. */
async function stepOf(): Promise<{ run?: string; id?: string; fatal?: (m: string) => Error }> {
  try {
    const wf = await import("workflow")
    let id: string | undefined
    try {
      id = wf.getStepMetadata().stepId
    } catch {}
    return { run: wf.getWorkflowMetadata().workflowRunId, id, fatal: (m) => new wf.FatalError(m) }
  } catch {
    return {}
  }
}

/** What a provider said, as an answer the ledger keeps; or why it is not one: busy (worth another try), the key, the account, a bad request. */
export async function answerOf(card: { label: string; name: string; key: boolean; docs: string }, res: Response): Promise<Answer> {
  const { label } = card
  const text = await res.text()
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {}
  const said = typeof data === "object" && data ? String((data as any).error?.message ?? (data as any).error ?? (data as any).message ?? "").slice(0, 200) : text.slice(0, 200)
  const why = said ? ` ("${said}")` : ""
  if (res.status === 429 || res.status >= 500)
    throw new Again(`${label} refused the call with ${res.status}${res.status === 429 ? ' "too many requests"' : why}.`, Number(res.headers.get("retry-after")) * 1000 || undefined)
  if (res.status === 401 || res.status === 403)
    throw new Refused(card.key ? `${label} refused the key${why}. Check it on the Connections page.` : `${label} refused the call, which went without a key${why}.`, { code: "no-key", card: card.name })
  if (res.status === 402) throw new Refused(`${label} says the account has no credit left${why}.`, { code: "no-key", card: card.name })
  if (res.status >= 300 && res.status !== 404) throw new Refused(`${label} did not accept the request: ${res.status}${why}. Nothing was spent on it. Check the call against the manual: ${card.docs}`, { code: "failed" })
  return { status: res.status, headers: Object.fromEntries(res.headers), data }
}

export function provider(card: Card): Plugin {
  const label = card.label ?? card.name.replace(/^./, (c) => c.toUpperCase())
  const price = card.price?.perCall !== undefined ? `${usd(card.price.perCall)} a call` : card.price?.reported ? "reported by the provider with each answer" : "no price on the card: capped by number of calls"

  const call = async (path: string, opts: CallOptions = {}): Promise<Result> => {
    const keys = use<Keys>("keys")
    const ledger = use<Ledger>("ledger")
    const method = (opts.method ?? (opts.body === undefined ? "GET" : "POST")).toUpperCase()
    const query = opts.query && Object.keys(opts.query).length ? `?${new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)]))}` : ""
    const step = await stepOf()
    try {
      const paid = await ledger.call(
        {
          provider: card.name,
          request: { method, path, query: opts.query ?? null, body: opts.body ?? null },
          price: opts.price ?? card.price?.perCall,
          reported: card.price?.reported,
          freshDays: opts.freshDays,
          scopeKey: step.run,
          step: step.id,
          rate: card.rate,
          write: opts.write ?? (typeof card.writes === "function" ? card.writes({ method, path }) : !!card.writes),
          how: opts.how,
        },
        async () => {
          let res: Response
          try {
            res = await keys.fetch(card.name, path + query, {
              method,
              headers: { ...(opts.body === undefined ? {} : { "content-type": "application/json" }), accept: "application/json", ...opts.headers },
              body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
            })
          } catch (e: any) {
            if (e instanceof Refused) throw e
            throw new Again(`${label} could not be reached (${e?.cause?.code ?? e?.message ?? e}).`)
          }
          return answerOf({ label, name: card.name, key: !!card.key, docs: card.docs }, res)
        },
      )
      const out = { status: paid.answer.status, ok: paid.answer.status < 300, data: paid.answer.data as any, cost: paid.cost, fact: paid.fact, fromMemory: paid.fromMemory }
      return Object.defineProperty(out as Result, "pick", { enumerable: false, value: (p: string): Picked => ({ value: dig(out.data, p) ?? null, fact: out.fact }) })
    } catch (e: any) {
      // Inside a step, an expected "no" must not be retried by the runner: say it once, with why.
      // A cap says which one it was ("@month:2026-11"), so the run can say which cap paused it and a yes can lift that one.
      if (step.fatal && e instanceof Refused) throw step.fatal(`[${e.more?.code === "failed" ? "failed" : `stop:${e.more?.code ?? "refused"}${e.more?.budget ? `@${e.more.budget}` : ""}`}] ${e.message}`)
      throw e
    }
  }

  return plugin({
    name: card.name,
    needs: ["keys", "ledger"],
    card,
    start: (): Provider => ({ card, fetch: call }),
    tools: {
      [card.name]: {
        about: `Call ${label} (${card.host}) once, on the person's key, to see what it answers. ${card.about ?? ""} Read the manual first: ${card.docs}. Counts against today's allowance for one-off calls.`.replace(
          /\s+/g,
          " ",
        ),
        price,
        docs: card.docs,
        input: {
          path: { about: 'the path at the provider, like "/v2/search"', required: true },
          body: { type: "json", about: "the JSON body (makes it a POST)" },
          query: { type: "json", about: "query parameters as JSON" },
          method: { about: "GET, POST, ... when it is not the usual one" },
          price: { type: "number", about: "USD this call costs, when the manual prices this endpoint differently from the card" },
          write: { type: "boolean", about: "this call writes to the other tool (counted against the write caps), when the card cannot tell" },
        },
        run: async (i) => {
          const r = await call(i.path, i)
          return { status: r.status, cost: r.cost, fromMemory: r.fromMemory, fact: r.fact, data: r.data }
        },
      },
    },
    docs: `### ${label} (\`use("${card.name}")\`)\n${card.about ? `${card.about}\n` : ""}- address: \`${card.host}\`${card.key ? `, key sent as \`${card.key.header}\`` : ", no key (a proxy adds it)"}\n- price: ${price}${card.writes ? "\n- writes: it can write to this tool; each write counts against the write caps" : ""}${card.rate ? `\n- speed limit: ${card.rate.perSecond ? `${card.rate.perSecond} a second` : `${card.rate.perMinute} a minute`}, kept for you` : ""}\n- manual: ${card.docs}`,
  })
}
