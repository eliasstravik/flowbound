import { use } from "flowbound"

export const from = "target_list"
export const into = "sales_heads"
export const summary =
  "For each company on the list: find its LinkedIn page, then its most senior sales leader (CRO first, then head of sales, then VP Sales), then a work email for them. A company with no LinkedIn page, or nobody found, is skipped for the steps after. All three lookups use BlitzAPI."
export const diagram = `
flowchart TD
  a[A company from the list] --> b[Find its LinkedIn page]
  b --> c{Found?}
  c -- no --> z([Skip it])
  c -- yes --> d[Find the top sales leader]
  d --> e{Found?}
  e -- yes --> f[Find a work email]
  e -- no --> g([Save without an email])
  f --> h([Save name, title, LinkedIn and email])
  click b companyLinkedin
  click d findHead
  click f findEmail
`

const EXCLUDE = [
  "Assistant", "Executive Assistant", "Advisor", "Office of", "Former",
  "Operations", "Enablement", "Engineering", "Compensation", "Strategy", "Recruiter", "Recruiting",
]

// Most senior first: tier 1 is the company-wide sales leader, later tiers fall back.
const CASCADE = [
  { include_title: ["Chief Revenue Officer", "[CRO]", "Chief Sales Officer", "Chief Commercial Officer", "Global Head of Sales", "President Sales"], exclude_title: EXCLUDE },
  { include_title: ["Head of Sales", "SVP Sales", "Senior Vice President Sales", "EVP Sales", "Executive Vice President Sales"], exclude_title: EXCLUDE },
  { include_title: ["VP Sales", "Vice President Sales"], exclude_title: EXCLUDE },
]

export async function findSalesHeads(company) {
  "use workflow"
  const linkedin = await companyLinkedin(company.domain)
  if (!linkedin.value) return { company_linkedin: linkedin, head_name: null, head_title: null, head_linkedin: null, email: null }
  const head = await findHead(linkedin.value)
  const email = head.linkedin.value ? await findEmail(head.linkedin.value) : null
  return { company_linkedin: linkedin, head_name: head.name, head_title: head.title, head_linkedin: head.linkedin, email }
}

async function companyLinkedin(domain) {
  "use step"
  const res = await use("blitzapi").fetch("/v2/enrichment/domain-to-linkedin", { body: { domain } })
  return res.pick("company_linkedin_url")
}

async function findHead(companyLinkedinUrl) {
  "use step"
  const res = await use("blitzapi").fetch("/v2/search/waterfall-icp-keyword", {
    body: { company_linkedin_url: companyLinkedinUrl, cascade: CASCADE, max_results: 1 },
  })
  return {
    name: res.pick("results.0.person.full_name"),
    title: res.pick("results.0.person.headline"),
    linkedin: res.pick("results.0.person.linkedin_url"),
  }
}

async function findEmail(personLinkedinUrl) {
  "use step"
  const res = await use("blitzapi").fetch("/v2/enrichment/email", { body: { person_linkedin_url: personLinkedinUrl } })
  return res.pick("email")
}
