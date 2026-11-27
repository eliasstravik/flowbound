// The diagram an agent draws for people, kept in the workflow file as `export const diagram = \`<svg ...>\``.
// Flowbound never draws it; it only shows it. Before a page shows it, everything that is not a plain drawing is
// taken out: scripts, event handlers, links, outside addresses, foreign content. What is left can only draw.

const TAGS = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "path", "polyline", "polygon", "text", "tspan", "title", "desc", "defs", "marker"])
const ATTRS = new Set([
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "dx",
  "dy",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
  "text-anchor",
  "dominant-baseline",
  "font-size",
  "font-weight",
  "font-family",
  "font-style",
  "role",
  "aria-label",
  "id",
  "marker-start",
  "marker-end",
  "markerwidth",
  "markerheight",
  "refx",
  "refy",
  "orient",
  "markerunits",
  "preserveaspectratio",
])
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]!)
/** A value is safe when it names nothing outside the drawing: only `url(#id)` may point anywhere, and only inside it. */
const safeValue = (v: string) => !/javascript:|data:|expression\(|@import|url\((?!\s*#[\w-]+\s*\))/i.test(v)
const CASE: Record<string, string> = { viewbox: "viewBox", markerwidth: "markerWidth", markerheight: "markerHeight", refx: "refX", refy: "refY", markerunits: "markerUnits", preserveaspectratio: "preserveAspectRatio" }

/** The drawing, with only drawing left in it; or why there is none. */
export function cleanDiagram(input: unknown): { svg?: string; problem?: string } {
  if (input === undefined || input === null || input === "") return {}
  if (typeof input !== "string") return { problem: 'diagram must be the text of an SVG drawing: export const diagram = `<svg viewBox="0 0 320 240">...</svg>`' }
  const src = input.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>/g, "")
  if (!/^\s*<svg[\s>]/i.test(src)) return { problem: "diagram must start with <svg" }
  if (src.length > 100_000) return { problem: "diagram is over 100 KB: draw the steps, not every detail" }
  const out: string[] = []
  const open: string[] = []
  let skip = 0
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
    if (m[5] !== undefined) {
      if (!skip && open.length) out.push(esc(m[5].replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (e) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" })[e]!)))
      continue
    }
    const closing = m[1] === "/"
    const tag = m[2]!.toLowerCase()
    const selfClosing = m[4] === "/"
    const allowed = TAGS.has(tag)
    if (closing) {
      // Inside something taken out, every closing tag closes one level of it.
      if (skip) {
        skip--
        continue
      }
      if (!allowed) continue
      const at = open.lastIndexOf(tag)
      if (at < 0) continue
      while (open.length > at) out.push(`</${open.pop()}>`)
      continue
    }
    if (!allowed || skip) {
      if (!selfClosing) skip++
      continue
    }
    const attrs: string[] = []
    for (const a of (m[3] ?? "").matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = a[1]!.toLowerCase()
      const value = a[2] ?? a[3] ?? a[4] ?? ""
      if (!ATTRS.has(name) || !safeValue(value)) continue
      attrs.push(`${CASE[name] ?? name}="${esc(value)}"`)
    }
    if (tag === "svg" && !open.length && !attrs.some((a) => a.startsWith("role="))) attrs.push('role="img"')
    out.push(`<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}${selfClosing ? "/>" : ">"}`)
    if (!selfClosing) open.push(tag)
  }
  while (open.length) out.push(`</${open.pop()}>`)
  const svg = out.join("")
  if (!svg.startsWith("<svg")) return { problem: "diagram has no drawing Flowbound can show" }
  return { svg }
}
