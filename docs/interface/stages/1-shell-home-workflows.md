# Stage 1: Shell, Home and Workflows

**Goal.** Build the first part of Flowbound's new interface, exactly as the frozen spec shows it: the menu, Home,
workflow folders, a workflow's page with its tabs and Mermaid diagram, and the Schedules page.

**Needs first:** nothing. This stage lands before the others; stages 2, 3 and 4 build on its menu and folders.

## Read first

- `docs/interface/README.md`, `decisions.md`, `plan.md`, `open.md`.
- `docs/interface/spec/index.html`: open it in a browser (serve the folder on 127.0.0.1) at phone (390 px) and
  desktop width. Click: Home, Workflows → TAM mapping → Nordics, back, Find sales heads (every tab, tap the
  step buttons under the diagram), Schedules, the "First day" switch.
- `docs/design.md` (the page parts: build with them, not with the prototype's CSS) and `AGENTS.md`.

## Build

1. **Menu**, in this order: Home, Workflows, Runs, Schedules, Data, Context, then (after a divider) Connections,
   Agents, Permissions. Home replaces Needs you and is where `/` lands. Pages that stages 2 to 4 rebuild keep
   working at their current addresses until then; a page not built yet keeps today's content under its new name
   (Tables shows as Data, Keys as Connections) so nothing breaks in between.
2. **Home**: a "Talk to Flowbound from your own agent… Connect one" line (links to today's connect page until
   stage 4 makes Agents); Needs attention (today's Needs you items; a waiting yes shows its question, "Tell your
   agent yes, and it passes it on" and Open run, no other buttons); Recent runs; Spend this month. On a first
   day: the Get started checklist (Set up Flowbound, Connect an agent, Run the free sample, Add a connection),
   each a link that ticks itself (Flowbound started; an agent first connected; the sample workflow ran once; the
   first key saved), gone when all are done. The menu count is the number of Needs attention items.
3. **Workflows in folders**: workflow files may sit in folders and subfolders under `workflows/`
   (`workflows/tam-mapping/nordics/build-tam-list.ts`). This is engine work: discovery in
   `src/plugins/workflow-sdk/build.ts` (it reads one flat folder today), workflow ids, the CLI, the connector's
   answers, runs and schedules must all accept a workflow in a folder, with a clear id (say `tam-mapping/find-sales-heads`).
   Keep flat files working.
4. **Workflows page**: Drive-style. Folders first (name, "N folders · M workflows"), then loose workflows (name and
   one line, nothing else: no run states, filters or counts). Tap a folder to go in; a path at the top leads back.
   Search filters across every folder and shows each hit's folder path.
5. **A workflow's page**: path at the top; title; one line; Open in editor (local only: opens the file, as the
   legacy build did, see `git show fd60fc5^:src/plugins/inspect/open.ts`) and Open in workflow UI (local: the
   Workflow SDK's UI; live: the Vercel project's Workflows page; shown only where it works); the Starts box (when it
   starts and the next time, or the webhook address with Copy; "Also: when you or your agent asks"); tabs Diagram,
   Code, Runs, Data. Diagram is first.
6. **The diagram**: the agent writes `export const diagram = \`flowchart TD …\`` (Mermaid flowchart) in the workflow
   file, with `click <node> <function>` lines tying boxes to steps. Flowbound draws it with mermaid.js (bundled, no
   CDN), themed with Flowbound's colours and Geist, with zoom and Fit; tapping a box with a `click` line shows that
   step's code under the diagram. Drift guard: a quiet line when a `"use step"` function has no `click` line. No
   diagram: the Code tab opens first with a line saying so. Update the skill and `workflows.md` so agents write the
   Mermaid block and keep it in step with every code change; today's SVG diagram (`diagram.ts`) goes.
7. **Code tab**: today's code view. **Runs tab** and **Data tab**: this workflow's runs and the table it reads and
   fills, using today's runs list and table view until stages 2 and 3 replace them.
8. **Schedules page**: every schedule and webhook: workflow (with its folder), when it starts, next time.

## Rules

- Keep the connector's tools (search, execute, show) exactly as they are: do not change them.
- Spend nothing beyond $0 runs (the fake provider). Nothing private in the repo. No other products' names in the
  project. Never drive a signed-in AI app with automation.
- Tests for what you touch (`test/`), `npm run check`'s lint and types.

## Proof

Screenshots of every page and state above at 390 px and 1280 px, light and dark, beside the matching prototype
screen, on the demo deployment (`https://flowbound-demo.vercel.app`) once merged, or a local run before. A fresh
reviewer compares the build with `docs/interface/spec/index.html` and lists every difference; fix them.
