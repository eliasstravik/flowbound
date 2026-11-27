import { ai, blitzapi, firecrawl } from "flowbound"
import type { Config } from "flowbound"

export default {
  // The data providers your workflows call. Keys are typed on the Keys page, never in a chat.
  providers: [firecrawl(), blitzapi(), ai()],

  // How much your agent may do without asking. Modes: "ask" (every paid run asks first), "auto" (spends freely up to
  // your caps), "skip" (no asking, no caps). A workflow or provider can have its own mode or caps; the strictest wins.
  permissions: { mode: "auto", caps: { perRun: 5, perMonth: 100, writesPerMonth: 500 } },

  // Run a workflow by itself, one line each (add schedule and hook to the import above):
  // schedules: [
  //   schedule({ id: "weekly-heads", workflow: "find-sales-heads", every: "monday 08:00", timezone: "Europe/Stockholm" }),
  //   hook({ id: "new-leads", workflow: "enrich-lead", key: "email" }),
  // ],
} satisfies Config
