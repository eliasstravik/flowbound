# Flowbound's interface: the spec

What Flowbound's pages and in-chat view show, decided from scratch with the person on 27 November 2026, and the
plan for building it in four stages.

| File | What it is |
| --- | --- |
| [spec/index.html](spec/index.html) | **The spec**: the frozen prototype. Open it in a browser and click through. The "Normal day / First day" switch shows the first-use state. |
| [decisions.md](decisions.md) | Every decision, in plain words, with the person's own words where they shaped it. |
| [plan.md](plan.md) | Only what the prototype can't show: data rules, where things live, limits. |
| [open.md](open.md) | What is left open: "ask" (stop and ask the person) or "your call" (the builder decides). |
| [spec/steps/](spec/steps/) | One page per question asked, with its options (`#option=<n>`). Snapshots: where they differ from `spec/index.html`, the spec wins. |
| [stages/](stages/) | One brief per build stage, in order. Each is a task prompt on its own. |

## The handoff

Build Flowbound's interface so it matches the prototype exactly. Where plan and prototype disagree, the prototype
wins. Anything neither shown nor listed: stop and ask. The prototype is throwaway: rebuild it properly with today's
page parts ([design.md](../design.md)); never ship its code. Done means: a reviewer opens the build and the
prototype side by side, goes through every screen and case, and lists each difference as a finding. Differences
are fixed, not explained.

The spec passed three rounds of review by a fresh reviewer (must fix: major and worse).

## The stages, in order

1. [Shell, Home and Workflows](stages/1-shell-home-workflows.md): the menu, Home, workflow folders, the workflow
   page with its tabs and Mermaid diagram, Schedules.
2. [Runs](stages/2-runs.md): the runs list and a run's page with rows and step timelines. Needs stage 1.
3. [Data and Context](stages/3-data-context.md): the Data page with folders, every table, Open in Drizzle Studio
   or Neon; the Context page. Needs stage 1.
4. [Connections, Agents, People and the in-chat view](stages/4-connections-agents-people-chat.md). Needs stages 1
   to 3.

Stages 2 and 3 may run side by side once stage 1 has landed.
