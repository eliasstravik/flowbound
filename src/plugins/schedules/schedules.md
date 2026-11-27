## Running without you: schedules and webhook rows

Two ways a workflow runs with nobody there, each one line in `schedules` in `flowbound.config.ts`:

```ts
import { blitzapi, hook, schedule } from "flowbound"

export default {
  providers: [blitzapi()],
  permissions: { mode: "auto", caps: { perRun: 2, perMonth: 10 } },
  schedules: [
    schedule({ id: "weekly-heads", workflow: "find-sales-heads", every: "monday 08:00", timezone: "Europe/Stockholm" }),
    hook({ id: "new-leads", workflow: "enrich-lead", key: "email" }),
  ],
}
```

- **A schedule** runs the workflow on the rows of its list that have no result yet. `every` is `"monday 08:00"`,
  `"day 08:00"`, `"weekday 08:00"`, `"hour"`, `"2 hours"` or `"15 minutes"`. `timezone` is the person's own (ask
  them if you do not know it); without it, times are the clock of the machine Flowbound runs on, UTC when live.
- **A webhook** makes the address `/hooks/<id>`. Each signed delivery adds its new rows to the workflow's list and
  runs them. `key` is the column that says two deliveries are the same row; without it the whole row is compared.

A run they start is a run like any other, **under the person's permissions**: in auto it spends inside the caps, in
ask it waits for the person's yes under Needs you, in skip it just runs. While a yes waits for a workflow (asked
first, or paused at a cap), its schedule skips: one question at a time. To keep what runs by itself small, give it a
rule of its own: `permissions: { workflows: { "find-sales-heads": { perRun: 2, perMonth: 10 } } }` (the strictest
rule wins). Caps never go in a workflow file.

### A schedule, from a plain request

"Run find-sales-heads every Monday morning, at most $2 a run and $10 a month."

1. The workflow must exist and have had its try-out (`npx flowbound run <id> --try 10`).
2. Add the `schedule({ ... })` line to `schedules`, and the person's caps as a rule for that workflow. Flowbound
   restarts by itself. Show the person the lines you wrote.
3. Check: `npx flowbound schedules weekly-heads` shows when it next comes due. To run it now, under the same
   permissions: `npx flowbound schedule-run weekly-heads`.

When nothing is left to do, a scheduled run does nothing and says so. So a schedule earns its keep on a list that
grows: by webhook, by the person adding a CSV (`import --add`), or by you adding rows. Rows that failed last time
are tried again each time; a failed call costs nothing.

### Rows by webhook, from a plain request

"When a new lead comes in from my form, find the head of sales."

1. Write the workflow: it reads the list the rows will land in (`export const from = "leads"`) and handles one row.
   Give it two or three sample rows so it can have its try-out: `npx flowbound import sample.csv --as leads`.
2. Add the `hook({ ... })` line. `npx flowbound schedules new-leads` shows its address and that no signing secret is
   saved yet.
3. **The signing secret** is typed by the person on the Keys page, like any key ("New leads webhook: signing
   secret"). It is the secret the sender signs with: the one the sender shows them, or a long random one they make
   up and give the sender too. Never ask for it in the chat and never put it in a command or a file.
4. Tell them how the sender must sign. Each delivery is a `POST` to the address with a JSON object (or a list of up
   to 100) as its body, and the header `x-flowbound-signature` holding the HMAC-SHA256 of the exact body with the
   signing secret, as hex (a leading `sha256=` is fine). For a sender with its own header or base64:
   `hook({ ..., signature: { header: "x-hub-signature-256", prefix: "sha256=", encoding: "hex" } })`.
   A way to try it from a shell, with the secret in a variable the person set themselves:
   `body='{"email":"a@b.example"}'; curl -X POST <address> -H "x-flowbound-signature: $(printf %s "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/.* //')" -d "$body"`
5. A sender with a shape of its own (a booking tool, a CRM: the person nested inside, and more kinds of event than
   you want) gets a `row` function on the line: what the sender posts in, a row out, and nothing for an event that
   is not a row. `hook({ id: "bookings", workflow: "enrich-lead", key: "email", row: (event) => (event.type ===
   "booking.created" ? { email: event.payload.attendee.email } : null) })`. It only ever runs on a signed delivery;
   an ignored event is answered 200 so the sender does not send it again; one it cannot read is answered 422.

What happens to a delivery: the signature is checked first, over the raw bytes, before anything is read; a missing or
wrong one is refused with 401 and nothing is taken in. Each row that is new is added to the list; a row already
taken in is not added again. Then one run starts under the permissions; rows that arrive while it is going are taken
by the same run. A lead whose facts were bought before costs nothing again.

### Stopping

`npx flowbound stop <run>` stops a run at once; anyone may. To stop a schedule or webhook for good, remove its line.

### Where it works

| | On the person's own computer | Live on Vercel (`npx flowbound deploy`) | A server of your own |
| --- | --- | --- | --- |
| A schedule fires | Only while Flowbound is running (`npx flowbound dev`, or any command started it). A time missed by more than an hour is skipped. | Vercel's own schedules are the clock: `deploy` writes one for each line. On Vercel's Hobby plan a schedule can run at most every 15 minutes. | Flowbound's own clock, whenever the server runs. |
| A webhook can be reached | Only from the same computer: the address is `localhost`. A sender on the internet cannot reach it. | Yes. | If the server's address can be reached by the sender. |
| Who passes on a yes | You, the agent, with the person's own words. | The person's agent, signed in as them, if they may approve. | The same as live. |

When a home cannot do it, say so plainly and offer what does work: on the person's own computer, running it by hand
(`npx flowbound schedule-run <name>`), or going live.
