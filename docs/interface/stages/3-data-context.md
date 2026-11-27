# Stage 3: Data and Context

**Goal.** Build the Data page and the Context page exactly as the frozen spec shows them: every table in the same
folders as the workflows, the grid with each bought answer's source, age and cost, Open in Drizzle Studio or Neon;
and a Context page of any files and folders.

**Needs first:** stage 1 (Shell, Home and Workflows) merged into main, for the menu and workflow folders. Stage 2
may run beside this one.

## Read first

- `docs/interface/README.md`, `decisions.md` (6, 8, and "Folders hold a play"), `plan.md`, `open.md`.
- `docs/interface/spec/index.html`: Data at 1280 px and 390 px (tap the table's name on a phone), Context (open a
  file), and the First day switch; `spec/steps/06-data.html`, `08-context.html`.
- `docs/design.md`, `AGENTS.md`, `src/plugins/postgres.ts` and `postgres/tables.html` (today's Tables).
- The legacy Data page and Drizzle Studio opener, for reference only:
  `git show fd60fc5^:src/plugins/data.ts`, `git show fd60fc5^:src/plugins/data/studio.ts`,
  `git show fd60fc5^:src/plugins/data/data.html`.

## Build

1. **Data page**: on a desktop, the table list down the left and the grid on the right; on a phone, the open
   table's name on top, tap it for the list. The list is grouped by folder (a table belongs to the folder of the
   workflow that fills it; an imported list to the folder it was imported into; Flowbound keeps that membership,
   the database stays plain), then "Flowbound's own" last (runs, facts, calls and the rest, read-only).
2. **The grid**: today's results view, every bought answer with its source, age and cost under it; Search;
   Download CSV; 50 rows at a time with Previous and Next; tapping a bought cell shows its kept fact (open.md).
3. **Open in**: locally, Open in Drizzle Studio (starts it, as the legacy build did); live, Open in Neon (the
   project's Neon console). Shown only where it works.
4. **A workflow's Data tab** (stage 1 made the tab): "Reads <list> · fills <table>" then the same grid.
5. **Context page**: whatever files and folders are in `context/`, shown like the workflows list (folders first,
   a path at the top, search); open a file to read it (Markdown rendered; other text as text); Open in editor
   (local). Nothing is edited on the page: the agent writes context. Make sure the agent's tools and skill read
   `context/` (agents use it for workflows and answers).
6. **Empty states** (First day): one line each ("No tables yet. A workflow's results land here.", "Nothing here
   yet. Ask your agent to write down what it should know.").

## Rules

- Keep the connector's tools (search, execute, show) exactly as they are.
- Spend nothing beyond $0 runs. Nothing private in the repo. No other products' names in the project.
- Never read `.env.local` files. Tests for what you touch; `npm run check`'s lint and types.

## Proof

Screenshots at 390 px and 1280 px, light and dark: Data with folders, the phone's table list open, Flowbound's own
tables, a cell's kept fact, Drizzle Studio opened locally, Context and a file; beside the prototype; on the demo
once merged. A fresh reviewer compares the build with the spec and lists every difference; fix them.
