import { use } from "flowbound"

export const from = "sample_companies"
export const into = "sample_contacts"
export const summary = "Use the sample provider to find a fictional contact for each example company."
export const diagram = `
flowchart TD
  a[A sample company] --> b[Look it up at the sample provider]
  b --> c([Save the contact])
  click b lookup
`

export async function sampleContacts(company: { domain: string }) {
  "use workflow"
  return lookup(company.domain)
}

async function lookup(domain: string) {
  "use step"
  return use<{ lookup(domain: string): { contact: string | null; email: string | null } }>("sample-data").lookup(domain)
}
