## Records

The person's data lives in their own Postgres database: PGlite in `.flowbound/pg` on their computer, a database
address (`DATABASE_URL`) when live. You make whatever tables a job needs.

- `npx flowbound import <file.csv>`: make a **list** table from a CSV (first line: column names). `targets.csv`
  becomes `target_list`; `--as <name>` picks the name; `--add` adds rows to a list that is already there. Every
  row gets an `id`; the columns are text.
  `--add --key email` is for a list the person brings again (a fresh export): a row whose key is already there is
  brought up to date (an empty cell never wipes what the list has) and only new rows are added. Keys are compared
  without capitals and outer spaces. A row that already has a result keeps it.
- `await use("records").add("people_list", rows, { key: "linkedin_url" })`: the same from a step, for one row in
  and many rows out. See `npx flowbound docs recipes`.
- `npx flowbound tables`: every table, its rows and where it came from.
- `npx flowbound table <name>`: read rows, 100 at a time (`--limit`, at most 500, and `--offset`). A **results**
  table (a workflow's `into`) is shown beside its list's own columns, on the same row, with the id of the kept fact
  behind each answer and a line saying where it came from, how old it is and what it cost. The person uploads a
  list as CSV on the Tables tab too. For a big table, count and filter with `sql` rather than reading every row.
- `npx flowbound export <table> --csv`: write `<table>.csv` (results come with the list's columns). Over MCP a big
  table is not sent into the chat: you get the page where the person downloads it. The file is made for a
  spreadsheet: a cell that would run there as a formula (it starts with `=`, `+`, `-` or `@`) gets a `'` in front.
  Numbers and phone numbers are left as they are. To read exact cells, use `table` or `sql`.
- `npx flowbound sql "<one statement>"`: any SQL: make a table, read across tables, fix a value.

A results table has the list row's `id`, one `jsonb` column per returned field and a `<field>__fact` column beside
it. A row is done when the results table holds its id, so deleting a row there makes the next run do it again
(with the workflow file as it is then; calls already paid for and still fresh are answered from memory).
To compare a result field in SQL, take it out as text first: `where head_name #>> '{}' = 'Dana Reyes'`; a number
as a number: `where (score)::numeric > 70`. `order by score desc` works as it is.
Flowbound's own tables live in schemas named `fb_<plugin>`; leave those alone. An agent's token reads with SQL as a
reader that sees only the tables in `public`: Flowbound's own tables are refused (`permission denied`).
