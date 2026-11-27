// An example that costs nothing and needs no key: it tidies a list of made-up companies with plain code.
// It is here so you can see a list, a try-out, a run and its results before any provider is set up.
// A real workflow has the same shape, with provider calls in its steps: npx flowbound docs workflow-sdk
// Delete this file, and the two example tables on the Tables page, whenever you like.

export const from = "example_companies" //  the list it reads (made from examples/example-companies.csv)
export const into = "example_tidy" //       the results table it writes

// For people, on the workflow's page: one line, and a diagram with a box (click line) for each step.
export const summary = "Cleans names and domains in a list. Free."
export const diagram = `
flowchart TD
  a[A company from the list] --> b[Find its domain in the website]
  b --> c[Drop AB, Inc and the like from its name]
  c --> d([Save])
  click b domainOf
  click c shortName
`

export async function tidyCompanies(company) {
  "use workflow"
  // One row of the list comes in. Steps do the work; this function only says in which order.
  const domain = await domainOf(company)
  const name = await shortName(company)
  return { domain, short_name: name }
}

async function domainOf(company) {
  "use step"
  // "https://www.Northwind.example/about" -> "northwind.example"
  const site = String(company.website ?? "").trim().toLowerCase()
  if (!site) return null // an empty field is "not found"
  return site.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] || null
}

async function shortName(company) {
  "use step"
  // "Northwind Traders AB" -> "Northwind Traders"
  return String(company.company ?? "").replace(/[\s,]+(ab|inc\.?|ltd\.?|llc|gmbh|oy|as|bv|sa)$/i, "").trim() || null
}
