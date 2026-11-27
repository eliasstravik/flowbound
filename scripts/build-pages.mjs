// Build what the pages look like: one style sheet, one script and the fonts, made once here so nobody who uses
// Flowbound has a build step. Sources are in src/plugins/pages/design; the result lands in src/plugins/pages/built
// (not in git; copy-assets takes it to dist). See docs/decisions.md, "Design".
//   node scripts/build-pages.mjs            build
//   node scripts/build-pages.mjs --sizes    build and print what it weighs
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import zlib from "node:zlib"
import * as esbuild from "esbuild"

const require = createRequire(import.meta.url)
const design = "src/plugins/pages/design"
const built = "src/plugins/pages/built"
const basecoat = path.dirname(require.resolve("basecoat-css/package.json"))

// The Basecoat parts the pages use. Each is one structure file and one section of the style pack; the rest of
// the pack (some fifty parts) is left out, so the style sheet stays small.
const PARTS = ["Button", "Card", "Badge", "Alert", "Empty", "Input", "Label", "Native Select", "Table", "Dialog", "Progress", "Skeleton"]
const file = (part) => part.toLowerCase().replace(/ /g, "-")
const pack = fs.readFileSync(path.join(basecoat, "dist/styles/vega.css"), "utf8")
/** One part's rules out of the style pack: from its `/* Name *\/` line to the next part's. */
function section(part) {
  const lines = pack.split("\n")
  const start = lines.findIndex((l) => l.trim() === `/* ${part} */`)
  if (start < 0) throw new Error(`Basecoat's style pack has no "${part}" section: its layout changed, look at dist/styles/vega.css.`)
  let end = lines.findIndex((l, i) => i > start && /^ {0,2}\/\* [A-Z][A-Za-z ]+ \*\/$/.test(l))
  if (end < 0) end = lines.lastIndexOf("}")
  return lines.slice(start + 1, end).join("\n")
}

/** Basecoat styles `.input` and a bare input inside `.field` with one selector per type (text, email, ...): 28 of them,
    written out again for every state, a fifth of the sheet. The pages always write class="input", so one says it all. */
const slim = (css) => {
  const out = css.replace(/^\s*\.(field > input|input\[type=).*,\n/gm, "").replace(/\.input:not\(\[type\]\)/g, ".input")
  if (!/^\s*\.input \{/m.test(out) || /field > input/.test(out)) throw new Error("Basecoat's input rules changed shape: look at dist/components/input.css and slim() here.")
  return out
}

fs.rmSync(built, { recursive: true, force: true })
fs.mkdirSync(built, { recursive: true })
const rel = (p) => path.relative(built, p).replaceAll("\\", "/")
const entry = path.join(built, "entry.css")
fs.writeFileSync(
  entry,
  [
    `@import "tailwindcss" source(none);`,
    `@source "${rel("src/plugins")}/**/*.html";`,
    `@source "${rel("src/plugins")}/pages.ts";`,
    `@source "${rel(design)}/*.js";`,
    `@import "${rel(path.join(basecoat, "dist/base/base.css"))}";`,
    ...PARTS.filter((p) => p !== "Input").map((p) => `@import "${rel(path.join(basecoat, `dist/components/${file(p)}.css`))}";`),
    slim(fs.readFileSync(path.join(basecoat, "dist/components/input.css"), "utf8")),
    `@layer components {\n${PARTS.map((p) => (p === "Input" ? slim(section(p)) : section(p))).join("\n")}\n}`,
    fs.readFileSync(path.join(design, "style.css"), "utf8"),
  ].join("\n"),
)
execFileSync(process.execPath, [path.join(path.dirname(require.resolve("@tailwindcss/cli/package.json")), "dist/index.mjs"), "-i", entry, "-o", path.join(built, "page.css"), "--minify"], {
  stdio: ["ignore", "ignore", "inherit"],
})
fs.rmSync(entry)

await esbuild.build({ entryPoints: [path.join(design, "app.js")], bundle: true, minify: true, format: "iife", target: "es2022", loader: { ".svg": "text" }, outfile: path.join(built, "page.js"), logLevel: "error" })
// Mermaid draws the workflow diagrams. One file, loaded only by a workflow's page, kept by the browser like the rest.
await esbuild.build({ entryPoints: [path.join(design, "mermaid.js")], bundle: true, minify: true, format: "iife", target: "es2022", outfile: path.join(built, "mermaid.js"), logLevel: "error", legalComments: "none" })
fs.copyFileSync(path.join(path.dirname(require.resolve("mermaid/package.json")), "LICENSE"), path.join(built, "MERMAID-LICENSE.txt"))
await esbuild.build({ entryPoints: [path.join(design, "bridge.js")], bundle: true, minify: true, format: "iife", target: "es2022", outfile: path.join(built, "app.js"), logLevel: "error" })

// Geist, the letters most lists need: latin, and latin-extended for names like Łódź (fetched only when a page has one).
const font = (pkg, name) => require.resolve(`@fontsource-variable/${pkg}/files/${name}-wght-normal.woff2`)
fs.copyFileSync(font("geist", "geist-latin"), path.join(built, "geist.woff2"))
fs.copyFileSync(font("geist", "geist-latin-ext"), path.join(built, "geist-ext.woff2"))
fs.copyFileSync(font("geist-mono", "geist-mono-latin"), path.join(built, "geist-mono.woff2"))
fs.copyFileSync(path.join(path.dirname(require.resolve("@fontsource-variable/geist/package.json")), "LICENSE"), path.join(built, "GEIST-LICENSE.txt"))

if (process.argv.includes("--sizes"))
  for (const f of fs.readdirSync(built).filter((f) => !f.endsWith(".txt"))) {
    const bytes = fs.readFileSync(path.join(built, f))
    console.log(`${f.padEnd(18)} ${String(bytes.length).padStart(7)} bytes   ${String(zlib.gzipSync(bytes, { level: 9 }).length).padStart(6)} zipped`)
  }
