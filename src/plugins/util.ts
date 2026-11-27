// Small things more than one base plugin needs. Not a plugin; no plugin's code is imported here.
import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
/** The path of a page or docs file that ships beside the plugins. */
export const asset = (name: string) => path.join(here, name)
export const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex")
/** find-sales-heads -> Find sales heads */
export const title = (id: string) => id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase())
/** find-sales-heads -> findSalesHeads */
export const camel = (id: string) => id.replace(/[-_]+(.)/g, (_, c) => c.toUpperCase())
/** 0.74 -> $0.74, 0.004 -> $0.004 */
export const usd = (n: number) => {
  if (!n) return "$0.00"
  const digits = Math.abs(n) >= 0.095 ? 2 : Math.min(6, 1 - Math.floor(Math.log10(Math.abs(n))))
  return `$${n.toFixed(Math.max(2, digits)).replace(/(\.\d\d\d*?)0+$/, "$1")}`
}
export const day = (d: Date | string | number = new Date()) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
/** Keys of an object in a fixed order, so the same request always hashes the same. */
export const stable = (v: unknown): string =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`)
          .join(",")}}`
    : (JSON.stringify(v) ?? "null")
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
