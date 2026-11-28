#!/usr/bin/env node
// The `flowbound` command. Its own words are dev, plugins and docs; every other word comes from a plugin.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { company, connect } from "./connection.ts"
import { docs } from "./docs.ts"
import { check, findRoot, readList, table } from "./load.ts"
import { claim, ensure, hasClients, running, shareFile, stateFile, stuck, watcherFile } from "./local.ts"
import type { Command, CommandLine, Plugin } from "./plugin.ts"
import { boot, listen } from "./server.ts"

const self = fileURLToPath(import.meta.url)
const state = stateFile

async function serve(root: string, port: number) {
  let stop = async () => {}
  const server = await listen(port, async (bound) => {
    // FLOWBOUND_LIVE=1 is the shared, deployed way of running on a server of your own: the door plugin then guards it.
    const app = await boot(await readList(root), { root, live: process.env.FLOWBOUND_LIVE === "1", url: process.env.FLOWBOUND_URL || `http://localhost:${bound}`, local: `http://localhost:${bound}` })
    stop = app.stop
    return app.fetch
  }).catch(async (e) => {
    console.error(String(e?.message ?? e))
    process.exit(1)
  })
  const url = `http://localhost:${server.port}`
  fs.mkdirSync(path.dirname(state(root)), { recursive: true })
  fs.writeFileSync(state(root), JSON.stringify({ url, pid: process.pid }))
  console.log(`pages at ${url}`)
  if (process.env.FLOWBOUND_URL) console.log(`shared at ${process.env.FLOWBOUND_URL}`)
  if (process.env.FLOWBOUND_LIVE !== "1") console.log("runs and schedules on while this computer is on\nyes from your phone: npx flowbound deploy")
  const end = async () => {
    await Promise.race([stop(), new Promise((r) => setTimeout(r, 3000))])
    await server.close()
    process.exit(0)
  }
  process.on("SIGTERM", end).on("SIGINT", end)
}

/**
 * A ceiling on the server's own memory. On a roomy machine Node lets its heap grow to gigabytes before it tidies up: a run
 * of 10,000 rows held 3.5 GB. With a ceiling it tidies up sooner and runs as fast (measured: docs/scale.md).
 * FLOWBOUND_HEAP_MB changes it; a --max-old-space-size of your own in NODE_OPTIONS is left alone.
 */
const heap = () => (/max-old-space-size/.test(process.env.NODE_OPTIONS ?? "") ? [] : [`--max-old-space-size=${Math.floor(Number(process.env.FLOWBOUND_HEAP_MB)) || 768}`])

/**
 * The address the person shares this Flowbound at (FLOWBOUND_URL) and the port the share points to, kept in
 * .flowbound/share.json. A server the MCP server or an agent starts later without them still gives links that open on
 * the person's phone, and its pages still load under the shared path. FLOWBOUND_URL set to nothing, or to a localhost
 * address, forgets it. A Flowbound already running picks a new address up by restarting.
 */
function share(root: string, args: string[]) {
  const given = process.env.FLOWBOUND_URL
  if (given === undefined) return
  const file = shareFile(root)
  const url = given.trim().replace(/\/+$/, "")
  let local = !url
  try {
    local ||= ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
  } catch {
    local = true
  }
  if (local) return fs.rmSync(file, { force: true })
  const at = args.indexOf("--port")
  const port = Number(at >= 0 ? args[at + 1] : process.env.FLOWBOUND_PORT) || undefined
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ url, port }))
}
const kept = (root: string): { url?: string; port?: number } => {
  try {
    const s = JSON.parse(fs.readFileSync(shareFile(root), "utf8"))
    return { url: typeof s.url === "string" && s.url ? s.url : undefined, port: Number(s.port) || undefined }
  } catch {
    return {}
  }
}

/** `flowbound dev`: one child serves; a change to the list, a plugin, a workflow or the shared address restarts it. */
async function dev(root: string, args: string[]) {
  const live = process.env.FLOWBOUND_LIVE === "1"
  if (!process.env.FLOWBOUND_CHILD && !live) share(root, args)
  const at = args.indexOf("--port")
  const port = Number(at >= 0 ? args[at + 1] : (process.env.FLOWBOUND_PORT ?? (live ? undefined : kept(root).port) ?? 4111))
  if (process.env.FLOWBOUND_CHILD) return serve(root, port)
  if (await running(root)) {
    const shared = live ? undefined : kept(root).url
    return console.log(`Already running: pages at ${JSON.parse(fs.readFileSync(state(root), "utf8")).url}${shared ? `\nshared at ${shared}` : ""}`)
  }
  if (stuck(root)) return console.log(`Already running, but stopped on a problem:\n${stuck(root)}`)
  const release = claim(watcherFile(root))
  if (!release) return console.log("Already running: another `flowbound dev` is starting it.")
  process.once("exit", release)
  const free = await listen(port, async () => async () => new Response())
  await free.close()
  let child: ReturnType<typeof spawn> | undefined
  let closing = false
  let restarting = false
  fs.rmSync(state(root), { force: true })
  const start = () => {
    if (closing) return
    // On your own computer the address comes from the share file, read again at every start: a later `flowbound dev`
    // with another FLOWBOUND_URL changes it for this one too.
    const env = { ...process.env, FLOWBOUND_CHILD: "1", FLOWBOUND_PORT: String(free.port), ...(live ? {} : { FLOWBOUND_URL: kept(root).url ?? "" }) }
    child = spawn(process.execPath, [...heap(), self, "dev"], { cwd: root, stdio: "inherit", env })
    child.on("exit", (code, signal) => {
      if (closing || restarting) return
      // Killed from outside (the computer slept, something pulled the plug): bring it straight back.
      if (signal) return void setTimeout(start, 300)
      if (!code) return
      console.log("Stopped on a problem. Fix the file and it starts again.")
      fs.writeFileSync(state(root), JSON.stringify({ pid: process.pid, problem: "It stopped on a problem." }))
    })
  }
  let timer: NodeJS.Timeout | undefined
  const restart = (what: string) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      console.log(`${what} changed: restarting`)
      fs.rmSync(state(root), { force: true })
      const old = child
      if (!old || old.exitCode !== null || old.signalCode) return start()
      restarting = true
      old.once("exit", () => ((restarting = false), start()))
      old.kill("SIGTERM")
    }, 200)
  }
  // Look at the files themselves twice a second. File-change notices from the system miss edits that replace a
  // file, which is how most editors and agents save, and a missed edit would leave an old workflow running.
  const seen = () => {
    const out = new Map<string, string>()
    for (const name of ["flowbound.config.ts", "plugins", "workflows", path.join(".flowbound", "share.json")]) {
      const target = path.join(root, name)
      if (!fs.existsSync(target)) continue
      const files = fs.statSync(target).isDirectory() ? (fs.readdirSync(target, { recursive: true }) as string[]).map((f) => path.join(name, f)) : [name]
      for (const f of files) {
        const s = fs.statSync(path.join(root, f), { throwIfNoEntry: false })
        if (s?.isFile()) out.set(f, `${s.mtimeMs}:${s.size}`)
      }
    }
    return out
  }
  let before = seen()
  setInterval(() => {
    const now = seen()
    const changed = [...new Set([...now.keys(), ...before.keys()])].find((f) => now.get(f) !== before.get(f))
    before = now
    if (changed) restart(changed)
  }, 500)
  const close = () => {
    if (closing) return
    closing = true
    clearTimeout(timer)
    child?.once("exit", () => process.exit(0))
    child?.kill("SIGTERM") || process.exit(0)
  }
  process.on("SIGTERM", close).on("SIGINT", close)
  if (args.includes("--mcp-session")) {
    let idleSince: number | undefined
    setInterval(() => {
      if (hasClients(root)) idleSince = undefined
      else if (Date.now() - (idleSince ??= Date.now()) >= 3000) close()
    }, 500)
  }
  start()
}

async function main() {
  const [word = "help", ...args] = process.argv.slice(2)
  if (word === "connect") return connect(args)
  if (word === "mcp") {
    const address = company()
    if (address) return (await import("../plugins/mcp.ts")).stdio(address)
  }
  const root = findRoot()
  const list: Plugin[] = root ? await readList(root) : (await import("../index.ts")).starter()
  const commands: Record<string, Command> = Object.assign({}, ...list.map((p) => (typeof p.commands === "function" ? p.commands(list) : (p.commands ?? {}))))
  const fb: CommandLine = {
    root: root ?? process.cwd(),
    plugins: list,
    call: async (tool, input = {}, opts = {}) => {
      if (!root) throw new Error("No Flowbound project here. Run: npx flowbound init")
      const res = await fetch(`${await ensure(root)}/api/${tool}${opts.live ? "?live=1" : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-flowbound-via": "cli" },
        body: JSON.stringify(input),
      })
      const out = await res.json().catch(() => ({ ok: false, error: `The server answered ${res.status}.` }))
      if (!out.ok) throw Object.assign(new Error(out.error), { more: out })
      return out.result
    },
  }
  if (word === "dev" && root) return dev(root, args)
  if (word === "plugins") {
    console.log(table(list))
    return void (check(list).problems.length && process.exit(1))
  }
  if (word === "docs") return console.log(docs(list, args[0]))
  const command = commands[word]
  if (command) return command.run(args, fb)
  const words = [
    ["dev", "start Flowbound on this computer (database, runs, pages)"],
    ["connect", "choose Run here or connect the agent plugin to your company"],
    ["plugins", "list the plugins and check the list"],
    ["docs", "everything an agent needs to know, for this version"],
    ...Object.entries(commands).map(([name, c]) => [c.usage ?? name, c.about]),
  ]
  const w = Math.max(...words.map((x) => x[0]!.length)) + 2
  console.log(`${root ? "" : "No Flowbound project in this folder. Start one with: npx flowbound init\n\n"}flowbound <command>\n\n${words.map(([a, b]) => `  ${a!.padEnd(w)}${b}`).join("\n")}`)
  if (word !== "help" && word !== "--help" && word !== "-h") process.exit(1)
}

main().catch((e) => {
  console.error(String(e?.message ?? e))
  process.exit(1)
})
