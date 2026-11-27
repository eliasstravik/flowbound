## Recipes

Shapes that come up again and again, each a whole workflow file. Copy one only when the job asks for it, then make
it the job's own. `acme` and `backup` stand for provider cards the project has; the paths and the fields of each
answer are made up here, so read the real ones in the provider's manual and try one call first. Every recipe is
run by Flowbound's own tests against a fake provider and a fake model, so the shape is known to work.

### 1. Ask a second provider when the first finds nothing

The cheapest or best source first; the next one only for the rows it left empty.

```ts
// workflows/find-heads-two-sources.ts
import { use } from "flowbound"

export const from = "target_list"
export const into = "heads_two_sources"

export async function findHeadsTwoSources(company) {
  "use workflow"
  const first = await askFirst(company)
  if (first.value) return { head: first, found_by: "acme" }
  const second = await askSecond(company)
  return { head: second, found_by: second.value ? "backup" : null }
}

async function askFirst(company) {
  "use step"
  const res = await use("acme").fetch("/v2/head", { body: { company: company.company } })
  return res.pick("person.full_name")
}

async function askSecond(company) {
  "use step"
  const res = await use("backup").fetch("/v2/head-b", { body: { company: company.company } })
  return res.pick("person.full_name")
}
```

- One step for each provider, so each answer is kept on its own: a run that is picked up again never asks the
  first provider twice, and "not found" is remembered like any answer.
- Decide between them in the workflow function, with a plain `if`. Do not catch a provider's error to move on to
  the next one: an error is not "nothing found", and a row that fails is tried again by the next run.
- `head` carries its source, so the results page shows which provider each name came from. The try-out's numbers
  say how many rows needed the second one, which is what the full run will cost.

### 2. Score each row against criteria, with a model

For "is this company a fit", "is this person the buyer", "which of these three segments".

```ts
// workflows/score-fit.ts
import { use } from "flowbound"

export const from = "target_list"
export const into = "fit_scores"

// The criteria are part of this file on purpose: a full run needs a try-out of the file as it is,
// so changing what "a fit" means asks for a new try-out.
const CRITERIA = `
A strong fit has all of these:
- sells to other companies, not to consumers
- between 50 and 1,000 people
- has its own sales team
Not a fit: agencies, and anything in gambling.
`

export async function scoreFit(company) {
  "use workflow"
  const verdict = await judge(company)
  return { fit: verdict.fit, why: verdict.why }
}

async function judge(company) {
  "use step"
  const question = `Judge this company against the criteria. First the evidence, then the verdict.
Answer as JSON only: {"why": "<one sentence: the evidence you used>", "fit": "strong" | "possible" | "no" | "unknown"}
Say "unknown" when the facts are not in what you were given. Never guess, and never invent a fact.

Criteria:
${CRITERIA}`
  const answer = await use("ai").pick(question, { company: company.company, domain: company.domain }, { maxTokens: 300 })
  let said = {}
  try {
    said = JSON.parse(String(answer.value).match(/\{[\s\S]*\}/)?.[0] ?? "{}")
  } catch {}
  // Both fields came from the one answer, so both carry its fact.
  return { fit: { value: said.fit ?? null, fact: answer.fact }, why: { value: said.why ?? null, fact: answer.fact } }
}
```

- Ask for the evidence before the verdict, and for a word ("strong", "possible", "no", "unknown") rather than a
  number: a number looks exact and is not. Missing facts are "unknown", never a low score.
- Give the model only what the question needs (the cap sets aside the whole prompt first), and a small
  `maxTokens` for a short answer.
- The model judges what it is given. To judge from the company's own website, read the page in a step before
  (a provider card that reads pages) and pass the text in.
- Sort and filter the result in SQL: `where fit #>> '{}' = 'strong'`.

### 3. One row in, many rows out, and one table feeding the next

A company becomes its five people; then each person gets an email. Two workflows, the first filling the list the
second reads.

```ts
// workflows/find-people.ts
import { use } from "flowbound"

export const from = "target_list"
export const into = "people_found"

export async function findPeople(company) {
  "use workflow"
  return { people: await savePeople(company) }
}

async function savePeople(company) {
  "use step"
  const res = await use("acme").fetch("/v2/people", { body: { company: company.company } })
  const people = (res.data.people ?? []).map((p) => ({ name: p.name, linkedin_url: p.linkedin_url, company: company.company }))
  // Rows for the next workflow's list. The key makes it safe to do twice: a person already there is not added again.
  await use("records").add("people_list", people, { key: "linkedin_url" })
  return { value: people.length, fact: res.fact }
}
```

```ts
// workflows/people-emails.ts
import { use } from "flowbound"

export const from = "people_list"
export const into = "people_emails"

export async function peopleEmails(person) {
  "use workflow"
  return { email: await findEmail(person) }
}

async function findEmail(person) {
  "use step"
  const res = await use("acme").fetch("/v2/email", { body: { linkedin_url: person.linkedin_url } })
  return res.pick("email")
}
```

- `use("records").add(list, rows, { key })` makes the list and its columns as needed. Always give a `key` in a
  step: a step can run twice, and the key is what keeps a second time from doubling the rows.
- Each workflow has its own try-out and its own runs, each under the permissions. Run the first, look at
  `people_list`, then try the second.
- The same key works for a list a person brings again: `npx flowbound import people.csv --add --key email`
  brings rows already there up to date and adds only the new ones.

### 4. New rows every week

"Every Monday, do this for whatever is new." A run only takes rows that have no result yet, so a schedule over a
list that grows is exactly that. Nothing is added to the workflow file:

```ts
// flowbound.config.ts
schedules: [schedule({ id: "weekly-emails", workflow: "people-emails", every: "monday 08:00", timezone: "Europe/Stockholm" })],
```

The list grows by any of: a fresh export imported with `--add --key`, rows a sender posts to a `hook({ ... })`
line, or another workflow adding rows with `use("records").add` (recipe 3). Each run it starts is under the person's
permissions; give the workflow caps of its own if they want it kept small: `npx flowbound docs schedules`.

### 5. A sender with a shape of its own

A booking tool or a CRM posts its own JSON, with the person nested inside and more kinds of event than you want.
The webhook line reads it:

```ts
// flowbound.config.ts, in schedules: [...]
hook({
  id: "bookings",
  workflow: "enrich-lead",
  key: "email",
  // What the sender posts in, a row out. Nothing for an event that is not a row.
  row: (event) => (event.type === "booking.created" ? { email: event.payload.attendee.email, name: event.payload.attendee.name } : null),
}),
```

The signature is still checked first, on the exact body. An ignored event is answered 200, so the sender does not
send it again.
