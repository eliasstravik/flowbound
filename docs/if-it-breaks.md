# If it breaks

Where your data lives, and how to back it up and put it back. Every command here was run on a throwaway project
before it was written down (26 Nov 2026): the backup made, the data deleted, the backup put back, and the tables, runs
and keys checked again.

Your workflows, `flowbound.config.ts` and your own plugins are ordinary files in your project. Keep them in git like
any code. What git does not hold is below.

## On your own computer

Two places, both outside git:

| What | Where |
| --- | --- |
| The database (your lists and results, runs, the ledger of what was paid, every yes) and the runner's own files | `.flowbound/` in your project folder. It is hidden and in `.gitignore`. |
| Your keys | `~/.flowbound/<folder name>-<a short code>/keys.json`, outside the project, readable by you only. `FLOWBOUND_HOME` moves `~/.flowbound`. |

### Back up

Stop Flowbound first, so the database is not written to while it is copied: press Ctrl+C where `npx flowbound dev`
runs, or, if it was started for you in the background, `kill $(cat .flowbound/dev.pid)`. Then, in the project folder:

```
tar czf ../acme-data.tgz --exclude=".flowbound/*.tgz" .flowbound
ls -d ~/.flowbound/acme-*                                   # your project's keys folder
tar czf ../acme-keys.tgz -C ~/.flowbound $(basename ~/.flowbound/acme-*)
```

(`acme` is your project folder's name.) Keep both files somewhere safe. The keys file holds your keys as they are:
treat it like a password.

### Put it back

Stop Flowbound, then in the project folder:

```
rm -rf .flowbound && tar xzf ../acme-data.tgz
tar xzf ../acme-keys.tgz -C ~/.flowbound
npx flowbound tables                                        # starts Flowbound again; your tables are back
```

Put it back in the same folder it came from: the keys folder's short code is made from the project's place on the
computer. In a project that moved, start Flowbound once, then copy `keys.json` from the backup into the new
`~/.flowbound/<folder name>-*` folder, or type the keys again on the keys page.

### When Flowbound will not start

- `npx flowbound doctor` says what needs you, each with the one thing to do.
- What the server said last is in `.flowbound/dev.log`.
- A database that will not open: stop Flowbound, move `.flowbound` aside (`mv .flowbound .flowbound-broken`) and run
  any `npx flowbound` command. It starts empty; put a backup back as above. Keep the broken copy until you are sure.
- An old Node.js: every command says which version it needs and how to get it.

## Live

Everything is in the one Postgres database (Neon, when `npx flowbound deploy` set it up): your tables, runs, the
ledger, the yeses, the people who may come in, and the keys, locked with `FLOWBOUND_SECRET`. The workflow runner's
own history is on the host (Vercel's, or the runner's tables on a server of your own); a run's results are in the
database either way.

Two things to keep safe:

- **The database**, with the backup below.
- **`FLOWBOUND_SECRET`.** The saved keys cannot be unlocked without it. Copy it from the host's settings into your
  password manager once. Lose it and the data is fine, but every key has to be typed again.

### Back up

You need `pg_dump` from PostgreSQL 17 or newer (on a Mac: `brew install postgresql@17`). The database's address is in
the host's settings; on Vercel, `npx vercel env pull .env.backup --environment production` writes it to a file, as
`DATABASE_URL_UNPOOLED`. That file holds secrets: delete it when you are done.

```
pg_dump "$DATABASE_URL_UNPOOLED" --format=custom --no-owner --file=flowbound-live.dump
```

Neon also keeps a short history of its own you can go back in: its console's Restore page.

### Put it back

Stop the work going on first (stop the runs that are going, `npx flowbound stop <run>`, and take the schedule and
webhook lines out of flowbound.config.ts for now), then:

```
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL_UNPOOLED" flowbound-live.dump
```

It replaces what is in the database with the backup. Then open the live pages and check your tables and runs; with
the same `FLOWBOUND_SECRET` the keys work as before.

Tried against a Postgres 17 on this computer standing in for Neon: tables, the run and its results came back. Not
tried against Neon itself.
