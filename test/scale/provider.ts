// The honest fake provider for the big run: a people-data API and a FAKE model on this machine, with delays, slow
// answers, failures and refusals, a speed limit it checks, and its own bill. Nothing here costs anything.
import crypto from "node:crypto"
import http from "node:http"

export const KEY = "sk-scale-123"
/** What the fake charges, in billionths of a dollar so its bill is exact. The card and the workflow say the same prices. */
export const PRICE = { head: 2_000_000, email: 4_000_000, tokenIn: 100, tokenOut: 500 }

/** A number from 0 to 1 that is always the same for the same text: who is found, who fails, who is refused. */
const chance = (text: string) => crypto.createHash("sha256").update(text).digest().readUInt32BE(0) / 2 ** 32

export async function scaleProvider(o: { perSecond: number; speed?: number }) {
  const speed = o.speed ?? 1
  const bill = {
    /** Everything the provider charged for, in billionths of a dollar. */
    nano: 0,
    calls: 0,
    /** Charged although the caller had gone before the answer was sent: a call in the air when Flowbound was killed. */
    lostNano: 0,
    lostCalls: 0,
    /** How often each request was charged. More than once means it was bought twice. */
    times: new Map<string, number>(),
  }
  const seen = { requests: 0, atOnce: 0, mostAtOnce: 0, mostDataPerSecond: 0, tooFast: 0, slow: 0, by: {} as Record<string, number> }
  const second = new Map<number, number>()
  const tries = new Map<string, number>()
  const count = (what: string) => (seen.by[what] = (seen.by[what] ?? 0) + 1)

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {}
    let gone = false
    res.on("close", () => (gone ||= !res.writableEnded))
    const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
      count(`${req.url} ${status}`)
      if (!gone) res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(json))
    }
    /** Charge for an answer. The provider did the work, so it charges even when nobody is left to hear it. */
    const charge = (key: string, nano: number) => {
      bill.nano += nano
      bill.calls++
      bill.times.set(key, (bill.times.get(key) ?? 0) + 1)
      if (gone) {
        bill.lostNano += nano
        bill.lostCalls++
      }
    }
    if (req.headers["x-api-key"] !== KEY) return send(401, { message: "bad key" })
    const model = req.url === "/v1/messages"
    const who = model ? String(body.messages?.[0]?.content ?? "") : String(body.company ?? body.linkedin_url ?? "")
    const key = `${req.url} ${who}`
    const luck = chance(key)
    const nth = (tries.get(key) ?? 0) + 1
    tries.set(key, nth)
    seen.requests++
    seen.mostAtOnce = Math.max(seen.mostAtOnce, ++seen.atOnce)
    try {
      if (!model) {
        // The speed limit on the card: the provider counts for itself, and refuses when it is passed by half.
        const now = Math.floor(Date.now() / 1000)
        const n = (second.get(now) ?? 0) + 1
        second.set(now, n)
        seen.mostDataPerSecond = Math.max(seen.mostDataPerSecond, n)
        if (n > o.perSecond * 1.5) {
          seen.tooFast++
          return send(429, { message: "too many requests" }, { "retry-after": "1" })
        }
      }
      // Realistic waits: most answers in a few hundred milliseconds, 2 in 100 take seconds.
      const usual = model ? 500 : req.url === "/v2/email" ? 180 : 120
      const slow = Math.random() < 0.02
      if (slow) seen.slow++
      await new Promise((r) => setTimeout(r, (slow ? 3000 + Math.random() * 3000 : usual * (0.5 + Math.random() * 1.5)) * speed))

      if (req.url === "/v2/head") {
        if (luck < 0.015) return send(500, { message: "internal error" }) // always down for this company: the row fails
        if (luck < 0.045 && nth === 1) return send(503, { message: "try again" }) // down once, fine the second time
        if (luck < 0.055 && nth === 1) return send(429, { message: "too many requests" }, { "retry-after": "1" })
        if (luck >= 0.055 && luck < 0.065) return send(422, { message: "this company is on our do-not-serve list" }) // a refusal: costs nothing
        charge(key, PRICE.head)
        if (luck < 0.145) return send(404, { found: false })
        const slug = who.toLowerCase().replace(/[^a-z0-9]+/g, "-")
        return send(200, { found: true, person: { full_name: `Head Of ${who}`, title: luck < 0.6 ? "VP Sales" : "Head of Sales", linkedin_url: `https://linkedin.example/in/${slug}` } })
      }
      if (req.url === "/v2/email") {
        charge(key, PRICE.email)
        return luck < 0.2 ? send(200, { found: false, email: null }) : send(200, { found: true, email: `${who.split("/").pop()}@corp.example` })
      }
      if (model) {
        if (!req.headers["anthropic-version"]) return send(400, { message: "anthropic-version header is required" })
        if (luck < 0.005 && nth === 1) return send(529, { message: "overloaded" })
        const input = Math.ceil(who.length / 4)
        // A FAKE model: the shape of the Messages API and token counts from the text. A refusal is an answer, and is charged.
        if (luck < 0.025) {
          charge(key, input * PRICE.tokenIn)
          return send(200, { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: "refusal", usage: { input_tokens: input, output_tokens: 0 } })
        }
        const output = 20 + Math.floor(luck * 40)
        charge(key, input * PRICE.tokenIn + output * PRICE.tokenOut)
        const text = `FAKE opener, ${output} tokens long, about ${who.length} characters of input.`
        return send(200, { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: input, output_tokens: output } })
      }
      send(400, { message: "unknown path" })
    } finally {
      seen.atOnce--
    }
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const port = (server.address() as { port: number }).port
  return {
    bill,
    seen,
    host: `http://127.0.0.1:${port}`,
    /** Requests charged more than once: the same thing bought twice. */
    twice: () => [...bill.times.values()].filter((n) => n > 1).length,
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(ok))),
  }
}
