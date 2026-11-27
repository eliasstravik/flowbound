// The MCP door: two tools however many plugins are installed. search finds a tool and its inputs; execute runs a few
// lines of JavaScript that call tools (several at once, keeping only what is needed).
// Over stdio on your own computer (`flowbound mcp`); over HTTPS when live (/mcp).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { docs } from "../core/docs.ts"
import { findRoot } from "../core/load.ts"
import { ensure, join } from "../core/local.ts"
import { type Flowbound, plugin } from "../core/plugin.ts"
import { about } from "../core/server.ts"
import catalog from "./mcp/catalog.json" with { type: "json" }
import { execute } from "./mcp/execute.ts"
import { type Pages, renderApp } from "./pages.ts"

type About = { url: string; live: boolean; tools: { name: string; about: string; input: Record<string, { type?: string; about: string; required?: boolean }>; price?: string; docs?: string }[] }
/** What the MCP door needs from the Flowbound behind it. The same two calls locally (over HTTP) and live (in process). */
type Behind = {
  about: (project?: unknown) => Promise<About>
  call: (tool: string, input: unknown, project?: unknown) => Promise<unknown>
  app?: { url: string; live: boolean; role?: string; tools: string[] }
}
type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }

const viewUri = "ui://flowbound/app.html"
const resource = { uri: viewUri, name: "Flowbound", mimeType: "text/html;profile=mcp-app" }
const ui = { resourceUri: viewUri, visibility: ["model", "app"] }
const showTool = {
  name: "show",
  title: "Show Flowbound",
  description: "Show a Flowbound run or its run list in chat. After execute starts or reads a run, call show with its run number to display its live status and any approval question. This only opens a view.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      run: { type: "integer", minimum: 1, description: "Run number from Flowbound" },
      project: { type: "string", description: "Absolute path to the open project folder for local Flowbound." },
    },
  },
  _meta: { ui },
}

const version = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version as string
  } catch {
    return "0"
  }
}
// Chat apps that run in a browser call from another origin. The token is the only way in, so any origin may ask.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "POST, OPTIONS" }
const text = (s: string, more = {}) => ({ content: [{ type: "text", text: s }], ...more })

export async function answer(msg: Rpc, behind: Behind, hasApp = !!behind.app): Promise<object | undefined> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result })
  if (msg.id === undefined) return undefined
  try {
    if (msg.method === "initialize")
      return ok({
        protocolVersion: catalog.versions.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : catalog.versions[0],
        capabilities: { tools: {}, ...(hasApp ? { resources: {}, extensions: { "io.modelcontextprotocol/ui": {} } } : {}) },
        serverInfo: { name: "flowbound", version: version() },
        instructions: catalog.instructions + (hasApp ? " After you start or inspect a run for the person, call show with its run number to open it in chat, and share its web link if chat cannot display it." : ""),
      })
    if (msg.method === "ping") return ok({})
    if (msg.method === "tools/list") return ok({ tools: hasApp ? [...catalog.tools, showTool] : catalog.tools })
    if (msg.method === "resources/list") return ok({ resources: hasApp ? [resource] : [] })
    if (msg.method === "resources/read") {
      if (msg.params?.uri !== viewUri || !hasApp) return { jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Flowbound has no such resource." } }
      return ok({ contents: [{ uri: viewUri, mimeType: resource.mimeType, text: renderApp(), _meta: { ui: { csp: {} } } }] })
    }
    if (msg.method === "resources/templates/list") return ok({ resourceTemplates: [] })
    if (msg.method !== "tools/call") return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Flowbound's MCP server has no ${msg.method}.` } }
    const { name, arguments: args = {} } = msg.params ?? {}
    if (name === "show" && hasApp) {
      if (args.run !== undefined && (!Number.isSafeInteger(args.run) || args.run <= 0)) throw new Error("Use a positive run number.")
      const app = behind.app
      const url = app?.url ?? (await behind.about(args.project)).url
      const params = args.run === undefined ? {} : { run: args.run }
      const link = `${url}/runs${args.run === undefined ? "" : `?run=${args.run}`}`
      return ok(
        text(`${args.run === undefined ? "Open Flowbound runs" : `Open Flowbound run ${args.run}`}: ${link}`, {
          structuredContent: { view: { path: "/runs", params, url, live: app?.live ?? false }, link },
          _meta: { flowbound: { role: app?.role, tools: app?.tools } },
        }),
      )
    }
    if (name === "search") {
      const info = await behind.about(args.project)
      const words = String(args.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      const hits = info.tools.filter((t) => !words.length || words.some((w) => `${t.name} ${t.about}`.toLowerCase().includes(w)))
      const lines = (hits.length ? hits : info.tools).map((t) => {
        const inputs = Object.entries(t.input).map(([k, s]) => `    ${k}${s.required ? " (needed)" : ""}: ${s.type ?? "string"}, ${s.about}`)
        return [`${t.name}: ${t.about}`, t.price ? `    price: ${t.price}` : "", ...inputs].filter(Boolean).join("\n")
      })
      return ok(
        text(
          `${hits.length ? "" : `Nothing matched "${args.query}". Every tool:\n`}${lines.join("\n")}\n\nCall them with execute: const r = await flowbound.<tool>({ ... }); return r. Tools with a dash: flowbound["schedule-run"]({ ... }). The person's page: ${info.url}/needs`,
        ),
      )
    }
    if (name === "execute") {
      const out = (await behind.call("execute", { code: String(args.code ?? "") }, args.project)) as { result: unknown; logs: string[] }
      const shown = typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2)
      return ok(text(`${out.logs.length ? `${out.logs.join("\n")}\n---\n` : ""}${shown}`, { structuredContent: { result: out.result, logs: out.logs } }))
    }
    return ok(text(`Flowbound has ${hasApp ? "search, execute and show" : "two MCP tools: search and execute"}. There is no "${name}".`, { isError: true }))
  } catch (e: any) {
    return ok(text(String(e?.message ?? e), { isError: true }))
  }
}

/** `flowbound mcp`: speak MCP on stdin and stdout, and pass every call to this folder's running Flowbound. */
export async function stdio(remote?: URL) {
  const end = new AbortController()
  let connected: ReturnType<typeof import("./mcp/company.ts").signIn> | undefined
  let root: string | undefined
  let selecting: Promise<string> | undefined
  let leave: (() => void) | undefined
  let closed = false
  let asked = 0
  const waiting = new Map<number, (result: any) => void>()
  const send = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`)
  let canAskRoots = false
  const select = async (project?: unknown) => {
    const cwd = fs.realpathSync(process.cwd())
    const pluginParent = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT
    const packageDir = pluginParent && fs.existsSync(pluginParent) ? fs.realpathSync(pluginParent) : undefined
    const inside = (dir: string) => packageDir && (dir === packageDir || dir.startsWith(packageDir + path.sep))
    const provided = typeof project === "string" && path.isAbsolute(project) ? fs.realpathSync(project) : undefined
    const here = !provided && !inside(cwd) && findRoot(cwd)
    if (here) return here
    const folders = new Set<string>()
    if (!provided && canAskRoots) {
      // Some agent apps start the server away from the project. Ask the app which folders it has open.
      const got: any = await new Promise((done) => {
        const id = --asked
        const timer = setTimeout(() => {
          waiting.delete(id)
          done(undefined)
        }, 3000)
        waiting.set(id, (value) => {
          clearTimeout(timer)
          done(value)
        })
        send({ jsonrpc: "2.0", id, method: "roots/list" })
      })
      for (const r of got?.roots ?? []) {
        try {
          const folder = fs.realpathSync(fileURLToPath(r.uri))
          if (fs.statSync(folder).isDirectory() && !inside(folder)) folders.add(folder)
        } catch {
          // Some clients report locations that aren't on this machine.
        }
      }
    }
    const folder = provided ?? (folders.has(cwd) || !folders.size ? cwd : folders.size === 1 ? [...folders][0]! : undefined)
    if (!folder || inside(folder) || folder === path.parse(folder).root || folder === path.resolve(os.homedir()) || !fs.statSync(folder).isDirectory()) {
      throw new Error("Pass the absolute path of the open project folder as the Flowbound tool's project argument.")
    }
    const existing = findRoot(folder)
    if (existing) return existing
    const { scaffold } = await import("./cli/init.ts")
    await scaffold(folder)
    return folder
  }
  const address = async (project?: unknown) => {
    root ??= await (selecting ??= select(project).finally(() => {
      selecting = undefined
    }))
    if (closed) throw new Error("The agent session ended.")
    if (typeof project === "string" && path.isAbsolute(project) && findRoot(fs.realpathSync(project)) !== root) {
      throw new Error("This agent session is using another Flowbound project. Start a new session in this folder.")
    }
    leave ??= join(root)
    return ensure(root, true)
  }
  const api = async (pathname: string, body?: unknown, project?: unknown) => {
    const res = await fetch(`${await address(project)}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-flowbound-via": "mcp" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return res
  }
  const behind: Behind = {
    about: async (project) => (await api("/api", undefined, project)).json(),
    call: async (tool, input, project) => {
      const out = await (await api(`/api/${encodeURIComponent(tool)}`, input, project)).json()
      if (!out.ok) throw new Error(out.error)
      return out.result
    },
  }
  const respond = async (msg: Rpc) => {
    const show = msg.method === "tools/call" && msg.params?.name === "show"
    if (msg.id === undefined || msg.method !== "tools/call") return answer(msg, behind, true)
    if (!remote) {
      if (!show) return answer(msg, behind, true)
      try {
        return await (await api("/mcp", msg, msg.params?.arguments?.project)).json()
      } catch (error) {
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(error) } }
      }
    }
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result })
    const session = (connected ??= import("./mcp/company.ts").then(({ signIn }) => signIn(remote, end.signal)))
    try {
      const client = await session
      const { project: _local, ...args } = msg.params?.arguments ?? {}
      return ok(await client.callTool({ ...msg.params, arguments: args }, { signal: end.signal, timeout: 600_000 }))
    } catch {
      if (connected === session) {
        connected = undefined
        void session.then((client) => client.close()).catch(() => {})
      }
      return ok(text(`Company Flowbound did not confirm this call. Check your work sign-in and the Flowbound page before repeating a run or change. Company: ${remote.origin}`, { isError: true }))
    }
  }
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.method === undefined) {
      waiting.get(msg.id)?.(msg.result)
      waiting.delete(msg.id)
      continue
    }
    if (msg.method === "initialize") canAskRoots = !!msg.params?.capabilities?.roots
    respond(msg).then((out) => {
      if (out && !closed) send(out)
    })
  }
  closed = true
  end.abort()
  for (const done of waiting.values()) done(undefined)
  leave?.()
  void connected?.then((client) => client.close()).catch(() => {})
}

export const mcp = (options: { timeoutMs?: number } = {}) => {
  let fb: Flowbound
  return plugin({
    name: "mcp",
    start(f) {
      fb = f
    },
    routes: {
      "POST /mcp": Object.assign(
        async (req: Request, at: { who: import("../core/plugin.ts").Who }) => {
          const msg = await req.json()
          const behind: Behind = {
            about: async () => about(fb) as About,
            call: (tool, input) => fb.call(tool, input, { ...at.who, via: "mcp" }),
            app:
              fb.has("pages") &&
              fb
                .use<Pages>("pages")
                .list()
                .some(({ path }) => path === "/runs")
                ? { url: fb.url, live: fb.live, role: at.who.role, tools: Object.keys(fb.tools).filter((name) => fb.tools[name]?.by !== "people") }
                : undefined,
          }
          const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => answer(m, behind)))).filter(Boolean) : await answer(msg, behind)
          return out && (!Array.isArray(out) || out.length) ? Response.json(out, { headers: CORS }) : new Response(null, { status: 202, headers: CORS })
        },
        { open: "token" as const },
      ),
      "OPTIONS /mcp": Object.assign(() => new Response(null, { status: 204, headers: CORS }), { open: "all" as const }),
      "GET /mcp": Object.assign(() => new Response("Flowbound's MCP server answers POST.", { status: 405, headers: { allow: "POST" } }), { open: "token" as const }),
    },
    tools: {
      docs: {
        about:
          "Read Flowbound's current guide, exactly as the docs command does. Start with topic start; topics lists parts; workflow-sdk explains workflows, ledger explains permissions, recipes gives examples. Without a topic, read the whole guide.",
        role: "viewer",
        input: { topic: { about: "start, topics, a plugin name, or a guide such as recipes" } },
        run: (input) => docs(fb.plugins, input.topic),
      },
      execute: {
        about:
          'Run JavaScript that calls Flowbound tools and returns what you need: `return (await flowbound.runs({})).filter((r) => r.state === "running")`. Each tool is `flowbound.<name>(input)`. It reaches only the tools, as you, with your rights. At most 10 minutes.',
        role: "viewer",
        input: { code: { about: "the body of an async function; return the answer", required: true } },
        run: async (i, who) => execute(String(i.code), (tool, input) => fb.call(tool, input, who), options),
        print: (r: { result: unknown; logs: string[] }) => [...r.logs, typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2)].join("\n"),
      },
    },
    commands: {
      mcp: { about: "the MCP server for agent apps (search, execute), over stdio", run: () => stdio() },
    },
    docs: `## MCP
\`flowbound mcp\` is the MCP server (stdio). It has two tools however many plugins are installed: \`search\` (find tools and read their inputs and prices) and \`execute\` (a few lines of JavaScript that call tools as \`flowbound.<name>(input)\` and return what you need; several at once with Promise.all). Each tool is also a command: \`npx flowbound <tool>\`, and \`npx flowbound execute "<code>"\` runs the same code.
A live Flowbound serves the same two at \`/mcp\` over HTTPS. Claude and ChatGPT take no token by hand: the person adds \`<address>/mcp\` as a custom connector, and the app sends them to this Flowbound to sign in with their work account and allow it. An agent that cannot sign in uses a token a signed-in person made: \`Authorization: Bearer fb_live_...\`. Either way it acts as that named person and can never do more than they can (passing on their yes, never managing keys or people). A chat app with no project folder can read, try, run and pass on a yes, not change workflow files.`,
  })
}
