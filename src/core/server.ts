// Start the plugins in order and offer every tool on one HTTP API. Nothing here knows any plugin by name.
import http from "node:http"
import type { Config } from "../index.ts"
import { check, toList } from "./load.ts"
import { type At, can, type Flowbound, type Plugin, projectRole, type Route, shared, type Tool, type Who } from "./plugin.ts"

/** An expected "no": said plainly to whoever asked, never logged as a crash. */
export class Refused extends Error {
  more?: Record<string, unknown>
  status: number
  constructor(message: string, more?: Record<string, unknown>, status = 400) {
    super(message)
    this.name = "Refused"
    this.more = more
    this.status = status
  }
}

export type App = { fb: Flowbound; fetch: (req: Request) => Promise<Response>; stop: () => Promise<void> }

/** Start the project: what flowbound.config.ts exports (the project, or a plain list of plugins). */
export async function boot(project: Config | Plugin[], opts: { root: string; live?: boolean; url: string; local?: string }): Promise<App> {
  const { order, problems } = check(await toList(project))
  if (problems.length) throw new Refused(`The plugin list has ${problems.length} problem(s):\n${problems.join("\n")}`)
  const parts = new Map<string, unknown>()
  const started: Plugin[] = []
  const fb: Flowbound = {
    root: opts.root,
    live: !!opts.live,
    url: opts.url.replace(/\/+$/, ""),
    base: basePath(opts.url),
    local: opts.local ?? opts.url,
    plugins: order,
    tools: {},
    has: (name) => parts.has(name),
    use: (name) => {
      if (!parts.has(name)) throw new Refused(`use("${name}"): no started plugin has that name or gives it. Started: ${[...parts.keys()].join(", ")}`)
      return parts.get(name) as any
    },
    call: async (name, input, who) => {
      const tool = fb.tools[name]
      if (!tool) throw new Refused(`No tool is called "${name}". Tools: ${Object.keys(fb.tools).join(", ")}`, undefined, 404)
      if (tool.by === "people" && !(who.kind === "person" || (who.kind === "local" && who.via === "page"))) throw new Refused(`"${name}" is for a person on a page, not for an agent.`, undefined, 403)
      const need = projectRole(tool.role ?? "member")
      if (!can(who, need)) throw new Refused(`"${name}" requires ${need} access. ${who.role === "none" ? "No admin has given you access yet." : `Your role is ${who.role}.`}`, { code: "rights", need }, 403)
      return tool.run(clean(name, tool, input), who)
    },
  }
  Object.assign(shared(), { use: fb.use, has: fb.has })
  try {
    for (const p of order) {
      started.push(p)
      const part = await p.start?.(fb)
      parts.set(p.name, part)
      if (p.provides) parts.set(p.provides, part)
      Object.assign(fb.tools, p.tools)
    }
  } catch (error) {
    for (const p of started.reverse())
      await Promise.resolve()
        .then(() => p.stop?.())
        .catch(() => {})
    throw error
  }
  const routes = order.flatMap((p) =>
    Object.entries(p.routes ?? {}).map(([key, run]) => {
      const [method, pattern] = key.split(" ") as [string, string]
      const names: string[] = []
      const re = new RegExp(`^${pattern.replace(/:(\w+)\*?/g, (m, n) => (names.push(n), m.endsWith("*") ? "(.*)" : "([^/]+)"))}/?$`)
      return { method, re, names, run }
    }),
  )
  const guards = order.filter((p) => p.guard)

  async function answer(req: Request): Promise<Response> {
    const url = new URL(req.url)
    // Shared under a path (FLOWBOUND_URL=https://host/flowbound): a proxy may pass that path on or cut it off. Both work.
    if (fb.base && (url.pathname === fb.base || url.pathname.startsWith(`${fb.base}/`))) url.pathname = url.pathname.slice(fb.base.length) || "/"
    const tool = /^\/api\/([\w.-]+)$/.exec(url.pathname)?.[1]
    let route: { run: Route; params: Record<string, string> } | undefined
    for (const r of routes) {
      const m = r.method === req.method || r.method === "ANY" ? r.re.exec(url.pathname) : null
      if (m) {
        route = { run: r.run, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) }
        break
      }
    }
    // On your own computer nobody signs in: the address is the only door, so another website must not reach through it.
    if (!fb.live) {
      const why = foreign(req, fb)
      if (why) return Response.json({ ok: false, error: why }, { status: 403 })
    }
    const via = req.headers.get("x-flowbound-via") ?? "api"
    let who: Who | undefined = fb.live ? undefined : { kind: "local", name: "You", via }
    for (const g of guards) {
      const said = await g.guard!(req, url, tool || url.pathname === "/api" ? { open: "token" } : route?.run)
      if (said instanceof Response) return said
      if (said) who = said
    }
    if (!who) return Response.json({ ok: false, error: "Nobody gets in: this live Flowbound has no door plugin." }, { status: 401 })
    if (url.pathname === "/api" && req.method === "GET") return Response.json(about(fb))
    if (tool && req.method === "POST") {
      const input = await req.json().catch(() => ({}))
      return Response.json({ ok: true, result: (await fb.call(tool, input, who)) ?? null })
    }
    if (route) return route.run(req, { params: route.params, url, who } satisfies At)
    return Response.json({ ok: false, error: `Nothing is at ${url.pathname}.` }, { status: 404 })
  }

  return {
    fb,
    fetch: (req) =>
      answer(req).catch((e) => {
        if (!(e instanceof Refused)) console.error(e)
        return Response.json({ ok: false, error: String(e?.message ?? e), ...(e instanceof Refused ? e.more : {}) }, { status: e instanceof Refused ? e.status : 500 })
      }),
    stop: async () => {
      for (const p of started.reverse()) await p.stop?.()
    },
  }
}

/** A name only this computer, a private network or a tailnet answers to. Nobody outside can point one of these at 127.0.0.1. */
const ownName = (hostname: string) => {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return /^[\d.]+$/.test(h) || h.includes(":") || h === "localhost" || !h.includes(".") || /\.(localhost|local|internal|ts\.net)$/.test(h)
}

/**
 * Why a request to a Flowbound on your own computer is turned away, if it is. A browser tab on any website can send
 * requests to this computer's own address, so two things are checked. The name it was sent to: a made-up name pointed
 * at 127.0.0.1 (DNS rebinding) is not this Flowbound's. And, for anything that is not a plain read, where it says it
 * comes from: a browser names the page that sent it (`Origin`), and only Flowbound's own pages may ask for changes.
 * The command line, the MCP server and a private proxy send no `Origin` and pass.
 */
export function foreign(req: Request, fb: Pick<Flowbound, "url" | "local">): string | undefined {
  const mine = [fb.url, fb.local].map((u) => {
    try {
      return new URL(u).host.toLowerCase()
    } catch {
      return ""
    }
  })
  const host = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase()
  let name = host
  try {
    name = new URL(`http://${host}`).hostname
  } catch {}
  if (!mine.includes(host) && !ownName(name))
    return `This Flowbound runs on a person's own computer and does not answer to the name ${host}. To share it privately under another name, start it with FLOWBOUND_URL set to that address.`
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return undefined
  const origin = req.headers.get("origin")
  let from = origin
  try {
    if (origin) from = new URL(origin).host.toLowerCase()
  } catch {}
  // A private proxy in front (a tailnet share) says the name the browser used; a page on another site cannot add that header.
  const proxied = (req.headers.get("x-forwarded-host") ?? "").toLowerCase()
  if ((origin && from !== host && from !== proxied && !mine.includes(from!)) || (!origin && req.headers.get("sec-fetch-site") === "cross-site"))
    return `This request comes from another website (${origin ?? "it did not say which"}). A Flowbound on a person's own computer only takes changes from its own pages, its command line and its MCP server.`
  return undefined
}

/** The path part of an address: "/flowbound" for https://host/flowbound/, "" for http://localhost:4111. */
export function basePath(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "")
  } catch {
    return ""
  }
}

/** What GET /api says: who this is and every tool an agent may call. */
export function about(fb: Flowbound) {
  const tools = Object.entries(fb.tools)
    .filter(([, t]) => t.by !== "people")
    .map(([name, t]) => ({ name, about: t.about, input: t.input ?? {}, price: t.price, docs: t.docs }))
  return { flowbound: true, root: fb.root, live: fb.live, url: fb.url, tools }
}

function clean(name: string, tool: Tool, raw: unknown): Record<string, unknown> {
  const input = { ...(raw && typeof raw === "object" ? raw : {}) } as Record<string, unknown>
  for (const [key, spec] of Object.entries(tool.input ?? {})) {
    let v = input[key]
    if (v === undefined || v === null || v === "") {
      if (spec.required) throw new Refused(`"${name}" needs "${key}": ${spec.about}`)
      delete input[key]
      continue
    }
    if (spec.type === "number" && typeof v === "string") v = Number(v)
    if (spec.type === "number" && !Number.isFinite(v)) throw new Refused(`"${key}" must be a number.`)
    if (spec.type === "boolean" && typeof v === "string") v = v !== "false" && v !== "0"
    if (spec.type === "json" && typeof v === "string") {
      try {
        v = JSON.parse(v)
      } catch {
        throw new Refused(`"${key}" must be JSON.`)
      }
    }
    input[key] = v
  }
  return input
}

/** Serve an app on this computer only. Tries the next ports when one is taken. */
export async function listen(port: number, handler: (port: number) => Promise<App["fetch"]>): Promise<{ port: number; close: () => Promise<void> }> {
  // The port is taken first and the plugins start after: a request that comes in between waits for them.
  let started!: (f: App["fetch"]) => void
  let failed!: (e: unknown) => void
  const ready = new Promise<App["fetch"]>((ok, no) => ((started = ok), (failed = no)))
  ready.catch(() => {})
  const server = http.createServer(async (req, res) => {
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await new Response(req as any).arrayBuffer()
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
      const out = await (await ready)(new Request(`http://${req.headers.host ?? `localhost:${port}`}${req.url}`, { method: req.method, headers, body }))
      const head: Record<string, string | string[]> = {}
      out.headers.forEach((v, k) => {
        if (k !== "set-cookie") head[k] = v
      })
      const cookies = out.headers.getSetCookie()
      if (cookies.length) head["set-cookie"] = cookies
      res.writeHead(out.status, head)
      if (out.body) for await (const chunk of out.body as any) res.write(chunk)
      res.end()
    } catch (e) {
      console.error(e)
      if (!res.headersSent) res.writeHead(500)
      res.end(String(e))
    }
  })
  for (let tries = 0; ; tries++) {
    try {
      await new Promise<void>((ok, no) => server.once("error", no).listen(port, "127.0.0.1", () => (server.off("error", no), ok())))
      break
    } catch (e: any) {
      if (e.code !== "EADDRINUSE" || tries > 20) throw e
      port++
    }
  }
  const address = server.address()
  if (address && typeof address !== "string") port = address.port
  try {
    started(await handler(port))
  } catch (e) {
    failed(e)
    server.closeAllConnections()
    server.close()
    throw e
  }
  return { port, close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))) }
}
