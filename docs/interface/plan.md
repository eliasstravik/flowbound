# Flowbound interface: plan

## Outcome

Flowbound's own pages (on your computer and live for a team) and its in-chat view, rebuilt from scratch as plainly as possible: the familiar shape of workflow and data tools, today's foundations (Basecoat/shadcn look, Geist, work login and roles, the connector and in-chat app, Save and Publish, permissions and caps, never pay twice). For GTM people who build with an agent and need to see what it built, what ran and what it found.

## Prototype

`spec/index.html`: open it and use the menu. It is a look-alike made to decide what shows where: it uses its own font and plain CSS, while the build uses today's Basecoat, Geist and lucide parts ([design.md](../design.md)). Copy what is shown and where, not its styling. Every page is clickable; "Normal day / First day" switches every page to its first-use state (Home's checklist, one line on each empty page). Workflows → TAM mapping → Find sales heads opens a workflow; Runs → Find sales heads, 27 Nov opens a run; tap a row for its steps.

## Decisions

1. Menu: Home, Workflows, Runs, Schedules, Data, Context, then Connections, Agents, Permissions. [step 1](spec/steps/01-navigation.html#option=1) (Schedules added in step 7, Context in step 8, Keys renamed Connections in step 10.)
2. Workflows list: Drive-style folders, folders first then loose workflows, a path at the top, subfolders allowed; each row is only a name and one line. No run states, filters or failing counts. [step 2](spec/steps/02-workflows-list.html#option=1)
3. Diagram: written by the agent as a Mermaid block in the workflow file; Flowbound draws it with Mermaid (step 15). Shown first on the workflow, without asking. Tap a box (Mermaid `click <node> <function>`) to see that step's code. [step 3](spec/steps/03-diagram.html#option=1) The person: "think of these diagrams almost like an agent conversation… do everything we can so that it doesn't [drift]."
4. Workflow page: tabs Diagram, Code, Runs, Data; header has Starts (step 7), Open in editor, Open in workflow UI. [step 4](spec/steps/04-workflow-page.html#option=1)
5. Run page: Done, Failed, Spent, Started; Stop; Open in workflow UI; every row, tap one for its step timeline with provider and price or why it failed. [step 5](spec/steps/05-run-view.html#option=1) Principle from the person: show the most important 80%, link to the real deep tool for the rest.
6. Data: table list beside the grid (phone: the table's name on top, tap for the list); tables sit in the same folders as their workflows; Flowbound's own tables last; every bought answer shows source, age and cost; Search, Download CSV, Open in Drizzle Studio (local) or Open in Neon (live). [step 6](spec/steps/06-data.html#option=1)
7. Schedules and webhooks: on the workflow (Starts box: when, next time, or the webhook address with Copy) and a Schedules page listing all. [step 7](spec/steps/07-schedules.html#option=2)
8. Context: a page of any files and folders in `context/`, Drive-style; open a file to read it rendered; Open in editor. No set kinds. [step 8](spec/steps/08-context.html#option=1)
9. No Chat page; Home says to talk to Flowbound from your own agent and links to Agents (connect one). [step 9](spec/steps/09-chat.html#option=1)
10. Connections: one list, each a name you choose and a secret key, with what uses it, Set/Missing, Change; Add connection asks only for a name and a key ([step 17](spec/steps/17-add-connection.html#option=2)). No list of known services, no sign-ins and no key check for now. The agent hook-up is called Agents. [step 10](spec/steps/10-keys.html#option=1)
11. The yes: only through the agent. The page acts only for keys (Connections), people (step 14), removing agents (step 21) and Stop on a run's page. Home shows the waiting question with Open run. [step 11](spec/steps/11-yes.html) The person: "stop you should only do in the runs view, just like… Vercel workflows."
12. First use: a Get started checklist on Home (Set up Flowbound, Connect an agent, Run the free sample, Add a connection), ticked as done, gone when all are. [step 12](spec/steps/12-first-use.html#option=2)
13. In-chat view: the same page one at a time (run, table or workflow), no menu, Open in Flowbound; expanded to full screen it is the whole app with its menu. [step 13](spec/steps/13-chat-app.html#option=1)
14. People: a People tab under Permissions (seen only by Admins and Owners, step 20) where an Admin or Owner invites anyone by email (any domain) with a role, changes roles (Viewer/Member/Admin/Owner) and removes people; above the list, "Allowed domains" (several, e.g. acme.com, acme.ca) whose people may sign in and get a default role (Viewer). [step 14](spec/steps/14-changes-people.html#option=1)

15. Diagram drawing: Mermaid's own renderer (mermaid.js), themed to Flowbound's colours and font, with zoom and Fit; branches, merges and loops as Mermaid lays them out; tapping a box (its `click` line) shows that step's code. [step 15](spec/steps/15-diagram-branches.html#option=1)
16. Agents page in the menu under Connections: how to connect Claude, ChatGPT (the `/mcp` address) and Claude Code, Codex (the connect command), each with Copy; then the connected agents, whose each is, last used, Remove. You see and remove your own agents; Admins and Owners see and remove everyone's ([step 21](spec/steps/21-agent-remove.html#option=1)). Removing an agent is a page action, like People. Home's "Connect one" links here. [step 16](spec/steps/16-agents.html#option=1)
17. Add connection: a name you choose and a key; nothing else. [step 17](spec/steps/17-add-connection.html#option=2)
18. A run that waits for a yes is a run: its page says Waiting for a yes, shows the question, the try-out's result, nothing spent, Stop; Home's Open run lands there; the Runs list shows it. [step 18](spec/steps/18-waiting-run.html#option=1)
19. Get started items are links (Agents, the Sample contacts workflow, Connections) that tick themselves when it happens: Flowbound started, an agent first connected, the sample run once, the first key saved. [step 19](spec/steps/19-checklist.html#option=1)
20. Only Admins and Owners see the People tab; Invite asks for an email and a role (Member by default). [step 20](spec/steps/20-people-rights.html#option=2)

Decided outside a step: data is organised like a workbook — a folder holds a play's workflows and the tables they fill; each workflow fills one results table; lists are tables several workflows can read; the database stays plain (your tables, Flowbound's own), folders are not schemas; moving a workflow moves nothing in the database.

## What the prototype can't show

- Folders are real folders: `workflows/<folder>/<sub>/x.ts` and `context/<folder>/x.md`. A table belongs to the folder of the workflow that fills it (`into`); an imported list to the folder it was imported into; that membership is kept by Flowbound, not in the database schema.
- Diagram: `export const diagram = \`flowchart TD …\`` in the workflow file, Mermaid flowchart syntax only; drawn by mermaid.js in Flowbound's theme (step 15). Drift guard: the skill tells the agent to update it with every code change, and Flowbound shows a quiet line "The diagram doesn't mention step X" when a `"use step"` function has no `click` line. No diagram: the Code tab opens first with a line saying so.
- Open in: editor opens the file locally (as legacy did); workflow UI is the Workflow SDK's UI locally, the Vercel project's Workflows page live; Drizzle Studio starts locally; Neon opens the project's Neon console live. Each shows only where it works.
- The run timeline comes from Flowbound's own per-row step records (name from the diagram's node for that function, else the function name; provider, price, duration, error).
- Stop cancels the run at once; nothing else on any page starts, approves or changes anything, except Connections, People and removing an agent.
- Sign-in stays Better Auth with the work login (Google, Microsoft, Okta). Allowed domains and invites replace the single deploy-time domain: the first Owner and first domain still come from the deploy settings; after that Owners edit them on the People tab. An invite sends no email (you share the link); the person signs in with a Google or Microsoft account on that address.
- In-chat: the views come from the existing `show` tool and app; expanded mode loads the full app.
- Long lists: a run's rows, a table's rows and the runs list show 50 at a time with Previous and Next. Search on Workflows and Context filters across all folders and shows each hit with its folder path.
- Home's menu count is the number of items under Needs attention.
- In-chat view: the prototype is the framed part of [step 13, option 1](spec/steps/13-chat-app.html#option=1): the run page without the menu, inside a frame headed Flowbound with Open in Flowbound. Only that frame is the spec; the rest of that page is an older snapshot (use this prototype for everything else).
- First day: Workflows holds only the Sample contacts workflow (four made-up companies, $0); the menu count, the changes line, Agents' list and the other People are empty.
- Every page works at 390 px with one scroll and no sideways page scroll; grids may scroll sideways inside.

## Constraints

- Keep: Basecoat 1.3 on Tailwind 4, Geist, lucide icons, the page parts in docs/design.md, the work login and roles, the connector's tools (search, execute, show) as settled in "Flowbound: app on its own tool", Save and Publish, permissions and caps, never pay twice, keys never in chat.
- Spend nothing beyond the demo's $0 runs; nothing private in the public repo; no competitor names in the project.

## Out of scope

- A chat page, a visual workflow editor, set kinds of context, Approve buttons, approvals in a chat tool, plain variables, database schemas per folder, sign-ins (OAuth) to services and a list of known services, for now.
