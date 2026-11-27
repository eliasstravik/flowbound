# Decisions the builder made

Newest first. The reshape (26 Nov 2026) rebuilt Flowbound to the vision frozen in the "Flowbound vision from scratch"
consultation; where an older section below says something else, the reshape wins and the older text is marked
"Replaced by the reshape". Each was decided by its two tests: everything is a plug-in, and only build what an agent
cannot be or do itself. One line each.

## Workflows are ordinary software, with Save and Publish (27 Nov 2026)

A workflow stays a TypeScript file in the project's Git repo. The chat writes it. Save commits the change on
a branch using a repo-scoped GitHub App, with the requesting person's name in the commit. A GitHub pull request
holds the normal diff, checks and optional company review. Vercel previews the branch, with an isolated Neon
branch for projects using Neon. Publish merges after the types, workflow and test checks pass and GitHub allows
the merge. Undo saves a revert that goes through the same checks. Local projects use the same steps with local Git.

The connector’s change tools work only with workflow files in the configured repo.
Engineers can use Git and GitHub directly and their workflow pull requests show in Changes. Viewers can look.
Members can make, change, run and publish workflows. Admins also manage people, keys and settings. Owners can
also remove the project. The Changes guide records the old-role mapping and setup.

## Flowbound opens in the chat (27 Nov 2026)

The [MCP Apps specification, 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
links a view to a tool at discovery. Flowbound offers three MCP tools, `search`, `execute` and `show`. Only
`show` declares a `ui://` resource. A separate view tool keeps search, execution and background reads clean in hosts
that draw a frame for every call of a tool with a view. When a person asks for no app, the agent skips `show`.

`execute` returns the arguments for opening a displayable result. The agent uses `show` once per run when a view
helps the person. The run view updates live and has **Open web page**. Text-only clients get a web link from
`show` or a displayable `execute` result. If the app starts and the page fails to draw, **Open web page** stays
available. The demo logs declared support at connection time and the app's load or error report when it can
reach the server.

The embedded view uses the same Basecoat pages and components as the website. The host bridge uses the existing
connection for `execute`, so Flowbound checks the same role and caps on every call. People answer spending requests
through the agent. Key values and people-only changes stay on Flowbound's signed-in website.

Host support checked on 27 Nov 2026:

- Claude renders inline views on web, desktop and mobile. The side panel, embedded sites and navigation entry
  points are rolling out on web and desktop, with account and connector eligibility. [Claude support](https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude) · [Developer requirements](https://claude.com/docs/connectors/building/mcp-apps/getting-started)
- ChatGPT uses the same resource and bridge standard. Custom MCP connections are available on the web on eligible
  plans. [UI documentation](https://developers.openai.com/plugins/build/chatgpt-ui) · [Custom connection access](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- Other MCP Apps hosts can use the same resource. In the terminal, use the plain tool results and links.
  [MCP client support matrix](https://modelcontextprotocol.io/extensions/client-matrix)

## The reshape to the vision (26 Nov 2026)

### The person's three answers
- A new install starts in **auto inside caps**: $5 a run and $100 a month (`DEFAULT_PERMISSIONS`). The person chose it over ask every time.
- A kept fact is **fresh for 30 days**, as before. One setting, `facts: { freshDays }`.
- A yes is given **only through the agent, everywhere**. There is no Yes button on the page. The frozen prototype showed one; the person's later words, "Probably not yes via pages at all, just agent", overrode it (with "assuming bitter lesson with virtually perfect future agents"). The page shows the question under Needs you, says "Tell your agent yes", and keeps Not now: stopping is always allowed. On your own computer the agent passes the answer on (`npx flowbound yes <run>`); live, an agent acting for a signed-in person who may approve passes theirs on, saved with the agent's and the person's name. An agent still never manages (keys, people, rights).

### The "your call" items
- **The diagram's format:** SVG text in the workflow file, `export const diagram = \`<svg ...>\``, beside `export const summary`. Every agent draws SVG well, it needs no library on the page, and it can be cleaned: everything that is not drawing (scripts, event handlers, links, outside addresses, foreign content) is taken out before it is shown, and `currentColor` draws it in the page's own text colour, light or dark.
- **Names of the settings:** `permissions: { mode, caps: { perRun, perMonth, callsPerRun, callsPerMonth, writesPerRun, writesPerMonth }, workflows: { <id>: rule }, providers: { <name>: rule } }`. A rule is a mode and/or caps, written inside `caps` or beside `mode` (the prototype shows both forms). Dollars, calls (for a card with no price) and writes are the three things a cap can count.
- **Which carry-overs to cut first:** all of plan.md's list at once (the Data page, Drizzle Studio and its database socket, Open in Neon, Open in editor, the workflow UI routing, the diagram drawn from code, three model routes), and the in-chat pages with them. Half a cut leaves two ways of doing one thing.
- **One mode for 0.1, or rules per workflow and provider:** rules now. The prototype shows them, they are a few lines in the ledger, and the strictest wins, so a rule can only ever tighten.
- **One freshness window, or per provider:** one global window that a call may override (`fetch(path, { freshDays })`). The card's own `freshDays` is gone: one number a person can find beats one per card.
- **Work sign-in beyond Google:** Microsoft and any OpenID login stay, as today. They were built, tested against stand-ins, and cost nothing to keep.
- **"Want us to set it up for you?":** only in the README. The product stays free of selling.
- **Docs a stranger's agent can follow first try:** checked with a fresh agent that has only the installed package, as a step before publishing, not in every test run, because it spends on a real model.
- **A budget said in chat** ("don't spend more than $5", `--max-usd`) is that run's cap in every mode, skip included. The strictest wins.

### How it was built
- **Agents do the work through `search` and `execute`**. `execute` runs a few lines of JavaScript with every tool as `flowbound.<name>(input)`, in QuickJS inside WebAssembly: no files, no network, no keys, only the tools, called as the caller with their rights; 64 MB and 10 minutes at most. It is also a command (`npx flowbound execute "<code>"`). Not Node's `vm`: that is no wall, and live the caller is somebody else's agent.
- The in-chat pages were removed in the reshape. The 27 Nov decision above restores them through the shared page renderer.
- **Permission modes are presets over caps.** Ask: a run that calls a paid provider waits (state `waiting`) with its question under Needs you. Auto: it runs inside the caps. Skip: no caps, only a budget said in chat. The mode of a run is worked out when it begins: the strictest of the project's, its workflow's and every provider it uses.
- Caps are budgets in the ledger, held by one atomic UPDATE each as before: the run's own (`run:<id>`), this month's (`month:<YYYY-MM>`), a workflow's or a provider's month, a provider's per run, and the write caps. A month's budget follows the rules as written now.
- **A hit cap pauses the run** (state `paused`, code `cap`, the cap's id kept) and puts a yes under Needs you, where it waits. A yes on the run's own cap sets a new one (twice the old unless the person said a number); a yes on another cap (the month's, a provider's, the writes) lifts that cap for that run only, and the run's own still holds. Not now stops it.
- **A schedule skips while a yes waits** for its workflow (asked first, or paused at a cap): one question at a time.
- **Schedules and webhooks run under the same permissions** as any run. The standing yes, its page, `standing-ask`/`yes`/`no`/`pause`/`resume`/`stop`/`run` and the leaver pause are gone; `schedule-run <name>` runs one now. Lines go in `schedules: [...]`. Old databases keep their `fb_standing` tables, unused.
- **Writes** to another tool are marked by the card (`writes: true`, or a function of method and path) or the call (`write: true`). Each is counted against the write caps, is never answered from memory, and is not in `lookup`: a write is an act, not a fact.
- **Kept facts, by exact inputs:** a fact is filed under provider, method and path, and its inputs cleaned (emails in lower case, web addresses without scheme, `www.` or trailing slash, LinkedIn paths in lower case, spaces trimmed). Its cleaned input values are kept too, so `lookup <value>` finds answers from every provider. No fuzzy matching: "Acme Inc" and acme.com stay two questions. Facts kept before the reshape were filed under the old key and are not found again by the new one (nobody outside used it yet).
- **The age on every cell:** "BlitzAPI · today · $0.004", "BlitzAPI · bought 12 days ago for $0.004 · free now", "BlitzAPI · bought again today for $0.004 · the last answer was 140 days old", "already known · free" (with "· N days old" when not today: the plan says every cell shows its age), and past the window "older than 30 days: bought again next time". Whether a row got it from memory is read from the newest call for that row and fact.
- **Run habits are defaults the workflow file may change:** `concurrency` (5), `retries` (2 more tries for a busy or unreachable provider), `pauseAfter` (`{ failed: 11, of: 20 }`, the old "more than 10 of the last 20"; `false` never pauses).
- **The model card is one way only:** a key typed on the Keys page (or a host that adds it). The signed-in Claude Code or Codex route, the AI Gateway route and `ai-way` are gone: a model is a provider.
- `hubspot()` ships as the card that writes, as the example of getting data out.
- One-off calls an agent makes to look at a provider keep their own $1 a day (and 100 unpriced calls), plus the month's caps unless skip.
- The Workflow SDK's `experimental_rateLimit()` is not used yet (plan item 8): it is experimental. Flowbound's own per-provider speed limit, kept in the database, stays until it is not.
- **The config is a plain object:** `export default { providers, permissions, schedules, facts, plugins, door, on, parts }`, made into the list of parts by `flowbound()`. A plain list of plugins still loads. `parts` swaps a part inside (`{ store: postgres({ url }) }`).
- **The page has six tabs:** Needs you (`/needs`, where `/` lands; it was the Overview), Runs, Tables (with CSV upload; the Lists page is gone), Workflows (the agent's summary and diagram, then the code), Keys, Permissions. People and agents' tokens are live-only pages linked from Permissions and Keys, not tabs.
- The look stays Flowbound's own design system (docs/design.md), not the prototype's: the prototype is a picture of the vision, and the plan says what it does not name stays as it works.
- `flowbound init` ends with `ready · no account needed · pages at localhost:4111`, `flowbound dev` says runs and schedules go on while the computer is on, and `deploy` says `live at <address> · sign in with <login>`, as the prototype shows.

## The open list's "your call" items (24 Nov 2026)
- `plugin()` fields: `name`, `needs`, `provides`, `start`, `stop`, `tools`, `pages`, `routes`, `migrations`, `commands`, `docs`, `guard`, `card`. `routes` (addresses that are not pages) and `guard` (who may pass) are the two the plan did not name; the runner's address, `/mcp`, `/hooks` and the door need them.
- `provider()` fields: `name`, `label`, `host`, `key`, `docs`, `price: { perCall, reported }`, `rate: { perSecond, perMinute }`, `writes`, `about`. A call may pass its own `price` when the manual prices endpoints differently. (`freshDays` left the card in the reshape.)
- A paid fact stays fresh for 30 days unless `facts: { freshDays }` or the call says otherwise.
- Keys on your own computer: `~/.flowbound/<folder name>-<hash of its path>/keys.json`, readable by you only (0600). `FLOWBOUND_HOME` moves it.
- Pages: plain HTML with Flowbound's own look and one small shared script.
- Install commands per agent app: see README; each was checked against the app's own manual on 24 Nov 2026, and Claude Code's and Codex's were run.
- The local port: 4111, then the next free one. The address in use is in `.flowbound/server.json`.

## Core
- The core is `src/core`: the list, needs and provides, starting in order, the HTTP API over every tool, and the `flowbound` command with `dev`, `plugins`, `docs`. It is about 580 lines, not the 300 the plan aimed for: the HTTP listener, the restart-on-change watcher and plain error messages took the rest. It names no plugin.
- `use("<name>")` reaches a part through one shared registry, so it works the same from a plugin, a tool and a step, however the step was bundled.
- A tool marked `by: "people"` (save a key, make a token, give rights) is refused to tokens and the command line. On your own computer that is a courtesy, not a wall, and the keys page says so.
- `flowbound plugins` prints one line per plugin (the prototype drew `mcp, cli` on one line).
- The watcher looks at the files itself twice a second instead of trusting the system's change notices, which miss saves that replace a file; and a run is refused when the workflow file on disk differs from the one loaded. Found on the real acceptance run, where an agent's edits were missed.
- `flowbound dev` is one watcher per project that owns one server: a change to the list, a plugin or a workflow restarts the server; a killed server is started again; a second watcher is refused, so two processes never open the local database.

## Records
- Flowbound's own tables live in one Postgres schema per plugin, `fb_<plugin>`; the agent's tables are in `public`.
- A list table has an `id` and text columns. A results table has the list row's `id`, a `jsonb` column per returned field and `<field>__fact` beside it; "nothing found" is stored empty so filled fields can be counted.
- `flowbound import` refuses to overwrite a list: `--add` adds rows, `--as` names a new one.
- Table changes are applied under a database lock, because several copies of a live Flowbound can start at once.

## Runs
- Flowbound has no run engine of its own. A run is a Workflow SDK workflow (the "driver", written beside the user's files on every start) that takes rows a batch at a time and starts one child workflow per batch; the child calls the user's function for each of its rows, one after the other, and saves each answer. After 100 batches the driver carries on in a fresh run of itself so its history stays small. Why batches, and why 25 rows: "Size" below.
- A run that reaches a cap pauses and waits for a yes, which carries the same run on (the reshape). `resume` is only for a pause after failures and a missing key.
- A row the cap or a missing key stopped is not a failed row: it stays not done.
- Rows already in the air when a run stops are allowed to finish.
- `export const concurrency = n` is the line that changes "5 rows at a time"; `retries` and `pauseAfter` change the other two habits (the reshape).
- A run does not end while a row is waiting for it: before it ends it looks once more, and it only ends if no row was handed to it meanwhile (one conditional UPDATE).
- A file change during a run stops the run ("a changed file needs a new try-out").

## Size (26 Nov 2026)
Decided by running a list of 10,000 rows, and what it showed: docs/scale.md has the numbers and how to run it again.
- Rows go in batches of 25, never one workflow run per row. Measured on 1,000 rows with a fast fake provider: batches of 1, 5, 25 and 40 rows did 11, 28, 33 and 32 rows a second and held 3.3, 3.0, 1.6 and 1.3 GB. So 25: nearly all of the speed, a history of about 380 events for one batch (the Workflow SDK replays slower past 2,000 and stops a run at 25,000), and a batch that breaks takes at most 25 rows with it.
- `concurrency` is still rows at a time: that many lanes, each on one row of its batch.
- A run remembers how far down the list it has taken rows, so taking the next batch costs the same at row 10 and at row 1,000,000. Before, each claim looked through every row the run had already taken.
- Taking a batch is safe to repeat. The driver names each claim, and a claim asked again under the same name (Flowbound was killed after the rows were taken and before the runner had written that down) gives the same rows back. Before, those rows stayed taken with nobody doing them.
- A row that failed in an earlier run and fails again does not count towards the pause. Found by the big run: a new run starts with the rows that failed before, and paused on them every time.
- The server's own memory has a ceiling of 768 MB (`FLOWBOUND_HEAP_MB`). Node tidies up late on a machine with room to spare, and a 10,000-row run held 3.5 GB; with the ceiling and the batches it held 1.2 GB and ran faster.
- The table tool answers at most 500 rows at a time, and an agent that asks for the export of a big table gets where the file is to be had, not the text: a chat is no place for 10,000 rows. People's "Download CSV" is unchanged.
- Results stay one `jsonb` column per field for now: they sort as they are, and compare with `(score)::numeric > 70` or `title #>> '{}' = 'VP Sales'`; the `sql` tool says so when a comparison fails. Columns with a type of their own need a design for tables that exist already and for a field that changes type, so that is a task of its own.

## Schedules and webhook rows
A run started by a schedule or webhook uses the same permissions as a manual run.
- A schedule and a webhook are lines in `schedules: [...]`, `schedule({ id, workflow, every, timezone })` and `hook({ id, workflow, key, signature, row })`. Caps never go in a workflow file: `every`, `on` and a monthly cap there are refused, with the line to write instead.
- A row with no run is kept, not refused: a row in a list costs nothing. The same row is taken in once (by the `key` column, or the whole row), and kept facts make a lead seen before free even as a new row. A row that arrives while its run is going is handed to that run.
- One run at a time for a workflow that runs by itself, kept by a unique index, so two copies of a live Flowbound cannot both start one.
- A webhook's sender signs the exact body with HMAC-SHA256; the signature is checked before anything is parsed, in constant time. The secret is typed by a person on the keys page and never leaves the keys plugin, which only hands out the MAC of some bytes. The address takes no token: the signature is its door.
- The clock. On your own computer and on a server of your own it is still a Workflow SDK workflow that sleeps until the next time. On Vercel it is Vercel's own schedules, one per line, calling `/clock` with `CRON_SECRET`: Vercel's docs (read 26 Nov 2026) say Schedules replace Cron Jobs, and that a new run for each time is the normal way because a run that sleeps and wakes forever stays on the deployment that started it. So after a deploy the newest code is what a schedule runs. A path target is not retried by Vercel; a tick starts each due time at most once, so a duplicate is harmless and a missed one is one missed time.
- `every` forms: `"monday 08:00"`, `"day 08:00"`, `"weekday 08:00"`, `"hour"`, `"2 hours"`, `"15 minutes"`. Day forms are the wall clock of the line's `timezone` (the machine's own without one, UTC live). A time more than an hour late is skipped.
- Failed rows are tried again by each scheduled run: a failed call costs nothing, and a provider that was down last Monday may be up this one.

## Ledger
- Reserving against a cap is one atomic UPDATE on the cap's row, so 5 rows at a time cannot overshoot it. A hold left by a crash is cleared after 15 minutes (at once on your own computer at start).
- A cap does not stop a run while money is only set aside for calls still in the air: the call waits for them (up to a minute) and stops the run only if it still does not fit. A model call is held at its worst case, many times its real cost, so without this the second row of a small run would stop it.
- The price check: the highest price a provider itself reported for an endpoint is kept, held for every later call to it, and shown in `spend` when it beats what the card or the call said. Before, a card with only a reported price held $0, and rows side by side could pass a cap.
- A card's speed limit is kept in the ledger, in the database, where the money is already held: each call takes the next free moment by the database's clock. Before, it was a timer inside one process, so a live Flowbound with several copies did not hold it.
- An answer counts as a fact when the provider answered: any 2xx, and 404 ("not found"). 401/403/402 stop the run (the key or the account); 429 and 5xx are tried 3 times; other 4xx fail the row and cost nothing.
- One-off calls an agent makes share $1 a day; for cards with no price, 100 calls a day. A try-out is a run like any other since the reshape, under the permissions.
- Calls in the air at the instant of a hard kill may be made again when the run is picked up (at most one per row in flight). Everything that was recorded is never paid twice.

## Keys and providers
- Each provider card is also a tool with its name (`flowbound blitzapi /v2/...`), so an agent can make one real call and see the answer before writing a workflow. It counts against the day's allowance for one-off calls.
- The key header cannot be redirected: the address is always the card's host, redirects are not followed.
- A key is checked when it is typed, on cards that name a free `check` path: a key the provider refuses is not saved. Firecrawl, BlitzAPI and the model card have one.
- The `ai` card: the default model is the cheap current one, `claude-haiku-5-5` (it was `claude-opus-5-5`; a model step runs once per row, so the default should be the one that is safe at 10,000 rows); the worst case of a call (every byte of the prompt as a token, and all of `maxTokens`, now 4,000) is held against the cap first; the cost is the answer's own usage, with cache reads and writes and Haiku's higher prices over 100,000 tokens, priced by the model that answered; a gateway that reports the cost is believed; one step can name its model, `maxTokens`, `effort` and `system`; an answer cut off at `maxTokens` fails the row instead of saving half a sentence. Prices were read from the maker's price page on 26 Nov 2026. `ask` returns text as the prototype shows; `pick` is the same answer carrying its fact. (The reshape: one way only, a key. The signed-in `claude`/`codex` route and the gateway are gone; a model is a provider.)

## Agents
- MCP offers `search` to find tools, `execute` to do the work, and `show` to open a view.
- When an agent app starts `flowbound mcp` away from the project (Codex starts plugin servers in its plugin cache), the server asks the app for its open folders (MCP roots) and uses the one with a `flowbound.config.ts`.
- `npx flowbound init` writes the project MCP setting and the skill for every agent app found on the machine, and one line in `AGENTS.md`. Before the package is on npm it installs from a tarball of itself.
- `--live` goes through the local Flowbound, which holds the live token like any key: the agent never sees it. The live address is in `.flowbound/live.json`, or `door({ live: "https://..." })`.

## Live
- Not Vercel's Deployment Protection, and not "Sign in with Vercel" as the way in: a wall cannot tell the app who somebody is, and salespeople have no Vercel account. See "Sign-in" below.
- Claude and ChatGPT connect by signing in, not with a pasted token. It is part of the door plugin, by the two tests: it is who gets in, and an agent cannot be the thing that checks a person.
- The daily allowance for one-off calls is a ledger setting (`ledger({ oneOffUsdPerDay })`), so a shared Flowbound can set it lower than $1.
- A server of your own runs the same code with `FLOWBOUND_LIVE=1 npx flowbound dev`.

## Sign-in (26 Nov 2026)
Decided by the research in the vision folder (sign-in half): people sign in inside the app with the work account they already have. How to use it: docs/sign-in.md.
- The door has one setting, who vouches for people: nobody (your own computer), Google or Microsoft limited to a company or a short list of emails, or any OpenID Connect provider. One design covers five people and 2,000, because all three speak the same standard and a company that limits it to its own people already has single sign-on.
- Built on Better Auth, after the test the research asked for. It passed on: starting with no framework (a plain Request in, Response out); a Google-like login limited to a company, a Microsoft-like one limited to a directory and an Okta-like one with groups, all through its one generic provider; the sign-in chat apps use (the older way for an app to introduce itself was walked through; the newer one, its own address as its id, is switched on and offered but could not be tried without a public address); PGlite and Postgres; bundling for Vercel; and a connected chat app that still works and renews after upgrading the library from 1.7.28 to 1.8.0-beta.11. It did not do, by itself: asking the login again when a chat app renews (a person who left kept renewing), and PGlite needs a few lines of ours because the community adapter does not accept PGlite 0.6. Both are in the door.
- What the engine does not know is the door's own: who may come in, rights, tokens, history. Signing in gives nothing by itself; the door's list of people is the only thing that lets anybody in, on pages, the API and MCP alike. That one check is why an outsider who gets as far as a session at the engine still has nothing.
- The engine's own addresses are not open to the world: only the ones a chat app needs (authorize, token, register, the discovery documents). Its sign-in and its "change my name" are called by the door, never from outside, so nobody can rename themselves into a manager's name.
- The engine's tables are in the door's schema and are made by the door's own list of table changes (`door/engine-tables.ts`), not by the engine at start: a serverless start stays fast and several copies cannot race. A test says when an upgrade wants a new entry. It reaches the database through the records part, so there are no transactions in it: a pooled Postgres gives each statement its own connection.
- A person is their checked work email in the door's own list, not the id the login gives (ids differ per app and change with the provider). The engine links one or more logins to it.
- Rights are view, edit, approve, manage, for the workflow side. A tool says the least it needs (`role`), edit when it says nothing. SQL that changes things is manage, because SQL reaches everything, the list of people too.
- An agent acts for one named person, up to approve: "Claude, for Maya". It passes on its person's yes when they may approve (the reshape: a yes is given only through the agent), saved with both names in the same field the yes always had. It never manages, whoever its person is.
- Leaving: browser sessions last 12 hours and are not stretched. For agents the door asks the login again once an hour, with the renewal the login gave at sign-in (kept locked). That covers tokens made on the Connect page too, which the research's "check at each renewal" would not have. When the login could not be asked (it gave no renewal, or is down), the person's last own sign-in counts for a day. The engine does not say why a renewal failed, so the door asks the login for its public document: if that answers, the login said no.
- Google only gives a renewal when the person is asked each time, so Google shows its consent page at every sign-in (once a working day). The other choice was agents that stop every day.
- Tokens made on the Connect page stay for agents that cannot sign in. They do not run out by the clock: an unattended agent cannot renew. They belong to a person, are checked hourly with that person, and die with them.
- The team password stays for a first try-out, as the research says, also beside a login. The name is asked when entering, so a chat app connected under it has a name too.
- History is written by the plugin that makes the change, through `use("door").wrote(...)`, with before and after; a database trigger refuses changes and deletes. A manager with SQL could still drop that trigger: it keeps honest people honest and makes tampering a deliberate act, not more.
- "Off" refuses to start live, and on any address that is not this computer, a private network or a tailnet name. A tailnet name that is opened to the internet (Funnel) would pass: never do that with sign-in off.
- Where this differs from the research: the hourly check is at use, not only at renewal (stricter); automatic removal of leavers (SCIM), the older SSO format (SAML) and company-managed "auto-connect" are left out, as the research says, until a customer asks; the per-person reach dial (own, team, all) is the CRM's and not built here.
- Not checked with the real ones: Google, Microsoft, Okta, Claude and ChatGPT themselves. Everything was proven against a stand-in login and a chat app walked by hand (`test/door.test.ts`).

## Design (26 Nov 2026)
See docs/design.md for the page components and style tokens.
- One design system for every page: shadcn/ui's, as Basecoat (its look and parts as plain HTML and CSS, MIT, version 1.3) on Tailwind 4, with Geist and lucide icons. Flowbound's values on shadcn/ui's token names: black on white, hairlines, one blue for focus, four colours that only say a state.
- Not shadcn/ui's own React components, by measuring: React with four Radix parts, the toasts and the icons is 416 KB (131 KB zipped) before any page exists, where a whole page document was 43 KB. And a page is a plain HTML file its plug-in ships, which a user's own plug-in adds with no build step; React would have made every plug-in page a build.
- Built once, when Flowbound itself is built (`scripts/build-pages.mjs`: Tailwind, then esbuild), into `src/plugins/pages/built`, which is not in git. Nobody who uses Flowbound builds anything: on a laptop, on Vercel and on a server of your own the package carries the finished files. Tailwind, Basecoat, the fonts and the icons are build-time only (devDependencies).
- Only the Basecoat parts the pages use are taken (12 of some fifty), by name, out of its style pack; and its input rules are cut from 28 selectors to one. The build fails with a plain sentence if Basecoat's files change shape. Its version is pinned.
- None of Basecoat's scripts. Dialogs, the phone menu and selects are the browser's own (`<dialog>`, `<select>`): focus, Escape and phones are the browser's work, and nothing young sits between a person and a yes.
- A page says what it shows with named parts (docs/design.md), never with loose utility classes: the style sheet only holds what the build saw, so a class it never saw would do nothing in a user's own plug-in page.
- In the browser the style sheet and the script are two files with a mark of their content in the address, kept by the browser for a year: a page's own HTML stays about as small as before.
- A sidebar from 1024px, a menu button under it. The row of links ran out at seven pages on a phone, and plug-ins add more.  Six tabs since the reshape: Needs you, Runs, Tables, Workflows, Keys, Permissions.
- While a run goes on, a page is refreshed, not rebuilt: only the parts marked `data-live` that changed are swapped. Before, the whole page was drawn again every two seconds, which threw away focus (Stop could not be pressed by keyboard), sideways scroll and selected text, and one failed refresh stopped it for good. Now it rests in a hidden tab, and says when the connection is gone and tries again.
- The yes stands apart from everything else (`.decision`). Since the reshape it is a question with Not now beside it, never a Yes button: the person tells their agent.
- Tables show one page of 100 rows, with the page, the search and the order in the address. For that the table tool gained `search`, `sort` and `desc` (added; nothing it did before changed): the database searches and sorts, the page never holds more than it shows. No TanStack Table for the same reason: there is nothing left for it to do in the browser.
- A person is shown what they may do: someone who may only look sees the yes and its numbers, not a button that refuses. Removing a person, handing over "manage" and removing an agent's token are asked once more. Stop stays one tap, always: stopping spending is never slowed down.
- Left out on purpose: start time and duration on runs (the runs tool does not return them), a preview before a CSV import, removing a saved key. Each is a change to what Flowbound does, not to how it looks. (Start time and duration, and removing a saved key, were added the same day by the full check: "Carried over" below.)
- For the current chat views, see “Flowbound opens in the chat” above.

## Diagrams (26 Nov 2026)
**Replaced by the reshape.** A picture read from the workflow's code (`outline.ts`, the `inspect()` plug-in, `workflows --check` for a whole picture) was built here and is gone. The agent writes the summary and draws the diagram for people in the workflow file (`export const summary`, `export const diagram`); Flowbound only shows them. See "The reshape to the vision" above.

## The same AI step, three ways (26 Nov 2026)
**Replaced by the reshape.** One step running through the person's signed-in Claude Code or Codex, a model key or Vercel's AI Gateway (and `ai({ via })`, `ai-way`) was built here and is gone: a model is a provider, with a key typed on the Keys page. The pricing from each answer's own usage, the worst case held first and an answer cut off failing the row stay ("Keys and providers").

## Open the workflow (26 Nov 2026)
**Replaced by the reshape.** "Open in editor" and "Open in the workflow UI" (`/open/workflow-ui`, the Workflow SDK's UI served inside Flowbound, "Open in Vercel") are gone: an agent can open a file or the SDK's own UI itself. The code stays on the Workflows page, under the agent's summary and diagram, coloured by a few lines of script (notes, text in quotes, the language's words).

## Data (26 Nov 2026)
**Replaced by the reshape.** The page of every raw table (`data()`), Drizzle Studio with its database socket, and "Open in Neon" are gone; the Tables tab stays, and an agent reads anything else with `sql`. What stays from this section: Flowbound's database layer did not move to Drizzle (most tables are made at run time, each plug-in brings its own SQL, and moving would rewrite migrations existing projects applied), and Neon is still the default live database.

## Workflow usability

Added, and why:
- A wall around a Flowbound on a person's own computer. Found by trying it: a request made as another website ran SQL and started a paid try-out, because locally nobody signs in and the address was the only door. Now a request is turned away when it was sent to a name that is not this computer's (a made-up DNS name pointed at 127.0.0.1) or, for anything that is not a read, when the browser says it comes from another site. It sits in the core, before any route, so `/api`, `/mcp` and the `?live` pass-through are all behind it. The command line, the MCP server and a private proxy (which says the name the browser used) pass. Both earlier products had this.
- `overview()`: one more plug-in, one line. It gives the first page (since the reshape: Needs you, at `/needs`) and `flowbound doctor`. It knows no other plug-in: every plug-in may say what needs a person with `attention`, and this one only gathers it. So a person's first page and an agent's first command show the same list, and a plug-in of your own joins with one line.
- What the check-up looks at was chosen from what stopped people in the old products: a key a workflow needs, a workflow file that is not well formed, a run waiting for a yes, the newest run of a workflow when it stopped short, a run that says it is running while no row has moved for half an hour, a webhook with no signing secret, a price surprise, and live, people waiting for rights. `--deep` tries each saved key again at its provider; the page never does, so opening it calls nobody.
- Which workflows use a key is read from each workflow file's `use("...")`, also through files of its own it imports. The old products had this written by hand per workflow (up to 300 lines of it); here nothing is declared. A name put together while running is not seen, so the page says "used by", never "not used". The keys page puts what a workflow waits for first, and has Remove with a question that names what stops.
- A card may say it also works with no key on a person's own computer (`without`). (The model card used it for the signed-in Claude Code route, gone in the reshape.)
- Runs show when they started and how long they took (both were stored, never shown), are filtered by state and workflow in the address, and `--rows 100` does only the next 100 rows: "do a hundred first" was said in every old project, and the dollar cap alone could not say it.
- One run of a workflow at a time, also for runs somebody asks for. Tried: two started by hand both did all 27 rows, paid once and worked twice. Runs that start by themselves already had the rule in the database; a run somebody asks for is refused with the number of the one going. The check-up's stuck-run line is its other half, so a dead run cannot hold a workflow for ever without anybody being told.
- A list has a key when a person or a step says so: `import --add --key email` brings rows already there up to date and adds the new ones, and `use("records").add(list, rows, { key })` does the same from a step. That is "one row in, many rows out" (a company's five people) and "one table feeds the next". A results table stays one row per list row. An empty cell never wipes what the list has, and a row that already has a result keeps it.
- `hook({ row })`: a few lines that turn a sender's own shape into a row, or into nothing for an event that is not a row. A booking tool and a CRM post nested events of many kinds; before, every one became a row of JSON text. It runs only after the signature is checked.
- The CSV a person downloads is made for a spreadsheet: a cell that would run as a formula gets a `'` in front (scraped text is not to be trusted), numbers and phone numbers are left alone. What an agent reads with `table` or `sql` is the cell as it is.
- Recipes are a guide, read by name (`flowbound docs recipes`) so the first guide stays short. A plug-in has `guides` for that. Each recipe is a whole workflow file and the tests run the text of the guide itself against the fake provider and the FAKE model, so a recipe cannot rot. The scoring recipe keeps its criteria in the workflow file on purpose: a full run needs a try-out of the file as it is.
- `init --example`: eight made-up companies and a workflow of plain code, tried once for $0.00, so the pages are not empty before a key exists. It is asked for, never the default: a new project stays empty unless the person wants the example.
- How the agent talks to the person (a few plain lines, the numbers first, one question at a time, a yes only for spending) is in the instructions, and the skill says what it is not for and is tested to stay under the 1,024 characters agent apps load: the earlier product lost a skill to a 1,051-character description.

Left for later, each with its reason:
- Company context (ICPs, personas, voice) as a plug-in with a page. It was used for real. It waits for a decision: a changed ICP changes what a run does, and a full run needs a try-out of the file as it is.
- One shared People and Companies record: the earlier outside review called it the lasting value; the plan already says later, as a plug-in.
- Doing a row again after some days (scores redone, job changes noticed): it changes how a run picks rows.
- A notice when a run ends or needs somebody: a chat's incoming address is itself the secret, so keys need a new kind first.
- Waiting for a person inside a run: it matters once a step sends something, and nothing sends yet.
- A step where the model picks its own tools; signing in to a CRM or a sheet by OAuth (the reshape writes to one with a key, as a provider call); credits left at a provider before a run; who is visiting on a shared private address (today anyone who reaches it is "You"); refusing the live database from a laptop; upgrade notes; a privacy scan before the repo is public (the reviewer found a tailnet name, the staging address, a team name and a home path in the docs).

## An agent's SQL sees only the person's tables
- Read-only SQL (an agent's token, or a signed-in person who may edit but not manage) runs as **the reader**, a database role that may read the tables in `public` and nothing else. Flowbound's own schemas (`fb_*`, the runner's `workflow`) were never opened to it, so the database refuses them however the query is written: a schema name, a CTE, a subquery, `query_to_xml`, `copy`, `information_schema` (which shows it no names of them), `pg_stats`. Filtering table names in the query was not chosen: SQL has too many ways to name a table.
- Postgres and Neon: the reader is a login of its own (`flowbound_reader_<12 hex>`, one per database and owner, since roles belong to the whole server). A role switched to on Flowbound's own connection would not hold: a role can always switch back to the login it came in on (`set role`, or `set_config('role', ...)` inside the one statement). Its password is worked out from the database login and its password (an HMAC), not the host, so the pooled and the direct address agree, so every copy of a live Flowbound agrees on it, nothing is stored, and whoever could work it out already has the whole database. Made or brought up to date at every start, under the start lock. It also gets `default_transaction_read_only`. It needs the database login to have CREATEROLE (Neon's owner has it); without it Flowbound still starts and read-only SQL is refused with the reason: closed, not open.
- PGlite has one login and it is the superuser, so there the reader is a role switched to inside the transaction, and the two ways to switch back from inside one statement are closed to everybody but the superuser: `set_config` and the plpgsql language (a DO block running `set role`). Flowbound itself runs as the superuser and uses neither otherwise. This is the strongest PGlite allows; on a person's own computer the database is a folder anyway.
- Both engines take one statement only (the extended protocol), so nothing can follow it (`; reset role; ...`). Tables made later in `public` are opened to the reader as they are made (default privileges).
- On your own computer, SQL that is not read-only (yours, and an agent's there, as today) still reaches everything: nobody signs in, the person is the manager, and an agent with a shell can open the database folder itself. The same for a live manager's SQL, as before (`SQL that changes things is manage`).
- (The Data page this once named is gone in the reshape.)
- Tried on PGlite and on a real Postgres 17 in Docker, as a Neon-like owner (CREATEROLE, not superuser) and as a superuser (`test/sql-wall.test.ts`, the second with `FLOWBOUND_TEST_DATABASE_URL`). Not tried on Neon itself: that a role made with SQL logs in through Neon's pooled address is from Neon's manual.
- Left as it is: the names and row counts of Flowbound's own tables still show in `pg_class`/`pg_stat_user_tables` (names, not contents), and a view in `public` that a manager makes over one of Flowbound's own tables would show it to the reader: that is the manager's own act.

Left out on purpose:
- A chat agent, voice and a Slack or Teams agent inside the product: the heaviest part of both (4.4 GB idle when run here), never proven hosted. Flowbound lives inside the agent a person already uses.
- Public share links (they needed a second, public deployment), folders for workflows (redone twice in each), hand-written details per workflow, input as JSON instead of a list, a separate connections app (built and deleted within ten days), plug-in machinery (sync, eject, diff).
- Setting a key from the command line, however well hidden the prompt: the command line is the agent's door.
- A monthly cap for the whole project (every dollar already sits under a cap a person gave), charging a failed row its estimate (here the money is held first, so a failed call costs nothing), an agent approving its own spending.
- Vercel's own login, clocks and key store; copying the live database down; testing the skill on a real model in every check (it spends).
