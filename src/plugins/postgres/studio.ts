// "One step deeper" than the Data page: Drizzle Studio on your own computer, Neon's console when live.
// Studio is Drizzle's, not ours: it is started beside Flowbound against the database Flowbound already uses, with no
// schema file (it reads the tables as they are). See docs/decisions.md, "Data".
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Engine } from "../postgres.ts"

/** What Studio needs, by version, tried together on 26 Nov 2026. `pglite-socket` lets a Postgres tool reach the database in your project folder. */
const KIT = { "drizzle-kit": "0.31.11", "drizzle-orm": "0.45.4", pg: "8.23.1", "@electric-sql/pglite-socket": "0.3.0" }
/** Beside the keys, one folder for every project on this computer. FLOWBOUND_STUDIO_KIT names another (a folder that already has them). */
const kitDir = () =>
  process.env.FLOWBOUND_STUDIO_KIT ??
  path.join(
    process.env.FLOWBOUND_HOME ?? path.join(os.homedir(), ".flowbound"),
    `studio-kit-${Object.values(KIT)
      .join("-")
      .replace(/[^\w.-]/g, "")}`,
  )
const has = (dir: string, name: string) => fs.existsSync(path.join(dir, "node_modules", name, "package.json"))

/**
 * The folder Studio's own packages are in: the project's, when it has them; else a folder beside your keys, filled
 * once (about half a minute) with the versions above. Nothing is added to the project.
 */
export async function kit(root: string, needsBridge: boolean): Promise<string> {
  const wanted = Object.keys(KIT).filter((n) => needsBridge || n !== "@electric-sql/pglite-socket")
  if (wanted.every((n) => has(root, n))) return root
  const dir = kitDir()
  if (Object.keys(KIT).every((n) => has(dir, n))) return dir
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "flowbound-studio-kit", private: true, type: "module", dependencies: KIT }))
  const done = await new Promise<{ code: number | null; err: string }>((ok) => {
    const child = spawn("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" })
    let err = ""
    child.stderr.on("data", (d) => (err += d))
    child.on("error", (e) => ok({ code: 1, err: e.message }))
    child.on("close", (code) => ok({ code, err }))
  })
  if (done.code !== 0 || !Object.keys(KIT).every((n) => has(dir, n))) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(
      `Drizzle Studio could not be fetched (npm install): ${done.err.trim().split("\n").pop() ?? "no reason given"}. With no network it can be added to the project instead: npm install -D ${wanted.map((n) => `${n}@${KIT[n as keyof typeof KIT]}`).join(" ")}`,
    )
  }
  return dir
}

const free = (from: number, tries = 20): Promise<number> =>
  new Promise((ok, no) => {
    const server = net.createServer()
    server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && tries > 0 && from ? ok(free(from + 1, tries - 1)) : no(e)))
    server.listen(from, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => ok(port))
    })
  })

export type Studio = { port: number; stop: () => Promise<void> }
/**
 * Start Drizzle Studio on this computer, listening on this computer only. A Postgres is opened at its address. The
 * database in the project folder is held by Flowbound alone, so Studio reaches it through Flowbound: a small Postgres
 * door on this computer only (pglite-socket), in front of the same open database.
 */
export async function startStudio(o: { root: string; engine: Engine; port?: number }): Promise<Studio> {
  const dir = await kit(o.root, o.engine.kind === "pglite")
  let url: string
  let bridge: { stop: () => Promise<void> } | undefined
  if (o.engine.kind === "postgres") url = o.engine.url
  else {
    const { PGLiteSocketServer } = await import(pathToFileURL(createRequire(path.join(dir, "noop.js")).resolve("@electric-sql/pglite-socket")).href)
    const port = await free(0)
    bridge = new PGLiteSocketServer({ db: o.engine.db, port, host: "127.0.0.1", maxConnections: 10 })
    await (bridge as unknown as { start: () => Promise<void> }).start()
    url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`
  }
  // Studio reads its settings from a file. The address stays out of it: it is handed over in the surroundings of the one command.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flowbound-studio-"))
  fs.writeFileSync(path.join(work, "drizzle.config.ts"), `export default { dialect: "postgresql", dbCredentials: { url: process.env.FLOWBOUND_STUDIO_DATABASE! } }\n`)
  // Studio looks for its own packages from the folder it runs in.
  fs.symlinkSync(path.join(dir, "node_modules"), path.join(work, "node_modules"), "junction")
  const port = await free(o.port ?? 4983, o.port ? 0 : 20)
  const bin = path.join(dir, "node_modules", "drizzle-kit", "bin.cjs")
  let child: ChildProcess | undefined
  const stop = async () => {
    child?.kill()
    await bridge?.stop().catch(() => {})
    fs.rmSync(work, { recursive: true, force: true })
  }
  try {
    await new Promise<void>((ok, no) => {
      // It ends with Flowbound, also when Flowbound is killed without a goodbye: the line between them goes quiet.
      child = spawn(process.execPath, ["--import", 'data:text/javascript,process.once("disconnect",()=>process.exit())', bin, "studio", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: work,
        env: { ...process.env, FLOWBOUND_STUDIO_DATABASE: url },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
      let said = ""
      const timer = setTimeout(() => no(new Error(`Drizzle Studio did not start in 40 seconds: ${said.trim().split("\n").pop() ?? ""}`)), 40_000)
      const hear = (d: Buffer) => {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the colour codes a terminal program prints
        said += String(d).replace(/\x1b\[[0-9;]*m/g, "")
        if (/Drizzle Studio is up and running|local\.drizzle\.studio/.test(said)) clearTimeout(timer), ok()
      }
      child.stdout!.on("data", hear)
      child.stderr!.on("data", hear)
      child.once("error", (e) => (clearTimeout(timer), no(e)))
      child.once("exit", (code) => (clearTimeout(timer), no(new Error(`Drizzle Studio stopped (${code}): ${said.trim().split("\n").pop() ?? ""}`))))
    })
  } catch (e) {
    await stop()
    throw e
  }
  return { port, stop }
}

/** Is `npm` here at all? Without it Studio cannot be fetched, and the button says so instead of failing late. */
let npmHere: boolean | undefined
export const canFetch = () => (npmHere ??= spawnSync("npm", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0)

/**
 * Where a live database is looked at more closely: Neon's console, for the project the host names (the Vercel
 * integration `flowbound deploy` uses sets NEON_PROJECT_ID), else Neon's list of projects when the address is
 * Neon's; nothing for a Postgres of your own, which any Postgres tool opens at its address.
 */
export function consoleOf(env: NodeJS.ProcessEnv = process.env): { label: string; href: string; where: string } | undefined {
  const host = (() => {
    try {
      return new URL(env.DATABASE_URL ?? "").hostname
    } catch {
      return ""
    }
  })()
  if (env.NEON_PROJECT_ID)
    return {
      label: "Open in Neon",
      href: `https://console.neon.tech/app/projects/${encodeURIComponent(env.NEON_PROJECT_ID)}`,
      where: "this database's project in Neon's own console: every table, its SQL editor, branches and backups",
    }
  if (/\.neon\.tech$/.test(host)) return { label: "Open in Neon", href: "https://console.neon.tech/app/projects", where: "Neon's own console, at your list of projects (this Flowbound was not told which one is its own)" }
  return undefined
}
