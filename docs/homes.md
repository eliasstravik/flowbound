# Other homes

`flowbound deploy` puts a project on Vercel. Any other home is set up by hand, with this guide. Nothing is kept
inside the runner: records, costs and the yes are in your database and keys are with Flowbound, so moving from one
home to another loses nothing.

## Start from the Deploy button

1. Open the [Deploy to Vercel button](../README.md#use-flowbound-from-a-phone). Sign in to Vercel, choose your GitHub account, and name the new project and repository.
2. Add Neon in the setup screen and choose its free plan for a first try. Keep the default variable names. Neon supplies `DATABASE_URL`.
3. In your password manager, generate two separate values. Set a random value of at least 32 characters as `FLOWBOUND_SECRET` to protect stored keys. Set a separate strong `FLOWBOUND_PASSWORD` that you can type when Flowbound asks you to sign in. Put both in Vercel’s form.
4. Tap **Deploy**. Open the production address Vercel shows you and sign in. Add provider keys on the **Keys** page only when you need them. The bundled sample workflow needs none.
5. In Claude on the web or desktop, open **Customize → Connectors → Add custom connector**. Name it Flowbound and use your production address followed by `/mcp`. Sign in on Flowbound’s page and tap **Allow**. Turn Flowbound on in the chat’s connector picker. Once configured, use the same connector from the phone app.

For Git-based updates, push to the GitHub repository Vercel created. For a project already running on your computer, use `npx flowbound deploy` from that project, or import its GitHub repository into Vercel with `npx flowbound deploy --build-only` as its build command. Connect Neon and configure sign-in for that project in Vercel.

The public demo uses its own Vercel project and database. It contains four made-up companies and a sample provider that makes no network calls. It allows 20 run requests and 400 tool requests per day, shared by all visitors, and resets its results at 02:00 UTC. It accepts no uploads or provider keys.

## Any server of your own (the Postgres world)

Proven with the test in `test/live/` of the flowbound repo. You need a server that stays up (the Postgres world
needs a long-lived worker, so it does not run on serverless hosts) and a Postgres database.

1. In `flowbound.config.ts`: `workflowSdk({ on: "postgres" })`.
2. On the server, in the project folder:
   ```
   npm install
   npm install @workflow/world-postgres
   DATABASE_URL=postgres://... npx --package=@workflow/world-postgres bootstrap     # the runner's own tables, schema "workflow"
   ```
3. Start it, with these in the environment:
   ```
   FLOWBOUND_LIVE=1                 # the shared, guarded way of running
   DATABASE_URL=postgres://...      # records, ledger and the runner
   FLOWBOUND_SECRET=<long random>   # unlocks the keys saved in the database; keep it on the host only
   FLOWBOUND_LOGIN_CLIENT_ID=...    # the two values from the company's login (Google, Microsoft, Okta), with the
   FLOWBOUND_LOGIN_CLIENT_SECRET=...#   door's line in flowbound.config.ts saying which: docs/sign-in.md
   # or, for a first try-out: FLOWBOUND_PASSWORD=<team password>  (one password for all; names are not checked)
   FLOWBOUND_URL=https://flowbound.example.com   # the address people and agents use
   FLOWBOUND_PORT=4111
   npx flowbound dev
   ```
   Flowbound listens on 127.0.0.1 only. Put your own HTTPS front (Caddy, nginx, a tunnel) before it and pass
   everything through.
4. Open the address, sign in, add keys on the keys page, give your colleagues rights on the People page, and
   connect each agent or chat app on the Connect page.

Flowbound's own access check is the only door: pages need a signed-in person the door lets in, `/api` and `/mcp`
need an agent that acts for one (Claude and ChatGPT get there by sending the person to sign in and allow
it, which needs the address in `FLOWBOUND_URL` to be the public https one), a webhook (`/hooks/<id>`) needs the
sender's signature and nothing else, and the runner's own address (`/.well-known/workflow/`) only answers the
runner. It does not start with no sign-in set. Under the team password, people's names are saved as typed and shown
as not checked.

## Schedules and webhooks in each home

One `schedule({ ... })` line works in every home; what differs is whose clock it is.

| Home | The clock | A webhook can be reached |
| --- | --- | --- |
| Your own computer | Flowbound's own: a Workflow SDK workflow that sleeps until the next time. It only ticks while Flowbound runs; a time missed by more than an hour is skipped. | Only from the same computer. |
| Vercel | Vercel's own schedules. `flowbound deploy` writes one for each line into the build (`schedules` in `.vercel/output/config.json`, with the line's timezone), each calling `/clock` with the project's `CRON_SECRET`, which `deploy` makes. Vercel's Hobby plan runs a schedule at most every 15 minutes. | Yes. |
| A server of your own | Flowbound's own clock, as on your computer, for as long as the server runs. | If the sender can reach the server's address. |

Any home can also be ticked from outside: with `CRON_SECRET` set (16 characters or more), a cron that calls
`POST /clock` with `Authorization: Bearer <CRON_SECRET>` starts whatever has come due, each time at most once.
Without that secret the address answers nobody.

Whatever the clock, a run a schedule or a webhook starts is under the person's permissions, like any run. The Vercel column is built
and checked by its tests (the build's output, the address's check) but has not been run on Vercel yet.

## Cloudflare: not proven yet

`workflowSdk({ on: "cloudflare" })` is not offered. The Workflow SDK lists a community-made world for Cloudflare
(`@fantasticfour/world-cloudflare`), but as of 24 Nov 2026 it is built for version 4 of the SDK's world interface
and Flowbound runs on version 5, so it cannot pass the acceptance run. It will be promised only once it does.

## Vercel, by git push

The normal Vercel way works too: connect the repo to the Vercel project, and every push builds it; every branch gets
its own preview address. What makes it so is one file in the project, which `flowbound deploy` writes the first time:

```json
{ "framework": null, "buildCommand": "npx flowbound deploy --build-only" }
```

The build command writes `.vercel/output` (pages, the runner's functions, one of Vercel's schedules per schedule
line), which is what Vercel puts live. Table changes are applied by Flowbound itself when it first starts, under a
lock. Checked on 26 Nov 2026 without deploying: Vercel's own builder (`vercel build`, version 67) built a project
this way and kept its schedule, and the built function started against a real Postgres. An older builder (version
60) dropped the schedules, so keep the Vercel command-line tool current where you run it yourself. What a company
still has to do, or know:

- The Flowbound package must be installable by Vercel's build. For a project set up with `npx flowbound init`,
  commit `package.json` and the lockfile so Vercel can install the same version from npm.
- Settings are environment values on the project: `DATABASE_URL` (the Neon integration sets it), `FLOWBOUND_SECRET`,
  `CRON_SECRET` if there is a schedule line, and the sign-in (`FLOWBOUND_LOGIN_CLIENT_ID` and
  `FLOWBOUND_LOGIN_CLIENT_SECRET`, or `FLOWBOUND_PASSWORD` for a try-out). Set `FLOWBOUND_URL` for Production only.
- A preview answers at its own branch address. The company's login only knows the production callback address, so
  give previews the team password (`FLOWBOUND_PASSWORD` for the Preview environment), and their own database (Neon
  makes a branch per preview when that is switched on in the integration): a preview that shares production's
  database applies its table changes to it, and sees its keys only if it shares `FLOWBOUND_SECRET` too.
- Vercel's schedules also tick on preview branches (its docs, read 26 Nov 2026). A preview with no `CRON_SECRET`
  answers nobody at `/clock`, so leave that value out of the Preview environment unless a preview should run its
  schedule lines, against its own database.
- A run that is going when a push goes live carries on with the code it started with: the Workflow SDK keeps a run
  on the deployment that started it.

Not done: none of this has been run on Vercel itself from a git push with a company's project; staging
(docs/staging.md) is built this way on every commit to main, with no schedule line.

## Vercel, by hand

What `flowbound deploy` does, if you would rather do it yourself:
`npx vercel link`, `npx vercel integration add neon`, set `FLOWBOUND_SECRET`, `CRON_SECRET` if the project has a
schedule line (and the two
`FLOWBOUND_LOGIN_CLIENT_*` values of the company's login, see docs/sign-in.md, or `FLOWBOUND_PASSWORD` for a try-out), then `npx flowbound deploy --build-only` and
`npx vercel deploy --prebuilt --prod`. Turn Vercel's own Deployment Protection off for the production address:
it cannot let token-only addresses (`/mcp`, `/api`) or a webhook's sender (`/hooks`) through, so Flowbound's door
does the guarding.
