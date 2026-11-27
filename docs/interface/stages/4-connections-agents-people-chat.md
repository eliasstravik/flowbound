# Stage 4: Connections, Agents, People and the in-chat view

**Goal.** Finish Flowbound's new interface exactly as the frozen spec shows it: Connections (any named key),
the Agents page, the People tab under Permissions, Changes behind "See them", and the in-chat view.

**Needs first:** stages 1, 2 and 3 merged into main.

## Read first

- `docs/interface/README.md`, `decisions.md` (10, 11, 13, 14, 16, 17, 20, 21, and "Who signs in"), `plan.md`,
  `open.md`.
- `docs/interface/spec/index.html`: Connections, Agents, Permissions → People (Invite by email), the changes line
  in the menu, First day; `spec/steps/13-chat-app.html` (only the framed part), `16-agents.html`,
  `17-add-connection.html` (option 2), `20-people-rights.html` (option 2), `21-agent-remove.html`.
- `docs/design.md`, `docs/sign-in.md`, `AGENTS.md`, `src/plugins/keys.ts`, `src/plugins/door.ts` and
  `door/people.html`, `door/connect.html`, `changes/changes.html`.

## Build

1. **Connections** (today's Keys): one list, each a name you choose and a secret key, with what uses it, Set or
   Missing, Change. Add connection asks only for a name and a key: any provider, also one Flowbound has never
   heard of; workflows use it by that name. No list of known services, no sign-ins, no key check (for now). Keys
   are typed only here, never in a chat; the agent never sees them.
2. **Agents** (menu item after Connections): how to connect Claude and ChatGPT (the `/mcp` address) and Claude
   Code and Codex (the connect command), each with Copy; then the connected agents: agent, whose, last used,
   Remove. You see and remove your own; Admins and Owners see and remove everyone's. Home's "Connect one" leads
   here. Locally, show what applies there.
3. **People** (a tab under Permissions, seen only by Admins and Owners; live only): Allowed domains (several,
   whose people may sign in as Viewers; Owners edit them; the first comes from the deploy settings); the people
   with their roles (Viewer, Member, Admin, Owner), Change role, Remove; Invite by email (any address, any domain,
   with a role, Member by default; no email is sent; the person signs in with the Google or Microsoft account on
   that address). This changes the door (`src/plugins/door.ts`): today it takes one domain; keep Better Auth.
4. **Changes**: the menu shows "N changes not live · See them" only when there are changes; See them opens today's
   Changes list; publishing is asked of the agent (no Publish button).
5. **In-chat view**: the `show` view is the same page as the app (a run, a table, a workflow) without the menu,
   headed Flowbound with Open in Flowbound; expanded to full screen it is the whole app with its menu. While it
   loads it reports a loading height, not 0. Do not change the connector's tools themselves (search, execute,
   show); keep an https redirect on a private tailnet address allowed for MCP sign-in.
6. **Only these act on a page**: Connections (keys), People, removing an agent, and Stop on a run (stage 2).
   Remove any other button that starts, approves or changes something.

## Rules

- Keep the connector's tools exactly as they are. Spend nothing beyond $0 runs. Nothing private in the repo. No
  other products' names in the project. Never drive a signed-in AI app with automation: test the in-chat view
  with the repo's chat stand-in.
- Tests for what you touch (`test/door.test.ts`, keys, the MCP tests); `npm run check`'s lint and types.

## Proof

Screenshots at 390 px and 1280 px, light and dark: Connections with Add connection, Agents as a Member and as an
Admin, People with Invite, the changes line, the in-chat view inline and expanded (chat stand-in), each beside the
prototype; on the demo once merged. A fresh reviewer compares the whole build with
`docs/interface/spec/index.html` and lists every difference; fix them.
