## Live: who gets in

On the person's own computer nobody signs in, and nothing below applies. A live Flowbound has one setting in
`flowbound.config.ts`: who vouches for people. Signing in happens inside Flowbound, with the work account people
already have.

```ts
door()                                                                    // nobody signs in: your own computer only
door({ login: "google", emails: ["ann@x.com", "bo@x.com"] })              // a few people, by a short list of emails
door({ login: "google", domain: "acme.com", owners: ["ann@acme.com"] }) // the company's own Google
door({ login: "microsoft", tenant: "<directory id>", owners: ["ann@acme.com"] }) // the company's own Microsoft
door({ login: "https://acme.okta.com", groups: { "flowbound-admins": "manage", sales: "approve", "*": "view" } }) // Okta, Entra, any OpenID Connect provider
```

The two values from the login's own console go on the host, never in the file or the chat:
`FLOWBOUND_LOGIN_CLIENT_ID` and `FLOWBOUND_LOGIN_CLIENT_SECRET`. The address to enter in that console is
`<the Flowbound's address>/door/callback`. Each setting can also come from the host's environment:
`FLOWBOUND_LOGIN`, `FLOWBOUND_LOGIN_DOMAIN`, `FLOWBOUND_LOGIN_TENANT`, `FLOWBOUND_LOGIN_EMAILS`, `FLOWBOUND_OWNERS`,
`FLOWBOUND_LOGIN_GROUPS` (`group=rights,group=rights`). `FLOWBOUND_PASSWORD` is one team password for a first
try-out, alone or beside a login: names are typed, saved as typed and shown as not checked.
A live Flowbound with no sign-in set does not start, and neither does one on a public address with `door()`.

- **Who comes in.** People at an allowed domain sign in as Viewers (Owners keep several domains on Permissions → People; the first comes from `domain`). An Admin or Owner invites anyone at any address with a role (Member by default); no email is sent. An Admin can grant Viewer or Member.
  An Owner can also appoint Admins and Owners. Use `owners` to name the first Owner. With `groups`, the
  work login sets roles at sign-in. With just a short email list or team password, people are Admins.
  See the Changes guide for the roles and how old access maps to them.
- **Chat apps (Claude, ChatGPT)** take no token by hand. The person adds `<address>/mcp` as a custom connector;
  the app sends them to this Flowbound to sign in and tap Allow (the Agents page shows the address with Copy). From then on every call arrives as
  "Claude, for <the person>". Its token lasts an hour and renews by itself.
- **Coding agents and scripts** sign in the same way where they can, with `npx flowbound connect <address>` (sign-in in the browser), or a token a
  signed-in person makes with the `make-token` tool (shown once): `Authorization: Bearer fb_live_...` on `/api/<tool>` and `/mcp`.
  The token belongs to that person and shows their name on everything it does.
- **A chat acts for its person, up to Member.** It can save, run and publish workflows for a Member. When a run
  needs a yes, ask the person and pass on their own answer. Flowbound records who said yes and which app passed it on.
  Keys and access are managed on the page.
- **When someone leaves.** A browser session lasts a working day. For agents, Flowbound asks the company's login
  again once an hour whether their person is still there; when it says no, they stop. Remove on Permissions → People stops the person's browser, tokens and chat apps at once.
- **Who changed what** is in `npx flowbound history` (`--csv` writes a file): rights, people,
  keys (never the key itself), tokens and connected apps, every yes and stop. Each line has who, through what,
  before, after and when, and cannot be changed or deleted. Another plugin adds a line with
  `use("door").wrote(who, "what", "on what", before, after)`.

A tool of your own says the least a person needs with `role: "viewer" | "member" | "admin" | "owner"` (Member by default); `by: "people"` keeps it from agents altogether.

From the project folder, `--live` after a command asks the live Flowbound instead of this computer
(`npx flowbound import targets.csv --live`, `npx flowbound runs --live`). The person types a live token once on
the local Connections page.
