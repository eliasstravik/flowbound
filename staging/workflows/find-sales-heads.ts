import { use } from "flowbound"

export const from = "target_list"
export const into = "sales_heads"
export const summary =
  "For each company on the list: find its LinkedIn page, then its most senior sales leader (CRO first, then head of sales, then VP Sales), then a work email for them. A company with no LinkedIn page, or nobody found, is skipped for the steps after. All three lookups use BlitzAPI."
export const diagram = `<svg viewBox="0 0 320 250" aria-label="Diagram of find sales heads">
<g font-size="12" fill="currentColor" font-family="system-ui, sans-serif">
<rect x="70" y="6" width="180" height="36" rx="8" fill="none" stroke="currentColor" opacity=".5"/><text x="160" y="29" text-anchor="middle">A company from the list</text>
<path d="M160 42v18" stroke="currentColor" opacity=".5"/>
<rect x="40" y="60" width="240" height="36" rx="8" fill="none" stroke="currentColor"/><text x="160" y="83" text-anchor="middle">Find its LinkedIn page (BlitzAPI)</text>
<path d="M160 96v18" stroke="currentColor" opacity=".5"/><text x="168" y="110" opacity=".6">none? stop here</text>
<rect x="40" y="114" width="240" height="36" rx="8" fill="none" stroke="currentColor"/><text x="160" y="137" text-anchor="middle">Find the top sales leader (BlitzAPI)</text>
<path d="M160 150v18" stroke="currentColor" opacity=".5"/><text x="168" y="164" opacity=".6">nobody? skip the email</text>
<rect x="40" y="168" width="240" height="36" rx="8" fill="none" stroke="currentColor"/><text x="160" y="191" text-anchor="middle">Find a work email (BlitzAPI)</text>
<path d="M160 204v18" stroke="currentColor" opacity=".5"/>
<text x="160" y="238" text-anchor="middle" opacity=".7">Name, title, LinkedIn and email in sales_heads</text>
</g></svg>`

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
