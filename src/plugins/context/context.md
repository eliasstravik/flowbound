## Context

`context/` in the project holds what you should know to do good work for this company: who it sells to and why, its
ICPs and personas, pricing, voice, competitors, notes. Any files, in any folders (`context/company.md`,
`context/market-research/nordics.md`); Markdown reads best. People read them on the Context page; nothing is
edited there.

- Before you write a workflow, a prompt, or an answer about the company: read what is there.
  `npx flowbound context` lists every file with its first line (`--search <words>` looks inside them);
  `npx flowbound context --path company.md` reads one. Over MCP: `flowbound.context({})` and
  `flowbound.context({ path })`.
- When the person tells you something worth keeping (who they sell to, a rule, a decision), write it down as a file
  there, in plain Markdown, one thing per file, with a first line that says what it is. Change a file when it is no
  longer true. Never put keys, passwords or personal data about people in it.
- A workflow step that needs it (an AI step's instructions, a score's rules) reads it from the file at build time
  or you copy the few lines it needs into the workflow: the run itself does not read the folder.
