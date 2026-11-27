// Keys: used, never read. The key is attached here, on the way out, and only to its own card's address.
// A connection is a name the person chooses and a secret key (MY_SERVICE_KEY). A card reaches its key by that name: a
// built-in card's is its own name in capitals (BLITZAPI_KEY), and a card of your own says which name it takes.
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
  key: false | { header: string; prefix?: string; name?: string }
  /** Why the key is needed, shown under its field on the Connections page. */
  hint?: string
  /** For a card that also works with no key on a person's own computer: one line saying how. */
  without?: string
  /** A path at the provider that answers a good key with 2xx and a bad one with 401 or 403, at no cost. A typed key is tried there before it is saved. */
  check?: string
  /** True for a secret that nothing is called with: a webhook's signing secret, only ever used to check a sender's signature. */
  incoming?: boolean
}
/** One line on the Connections page: a key by its name, the cards that take it, and whether it is set. */
export type Connection = { name: string; label: string; cards: string[]; hasKey: boolean; incoming?: boolean; hint?: string; without?: string }
export type Keys = {
  cards: () => Promise<{ name: string; label: string; host: string; needsKey: boolean; hasKey: boolean; key?: string; hint?: string; incoming?: boolean; without?: string }[]>
  /** Every connection: each key a card takes, and each key a person saved under a name of their own. */
  connections: () => Promise<Connection[]>
  has: (name: string) => Promise<boolean>
  /** Call a card's address with its key attached. Any other address is refused. */
  fetch: (name: string, pathAndQuery: string, init?: RequestInit) => Promise<Response>
  /** HMAC-SHA256 of some bytes with a card's secret: how a sender's signature is checked without the secret leaving here. Undefined when no secret is saved. */
  mac: (name: string, bytes: Uint8Array) => Promise<Buffer | undefined>
}

/** Where this project's keys sit on your own computer: outside the project folder. */
/** The name a card's key is kept under: its own `key.name`, else its name in capitals (BLITZAPI_KEY, NEW_LEADS_SECRET). */
export const keyName = (card: KeyCard) =>
  (card.key && card.key.name) ||
  `${card.name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}_${card.incoming ? "SECRET" : "KEY"}`
/** A connection's name: a letter, then letters, digits, _ . or -. */
export const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

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
  const writeFile = (all: Record<string, string>) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file(), JSON.stringify(all), { mode: 0o600 })
  }
  // Keys saved before connections had names were kept under their card's name ("blitzapi"): moved once to the key's name.
  // On your own computer the file is looked at each time (it is small, and may be copied in from an older install); live, once.
  let moved: Promise<void> | undefined
  const move = () =>
    (moved ??= (async () => {
      const olds = [...cards.values()].filter((c) => c.key && keyName(c) !== c.name)
      if (fb.live) {
        const db = fb.use("records")
        for (const c of olds) await db.query("update fb_keys.keys set name = $2 where name = $1 and not exists (select 1 from fb_keys.keys where name = $2)", [c.name, keyName(c)])
        return
      }
      const all = readFile()
      let changed = false
      for (const c of olds)
        if (c.name in all) {
          if (!(keyName(c) in all)) all[keyName(c)] = all[c.name]!
          delete all[c.name]
          changed = true
        }
      if (changed) writeFile(all)
    })().then(
      () => {
        if (!fb.live) moved = undefined
      },
      (e) => {
        moved = undefined
        throw e
      },
    ))
  /** The name a key is kept under: a card's name leads to its key's name; any other name is the key's own. */
  const nameOf = (name: string) => {
    const c = cards.get(name)
    return c?.key ? keyName(c) : name
  }
  const read = async (name: string): Promise<string | undefined> => {
    await move()
    if (!fb.live) return readFile()[name]
    const row = (await fb.use("records").query("select locked from fb_keys.keys where name = $1", [name])).rows[0]
    return row ? unlock(row.locked) : undefined
  }
  const names = async (): Promise<Set<string>> => {
    await move()
    return new Set(fb.live ? (await fb.use("records").query("select name from fb_keys.keys")).rows.map((r: any) => r.name) : Object.keys(readFile()))
  }
  const write = async (name: string, value: string) => {
    if (!NAME.test(name)) throw new Refused("A connection's name starts with a letter, then letters, digits, _ . or -, like MY_SERVICE_KEY.")
    await move()
    if (fb.live) {
      const db = fb.use("records")
      if (value) await db.query("insert into fb_keys.keys (name, locked) values ($1, $2) on conflict (name) do update set locked = $2, at = now()", [name, lock(value)])
      else await db.query("delete from fb_keys.keys where name = $1", [name])
      return
    }
    const all = readFile()
    if (value) all[name] = value
    else delete all[name]
    writeFile(all)
  }
  const address = (card: KeyCard, pathAndQuery: string) => {
    // A server on this machine is plain http unless the card says otherwise; everything else is https.
    const base = /^https?:\/\//.test(card.host) ? card.host : `${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(card.host) ? "http" : "https"}://${card.host}`
    const url = new URL(base.replace(/\/$/, "") + (pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`))
    if (url.host !== new URL(base).host) throw new Refused(`${label(card)}'s key only goes to ${new URL(base).host}, not to ${url.host}.`)
    return url
  }
  const api: Keys = {
    async cards() {
      const have = await names()
      return [...cards.values()].map((c) => ({
        name: c.name,
        label: label(c),
        host: c.host,
        needsKey: !!c.key,
        hasKey: !!c.key && have.has(keyName(c)),
        key: c.key ? keyName(c) : undefined,
        hint: c.hint,
        incoming: c.incoming || undefined,
        without: fb.live ? undefined : c.without,
      }))
    },
    async connections() {
      const have = await names()
      // No list of known services: a card's key shows only once it is saved, or when a workflow (or a webhook) needs it.
      const flows = fb.has("runs") ? Object.values(fb.use<{ workflows: () => Record<string, { uses?: string[] }> }>("runs").workflows()) : []
      const needed = (c: KeyCard) => c.incoming || flows.some((w) => w.uses?.includes(c.name))
      const out = new Map<string, Connection>()
      for (const c of cards.values()) {
        if (!c.key || !(have.has(keyName(c)) || needed(c))) continue
        const name = keyName(c)
        const was = out.get(name)
        if (was) was.cards.push(c.name)
        else out.set(name, { name, label: label(c), cards: [c.name], hasKey: have.has(name), incoming: c.incoming || undefined, hint: c.hint, without: fb.live ? undefined : c.without })
      }
      for (const name of have) if (!out.has(name)) out.set(name, { name, label: name, cards: [], hasKey: true })
      return [...out.values()]
    },
    has: async (name) => {
      const c = cards.get(name)
      return !c?.key || (await names()).has(keyName(c))
    },
    async mac(name, bytes) {
      const c = cards.get(name)
      const secret = c?.incoming ? await read(keyName(c)) : undefined
      return secret ? crypto.createHmac("sha256", secret).update(bytes).digest() : undefined
    },
    async fetch(name, pathAndQuery, init = {}) {
      const card = cards.get(name)
      if (!card || card.incoming) throw new Refused(`There is no provider card called "${name}".`)
      const url = address(card, pathAndQuery)
      const headers = new Headers(init.headers)
      if (card.key) {
        const key = await read(keyName(card))
        if (!key) throw new Refused(`${label(card)} has no key yet. Add it on the Connections page: ${fb.url}/keys`, { code: "no-key", card: name })
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
        about:
          'The connections: each key by its name (BLITZAPI_KEY, or any name a person chose), which cards take it, and whether it is set. Never shows a key. Keys are typed by a person on the Connections page. A card of your own takes a key by its name: key: { header, name: "MY_SERVICE_KEY" }.',
        role: "viewer",
        run: async () => ({ cards: await api.cards(), connections: await api.connections(), page: `${fb.url}/keys` }),
        print: (r) => {
          const w = Math.max(...r.connections.map((c: any) => c.name.length), 4) + 3
          return [...r.connections.map((c: any) => `${c.name.padEnd(w)}${c.hasKey ? "set" : "missing"}`), `Keys are typed on the Connections page: ${r.page}`].join("\n")
        },
      },
      "set-key": {
        about: "Save or remove a key by its name (a card's name also works). Any name: a key no card takes yet is kept for a card of your own. Nothing is checked: a wrong key shows when a run fails.",
        by: "people",
        role: "admin",
        input: { name: { about: "the connection's name, like MY_SERVICE_KEY, or a card's name", required: true }, value: { about: "the key; empty removes it" } },
        run: async (i, who) => {
          const value = String(i.value ?? "").trim()
          const name = nameOf(String(i.name ?? "").trim())
          if (cards.get(i.name) && !cards.get(i.name)!.key) throw new Refused(`${label(cards.get(i.name)!)} takes no key here: a proxy adds it.`)
          const had = (await names()).has(name)
          await write(name, value)
          // History says that a key changed and who did it, never the key.
          if (fb.has("door")) await fb.use("door").wrote(who, "key", name, had ? "a key" : "no key", value ? "a key" : "no key")
          return { name: i.name, hasKey: !!value }
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
        if (!have.has(keyName(c))) {
          // A card that also works with no key on a person's own computer (the model, on their agent login) is not a problem there.
          if (by.length && !(c.without && !fb.live))
            out.push({
              what: `${label(c)} has no key, and ${words(by)} ${by.length === 1 ? "needs" : "need"} it.`,
              name: words(by),
              why: `Needs a ${label(c)} connection`,
              fix: "Type it on the Connections page, never in a chat. The agent uses it and never sees it.",
              page: "/keys",
            })
        } else if (deep && c.check) {
          // The same free call a typed key is tried with, now with the saved one: has the provider taken it back?
          const res = await fetch(address(c, c.check), {
            headers: { accept: "application/json", [c.key.header]: (c.key.prefix ?? "") + (await read(keyName(c))) },
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          }).catch(() => undefined)
          if (res && (res.status === 401 || res.status === 403))
            out.push({
              what: `${label(c)} no longer takes the saved key (it answered ${res.status}).${by.length ? ` ${words(by)} will stop at ${by.length === 1 ? "its" : "their"} next call.` : ""}`,
              fix: "A person types a new key on the Connections page.",
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
