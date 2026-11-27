// Prints the SQL for the tables Better Auth (the engine under the door) wants and the door's table changes do not
// make yet. After upgrading better-auth: run this, and add what it prints as a new entry at the end of the list in
// src/plugins/door/engine-tables.ts. Empty output: nothing to do.
//   node scripts/door-tables.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { getMigrations } from "better-auth/db/migration"
import { plugin } from "../src/core/plugin.ts"
import { boot } from "../src/core/server.ts"
import { door } from "../src/plugins/door.ts"

export async function wanted() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-door-tables-"))
  process.env.FLOWBOUND_SECRET ??= "only-for-reading-the-tables"
  const db = new PGlite()
  const records = plugin({
    name: "records",
    provides: "records",
    async start(fb) {
      for (const p of fb.plugins) for (const sql of p.migrations ?? []) await db.exec(`create schema if not exists fb_${p.name}; ${sql}`)
      return { query: async (sql: string, params?: unknown[]) => ((r) => ({ rows: r.rows, count: r.affectedRows ?? r.rows.length, columns: r.fields.map((f) => f.name) }))(await db.query(sql, params as any[])) }
    },
  })
  const app = await boot([records, door({ password: "x" })], { root, url: "https://flowbound.example", live: true })
  try {
    const m = await getMigrations(app.fb.use("door").engine().options)
    const todo = m.toBeCreated.length + m.toBeAdded.length
    return { sql: todo ? (await m.compileMigrations()).trim() : "", todo }
  } finally {
    await app.stop()
    await db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) process.stdout.write((await wanted()).sql)
