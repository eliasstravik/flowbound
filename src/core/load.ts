// Read the list, check each plugin's needs against what others provide, and put them in starting order.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "./plugin.ts"

export const CONFIG = "flowbound.config.ts"

/** The folder that holds flowbound.config.ts, looking upward from here. */
export function findRoot(from = process.cwd()): string | undefined {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, CONFIG))) return dir
    if (dir === path.dirname(dir)) return undefined
  }
}

/** flowbound.config.ts: `export default { providers, permissions, ... }`, made into the list of parts it starts. A plain list of plugins works too. */
export async function readList(root: string): Promise<Plugin[]> {
  const file = path.join(root, CONFIG)
  const mod = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`)
  return toList(mod.default)
}

/** What flowbound.config.ts exports by default (the project, or a plain list of plugins), as the list of parts it starts. */
export async function toList(project: unknown): Promise<Plugin[]> {
  if (Array.isArray(project)) return project.flat()
  if (project && typeof project === "object") return (await import("../index.ts")).flowbound(project)
  throw new Error(`${CONFIG} must export default the project: export default { providers: [blitzapi(), firecrawl()], permissions: { mode: "auto", caps: { perRun: 5, perMonth: 100 } } }`)
}

export type Checked = { order: Plugin[]; replaced: Plugin[]; problems: string[] }

/** A later plugin with the same `provides` replaces an earlier one. Needs come before the plugins that need them. */
export function check(list: Plugin[]): Checked {
  const problems: string[] = []
  const giver = new Map<string, Plugin>()
  const names = new Set<string>()
  for (const p of list) {
    if (!p || typeof p.name !== "string") {
      problems.push("an entry in the list is not a plugin (did you forget the brackets, as in postgres()?)")
      continue
    }
    if (names.has(p.name)) problems.push(`${p.name} is in the list twice`)
    names.add(p.name)
    if (p.provides) giver.set(p.provides, p)
  }
  const kept = list.filter((p) => p?.name && (!p.provides || giver.get(p.provides) === p))
  const replaced = list.filter((p) => p?.name && !kept.includes(p))
  const order: Plugin[] = []
  const state = new Map<Plugin, "open" | "done">()
  const visit = (p: Plugin, trail: string[]) => {
    if (state.get(p) === "done") return
    if (state.get(p) === "open") {
      problems.push(`${[...trail, p.name].join(" needs ")}: they need each other in a circle`)
      return
    }
    state.set(p, "open")
    for (const need of p.needs ?? []) {
      const g = giver.get(need) ?? kept.find((k) => k.name === need)
      if (!g) problems.push(`${p.name} needs ${need}, and no plugin in the list gives it`)
      else visit(g, [...trail, p.name])
    }
    state.set(p, "done")
    order.push(p)
  }
  for (const p of kept) visit(p, [])
  return { order, replaced, problems }
}

/** The table `flowbound plugins` prints. */
export function table(list: Plugin[]): string {
  const { replaced, problems } = check(list)
  const rows = list.filter((p) => p?.name).map((p) => [p.name + (replaced.includes(p) ? " (replaced)" : ""), p.provides ?? "-", p.from ?? "flowbound"])
  const w = [0, 1].map((i) => Math.max(...rows.map((r) => r[i]!.length), i ? 5 : 6) + 2)
  const line = (r: string[]) => `${r[0]!.padEnd(w[0]!)}${r[1]!.padEnd(w[1]!)}${r[2]}`
  const count = `${rows.length} plugin${rows.length === 1 ? "" : "s"}, ${problems.length} problem${problems.length === 1 ? "" : "s"}`
  return [line(["plugin", "gives", "from"]), ...rows.map(line), count, ...problems.map((p) => `problem: ${p}`)].join("\n")
}
