// On your own computer: find this project's running Flowbound, or start it in the background.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), `start${path.extname(fileURLToPath(import.meta.url))}`)
export const stateFile = (root: string) => path.join(root, ".flowbound", "server.json")
/** The address the person shares this Flowbound at, and its port: kept so every later start uses them too. */
export const shareFile = (root: string) => path.join(root, ".flowbound", "share.json")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function running(root: string): Promise<string | undefined> {
  try {
    const { url } = JSON.parse(fs.readFileSync(stateFile(root), "utf8"))
    const about = await (await fetch(`${url}/api`, { signal: AbortSignal.timeout(2000) })).json()
    return about.flowbound && about.root === root ? url : undefined
  } catch {
    return undefined
  }
}

/** The `flowbound dev` that watches over this project's server, if one is alive. Only one may be. */
export const watcherFile = (root: string) => path.join(root, ".flowbound", "dev.pid")
function owner(file: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(file, "utf8"))
    return pid && alive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}
export const watcher = (root: string) => owner(watcherFile(root))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Publish the PID in one operation, so concurrent starts never see a partially written claim. */
export function claim(file: string): (() => void) | undefined {
  const candidate = `${file}.${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(candidate, String(process.pid))
  try {
    if (owner(file)) return undefined
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
    try {
      fs.linkSync(candidate, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined
      throw error
    }
    return () => {
      if (owner(file) === process.pid) fs.rmSync(file, { force: true })
    }
  } finally {
    fs.rmSync(candidate, { force: true })
  }
}

const clients = (root: string) => path.join(root, ".flowbound", "mcp-clients")
export function join(root: string): () => void {
  const folder = clients(root)
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, String(process.pid))
  fs.writeFileSync(file, "")
  return () => fs.rmSync(file, { force: true })
}

export function hasClients(root: string): boolean {
  let active = false
  const folder = clients(root)
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
    const pid = Number(name)
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    if (alive(pid)) active = true
    else fs.rmSync(path.join(folder, name), { force: true })
  }
  return active
}
/** A `flowbound dev` that is up but could not start its server (a broken file): its pid and what went wrong. */
export function stuck(root: string): string | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(root), "utf8"))
    if (!s.problem || !alive(s.pid)) return undefined
    const log = path.join(root, ".flowbound", "dev.log")
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").slice(-12).join("\n") : s.problem
  } catch {
    return undefined
  }
}

/** The address of this project's running Flowbound; starts it in the background when it is not up. */
export async function ensure(root: string, managed = false): Promise<string> {
  let url = await running(root)
  if (url) return url
  const fail = (why: string) => new Error(`Flowbound could not start:\n${why}\nFix that and it starts again by itself.`)
  if (stuck(root)) throw fail(stuck(root)!)
  fs.mkdirSync(path.join(root, ".flowbound"), { recursive: true })
  const installed = path.join(root, "node_modules", "flowbound", "dist", "core", "start.js")
  // The first-use project has its own complete copy. npm's temporary npx cache can be replaced by another client.
  const runner = managed && fs.existsSync(installed) ? installed : bin
  // A `flowbound dev` that is alive brings its own server back up: wait for it rather than start a second one.
  let child: ReturnType<typeof spawn> | undefined
  let failed = false
  for (let i = 0; i < 480 && !url; i++) {
    if (failed && !watcher(root)) throw fail(`See ${path.join(root, ".flowbound", "dev.log")}`)
    if (!watcher(root) && !child) {
      const log = fs.openSync(path.join(root, ".flowbound", "dev.log"), "a")
      try {
        child = spawn(process.execPath, [runner, "dev", ...(managed ? ["--mcp-session"] : [])], {
          cwd: root,
          detached: true,
          stdio: ["ignore", log, log],
        })
        child.on("error", () => {
          failed = true
        })
        child.on("exit", (code) => {
          failed = code !== 0
          child = undefined
        })
        child.unref()
      } finally {
        fs.closeSync(log)
      }
    }
    await delay(250)
    if (stuck(root)) throw fail(stuck(root)!)
    url = await running(root)
  }
  if (!url) throw new Error(`Flowbound did not start. See ${path.join(root, ".flowbound", "dev.log")}`)
  return url
}
