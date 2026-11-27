// Shared by the tests: a throwaway project folder, an honest fake provider, and the command line as a subprocess.
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bin = path.join(repo, "dist", "core", "bin.js")

/** A fake data provider: answers like a people-data API, counts its calls, and can be told to misbehave. */
export async function fakeProvider() {
  const state = { calls: 0, mode: "ok" as "ok" | "busy" | "empty", delay: 0, revoked: false, times: [] as { path: string; who: string; at: number }[], models: [] as any[] }
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {}
    const send = (status: number, json: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(json))
    // `revoked`: the provider took the key back, as when somebody rotates it in the provider's dashboard.
    // The key in its own header, or as a bearer token (how a gateway is paid by a host's own sign-in).
    if ((req.headers["x-api-key"] !== "sk-test-123" && req.headers.authorization !== "Bearer sk-test-123") || state.revoked) return send(401, { message: "bad key" })
    // A second source that knows what the first does not: for a workflow that asks one provider, then another.
    if (req.url === "/v2/head-b") {
      state.calls++
      state.times.push({ path: req.url, who: String(body.company ?? ""), at: Date.now() })
      return send(200, { found: true, person: { full_name: `Second Source Head Of ${body.company}` } })
    }
    // A company's people: one row in, several out.
    if (req.url === "/v2/people") {
      state.calls++
      state.times.push({ path: req.url, who: String(body.company ?? ""), at: Date.now() })
      return send(200, { people: [1, 2, 3].map((n) => ({ name: `Person ${n} at ${body.company}`, linkedin_url: `https://linkedin.example/in/${String(body.company).toLowerCase()}-${n}` })) })
    }
    // Where a typed key is tried: it answers, and costs nothing.
    if (req.url === "/v2/me") return send(200, { account: "fake" })
    state.calls++
    state.times.push({ path: req.url ?? "", who: String(body.company ?? body.linkedin_url ?? ""), at: Date.now() })
    if (state.delay) await new Promise((r) => setTimeout(r, state.delay))
    if (state.mode === "busy") return send(429, { message: "too many requests" })
    if (state.mode === "empty") return send(200, { found: false })
    const n = Number(String(body.company ?? body.linkedin_url ?? "").replace(/\D/g, ""))
    if (req.url === "/v2/head") return n % 10 === 7 ? send(404, { found: false }) : send(200, { found: true, person: { full_name: `Head Of ${body.company}`, linkedin_url: `https://linkedin.example/in/co${n}` } })
    if (req.url === "/v2/email") return n % 5 === 3 ? send(200, { found: false, email: null }) : send(200, { found: true, email: `co${n}@corp.example` })
    // An endpoint that costs more than its card says, and says so with its answer.
    if (req.url === "/v2/pricey") return send(200, { ok: true }, { "x-fake-cost-usd": "0.05" })
    // A FAKE model: the shape of the Messages API, a made-up answer, and token counts worked out from the text.
    // It proves the plumbing (pricing from usage, the cap, the memory), never what a real model would say.
    if (req.url === "/v1/messages") {
      if (!req.headers["anthropic-version"]) return send(400, { message: "anthropic-version header is required" })
      state.models.push(body)
      const prompt = String(body.messages?.[0]?.content ?? "")
      return send(200, {
        id: `msg_fake_${state.calls}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [
          { type: "thinking", thinking: "", signature: "fake" },
          // Asked for JSON, it gives JSON: a made-up verdict, so a step that reads one can be walked through.
          { type: "text", text: /answer as json/i.test(prompt) ? `Here it is: {"why": "FAKE reason (${prompt.length} characters read)", "fit": "possible"}` : `FAKE one-liner (${prompt.length} characters read)` },
        ],
        stop_reason: Number(body.max_tokens) < 5 ? "max_tokens" : "end_turn",
        usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      })
    }
    send(400, { message: "unknown path" })
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const port = (server.address() as { port: number }).port
  return { state, port, host: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(ok)) }
}

export const WORKFLOW = `import { use } from "flowbound"

export const from = "target_list"
export const into = "sales_heads"

export async function findSalesHeads(company) {
  "use workflow"
  const head = await findHead(company)
  const email = await findEmail(head)
  return { head: head.name, email }
}

async function findHead(company) {
  "use step"
  const res = await use("fakedata").fetch("/v2/head", { body: { company: company.company } })
  return { name: res.pick("person.full_name"), linkedin: res.data.person?.linkedin_url ?? null }
}

async function findEmail(head) {
  "use step"
  if (!head.linkedin) return null
  const res = await use("fakedata").fetch("/v2/email", { body: { linkedin_url: head.linkedin } })
  return res.pick("email")
}
`

/** A project folder as `init` leaves it, with a card for the fake provider. The package is linked, not installed. */
export function project(providerHost: string, opts: { price?: string; permissions?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowbound-test-"))
  const home = path.join(root, ".home")
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true })
  fs.symlinkSync(repo, path.join(root, "node_modules", "flowbound"))
  for (const dep of ["workflow", "@workflow", "@electric-sql", "pg", "esbuild"]) fs.symlinkSync(path.join(repo, "node_modules", dep), path.join(root, "node_modules", dep))
  fs.mkdirSync(path.join(root, "workflows"))
  fs.mkdirSync(path.join(root, "plugins"))
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "test-project", private: true, type: "module" }))
  fs.writeFileSync(
    path.join(root, "plugins", "fakedata.ts"),
    `import { provider } from "flowbound"\nexport const fakedata = () => provider({ name: "fakedata", label: "FakeData", host: "${providerHost}", key: { header: "x-api-key" }, docs: "${providerHost}/docs", ${opts.price ?? "price: { perCall: 0.002 }"} })\n`,
  )
  fs.writeFileSync(path.join(root, "flowbound.config.ts"), `import { fakedata } from "./plugins/fakedata.ts"\nexport default { providers: [fakedata()]${opts.permissions ? `, permissions: ${opts.permissions}` : ""} }\n`)
  fs.writeFileSync(path.join(root, "workflows", "find-sales-heads.ts"), WORKFLOW)
  const csv = (from: number, to: number) => `company,domain\n${Array.from({ length: to - from + 1 }, (_, i) => `Co${from + i},co${from + i}.example`).join("\n")}\n`
  fs.writeFileSync(path.join(root, "targets.csv"), csv(1, 30))
  const port = 4300 + Math.floor(Math.random() * 600)
  const env = { ...process.env, FLOWBOUND_HOME: home, FLOWBOUND_RETRY_MS: "20,40", FLOWBOUND_PORT: String(port), CRON_SECRET: "test-clock-secret-0123456789" }
  let server: ChildProcess | undefined

  /** Run a `flowbound` command in the project. Resolves to what it printed; rejects when it fails unless `fails` is set. */
  const fb = (args: string, o: { fails?: boolean } = {}) =>
    new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, [bin, ...(args.match(/'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^'|'$/g, ""))], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (out += d))
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
      child.on("close", (code) => {
        clearTimeout(timer)
        if (code !== 0 && !o.fails) return fail(new Error(`flowbound ${args} failed:\n${out.trim()}`))
        if (code === 0 && o.fails) return fail(new Error(`flowbound ${args} should have failed:\n${out.trim()}`))
        done(out.trim())
      })
    })
  const url = () => JSON.parse(fs.readFileSync(path.join(root, ".flowbound", "server.json"), "utf8")).url as string
  /** Call a tool the way a page does (a person's door). */
  const page = async (tool: string, input: unknown = {}) =>
    (await fetch(`${url()}/api/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-flowbound-via": "page" }, body: JSON.stringify(input) })).json()
  /** Start Flowbound as `flowbound dev` does, as a child we can kill. */
  const start = async () => {
    server = spawn(process.execPath, [bin, "dev"], { cwd: root, env, stdio: "ignore" })
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 150))
      try {
        // Any answer means it is up: a live Flowbound answers "this needs a token" here.
        if ((await fetch(`${url()}/api`)).status < 500) return
      } catch {}
    }
    throw new Error("Flowbound did not start in the test project")
  }
  /** Pull the plug: kill the server and its supervisor without a goodbye. */
  const kill = () => {
    const pid = JSON.parse(fs.readFileSync(path.join(root, ".flowbound", "server.json"), "utf8")).pid as number
    server?.kill("SIGKILL")
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
    server = undefined
  }
  const stop = async () => {
    server?.kill("SIGTERM")
    await new Promise((r) => setTimeout(r, 300))
    fs.rmSync(root, { recursive: true, force: true })
  }
  /** Change a watched file and wait until Flowbound has restarted itself with it. */
  const restarted = async (change: () => void) => {
    const pid = () => JSON.parse(fs.readFileSync(path.join(root, ".flowbound", "server.json"), "utf8")).pid as number | undefined
    const before = pid()
    change()
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        if (pid() !== before && (await fetch(`${url()}/api`)).ok) return
      } catch {}
    }
    throw new Error("Flowbound did not restart after the change")
  }
  const until = async (what: () => boolean | Promise<boolean>, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await what()) return
    throw new Error("waited too long")
  }
  return { root, home, env, fb, page, url, start, kill, stop, until, restarted, csv }
}
