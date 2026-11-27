## Workflows

Save a workflow from chat with the tools in the Changes guide (`npx flowbound docs changes`).
Its code stays in Git. Engineers can also edit it on a branch and open a pull request in GitHub.

A workflow is one TypeScript file in `workflows/`, on the open Workflow SDK. Its path is its id:
`workflows/find-sales-heads.ts` is `find-sales-heads`, exports the function `findSalesHeads`, and people see it as
"Find sales heads". Put the workflows of one play in a folder, with subfolders if it helps:
`workflows/tam-mapping/find-sales-heads.ts` is `tam-mapping/find-sales-heads` (folder and file names in lower-case
letters, digits and dashes), and that id is what `npx flowbound run`, schedules and webhooks name. In a folder, a file
without `"use workflow"` is a helper, not a workflow. The file says where its list comes from and where the answers go, handles **one row**, and
returns the answer. Flowbound does the rest: reads the list, saves each answer, skips rows already done, runs 5 rows
at a time, keeps which paid answer each field came from, and holds every call to the person's permissions.

```ts
// workflows/find-sales-heads.ts
import { use } from "flowbound"

export const from = "target_list" //  the list table to read
export const into = "sales_heads" //  the results table to write (made for you)

/** Find the head of sales at each company and a work email for them. */
export async function findSalesHeads(company) {
  "use workflow"
  // `company` is one row of the list: an object with the list's columns (all text) and its id.
  const head = await findHead(company)
  const email = await findEmail(head)
  return { head: head.name, email } // one column per field, named as returned
}

/** Look up the most senior sales leader at the company. */
async function findHead(company) {
  "use step"
  const res = await use("blitzapi").fetch("/v2/search/waterfall-icp-keyword", {
    body: { company_linkedin_url: company.linkedin_url, cascade: [{ include_title: ["Head of Sales", "VP Sales"] }], max_results: 1 },
  })
  return { name: res.pick("results.0.person.full_name"), linkedin: res.data.results?.[0]?.person?.linkedin_url ?? null }
}

/** Get a work email for that person. */
async function findEmail(head) {
  "use step"
  if (!head.linkedin) return null // nothing to look up: the field stays empty ("not found")
  const res = await use("blitzapi").fetch("/v2/enrichment/email", { body: { person_linkedin_url: head.linkedin } })
  return res.pick("email")
}
```

This file is an example of the shape, not of the right calls: which endpoints to chain, and which field of an
answer is the right one, come from the provider's manual and from looking at a few real answers. A step can take
more than one argument, return an array of picked values, and build a pick path (`all_emails.${i}.email`).
Look at the try-out's rows (`npx flowbound table <into>`) before you run the rest.

### The summary and the diagram, for people

People read and understand a workflow on its page through what you write for them, in the file beside the code.
Write both with every workflow:

```ts
export const summary = "Finds the head of sales at each company, then a work email."
export const diagram = `
flowchart TD
  a[Companies from your list] --> b[Find the head of sales]
  b --> c{Found?}
  c -- yes --> d[Find their work email]
  c -- no --> f[Mark as not found]
  d --> e([Save])
  f --> e
  click b findHead
  click d findEmail
`
```

- `summary`: one plain line for a business person: what goes in and what comes out. No code words.
- `diagram`: a Mermaid flowchart (`flowchart TD`) of what the workflow does, the way you would explain it to the
  person: boxes in plain words, a `{diamond}` for each decision with its answers on the arrows (`-- yes -->`),
  branches, merges and loops as they are. Flowbound draws it with Mermaid in its own colours and font, first thing
  on the workflow's page.
- One `click <box> <function>` line for every `"use step"` function, naming the box that stands for it: tapping the
  box shows that step's code. A step with no click line gets a quiet line on the page saying the diagram doesn't
  show it, and `npx flowbound workflows` names it.
- **Keep it in step with the code.** Every time you change the code, change the diagram (and the summary) in the same
  edit: a new step gets a box and a click line, a removed one goes, a new branch is drawn. Read the diagram back
  against the code before you save.
- Without a diagram the page opens on the code with a line saying there is none. `npx flowbound workflows` lists the
  workflows that still lack a summary or a diagram.

### The two kinds of function

- The **workflow function** starts with `"use workflow"`. It only decides what happens in which order: call steps,
  `await` them, use `if` and loops, return the answer. No `fetch`, no `use()`, no files, no `Date.now()` here.
- A **step** starts with `"use step"`. Everything that touches the world goes in a step: provider calls, SQL, a
  model. A step's result is kept, so when a run is picked up after a stop, finished steps are not done again.
  What a step returns must be plain data (objects, arrays, text, numbers).

### Calling a provider

`use("<card name>").fetch(path, { body, query, method, headers, price })` calls the provider at its card's address
with the person's key attached; you never see the key and cannot send it anywhere else. A `body` makes it a POST
with JSON. It returns:

- `res.data`: the provider's answer (parsed JSON), `res.status`, `res.ok` (false for "not found", status 404)
- `res.pick("path.to.value")`: `{ value, fact }`, the value together with the id of the paid fact it came from.
  Return picked values from the step and from the workflow as they are (read `.value` in code when you need it);
  the results page then shows for that field where it came from, when, and what it cost. A field returned as a
  plain value shows "worked out by <workflow title>" with the calls made for that row. Paths use dots: `data.web.0.url`.
- `res.cost` (USD; 0 when answered from memory), `res.fromMemory`

When the path is not in the answer (or the provider said "not found"), `pick` gives `{ value: null, fact }`. A field
that ends up `null` or empty, picked or plain, is "not found": the cell stays empty and is not counted as filled.
A picked value is plain data, so it travels between steps and out of the workflow unchanged; pass it on as it is
and read `.value` where the next call needs the bare value, as `findEmail(head)` could with `head.linkedin.value`.

Pass `price` (USD) when the manual prices this endpoint differently from the card. A call that fails with a busy
or broken provider is tried 3 times with a wait between (`export const retries` changes that); if it still fails the row is marked failed with the reason
and the run goes on. Do not catch those errors to carry on yourself: let them stop the row.

### Steps that need a model

`await use("ai").ask("Is this person the head of sales? Answer yes or no.", profile)` returns text;
`use("ai").pick(question, input)` returns `{ value, fact }` for a field. Call it from a step. A model is a provider
card like any other: each answer is priced from its own token usage and counts against the cap, and the same
question about the same input is answered from memory. Before each call the most it could cost is set aside (the
whole prompt, and `maxTokens` of answer), so keep the input to what the question needs and pass
`{ maxTokens: 300 }` as a third argument when the answer is short.

It runs on the model key the person types on the Keys page, here and live. See "AI model" under the provider cards
(`npx flowbound docs ai`).

### Your own tables

`await use("records").query("select ... where x = $1", [x])` runs SQL on the person's database from a step or a
tool; `npx flowbound sql "<statement>"` does the same from the command line. Make any table the job needs.

`await use("records").add("people_list", rows, { key: "linkedin_url" })` adds rows to a list from a step: one row
in, many rows out (a company's people), and the list the next workflow reads. The list and its columns are made as
needed. Always give a `key`: a row whose key is already there is brought up to date instead of added again, so a
step that runs twice leaves no doubles.

### Recipes

`npx flowbound docs recipes` prints whole workflow files for shapes that come up again and again. Read it when a
job has one of them, not before:

1. ask a second provider when the first finds nothing
2. score each row against criteria, with a model
3. one row in, many rows out, and one table feeding the next
4. new rows every week
5. a webhook sender with a shape of its own

### Other lines a workflow file can have: its habits

```ts
export const concurrency = 2 //                    rows at a time (5 unless set)
export const retries = 1 //                        more tries for a busy or unreachable provider (2 unless set)
export const pauseAfter = { failed: 5, of: 10 } // pause when this many of the last rows failed (11 of 20; false: never)
```

### Running under the person's permissions

Every run is held to the permissions in `flowbound.config.ts` (`npx flowbound permissions` shows them):

- **auto** (a new install): the run starts and spends inside the caps.
- **ask**: a run that calls a paid provider waits for the person's yes first, a try-out too. The `run` command says the
  question; ask the person, word for word, and pass their answer on.
- **skip**: it just runs, with no caps.
- A budget the person says in chat ("don't spend more than $5") is `--max-usd 5`: that run's cap, in every mode.
- When a cap is reached the run pauses, and its yes waits under Needs you (`/needs`) and in `npx flowbound doctor`.
  Ask the person; pass on a yes with `npx flowbound yes <run>` (`--max-usd <n>` when they name a new cap) or a no
  with `npx flowbound no <run>`. Never say yes for them, and never widen the permissions in flowbound.config.ts unless
  they ask you to.

### Running by itself: on a schedule, or for each row that arrives

That is not a line in the workflow file. It is one line in `schedules: [...]` in `flowbound.config.ts`,
`schedule({ ... })` or `hook({ ... })`, and the runs it starts are under the same permissions. Once a line is there,
`npx flowbound docs schedules` has the whole recipe (the webhook's signing secret, the `every` forms, a rule of its
own for that workflow's caps).

### Commands

- `npx flowbound workflows`: the workflow files, what is wrong with any of them, and which still lack a summary and
  diagram (`--check` fails when one is not ready)
- `npx flowbound workflow <id>`: one workflow as the person sees it: summary, diagram, last run
- `npx flowbound run <id> --try 10`: a try-out on the first rows not done yet
- `npx flowbound run <id> [--max-usd 1.60] [--wait]`: the rows that are left, after a finished try-out
- `npx flowbound run <id> --rows 100`: only the next 100 rows not done yet, when the person says "do a hundred first"
- `npx flowbound yes <run> [--max-usd <n>]` / `npx flowbound no <run>`: the person's answer to a run that waits
- `npx flowbound runs` / `npx flowbound runs <number>`: all runs / one run with its failed rows, when it started
  and how long it took; `--state paused` or `--workflow <id>` shows only those
- one run of a workflow at a time: a second start is refused with the number of the one that is going
- `npx flowbound resume <number>` (after failures or a missing key), `npx flowbound stop <number>`
- `npx flowbound lookup <value>`: what is already known about an email, a domain or a name, from every provider

### Going live

`npx flowbound deploy` puts the same project on Vercel with a Neon database (it runs Vercel's own command-line tool
and sign-in). The person's local tables stay local; the kept facts can be copied up. Live, the person's agent passes on
their yes as it does here, signed in as them, when they may approve. `on: "postgres"` in flowbound.config.ts is for any server of
your own; see the guide `docs/homes.md` in the flowbound package.
