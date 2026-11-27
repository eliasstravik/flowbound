// On your own computer: find this project's running Flowbound, or start it in the background.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), `bin${path.extname(fileURLToPath(import.meta.url))}`)
export const stateFile = (root: string) => path.join(root, ".flowbound", "server.json")

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
export function watcher(root: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(watcherFile(root), "utf8"))
    return pid && alive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
export async function ensure(root: string): Promise<string> {
  let url = await running(root)
  if (url) return url
  const fail = (why: string) => new Error(`Flowbound could not start:\n${why}\nFix that and it starts again by itself.`)
  if (stuck(root)) throw fail(stuck(root)!)
  fs.mkdirSync(path.join(root, ".flowbound"), { recursive: true })
  // A `flowbound dev` that is alive brings its own server back up: wait for it rather than start a second one.
  if (!watcher(root)) {
    fs.rmSync(stateFile(root), { force: true })
    const log = fs.openSync(path.join(root, ".flowbound", "dev.log"), "w")
    spawn(process.execPath, [bin, "dev"], { cwd: root, detached: true, stdio: ["ignore", log, log] }).unref()
  }
  for (let i = 0; i < 480 && !url; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (stuck(root)) throw fail(stuck(root)!)
    url = await running(root)
  }
  if (!url) throw new Error(`Flowbound did not start. See ${path.join(root, ".flowbound", "dev.log")}`)
  return url
}
