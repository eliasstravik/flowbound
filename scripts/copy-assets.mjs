// Copy what is not TypeScript (pages, docs, the built style sheet, script and fonts) next to the compiled plugins.
// The design sources (src/plugins/pages/design) stay behind: build-pages.mjs already made them into pages/built.
import fs from "node:fs"
import path from "node:path"

const from = "src/plugins"
const to = "dist/plugins"
for (const file of fs.readdirSync(from, { recursive: true })) {
  const src = path.join(from, String(file))
  if (fs.statSync(src).isDirectory() || src.endsWith(".ts") || src.includes(path.join("pages", "design"))) continue
  fs.mkdirSync(path.dirname(path.join(to, String(file))), { recursive: true })
  fs.copyFileSync(src, path.join(to, String(file)))
}
fs.chmodSync("dist/core/bin.js", 0o755)
fs.chmodSync("dist/core/start.js", 0o755)
fs.copyFileSync("docs/start.md", "dist/core/start.md")
