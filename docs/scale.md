# How big a list

Flowbound was run over a list of 10,000 companies on 26 Nov 2026, to see that it holds and to fix what the run
showed. Nothing was spent: the provider and the model are fakes on the same machine (`test/scale/provider.ts`), no
paid service was called and nothing was deployed. This page has the numbers, how the work is cut up, what the
Workflow SDK allows, and what a million rows would need.

## Run it again

```
npm run build
npm run test:scale                 # 10,000 rows, the database in the folder (PGlite), as on a laptop
DB=postgres npm run test:scale     # a real Postgres in Docker and the Postgres world, as on a server of your own
ROWS=500 SPEED=0.2 KILLS=0.5 npm run test:scale     # a quick look
```

It is not part of `npm run check`: it takes many minutes. Run one at a time; it holds about 1 GB and the database's
container up to 1 GB more. The numbers go to `.flowbound/scale-<db>-<rows>.json`.

The workflow has four steps for each company: find a person, find their email, a model writes an opening line, a
score is worked out. The fake provider answers like a real one: most answers in 0.1 to 1 second, 2 in 100 take 3 to
6 seconds, 1.5 in 100 companies always fail, 4 in 100 fail once and work the second time, 1 in 100 is refused, 8 in
100 have nobody to find, 2 in 100 model answers are refusals, and it refuses calls that come in much faster than
its card's speed limit of 40 a second.
It keeps its own bill, which the test holds against the ledger. On the way the test stops a run at a small cap,
kills Flowbound three times (at 20, 50 and 80 in 100) and starts it again, adds 500 rows while the run is going,
and runs the whole list a second time.

## The numbers

Three full runs of the same test, on one machine (16 cores, 31 GB, shared with other work). Before is `main` as it was;
after is this change. Every number is read from the file the run wrote.

| | Before, laptop database | After, laptop database | After, real Postgres |
| --- | --- | --- | --- |
| The full run, killed 3 times on the way | 17.4 min | 10.9 min | 10.9 min |
| Rows a second while it was up | 9.3 | 15.2 | 15.1 |
| Of 10,500 rows: with a result, failed, left undone | 9,544, 456, 500 | 10,010, 490, 0 | 10,010, 490, 0 |
| Calls at once, most | 35 | 25 | 25 |
| Data calls in one second, most (the card says 40) | 46 | 41 | 41 |
| Memory, most | 3.5 GB | 1.2 GB | 1.0 GB, and 0.8 GB for the database |
| Database size | 112 MB | 130 MB | 46 MB |
| The runner's own history | 617 MB: 10,381 runs, 251,225 events | 442 MB: 605 runs, 114,691 events | 124 MB: 606 runs, 114,726 events |
| Most events in one runner run | 2,462 | 905 | 907 |
| A $3 cap | spent $2.9975 of $3.0000 | spent $2.9994 of $3.0000 | spent $2.9973 of $3.0000 |
| The provider's own bill | $53.8569 for 26,831 calls | $56.5469 for 28,174 calls | $56.5249 for 28,166 calls |
| The ledger's total | $53.7925 for 26,795 calls | $56.4383 for 28,112 calls | $56.4383 for 28,112 calls |
| Difference: calls in the air at the 3 kills | $0.0644, 36 calls | $0.1086, 62 calls | $0.0866, 54 calls |
| Recorded and bought twice | 0 | 0 | 0 |
| The 500 rows that arrived | never done: the next run kept pausing | done by the next run | done by the next run |
| A second run over the same list | $1.00, 16.8 min (it was buying those 500 rows) | $0.00, 3.6 min | $0.00, 6.2 min |
| The run page's answer | 76 ms | 45 ms | 30 ms |
| The runs list's answer | 122 ms | 88 ms | 37 ms |
| The table page's answer, 100 rows | 15 ms | 15 ms | 9 ms |
| An agent asks for 10,000 rows of the table | 7.3 MB | 383 KB | 383 KB |
| An agent asks for the export | 3.0 MB | 1 KB | 1 KB |

The database's size on a laptop includes about 40 MB that an empty one already takes. Most of the rest is the memory
of paid facts: about 4 KB a row in all. The second run is slower against Postgres (28 rows a second, 49 on the
laptop database): with every answer in memory nothing waits on a provider, and what is left is the runner writing
its own history to the database.

## What the run showed, and what was changed

| What the run showed | What was changed |
| --- | --- |
| One small workflow run for every row: 10,381 runs and 251,225 events in the runner's history, 9.3 rows a second and slowing as the list went on, because taking the next row looked through every row already taken. | Rows go 25 at a time, and a run remembers how far down the list it is: 605 runs, 114,691 events, and a steady 18 rows a second between the kills (15.2 over the whole run; two calls a row against a limit of 40 a second allow 20). |
| 3.5 GB of memory. Not a leak: Node tidies up late when the machine has room, and every small run left a lot to tidy. | Fewer, bigger runs, and a ceiling of 768 MB on the server's own memory (`FLOWBOUND_HEAP_MB`): 1.2 GB at the most, at the same speed. |
| A new run paused at once on the rows that had failed in the run before, every time. So the 500 rows that arrived were never reached, and the "second run" was still buying them when its cap stopped it. | A row that failed before and fails again is not news: it does not count towards the pause. |
| A kill in the instant between "these rows are taken" and the runner writing that down would leave those rows taken with nobody doing them. Found by reading; the window is a few milliseconds. | Taking a batch is safe to repeat: asked twice under the same name, the same rows come back (`test/last-moment.test.ts`). |
| The driver's own history reached 2,462 events in one run; the Workflow SDK replays slower past 2,000. | It hands over to a fresh run of itself after 100 batches: 905 events at the most. |
| An agent that asked for the whole table got 7.3 MB into the chat, and 3.0 MB for the export. | The table tool answers at most 500 rows at a time, and an agent's export of a big table gets the page where the person downloads it. People's Download CSV is unchanged. |
| SQL that compares a results field the plain way fails in Postgres's own words. | The answer says how to write it. |
| The big test could not start against a real Postgres. | It runs both ways. |
| On Vercel, a branch's preview would have called itself by the production address. | A preview uses its own address. |

What a kill costs: the calls that were in the air. The provider did the work and charged, the answer never arrived,
and the call is made again when the run is picked up: at most one call for each row in flight, here about 20 calls
and 4 cents a kill. Everything that was recorded is never paid for twice. On a server (not on your own computer),
the money set aside for those calls stays set aside for 15 minutes before it is given back to the cap: after the
Postgres run, 12 cents for 67 calls were still held on the run's cap, with its spent total right.

## How the work is cut up

A run is a few lanes (`concurrency`, 5 unless the workflow file says otherwise; the test used 25). A lane takes the
next 25 rows not done yet in one statement and starts one small workflow run for them, the batch. The batch calls
the workflow's function for each row, one after the other, and saves each answer as its own step. So a row that is
done stays done whatever happens to the rest of its batch, and a batch that is killed carries on at the row it was
on. After 100 batches the driver hands over to a fresh run of itself.

Why 25: measured on 1,000 rows with the fake's waits cut to a tenth, so that the runner is what is slow.

| Rows in a batch | Rows a second | Memory, most |
| --- | --- | --- |
| 1 | 10.5 | 3.3 GB |
| 5 | 27.7 | 3.0 GB |
| 25 | 32.6 | 1.6 GB |
| 40 (asked for 100; a short list is shared out between the lanes) | 31.6 | 1.3 GB |

(Before the memory ceiling; with a small one, batches of 25 did 29 rows a second in 1.1 GB.) Bigger batches buy no
more speed, make the history of one batch longer, and a batch whose own run breaks takes all its unfinished rows
with it.

## What the Workflow SDK allows

Read on 26 Nov 2026 from Vercel's "Workflow Pricing and Limits" page (last changed 16 Sep 2026) and the docs that
ship with the `workflow` package (5.8).

| Limit (Vercel's hosted runner) | Allowed | One batch of 25 rows | One driver run |
| --- | --- | --- | --- |
| Events in one run | 25,000; replay slows past 2,000 | about 380 | about 1,000 |
| Steps in one run | 10,000 | 126 | about 330 |
| Size of one input or output | 50 MB | 25 list rows, a few KB | a list of 25 row numbers |
| Everything one run stores | 2 GB | under 1 MB | under 1 MB |
| Events a second in one run | 200 | about 15 | about 10 |
| How long a run may last | no limit | about half a minute | a few minutes at 25 lanes |
| New runs a second | 1,000 | | under 1 |

So 10,000 rows are 400 batches and 4 driver runs, and 1,000,000 rows are 40,000 batches and 400 driver runs: no
single run grows with the list, and both fit. Measured here: the biggest run of any kind had 905 events.

Vercel's free plan includes 50,000 workflow events a month, which is about 3,200 rows of a four-step workflow. A
10,000-row run needs the Pro plan, where events are billed as used.

## A million rows

Arithmetic from the measured run and Vercel's prices on 26 Nov 2026, not a test.

Locally the runner wrote 10.5 events for a row (5 steps: the workflow's four and saving the answer). Vercel also
counts each step's creation, which makes about 15.6.

| On Vercel | 10,000 rows | 1,000,000 rows |
| --- | --- | --- |
| Workflow events, $0.02 per 1,000 | 156,000: $3.11 | 15.6 million: $311 |
| Workflow data written, $0.50 per GB | 0.4 GB: $0.20 | 39 GB: $20 |
| The same, kept 7 days (Pro), $0.50 per GB a month | $0.05 | $5 |
| Functions and queue | about $0.02 | about $3 |
| Neon: storage for a month, and the run's hours | 0.04 GB: about $0.03 | 4 GB: about $3 |
| Together, about | $3.42 | $342 |
| Time, 25 rows at a time | 9 minutes | 15 hours |

- Next to that is what the providers themselves charge: this fake's prices came to $56 for 10,000 rows, so about
  $5,600 for a million. The runner is a few cents on the dollar.
- The time is Vercel's own published figure of about 0.1 second between steps, plus the providers' answers. A speed
  limit of 40 calls a second on a card caps it near 20 rows a second whatever the runner does: for a million rows
  in less than 14 hours, raise the card's limit and `concurrency` together.
- The data written is this run's own history file on a laptop (41 KB a row) as a stand-in, which errs high: in
  Postgres the same history took 11 KB a row. Vercel measures its own.
- Functions: about 50 ms of processor time a row at $0.128 an hour, two instances of 2 GB at $0.0106 a GB-hour, and
  about 12 queue operations a batch at $0.60 a million.

What a million would need that 10,000 does not:

- **The run page's totals.** It counts the run's rows and calls each time it is opened: 45 ms for 10,000 rows, so
  seconds for a million. It needs running totals kept as the run goes.
- **Lists and downloads in parts.** Vercel takes and gives at most 4.5 MB in one request. This list's CSV is 0.5 MB
  to upload and its results 1.6 MB to download, so a download stops working near 28,000 rows and an upload near
  85,000. Bigger ones need to go in parts (`import --add` already adds to a list).
- **Tidying the runner's history.** It grows by about 41 KB a row and nothing removes it: 442 MB after this run,
  about 40 GB for a million on a laptop. The Workflow SDK can drop a finished run's data (`deleteRuns`, or
  `experimental_retention: 0` when a batch is started); the Postgres world has `workflow-postgres-prune`.
- **Results with a type**, below.
- **The memory of paid facts** is the biggest table (19 MB for 28,000 answers): every answer is kept whole. At a
  million rows that is about 2 GB, which is the point of it, and worth a look at what is kept.

## Results in SQL

A results table has one real column for each field the workflow returns, so SQL can sort, filter, count and join
on them. The values are stored as JSON (`jsonb`), with the paid fact's id in a `<field>__fact` column beside each.

| On 10,000 rows | |
| --- | --- |
| `order by score desc limit 3` | 9 ms |
| `where score::int > 70` | 6 ms |
| `where title #>> '{}' = 'VP Sales'` | 4 ms |
| join with the list, grouped by industry | 13 ms |
| `where score > 70` | fails ("operator does not exist: jsonb > integer"), and the answer now says how to write it |
| `where title = 'VP Sales'` | fails, and the answer now says how to write it |

Giving each column a type of its own (text, number, yes or no) is the right end state. It needs a design for tables
that exist already and for a field that changes type between runs, so it is a task of its own.

## Pages and agents with 10,000 rows

Measured in a browser at a phone's width (390 by 844) on the finished run, and by the test from the same machine.

| | Answer | What comes back |
| --- | --- | --- |
| The runs list (5 runs) | 0.2 s | 3 KB |
| One run of 10,000 rows, with its first 200 failed rows | 0.09 s | 23 KB |
| The results table: 100 rows, then "Show more" | 0.014 s | 25 KB |
| Download CSV, 10,010 rows | 0.24 s | 1.6 MB |

No page reads the whole table: the table page takes 100 rows at a time and the run page counts in the database.

What an agent got, on the same data (measured before the reshape, when the MCP tools were search, run and show;
`execute` now returns only what the code keeps): `search` answered 5 KB, one
run 53 KB (its first 200 failed rows with why), the table as asked 76 KB (its first 100 rows), the table "with a
limit of 10,000" 383 KB (500 rows: it was 7.3 MB), `select * from leads` 319 KB (SQL answers at most 500 rows),
and the export 1 KB (where to get the file: it was 3.0 MB).

## Not done here

- Nothing was run on Vercel or on Neon. The Vercel figures are arithmetic from its docs and this run's counts. The
  check that would settle them: the same test against a preview, with the fake provider deployed beside it; 10,000
  rows would cost about $3.50 of Vercel usage on a Pro plan and nothing to any provider.
- The real Postgres was on the same machine, so there was no network between Flowbound and its database, and no
  pooled connection address as Neon gives.
- One copy of Flowbound. Taking rows is one statement that locks the run's own row, so two copies cannot take the
  same rows, but two copies were not run side by side here.
- A million rows were not run.

The next tasks this leaves: results with a type of their own; running totals for the run page; uploads and downloads
in parts; tidying the runner's history; and putting the package on npm, which a git-push build on Vercel needs
(docs/homes.md).
