# Changelog

What changed in each version, in the words of what you will notice. Newest first.

## 0.1.0 (not published yet)

The first version.

Reshaped to the vision before it was published (26 Nov 2026):

- **Permissions like your agent's own.** Ask every time, auto inside caps ($5 a run and $100 a month to start), or
  skip asking. A workflow or provider can have its own; the strictest wins. A budget you say in chat is that run's
  cap. When a cap is hit, the run pauses and a yes waits under Needs you. You give a yes by telling your agent.
- **Every paid fact kept, with its age.** Each answer shows where it came from, how old it is and what it cost.
  Questions are cleaned up first, and one lookup finds answers from any provider.
- **Your agent explains each workflow** in a summary and a diagram it writes in the file; the page shows them.
- **Writing to your CRM** is a provider call under the same permissions, counted by number. HubSpot ships as a card.
- **One page with six tabs**: Needs you, Runs, Tables, Workflows, Keys, Permissions.
- **Two tools for agents**: search, and execute (a few lines of code that call Flowbound).
- **Gone**: the standing yes (schedules now run under your permissions), the page of every raw table, Drizzle Studio,
  Open in Neon, Open in editor, the workflow UI button, the picture drawn from code, model steps through your
  signed-in Claude Code or Codex or the AI Gateway, and pages inside chat apps.

- **Start in one line.** `npx flowbound init` makes a project, sets up the agent apps it finds on your computer
  (Claude Code, Codex and others) and starts it. `--example` adds eight made-up companies and a workflow that costs
  nothing, so the pages are not empty before you have a key.
- **Runs on your own computer, for free.** `npx flowbound dev` keeps a small database and the runs in a hidden
  `.flowbound/` folder in your project. Nothing needs an account or a sign-up.
- **Your own keys.** Data providers (Firecrawl, BlitzAPI, Monid, treg) and AI models use keys you type on the keys
  page. Your agent uses them and never sees them.
- **Nothing is spent past your permissions.** A try-out runs 10 rows at most; a run stays inside your caps, or asks
  first, as you set. A paid answer is kept, so the same thing is not bought twice while it is fresh.
- **Workflows are plain TypeScript files** your agent writes, with a summary and diagram for people. Runs survive a
  restart and carry on where they stopped.
- **One page to see it all**, on a phone too.
- **Schedules and webhooks**, under the same permissions.
- **Goes live when you want** with `npx flowbound deploy` (Vercel and Neon), or on a server of your own. Live,
  people sign in with the work account they already have (Google, Microsoft, Okta).
- **`npx flowbound doctor`** lists what needs you, each with the one thing to do.
- **A plain message on an old Node.js**: every command says which version it needs (22.18 or newer) and how to get
  it, instead of an error nobody can read.
