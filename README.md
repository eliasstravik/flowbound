# Flowbound

**Flowbound is an open-source agent plugin for GTM workflows.**

The job you hire it for:

> "Here are 200 companies. **Find the head of sales at each and a work email.** Don't spend more than $5."

## The first five minutes

**Run Flowbound on your computer.** Use Node.js 22.18 or newer. The sample workflow runs without an account or provider key.

```
npm ci
npm run build
npm pack
```

After installing the plugin, open a project folder and ask your agent to use Flowbound. Its first tool call sets up the folder and starts the database, runner and pages. The runner stops after the last agent session closes. Add provider keys on Flowbound’s Keys page.

## Works with your agent

**Every agent app that can take it,** through the open standards first: the cross-app plugin standard and the skills
standard (also listed on skills.sh). Where a big player needs its own kind of plugin (Claude, Google's Gemini), that
kind is added too. Plus tools (MCP) and a command line for anything else. Init sets up the apps it finds on your
computer. Live, Claude and ChatGPT connect by signing in.

```
/plugin install flowbound@flowbound        # Claude Code
codex plugin add flowbound@flowbound       # Codex
npx skills add eliasstravik/flowbound      # skills.sh
npx flowbound init                         # anything else
```

The npm release is pending. Install from a tarball of this repo
(`npm run build && npm pack`, then `npx -y --package=/absolute/path/to/flowbound-0.1.0.tgz flowbound init --example` in your project folder).
Claude Code and Codex first need the marketplace: `/plugin marketplace add eliasstravik/flowbound`,
`codex plugin marketplace add eliasstravik/flowbound`.

The plugin starts in **Run here**. To use a company installation, run `npx flowbound connect https://your-company.example` once and restart the agent app. Flowbound opens your browser for work sign-in on the first tool call. Switch back with `npx flowbound connect --local` and restart the app. Cloud chat apps connect directly to the company’s `/mcp` address.

Agents do the work through two MCP tools: `search` finds a tool and its inputs,
`execute` runs a few lines of JavaScript that call tools (`await flowbound.runs({})`), several at once, keeping only
what is needed. `show` opens Flowbound inside chat. You can see run progress, spending questions, result tables
and workflow diagrams right there, and expand to the app when your chat supports it. Text-only apps still get a
web link. Embedded views reuse the connector's sign-in.

## Try the demo

Add `https://flowbound-demo.vercel.app/mcp` as a custom connector in Claude. Choose **No sign in**, turn it on
in a chat and ask “Run the free sample-contacts workflow and show me the results in Flowbound.” The demo uses
four fictional companies and costs $0. [Open the demo website](https://flowbound-demo.vercel.app/)

## Use Flowbound from a phone

[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Feliasstravik%2Fflowbound&project-name=flowbound&repository-name=flowbound&env=FLOWBOUND_SECRET%2CFLOWBOUND_PASSWORD&envDescription=Create+two+separate+values+in+your+password+manager.+Keep+the+team+password+to+sign+in.&envLink=https%3A%2F%2Fgithub.com%2Feliasstravik%2Fflowbound%2Fblob%2Fmain%2Fdocs%2Fhomes.md%23start-from-the-deploy-button&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

Deploy your own Flowbound with Neon, then add its `/mcp` address to your chat app. See the [phone setup](docs/homes.md#start-from-the-deploy-button).

## Made first for

**GTM engineers** at agencies or inside companies can build workflows with an agent and share them with their team.

| | |
| --- | --- |
| First | GTM engineers, in-house or at agencies |
| Then | Agencies and company teams: RevOps, sales and marketing ops |
| Later | Individual sellers and marketers |

## Where it's going

**GTM workflows from your agent.** Build company lists, research contacts, and enrich your data with your own
provider accounts. Flowbound keeps each result with its source, date, and cost.

## Your data

**Your own tables, any shape, and every paid fact kept.** The agent makes whatever tables a job needs. Each enriched
cell knows where it came from and how old it is. Before buying, a job checks what's already known; anything older
than its freshness window (30 days unless you say otherwise) is looked up again, because people change jobs.

| company | head of sales | email |
| --- | --- | --- |
| acme.com | Maya Lind<br><sub>BlitzAPI · bought 12 days ago for $0.004 · free now</sub> | maya@acme.com<br><sub>already known · free</sub> |
| globex.example | Sam Berg<br><sub>BlitzAPI · bought again today for $0.004 · the last answer was 140 days old</sub> | sam@globex.example<br><sub>BlitzAPI · today · $0.004</sub> |

Each paid answer is filed under its provider and the exact question, cleaned up first (email in lower case, tidy web
address), with its age. The same question finds answers from any provider: `npx flowbound lookup acme.com`. No
guessing who is who: matching "Acme Inc" to acme.com is your agent's job.

## Permissions

**Like your agent's own permission modes.** You pick how much the agent may do without asking, and change it any time.

| Mode | |
| --- | --- |
| Ask every time | Every paid run asks first, even a 10-row try. |
| Auto inside caps | Spends freely up to your caps. A new install starts here: $5 a run, $100 a month. |
| Skip asking (dangerous) | No asking, no caps. |

```ts
permissions: {
  mode: "auto",
  caps: { perRun: 5, perMonth: 100, writesPerMonth: 500 },
  workflows: { "big-enrich": { mode: "ask" } },
  providers: { hubspot: { writesPerRun: 200 } },
}
```

The modes are three presets over caps. A workflow or provider can have its own mode or caps; the strictest one wins.
Writes to other tools count by number, not dollars. When a cap is hit, the run pauses and a yes appears under Needs
you; it waits there until answered, and a schedule skips its next run meanwhile. A budget said in chat ("don't spend
more than $5") is that run's cap, in every mode.

A yes is never a button. You tell your agent, and it passes your answer on: `npx flowbound yes <run>` (with
`--max-usd` for a new cap), or `npx flowbound no <run>`. Not now is also on the page: stopping is always allowed.

## What Flowbound is made of

**Only what an agent can't be, however smart.** It can't stay up for days, keep a database, hold a key you don't want
in its chat, or be on your phone when it isn't running. People still need to read, find their way and understand.

| Part | |
| --- | --- |
| Store | Your tables and the kept facts |
| Runner | Stays up; schedules, webhooks, restarts |
| Keys | Used, never shown |
| Permissions | Your mode and caps, enforced |
| A page | To read, find your way, understand, and see what needs you from a phone |

Left to the agent: how workflows are written, retries, which provider first, scoring, fixing what broke.

## The page, on your phone

Six tabs: **Needs you** · Runs · Tables · Workflows · Keys · Permissions.

- Needs you: each yes that waits ("Run Find sales heads on 200 rows, stop at $1.60?"), and a key that is missing
  ("Firecrawl needs a key · type it on the Keys page, never in a chat").
- Tables: your results, each cell with its source, age and cost; upload a list as CSV; download as CSV.
- Workflows: your agent's summary and diagram; with none yet, "No summary yet: ask your agent to write one", then
  the code.
- Runs: what ran, what failed and why.
- Keys: keys are typed only here.
- Permissions: the mode, the caps and what this month has used.

## A workflow, on the page

**Save and publish from chat.** Members can save workflow edits on a Git branch, try the preview, and
publish after its checks pass. Undo saves a revert. GitHub pull requests keep the diff and any required
company review. On a laptop, it works with local Git. See the Changes page or run `npx flowbound docs changes`.

The agent writes a summary and draws a diagram for people, in the workflow file beside the code. Flowbound only shows
them; it never draws them from the code.

```ts
// workflows/find-sales-heads.ts
export const summary = "For each company: find its head of sales, then a work email. If the first provider finds nobody, try a second."
export const diagram = `<svg viewBox="0 0 320 250">...</svg>`
```

The diagram is cleaned before it is shown, so it can only draw (no scripts, no links), and it is drawn in the page's
own text colour, light or dark. Last run: 200 rows · 175 found · $0.29.

## On your own computer

**The same workflow engine as live, running on your computer** (Vercel's Workflow SDK, nothing to sign up for). Close
the lid and runs pause; open it and they carry on where they stopped. Schedules run while it's on. Saying yes from your
phone and receiving webhooks need it live, or the page shared privately (for example on your own Tailscale).

```
$ npx flowbound dev
runs and schedules on while this computer is on
yes from your phone: npx flowbound deploy
```

## Running without you

**One command puts the same project live,** on Vercel or any server, with your own database (a small one in the
project folder on your computer; Postgres, such as Neon, live). Teammates sign in with the work account they already
have (Google, Microsoft, or any OpenID login); Claude and ChatGPT connect by signing in.

```
$ npx flowbound deploy
live at https://gtm.acme.com · sign in with Google (acme.com)
```

A workflow can run by itself, one line each, under the same permissions:

```ts
schedules: [
  schedule({ id: "weekly-heads", workflow: "find-sales-heads", every: "monday 08:00", timezone: "Europe/Stockholm" }),
  hook({ id: "new-leads", workflow: "enrich-lead", key: "email" }),   // signed rows in at /hooks/new-leads
],
```

## Your project

**Few parts, each swappable in one line.** What you add or remove yourself: providers, workflows and pages. The five
parts inside are built as plugins too, so each can be swapped for another (a different database, runner, key store or
work login), but nobody needs to know.

```
flowbound.config.ts
  providers: [blitzapi(), firecrawl(), myCrm()]
  permissions: { mode: "auto", caps: { perMonth: 100 } }
workflows/find-sales-heads.ts
```

`flowbound.config.ts` is `export default { providers, permissions }`, and optionally `schedules`, `facts:
{ freshDays }`, `plugins` (pages of your own), `door` (the work login) and `parts` (swap a part inside).

## Getting data to your other tools

**Writing out is a provider call, under the same permissions.** A HubSpot or sequencer card can write as well as read
(`hubspot()` ships as the example). A write counts like a spend: ask, auto inside limits, or skip, as you set. A write
is never answered from memory.

## What it costs

**Free and open source, all of it.** You pay your data providers and your own hosting, nothing else. It earns by
bringing GTM consulting and agency work to its makers.

| | |
| --- | --- |
| Flowbound | $0 · MIT · every feature |
| Help | "Want us to set it up for you?" → consulting |

## Principles

1. **Only what an agent can't be.** Stay up, store, hold keys, enforce your permissions, show people. Everything else
   is the agent's; as agents improve, delete more.
2. **Your permissions, your way.** Ask, auto inside caps, or skip, for spending and for writing outside. Try 10 rows
   first, then the rest.
3. **Every paid fact is kept,** with source, date and cost, and never bought twice while it's fresh.
4. **Yours.** Your keys, database and repo. Free and open; nothing hosted, no credits, no sign-up to start.
5. **Made for people to read.** The agent explains each workflow in words and a diagram; one page to look and see
   what needs you.
6. **Everything is a plugin,** built the way DeepSeek's harness and OpenCode v2 are: few parts, each swappable in one
   line; providers, workflows and pages also removable.
7. **A stranger's agent gets it right first try,** from the docs alone.

## More

The agent's instructions ship with the installed version: `npx flowbound docs`. Whole workflow files for shapes that
come up again and again: `npx flowbound docs recipes`. `npx flowbound init --example` adds eight made-up companies and
a workflow of plain code, tried once for $0.00. What changed in each version: [CHANGELOG.md](CHANGELOG.md).
[Company setup](docs/company.md). Signing in when live: [docs/sign-in.md](docs/sign-in.md). Other homes than Vercel: [docs/homes.md](docs/homes.md).
Where your data lives, and how to back it up: [docs/if-it-breaks.md](docs/if-it-breaks.md). Found a security problem?
Tell us privately: [SECURITY.md](SECURITY.md). Why things are the way they are: [docs/decisions.md](docs/decisions.md).
To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md).

## Working on Flowbound itself

```
npm install
npm run check        # lint, types, build, tests
npm run test:scale   # a list of 10,000 rows, killed and restarted on the way; many minutes, so not part of check
```

Tests run the real command line against an honest fake provider and a fake model (`test/`), and the live door
against a stand-in for a company's login (`test/stand-in-idp.ts`: Google with a company, Microsoft with a directory,
Okta with groups); `test/live/` walks through the live door against a real Postgres. How the pages look and the parts
a page is made of: [docs/design.md](docs/design.md). How big a list it holds, measured:
[docs/scale.md](docs/scale.md). MIT licence.
