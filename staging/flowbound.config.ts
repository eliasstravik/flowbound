import { blitzapi, ledger } from "flowbound"

// The staging Flowbound: what main is, live, for trying Flowbound inside Claude. See docs/staging.md.
// Staging's own low caps: every paid run asks first, at most 25 cents a run and $5 a month, and one-off calls share
// 25 cents a day, not $1.
const permissions = { mode: "ask" as const, caps: { perRun: 0.25, perMonth: 5 } }
export default {
  changes: { directory: "staging" },
  providers: [blitzapi()],
  permissions,
  parts: { permissions: ledger({ permissions, oneOffUsdPerDay: 0.25 }) },
}
