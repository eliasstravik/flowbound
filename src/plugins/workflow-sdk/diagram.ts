// The diagram an agent writes for people, kept in the workflow file as a Mermaid flowchart:
//   export const diagram = `flowchart TD
//     a[Companies from your list] --> b[Find the head of sales]
//     click b findHead`
// Flowbound draws it on the page with mermaid.js in its own theme. Here it is only read: the drawing itself, and
// which box stands for which step (`click <box> <function>`). Nothing in it can run: the click lines are taken out
// before it is drawn, and so are lines that would change how Mermaid behaves (`%%{init ...}%%`).

export type Diagram = {
  /** The flowchart as Mermaid reads it, without the click lines. */
  source?: string
  /** Each box tied to a step: the box's name in the chart and the "use step" function behind it. */
  clicks: { node: string; fn: string }[]
  /** Why the diagram cannot be shown, when it cannot. */
  problem?: string
}

const CLICK = /^\s*click\s+([A-Za-z0-9_-]+)\s+(?:call\s+)?([A-Za-z_$][\w$]*)(?:\(\))?\s*(?:"[^"]*")?\s*;?\s*$/
/** Read the agent's diagram: the chart to draw, and the boxes tied to steps. */
export function readDiagram(input: unknown): Diagram {
  if (input === undefined || input === null || input === "") return { clicks: [] }
  const shape = "diagram must be a Mermaid flowchart: export const diagram = `flowchart TD\n  a[Your list] --> b[A step]\n  click b yourStep`"
  if (typeof input !== "string") return { clicks: [], problem: shape }
  if (input.length > 50_000) return { clicks: [], problem: "diagram is over 50 KB: draw the steps, not every detail" }
  const lines = input.replace(/\r/g, "").split("\n")
  const first = lines.find((l) => l.trim() && !l.trim().startsWith("%%"))?.trim() ?? ""
  if (!/^(flowchart|graph)(\s+(TD|TB|BT|LR|RL))?\s*;?$/i.test(first)) return { clicks: [], problem: shape.replace("must be", "must start with flowchart TD: it is") }
  const clicks: Diagram["clicks"] = []
  const kept: string[] = []
  for (const line of lines) {
    if (/^\s*%%\s*\{/.test(line)) continue
    if (/^\s*click\s/.test(line)) {
      const m = CLICK.exec(line)
      // Only a box tied to a function of the file is kept; a link or anything else is dropped.
      if (m && !/^(href|callback)$/.test(m[2]!)) clicks.push({ node: m[1]!, fn: m[2]! })
      continue
    }
    kept.push(line)
  }
  return { source: kept.join("\n").trim(), clicks }
}

/** The "use step" functions of a file, in the order written. */
export const stepsOf = (text: string) => [...text.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{\s*(?:\/\/[^\n]*\n\s*)*["']use step["']/g)].map((m) => m[1]!)
