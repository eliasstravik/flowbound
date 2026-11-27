// `flowbound deploy`: the same project, live on Vercel with a Neon database. It drives Vercel's own command-line
// tool and sign-in, builds the project for Vercel, applies table changes and prints the address.
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import readline from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { readList } from "../../core/load.ts"
import { running } from "../../core/local.ts"
import type { CommandLine, Flowbound, Plugin } from "../../core/plugin.ts"
import { driverSource, readWorkflows } from "./build.ts"

const APP = "__app"
const RUNTIME = "nodejs22.x"
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const say = (line: string) => console.log(line)

function vercel(root: string, args: string[], opts: { input?: string; show?: boolean } = {}) {
  const r = spawnSync("npx", ["--yes", "vercel", ...args], { cwd: root, encoding: "utf8", input: opts.input, stdio: opts.show ? "inherit" : ["pipe", "pipe", "pipe"] })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}`, err: `${r.stderr ?? ""}` }
}
function liveSettings(root: string): Set<string> {
  const names = vercel(root, ["env", "ls", "production"])
  if (!names.ok) throw new Error("Could not read production setting names from Vercel. Check your login and project link.")
  return new Set((names.out + names.err).match(/\b[A-Z][A-Z_]+\b/g))
}

/** Write .vercel/output for this project: the workflow functions from the Workflow SDK's builder, plus Flowbound itself. */
export async function buildVercel(root: string): Promise<{ out: string; workflows: number; schedules: number }> {
  const workflows = await readWorkflows(root)
  const gen = path.join(root, ".flowbound", "gen")
  fs.mkdirSync(gen, { recursive: true })
  fs.writeFileSync(
    path.join(gen, "driver.ts"),
    driverSource(Object.values(workflows), (w) => `../../workflows/${w.id}.ts`),
  )
  const { VercelBuildOutputAPIBuilder } = await import("@workflow/builders")
  const esbuild = await import("esbuild")
  const out = path.join(root, ".vercel", "output")
  fs.rmSync(out, { recursive: true, force: true })
  const builder = new VercelBuildOutputAPIBuilder({
    buildTarget: "vercel-build-output-api",
    workingDir: root,
    dirs: ["workflows", ".flowbound/gen"],
    runtime: RUNTIME,
    externalPackages: ["flowbound"],
    stepsBundlePath: "",
    workflowsBundlePath: "",
    webhookBundlePath: "",
    suppressCreateWorkflowsBundleLogs: true,
    suppressCreateWebhookBundleLogs: true,
    suppressCreateManifestLogs: true,
  } as any)
  const log = console.log
  console.log = () => {}
  try {
    await builder.build()
  } finally {
    console.log = log
  }
  const fnDir = path.join(out, "functions")
  const made = JSON.parse(fs.readFileSync(path.join(fnDir, ".well-known/workflow/v1/manifest.json"), "utf8"))
  const id = (name: string) => made.workflows?.[".flowbound/gen/driver.ts"]?.[name]?.workflowId
  const manifest = {
    workflows: Object.fromEntries(Object.entries(workflows).map(([k, w]) => [k, { ...w, file: `workflows/${w.id}.ts` }])),
    ids: { run: id("flowboundRun"), row: id("flowboundBatch"), clock: id("flowboundClock") },
  }
  if (!manifest.ids.run) throw new Error("The workflow bundle did not come out right: the driver is missing from it.")

  // Flowbound itself as one function: the list, booted once per instance, answering every address but the SDK's own.
  const entry = path.join(gen, "live.ts")
  fs.writeFileSync(
    entry,
    `// Written by Flowbound on every deploy. Do not edit.
import project from "../../flowbound.config.ts"
import { boot } from "flowbound"
import { liveApp } from ${JSON.stringify(path.join(dist, "..", "core", "live.js"))}
const shared = ((globalThis as any)[Symbol.for("flowbound")] ??= {})
shared.built = { manifest: ${JSON.stringify(manifest)} }
// A preview (a branch's own deployment) answers at its own address, so its links and its sign-in stay on the preview.
const preview = process.env.VERCEL_ENV === "preview"
const host = preview ? process.env.VERCEL_URL : (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL)
const url = (!preview && process.env.FLOWBOUND_URL) || \`https://\${host}\`
export const getApp = liveApp(async () => {
  if (preview && !process.env.FLOWBOUND_SECRET) throw new Error("Preview sign-in is not configured")
  return boot(project, { root: process.cwd(), live: true, url })
})
const answer = async (req: Request) => getApp().then((app) => app.fetch(req), () => new Response("Flowbound could not start. Please try again in a moment.", { status: 503, headers: { "retry-after": "1", "cache-control": "no-store" } }))
export default { fetch: answer }
export { answer as GET, answer as POST, answer as PUT, answer as PATCH, answer as DELETE, answer as HEAD, answer as OPTIONS }
`,
  )
  const app = path.join(fnDir, `${APP}.func`)
  fs.mkdirSync(app, { recursive: true })
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(app, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "error",
    // Only used on your own computer or at build time; never loaded live.
    external: ["@electric-sql/pglite", "@workflow/builders", "esbuild", "pg-native", "@opentelemetry/api"],
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; import { fileURLToPath as __fu } from "node:url"; import { dirname as __dn } from "node:path"; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);',
    },
  })
  // execute's sandbox loads its engine, a .wasm file, from beside the bundle at run time: put it there.
  fs.copyFileSync(createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm"), path.join(app, "emscripten-module.wasm"))
  fs.copyFileSync(path.join(dist, "..", "core", "start.md"), path.join(app, "start.md"))
  // Pages and docs are plain files read at run time: put them beside the bundle, where the plugins look for them.
  for (const file of fs.readdirSync(dist, { recursive: true })) {
    const from = path.join(dist, String(file))
    // The pages' own script (pages/built/page.js) is one of those files: it is sent to the browser, never run here.
    if (fs.statSync(from).isDirectory() || (/\.(js|ts|map)$/.test(from) && !from.endsWith(path.join("pages", "built", "page.js")))) continue
    fs.mkdirSync(path.dirname(path.join(app, String(file))), { recursive: true })
    fs.copyFileSync(from, path.join(app, String(file)))
  }
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ type: "module" }))
  fs.writeFileSync(
    path.join(app, ".vc-config.json"),
    JSON.stringify({ runtime: RUNTIME, handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 300 }, null, 2),
  )

  // The SDK's flow function runs the steps, and steps reach Flowbound with use(): boot Flowbound in that function too.
  const flow = path.join(fnDir, ".well-known/workflow/v1/flow.func")
  fs.renameSync(path.join(flow, "index.mjs"), path.join(flow, "flow.mjs"))
  fs.cpSync(app, path.join(flow, "app"), { recursive: true })
  fs.rmSync(path.join(flow, "app", ".vc-config.json"))
  fs.writeFileSync(
    path.join(flow, "index.mjs"),
    'import { getApp } from "./app/index.mjs"\nimport * as flow from "./flow.mjs"\nexport * from "./flow.mjs"\nexport async function POST(req) { await getApp(); return flow.POST(req) }\n',
  )
  // Inside a step, `import { use } from "flowbound"` only needs use(): a few lines instead of the whole package.
  const tiny = path.join(flow, "node_modules", "flowbound")
  fs.mkdirSync(tiny, { recursive: true })
  fs.writeFileSync(path.join(tiny, "package.json"), JSON.stringify({ name: "flowbound", type: "module", main: "index.mjs" }))
  fs.writeFileSync(path.join(tiny, "index.mjs"), 'export const use = (name) => globalThis[Symbol.for("flowbound")].use(name)\n')

  const configFile = path.join(out, "config.json")
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
  config.routes = [...(config.routes ?? []), { handle: "filesystem" }, { src: "^/(?!\\.well-known/workflow/).*$", dest: `/${APP}`, check: true }]
  // Each schedule line becomes one of Vercel's own schedules: the host is the clock, and it calls /clock with its CRON_SECRET.
  // (Vercel's docs, read 26 Nov 2026: Schedules replace Cron Jobs; a new run for each time is the normal way, not one run that sleeps.)
  const list = await readList(root)
  const lines = (list.find((p) => p.provides === "schedules")?.hostSchedules as ((l: Plugin[]) => Record<string, unknown>) | undefined)?.(list) ?? {}
  if (Object.keys(lines).length) config.schedules = { ...(config.schedules ?? {}), ...lines }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
  return { out, workflows: Object.values(workflows).filter((w) => !w.problem).length, schedules: Object.keys(lines).length }
}

/** Apply every plugin's table changes to the live database, from here, so the first visit is not the one that waits. */
async function migrate(root: string, list: Plugin[], url: string): Promise<{ applied: number; close: () => Promise<void>; query: (sql: string, params?: unknown[]) => Promise<any> }> {
  const pg = list.find((p) => p.provides === "records")
  if (!pg?.start) throw new Error("The list has no records plugin (postgres), so there is no database to set up.")
  const before = process.env.DATABASE_URL
  process.env.DATABASE_URL = url
  try {
    const api: any = await pg.start({ root, live: true, url: "", base: "", local: "", plugins: list, tools: {}, use: () => api, has: () => true, call: async () => undefined } as Flowbound)
    return { applied: api.applied(), close: async () => void (await pg.stop?.()), query: api.query }
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = before
  }
}

export async function deploy(args: string[], cl: CommandLine, on?: string): Promise<void> {
  const root = cl.root
  const flag = (name: string) => args.includes(`--${name}`)
  const value = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined)

  if (flag("prepare-database")) {
    const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
    if (!url) throw new Error("No database address is available to the migration command.")
    const facts = JSON.parse(fs.readFileSync(0, "utf8") || "[]")
    const db = await migrate(root, await readList(root), url)
    try {
      say(`Tables: ${db.applied} change${db.applied === 1 ? "" : "s"} applied`)
      for (const f of facts)
        await db.query(
          "insert into fb_ledger.facts (key, provider, request, status, answer, cost_usd, by, at) select $1, $2, $3, $4, $5, $6, $7, $8 where not exists (select 1 from fb_ledger.facts where key = $1 and at = $8)",
          [f.key, f.provider, JSON.stringify(f.request), f.status, JSON.stringify(f.answer), f.cost_usd, f.by, f.at],
        )
      if (facts.length) say(`Copied ${facts.length} paid facts`)
    } finally {
      await db.close()
    }
    return
  }
  if (on === "local") return say('This project is set to run on your computer only. To go live, change the line in flowbound.config.ts to workflowSdk() or workflowSdk({ on: "vercel" }).')
  if (on === "postgres" || on === "cloudflare") return say(`workflowSdk({ on: "${on}" }) has a written guide, not a deploy command: see docs/homes.md in the flowbound package (node_modules/flowbound/docs/homes.md).`)
  if (flag("build-only")) {
    const built = await buildVercel(root)
    return say(
      `Built ${built.workflows} workflow${built.workflows === 1 ? "" : "s"}${built.schedules ? ` and ${built.schedules} schedule${built.schedules === 1 ? "" : "s"}` : ""} for Vercel in ${path.relative(root, built.out)}`,
    )
  }
  const tty = process.stdin.isTTY && !flag("yes")
  const rl = tty ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined
  const ask = async (q: string, fallback: boolean) => (rl ? /^y/i.test(await rl.question(`${q} (y/n) `)) : fallback)

  say("Signing in with Vercel's own tool ...")
  if (!vercel(root, ["whoami"]).ok && !vercel(root, ["login"], { show: true }).ok) throw new Error("Vercel's sign-in did not finish. Run `npx vercel login`, then deploy again.")
  const name =
    value("name") ??
    `flowbound-${path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")}`
  if (!fs.existsSync(path.join(root, ".vercel", "project.json")) && !vercel(root, ["link", "--yes", "--project", name]).ok) throw new Error(`Could not make or link the Vercel project "${name}". Try: npx vercel link`)

  // The normal Vercel way from here on: with this file in the repo, a git push builds the same thing this command does.
  const vercelJson = path.join(root, "vercel.json")
  if (!fs.existsSync(vercelJson)) {
    fs.writeFileSync(vercelJson, `${JSON.stringify({ $schema: "https://openapi.vercel.sh/vercel.json", framework: null, buildCommand: "npx flowbound deploy --build-only" }, null, 2)}\n`)
    say("Wrote vercel.json: connect this repo to the project in Vercel and every push builds it (see docs/homes.md in the flowbound package).")
  }

  let env = liveSettings(root)
  if (!env.has("DATABASE_URL")) {
    vercel(root, ["integration", "accept-terms", "neon", "--yes"])
    vercel(root, ["integration", "add", "neon", "--name", `${name}-db`.slice(0, 32), "-m", "auth=false", "--plan", "free_v3", "-e", "production", "-e", "preview", "-e", "development", "--no-env-pull"], {
      show: !!rl,
    })
    env = liveSettings(root)
    if (!env.has("DATABASE_URL")) throw new Error("Vercel did not add a Neon database. Connect one in the project’s Storage tab and try again.")
    say("Database: Neon (made for you)")
  } else say("Database: Neon")
  if (!env.has("FLOWBOUND_SECRET")) vercel(root, ["env", "add", "FLOWBOUND_SECRET", "production"], { input: crypto.randomBytes(32).toString("base64url") })
  // Vercel's schedules call /clock with this secret, and the clock ticks for nobody else. Made here, never shown.
  if (!env.has("CRON_SECRET")) vercel(root, ["env", "add", "CRON_SECRET", "production"], { input: crypto.randomBytes(32).toString("base64url") })

  const list = await readList(root)

  const facts: any[] = []
  // The sql tool answers 500 rows at a time: read the whole memory, page by page.
  for (let from = 0; await running(root); from += 500) {
    const page = await cl.call("sql", { query: `select key, provider, request, status, answer, cost_usd, by, at from fb_ledger.facts order by id limit 500 offset ${from}` }).catch(() => undefined)
    facts.push(...(page?.rows ?? []))
    if ((page?.rows?.length ?? 0) < 500) break
  }

  const copy = facts.length && (flag("copy-facts") || (await ask(`Copy ${facts.length} paid facts to live?`, false)))
  const prepared = vercel(root, ["env", "run", "--environment", "production", "--", process.execPath, process.argv[1]!, "deploy", "--prepare-database"], {
    input: JSON.stringify(copy ? facts : []),
  })
  if (!prepared.ok && copy) throw new Error("Could not copy the requested facts. Check that Vercel can supply the production database address to a command.")
  if (!prepared.ok) say("The deployment will apply its table changes on the first request.")
  else for (const line of prepared.out.split("\n").filter((line) => /^(Tables: \d+ changes? applied|Copied \d+ paid facts)$/.test(line))) say(line)

  await buildVercel(root)
  const shipped = vercel(root, ["deploy", "--prebuilt", "--prod", "--yes"])
  if (!shipped.ok) throw new Error(`Vercel did not take the deploy:\n${shipped.err.trim() || shipped.out.trim()}`)
  let url = shipped.out.trim().split("\n").pop() ?? ""
  try {
    const j = JSON.parse(shipped.out)
    url = `https://${(j.deployment?.url ?? j.url).replace(/^https:\/\//, "")}`
  } catch {}
  const project = JSON.parse(fs.readFileSync(path.join(root, ".vercel", "project.json"), "utf8"))
  const home = vercel(root, ["inspect", url, "--json"])
  try {
    const alias = JSON.parse(home.out).aliases?.find((a: string) => !a.includes("-git-")) ?? JSON.parse(home.out).alias?.[0]
    if (alias) url = `https://${alias}`
  } catch {}
  fs.mkdirSync(path.join(root, ".flowbound"), { recursive: true })
  fs.writeFileSync(path.join(root, ".flowbound", "live.json"), JSON.stringify({ url, project: project.projectName ?? name }))
  rl?.close()
  const signIn = list.find((p) => p.provides === "door")?.signIn as string | undefined
  say(`live at ${url}${signIn ? ` · sign in with ${signIn}` : ""}`)
  if (!env.has("FLOWBOUND_LOGIN_CLIENT_ID") && !env.has("FLOWBOUND_PASSWORD"))
    say(
      [
        "",
        "Nobody can sign in yet, so it does not start. The person picks one, in their own terminal (never in the chat):",
        "  the company's own login (Google, Microsoft, Okta): the door's line in flowbound.config.ts says which, and the two",
        `    values from the login's console go on the host; its callback address is ${url}/door/callback. See: npx flowbound docs door`,
        "    npx vercel env add FLOWBOUND_LOGIN_CLIENT_ID production   and   npx vercel env add FLOWBOUND_LOGIN_CLIENT_SECRET production",
        "  or, for a first try-out, one team password:   npx vercel env add FLOWBOUND_PASSWORD production",
        "Then: npx flowbound deploy",
      ].join("\n"),
    )
  else say(`Next: a signed-in person makes a token at ${url}/connect and types it on this computer's keys page. Then \`--live\` commands reach it.`)
}
