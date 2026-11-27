// A model is a provider card like any other, named "ai": the key, the one allowed address, the memory, the try-out,
// the estimate and the cap are the ones data providers have. Each answer is priced from its own token usage, and
// the worst case of a call is held against the cap before it is made.
// One way only: a model key typed on the Connections page (or a host that adds it). A model is a provider.
import { type Flowbound, use } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import type { Answer } from "./ledger.ts"
import { type Card, type Picked, type Provider, provider } from "./provider.ts"

type Price = { in: number; out: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }
type Tiered = Price & { long?: Price & { over: number } }

/** USD per million tokens, read from https://platform.claude.com/docs/en/about-claude/pricing on 26 Nov 2026. */
const PRICES: Record<string, Tiered> = {
  // Haiku 5.5 is priced by prompt length: a prompt over 100,000 tokens (cache reads and writes counted) pays the higher prices.
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, long: { over: 100_000, in: 0.5, out: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 } },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  "claude-fable-5-2": { in: 8, out: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 },
}
// These models may decline a request; with this the API carries on with a fallback model in the same call.
const FALLBACKS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"])
/** "anthropic/claude-haiku-5.5" and "claude-haiku-5-5" are the same model. */
const plain = (model: string) => model.replace(/^.*\//, "").replace(/\./g, "-")

export type AskOptions = {
  /** Another model for this one step. */
  model?: string
  /** The most tokens this answer may be, thinking included. */
  maxTokens?: number
  /** How hard the model thinks: "low", "medium", "high". null sends none. */
  effort?: string | null
  /** Standing instructions for the model, apart from the question. */
  system?: string
}
export type Ai = Provider & {
  /** Ask the model a question about some input. Returns its answer as text. */
  ask: (question: string, input?: unknown, opts?: AskOptions) => Promise<string>
  /** The same, as a value that carries its source: { value, fact }. */
  pick: (question: string, input?: unknown, opts?: AskOptions) => Promise<Picked>
}
export type AiOptions = Partial<Card> & {
  /** The model every step uses unless it names another. The cheap current one unless set. */
  model?: string
  /** The most tokens one answer may be, thinking included. Its price is held against the cap before each call. */
  maxTokens?: number
  /** How hard the model thinks: "low" unless set. null sends none. */
  effort?: string | null
  /** USD per million tokens for a model this card has no price for. */
  prices?: Record<string, { in: number; out: number }>
}

export const ai = (opts: AiOptions = {}) => {
  const model = opts.model ?? "claude-haiku-5-5"
  const maxTokens = opts.maxTokens ?? 4000
  const effort = opts.effort === undefined ? "low" : opts.effort
  const priceOf = (m: string): Tiered | undefined => {
    const mine = opts.prices?.[m] ?? opts.prices?.[plain(m)]
    return mine ? { ...mine, cacheRead: mine.in * 0.1, cacheWrite: mine.in * 1.25, cacheWrite1h: mine.in * 2 } : PRICES[plain(m)]
  }
  const tier = (p: Tiered, promptTokens: number): Price => (p.long && promptTokens > p.long.over ? p.long : p)
  const num = (v: unknown) => Number(v ?? 0) || 0

  /** What one answer really cost, from its token usage. A gateway that says the cost itself is believed. */
  const reported = (a: Answer): number | undefined => {
    const d = a.data as any
    const said = d?.provider_metadata?.gateway?.cost
    if (said !== undefined && Number.isFinite(Number(said))) return Number(said)
    const u = d?.usage
    // A fallback model may have answered: the answer says which model it was.
    const p = priceOf(String(d?.model ?? model)) ?? priceOf(model)
    if (!u || !p) return undefined
    const hour = num(u.cache_creation?.ephemeral_1h_input_tokens)
    const written = num(u.cache_creation_input_tokens)
    const read = num(u.cache_read_input_tokens)
    const t = tier(p, num(u.input_tokens) + written + read)
    return (num(u.input_tokens) * t.in + num(u.output_tokens) * t.out + read * t.cacheRead + Math.max(0, written - hour) * t.cacheWrite + hour * t.cacheWrite1h) / 1_000_000
  }
  /** The most one call can cost: every byte of the prompt as a token, and the whole answer used. Held against the cap. */
  const most = (m: string, prompt: string, max: number): number | undefined => {
    const p = priceOf(m)
    if (!p) return undefined
    const tokens = Buffer.byteLength(prompt) + 50
    const t = tier(p, tokens)
    return (tokens * t.in + max * t.out) / 1_000_000
  }
  const known = priceOf(model)
  const priceText = known
    ? `per token, from each answer's real usage: $${known.in} a million tokens in, $${known.out} out (${model})`
    : `per token, but this card has no price for ${model}: add prices: { "${model}": { in, out } } or it is capped by calls`

  const card: Card = {
    name: "ai",
    label: "AI model",
    host: "api.anthropic.com",
    key: { header: "x-api-key" },
    docs: "https://platform.claude.com/docs/en/api/messages",
    about: `A model for steps that need reading or judgement: use("ai").ask(question, input) returns text. Model: ${model}; a step can name another.`,
    hint: "For workflow steps that need reading or judgement. Paid per token, from each answer's real usage.",
    price: known || opts.prices ? { reported } : undefined,
    ...Object.fromEntries(Object.entries(opts).filter(([k]) => !["model", "maxTokens", "effort", "prices"].includes(k))),
  }
  const own = card.host === "api.anthropic.com"
  // A key typed on the Connections page is tried here first, at no cost.
  if (own && card.check === undefined) card.check = "/v1/models?limit=1"
  const base = provider(card)
  const startCard = base.start!

  type Asked = Picked & { costUsd: number; fromMemory: boolean; usage?: unknown }
  /** The text of a Messages API answer, or why there is none. */
  const textOf = (ok: boolean, status: number, data: any, m: string, max: number): string => {
    if (!ok) throw new Refused(`The model card answered ${status}: is "${m}" a model this account has?`, { code: "failed" })
    if (data?.stop_reason === "refusal") throw new Refused(`The model declined to answer${data.stop_details?.explanation ? `: ${data.stop_details.explanation}` : "."}`, { code: "failed" })
    if (data?.stop_reason === "max_tokens") throw new Refused(`The model's answer was cut off at ${max} tokens. Ask for less, or give the step a higher maxTokens.`, { code: "failed" })
    return (data?.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim()
  }
  const ask = async (question: string, input?: unknown, o: AskOptions = {}): Promise<Asked> => {
    const prompt = input === undefined ? question : `${question}\n\n${typeof input === "string" ? input : JSON.stringify(input, null, 2)}`
    const m = o.model ?? model
    const max = o.maxTokens ?? maxTokens
    const e = o.effort === undefined ? effort : o.effort
    const body = (name: string, more: object = {}) => ({
      model: name,
      max_tokens: max,
      ...(e ? { output_config: { effort: e } } : {}),
      ...more,
      ...(o.system ? { system: o.system } : {}),
      messages: [{ role: "user", content: prompt }],
    })
    // The worst case, so rows running side by side cannot pass the cap; the real cost replaces it when the answer is in.
    const price = most(m, `${o.system ?? ""}${prompt}`, max)
    const fallbacks = own && FALLBACKS.has(plain(m))
    const res = await use<Provider>(card.name).fetch("/v1/messages", {
      headers: { "anthropic-version": "2023-06-01", ...(fallbacks ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}) },
      body: body(m, fallbacks ? { fallbacks: "default" } : {}),
      price,
    })
    return { value: textOf(res.ok, res.status, res.data, m, max), fact: res.fact, costUsd: res.cost, fromMemory: res.fromMemory, usage: res.data?.usage }
  }
  /** Inside a step, an expected "no" must not be retried by the runner: say it once, with why. */
  const inStep = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (e: any) {
      if (!(e instanceof Refused)) throw e
      let fatal: ((m: string) => Error) | undefined
      try {
        const wf = await import("workflow")
        wf.getWorkflowMetadata()
        fatal = (m) => new wf.FatalError(m)
      } catch {}
      if (!fatal) throw e
      throw fatal(`[${e.more?.code === "failed" ? "failed" : `stop:${e.more?.code ?? "refused"}${e.more?.budget ? `@${e.more.budget}` : ""}`}] ${e.message}`)
    }
  }

  return Object.assign(base, {
    start: (f: Flowbound): Ai => {
      const pick: Ai["pick"] = (q, i, o) => inStep(async () => (({ value, fact }) => ({ value, fact }))(await ask(q, i, o)))
      return { ...(startCard(f) as Provider), ask: async (q, i, o) => String((await pick(q, i, o)).value), pick }
    },
    tools: {
      [card.name]: {
        about:
          "Ask the model one question about some input, as a workflow step would, on the model key typed on the Connections page. Paid per token, priced from the answer's own usage. The same question about the same input is answered from memory.",
        price: priceText,
        input: {
          question: { about: "what to ask", required: true },
          input: { type: "json" as const, about: "what the question is about" },
          model: { about: "another model for this one question" },
          maxTokens: { type: "number" as const, about: "the most tokens the answer may be" },
        },
        run: async (i: any) => ask(i.question, i.input, { model: i.model, maxTokens: i.maxTokens }),
      },
    },
    docs: `### AI model (\`use("${card.name}")\`)
A model is a provider card too. \`await use("${card.name}").ask("Is this person the head of sales?", profile)\` returns text; \`.pick(question, input)\` returns \`{ value, fact }\` so the field carries its source. The same question about the same input is answered from memory.

- before each paid call the most it could cost is held against the cap (the whole prompt and \`maxTokens\` of answer, ${maxTokens} unless set), so a cap smaller than one such call buys nothing: keep prompts and \`maxTokens\` as small as the job allows
- one step can differ: \`.ask(question, input, { model: "claude-sonnet-5-5", maxTokens: 500, effort: "medium", system: "..." })\`
- another default: \`ai({ model: "claude-sonnet-5-5" })\` in flowbound.config.ts; a model this card has no price for needs \`prices: { "<model>": { in, out } }\` (USD per million tokens)`,
  })
}
