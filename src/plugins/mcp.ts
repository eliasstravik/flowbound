// The MCP door: search finds work and execute does it and returns views.
// Over stdio on your own computer (`flowbound mcp`); over HTTPS when live (/mcp).
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { docs } from "../core/docs.ts"
import { findRoot } from "../core/load.ts"
import { ensure, join } from "../core/local.ts"
import { type Flowbound, plugin, type Who } from "../core/plugin.ts"
import { about } from "../core/server.ts"
import catalog from "./mcp/catalog.json" with { type: "json" }
import { execute } from "./mcp/execute.ts"
import { appPages, type Pages, renderApp } from "./pages.ts"

type About = { url: string; live: boolean; tools: { name: string; about: string; input: Record<string, { type?: string; about: string; required?: boolean }>; price?: string; docs?: string }[] }
/** What the MCP door needs from the Flowbound behind it. The same two calls locally (over HTTP) and live (in process). */
type Behind = {
  about: (project?: unknown) => Promise<About>
  call: (tool: string, input: unknown, project?: unknown) => Promise<unknown>
  app?: { url: string; live: boolean; role?: string; tools: string[]; paths: string[] }
  logAppStatus?: boolean
}
type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }

const viewUri = "ui://flowbound/app-v4.html"
const resource = { uri: viewUri, name: "Flowbound", mimeType: "text/html;profile=mcp-app" }
const ui = { resourceUri: viewUri, visibility: ["model", "app"] }
const uiExtension = "io.modelcontextprotocol/ui"
const sessionHeader = "Mcp-Session-Id"
const appSession = () => `flowbound-app-${randomUUID()}`
const isAppSession = (value: string | null) => /^flowbound-app-[0-9a-f-]{36}$/.test(value ?? "")
type Selection = { run?: unknown; table?: unknown; workflow?: unknown; page?: unknown }
type AppContext = NonNullable<Behind["app"]>
const object = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)

function supportsApp(params: Rpc["params"]) {
  const types = params?.capabilities?.extensions?.[uiExtension]?.mimeTypes
  return Array.isArray(types) && types.includes(resource.mimeType)
}

function selectView(value: unknown, app: AppContext) {
  const result = object(value)
  if (!result) return
  let selected: Selection | undefined = object(result.flowboundView)
  if (!selected && typeof result.run === "number" && result.page === `${app.url}/runs?run=${result.run}`) selected = { run: result.run }
  if (!selected && typeof result.id === "string" && result.page === `${app.url}/workflows?workflow=${result.id}`) selected = { workflow: result.id }
  if (!selected && typeof result.name === "string" && Array.isArray(result.columns) && Array.isArray(result.rows) && typeof result.total === "number") selected = { table: result.name }
  if (!selected) return

  const { run, table, workflow, page } = selected
  if (run !== undefined && (typeof run !== "number" || !Number.isSafeInteger(run) || run <= 0)) return
  if ([table, workflow].some((id) => id !== undefined && (typeof id !== "string" || !id.trim() || id.length > 200))) return
  if (page !== undefined && typeof page !== "string") return
  const items = [
    ["run", run, "/runs"],
    ["table", table, "/tables"],
    ["workflow", workflow, "/workflows"],
  ].filter(([, id]) => id !== undefined)
  if (items.length > 1) return
  const item = items[0]
  if (item && page !== undefined && `/${page}` !== item[2]) return
  const path = item?.[2] ?? (page === undefined ? app.paths[0] : `/${page}`)
  if (typeof path !== "string" || !app.paths.includes(path)) return
  const params = item ? { [String(item[0])]: String(item[1]) } : {}
  const query = new URLSearchParams(params).toString()
  return {
    view: { path, params, url: app.url, live: app.live, paths: app.paths },
    link: app.url + path + (query ? `?${query}` : ""),
  }
}

const version = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version as string
  } catch {
    return "0"
  }
}
// Chat apps that run in a browser call from another origin. The token is the only way in, so any origin may ask.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-expose-headers": sessionHeader,
  "cache-control": "no-store",
}
const text = (s: string, more = {}) => ({ content: [{ type: "text", text: s }], ...more })

export async function answer(msg: Rpc, behind: Behind, showApp = false): Promise<object | undefined> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result })
  if (msg.id === undefined) return undefined
  try {
    if (msg.method === "initialize")
      return ok({
        protocolVersion: catalog.versions.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : catalog.versions[0],
        capabilities: { tools: {}, ...(showApp ? { resources: {}, extensions: { [uiExtension]: {} } } : {}) },
        serverInfo: { name: "flowbound", version: version() },
        instructions: catalog.instructions,
      })
    if (msg.method === "ping") return ok({})
    if (msg.method === "tools/list") {
      const meta = behind.app?.live ? { ui, "openai/ui": { entrypoints: [{ type: "global" }] } } : { ui }
      return ok({ tools: catalog.tools.map((tool) => (showApp && tool.name === "execute" ? { ...tool, _meta: meta } : tool)) })
    }
    if (msg.method === "resources/list") return ok({ resources: showApp ? [resource] : [] })
    if (msg.method === "resources/read") {
      const uri = msg.params?.uri
      if ((uri !== viewUri && uri !== "ui://flowbound/app-v3.html") || (!showApp && !behind.app)) return { jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Flowbound has no such resource." } }
      return ok({ contents: [{ uri, mimeType: resource.mimeType, text: renderApp(), _meta: { ui: { csp: {} } } }] })
    }
    if (msg.method === "resources/templates/list") return ok({ resourceTemplates: [] })
    if (msg.method !== "tools/call") return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Flowbound's MCP server has no ${msg.method}.` } }
    const { name, arguments: args = {} } = msg.params ?? {}
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
          `${hits.length ? "" : `Nothing matched "${args.query}". Every tool:\n`}${lines.join("\n")}\n\nCall them with execute: const r = await flowbound.<tool>({ ... }); return r. Tools with a dash: flowbound["schedule-run"]({ ... }). To show a run, return it directly once from execute. Its chat view updates live. If you need the outcome in text, wait inside the same execute call with flowbound.wait({ run, seconds: 30 }). The person's page: ${info.url}/needs`,
        ),
      )
    }
    if (name === "execute") {
      const report = msg.params?._meta?.["flowbound/view-status"]
      if (args.render === false && args.code === "return null" && (report?.status === "loaded" || report?.status === "error")) {
        if (behind.logAppStatus) {
          const platform = ["web", "desktop", "mobile"].includes(report.platform) ? report.platform : "unknown"
          console.info("Flowbound MCP app", JSON.stringify({ status: report.status, platform }))
        }
        return ok(text("null", { structuredContent: { result: null, logs: [] } }))
      }
      const app = args.render === false ? undefined : behind.app
      const out = app && args.code === undefined ? { result: { flowboundView: {} }, logs: [] } : ((await behind.call("execute", { code: String(args.code ?? "") }, args.project)) as { result: unknown; logs: string[] })
      const presentation = app && selectView(out.result, app)
      const embedded = showApp ? presentation : undefined
      let result = out.result
      const record = object(result)
      const run = embedded?.view.params.run
      const liveRun = run !== undefined && record?.state !== "done" && record?.state !== "stopped"
      if (liveRun && record?.run === Number(run)) {
        // The card reads its own status. Give the model stable context and keep any question that needs a person's answer.
        const { title, asks } = record
        result = { run: Number(run), ...(typeof title === "string" ? { title } : {}), ...(asks ? { asks } : {}), view: "live" }
      } else if (embedded && record && record.page === embedded.link) {
        const { page: _page, ...rest } = record
        result = rest
      }
      const shown = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      const link = liveRun
        ? "\n\nThe Flowbound run view in chat is live and will show the outcome or when it needs the person's input. Say this briefly. Ask any approval question returned here. Skip progress counts, follow-up polling, and another view for this run. The Open web page button has the link."
        : embedded
          ? "\n\nThe person is seeing this result in the Flowbound app in chat. Summarize it in one or two lines. Leave the page link to the app’s Open web page button."
          : presentation
            ? `\n\nOpen Flowbound: ${presentation.link}`
            : ""
      return ok(
        text(`${out.logs.length ? `${out.logs.join("\n")}\n---\n` : ""}${shown}${link}`, {
          structuredContent: { result, logs: out.logs, ...(presentation && !embedded ? { link: presentation.link } : {}) },
          ...(embedded && app ? { _meta: { flowbound: { view: embedded.view, role: app.role, tools: app.tools, report: behind.logAppStatus, ...(run ? { instance: `${Date.now()}-${randomUUID()}` } : {}) } } } : {}),
        }),
      )
    }
    return ok(text(`Flowbound has two MCP tools: search and execute. There is no "${name}".`, { isError: true }))
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
  let session: string | undefined
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
      headers: { "content-type": "application/json", "x-flowbound-via": "mcp", ...(pathname === "/mcp" && session ? { [sessionHeader]: session } : {}) },
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
    const executeWithView = msg.method === "tools/call" && msg.params?.name === "execute" && msg.params?.arguments?.render !== false
    if (msg.id === undefined || msg.method !== "tools/call") return answer(msg, behind, !!session)
    if (!remote) {
      if (!executeWithView) return answer(msg, behind, !!session)
      try {
        return await (await api("/mcp", msg, msg.params?.arguments?.project)).json()
      } catch (error) {
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(error) } }
      }
    }
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result })
    const appCapabilities = session ? { extensions: { [uiExtension]: { mimeTypes: [resource.mimeType] } } } : undefined
    const connection = (connected ??= import("./mcp/company.ts").then(({ signIn }) => signIn(remote, end.signal, undefined, appCapabilities)))
    try {
      const client = await connection
      const { project: _local, ...args } = msg.params?.arguments ?? {}
      return ok(await client.callTool({ ...msg.params, arguments: args }, { signal: end.signal, timeout: 600_000 }))
    } catch {
      if (connected === connection) {
        connected = undefined
        void connection.then((client) => client.close()).catch(() => {})
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
    if (msg.method === "initialize") {
      canAskRoots = !!msg.params?.capabilities?.roots
      session = supportsApp(msg.params) ? appSession() : undefined
    }
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

export const mcp = (options: { timeoutMs?: number; logAppStatus?: boolean } = {}) => {
  let fb: Flowbound
  return plugin({
    name: "mcp",
    start(f) {
      fb = f
    },
    routes: {
      "POST /mcp": Object.assign(
        async (req: Request, at: { who: Who }) => {
          const msg = await req.json()
          const pages = new Set(
            fb.has("pages")
              ? fb
                  .use<Pages>("pages")
                  .list()
                  .map(({ path }) => path)
              : [],
          )
          const paths = [...appPages.keys()].filter((path) => pages.has(path))
          const behind: Behind = {
            about: async () => about(fb) as About,
            call: (tool, input) => fb.call(tool, input, { ...at.who, via: "mcp" }),
            app: paths.length ? { url: fb.url, live: fb.live, role: at.who.role ?? "owner", paths, tools: Object.keys(fb.tools).filter((name) => fb.tools[name]?.by !== "people") } : undefined,
            logAppStatus: options.logAppStatus,
          }
          const initializing = msg?.method === "initialize" && msg.id !== undefined
          const session = initializing ? (behind.app && supportsApp(msg.params) ? appSession() : null) : req.headers.get(sessionHeader)
          // The ID carries only the app preference across serverless requests. The door still checks every request.
          const showApp = !!behind.app && isAppSession(session)
          const headers = new Headers(CORS)
          if (initializing && session) headers.set(sessionHeader, session)
          if (initializing && options.logAppStatus) {
            const identify = (value: unknown) => (typeof value === "string" && /^[\w ./:+-]{1,64}$/.test(value) ? value : undefined)
            console.info(
              "Flowbound MCP initialize",
              JSON.stringify({
                client: identify(msg.params?.clientInfo?.name),
                protocol: identify(msg.params?.protocolVersion),
                appExtension: object(msg.params?.capabilities?.extensions?.[uiExtension]) !== undefined,
                appHtml: supportsApp(msg.params),
              }),
            )
          }
          const respond = (message: Rpc) => answer(message, behind, showApp)
          const out = Array.isArray(msg) ? (await Promise.all(msg.map(respond))).filter(Boolean) : await respond(msg)
          return out && (!Array.isArray(out) || out.length) ? Response.json(out, { headers }) : new Response(null, { status: 202, headers })
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
          'Run JavaScript that calls Flowbound tools and returns what you need: `return (await flowbound.runs({})).filter((r) => r.state === "running")`. Each tool is `flowbound.<name>(input)`. Use `flowbound.wait({ run, seconds: 30 })` to wait for a running workflow within this call. It reaches only the tools, as you, with your rights. At most 10 minutes.',
        role: "viewer",
        input: { code: { about: "the body of an async function; return the answer", required: true } },
        run: async (i, who) => execute(String(i.code), (tool, input) => fb.call(tool, input, who), options),
        print: (r: { result: unknown; logs: string[] }) => [...r.logs, typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2)].join("\n"),
      },
    },
    commands: {
      mcp: { about: "the MCP server for agent apps, over stdio", run: () => stdio() },
    },
    docs: `## MCP
Search finds work tools and execute calls them as \`flowbound.<name>(input)\`. Return a run, table or workflow directly from execute. A run view updates live. Say the view will show the outcome and pass along any question for the person. One view per run is enough. For a text result, \`return await flowbound.wait({ run, seconds: 30 })\` returns the latest run when it leaves "running" or the wait ends (up to 30 seconds, less if execute has less time). Give the person the returned page link in text-only chats. Leave the link to the Open web page button when the chat app shows. For an explicit view, return \`{ flowboundView: { page: "needs" } }\`. Set \`render: false\` on the MCP call for background work.
The server speaks stdio over \`flowbound mcp\` and HTTPS at \`/mcp\`. Add the HTTPS address as a custom connector and sign in once. The embedded app reuses the connection. An agent that cannot sign in uses a token a signed-in person made. Both act with the person's permissions. Pass on their yes only after they give it. Key and people management stays on the signed-in website.`,
  })
}
