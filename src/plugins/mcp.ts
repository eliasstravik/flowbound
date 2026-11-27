// The MCP door: two tools however many plugins are installed. search finds a tool and its inputs; execute runs a few
// lines of JavaScript that call tools (several at once, keeping only what is needed). The approach of Cloudflare's
// code mode and Executor. Over stdio on your own computer (`flowbound mcp`); over HTTPS when live (/mcp).
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
import { execute } from "./mcp/execute.ts"

type About = { url: string; live: boolean; tools: { name: string; about: string; input: Record<string, { type?: string; about: string; required?: boolean }>; price?: string; docs?: string }[] }
/** What the MCP door needs from the Flowbound behind it. The same two calls locally (over HTTP) and live (in process). */
type Behind = { about: () => Promise<About>; call: (tool: string, input: unknown) => Promise<unknown> }
type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }

const version = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version as string
  } catch {
    return "0"
  }
}
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
// Chat apps that run in a browser call from another origin. The token is the only way in, so any origin may ask.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "POST, OPTIONS" }
const text = (s: string, more = {}) => ({ content: [{ type: "text", text: s }], ...more })

const TOOLS = [
  {
    name: "search",
    title: "Find Flowbound tools",
    annotations: { readOnlyHint: true },
    description:
      "Find Flowbound tools and read their inputs and prices. Leave query empty to list every tool. Search docs for the current guide, available without a shell. Flowbound runs GTM workflows (list building, research, enrichment) and keeps every paid fact, on the person's own data provider keys, under their permissions.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "words to look for, like: run, table, import, lookup, firecrawl" } } },
  },
  {
    name: "execute",
    title: "Run code against Flowbound",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      'Run JavaScript that calls Flowbound tools and returns what you need. Each tool is an async function: `return await flowbound.runs({ state: "running" })`, `await flowbound["schedule-run"]({ name })`. Call several with Promise.all, filter big answers before returning them, console.log to see steps. It reaches only the tools, as you, with your rights: no files, no network, no keys. Find tools and their inputs with search first.',
    inputSchema: { type: "object", properties: { code: { type: "string", description: "the body of an async function; return the answer" } }, required: ["code"] },
  },
]

export async function answer(msg: Rpc, behind: Behind): Promise<object | undefined> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result })
  if (msg.id === undefined) return undefined
  try {
    if (msg.method === "initialize")
      return ok({
        protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "flowbound", version: version() },
        instructions:
          'Flowbound: GTM workflows and kept facts on the person\'s own data provider keys, under their permissions. Use search to find tools, execute to call them in a few lines of JavaScript. First read the current guide: execute `return await flowbound.docs({ topic: "start" })`. Read a part with topic "workflow-sdk", "ledger", or "recipes"; topic "topics" lists them. No shell needed. Workflows are TypeScript files in the project Git repo. To edit from chat, read the guide topic "changes", read the file with workflow-file, and use workflow-save to save a branch. Use workflow-change for checks and preview. Publish only when the person asks you to publish this change. GitHub rules still apply. People see everything on Flowbound\'s page: give them its links.',
      })
    if (msg.method === "ping") return ok({})
    if (msg.method === "tools/list") return ok({ tools: TOOLS })
    if (msg.method === "resources/list") return ok({ resources: [] })
    if (msg.method === "resources/templates/list") return ok({ resourceTemplates: [] })
    if (msg.method !== "tools/call") return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Flowbound's MCP server has no ${msg.method}.` } }
    const { name, arguments: args = {} } = msg.params ?? {}
    if (name === "search") {
      const info = await behind.about()
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
      const out = (await behind.call("execute", { code: String(args.code ?? "") })) as { result: unknown; logs: string[] }
      const shown = typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2)
      return ok(text(`${out.logs.length ? `${out.logs.join("\n")}\n---\n` : ""}${shown}`, { structuredContent: { result: out.result, logs: out.logs } }))
    }
    return ok(text(`Flowbound has two MCP tools: search and execute. There is no "${name}".`, { isError: true }))
  } catch (e: any) {
    return ok(text(String(e?.message ?? e), { isError: true }))
  }
}

/** `flowbound mcp`: speak MCP on stdin and stdout, and pass every call to this folder's running Flowbound. */
async function stdio() {
  let root: string | undefined
  let selecting: Promise<string> | undefined
  let leave: (() => void) | undefined
  let closed = false
  let asked = 0
  const waiting = new Map<number, (result: any) => void>()
  const send = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`)
  let canAskRoots = false
  const select = async () => {
    const cwd = fs.realpathSync(process.cwd())
    const here = findRoot(cwd)
    if (here) return here
    const folders = new Set<string>()
    if (canAskRoots) {
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
          if (fs.statSync(folder).isDirectory()) folders.add(folder)
        } catch {
          // Some clients report locations that aren't on this machine.
        }
      }
    }
    const folder = folders.has(cwd) || !folders.size ? cwd : folders.size === 1 ? [...folders][0]! : undefined
    if (!folder || folder === path.parse(folder).root || folder === fs.realpathSync(os.homedir())) {
      throw new Error("Open one project folder in your agent app, then try Flowbound again.")
    }
    const existing = findRoot(folder)
    if (existing) return existing
    const { scaffold } = await import("./cli/init.ts")
    await scaffold(folder)
    return folder
  }
  const address = async () => {
    root ??= await (selecting ??= select().finally(() => {
      selecting = undefined
    }))
    if (closed) throw new Error("The agent session ended.")
    leave ??= join(root)
    return ensure(root, true)
  }
  const api = async (pathname: string, body?: unknown) => {
    const res = await fetch(`${await address()}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-flowbound-via": "mcp" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return res
  }
  const behind: Behind = {
    about: async () => (await api("/api")).json(),
    call: async (tool, input) => {
      const out = await (await api(`/api/${encodeURIComponent(tool)}`, input)).json()
      if (!out.ok) throw new Error(out.error)
      return out.result
    },
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
    answer(msg, behind).then((out) => {
      if (out && !closed) send(out)
    })
  }
  closed = true
  for (const done of waiting.values()) done(undefined)
  leave?.()
}

export const mcp = () => {
  let fb: Flowbound
  return plugin({
    name: "mcp",
    start(f) {
      fb = f
    },
    routes: {
      "POST /mcp": Object.assign(
        async (req: Request, at: { who: any }) => {
          const msg = await req.json()
          const behind: Behind = {
            about: async () => about(fb) as About,
            call: (tool, input) => fb.call(tool, input, { ...at.who, via: "mcp" }),
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
        run: async (i, who) => execute(String(i.code), (tool, input) => fb.call(tool, input, who)),
        print: (r: { result: unknown; logs: string[] }) => [...r.logs, typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2)].join("\n"),
      },
    },
    commands: {
      mcp: { about: "the MCP server for agent apps (search, execute), over stdio", run: stdio },
    },
    docs: `## MCP
\`flowbound mcp\` is the MCP server (stdio). It has two tools however many plugins are installed: \`search\` (find tools and read their inputs and prices) and \`execute\` (a few lines of JavaScript that call tools as \`flowbound.<name>(input)\` and return what you need; several at once with Promise.all). Each tool is also a command: \`npx flowbound <tool>\`, and \`npx flowbound execute "<code>"\` runs the same code.
A live Flowbound serves the same two at \`/mcp\` over HTTPS. Claude and ChatGPT take no token by hand: the person adds \`<address>/mcp\` as a custom connector, and the app sends them to this Flowbound to sign in with their work account and allow it. An agent that cannot sign in uses a token a signed-in person made: \`Authorization: Bearer fb_live_...\`. Either way it acts as that named person and can never do more than they can (passing on their yes, never managing keys or people). A chat app with no project folder can read, try, run and pass on a yes, not change workflow files.`,
  })
}
