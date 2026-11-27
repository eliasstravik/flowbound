// The whole plugin model: one typed object per plugin, and use() to reach another plugin's part.
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Who is asking: you on your own computer, a signed-in person, an agent's token, or Flowbound itself. */
export type Who = {
  kind: "local" | "person" | "token" | "system"
  name: string
  /** The door they came through: cli, mcp, page, api, hook, schedule. */
  via: string
  /** False when the name was typed under a team password and never checked. */
  checked?: boolean
  /** The person's work email, checked by the company's login. For an agent's token: the person it belongs to. */
  email?: string
  /** Name of the person behind an agent, without the app label. */
  personName?: string
  /** What they may do. Unset (you on your own computer, Flowbound itself): everything. */
  role?: Role
}

/** No access ("none"), or one of the four project roles. */
export type Role = "none" | "viewer" | "member" | "admin" | "owner"
export const ROLES: Role[] = ["none", "viewer", "member", "admin", "owner"]
/** Old project configs and plugins keep working through the role change. */
type LegacyRole = "view" | "edit" | "approve" | "manage"
export function projectRole(role: Role | LegacyRole): Role {
  switch (role) {
    case "view":
      return "viewer"
    case "edit":
    case "approve":
      return "member"
    case "manage":
      return "admin"
    default:
      return role
  }
}
export const can = (who: Pick<Who, "role">, need: Role | LegacyRole) => {
  const level = ROLES.indexOf(projectRole(need))
  return level >= 0 && (!who.role || ROLES.indexOf(projectRole(who.role)) >= level)
}

export type Input = Record<string, { type?: "string" | "number" | "boolean" | "json" | "file"; about: string; required?: boolean }>

/** What agents can call. A plain function with a name, its inputs and, when it costs money, a price. */
export type Tool = {
  about: string
  input?: Input
  price?: string
  docs?: string
  /** "people": only a person on a page may call it, never a token or the command line. */
  by?: "people"
  /** The least a signed-in person must be allowed, to call it: viewer, member (the default), admin or owner. */
  role?: Role | LegacyRole
  run: (input: any, who: Who) => unknown
  /** How the command line prints the result. Without it, JSON. */
  print?: (result: any, input: any) => string
}

export type At = { params: Record<string, string>; url: URL; who: Who }
export type Route = ((req: Request, at: At) => Response | Promise<Response>) & { open?: "token" | "all" }

/** A page people see: one plain HTML file. `first`: it leads the menu and is where "/" lands. `order`: its place in the menu. `live`: only on a live Flowbound. */
export type Page = { title: string; file: string; menu?: boolean; first?: boolean; order?: number; live?: boolean }

/** Something that needs a person or is not right, said by the plug-in that knows it: the check-up and the home page show it. */
export type Attention = {
  /** What is the matter, in one plain sentence a person understands. */
  what: string
  /** The one thing to do about it. */
  fix: string
  /** The page where a person does that, like "/keys", and its settings. */
  page?: string
  params?: Record<string, string | number>
  /** "soon": it works today and will not for long. Without it: something is stopped or broken now. */
  when?: "now" | "soon"
  /** A yes that waits: the run it is for. The page shows it as a question, with Not now beside it. */
  yes?: { run: number }
  /** For Home's short row: what it is about ("Read websites") and why, in a few words ("Needs a Firecrawl connection"). */
  name?: string
  why?: string
}

export type Command = {
  about: string
  usage?: string
  run: (args: string[], fb: CommandLine) => unknown
}

/** What a command gets: the list as written, the project folder, and a way to call the running server. */
export type CommandLine = {
  root: string
  plugins: Plugin[]
  call: (tool: string, input?: unknown, opts?: { live?: boolean }) => Promise<any>
}

export type Plugin = {
  name: string
  /** Parts this plugin can't work without, by the name another plugin provides. */
  needs?: string[]
  /** The part this plugin gives. A later plugin with the same word replaces an earlier one. */
  provides?: string
  /** Called once, in order. What it returns is what use("<name>") hands to others. */
  start?: (fb: Flowbound) => unknown
  stop?: () => unknown
  tools?: Record<string, Tool>
  pages?: Record<string, Page>
  /** HTTP addresses that are not pages, as "POST /hooks/:id". */
  routes?: Record<string, Route>
  /** SQL for this plugin's own tables, applied once each, in order. */
  migrations?: string[]
  /** Words for the `flowbound` command. A function gets the whole list, for a plugin that makes commands out of other plugins' tools. */
  commands?: Record<string, Command> | ((plugins: Plugin[]) => Record<string, Command>)
  /** Words for `flowbound docs`: markdown, or the path of a markdown file. */
  docs?: string
  /**
   * Longer how-tos an agent reads only when it needs one, by name: `flowbound docs recipes`. Markdown, or the path
   * of a markdown file. They are not part of plain `flowbound docs`, so the text every agent reads first stays short.
   */
  guides?: Record<string, string>
  /** Checks a request before any route runs. Return who it is, or a Response to turn it away. */
  guard?: (req: Request, url: URL, route: { open?: "token" | "all" } | undefined) => Who | Response | undefined | Promise<Who | Response | undefined>
  /**
   * What needs a person, as this plugin knows it: a missing key, a run that waits, a yes that ends soon. Each with
   * what is the matter and the one thing to do. Read by `flowbound doctor` and the home page. `deep`: also do the
   * slower checks (a call out to a provider), which the home page never asks for.
   */
  attention?: (o: { deep?: boolean }) => Attention[] | Promise<Attention[]>
  /** Where the plugin was written: "flowbound" or a file in the project. Filled in by plugin(). */
  from?: string
  /** A data provider's card, when the plugin is one. */
  card?: unknown
  [more: string]: unknown
}

/** What a started plugin can see. */
export type Flowbound = {
  root: string
  /** True when this is the deployed, shared Flowbound; false on your own computer. */
  live: boolean
  /** The address people open it at, like http://localhost:4111. Behind a proxy that shares it under a path, that path is part of it. */
  url: string
  /** The path part of `url`, like "/flowbound" or "". Every link to one of its own pages starts with it. */
  base: string
  /** The address it answers at on this computer itself, whatever `url` says. */
  local: string
  plugins: Plugin[]
  use: <T = any>(name: string) => T
  has: (name: string) => boolean
  tools: Record<string, Tool>
  /** Call a tool by name, as the HTTP API does. */
  call: (tool: string, input: unknown, who: Who) => Promise<unknown>
}

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const helpers = [path.join("core", "plugin."), path.join("plugins", "provider.")]

/** Make a plugin. Also notes which file wrote it, for `flowbound plugins`. */
export function plugin<P extends Plugin>(p: P): P {
  if (!p.from) {
    const files = (new Error().stack ?? "")
      .split("\n")
      .slice(1)
      .map((l) => /\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?$/.exec(l.trim())?.[1])
      .filter((f): f is string => !!f)
      .map((f) => (f.startsWith("file://") ? fileURLToPath(f) : f))
    const author = files.find((f) => !helpers.some((h) => f.includes(h)))
    p.from = !author || author.startsWith(here) ? "flowbound" : `./${path.relative(process.cwd(), author)}`
  }
  return p
}

const KEY = Symbol.for("flowbound")
type Shared = { use?: Flowbound["use"]; has?: Flowbound["has"] }
export const shared = (): Shared => ((globalThis as any)[KEY] ??= {})

/** Reach a provider, the records or any other part by name: use("blitzapi"), use("records"). */
export function use<T = any>(name: string): T {
  const u = shared().use
  if (!u) throw new Error(`use("${name}") works inside a running Flowbound: in a step, a tool or a plugin's start.`)
  return u<T>(name)
}
