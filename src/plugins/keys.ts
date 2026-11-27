// Keys: used, never read. The key is attached here, on the way out, and only to its own card's address.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Attention, type Flowbound, plugin } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import { asset, sha } from "./util.ts"

/** The part of a provider's card the keys plugin reads. */
export type KeyCard = {
  name: string
  label?: string
  host: string
  key: false | { header: string; prefix?: string }
  /** Why the key is needed, shown under its field on the keys page. */
  hint?: string
  /** For a card that also works with no key on a person's own computer: one line saying how. */
  without?: string
  /** A path at the provider that answers a good key with 2xx and a bad one with 401 or 403, at no cost. A typed key is tried there before it is saved. */
  check?: string
  /** True for a secret that nothing is called with: a webhook's signing secret, only ever used to check a sender's signature. */
  incoming?: boolean
}
export type Keys = {
  cards: () => Promise<{ name: string; label: string; host: string; needsKey: boolean; hasKey: boolean; hint?: string; incoming?: boolean; without?: string }[]>
  has: (name: string) => Promise<boolean>
  /** Call a card's address with its key attached. Any other address is refused. */
  fetch: (name: string, pathAndQuery: string, init?: RequestInit) => Promise<Response>
  /** HMAC-SHA256 of some bytes with a card's secret: how a sender's signature is checked without the secret leaving here. Undefined when no secret is saved. */
  mac: (name: string, bytes: Uint8Array) => Promise<Buffer | undefined>
}

/** Where this project's keys sit on your own computer: outside the project folder. */
export const keysFile = (root: string) => path.join(process.env.FLOWBOUND_HOME ?? path.join(os.homedir(), ".flowbound"), `${path.basename(root)}-${sha(root).slice(0, 8)}`, "keys.json")

export const keys = () => {
  let fb: Flowbound
  const cards = new Map<string, KeyCard>()
  const label = (c: KeyCard) => c.label ?? c.name.replace(/^./, (x) => x.toUpperCase())

  const secret = () => {
    const s = process.env.FLOWBOUND_SECRET
    if (!s) throw new Refused("This live Flowbound has no FLOWBOUND_SECRET on its host, so it cannot lock or unlock keys.")
    return crypto.createHash("sha256").update(s).digest()
  }
  const lock = (value: string) => {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv("aes-256-gcm", secret(), iv)
    const body = Buffer.concat([c.update(value, "utf8"), c.final()])
    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".")
  }
  const unlock = (locked: string) => {
    const [iv, tag, body] = locked.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer]
    const d = crypto.createDecipheriv("aes-256-gcm", secret(), iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()]).toString("utf8")
  }
  const file = () => keysFile(fb.root)
  const readFile = (): Record<string, string> => (fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : {})
  const read = async (name: string): Promise<string | undefined> => {
    if (!fb.live) return readFile()[name]
    const row = (await fb.use("records").query("select locked from fb_keys.keys where name = $1", [name])).rows[0]
    return row ? unlock(row.locked) : undefined
  }
  const names = async (): Promise<Set<string>> => new Set(fb.live ? (await fb.use("records").query("select name from fb_keys.keys")).rows.map((r: any) => r.name) : Object.keys(readFile()))
  const write = async (name: string, value: string) => {
    if (!cards.get(name)?.key) throw new Refused(`No card called "${name}" takes a key.`)
    if (fb.live) {
      const db = fb.use("records")
      if (value) await db.query("insert into fb_keys.keys (name, locked) values ($1, $2) on conflict (name) do update set locked = $2, at = now()", [name, lock(value)])
      else await db.query("delete from fb_keys.keys where name = $1", [name])
      return
    }
    const all = readFile()
    if (value) all[name] = value
    else delete all[name]
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file(), JSON.stringify(all), { mode: 0o600 })
  }
  const address = (card: KeyCard, pathAndQuery: string) => {
    // A server on this machine is plain http unless the card says otherwise; everything else is https.
    const base = /^https?:\/\//.test(card.host) ? card.host : `${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(card.host) ? "http" : "https"}://${card.host}`
    const url = new URL(base.replace(/\/$/, "") + (pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`))
    if (url.host !== new URL(base).host) throw new Refused(`${label(card)}'s key only goes to ${new URL(base).host}, not to ${url.host}.`)
    return url
  }
  /** A key is checked when it is typed: one free call to the card's own address. A key the provider refuses is not saved. */
  const checked = async (card: KeyCard, value: string): Promise<"good" | "not checked"> => {
    if (!card.check || !card.key) return "not checked"
    let res: Response
    try {
      res = await fetch(address(card, card.check), { headers: { accept: "application/json", [card.key.header]: (card.key.prefix ?? "") + value }, redirect: "manual", signal: AbortSignal.timeout(10_000) })
    } catch {
      return "not checked" // the provider could not be reached: the key is saved, and the first call will tell
    }
    if (res.status === 401 || res.status === 403)
      throw new Refused(`${label(card)} refused this key (${res.status}), so it was not saved. Check that it was copied whole, from the right account.`, { code: "bad-key", card: card.name })
    return res.ok ? "good" : "not checked"
  }

  const api: Keys = {
    async cards() {
      const have = await names()
      return [...cards.values()].map((c) => ({
        name: c.name,
        label: label(c),
        host: c.host,
        needsKey: !!c.key,
        hasKey: have.has(c.name),
        hint: c.hint,
        incoming: c.incoming || undefined,
        without: fb.live ? undefined : c.without,
      }))
    },
    has: async (name) => !cards.get(name)?.key || (await names()).has(name),
    async mac(name, bytes) {
      const secret = cards.get(name)?.incoming ? await read(name) : undefined
      return secret ? crypto.createHmac("sha256", secret).update(bytes).digest() : undefined
    },
    async fetch(name, pathAndQuery, init = {}) {
      const card = cards.get(name)
      if (!card || card.incoming) throw new Refused(`There is no provider card called "${name}".`)
      const url = address(card, pathAndQuery)
      const headers = new Headers(init.headers)
      if (card.key) {
        const key = await read(name)
        if (!key) throw new Refused(`${label(card)} has no key yet. Add it on the keys page: ${fb.url}/keys`, { code: "no-key", card: name })
        headers.set(card.key.header, (card.key.prefix ?? "") + key)
      }
      return fetch(url, { ...init, headers, redirect: "manual" })
    },
  }

  return plugin({
    name: "keys",
    provides: "keys",
    needs: ["records"],
    migrations: ["create table fb_keys.keys (name text primary key, locked text not null, at timestamptz default now())"],
    start(f) {
      fb = f
      for (const p of fb.plugins) if (p.card) cards.set(p.name, p.card as KeyCard)
      // A plugin with a second address of its own brings that card too.
      for (const p of fb.plugins) for (const c of (p.cards as KeyCard[] | undefined) ?? []) cards.set(c.name, c)
      return api
    },
    tools: {
      keys: {
        about: "Which provider cards have a key, and which still need one. Never shows a key. Keys are typed by a person on the keys page.",
        role: "viewer",
        run: async () => ({ cards: await api.cards(), page: `${fb.url}/keys` }),
        print: (r) => {
          const need = r.cards.filter((c: any) => c.needsKey)
          const w = Math.max(...need.map((c: any) => c.label.length), 4) + 3
          return [...need.map((c: any) => `${c.label.padEnd(w)}${c.hasKey ? "key is in" : "no key yet"}`), `Keys are typed on the keys page: ${r.page}`].join("\n")
        },
      },
      "set-key": {
        about: "Save or remove a card's key. A card with a `check` path tries the key at the provider first: a key it refuses is not saved.",
        by: "people",
        role: "admin",
        input: { name: { about: "the card's name", required: true }, value: { about: "the key; empty removes it" } },
        run: async (i, who) => {
          const value = String(i.value ?? "").trim()
          const card = cards.get(i.name)
          const had = (await names()).has(i.name)
          const check = value && card ? await checked(card, value) : undefined
          await write(i.name, value)
          // History says that a key changed and who did it, never the key.
          if (fb.has("door")) await fb.use("door").wrote(who, "key", i.name, had ? "a key" : "no key", value ? "a key" : "no key")
          return { name: i.name, hasKey: !!i.value, ...(check === "good" ? { checked: true } : {}) }
        },
      },
    },
    /** For the check-up: a key a workflow needs and nobody has typed; and, when asked to look deeper, a saved key its provider no longer takes. */
    async attention({ deep }) {
      const out: Attention[] = []
      const have = await names()
      const flows = fb.has("runs") ? Object.values(fb.use<{ workflows: () => Record<string, { title: string; uses?: string[] }> }>("runs").workflows()) : []
      const words = (n: string[]) => (n.length < 3 ? n.join(" and ") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`)
      for (const c of cards.values()) {
        if (!c.key || c.incoming) continue
        const by = flows.filter((w) => w.uses?.includes(c.name)).map((w) => w.title)
        if (!have.has(c.name)) {
          // A card that also works with no key on a person's own computer (the model, on their agent login) is not a problem there.
          if (by.length && !(c.without && !fb.live))
            out.push({ what: `${label(c)} has no key, and ${words(by)} ${by.length === 1 ? "needs" : "need"} it.`, fix: "Type it on the Keys page, never in a chat. The agent uses it and never sees it.", page: "/keys" })
        } else if (deep && c.check) {
          // The same free call a typed key is tried with, now with the saved one: has the provider taken it back?
          const res = await fetch(address(c, c.check), {
            headers: { accept: "application/json", [c.key.header]: (c.key.prefix ?? "") + (await read(c.name)) },
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          }).catch(() => undefined)
          if (res && (res.status === 401 || res.status === 403))
            out.push({
              what: `${label(c)} no longer takes the saved key (it answered ${res.status}).${by.length ? ` ${words(by)} will stop at ${by.length === 1 ? "its" : "their"} next call.` : ""}`,
              fix: "A person types a new key on the keys page.",
              page: "/keys",
            })
          else if (!res) out.push({ what: `${label(c)} could not be reached to try its key.`, fix: "Nothing to do if the provider is only down for a moment. Run the check-up again later.", when: "soon" })
        }
      }
      return out
    },
    pages: { "/keys": { title: "Connections", file: asset("keys/keys.html"), menu: true, order: 7 } },
    docs: asset("keys/keys.md"),
  })
}
