## Kept facts and permissions

Flowbound keeps every fact it paid for, with where it came from, when, and what it cost, so nothing is bought twice
while it is fresh. It also holds the person's permissions: the mode and the caps.

### Kept facts
- An answer is filed under its provider, the method and path, and the inputs cleaned first: emails in lower case, web
  addresses without `https://`, `www.` or a trailing slash, LinkedIn paths in lower case, spaces trimmed. The same
  question asked again inside the freshness window (30 days unless `facts: { freshDays }` in flowbound.config.ts says
  otherwise; one call may pass `freshDays`) is answered from memory at no cost. "Not found" is such a fact too.
- `npx flowbound lookup <value>` finds every kept answer whose cleaned inputs hold that value, from any provider,
  with its age and whether it is still fresh. Free. It finds exact inputs only: matching "Acme Inc" to acme.com is
  your job.
- Every answered cell of a results table says where it came from, how old it is and what it cost: "BlitzAPI · bought
  12 days ago for $0.004 · free now", "already known · free", "BlitzAPI · bought again today for $0.004 · the last
  answer was 140 days old".
- A write to another tool (a card with `writes`, or a call with `write: true`) is an act, not a fact: it is done every
  time, never answered from memory, and not in `lookup`.

### Permissions
`permissions` in flowbound.config.ts, like an agent app's own permission modes:

```ts
permissions: {
  mode: "auto",                                         // "ask" | "auto" | "skip"
  caps: { perRun: 5, perMonth: 100, writesPerMonth: 500 },
  workflows: { "big-enrich": { mode: "ask" } },         // a rule of its own: a mode, caps, or both
  providers: { hubspot: { writesPerRun: 200 } },
}
```

- **ask**: every paid run (a run whose workflow calls a provider) waits for the person's yes first, a 10-row try too.
- **auto**: runs spend freely up to the caps. A new install starts here, at $5 a run and $100 a month.
- **skip**: no asking and no caps. Only a budget said in chat holds.
- Caps: `perRun`, `perMonth` (dollars), `callsPerRun`, `callsPerMonth` (for a card with no price), `writesPerRun`,
  `writesPerMonth` (writes to other tools, by number). The strictest rule that holds for a run wins: the project's,
  its workflow's, and every provider it calls.
- A budget the person says in chat ("don't spend more than $5") is that run's cap in every mode: `--max-usd 5`.
- Before a call, the most it could cost is set aside against every cap that holds it; what the provider reports
  replaces it afterwards; a failed call is released and costs nothing.
- When a cap is reached the run pauses and a yes waits under Needs you, saying which cap. Ask the person, word for
  word, and pass their answer on: `npx flowbound yes <run>` (with `--max-usd <n>` when they name a new cap) or
  `npx flowbound no <run>`. A yes on the run's own cap sets a new cap; on this month's, a provider's or the write cap,
  it lifts that cap for that run only. Never say yes for the person.
- The price check: when a provider reports a higher price for an endpoint than its card (or the call) said, that
  price is set aside for every later call to it, and `npx flowbound spend` shows it. Tell the person.
- A card's speed limit (`rate`) is kept here too, across rows, runs and copies of Flowbound.
- One-off calls you make to look at a provider's answers share $1 a day (and 100 calls of cards with no price).

`npx flowbound permissions` shows the mode, the caps and what this month has used. `npx flowbound spend` shows each
provider this month. `npx flowbound fact <id>` shows one kept fact: the request, the whole answer, the date, the age
and the cost. The dollar figures are Flowbound's own count from the price on each card; on a provider that sells a flat
plan they are not a bill.
