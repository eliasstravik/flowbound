## Keys and provider cards

A data provider is a small card: where it lives, how its key attaches, where its manual is, what a call costs.
You read the manual and write the calls. A connection is a name the person chooses and a key, typed once on the
Connections page (http://localhost:4111/keys), kept outside the project folder, and attached by Flowbound on the way
out, only to the address of the card that takes it. A card takes its key by name: a built-in card's is its name in
capitals and `_KEY` (`BLITZAPI_KEY`; a webhook's is `<ID>_SECRET`); for a provider Flowbound has never heard of, the
person adds a key under any name (`SAMPLE_DATA_KEY`) and you write a card that takes it:
`key: { header: "x-api-key", name: "SAMPLE_DATA_KEY" }`. Nothing is checked when it is typed: a wrong key shows when a
run fails. `npx flowbound keys` says which cards have one. Nothing prints or returns a key.
The Connections page lists each saved key, and each key a workflow (or webhook) needs and nobody saved, with the
workflows that use it (read from each file's `use("...")`), Set or Missing, and Change; a missing one a workflow
waits for comes first. There is no list of known services. `npx flowbound doctor` says which keys are missing for which workflow; `--deep` also tries every saved key
again at its provider.

A card of your own is one file in `plugins/` plus its line in `providers` in `flowbound.config.ts`:

```ts
// plugins/acme-data.ts
import { provider } from "flowbound"

export const acmeData = () =>
  provider({
    name: "acme-data", //                      use("acme-data") in a step; `npx flowbound acme-data <path>` to try a call
    label: "Acme Data",
    host: "api.acme-data.example", //          only this address ever gets the key (https; write "http://127.0.0.1:4999" for plain http or a port)
    key: { header: "x-api-key" }, //           or { header: "authorization", prefix: "Bearer " }
    docs: "https://docs.acme-data.example",
    price: { perCall: 0.004 }, //              from the price page; leave out when unknown (runs are then capped by calls)
    rate: { perSecond: 2 }, //                 the provider's speed limit, kept across all rows and runs (or perMinute)
    check: "/v1/me", //                        a free path that answers a bad key with 401: `doctor --deep` tries saved keys there
  })
```

Other card lines: `price.reported: (answer) => usd` when the provider reports each call's cost in its answer
(`answer.data`, `answer.headers`); that wins over `perCall`. A card that can write to another tool (a CRM, a sequencer) says
which calls write: `writes: ({ method, path }) => method !== "GET"` (or `true`); each write counts against the write
caps and is never answered from memory (`hubspot()` is the example). How long a kept fact stays fresh is one setting
for the project, `facts: { freshDays }`, not a card line. With `check`, `npx flowbound doctor --deep` finds a saved key the provider no longer takes; pick a path
from the manual that costs nothing (an account or credits endpoint). A webhook's signing secret is typed on the
same page (see `npx flowbound docs schedules`).

Every card that ships with Flowbound takes the same lines as overrides: `blitzapi({ rate: { perSecond: 2 } })`.
For a machine that should hold no keys at all, point a card at a proxy that adds the key:
`blitzapi({ host: "blitz-proxy.example.com", key: false })`. The path is passed on unchanged; the person brings the
proxy. On the person's own computer that is the only hard wall: keys are kept out of the chat and out of the
project folder, but an agent with the whole machine could still dig one out.
