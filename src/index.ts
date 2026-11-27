// Flowbound: an open-source agent plugin for GTM workflows.
// Everything a project imports comes from here. A project says what it adds or removes itself (providers,
// workflows, pages) and its permissions; the five parts inside (store, runner, keys, permissions, the page) are
// plugins too, each swappable in one line, but nobody needs to know.

import type { Plugin } from "./core/plugin.ts"
import { ai } from "./plugins/ai.ts"
import { blitzapi, firecrawl } from "./plugins/cards.ts"
import { type ChangesOptions, changes } from "./plugins/changes.ts"
import { cli } from "./plugins/cli.ts"
import { context } from "./plugins/context.ts"
import { type DoorOptions, door } from "./plugins/door.ts"
import { keys } from "./plugins/keys.ts"
import { ledger, type Permissions } from "./plugins/ledger.ts"
import { mcp } from "./plugins/mcp.ts"
import { overview } from "./plugins/overview.ts"
import { pages } from "./plugins/pages.ts"
import { postgres } from "./plugins/postgres.ts"
import { hook, schedule, schedules } from "./plugins/schedules.ts"
import { type Home, workflowSdk } from "./plugins/workflow-sdk.ts"

export type { Attention, Command, Flowbound, Page, Plugin, Role, Route, Tool, Who } from "./core/plugin.ts"
export { plugin, use } from "./core/plugin.ts"
export { boot, Refused } from "./core/server.ts"
export type { Ai, AskOptions } from "./plugins/ai.ts"
export { monid, treg } from "./plugins/cards.ts"
export type { Door, DoorOptions } from "./plugins/door.ts"
export type { Keys } from "./plugins/keys.ts"
export type { Caps, Ledger, Mode, Permissions, Rule } from "./plugins/ledger.ts"
export type { Checkup, Overview } from "./plugins/overview.ts"
export type { Records } from "./plugins/postgres.ts"
export type { Card, Picked, Provider, Result } from "./plugins/provider.ts"
export { provider } from "./plugins/provider.ts"
export type { HookLine, ScheduleLine } from "./plugins/schedules.ts"
export { ai, blitzapi, changes, cli, context, door, firecrawl, hook, keys, ledger, mcp, overview, pages, postgres, schedule, schedules, workflowSdk }

/** What `flowbound.config.ts` says. Only `providers` and `permissions` are needed; the rest has a sensible default. */
export type Config = {
  /** The data providers (and the model, and the tools it may write to) your workflows call. */
  providers?: Plugin[]
  /** How much the agent may do without asking: a mode and caps, and a rule of its own per workflow or provider. */
  permissions?: Permissions
  /** Workflows that run by themselves: schedule({ ... }) and hook({ ... }) lines. */
  schedules?: Plugin[]
  /** Kept facts: how many days an answer is used again before it is bought again (30). */
  facts?: { freshDays?: number }
  /** Pages and parts of your own: plugin({ ... }) objects. */
  plugins?: Plugin[]
  /** Who gets in when live: the work login (Google, Microsoft, any OpenID login). */
  door?: DoorOptions
  /** Git repository settings for Save and Publish. */
  changes?: ChangesOptions | false
  /** Where it runs live, when it is not Vercel: "postgres" for a server of your own. */
  on?: Home
  /** Swap one of the parts inside for another: { store: postgres({ url }) }. */
  parts?: Partial<Record<"store" | "runner" | "keys" | "permissions" | "page" | "door", Plugin>>
}

/** The parts inside, and what the project adds: the list Flowbound starts. */
export function flowbound(c: Config = {}): Plugin[] {
  const p = c.parts ?? {}
  return [
    p.store ?? postgres(),
    p.runner ?? workflowSdk({ on: c.on }),
    p.keys ?? keys(),
    p.permissions ?? ledger({ permissions: c.permissions, freshDays: c.facts?.freshDays }),
    overview(),
    context(),
    p.page ?? pages(),
    mcp(),
    ...(c.changes === false ? [] : [changes(c.changes)]),
    cli(),
    p.door ?? door(c.door),
    ...(c.schedules?.length ? [schedules(), ...c.schedules] : []),
    ...(c.providers ?? []),
    ...(c.plugins ?? []),
  ]
}

/** The project a new install starts with: the same lines `npx flowbound init` writes to flowbound.config.ts. */
export const starter = (): Plugin[] => flowbound({ providers: [firecrawl(), blitzapi(), ai()] })
