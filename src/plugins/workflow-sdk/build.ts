// Turn the project's workflows/ folder into what the Workflow SDK runs: read each file, write the driver, bundle.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { camel, sha, title } from "../util.ts"
import { readDiagram, stepsOf } from "./diagram.ts"

export type Wf = {
  /** Its path under workflows/ without .ts: the one id of a workflow ("find-sales-heads", "tam-mapping/find-sales-heads"). */
  id: string
  /** The folder it sits in under workflows/ ("tam-mapping/nordics"), or "" for a file straight in workflows/. */
  folder: string
  title: string
  file: string
  fn: string
  hash: string
  from?: string
  into?: string
  /** Rows at a time (5 unless the file says `export const concurrency`). */
  concurrency: number
  /** Extra tries for a busy or unreachable provider (2 unless the file says `export const retries`). */
  retries: number
  /** Pause when this many of the last rows failed (11 of the last 20 unless the file says `export const pauseAfter`; false never pauses). */
  pauseAfter: { failed: number; of: number } | false
  /** What it does, in plain words, written by the agent for people: `export const summary`. */
  summary?: string
  /** The agent's drawing of it, a Mermaid flowchart without its click lines: `export const diagram`. */
  diagram?: string
  /** The boxes of the drawing tied to steps (`click <box> <function>`). */
  clicks?: { node: string; fn: string }[]
  /** The file's "use step" functions, in the order written. */
  steps?: string[]
  /** Why the drawing cannot be shown, when it cannot. */
  diagramProblem?: string
  /** The parts the file reaches with use("..."): provider cards, "ai", "records". Read from its text, so nothing has to be declared. */
  uses: string[]
  problem?: string
  /** The file as written, so its code can be read on a page, also live where the file itself is not there. */
  text?: string
}
export type Manifest = { workflows: Record<string, Wf>; ids: { run: string; row: string; clock: string } }

/**
 * Every name a workflow file reaches with use("..."), also in the files of its own it imports ("./lib/find.ts").
 * It reads the text, so a name put together while running (use(which)) is not seen: the Connections page says "used by"
 * for what a file names plainly, never "not used".
 */
export function usesOf(file: string, text = fs.readFileSync(file, "utf8"), seen = new Set<string>()): string[] {
  seen.add(file)
  const names = new Set([...text.matchAll(/\buse(?:<[^>]*>)?\(\s*["'`]([\w.-]+)["'`]\s*\)/g)].map((m) => m[1]!))
  for (const m of text.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const next = path.resolve(path.dirname(file), m[1]!)
    if (seen.size < 30 && !seen.has(next) && fs.existsSync(next) && fs.statSync(next).isFile()) for (const n of usesOf(next, undefined, seen)) names.add(n)
  }
  return [...names].sort()
}

const FOLDER = /^[a-z0-9][a-z0-9-]*$/
const FILE = /^[a-z0-9][a-z0-9-]*\.ts$/
/**
 * The workflow files under workflows/, also in folders and subfolders (workflows/tam-mapping/nordics/build-tam-list.ts).
 * A file straight in workflows/ is always a workflow. In a folder, only a file that says "use workflow" is one: the
 * rest are its helpers (workflows/tam-mapping/lib/find.ts).
 */
export function workflowFiles(root: string): { id: string; folder: string; file: string }[] {
  const out: { id: string; folder: string; file: string }[] = []
  const walk = (dir: string, folder: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 8 && FOLDER.test(e.name) && e.name !== "node_modules") walk(file, folder ? `${folder}/${e.name}` : e.name, depth + 1)
        continue
      }
      if (!e.isFile() || !FILE.test(e.name)) continue
      if (folder && !/["']use workflow["']/.test(fs.readFileSync(file, "utf8"))) continue
      out.push({ id: `${folder ? `${folder}/` : ""}${e.name.slice(0, -3)}`, folder, file })
    }
  }
  const dir = path.join(root, "workflows")
  if (fs.existsSync(dir)) walk(dir, "", 0)
  return out
}

/** Read every workflow file: its id, what it exports, and whether it is well formed. */
export async function readWorkflows(root: string): Promise<Record<string, Wf>> {
  const out: Record<string, Wf> = {}
  for (const { id, folder, file } of workflowFiles(root)) {
    const name = path.basename(file, ".ts")
    const text = fs.readFileSync(file, "utf8")
    const wf: Wf = { id, folder, title: title(name), file, fn: camel(name), hash: sha(text), concurrency: 5, retries: 2, pauseAfter: { failed: 11, of: 20 }, text, uses: usesOf(file, text), steps: stepsOf(text) }
    out[id] = wf
    try {
      const mod = await import(`${pathToFileURL(file).href}?h=${wf.hash}`)
      Object.assign(wf, { from: mod.from, into: mod.into, concurrency: Number(mod.concurrency) || 5 })
      // Run habits are defaults the agent may change in the file: tries for a busy provider, and when to pause.
      if (mod.retries !== undefined) wf.retries = Math.max(0, Math.min(5, Math.floor(Number(mod.retries)) || 0))
      if (mod.pauseAfter === false) wf.pauseAfter = false
      else if (mod.pauseAfter && typeof mod.pauseAfter === "object" && Number(mod.pauseAfter.failed) > 0)
        wf.pauseAfter = { failed: Math.floor(Number(mod.pauseAfter.failed)), of: Math.max(Math.floor(Number(mod.pauseAfter.failed)), Math.floor(Number(mod.pauseAfter.of)) || 20) }
      if (typeof mod.summary === "string" && mod.summary.trim()) wf.summary = mod.summary.trim()
      const drawn = readDiagram(mod.diagram)
      wf.diagram = drawn.source
      wf.clicks = drawn.clicks
      wf.diagramProblem = drawn.problem
      if (typeof mod[wf.fn] !== "function") wf.problem = `it must export an async function named ${wf.fn} (the file name in camel case)`
      else if (!new RegExp(`function\\s+${wf.fn}\\s*\\([^)]*\\)[^{]*\\{\\s*["']use workflow["']`).test(text)) wf.problem = `${wf.fn} must start with the line "use workflow"`
      else if (typeof wf.from !== "string" || typeof wf.into !== "string") wf.problem = 'it must name its list and its results table: export const from = "..." and export const into = "..."'
      // Caps live in the permissions, never in a workflow file; what runs by itself is a line in flowbound.config.ts.
      else if (mod.every !== undefined || mod.on !== undefined || mod.maxUsdPerMonth !== undefined || mod.maxCallsPerMonth !== undefined)
        wf.problem = `"every", "on" and a monthly cap do not go in a workflow file. Remove them: a schedule or webhook is a line in flowbound.config.ts (schedules: [schedule({ id: "${name}-schedule", workflow: "${id}", every: "monday 08:00" })]), and caps are in its permissions`
    } catch (e: any) {
      wf.problem = `it does not load: ${String(e?.message ?? e).split("\n")[0]}`
    }
  }
  return out
}

/** The driver: the two Flowbound workflows that walk a list and handle one batch of rows, written beside the user's own. */
export function driverSource(workflows: Wf[], importFrom: (wf: Wf) => string): string {
  const ok = workflows.filter((w) => !w.problem)
  return `// Written by Flowbound on every start. Do not edit.
import { getWorkflowMetadata, sleep } from "workflow"
import { start } from "workflow/api"
${ok.map((w, i) => `import { ${w.fn} as w${i} } from ${JSON.stringify(importFrom(w))}`).join("\n")}

const fns: Record<string, (row: any) => Promise<any>> = { ${ok.map((w, i) => `${JSON.stringify(w.id)}: w${i}`).join(", ")} }
const steps = () => (globalThis as any)[Symbol.for("flowbound")].use("runs").steps

/** One batch of rows, one after the other: hand each to the workflow, save the answer or the reason it failed. */
export async function flowboundBatch(runId: number, rowIds: number[]) {
  "use workflow"
  const got = await beginBatch(runId, rowIds)
  if (!got) return
  for (const [i, row] of got.rows.entries()) {
    const rest = got.rows.slice(i + 1).map((r: any) => r.id)
    let more: boolean
    try {
      const out = await fns[got.workflow]!(row)
      more = await saveRow(runId, row.id, out, rest)
    } catch (e: any) {
      more = await failRow(runId, row.id, String(e?.message ?? e), rest)
    }
    // The run stopped or paused: the rows left in this batch went back, not done.
    if (!more) return
  }
}

/** One run: a few lanes, each a batch of rows at a time, until the list is done, the cap is reached or the run is paused. */
export async function flowboundRun(runId: number) {
  "use workflow"
  const plan = await begin(runId)
  if (!plan) return
  const lane = async (l: number) => {
    for (let n = 0; n < plan.each; n++) {
      const rows = await claim(runId, plan.batch, l + ":" + n)
      if (!rows.length) return false
      try {
        const child = await start(flowboundBatch, [runId, rows])
        await child.returnValue
      } catch (e: any) {
        await failBatch(runId, rows, String(e?.message ?? e))
      }
    }
    return true
  }
  const more = await Promise.all(Array.from({ length: plan.lanes }, (_, l) => lane(l)))
  if (more.some(Boolean)) {
    // Carry on in a fresh run of this driver, so one run's history never grows without end.
    await start(flowboundRun, [runId])
    return
  }
  // A row can arrive in the last moment (a webhook's): the run does not end while one is waiting.
  if (await finish(runId)) await start(flowboundRun, [runId])
}

/** The clock: sleeps until the next scheduled workflow is due, starts it, and sleeps again. */
export async function flowboundClock(generation: string) {
  "use workflow"
  for (let n = 0; n < 200; n++) {
    const due = await nextDue(generation)
    if (!due) return
    await sleep(new Date(due))
    await fire(generation)
  }
  await start(flowboundClock, [generation])
}

async function begin(runId: number) {
  "use step"
  return steps().begin(runId)
}
async function claim(runId: number, most: number, name: string): Promise<number[]> {
  "use step"
  return steps().claim(runId, most, getWorkflowMetadata().workflowRunId + ":" + name)
}
async function beginBatch(runId: number, rowIds: number[]) {
  "use step"
  return steps().beginBatch(runId, rowIds, getWorkflowMetadata().workflowRunId)
}
async function saveRow(runId: number, rowId: number, out: unknown, rest: number[]): Promise<boolean> {
  "use step"
  return steps().saveRow(runId, rowId, out, rest, getWorkflowMetadata().workflowRunId)
}
async function failRow(runId: number, rowId: number, why: string, rest: number[]): Promise<boolean> {
  "use step"
  return steps().failRow(runId, rowId, why, rest, getWorkflowMetadata().workflowRunId)
}
async function failBatch(runId: number, rowIds: number[], why: string) {
  "use step"
  return steps().failBatch(runId, rowIds, why)
}
async function finish(runId: number): Promise<boolean> {
  "use step"
  return steps().finish(runId)
}
async function nextDue(generation: string): Promise<string | null> {
  "use step"
  return steps().nextDue(generation)
}
async function fire(generation: string) {
  "use step"
  return steps().fire(generation)
}
`
}

/** Build for this computer: bundles in .flowbound/build, loaded straight into the running server. */
export async function buildLocal(root: string): Promise<{ manifest: Manifest; flow: { POST: (req: Request) => Promise<Response> }; webhook: Record<string, (req: Request) => Promise<Response>> }> {
  const workflows = await readWorkflows(root)
  const gen = path.join(root, ".flowbound", "gen")
  const out = path.join(root, ".flowbound", "build")
  fs.mkdirSync(gen, { recursive: true })
  fs.mkdirSync(out, { recursive: true })
  const source = driverSource(Object.values(workflows), (w) => `../../workflows/${w.id}.ts`)
  const driver = path.join(gen, "driver.ts")
  if (!fs.existsSync(driver) || fs.readFileSync(driver, "utf8") !== source) fs.writeFileSync(driver, source)
  const stamp = sha(
    source +
      Object.values(workflows)
        .map((w) => w.hash)
        .join(),
  )
  const { BaseBuilder } = await import("@workflow/builders")
  type Made = { manifest: { workflows: Record<string, Record<string, { workflowId: string }>> } }
  class Builder extends BaseBuilder {
    made?: Made
    async build() {
      this.made = (await this.createCombinedBundle({
        inputFiles: await this.getInputFiles(),
        stepsOutfile: path.join(out, "__step_registrations.mjs"),
        flowOutfile: path.join(out, "flow.mjs"),
        tsconfigPath: await this.findTsConfigPath(),
        format: "esm",
        bundleFinalOutput: true,
      } as any)) as Made
      await this.createWebhookBundle({ outfile: path.join(out, "webhook.mjs") } as any)
    }
  }
  const quiet = { suppressCreateWorkflowsBundleLogs: true, suppressCreateWebhookBundleLogs: true, suppressCreateManifestLogs: true }
  const builder = new Builder({
    buildTarget: "standalone",
    dirs: ["workflows", ".flowbound/gen"],
    workingDir: root,
    externalPackages: ["flowbound"],
    stepsBundlePath: "",
    workflowsBundlePath: "",
    webhookBundlePath: "",
    ...quiet,
  } as any)
  const log = console.log
  console.log = () => {}
  try {
    await builder.build()
  } finally {
    console.log = log
  }
  const made = builder.made!
  const id = (name: string) => made.manifest.workflows[".flowbound/gen/driver.ts"]?.[name]?.workflowId ?? ""
  const manifest: Manifest = { workflows, ids: { run: id("flowboundRun"), row: id("flowboundBatch"), clock: id("flowboundClock") } }
  if (!manifest.ids.run) throw new Error("The workflow bundle did not come out right: the driver is missing from it.")
  const flow = await import(`${pathToFileURL(path.join(out, "flow.mjs")).href}?v=${stamp}`)
  const webhook = await import(`${pathToFileURL(path.join(out, "webhook.mjs")).href}?v=${stamp}`)
  return { manifest, flow, webhook }
}
