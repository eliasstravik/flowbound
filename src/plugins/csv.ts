// CSV in and out, the plain kind: commas, quotes, line breaks inside quotes.
export function fromCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  const src = text.replace(/^﻿/, "")
  const end = () => {
    row.push(cell)
    cell = ""
    if (row.some((c) => c !== "")) rows.push(row.map((c) => c.trim()))
    row = []
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === "") quoted = true
    else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      end()
    } else cell += ch
  }
  end()
  return rows
}

/**
 * Text a spreadsheet would run as a formula: it starts with = + - or @ (or a tab or a line break). A file made for a
 * spreadsheet gets a ' in front of such a cell, so a line scraped from a web page can never run on the person's
 * computer. Numbers and phone numbers (only digits, spaces and punctuation) are left as they are.
 */
const formula = (s: string) => (/^\s*[=+\-@]|^[\t\r]/.test(s) && !/^\s*[+-]?[\d\s().,-]*$/.test(s) ? `'${s}` : s)

export function toCsv(rows: unknown[][], opts: { forSheets?: boolean } = {}): string {
  const cell = (v: unknown) => {
    const text = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)
    const s = opts.forSheets ? formula(text) : text
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return `${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`
}
