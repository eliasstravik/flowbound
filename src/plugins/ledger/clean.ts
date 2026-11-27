// Kept facts, by exact inputs: a paid answer is filed under its provider, its endpoint and its exact inputs,
// cleaned up first, so the same question asked in a different case or with a different web address prefix finds it.
// No guessing who is who: "Acme Inc" and acme.com stay two different questions. Matching them is the agent's job.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URLISH = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$/i

/** One input value, cleaned: an email in lower case, a web address without its scheme, "www." or trailing slash, spaces trimmed. */
export function cleanValue(v: string): string {
  const s = v.trim().replace(/\s+/g, " ")
  if (EMAIL.test(s)) return s.toLowerCase()
  if (URLISH.test(s) && !s.includes(" ")) {
    const bare = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "")
    const cut = bare.search(/[/?#]/)
    const host = (cut < 0 ? bare : bare.slice(0, cut)).toLowerCase()
    // The host is case-blind; a path is lower-cased too when it is a profile address (people type them every way).
    const rest =
      cut < 0
        ? ""
        : bare
            .slice(cut)
            .replace(/[?#].*$/, "")
            .replace(/\/+$/, "")
    return host + (/linkedin\.com$/.test(host) ? rest.toLowerCase() : rest)
  }
  return s
}

/** A request's inputs, cleaned all the way down. Keys keep their names; only values change. */
export function clean(v: unknown): unknown {
  if (typeof v === "string") return cleanValue(v)
  if (Array.isArray(v)) return v.map(clean)
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]))
  return v
}

/** Every text value in a request's inputs, cleaned: what one lookup across providers searches. */
export function inputsOf(v: unknown, out = new Set<string>()): string[] {
  if (typeof v === "string") {
    const c = cleanValue(v)
    if (c.length >= 3 && c.length <= 300) out.add(c)
  } else if (Array.isArray(v)) for (const x of v) inputsOf(x, out)
  else if (v && typeof v === "object") for (const x of Object.values(v)) inputsOf(x, out)
  return [...out]
}

/** Whole days since a moment. */
export const daysSince = (at: Date | string, now = Date.now()) => Math.max(0, Math.floor((now - new Date(at).getTime()) / 86_400_000))
/** "12 days", "1 day", "2 years": how old something is, in words (0 days is "today" where it is said). */
export function age(at: Date | string, now = Date.now()): string {
  const days = daysSince(at, now)
  if (days === 1) return "1 day"
  if (days < 730) return `${days} days`
  return `${Math.floor(days / 365)} years`
}
