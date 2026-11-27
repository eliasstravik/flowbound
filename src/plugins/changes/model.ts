import type { Who } from "../../core/plugin.ts"
import { Refused } from "../../core/server.ts"

export type Edit = { path: string; text: string | null }
export type Check = { name: string; state: "waiting" | "passed" | "failed"; url?: string }
export type Change = {
  id: string
  title: string
  branch: string
  head: string
  state: "open" | "published" | "closed"
  checks: Check[]
  blocked?: string
  external?: boolean
  pull?: string
  preview?: string
  previewState?: string
  published?: string
  page?: string
}
export type Save = { title: string; head: string; edits: Edit[]; id?: string }
export type Repository = {
  list: (published?: boolean) => Promise<Change[]>
  read: (id: string | undefined, file: string) => Promise<{ head: string; text: string | null }>
  change: (id: string) => Promise<Change>
  save: (input: Save, who: Who) => Promise<Change>
  publish: (id: string, head: string, who: Who) => Promise<Change>
  undo: (id: string, who: Who) => Promise<Change>
  preview?: (id: string, head: string) => Promise<Change>
}
export const branchPrefix = "flowbound/"
export const shaPattern = /^[0-9a-f]{40}$/
export const checkNames = ["types", "workflows", "tests"]
export const workflowFile = /^workflows\/(?:[A-Za-z0-9][A-Za-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.ts$/
export const stale = () => new Refused("This change moved. Read the latest version before trying again.", undefined, 409)
export const lines = (s: string) => s.trim().split("\n").filter(Boolean)
export const plain = (s: string) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim()
export const attributed = (who: Who) => plain(who.personName ?? (who.email ? who.name.replace(` (${who.email})`, "") : who.name)).slice(0, 120)
export const authorLine = (who: Who) => `Requested by ${attributed(who)}${who.checked === false ? " (name not checked)" : ""}.`
export const link = (value: unknown, host: (host: string) => boolean) => {
  if (typeof value !== "string") return undefined
  try {
    const u = new URL(value)
    if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && host(u.hostname)) return u.href
  } catch {}
  return undefined
}
