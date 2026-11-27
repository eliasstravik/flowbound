// The command line door: one command per tool, plus init. It only talks to the running Flowbound's HTTP API.
import fs from "node:fs"
import path from "node:path"
import { type Command, type CommandLine, type Plugin, plugin, type Tool } from "../core/plugin.ts"

const flag = (name: string) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

function parse(tool: Tool, args: string[]) {
  const input: Record<string, unknown> = {}
  const specs = Object.entries(tool.input ?? {})
  const loose: string[] = []
  const opts = { live: false, json: false, help: false }
  for (let n = 0; n < args.length; n++) {
    const arg = args[n]!
    if (!arg.startsWith("--")) {
      loose.push(arg)
      continue
    }
    const [name, inline] = arg.split(/=(.*)/s) as [string, string | undefined]
    if (name === "--live" || name === "--json" || name === "--help") {
      opts[name.slice(2) as "live"] = true
      continue
    }
    const spec = specs.find(([key]) => flag(key) === name)
    if (!spec) throw new Error(`There is no ${name} here. It takes: ${specs.map(([k]) => flag(k)).join(", ") || "nothing"}`)
    input[spec[0]] = spec[1].type === "boolean" ? (inline ?? "true") : (inline ?? args[++n])
  }
  for (const [key] of specs.filter(([key, s]) => s.type !== "boolean" && !(key in input))) if (loose.length) input[key] = loose.shift()
  if (loose.length) throw new Error(`Too many words: "${loose.join(" ")}".`)
  for (const [key, spec] of specs) {
    if (spec.type !== "file" || typeof input[key] !== "string") continue
    const file = String(input[key])
    if (!fs.existsSync(file)) throw new Error(`There is no file ${file}.`)
    input[`${key}Name`] = path.basename(file)
    input[key] = fs.readFileSync(file, "utf8")
  }
  return { input, opts }
}

function commandFor(name: string, tool: Tool): Command {
  const specs = Object.entries(tool.input ?? {})
  const usage = `${name}${specs
    .filter(([, s]) => s.required)
    .map(([k]) => ` <${k}>`)
    .join("")}`
  return {
    about: tool.about.split(/(?<=[.:])\s/)[0]!.replace(/[.:]$/, ""),
    usage,
    async run(args, cl) {
      const { input, opts } = parse(tool, args)
      if (opts.help) {
        const lines = specs.map(([k, s]) => `  ${(s.required ? `<${k}>` : flag(k)).padEnd(16)}${s.about}`)
        return console.log(
          [`flowbound ${usage}`, "", tool.about, tool.price ? `Price: ${tool.price}` : "", "", ...lines, "  --live          ask the live Flowbound instead of this computer", "  --json          print the answer as JSON"]
            .filter((l, i) => l || i === 1 || i === 4)
            .join("\n"),
        )
      }
      const result = await cl.call(name, input, { live: opts.live })
      if (result?.save?.name) {
        fs.writeFileSync(path.join(process.cwd(), path.basename(result.save.name)), result.save.text)
        result.save = { name: result.save.name }
      }
      const text = !opts.json && tool.print ? tool.print(result, input) : JSON.stringify(result, null, 2)
      console.log(opts.live && !opts.json && tool.print ? text.replace(/(\n|$)/, "   live$1") : text)
    },
  }
}

export const cli = () =>
  plugin({
    name: "cli",
    commands: (plugins: Plugin[]) => ({
      init: {
        about: "set Flowbound up in this folder and start it (no account, no sign-up); --example adds a small list and a workflow that costs nothing, tried once",
        run: async (args: string[], cl: CommandLine) => (await import("./cli/init.ts")).init(args, cl),
      },
      ...Object.fromEntries(
        plugins.flatMap((p) =>
          Object.entries(p.tools ?? {})
            .filter(([, t]) => t.by !== "people")
            .map(([name, tool]) => [name, commandFor(name, tool)] as const),
        ),
      ),
    }),
    docs: `## The command line
Every tool is a command: \`flowbound <tool> [words] [--flags]\`. The words fill the tool's inputs in order; \`--help\` after any command lists them.
Add \`--json\` for the raw answer, and \`--live\` to ask the live Flowbound instead of this computer (the live token is typed on the keys page).
The commands start Flowbound in the background when it is not running. Its log is \`.flowbound/dev.log\`.`,
  })
