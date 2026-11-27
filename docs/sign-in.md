# Sign-in

People sign in to a live Flowbound with the work account they already have, inside the app. Chat apps and agents
come in the same way, each as a named person. On your own computer nobody signs in and none of this applies.

## One setting: who vouches for people

It is the door's line in `flowbound.config.ts`. Everything else stays the same.

| Who | The line | What people do |
| --- | --- | --- |
| A laptop | `door()` | Nothing. Nobody signs in. It will not start live, or on a public address. |
| Five people | `door({ login: "google", emails: ["ann@x.com", "bo@x.com"] })` | Tap "Sign in with Google". Only the listed emails get in; all of them may do everything. |
| A company on Google Workspace | `door({ login: "google", domain: "acme.com", owners: ["ann@acme.com"] })` | Tap "Sign in with Google". Signing in proves you work there. A manager gives each person rights. |
| A company on Microsoft 365 | `door({ login: "microsoft", tenant: "<directory id>", owners: ["ann@acme.com"] })` | The same, with Microsoft. |
| A big company on Okta or Entra | `door({ login: "https://acme.okta.com", groups: { "flowbound-admins": "manage", sales: "approve", "*": "view" } })` | Click the app in Okta. IT decides who gets it; groups set each person's rights. |
| A first try-out | `FLOWBOUND_PASSWORD` on the host, alone or beside a login | Type your name and the team password. Names are shown as not checked. |

`microsoft` also takes `emails`. Any OpenID Connect provider works as the last line does (Sign in with Vercel
too: `login: "https://vercel.com"`); without `groups` it needs `owners`.

Two values go on the host, never in the file: `FLOWBOUND_LOGIN_CLIENT_ID` and `FLOWBOUND_LOGIN_CLIENT_SECRET`.
`FLOWBOUND_SECRET` must be set too (it already is for keys). The settings can also come from the host's
environment, so a deploy needs no file change: `FLOWBOUND_LOGIN` (`google`, `microsoft` or the provider's address),
`FLOWBOUND_LOGIN_DOMAIN`, `FLOWBOUND_LOGIN_TENANT`, `FLOWBOUND_LOGIN_EMAILS`, `FLOWBOUND_MANAGERS`,
`FLOWBOUND_LOGIN_GROUPS` (`group=rights,group=rights`).

## Rights

Signing in gives nothing by itself. Each person on the People page has one of:

| Rights | May |
| --- | --- |
| nothing yet | Sign in, and see who to ask. |
| Viewer | Read workflows, changes, runs, tables and lists. |
| Member | Also save, try, run and publish workflows and pass on a yes to spending. |
| Admin | Also manage keys, settings, and roles for Members and Viewers. |
| Owner | Also manage Admins and Owners, and remove the project through its host. |

The people in `owners` start as Owners. Add others on the People page, including before they first sign in.
With `groups`, roles come from the work login at sign-in. A chat acts for its person, up to Member.

## Try it with a real Google Workspace

About ten minutes, once, by someone who is an admin of the Workspace (or may create projects in its Google Cloud
organisation). Google asks for no payment and no review for an app that is for the company's own people only.

1. Open `https://console.cloud.google.com/auth/clients` signed in with your Workspace account. Pick or create a
   project **inside your organisation** (the project picker shows the organisation's name).
2. If it asks you to set the app up first ("Get started"): app name `Flowbound`, your email as support email,
   audience **Internal**, your email as contact, agree, create. *Internal* is the mark that keeps everyone outside
   your company out, at Google.
3. **Create client**. Application type **Web application**. Name `Flowbound`.
4. Under **Authorized redirect URIs**, add the Flowbound's address followed by `/door/callback`, for example
   `https://flowbound.yourcompany.com/door/callback`. For a try on your own machine:
   `http://localhost:4111/door/callback`.
5. **Create**. Copy the two values it shows: the **Client ID** and the **Client secret** (the secret is shown in
   full only now).
6. Put them on the host as `FLOWBOUND_LOGIN_CLIENT_ID` and `FLOWBOUND_LOGIN_CLIENT_SECRET`, and set the door's line:
   `door({ login: "google", domain: "yourcompany.com", owners: ["you@yourcompany.com"] })`.

To try it on your own machine first, with no deploy (Flowbound still needs a Postgres, see docs/homes.md):

```
FLOWBOUND_LIVE=1 FLOWBOUND_URL=http://localhost:4111 DATABASE_URL=postgres://... FLOWBOUND_SECRET=<long random> \
FLOWBOUND_LOGIN_CLIENT_ID=<the client id> FLOWBOUND_LOGIN_CLIENT_SECRET=<the client secret> npx flowbound dev
```

Open `http://localhost:4111`, tap "Sign in with Google". You are the Owner named in the settings; a colleague
who signs in shows up on the People page with nothing until you give them rights; an account outside your domain
is told it cannot come in. Google shows its "wants to access your Google Account" page at each sign-in: that is
what lets Flowbound ask Google later whether a person is still there.

Microsoft is the same shape: in Entra, App registrations, New registration, "Accounts in this organizational
directory only", redirect URI (Web) `<address>/door/callback`; then a client secret under Certificates & secrets.
The two values are the Application (client) ID and the secret's value; `tenant` is the Directory (tenant) ID.
Okta: an OIDC "Web Application" with sign-in redirect URI `<address>/door/callback` and a `groups` claim in the ID
token; `login` is the Okta address.

## When someone leaves

- They cannot sign in again: the company's login refuses them.
- A browser session lasts a working day (12 hours), then signing in is needed again.
- Agents and chat apps: once an hour Flowbound asks the company's login again whether their person is still
  there (it keeps a renewal for that, locked with the host's secret). When the login says no, they stop until the
  person signs in again. A chat app's own token lasts an hour and renews.
- A manager's "remove from Flowbound" on the People page (linked from Permissions) works at once: browser, tokens and
  chat apps, so their agent can no longer pass on a yes either.
- Not built: instant removal pushed by the company's directory (SCIM). Add it when a customer asks.

## What a deploy needs

Nothing here was deployed. To put it on a live Flowbound (Vercel or any server):

1. The door's line (or `FLOWBOUND_LOGIN...` in the environment) and the two values, as above. The redirect address
   in the login's console must be the live address plus `/door/callback`.
2. `npx flowbound deploy` (or restart the server). The door's new tables are made at start.
3. Chat apps connected before this version must be added again once: remove the connector in Claude or ChatGPT and
   add `<address>/mcp` again. Tokens made on the old Connect page belong to nobody and stop working; make new ones.
4. The staging site still runs on its team password and keeps working as it is until it is deployed again. After
   that deploy the sign-in page also asks for a name.

## What it is built on

The sign-in engine is [Better Auth](https://better-auth.com) (MIT, no account anywhere), inside the door plugin:
`src/plugins/door/engine.ts`. It does the company login (OpenID Connect), sessions and the sign-in chat apps use.
The door keeps what is Flowbound's own: who may come in, rights, tokens, history. After upgrading `better-auth`,
run `node scripts/door-tables.ts`; if it prints SQL, add it as a new entry in `src/plugins/door/engine-tables.ts`
(a test fails until you do). Why this engine, and what the test of it showed: docs/decisions.md.
