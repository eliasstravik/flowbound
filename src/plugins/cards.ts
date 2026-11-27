// Provider cards that ship with Flowbound. Each is a few lines: copy one into plugins/ to make your own.
// Addresses, key headers and prices were read from each provider's own manual on 24 Nov 2026.
import { type Card, provider } from "./provider.ts"

type Over = Partial<Card>
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/** Firecrawl: search the web and read pages. Hobby plan: $19 for 5,000 credits, so $0.0038 a credit. */
export const firecrawl = (over: Over = {}) =>
  provider({
    name: "firecrawl",
    label: "Firecrawl",
    host: "api.firecrawl.dev",
    key: { header: "authorization", prefix: "Bearer " },
    docs: "https://docs.firecrawl.dev/llms.txt",
    about: "Web search and page scraping. POST /v2/search and POST /v2/scrape. Both also answer without a key, inside a small daily allowance per network address: firecrawl({ key: false }).",
    // A scrape is 1 credit; a search reports its credits as creditsUsed.
    price: { perCall: 0.0038, reported: (a) => (num((a.data as any)?.creditsUsed) ?? 1) * 0.0038 },
    rate: { perSecond: 1 },
    check: "/v2/team/credit-usage",
    ...over,
  })

/** BlitzAPI: B2B people and company data. Flat plans; Start is $99 for 200,000 records, so about $0.0005 a record. */
export const blitzapi = (over: Over = {}) =>
  provider({
    name: "blitzapi",
    label: "BlitzAPI",
    host: "api.blitz-api.ai",
    key: { header: "x-api-key" },
    docs: "https://docs.blitz-api.ai/llms.txt",
    about: "People and company lookups from a LinkedIn URL or a domain. All calls are POST with a JSON body under /v2.",
    price: { perCall: 0.0005 },
    rate: { perSecond: 5 },
    check: "/v2/account/key-info",
    ...over,
  })

/** Monid: one wallet for many data endpoints. Each run reports what it cost. */
export const monid = (over: Over = {}) =>
  provider({
    name: "monid",
    label: "Monid",
    host: "api.monid.ai",
    key: { header: "authorization", prefix: "Bearer " },
    docs: "https://monid.ai/docs/llms.txt",
    about: "A catalogue of data endpoints paid from a prepaid wallet: POST /v1/discover/endpoints to find one, /v1/inspect for its inputs and price, /v1/run to call it.",
    price: {
      reported: (a) => {
        const cost = (a.data as any)?.billing?.reportedCost
        const value = num(cost?.value)
        return value === undefined ? undefined : value / ({ MICRO_DOLLAR: 1_000_000, CENT: 100, DOLLAR: 1 }[cost.unit as string] ?? 1)
      },
    },
    ...over,
  })

/** treg: an open tool registry. Each call reports its cost in a header; calls on your own provider keys cost nothing. */
export const treg = (over: Over = {}) =>
  provider({
    name: "treg",
    label: "treg",
    host: "treg.to",
    key: { header: "x-treg-token" },
    docs: "https://treg.to/llms.txt",
    about: 'A registry of data tools: POST /call/<endpoint-id>, like /call/treg.people.search. Self-hosted: treg({ host: "http://localhost:18790" }).',
    price: { reported: (a) => (a.headers["x-treg-cost-micro"] === undefined ? 0 : (Number(a.headers["x-treg-cost-micro"]) || 0) / 1_000_000) },
    ...over,
  })

/**
 * HubSpot: a CRM that Flowbound can read and write, under the same permissions. Its API has no price per call, so a
 * call costs $0; a write counts by number against the write caps (writesPerRun, writesPerMonth). Searches are POST
 * but only read. A private app's token, typed on the Connections page.
 */
export const hubspot = (over: Over = {}) =>
  provider({
    name: "hubspot",
    label: "HubSpot",
    host: "api.hubapi.com",
    key: { header: "authorization", prefix: "Bearer " },
    docs: "https://developers.hubspot.com/docs/api-reference/latest/overview",
    about:
      "Read and write CRM records: GET /crm/v3/objects/contacts, POST /crm/v3/objects/contacts/search (reads), POST /crm/v3/objects/contacts (writes), PUT /crm/v3/lists/{id}/memberships/add (writes). Every write counts against the write caps.",
    price: { perCall: 0 },
    rate: { perSecond: 10 },
    writes: ({ method, path }) => method !== "GET" && !/\/search$/.test(path),
    check: "/crm/v3/objects/contacts?limit=1",
    ...over,
  })
