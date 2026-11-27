# Flowbound

Flowbound is an open-source agent plugin for GTM workflows: list building, research, enrichment, on the person's own
data provider keys. You, the agent, write each job as a workflow file and run it. Flowbound is the part you cannot
be: it stays up for days, keeps every fact that was paid for, holds keys you never see, enforces the person's
permissions, and shows people the app in their chat or on the web. How a job is done is yours to decide.

Run commands as `npx flowbound <command>` from the project folder. Any command starts Flowbound in the background
if it is not running (`.flowbound/dev.log` is its log); `npx flowbound dev` runs it in the foreground instead.
`npx flowbound <command> --help` lists a command's inputs. `npx flowbound docs <plugin>` prints one part of this text
again; the parts are the plugin names `npx flowbound plugins` lists (`workflow-sdk`, `postgres`, `keys`, `ledger`, ...).
Over MCP, `search` finds tools and their inputs, and `execute` runs a few lines of JavaScript that
call them (`return await flowbound.runs({ state: "running" })`); `npx flowbound execute "<code>"` does the same here.
Return a run, table or workflow directly from `execute` to get the arguments for `show` in supported chats.
Call `show` only when a view helps the person. If they ask for no app, skip `show`. To open the app home,
call `show` without a selection.
The run view updates live and shows the outcome or when it needs input. Open it once, tell the person it updates,
and pass along any question the run is waiting on. Leave the link to the app's **Open web page** button.
In text-only chats, `show` and displayable `execute` results return a web link. Share it if the person can reach it. If the person needs the outcome
in text, wait in the same execute call:

```js
const run = await flowbound.run({ workflow: "my-workflow", wait: false })
return await flowbound.wait({ run: run.run, seconds: 30 })
```

The wait returns the latest run when it leaves `running` (including a pause or a request for approval), or when
the time runs out. The wait is capped at 30 seconds and may be shorter if execute has less time left.
To open a known run, call `show` with `{ run: 123 }`. You can also pick a `table`, `workflow` or `page`
(such as `{ page: "needs" }` for waiting approvals). Set `render: false` on background `execute` calls
or to get full text results in an app-capable chat without suggesting a view.
The first local tool call sets up the open project folder and starts the database, runner and pages. The runner
started by the agent shuts down when the last agent session using it ends. Use `npx flowbound dev` before
connecting the agent if runs or schedules need to keep going on this computer after the session ends.
If the person has selected their company using `npx flowbound connect <address>`, use the MCP tools for
company work. The plugin opens the browser for work sign-in when needed. Shell commands still work on the
project in this folder and its own data. Use Save and Publish to send workflow changes to the company.
With only an MCP connection and no shell, read this same guide with
`return await flowbound.docs({ topic: "start" })` in `execute`. `topic: "topics"` lists the parts;
`"workflow-sdk"`, `"ledger"`, and `"recipes"` read those parts. Leaving topic out returns the whole current guide.

## If the person only has a phone

Point them to the Deploy to Vercel button in the Flowbound GitHub README. It copies Flowbound to their GitHub and
sets up a Vercel project with Neon. They enter two separate values from their password manager in Vercel for
`FLOWBOUND_SECRET` and `FLOWBOUND_PASSWORD`. After deployment, use the production address followed by `/mcp` as
the custom connector address. The person signs in on Flowbound’s page, allows the connector, then turns it on
in the chat. Never ask for their password or provider keys. [Phone setup](https://github.com/eliasstravik/flowbound/blob/main/docs/homes.md#start-from-the-deploy-button)

## Creating or changing a workflow, including from a chat

Workflows are TypeScript files in this project's Git repo. Read `workflow-sdk` for the file format and `recipes`
for examples. Each file lives at `workflows/<job-name>.ts` next to `flowbound.config.ts` and includes a summary
and diagram for people.

From chat, read the file and commit with `workflow-file`, then write the file and call `workflow-save`.
Share the saved change link. Use `workflow-change` to see its checks and preview. When the person asks to
publish, use `workflow-publish` with the checked commit. Help them find any required review in GitHub. Use
`workflow-undo` to save a revert, then check and publish it. A Member can do all of this. The local steps are
the same with local Git. Engineers can use GitHub directly and see their pull requests under Changes.

Read `changes` for the precise inputs, roles, and the owner's one-time setup. On staging, the project's directory
in Git is `staging/` and its workflow paths in the connector still start with `workflows/`.

The app inside chat uses the same connection you use. Pages on the local machine use port 4111 by default. Deploy or set
`FLOWBOUND_URL` to the address the person can reach to share links across devices. The signed-in website is where
people change keys and access. A CSV can be imported from any path. Write the workflow from the provider's
manual before its key is in, then make the real call once it is.

## Talking to the person

The person is often on a phone, between other things. Write for that.

- A few plain lines. The result or the numbers first, then what they need to decide.
- One question at a time, and only one they alone can answer. What you can look up, look up.
- Ask for a yes only when Flowbound asks for one (a run that waits on Home) and for what cannot be undone.
  Everything else, do and say you did.
- Say what a thing costs before it is bought, in dollars, with the cap you suggest.
- When something is wrong, say what, what you did about it, and the one thing they must do, with its link.
- Never invent a fact to fill a hole: "not found" and "I do not know" are answers.

`npx flowbound doctor` lists everything that needs the person or is not right, each with the one thing to do. Run it
first when something seems off, and before you tell them all is well. The person sees the same list on the page
on Home: http://localhost:4111/home.

## A job, start to finish

The person says something like "find the head of sales at each of these 200 companies and get a work email".

0. **What you know.** `npx flowbound context` lists the files in `context/` (the company, its ICPs, personas,
   pricing, notes: whatever is there); read the ones that matter for the job (`--path <file>`). When the person tells
   you something worth keeping, write it down there as a Markdown file. See `npx flowbound docs context`.
1. **The list.** `npx flowbound import targets.csv` makes a list table (`target_list`) from a CSV whose first line
   is column names; `--folder <folder>` files it with the play's workflows under workflows/<folder>/. `npx flowbound tables` shows what is there. A list the person brings again (a fresh export):
   `--add --key email` brings rows already there up to date and adds only the new ones.
2. **The providers.** `npx flowbound keys` shows which provider cards have a key. Each card is listed further down
   with its manual. If a card you need has no key, stop and tell the person: "Add the Firecrawl and BlitzAPI keys on
   the Connections page: http://localhost:4111/keys. I can use them, but I never see them." Never ask for a key in the chat,
   never look for the keys file.
3. **Learn the calls.** Read the provider's manual (the link on its card). Then make one real call to see what
   comes back: `npx flowbound blitzapi /v2/enrichment/email --body '{"person_linkedin_url":"..."}'`.
   One-off calls share an allowance of $1 a day; the same call twice is answered from memory for free.
   `npx flowbound lookup <value>` says what is already known about an email, a domain or a name, from any provider.
4. **Write the workflow** in `workflows/<id>.ts` (see "Workflows" below), with its summary and diagram for people
   (`export const summary`, `export const diagram`). `npx flowbound workflows --check` says if the file is well
   formed; `npx flowbound workflow <id>` shows what the person will read on its page.
5. **Try it.** `npx flowbound run <id> --try 10` runs the first 10 rows that have no result yet, under the
   person's permissions (`npx flowbound permissions`). In auto it runs inside the caps; in ask it waits for their
   yes first (see "Money" below). It prints how many rows filled each field, what the 10 cost and the estimate for
   all rows. Tell the person those numbers and give them the workflow's page, so they know what runs:
   http://localhost:4111/workflows?workflow=<id>. The estimate counts every row in the list, so it errs high.
6. **Run the rest:** `npx flowbound run <id>`. A budget the person said ("don't spend more than $5") goes in as
   `--max-usd 5`. Add `--wait` to wait for the end, or look with `npx flowbound runs <number>`.
7. **Hand over.** Return the results table from `execute`, for example `return await flowbound.table({ name: "results", limit: 5 })`. Call `show` with the suggested arguments if the person wants the view. Each field says where it came from, how old it is and what it
   cost. The web page can download it, and `npx flowbound export <results table> --csv` writes it to your folder.

## Jobs that run by themselves

"Run this every Monday" or "do this for each new lead that comes in" is one line in `schedules: [...]` in
`flowbound.config.ts`: `schedule({ id, workflow, every })` or `hook({ id, workflow })`. A run it starts is under the
same permissions as any run; while a yes waits for that workflow, its schedule skips. `npx flowbound schedules` shows
each line and what it last did; `npx flowbound schedule-run <name>` runs one now. The whole recipe, the webhook's
signature and what works in which home: `npx flowbound docs schedules` (once a line is in the config).

## Money: the rules

The person's permissions are in `flowbound.config.ts` (`npx flowbound permissions` shows them and this month's use),
like their agent app's own permission modes:

- **ask every time**: every paid run waits for their yes first, even a 10-row try.
- **auto inside caps** (a new install: $5 a run, $100 a month): runs spend freely up to the caps.
- **skip asking**: no asking, no caps.
- A workflow or provider can have its own mode or caps; the strictest wins. Writes to other tools (a CRM, a
  sequencer) count by number against the write caps.
- A budget the person says in chat is that run's cap in every mode: `--max-usd`. A provider with no price on its card
  is capped by calls: `--max-calls`.
- When a run waits for a yes (ask mode, or it reached a cap and paused), it shows on Home and in `doctor`
  with its question. Show the person the question word for word and pass on **their** answer: `npx flowbound yes
  <run>` (`--max-usd <n>` when they name a new cap), or `npx flowbound no <run>`. A yes is never a button on the
  page: it always comes through you. Never say yes for them, never invent a cap, and never widen the permissions in
  the config unless they ask you to.
- A full run needs a finished try-out of the workflow file as it is now. If you change the file, try it again.
- Nothing is paid twice while it is fresh: a call with the same cleaned inputs is answered from memory (for 30 days
  unless `facts: { freshDays }` says otherwise), and "not found" is remembered too. A write is never answered from
  memory: it is done each time.

## When a run does not go to plan

`npx flowbound runs <number>` says what happened and what to do. What to tell the person:

| What it says | What happened | What you do |
| --- | --- | --- |
| stopped: "has no key yet" or "refused the key" | A provider has no working key. Nothing more was spent. | Ask the person to add the key on the Connections page, then `npx flowbound resume <number>`. |
| waits for a yes: "Reached the $X cap ... so it paused" | A cap held: the run's own, this month's, a provider's or the writes. | Show the person the question; pass on their answer: `npx flowbound yes <number> [--max-usd <n>]` or `no <number>`. |
| waits for a yes: "Run ... on N rows?" | The mode is ask every time. | The same: the question word for word, then their answer. |
| paused: "N of the last 20 rows failed" (the file's `pauseAfter`) | A provider is refusing calls (often its speed limit). | Fix the cause (for a speed limit, set `rate` on the card: Flowbound then spaces the calls), then `npx flowbound resume <number>`. |
| try-out: "filled no field" | The providers answered, but with nothing useful. The full run is blocked. | Try another provider or call. Only if the person says "run anyway": `--anyway`. |
| stopped: the workflow file changed | The file was edited during the run. | Try it again, then run the rest. |
| "Run N of ... is going now" | One run of a workflow at a time, and one is going. | Wait for it (`npx flowbound runs <N>`), or stop it if nobody wants it. If it has not moved for long, `npx flowbound doctor` says so. |
| failed rows | Those rows failed their tries (3 unless the file's `retries` says); the run carried on. | `npx flowbound runs <number>` lists each row and why. A later run tries them again. |
| a schedule: "waits for a yes on Home, so this time was skipped" | A run of that workflow waits for the person. | Ask them; once answered, the schedule runs again. |
| a webhook answers 401 | The delivery's signature is missing or wrong, or no signing secret is saved. Nothing was taken in. | `npx flowbound schedules <name>` says which. The secret is typed on the Connections page. |
| `spend` shows "Price check" | A provider reported a higher price than its card says. That price is set aside from now on. | Tell the person; fix `price` on the card or the call. |

A run that was going when the computer slept or Flowbound stopped carries on by itself when Flowbound is back.

## Your project, and plugins of your own

`flowbound.config.ts` is the whole installation: what you add (providers, and pages of your own) and the person's
permissions. Change it and Flowbound restarts by itself.

```ts
import { blitzapi, firecrawl } from "flowbound"
import type { Config } from "flowbound"
export default {
  providers: [firecrawl(), blitzapi()],
  permissions: { mode: "auto", caps: { perRun: 5, perMonth: 100 } },
  // schedules: [...], facts: { freshDays: 30 }, plugins: [...], door: { ... }, parts: { store: ... }
} satisfies Config
```

The five parts inside (store, runner, keys, permissions, the page) are plugins too, each swappable in one line with
`parts`; `npx flowbound plugins` prints the list and checks it. A plugin of your own is one file in `plugins/` that
exports a function, plus its line in `plugins` (or `providers`, for a card):

```ts
// plugins/my-scoring.ts
import { plugin, use } from "flowbound"

export const myScoring = () =>
  plugin({
    name: "my-scoring",
    needs: ["records"], //                    parts it cannot work without
    migrations: ["create table fb_my_scoring.scores (company text primary key, score int)"], // its own tables, in its own schema fb_<name>
    tools: {
      score: {
        about: "Score one company from 0 to 100.",
        input: { company: { about: "the company's name", required: true } },
        run: async ({ company }) => {
          const { rows } = await use("records").query("select score from fb_my_scoring.scores where company = $1", [company])
          return rows[0] ?? { score: null }
        },
      },
    },
  })
```

```ts
// flowbound.config.ts
import { myScoring } from "./plugins/my-scoring.ts"
export default { providers: [/* ... */], plugins: [myScoring()] }
```

A plugin is one object: `name`, `needs`, `provides`, and any of `tools` (what agents can call: each becomes a
command and is reachable over MCP), `pages`, `routes`, `migrations`, `commands`, `docs`, `start`, `attention`
(what needs a person: it shows in the check-up and on Home). A later plugin
with the same `provides` replaces an earlier one. No plugin imports another plugin's code: reach a provider, the
records or any other part with `use("<name>")`, in a tool, a step or a plugin's `start`.
