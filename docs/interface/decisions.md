# Flowbound's interface: what was decided

A consulting session on 27 November 2026 decided, from scratch, what Flowbound's pages and in-chat view show. The
person's goal: as plain and familiar as possible, the shape people already know from workflow and data tools, built
on today's foundations. Every choice below was the person's; each links to the page that showed the options
(`spec/steps/`, open in a browser, `#option=<n>` shows an option). The whole result is the frozen prototype,
[spec/index.html](spec/index.html): it is the spec.

## Principles

- **Show the 80%, link to the real tool for the rest.** Flowbound shows what people most need to understand; every
  page links out to the deep tool: the workflow UI (locally, or the Vercel project's Workflows page live), Drizzle
  Studio locally, Neon live, the file in an editor.
- **Everything goes through the agent.** Nothing is started, approved or changed from a page. The only things a page
  does itself: typing a key (Connections), managing people (People), removing a connected agent (Agents), and Stop
  on a run's page.
- **Not opinionated.** Like workflows and tables, context is whatever files you put there; connections are whatever
  keys you name.
- **Keep the foundations:** Basecoat (shadcn/ui's look), Geist, lucide, the page parts in [design.md](../design.md),
  the work login and roles, the connector's tools (search, execute, show) and the in-chat app, Save and Publish,
  permissions and caps, never pay twice.

## The decisions

| # | What | Decided |
| --- | --- | --- |
| 1 | The menu | Home, Workflows, Runs, Schedules, Data, Context, then Connections, Agents, Permissions. Home replaces Needs you. [step 1](spec/steps/01-navigation.html#option=1) |
| 2 | Workflows list | Folders you open, like a file drive: folders first, then loose workflows, a path at the top, subfolders allowed. Each row is only a name and one line: no run states, filters or failing counts ("we have runs and stuff other places, so just simplify"). [step 2](spec/steps/02-workflows-list.html#option=1) |
| 3 | The diagram | The agent writes it as a Mermaid block in the workflow file, kept in step with the code ("think of these diagrams almost like an agent conversation… do everything we can so that it doesn't [drift]"). Shown first, without asking. [step 3](spec/steps/03-diagram.html#option=1) |
| 4 | A workflow's page | Tabs: Diagram, Code, Runs, Data. [step 4](spec/steps/04-workflow-page.html#option=1) |
| 5 | A run's page | Done, Failed, Spent, Started; every row, tap one for its steps as a timeline with provider and price, or why it failed; Open in workflow UI for the raw trace. [step 5](spec/steps/05-run-view.html#option=1) |
| 6 | Data | The table list beside the grid on a desktop; on a phone the table's name on top, tap it for the list. Tables sit in the same folders as their workflows. Each bought answer shows source, age and cost. [step 6](spec/steps/06-data.html#option=1) |
| 7 | Schedules and webhooks | On the workflow (when it starts, the next time, or the webhook address with Copy) and a Schedules page listing them all. [step 7](spec/steps/07-schedules.html#option=2) |
| 8 | Context | A Context page of any files and folders you or your agent put in `context/`; open one to read it; Open in editor. No set kinds. [step 8](spec/steps/08-context.html#option=1) |
| 9 | Chat page | None. You talk to Flowbound from your own agent; Home links to Agents. [step 9](spec/steps/09-chat.html#option=1) |
| 10 | Keys | Called Connections. The agent hook-up is called Agents, so the words don't clash. [step 10](spec/steps/10-keys.html#option=1) |
| 11 | The yes | Only through the agent. Stop only on a run's page. [step 11](spec/steps/11-yes.html) |
| 12 | First use | A Get started checklist on Home. [step 12](spec/steps/12-first-use.html#option=2) |
| 13 | In-chat view | The same page, one at a time (a run, a table, a workflow), without the menu, with Open in Flowbound; expanded to full screen it is the whole app with its menu. [step 13](spec/steps/13-chat-app.html#option=1) (only the framed part is the spec) |
| 14 | People | A People tab under Permissions. [step 14](spec/steps/14-changes-people.html#option=1) |
| 15 | Drawing the diagram | Mermaid's own renderer, in Flowbound's colours and font: branches, merges and loops for free. [step 15](spec/steps/15-diagram-branches.html#option=1) |
| 16 | Agents | An Agents page in the menu: how to connect each kind of agent (address or command, with Copy), then the connected agents with whose each is, last used, Remove. [step 16](spec/steps/16-agents.html#option=1) |
| 17 | Add connection | A name you choose and a key. No list of known services, no sign-ins, no key check, for now ("there are too many services"). [step 17](spec/steps/17-add-connection.html#option=2) |
| 18 | A run waiting for a yes | A run whose page says Waiting for a yes: the question, the try-out's result, nothing spent, Stop. [step 18](spec/steps/18-waiting-run.html#option=1) |
| 19 | Get started items | Links (Agents, the free sample workflow, Connections) that tick themselves when it happens. [step 19](spec/steps/19-checklist.html#option=1) |
| 20 | Who sees People | Only Admins and Owners. Invite asks for an email and a role. [step 20](spec/steps/20-people-rights.html#option=2) |
| 21 | Removing agents | You see and remove your own; Admins and Owners see and remove everyone's. [step 21](spec/steps/21-agent-remove.html#option=1) |

Step pages are snapshots taken when each question was asked; where a later decision changed a part, the prototype
([spec/index.html](spec/index.html)) wins.

## Decided in conversation

- **Folders hold a play.** A folder is the container for one play (TAM mapping, champion tracking): its workflows
  and the tables they fill, the way spreadsheet tools group sheets into a workbook. Subfolders are fine. Each
  workflow fills one results table; lists are tables that several workflows may read. The database stays plain
  (your tables, and Flowbound's own): folders are not database schemas, and moving a workflow moves nothing in the
  database. Neon and Drizzle Studio show a flat list; Flowbound shows the folders.
- **Who signs in.** Owners keep a list of allowed domains (several, like acme.com and acme.ca) whose people may sign
  in as Viewers, and may invite anyone at any address with a role. Sign-in stays Better Auth with the work login
  (Google, Microsoft, Okta). An invite sends no email (share the link); the person signs in with the Google or
  Microsoft account on that address.
- **The diagram's drift guard.** The skill tells the agent to update the diagram with every code change, and
  Flowbound shows a quiet line when a `"use step"` function has no box (`click` line) in the diagram.

## What was cut, and stays cut

A chat page, a visual workflow editor, set kinds of context, Approve buttons, approvals in a chat tool, plain
variables, schemas per folder, sign-ins to services and a list of known services (for now), the standing yes, a
separate Lists page (lists are tables).
