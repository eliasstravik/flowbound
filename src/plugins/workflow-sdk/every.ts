// When a schedule comes due. The line: schedule({ id, workflow, every: "monday 08:00", timezone: "Europe/Stockholm" })
// Forms: "<day> HH:MM" where day is a weekday name, "day" or "weekday"; "hour"; "<n> hours"; "<n> minutes".
// Times are in the line's timezone; without one, the clock of the machine Flowbound runs on (UTC when live).
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const FORMS = '"monday 08:00", "day 08:00", "weekday 08:00", "hour", "2 hours" or "15 minutes"'

type Parsed = { span: number } | { days: number[]; hour: number; minute: number }

function parse(every: string): Parsed {
  const text = String(every).trim().toLowerCase()
  const span = /^(?:(\d+)\s+)?(minute|hour)s?$/.exec(text)
  if (span && Number(span[1] ?? 1) > 0) return { span: Number(span[1] ?? 1) * (span[2] === "hour" ? 3600_000 : 60_000) }
  const at = /^([a-z]+)\s+(\d{1,2}):(\d{2})$/.exec(text)
  const days =
    at && (at[1] === "day" || at[1] === "daily" ? [0, 1, 2, 3, 4, 5, 6] : at[1] === "weekday" ? [1, 2, 3, 4, 5] : DAYS.map((d, i) => (d.startsWith(at[1]!) && at[1]!.length >= 3 ? i : -1)).filter((i) => i >= 0))
  if (!at || !days?.length || Number(at[2]) > 23 || Number(at[3]) > 59) throw new Error(`every: "${every}" is not a schedule Flowbound knows. Use ${FORMS}.`)
  return { days, hour: Number(at[2]), minute: Number(at[3]) }
}

/** The machine's own timezone: what a line without `timezone` means. */
export const here = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

/** A moment as the wall clock of a timezone shows it. */
function wall(at: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: DAYS.findIndex((d) => d.startsWith(String(parts.weekday).toLowerCase())),
  }
}
/** The moment a timezone's wall clock shows this date and time. */
function instant(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const want = Date.UTC(year, month - 1, day, hour, minute)
  let guess = want
  // Twice: the first guess can land on the other side of a clock change.
  for (let n = 0; n < 2; n++) {
    const w = wall(new Date(guess), timezone)
    guess -= Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - want
  }
  return new Date(guess)
}

/** The first time after `after` that a schedule comes due. Throws on a form Flowbound does not know, or a timezone the machine does not. */
export function nextAfter(every: string, after: Date, timezone?: string): Date {
  const p = parse(every)
  if ("span" in p) return new Date((Math.floor(after.getTime() / p.span) + 1) * p.span)
  const zone = timezone ?? here()
  const from = wall(after, zone)
  for (let add = 0; add < 9; add++) {
    // Noon keeps the date sums clear of any clock change.
    const date = new Date(Date.UTC(from.year, from.month - 1, from.day + add, 12))
    const due = instant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), p.hour, p.minute, zone)
    if (due > after && p.days.includes(wall(due, zone).weekday)) return due
  }
  throw new Error(`every: "${every}" never comes due.`)
}

/** The same schedule as a cron line, for a host that has its own clock (Vercel). A span cron cannot say exactly gets the next finer one: the tick itself decides what is due. */
export function toCron(every: string): string {
  const p = parse(every)
  if ("span" in p) {
    const minutes = p.span / 60_000
    if (minutes < 60) return 60 % minutes === 0 && minutes > 1 ? `*/${minutes} * * * *` : "* * * * *"
    const hours = minutes / 60
    return hours === 1 || 24 % hours !== 0 ? "0 * * * *" : `0 */${hours} * * *`
  }
  const dow = p.days.length === 7 ? "*" : p.days.join(",")
  return `${p.minute} ${p.hour} * * ${dow}`
}

/** How people read it: "every monday 08:00 (Europe/Stockholm)". */
export const when = (every: string, timezone?: string) => `every ${String(every).trim().toLowerCase()}${"span" in parse(every) ? "" : ` (${timezone ?? `${here()}, this machine's clock`})`}`

/** When a schedule starts, as people read it: "Every Monday 08:00 (Stockholm)", "Every weekday 07:30", "Every 2 hours". */
export const starts = (every: string, timezone?: string) => {
  const text = String(every).trim().toLowerCase()
  const p = parse(every)
  if ("span" in p) return `Every ${text.replace(/^1\s+/, "")}`
  const [day, time] = text.split(/\s+/)
  const days = day === "day" || day === "daily" ? "day" : day === "weekday" ? "weekday" : DAYS.find((d) => d.startsWith(day!))!.replace(/^./, (c) => c.toUpperCase())
  const [h, m] = time!.split(":")
  const place = timezone ? ` (${timezone.split("/").pop()!.replace(/_/g, " ")})` : ""
  return `Every ${days} ${h!.padStart(2, "0")}:${m}${place}`
}
