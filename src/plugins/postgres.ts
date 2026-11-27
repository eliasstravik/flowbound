// Records: the agent's own tables in Postgres. PGlite in a folder on your computer; a database address when live.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { can, type Flowbound, type Plugin, plugin, type Who } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import { fromCsv, toCsv } from "./csv.ts"
import { canFetch, consoleOf, type Studio, startStudio } from "./postgres/studio.ts"
import { asset } from "./util.ts"

export type Picked = { value: unknown; fact: number | null }
export type Records = {
  /** Run any SQL. Params are $1, $2, ... */
  query: <T = any>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; count: number; columns: string[] }>
  tables: () => Promise<{ name: string; rows: number; origin: string; kind: string; list?: string; workflow?: string; folder?: string }[]>
  /** `folder`: the folder under workflows/ it belongs with on the Data page ("tam-mapping"). Kept by Flowbound, not in the database. */
  importCsv: (o: { csv: string; file?: string; as?: string; add?: boolean; key?: string; folder?: string }) => Promise<{ name: string; rows: number; added: number; updated: number }>
  /**
   * Add rows to a list from a step or a tool: one row in, many rows out (a company's five people into `people_list`).
   * The list and any new column are made as needed. With `key`, a row whose key is already there is brought up to
   * date instead of added again, so a step that runs twice leaves no doubles.
   */
  add: (list: string, rows: Record<string, unknown>[], o?: { key?: string; origin?: string }) => Promise<{ added: number; updated: number }>
  addRow: (list: string, row: Record<string, unknown>, origin: string) => Promise<number>
  results: (into: string, list: string, workflow: string, title: string) => Promise<void>
  count: (list: string, into: string) => Promise<{ all: number; done: number }>
  save: (into: string, id: number, fields: Record<string, unknown>) => Promise<void>
  read: (name: string, o?: { limit?: number; offset?: number; search?: string; sort?: string; desc?: boolean }) => Promise<TableView>
  /** What the database is, for a plug-in that hands it to a database tool: a Postgres at an address, or the PGlite this process holds. */
  engine: () => Engine
}
export type Engine = { kind: "postgres"; url: string } | { kind: "pglite"; db: unknown; dir: string }
export type PostgresOptions = {
  url?: string
  /**
   * For when the pages are opened from another device: the private name and port Drizzle Studio is shared at (for
   * example with `tailscale serve --https=4983 http://127.0.0.1:4983`). Studio's page then talks to that address.
   * Unset: Studio is for a browser on the computer Flowbound runs on.
   */
  studio?: { host?: string; port?: number }
}
export type TableView = {
  name: string
  kind: string
  origin: string
  workflow?: string
  total: number
  /** With a search: how many rows it found. `total` stays the whole table. */
  found?: number
  columns: { name: string; of: "list" | "result" | "table" | "own" }[]
  rows: { id: number | null; cells: unknown[]; facts: (number | null)[] }[]
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Refused(`"${name}" is not a table or column name Flowbound can use: lower-case letters, digits and _ only.`)
  return `"${name}"`
}
export const snake = (s: string) =>
  s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1")
    .slice(0, 60)
/** targets.csv -> target_list */
export const listName = (file: string) => {
  const base = snake(path.basename(file).replace(/\.[^.]+$/, "")) || "my"
  return /_?list$/.test(base) ? base : `${base.replace(/([^s])s$/, "$1")}_list`
}
const isPicked = (v: unknown): v is Picked => !!v && typeof v === "object" && "value" in v && "fact" in v && Object.keys(v).length === 2

type Driver = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; affectedRows?: number; rowCount?: number | null; fields: { name: string }[] }>
  exec: (sql: string) => Promise<unknown>
  /** One statement, run as the reader: it cannot change anything and sees only the person's own tables. */
  readOnly: (sql: string) => Promise<{ rows: any[] }>
  /** Make (or bring up to date) the reader. Run after every plug-in's tables are made. */
  wall: () => Promise<void>
  alone: <T>(fn: (d: Pick<Driver, "query" | "exec">) => Promise<T>) => Promise<T>
  close: () => Promise<unknown>
  engine: Engine
}

/**
 * The reader: the database role an agent's read-only SQL runs as. It may read the person's own tables in `public`
 * and nothing else: Flowbound's own schemas (`fb_*`, the runner's `workflow`) were never opened to it, so the
 * database itself refuses them, however the query is written (a schema name, a view, a CTE, a function).
 * Tables made later in `public` are opened to it as they are made (default privileges).
 */
const grantsFor = (role: string) =>
  [`grant usage on schema public to ${role}`, `grant select on all tables in schema public to ${role}`, `alter default privileges in schema public grant select on tables to ${role}`].join("; ")
const READER = "flowbound_reader"

async function open(fb: Flowbound, opts: { url?: string }): Promise<Driver> {
  const url = opts.url ?? process.env.DATABASE_URL
  if (url) {
    const { default: pg } = await import("pg")
    pg.types.setTypeParser(20, Number)
    pg.types.setTypeParser(1700, Number)
    const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000 })
    pool.on("error", () => {})
    // Postgres: the reader is a login of its own. Switching role on Flowbound's own connection would not hold: a
    // role can always switch back to the login it came in on (`set role`, or set_config inside one statement).
    // Its password is worked out from the database login, so every copy of a live Flowbound agrees on it and
    // nothing is stored; whoever has the address has the whole database anyway.
    let reader: InstanceType<typeof pg.Pool> | undefined
    let wallDown = "it has not been set up yet"
    // Live, several copies of Flowbound can start at the same moment. One at a time may change tables.
    // The lock lives and dies with one transaction: a pooled database address (Neon's, PgBouncer) hands every
    // transaction to whichever connection is free, so a lock held across them would never be given back.
    const alone: Driver["alone"] = async (fn) => {
      const c = await pool.connect()
      try {
        await c.query("begin")
        await c.query("select pg_advisory_xact_lock(7275041)")
        const out = await fn({ query: (sql, params) => c.query(sql, params as any[]), exec: (sql) => c.query(sql) })
        await c.query("commit")
        return out
      } catch (e) {
        await c.query("rollback").catch(() => {})
        throw e
      } finally {
        c.release()
      }
    }
    const wall = async () => {
      try {
        const { name, password } = await alone(async (d) => {
          const me = (await d.query("select current_database() as db, current_user as me")).rows[0]
          // Roles belong to the whole server, which may hold other databases: one reader per database and owner.
          const name = `${READER}_${crypto.createHash("md5").update(`${me.db}\n${me.me}`).digest("hex").slice(0, 12)}`
          // From the login and its password, not the host: the pooled and the direct address must agree on it.
          const owner = new URL(url)
          const password = crypto
            .createHmac("sha256", owner.password ? `${owner.username}:${owner.password}` : url)
            .update(`flowbound reader ${name}`)
            .digest("hex")
          const there = (await d.query("select 1 from pg_roles where rolname = $1", [name])).rows.length > 0
          // A role that may make roles may not name superuser rights at all when it changes one, not even to say no.
          await d.exec(there ? `alter role ${name} with login password '${password}'` : `create role ${name} with login nosuperuser nocreatedb nocreaterole noinherit password '${password}'`)
          await d.exec(`grant connect on database "${String(me.db).replace(/"/g, `""`)}" to ${name}; ${grantsFor(name)}`)
          await d.exec(`alter role ${name} set default_transaction_read_only = on`)
          return { name, password }
        })
        const at = new URL(url)
        at.username = name
        at.password = password
        await reader?.end()
        reader = new pg.Pool({ connectionString: at.toString(), max: 3, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000 })
        reader.on("error", () => {})
        wallDown = ""
      } catch (e: any) {
        wallDown = `the database would not make a reader for it (${e?.message ?? e}). The database login needs the right to make roles (CREATEROLE)`
      }
    }
    const readOnly = async (sql: string) => {
      // Fail closed: without the reader, no read-only SQL at all rather than SQL that sees everything.
      if (!reader || wallDown) throw new Refused(`SQL for agents is off here: ${wallDown}.`)
      const c = await reader.connect()
      try {
        await c.query("begin read only")
        // One statement only (the extended protocol takes no more), so nothing can be added after it.
        return await c.query({ text: sql, queryMode: "extended" } as any)
      } finally {
        await c.query("rollback").catch(() => {})
        c.release()
      }
    }
    return {
      query: (sql, params) => pool.query(sql, params as any[]),
      exec: (sql) => pool.query(sql),
      readOnly,
      wall,
      alone,
      close: async () => {
        await reader?.end()
        await pool.end()
      },
      engine: { kind: "postgres", url },
    }
  }
  if (fb.live) throw new Refused("A live Flowbound needs a database address in DATABASE_URL.")
  const { PGlite, types } = await import("@electric-sql/pglite")
  const dir = path.join(fb.root, ".flowbound", "pg")
  fs.mkdirSync(dir, { recursive: true })
  const db = new PGlite(dir, { parsers: { [types.INT8]: Number, [types.NUMERIC]: Number } })
  await db.waitReady
  // PGlite has one login, and it is the superuser, so the reader is a role switched to inside the transaction. A role
  // can switch back to its login, so the two ways to do that from inside one statement are closed to everybody but
  // the superuser: set_config (setting `role` from a select) and plpgsql (a DO block running `set role`). Neither
  // is used by Flowbound outside the superuser. The extended protocol takes one statement, so nothing follows it.
  const wall = async () => {
    await db.exec(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${READER}') then create role ${READER} nologin; end if; end $$`)
    await db.exec(`${grantsFor(READER)}; revoke execute on function pg_catalog.set_config(text, text, boolean) from public; revoke usage on language plpgsql from public`)
  }
  const readOnly = (sql: string) =>
    db.transaction(async (tx) => {
      await tx.exec(`set transaction read only; set local role ${READER}`)
      const r = await tx.query(sql)
      await tx.rollback()
      return r as { rows: any[] }
    }) as Promise<{ rows: any[] }>
  const self: Driver = {
    query: (sql, params) => db.query(sql, params as any[]),
    exec: (sql) => db.exec(sql),
    readOnly,
    wall,
    alone: (fn) => fn(self),
    close: () => db.close(),
    engine: { kind: "pglite", db, dir },
  }
  return self
}

/** Apply every plugin's own table changes, once each. Returns how many were new. */
async function migrate(db: Pick<Driver, "query" | "exec">, plugins: Plugin[]): Promise<number> {
  await db.exec("create schema if not exists fb_postgres; create table if not exists fb_postgres.migrations (plugin text, n int, at timestamptz default now(), primary key (plugin, n))")
  const done = new Set((await db.query("select plugin, n from fb_postgres.migrations")).rows.map((r) => `${r.plugin}:${r.n}`))
  let applied = 0
  for (const p of plugins) {
    if (!p.migrations?.length) continue
    await db.exec(`create schema if not exists fb_${snake(p.name)}`)
    for (const [n, sql] of p.migrations.entries()) {
      if (done.has(`${p.name}:${n}`)) continue
      await db.exec(sql)
      await db.query("insert into fb_postgres.migrations (plugin, n) values ($1, $2)", [p.name, n])
      applied++
    }
  }
  return applied
}

/** A folder under workflows/ as Flowbound writes it: tam-mapping/nordics. */
const folderOf = (v: unknown) => {
  const f = String(v ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/^workflows\//, "")
  if (!f) return null
  if (!f.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(part)) || f.split("/").length > 8)
    throw new Refused(`"${f}" is not a folder Flowbound can use: the folder's path under workflows/, like tam-mapping or tam-mapping/nordics.`)
  return f
}
/** A value of one of Flowbound's own tables, as a cell: JSON as its text, a time as it is written. */
const plainCell = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : v)

/** The most rows the table tool answers at once: pages and agents read a big table a part at a time. */
const MOST_ROWS = 500
/** A CSV bigger than this is not sent into an agent's chat: it gets the way to the file instead. */
const MOST_CHAT_BYTES = 50_000

export const postgres = (opts: PostgresOptions = {}) => {
  let fb: Flowbound
  let db: Driver
  let applied = 0
  let studio: Promise<Studio> | undefined
  /** Flowbound's own tables people may read: "fb_ledger.facts" -> what it holds. Named by the plug-ins that make them. */
  const own = () => Object.assign({}, ...fb.plugins.map((p) => p.own ?? {})) as Record<string, string>
  const columns = new Map<string, Set<string>>()

  const query: Records["query"] = async (sql, params) => {
    const r = await db.query(sql, params)
    return { rows: r.rows ?? [], count: r.affectedRows ?? r.rowCount ?? r.rows?.length ?? 0, columns: (r.fields ?? []).map((f) => f.name) }
  }
  const cols = async (table: string) => {
    let set = columns.get(table)
    if (!set) {
      const r = await query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [table])
      set = new Set(r.rows.map((x) => x.column_name))
      if (set.size) columns.set(table, set)
    }
    return set
  }
  const note = (name: string, kind: string, origin: string, list?: string, workflow?: string, folder?: string | null) =>
    query(
      "insert into fb_postgres.tables (name, kind, origin, list, workflow, folder) values ($1, $2, $3, $4, $5, $6) on conflict (name) do update set kind = $2, origin = $3, list = $4, workflow = $5, folder = coalesce($6, fb_postgres.tables.folder)",
      [name, kind, origin, list ?? null, workflow ?? null, folder ?? null],
    )
  const makeList = async (name: string, fields: string[], origin: string, folder?: string | null) => {
    const have = await cols(name)
    if (!have.size) {
      await db.exec(`create table ${ident(name)} (id bigserial primary key${fields.map((f) => `, ${ident(f)} text`).join("")})`)
      await note(name, "list", origin, undefined, undefined, folder)
    } else {
      for (const f of fields) if (!have.has(f)) await db.exec(`alter table ${ident(name)} add column ${ident(f)} text`)
      if (folder) await query("update fb_postgres.tables set folder = $2 where name = $1", [name, folder])
    }
    columns.delete(name)
  }
  /**
   * Put rows into a list, making the list or its new columns first. With `key` (a column), a row whose key is already
   * in the list is the same row: its other columns are brought up to date and no second row is made. Keys are compared
   * without capitals and outer spaces, as webhook rows are. A row with an empty key is always a new row.
   */
  const putRows = async (name: string, fields: string[], rows: (string | null | undefined)[][], origin: string, key?: string, folder?: string | null) => {
    await makeList(name, fields, origin, folder)
    const insert = async (part: (string | null | undefined)[][]) => {
      for (let i = 0; i < part.length; i += 200) {
        const some = part.slice(i, i + 200)
        const values = some.map((_, r) => `(${fields.map((_, c) => `$${r * fields.length + c + 1}`).join(", ")})`).join(", ")
        await query(
          `insert into ${ident(name)} (${fields.map(ident).join(", ")}) values ${values}`,
          some.flatMap((row) => fields.map((_, c) => row[c] ?? null)),
        )
      }
    }
    if (!key) return (await insert(rows), { added: rows.length, updated: 0 })
    const k = snake(key)
    const at = fields.indexOf(k)
    if (at < 0) throw new Refused(`The key column "${key}" is not in these rows. Their columns: ${fields.join(", ")}.`)
    const norm = (v: unknown) =>
      String(v ?? "")
        .trim()
        .toLowerCase()
    const have = new Map<string, number | null>((await query(`select id, ${ident(k)} as k from ${ident(name)} where ${ident(k)} is not null`)).rows.map((r: any) => [norm(r.k), Number(r.id)]))
    const fresh: (string | null | undefined)[][] = []
    const others = fields.filter((f) => f !== k)
    let updated = 0
    for (const row of rows) {
      const mine = norm(row[at])
      if (!mine) fresh.push(row)
      else if (!have.has(mine)) have.set(mine, null), fresh.push(row)
      else {
        // Known already: say only what this row knows. An empty cell never wipes what the list has.
        const id = have.get(mine)
        const set = others.filter((f) => String(row[fields.indexOf(f)] ?? "") !== "")
        if (id !== null && id !== undefined && set.length)
          await query(`update ${ident(name)} set ${set.map((f, i) => `${ident(f)} = $${i + 2}`).join(", ")} where id = $1`, [id, ...set.map((f) => row[fields.indexOf(f)])])
        updated++
      }
    }
    await insert(fresh)
    return { added: fresh.length, updated }
  }
  const heads = (raw: string[]) => {
    const seen = new Set<string>(["id"])
    return raw.map((h, i) => {
      let name = snake(h) || `column_${i + 1}`
      while (seen.has(name)) name = `${name}_`
      seen.add(name)
      return name
    })
  }

  /**
   * One of Flowbound's own tables, read-only: only those a plug-in names in `own`, never sign-ins or keys. Newest
   * first. Searched and sorted in the database, like your own tables.
   */
  const readOwn = async (name: string, o: { limit: number; offset: number; search: string; sort: string; desc: boolean }): Promise<TableView> => {
    const about = own()[name]
    const [schema, table] = name.split(".")
    if (!about || !schema || !table) throw new Refused(`There is no table called ${name}. See them with: npx flowbound tables`)
    const have = (await query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position", [schema, table])).rows.map(
      (r) => r.column_name,
    )
    if (!have.length) throw new Refused(`There is no table called ${name}.`)
    const from = `${ident(schema)}.${ident(table)} t`
    const total = (await query(`select count(*)::int as n from ${from}`)).rows[0].n
    const view: TableView = { name, kind: "own", origin: about, total, columns: have.map((c) => ({ name: c, of: "own" as const })), rows: [] }
    const words = o.search.trim()
    const where = words ? `where position(lower($3) in lower(concat_ws(' ', ${have.map((c) => `t.${ident(c)}::text`).join(", ")}))) > 0` : ""
    if (where) view.found = (await query(`select count(*)::int as n from ${from} ${where.replace("$3", "$1")}`, [words])).rows[0].n
    if (o.sort && !have.includes(o.sort)) throw new Refused(`${name} has no column called ${o.sort}. It has: ${have.join(", ")}.`)
    const dir = o.desc ? "desc" : "asc"
    const order = o.sort ? `t.${ident(o.sort)} ${dir} nulls last` : `t.${ident(have.includes("id") ? "id" : have.includes("at") ? "at" : have[0]!)} desc`
    const r = await query(`select * from ${from} ${where} order by ${order} limit $1 offset $2`, where ? [o.limit, o.offset, words] : [o.limit, o.offset])
    view.rows = r.rows.map((x) => ({ id: null, cells: have.map((c) => plainCell(x[c])), facts: have.map(() => null) }))
    return view
  }

  /** Where the database is looked at one step deeper, for where this Flowbound runs: Drizzle Studio here, Neon live. */
  const deeper = () => {
    if (fb.live) {
      const at = consoleOf()
      return at ? { kind: "console" as const, ...at } : null
    }
    return {
      kind: "studio" as const,
      shared: !!opts.studio?.host,
      label: "Open in Drizzle Studio",
      where: "Drizzle's own Studio, started on this computer against the database Flowbound uses: every table, and it can change them",
    }
  }

  /**
   * The Data page's list: your tables, each with the folder it sits in, and Flowbound's own. A results table is in the
   * folder of the workflow that fills it; a list in the folder it was imported into, else the one folder of the
   * workflows that read it. Folders are Flowbound's; the database stays plain.
   */
  const data = async (who: Who) => {
    const yours = await api.tables()
    const flows: { id: string; folder: string; from?: string; into?: string }[] = fb.has("runs") ? ((await fb.call("workflows", {}, { kind: "system", name: "Flowbound", via: "page" })) as any[]) : []
    const folderOfTable = (t: (typeof yours)[number]) => {
      const filler = flows.find((w) => w.id === t.workflow) ?? flows.find((w) => w.into === t.name)
      if (t.kind === "results" && filler) return filler.folder
      if (t.folder) return t.folder
      const readers = [...new Set(flows.filter((w) => w.from === t.name).map((w) => w.folder))]
      return readers.length === 1 ? readers[0]! : ""
    }
    const ownRows = []
    // Runs, facts and calls first, as the page names them; then the rest; where your tables came from last.
    const first = ["fb_workflow_sdk.runs", "fb_ledger.facts", "fb_ledger.calls"]
    const rank = (n: string) => (first.includes(n) ? first.indexOf(n) : n.startsWith("fb_postgres.") ? 99 : 9)
    for (const [name, about] of Object.entries(own()).sort(([a], [b]) => rank(a) - rank(b))) {
      const [schema, table] = name.split(".")
      const there = (await query("select 1 from information_schema.tables where table_schema = $1 and table_name = $2", [schema, table])).rows.length
      if (there) ownRows.push({ name, short: table!, about, rows: (await query(`select count(*)::int as n from ${ident(schema!)}.${ident(table!)}`)).rows[0].n })
    }
    const d = deeper()
    return {
      tables: yours.map((t) => ({ ...t, folder: folderOfTable(t) })),
      own: ownRows,
      open: d && (d.kind === "console" || canFetch()) && can(who, "admin") ? d : null,
      page: `${fb.url}/tables`,
    }
  }

  const api: Records = {
    query,
    engine: () => db.engine,
    async tables() {
      const r = await query(
        `select c.relname as name, t.kind, t.origin, t.list, t.workflow, t.folder from pg_class c join pg_namespace n on n.oid = c.relnamespace
         left join fb_postgres.tables t on t.name = c.relname where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
      )
      const out = []
      for (const t of r.rows) {
        const n = (await query(`select count(*)::int as n from ${ident(t.name)}`)).rows[0].n
        out.push({ name: t.name, rows: n, origin: t.origin ?? "made with SQL", kind: t.kind ?? "table", list: t.list ?? undefined, workflow: t.workflow ?? undefined, folder: t.folder ?? undefined })
      }
      return out
    },
    async importCsv({ csv, file, as, add, key, folder }) {
      const into = folderOf(folder)
      const [head, ...rows] = fromCsv(csv)
      if (!head?.length || !rows.length) throw new Refused("That file has no rows. A list needs a first line of column names, then one line per row.")
      const name = as ? snake(as) : listName(file ?? "list.csv")
      const before = (await cols(name)).size ? (await query(`select count(*)::int as n from ${ident(name)}`)).rows[0].n : -1
      if (before >= 0 && !add) throw new Refused(`${name} is already there with ${before} rows. Add --add to add these rows to it, or --as <name> to make a new list.`)
      const fields = heads(head)
      const put = await putRows(name, fields, rows, `imported from ${file ? path.basename(file) : "a CSV"}`, key, into)
      return { name, rows: Math.max(before, 0) + put.added, ...put }
    },
    async add(list, rows, o = {}) {
      if (!rows.length) return { added: 0, updated: 0 }
      const names = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((n) => n !== "id")
      const fields = heads(names)
      const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v))
      return putRows(
        snake(list),
        fields,
        rows.map((r) => names.map((n) => text(r[n]))),
        o.origin ?? "added by a workflow",
        o.key,
      )
    },
    async addRow(list, row, origin) {
      const fields = heads(Object.keys(row))
      await makeList(list, fields, origin)
      const values = Object.values(row).map((v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v)))
      const r = await query(`insert into ${ident(list)} (${fields.map(ident).join(", ")}) values (${fields.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, values)
      return r.rows[0].id
    },
    async results(into, list, workflow, title) {
      if (!(await cols(list)).size) throw new Refused(`There is no list called ${list}. Make it with: npx flowbound import <file.csv> --as ${list}`)
      // Its folder is the workflow's, worked out when the Data page asks: moving the workflow file moves the table with it.
      await db.exec(`create table if not exists ${ident(into)} (id bigint primary key)`)
      await note(into, "results", `made by ${title}`, list, workflow)
      columns.delete(into)
    },
    async count(list, into) {
      const r = await query(`select (select count(*)::int from ${ident(list)}) as all, (select count(*)::int from ${ident(into)} r where exists (select 1 from ${ident(list)} l where l.id = r.id)) as done`)
      return r.rows[0]
    },
    async save(into, id, fields) {
      const have = await cols(into)
      const names = Object.keys(fields).map((f) => snake(f) || "value")
      for (const f of names) {
        if (have.has(f)) continue
        await db.exec(`alter table ${ident(into)} add column if not exists ${ident(f)} jsonb, add column if not exists ${ident(`${f}__fact`)} bigint`)
        have.add(f).add(`${f}__fact`)
      }
      const picked = Object.values(fields).map((v) => (isPicked(v) ? v : { value: v ?? null, fact: null }))
      const all = names.flatMap((f) => [ident(f), ident(`${f}__fact`)])
      // Nothing found is stored as empty, so "how many rows filled it" can be counted.
      const params = picked.flatMap((p) => [p.value === undefined || p.value === null || p.value === "" ? null : JSON.stringify(p.value), p.fact])
      await query(
        `insert into ${ident(into)} (id${all.map((c) => `, ${c}`).join("")}) values ($1${params.map((_, i) => `, $${i + 2}`).join("")})
         on conflict (id) do update set ${all.length ? all.map((c) => `${c} = excluded.${c}`).join(", ") : "id = excluded.id"}`,
        [id, ...params],
      )
    },
    async read(name, { limit = 100, offset = 0, search = "", sort = "", desc = false } = {}) {
      if (name.includes(".")) return readOwn(name, { limit, offset, search, sort, desc })
      const have = [...(await cols(name))]
      if (!have.length) throw new Refused(`There is no table called ${name}. See them with: npx flowbound tables`)
      const meta = (await query("select kind, origin, list, workflow from fb_postgres.tables where name = $1", [name])).rows[0] ?? { kind: "table", origin: "made with SQL" }
      const total = (await query(`select count(*)::int as n from ${ident(name)}`)).rows[0].n
      const view: TableView = { name, kind: meta.kind, origin: meta.origin, workflow: meta.workflow ?? undefined, total, columns: [], rows: [] }
      const joined = meta.kind === "results" && meta.list && (await cols(meta.list)).size
      const listCols = joined ? [...(await cols(meta.list))].filter((c) => c !== "id") : []
      const fields = joined ? have.filter((c) => c !== "id" && !c.endsWith("__fact")) : []
      const shown = joined ? [] : have.filter((c) => c !== "id")
      view.columns = joined
        ? // The list's first column, then the answers, then the rest of the list: on a phone the answers come into view first.
          [...listCols.slice(0, 1).map((c) => ({ name: c, of: "list" as const })), ...fields.map((c) => ({ name: c, of: "result" as const })), ...listCols.slice(1).map((c) => ({ name: c, of: "list" as const }))]
        : shown.map((c) => ({ name: c, of: meta.kind === "list" ? ("list" as const) : ("table" as const) }))
      /** A shown column as SQL: the list's own, or the result beside it. */
      const at = (c: string) => (joined ? `${listCols.includes(c) ? "l" : "r"}.${ident(c)}` : `t.${ident(c)}`)
      const from = joined ? `${ident(name)} r join ${ident(meta.list)} l on l.id = r.id` : `${ident(name)} t`
      const id = joined ? "r.id" : have.includes("id") ? "t.id" : ""
      // A search looks through every shown column as text, in the database: the page never holds more than it shows.
      const words = search.trim()
      const where = words && view.columns.length ? `where position(lower($3) in lower(concat_ws(' ', ${view.columns.map((c) => `${at(c.name)}::text`).join(", ")}))) > 0` : ""
      if (where) view.found = (await query(`select count(*)::int as n from ${from} ${where.replace("$3", "$1")}`, [words])).rows[0].n
      if (sort && !view.columns.some((c) => c.name === sort)) throw new Refused(`${name} has no column called ${sort}. It has: ${view.columns.map((c) => c.name).join(", ")}.`)
      // Numbers sort as numbers (a list's columns are text, a result is JSON), everything else as it is stored.
      const dir = desc ? "desc" : "asc"
      const order = [sort ? `case when ${at(sort)}::text ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${at(sort)}::text)::numeric end ${dir} nulls last, ${at(sort)} ${dir} nulls last` : "", id].filter(Boolean).join(", ")
      const page = where ? [limit, offset, words] : [limit, offset]
      if (joined) {
        const sel = [...listCols.map((c, i) => `l.${ident(c)} as l${i}`), ...fields.flatMap((c, i) => [`r.${ident(c)} as r${i}`, `r.${ident(`${c}__fact`)} as f${i}`])]
        const r = await query(`select r.id as id${sel.map((x) => `, ${x}`).join("")} from ${from} ${where} order by ${order} limit $1 offset $2`, page)
        view.rows = r.rows.map((x) => ({
          id: x.id,
          cells: [...listCols.slice(0, 1).map((_, i) => x[`l${i}`]), ...fields.map((_, i) => x[`r${i}`]), ...listCols.slice(1).map((_, i) => x[`l${i + 1}`])],
          facts: [...listCols.slice(0, 1).map(() => null), ...fields.map((_, i) => x[`f${i}`] ?? null), ...listCols.slice(1).map(() => null)],
        }))
      } else {
        const r = await query(`select t.* from ${from} ${where} ${order ? `order by ${order}` : ""} limit $1 offset $2`, page)
        view.rows = r.rows.map((x) => ({ id: x.id ?? null, cells: shown.map((c) => x[c]), facts: shown.map(() => null) }))
      }
      return view
    },
  }

  return plugin({
    name: "postgres",
    provides: "records",
    migrations: [
      "create table fb_postgres.tables (name text primary key, kind text not null, origin text not null, list text, workflow text, made_at timestamptz default now())",
      // The folder a list was imported into: Flowbound's, for the Data page. The database itself stays plain.
      "alter table fb_postgres.tables add column folder text",
    ],
    async start(f) {
      fb = f
      db = await open(fb, opts)
      applied = await db.alone((d) => migrate(d, fb.plugins))
      await db.wall()
      return Object.assign(api, { applied: () => applied })
    },
    stop: async () => {
      await (await studio?.catch(() => undefined))?.stop()
      studio = undefined
      await db?.close()
    },
    own: { "fb_postgres.tables": "where each of your tables came from" },
    tools: {
      tables: {
        about: "List your tables: name, rows and where each came from.",
        role: "viewer",
        run: () => api.tables(),
        print: (r: Awaited<ReturnType<Records["tables"]>>) => {
          if (!r.length) return "No tables yet. Make a list with: npx flowbound import <file.csv>"
          const w = Math.max(...r.map((t) => t.name.length)) + 3
          return r.map((t) => `${t.name.padEnd(w)} ${`${t.rows} rows`.padEnd(10)} ${t.origin}`).join("\n")
        },
      },
      import: {
        about: "Make a list table from a CSV file: the first line is the column names. targets.csv becomes target_list.",
        input: {
          csv: { type: "file", about: "the CSV file (over MCP: its text)", required: true },
          as: { about: "a name for the list, instead of the one made from the file name" },
          add: { type: "boolean", about: "add the rows to a list that is already there" },
          key: { about: "a column that says which row is which, like email or domain: a row whose key is already in the list is brought up to date, not added again" },
          folder: { about: "the folder under workflows/ it belongs with on the Data page, like tam-mapping: the play it is for. Without it, the folder of the workflows that read it" },
        },
        run: (i) => api.importCsv({ csv: i.csv, file: i.csvName, as: i.as, add: i.add, key: i.key, folder: i.folder }),
        print: (r) => `${r.name}   ${r.rows} rows${r.added < r.rows || r.updated ? ` (${r.added} added${r.updated ? `, ${r.updated} already there and brought up to date` : ""})` : ""}`,
      },
      data: {
        about:
          "What the Data page lists: your tables, each in the folder of the workflow that fills it (a list: the folder it was imported into), and Flowbound's own (runs, facts, calls and the rest, read-only; read one with the table tool by its full name, like fb_ledger.facts). Also the way one step deeper: Drizzle Studio here, Neon live.",
        role: "viewer",
        run: (_i, who) => data(who),
        print: (r: Awaited<ReturnType<typeof data>>) =>
          [...r.tables.map((t) => `${(t.folder ? `${t.folder}/` : "") + t.name}   ${t.rows} rows   ${t.origin}`), ...r.own.map((t) => `${t.name}   ${t.rows} rows   ${t.about} (Flowbound's own)`), `Page: ${r.page}`].join(
            "\n",
          ),
      },
      "data-open": {
        about:
          "Open the database one step deeper than the Data page. On your own computer: start Drizzle Studio (Drizzle's own database tool) against the database Flowbound uses and give its address; the first time it is fetched with npm, about half a minute. Live: the address of the project's Neon console.",
        input: { stop: { type: "boolean", about: "stop Drizzle Studio instead" } },
        // On your own computer it is the person's database and the person's click. Live it only hands out a link, to a console with its own sign-in.
        role: "admin",
        run: async (i) => {
          const d = deeper()
          if (!d) throw new Refused("This database is a Postgres of your own: open it in any Postgres tool at its address, which is on the server, not on this page.")
          if (d.kind !== "studio") return d
          if (i.stop) {
            await (await studio?.catch(() => undefined))?.stop()
            studio = undefined
            return { kind: "studio", stopped: true }
          }
          if (!studio && !canFetch()) throw new Refused("Drizzle Studio is fetched with npm, and npm is not on this computer.")
          studio ??= startStudio({ root: fb.root, engine: db.engine, port: opts.studio?.port })
          let up: Studio
          try {
            up = await studio
          } catch (e: any) {
            studio = undefined
            throw new Refused(String(e?.message ?? e))
          }
          const shared = opts.studio?.host
          return {
            ...d,
            // Studio's page is Drizzle's own, on the web; the data never goes there: the page in the browser talks to this computer directly.
            href: `https://local.drizzle.studio/?${shared ? `host=${encodeURIComponent(shared)}&` : ""}port=${up.port}`,
            port: up.port,
            note: shared
              ? `Shared at ${shared}:${up.port}. Studio can change data and has no sign-in of its own: keep that address private.`
              : `It answers on this computer only (127.0.0.1:${up.port}), so open it in a browser on this computer. Studio can change data. It stops when Flowbound stops.`,
          }
        },
        print: (r: any) => (r.stopped ? "Drizzle Studio is stopped." : `${r.label}: ${r.href}\n${r.note ?? r.where}`),
      },
      export: {
        about: "Get a table out as a CSV file. A results table comes with its list's columns beside the answers.",
        role: "viewer",
        input: { table: { about: "the table's name", required: true }, csv: { type: "boolean", about: "as CSV (the only format)" } },
        run: async (i, who) => {
          const v = await api.read(i.table, { limit: 1_000_000 })
          // The file is opened in a spreadsheet: a cell that would run there as a formula is made plain text.
          const text = toCsv([v.columns.map((c) => c.name), ...v.rows.map((r) => r.cells)], { forSheets: true })
          // A whole table does not belong in a chat: an agent gets where the file is to be had, not 10,000 rows of text.
          if (who.via === "mcp" && text.length > MOST_CHAT_BYTES)
            return {
              rows: v.rows.length,
              tooBigForChat: `${v.name}.csv is ${v.rows.length} rows (${Math.ceil(text.length / 1024)} KB), too big to send into a chat. The person downloads it at ${fb.url}/tables?table=${v.name} (Download CSV)${fb.live ? "" : `, or in the project folder: npx flowbound export ${v.name} --csv`}. To read part of it, use the table tool (limit, offset) or sql.`,
            }
          return { rows: v.rows.length, save: { name: `${v.name}.csv`, text } }
        },
        print: (r) => r.tooBigForChat ?? `${r.save.name}   ${r.rows} rows`,
      },
      table: {
        about: "Read rows of a table. A results table shows the answers beside the list's own columns, with the kept fact behind each field and where it came from, how old it is and what it cost.",
        role: "viewer",
        input: {
          name: { about: "the table's name", required: true },
          limit: { type: "number", about: `how many rows (100, at most ${MOST_ROWS})` },
          offset: { type: "number", about: "rows to skip" },
          search: { about: "only rows with these words in any column" },
          sort: { about: "a column to sort by" },
          desc: { type: "boolean", about: "sort from the highest down" },
        },
        run: async (i) => {
          const v = await api.read(i.name, {
            limit: Math.min(Math.max(1, Math.floor(Number(i.limit)) || 100), MOST_ROWS),
            offset: Math.max(0, Math.floor(Number(i.offset)) || 0),
            search: i.search ? String(i.search) : "",
            sort: i.sort ? String(i.sort) : "",
            desc: i.desc === true || i.desc === "true",
          })
          // Each answered cell says where it came from, how old it is and what it cost (the kept facts know).
          if (v.kind !== "results" || !fb.has("ledger")) return v
          const cells = v.rows.flatMap((r) => r.facts.flatMap((f) => (f && r.id !== null ? [{ row: Number(r.id), fact: Number(f) }] : [])))
          const said = await fb.use<{ sources: (into: string, c: { row: number; fact: number }[]) => Promise<Record<string, { text: string }>> }>("ledger").sources(v.name, cells)
          return { ...v, rows: v.rows.map((r) => ({ ...r, sources: r.facts.map((f) => (f && r.id !== null ? (said[`${r.id}:${f}`]?.text ?? null) : null)) })) }
        },
        print: (v: TableView) =>
          `${toCsv([v.columns.map((c) => c.name), ...v.rows.map((r) => r.cells)]).trimEnd()}\n(${v.rows.length} of ${v.found ?? v.total} rows${v.found === undefined ? "" : ` found in ${v.total}`}, ${v.origin}. Add --json for the paid fact behind each field.)`,
      },
      sql: {
        about:
          "Run SQL on your own database: make any table the job needs, or read across tables. Your tables are in schema public. Flowbound's own tables (schemas named fb_*) are not for SQL: a token's SQL cannot read them. Its runs, facts, calls and the like are read with the table tool by their full name (fb_ledger.facts), as the Data page shows them; sign-ins, keys and yeses never.",
        input: { query: { about: "one SQL statement", required: true } },
        run: async (i, who) => {
          // A results field is JSON, so comparing it with a number or a text fails in Postgres's own words. Say what to write.
          const said = (e: any) => {
            const m = String(e?.message ?? e)
            return /operator does not exist: jsonb|invalid input syntax for type json/.test(m)
              ? `${m}. A results field is stored as JSON: compare it as a number with (score)::numeric > 70, or as text with title #>> '{}' = 'VP Sales' (the same for like and order by).`
              : m
          }
          // An agent's token can read, not change: its SQL runs in a transaction that cannot write, as the reader, a
          // database role that sees only the person's own tables. The same for a signed-in person who is not a
          // manager. Flowbound's own tables (people, sign-ins, tokens, history, yeses) are refused by the database.
          if (who.kind === "token" || !can(who, "admin")) {
            const r = await db.readOnly(i.query).catch((e) => {
              const m = String(e?.message ?? e)
              if (e instanceof Refused) throw e
              if (/read-only/.test(m)) throw new Refused(who.kind === "token" ? "A token can read with SQL, not change anything." : "Only a manager can change things with SQL. You can read.")
              if (/permission denied/.test(m))
                throw new Refused(
                  `${m}. This SQL reads only the person's own tables (schema public); Flowbound's own tables are not open to it.${who.kind === "token" ? "" : " A manager sees them on the Data page."}`,
                  { code: "rights" },
                  403,
                )
              throw new Refused(said(e))
            })
            return { rows: (r.rows ?? []).slice(0, 500), count: r.rows?.length ?? 0 }
          }
          const r = await api.query(i.query).catch((e) => {
            throw said(e) === String(e?.message ?? e) ? e : new Refused(said(e))
          })
          columns.clear()
          return { rows: r.rows.slice(0, 500), count: r.count }
        },
        print: (r) => (r.rows.length ? toCsv([Object.keys(r.rows[0]), ...r.rows.map((x: any) => Object.values(x))]).trimEnd() : `${r.count} rows changed`),
      },
    },
    pages: { "/tables": { title: "Data", file: asset("postgres/tables.html"), menu: true, order: 5 } },
    docs: asset("postgres/postgres.md"),
  })
}
