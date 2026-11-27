import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "./plugin.ts"

export function docs(list: Plugin[], topic?: string) {
  const read = (document: string) => (document.endsWith(".md") && !document.includes("\n") && fs.existsSync(document) ? fs.readFileSync(document, "utf8") : document)
  const pages = list.filter((part) => part.docs).map((part) => ({ name: part.name, text: read(part.docs!).trim() }))
  const guides = Object.fromEntries(list.flatMap((part) => Object.entries(part.guides ?? {})))
  const here = path.dirname(fileURLToPath(import.meta.url))
  const nearby = path.join(here, "start.md")
  const core = fs.readFileSync(fs.existsSync(nearby) ? nearby : path.join(here, "..", "..", "docs", "start.md"), "utf8").trim()
  if (topic === "start") return core
  if (topic === "topics") return ["start", ...pages.map((part) => part.name), ...Object.keys(guides)].join(", ")
  if (topic)
    return (
      pages.find((part) => part.name === topic)?.text ?? (guides[topic] ? read(guides[topic]).trim() : `No docs for "${topic}". Topics: ${["start", ...pages.map((part) => part.name), ...Object.keys(guides)].join(", ")}`)
    )
  return [core, ...pages.map((part) => part.text)].join("\n\n")
}
