// Every pair of text and ground the design's tokens allow, and its contrast: at least 4.5 to 1 for text.
//   node test/design/contrast.mjs        (reads src/plugins/pages/design/style.css; fails on a pair below 4.5)
import fs from "node:fs"

const css = fs.readFileSync(new URL("../../src/plugins/pages/design/style.css", import.meta.url), "utf8")
const block = (selector) => Object.fromEntries([...css.slice(css.indexOf(`${selector} {`)).split("}")[0].matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const hex = (v) => {
  const h = v.replace("#", "")
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16))
}
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
/** A colour laid over a ground at some strength: the tint a badge sits on. */
const over = (top, ground, share) => top.map((c, i) => Math.round(c * share + ground[i] * (1 - share)))

let low = 0
for (const [name, selector] of [["light", ":root"], ["dark", ".dark"]]) {
  const t = block(selector)
  const c = (k) => hex(t[k])
  const pairs = [
    ["text on the page", c("foreground"), c("background")],
    ["quiet text on the page", c("muted-foreground"), c("background")],
    ["quiet text on a well", c("muted-foreground"), c("muted")],
    ["quiet text in the sidebar", c("muted-foreground"), c("sidebar")],
    ["text on a hovered row", c("foreground"), c("accent")],
    ["the main button", c("primary-foreground"), c("primary")],
    ["an error", c("destructive"), c("background")],
    ["done, on the page", c("ok"), c("background")],
    ["running, on the page", c("running"), c("background")],
    ["a warning, on the page", c("warn"), c("background")],
    ["a saved badge", c("ok"), over(c("ok"), c("background"), 0.12)],
    ["a missing badge", c("warn"), over(c("warn"), c("background"), 0.12)],
  ]
  for (const [what, a, b] of pairs) {
    const r = ratio(a, b)
    if (r < 4.5) low++
    console.log(`${name.padEnd(6)} ${what.padEnd(28)} ${r.toFixed(2)}${r < 4.5 ? "   TOO LOW" : ""}`)
  }
}
process.exit(low ? 1 : 0)
