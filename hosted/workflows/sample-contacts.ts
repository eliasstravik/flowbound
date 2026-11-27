import { use } from "flowbound"

export const from = "sample_companies"
export const into = "sample_contacts"
export const summary = "Use the sample provider to find a fictional contact for each example company."
export const diagram = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 42"><text x="10" y="24">Sample company → Sample provider → Contact</text></svg>`

export async function sampleContacts(company: { domain: string }) {
  "use workflow"
  return lookup(company.domain)
}

async function lookup(domain: string) {
  "use step"
  return use<{ lookup(domain: string): { contact: string | null; email: string | null } }>("sample-data").lookup(domain)
}
