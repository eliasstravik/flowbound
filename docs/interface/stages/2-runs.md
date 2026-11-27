# Stage 2: Runs

**Goal.** Build the Runs list and a run's page exactly as the frozen spec shows them: every row of a run, each
with its step timeline, the waiting state, Stop, and Open in workflow UI.

**Needs first:** stage 1 (Shell, Home and Workflows) merged into main. Stage 3 may run beside this one.

## Read first

- `docs/interface/README.md`, `decisions.md` (5, 11, 18), `plan.md`, `open.md`.
- `docs/interface/spec/index.html`: Runs; Find sales heads (tap rows: Northwind, Ironclad, Redwood); Home →
  Open run on the waiting yes (Find champions); `spec/steps/05-run-view.html` and `18-waiting-run.html`.
- `docs/design.md`, `AGENTS.md`, `src/plugins/workflow-sdk/runs.html`, the ledger (`src/plugins/ledger.ts`).

## Build

1. **Runs list**: workflow name (with its folder), state, when; newest first; 50 at a time with Previous and Next.
   A workflow's Runs tab is the same list for that workflow. Tapping a run opens its page.
2. **A run's page**: path (Runs / name, date), title with its state; Done (n of total), Failed, Spent (of the
   cap), Started (time and how: schedule, webhook, asked); Stop (the only action on the page; cancels at once,
   Not now's meaning today) and Open in workflow UI (local: the Workflow SDK's UI for this run; live: the Vercel
   project's run); then **Rows**: each row with its status and cost, 50 at a time.
3. **A row's steps**: tap a row to open its timeline under it: each step on a time axis with its name (the
   diagram's box label for that function, else the function's name), provider and price, "already known · N days
   old · free" when nothing was bought, or why it failed in plain words. This needs per-row step records
   (function, start, end, provider call, price, error); keep them in Flowbound's own tables. Choose whether to keep
   the millisecond bars (open.md, "your call").
4. **Waiting for a yes**: a run that waits is a run. Its page says Waiting for a yes, shows the question, the
   try-out's result, nothing spent, Stop; the list shows it; Home's Open run lands here. No Approve button: the
   yes goes through the agent.
5. Failed, capped and stopped runs keep today's plain-words reasons.

## Rules

- Keep the connector's tools (search, execute, show) exactly as they are.
- Spend nothing beyond $0 runs. Nothing private in the repo. No other products' names in the project.
- Tests for what you touch; mind the 10,000-row scale tests (`test/scale`): run heavy tests one at a time.

## Proof

Screenshots at 390 px and 1280 px, light and dark, of the runs list, a running run with a row opened, a failed
row, a waiting run and a capped run, beside the matching prototype screens; on the demo once merged. A fresh
reviewer compares the build with the spec and lists every difference; fix them.
