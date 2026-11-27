// `npx flowbound init`: write the project's files, add the package, set up every agent app on this machine, start it.
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { CommandLine } from "../../core/plugin.ts"

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"))
const SERVER = { command: "npx", args: ["-y", "flowbound", "mcp"] }

const onPath = (bin: string) => (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, bin)))

/** Merge our MCP server into a JSON settings file, keeping whatever else is in it. */
function mergeJson(file: string, set: (json: any) => void) {
  let json: any = {}
  if (fs.existsSync(file)) {
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      return false
    }
  }
  set(json)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  return true
}
const mcpServers = (file: string, extra = {}) => mergeJson(file, (j) => ((j.mcpServers ??= {}).flowbound = { ...SERVER, ...extra }))

/** Each agent app: how to tell it is installed, where its project MCP setting goes, where it reads skills. */
const APPS: { name: string; bins: string[]; mcp: (root: string) => boolean; skills: string }[] = [
  { name: "Claude Code", bins: ["claude"], mcp: (r) => mcpServers(path.join(r, ".mcp.json"), { type: "stdio" }), skills: ".claude/skills" },
  {
    name: "Codex",
    bins: ["codex"],
    mcp: (r) => {
      const file = path.join(r, ".codex", "config.toml")
      const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
      if (have.includes("[mcp_servers.flowbound]")) return true
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${have}${have && !have.endsWith("\n") ? "\n" : ""}[mcp_servers.flowbound]\ncommand = "npx"\nargs = ["-y", "flowbound", "mcp"]\n`)
      return true
    },
    skills: ".agents/skills",
  },
  { name: "Cursor", bins: ["cursor", "cursor-agent"], mcp: (r) => mcpServers(path.join(r, ".cursor", "mcp.json")), skills: ".agents/skills" },
  { name: "VS Code", bins: ["code", "code-insiders"], mcp: (r) => mcpServers(path.join(r, ".mcp.json"), { type: "stdio" }), skills: ".agents/skills" },
  { name: "GitHub Copilot", bins: ["copilot"], mcp: (r) => mcpServers(path.join(r, ".mcp.json"), { type: "stdio" }), skills: ".agents/skills" },
  { name: "Gemini CLI", bins: ["gemini"], mcp: (r) => mcpServers(path.join(r, ".gemini", "settings.json")), skills: ".agents/skills" },
  {
    name: "OpenCode",
    bins: ["opencode"],
    mcp: (r) =>
      mergeJson(path.join(r, "opencode.json"), (j) => ((j.$schema ??= "https://opencode.ai/config.json"), ((j.mcp ??= {}).flowbound = { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true }))),
    skills: ".agents/skills",
  },
  { name: "pi", bins: ["pi"], mcp: (r) => mcpServers(path.join(r, ".pi", "mcp.json")), skills: ".agents/skills" },
  { name: "Kiro", bins: ["kiro-cli", "kiro"], mcp: (r) => mcpServers(path.join(r, ".kiro", "settings", "mcp.json")), skills: ".kiro/skills" },
  { name: "Devin", bins: ["devin"], mcp: (r) => mcpServers(path.join(r, ".devin", "mcp_config.json")), skills: ".agents/skills" },
]

function writeIfMissing(file: string, text: string, made: string[], what: string) {
  if (fs.existsSync(file)) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  made.push(what)
}

/** Add the package to the project. Before it is on npm, the copy that is running packs itself. */
function install(root: string) {
  if (fs.existsSync(path.join(root, "node_modules", "flowbound", "package.json"))) return
  let spec = process.env.FLOWBOUND_INSTALL ?? `flowbound@${pkg.version}`
  if (!process.env.FLOWBOUND_INSTALL && spawnSync("npm", ["view", spec, "version"], { stdio: "ignore" }).status !== 0) {
    fs.mkdirSync(path.join(root, ".flowbound"), { recursive: true })
    const out = execFileSync("npm", ["pack", pkgRoot, "--pack-destination", path.join(root, ".flowbound"), "--silent"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .pop()!
    spec = path.join(root, ".flowbound", out)
  }
  console.log("Adding the flowbound package ...")
  const done = spawnSync("npm", ["install", "--save-exact", "--no-audit", "--no-fund", "--loglevel=error", spec], { cwd: root, stdio: "inherit" })
  if (done.status !== 0) throw new Error("npm could not add the flowbound package. Fix that, then run init again.")
}

export async function init(args: string[], cl: CommandLine) {
  const root = process.cwd()
  const made: string[] = []
  const tpl = (name: string) => fs.readFileSync(path.join(pkgRoot, "template", name), "utf8")
  // `--example`: a small made-up list and a workflow that needs no key and costs nothing, tried once, so the pages
  // have a list, a run and results on them before any provider is set up.
  const example = args.includes("--example")
  if (example) {
    writeIfMissing(path.join(root, "workflows", "tidy-companies.ts"), tpl("example/tidy-companies.ts"), made, "workflows/tidy-companies.ts          an example that needs no key and costs nothing")
    writeIfMissing(path.join(root, "examples", "example-companies.csv"), tpl("example/example-companies.csv"), made, "examples/example-companies.csv       its list: eight made-up companies")
  }
  writeIfMissing(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name:
          path
            .basename(root)
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-") || "flowbound-project",
        private: true,
        type: "module",
        devDependencies: { typescript: "^6.0.0" },
      },
      null,
      2,
    )}\n`,
    made,
    "package.json",
  )
  writeIfMissing(path.join(root, "flowbound.config.ts"), tpl("flowbound.config.ts"), made, "flowbound.config.ts   your providers and permissions")
  writeIfMissing(path.join(root, "workflows", "README.md"), tpl("workflows.md"), made, "workflows/            one file per workflow")
  writeIfMissing(path.join(root, "plugins", "README.md"), tpl("plugins.md"), made, "plugins/              your own plugins and provider cards")
  writeIfMissing(path.join(root, "tsconfig.json"), tpl("tsconfig.json"), made, "tsconfig.json")
  const ignore = path.join(root, ".gitignore")
  const ignored = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : ""
  const lines = ["node_modules", ".flowbound", ".vercel", ".swc"].filter((l) => !ignored.split("\n").includes(l))
  if (lines.length) fs.writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`)
  install(root)

  // The skill is a stub that sends the agent to `flowbound docs`, so the words always match the installed version.
  const skill = fs.readFileSync(path.join(pkgRoot, "skills", "flowbound", "SKILL.md"), "utf8")
  const apps = APPS.filter((a) => a.bins.some(onPath))
  for (const dir of new Set([".agents/skills", ...apps.map((a) => a.skills)])) {
    fs.mkdirSync(path.join(root, dir, "flowbound"), { recursive: true })
    fs.writeFileSync(path.join(root, dir, "flowbound", "SKILL.md"), skill)
  }
  const set = apps.filter((a) => a.mcp(root)).map((a) => a.name)
  const agents = path.join(root, "AGENTS.md")
  const note = "This project uses Flowbound for GTM workflows. Before working on it, run `npx flowbound docs` and follow what it says."
  if (!fs.existsSync(agents) || !fs.readFileSync(agents, "utf8").includes("flowbound docs")) fs.appendFileSync(agents, `${fs.existsSync(agents) ? "\n" : ""}## Flowbound\n${note}\n`)

  console.log(`Flowbound is set up in this folder.${made.length ? `\n${made.map((m) => `  ${m}`).join("\n")}` : ""}`)
  console.log(set.length ? `Agent apps set up: ${[...new Set(set)].join(", ")}` : "No agent app found on this machine. The skill is in .agents/skills/flowbound for any that reads it.")
  // Start it with the project's own copy, so the first chat can go straight on.
  const started = spawnSync(process.execPath, [path.join(root, "node_modules", "flowbound", "dist", "core", "bin.js"), "keys", "--json"], { cwd: root, encoding: "utf8" })
  const url = fs.existsSync(path.join(root, ".flowbound", "server.json")) ? JSON.parse(fs.readFileSync(path.join(root, ".flowbound", "server.json"), "utf8")).url : undefined
  if (started.status !== 0 || !url) return console.log(`It did not start by itself: ${(started.stderr || started.stdout).trim()}\nStart it with: npx flowbound dev`)
  if (example) {
    // The list, then a try-out of it: no yes is needed in any mode and nothing is spent, because the example calls no provider.
    const bin = path.join(root, "node_modules", "flowbound", "dist", "core", "bin.js")
    const go = (...words: string[]) => spawnSync(process.execPath, [bin, ...words], { cwd: root, encoding: "utf8" })
    const have = go("tables", "--json")
    if (!/"example_companies"/.test(have.stdout)) go("import", path.join("examples", "example-companies.csv"), "--as", "example_companies")
    let tried = go("run", "tidy-companies", "--try", "8")
    // Set up again in a project that was already running: Flowbound restarts for the new file first.
    for (let i = 0; i < 10 && tried.status !== 0 && /starting again|no workflow called/.test(tried.stderr + tried.stdout); i++) {
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"])
      tried = go("run", "tidy-companies", "--try", "8")
    }
    console.log(
      tried.status === 0
        ? `The example ran: 8 made-up companies, tidied with plain code, $0.00. See it at ${url}/runs and ${url}/tables\nTo remove it: delete workflows/tidy-companies.ts and examples/.`
        : /already has a result/.test(tried.stderr + tried.stdout)
          ? `The example is already there: ${url}/runs and ${url}/tables`
          : `The example was written but did not run: ${(tried.stderr || tried.stdout).trim().split("\n")[0]}`,
    )
  }
  console.log(`ready · no account needed · pages at ${String(url).replace(/^https?:\/\//, "")}\nNext, for the agent: npx flowbound docs`)
  void cl
}
