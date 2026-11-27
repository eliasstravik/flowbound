---
name: flowbound
description: Build and run GTM workflows (list building, research, enrichment, scoring, finding people and emails for a list of companies) and keep every paid fact, on the person's own data provider keys, with Flowbound. Use when the person asks for such a job, mentions Flowbound, or the folder has a flowbound.config.ts. Not for sending emails or messages on its own, for one-off web research with no list, or for work on the flowbound package itself.
---

Flowbound is installed per project, and its instructions ship with the installed version so they always match it.

1. If this folder has no `flowbound.config.ts`, set it up first: `npx flowbound init` (no account, no sign-up).
2. Read the instructions: `npx flowbound docs`. Follow them; do not work from memory of an older version.
3. With no shell or project folder (a chat app connected to a live Flowbound): use `search` to find tools, then
   `execute` with `return await flowbound.docs({ topic: "start" })`. Read the matching live guide before acting;
   `topic: "topics"` lists parts, `"workflow-sdk"` explains workflows, and `"recipes"` gives examples. Every tool
   below is available as `flowbound.<tool>(input)` through `execute`, including `doctor`, `permissions`, and `yes`.

Workflows are code in the project's Git repo. Read `workflow-sdk` for the file format and `changes` for the
Save and Publish steps. In chat, read the code and commit from `workflow-file`, write the new file, and save it
with `workflow-save`. Show the change link and check its preview with `workflow-change`. Publish with
`workflow-publish` only when the person asks. Report required GitHub review and check production before saying
it is live. Use `workflow-undo` to save a revert for the same checks. Engineers can keep working directly in Git.

When something seems off, or before you say all is well: `npx flowbound doctor` lists what needs the person
(also on the page under Needs you), each with the one thing to do.

Every run is held to the person's permissions (`npx flowbound permissions`): ask every time, auto inside caps, or
skip. A budget they say in chat is `--max-usd`. Whole workflow files for common shapes: `npx flowbound docs recipes`.

Three rules hold everywhere: never ask the person for a provider key or a webhook's signing secret in the chat (they
are typed on the Keys page); never say yes for them: when a run waits for a yes, show the question word for word and
pass on their own answer (`npx flowbound yes <run>` or `no <run>`), and never widen their permissions unasked; and
write a plain summary and a diagram (`export const summary`, `export const diagram`, an SVG) in every workflow file,
for the people who read it on the page.

Talk to the person in a few plain lines: the numbers first, one question at a time, and a yes or no only for
spending or for something that cannot be undone.
