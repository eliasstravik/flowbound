// Context: what the agent should know, as whatever files and folders are in context/. No set kinds: a company page,
// ICPs, personas, a pricing sheet, notes. The agent writes them; people read them on the Context page; the agent
// reads them before it writes a workflow or answers. Live, the files deployed with the project are read.
import fs from "node:fs"
import path from "node:path"
import { type Flowbound, plugin } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import { asset } from "./util.ts"
import { editorHere, openInEditor } from "./workflow-sdk/open.ts"

export type ContextFile = { path: string; text: string }
/** A file bigger than this is not read (it is not something to read on a page or in a chat). */
const MOST_BYTES = 1_000_000
/** Folders this deep and no deeper. */
const DEEPEST = 8
const MARKDOWN = /\.(md|markdown|mdx)$/i

/** Every text file under context/, by its path inside it ("market-research/icp.md"). Hidden files and binaries are left out. */
export function contextFiles(root: string): ContextFile[] {
  const out: ContextFile[] = []
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue
      const file = path.join(dir, e.name)
      const at = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth < DEEPEST) walk(file, at, depth + 1)
        continue
      }
      if (!e.isFile() || fs.statSync(file).size > MOST_BYTES) continue
      const bytes = fs.readFileSync(file)
      if (bytes.subarray(0, 8000).includes(0)) continue
      out.push({ path: at, text: bytes.toString("utf8") })
    }
  }
  walk(path.join(root, "context"), "", 0)
  return out
}

/** The line under a file's name: its front matter's description, else its first line of plain text. */
export function lineOf(file: ContextFile): string {
  const text = file.text.replace(/\r\n?/g, "\n")
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)
  const said = front && /^(?:description|summary):\s*["']?(.+?)["']?\s*$/m.exec(front[1]!)
  if (said) return said[1]!.slice(0, 160)
  const body = front ? text.slice(front[0].length) : text
  const md = MARKDOWN.test(file.path)
  for (const raw of body.split("\n")) {
    const l = raw.trim()
    if (!l || (md && /^(#|```|~~~|---|\||<!--)/.test(l))) continue
    const plain = md
      ? l
          .replace(/^([-*+]|\d+[.)]|>)\s+/, "")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/[*_`]/g, "")
      : l
    return plain.length > 160 ? `${plain.slice(0, 157)}...` : plain
  }
  return ""
}

/** "market-research/icp.md", checked: inside context/, no way out of it. */
const cleanPath = (p: unknown) => {
  const s = String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^context\//, "")
  if (!s || s.split("/").some((part) => !part || part === "." || part === "..")) throw new Refused(`"${p}" is not a file in context/. Give its path inside context/, like company.md or market-research/icp.md.`)
  return s
}

export const context = () => {
  let fb: Flowbound
  /** Live on a host, the files that were deployed; on your own computer (and a server of your own) the folder itself. */
  const files = (): ContextFile[] => (globalThis as any)[Symbol.for("flowbound")]?.built?.context ?? contextFiles(fb.root)

  return plugin({
    name: "context",
    provides: "context",
    start(f) {
      fb = f
      return { files }
    },
    tools: {
      context: {
        about:
          "What you should know about the company and its market, as files in context/ (a company page, ICPs, personas, pricing, notes: any files, in any folders). Without path: every file with its folder and first line; with search, only files that mention it. With path: the whole file. Read it before you write a workflow or answer a question about the company.",
        role: "viewer",
        input: {
          path: { about: "one file's path inside context/, like company.md or market-research/icp.md" },
          search: { about: "only files whose name or text has these words" },
        },
        run: (i) => {
          const all = files()
          if (i.path) {
            const p = cleanPath(i.path)
            const f = all.find((x) => x.path === p)
            if (!f) throw new Refused(`There is no context/${p}. Files: ${all.map((x) => x.path).join(", ") || "none yet"}`)
            return {
              path: f.path,
              file: `context/${f.path}`,
              kind: MARKDOWN.test(f.path) ? "markdown" : "text",
              text: f.text,
              open: { editor: fb.live ? null : (editorHere()?.name ?? null) },
              page: `${fb.url}/context?file=${encodeURIComponent(f.path)}`,
            }
          }
          const words = String(i.search ?? "")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean)
          return all
            .filter((f) => words.every((w) => `${f.path}\n${f.text}`.toLowerCase().includes(w)))
            .map((f) => ({ path: f.path, folder: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "", name: path.basename(f.path), line: lineOf(f) }))
        },
        print: (r: any) =>
          Array.isArray(r)
            ? r.length
              ? r.map((f: any) => `context/${f.path}${f.line ? `   ${f.line}` : ""}`).join("\n")
              : "Nothing in context/ yet. Write down what you should know there, one file per thing: context/company.md, context/icps/<name>.md."
            : r.text,
      },
      "context-open": {
        about: "Open a file of context in the person's editor, on the computer Flowbound runs on. Only on your own computer.",
        by: "people",
        input: { path: { about: "the file's path inside context/", required: true } },
        run: async (i) => {
          if (fb.live) throw new Refused("A file opens in an editor on your own computer. Here it is read on the Context page.")
          const p = cleanPath(i.path)
          const file = path.join(fb.root, "context", p)
          if (!fs.existsSync(file)) throw new Refused(`There is no context/${p}.`)
          const editor = editorHere()
          if (!editor) throw new Refused(`No editor was found on this computer. The file is ${file}. Name your editor's command in FLOWBOUND_EDITOR.`, { code: "no-editor", file })
          await openInEditor(editor, file, 1).catch((e) => {
            throw new Refused(`${e.message}. The file is ${file}`, { code: "no-editor", file })
          })
          return { opened: file, with: path.basename(editor.name) }
        },
        print: (r) => `Opened ${r.opened} in ${r.with}`,
      },
    },
    pages: { "/context": { title: "Context", file: asset("context/context.html"), menu: true, order: 6 } },
    docs: asset("context/context.md"),
  })
}
