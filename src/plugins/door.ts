// The door: who gets in, when live. It has one setting: who vouches for people.
//   door()                                                        nobody signs in: your own computer
//   door({ login: "google", emails: ["a@x.com", "b@x.com"] })     a small team, by a short list of emails
//   door({ login: "google", domain: "acme.com", managers: [..] }) the company's own Google: signing in proves you work there
//   door({ login: "microsoft", tenant: "<id>", managers: [..] })  the company's own Microsoft
//   door({ login: "https://acme.okta.com", groups: { .. } })      any OpenID Connect provider (Okta, Entra): groups set rights
// Signing in gives nothing by itself: the door keeps its own list of people, and a manager (or a group) gives each one
// rights. Agents and chat apps come in the same way, each as a named person. The engine that does the signing in is
// Better Auth (door/engine.ts). On your own computer it lets everyone on the machine in, and passes `--live` calls on.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { type Attention, can, type Flowbound, plugin, projectRole, ROLES, type Role, type Who } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import type { Claims, Engine, Login, Signed } from "./door/engine.ts"
import { ENGINE_TABLES } from "./door/engine-tables.ts"
import { asset, day, sha } from "./util.ts"

export type DoorOptions = {
  /** Who vouches for people: "google", "microsoft", or the address of any OpenID Connect provider. Not set: nobody signs in. */
  login?: "google" | "microsoft" | (string & {})
  /** Google: the company's domain, or several. Signing in then proves the person works there. */
  domain?: string | string[]
  /** Microsoft: the company's directory (tenant) id. */
  tenant?: string
  /** A short list: only these emails get in. */
  emails?: string[]
  /** The first manager, by email. Managers give the others their rights. */
  owners?: string[]
  /** Optional first role for new people verified against the company's Google domain or Microsoft directory. */
  defaultRole?: "member"
  /** Emails configured under the former name are kept as owners. */
  managers?: string[]
  /** For a provider that sends groups: which group gives which rights. "*" is everyone who can sign in. */
  groups?: Record<string, Parameters<typeof projectRole>[0]>
  /** A team password, for a first try-out. Names are typed, not checked. */
  password?: string
  /** The login's address when it is not the real one (the tests' stand-in). */
  issuer?: string
  /** The live Flowbound's address, for `--live` on your own computer. */
  live?: string
}
/** What other plugins get from use("door"). */
export type Door = {
  live: () => string | undefined
  /** Write one line of history: who changed what, through what, and the value before and after. Never a secret. */
  wrote: (who: Who, what: string, on: string, before?: unknown, after?: unknown) => Promise<void>
}
type Person = { email: string; name: string; role: Role; checked: boolean; blocked: boolean; checked_at: Date | null }

const HOUR = 3600_000
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "GET, POST, OPTIONS" }
const open = <R extends (...a: any[]) => any>(run: R) => Object.assign(run, { open: "all" as const })
const list = (v: string | string[] | undefined, env?: string) => (Array.isArray(v) ? v : (v ?? env ?? "").split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean)
const TEAM = "@team-password.invalid"

/** An address only this computer or a private network can reach. Anything else is the open internet. */
export function privateAddress(url: string) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "")
    return /^(localhost|127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || /\.(local|localhost|internal|ts\.net)$/.test(h) || !h.includes(".")
  } catch {
    return false
  }
}

export const door = (opts: DoorOptions = {}) => {
  let fb: Flowbound
  let eng: Engine | undefined
  const env = process.env
  const liveUrl = () => {
    const file = path.join(process.cwd(), ".flowbound", "live.json")
    return (opts.live ?? (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).url : undefined))?.replace(/\/$/, "") as string | undefined
  }
  const q = async (sql: string, params?: unknown[]) => (await fb.use("records").query(sql, params)).rows

  // The one setting, from the list or, where the host sets it, from its environment.
  const set = () => {
    // Before this setting there was only "Sign in with Vercel": two values and nothing else. It is one provider among any.
    const named = opts.login ?? env.FLOWBOUND_LOGIN ?? (env.FLOWBOUND_LOGIN_CLIENT_ID ? "https://vercel.com" : undefined)
    const kind = named === "google" || named === "microsoft" ? named : named ? "sso" : undefined
    const groups: NonNullable<DoorOptions["groups"]> = opts.groups ?? Object.fromEntries(list(undefined, env.FLOWBOUND_LOGIN_GROUPS).map((g) => g.split("=") as [string, Role]))
    return {
      kind,
      named,
      domains: list(opts.domain, env.FLOWBOUND_LOGIN_DOMAIN),
      tenant: (opts.tenant ?? env.FLOWBOUND_LOGIN_TENANT ?? "").trim().toLowerCase(),
      emails: list(opts.emails, env.FLOWBOUND_LOGIN_EMAILS),
      managers: list(opts.owners ?? opts.managers, env.FLOWBOUND_OWNERS ?? env.FLOWBOUND_MANAGERS),
      defaultRole: opts.defaultRole ?? env.FLOWBOUND_LOGIN_DEFAULT_ROLE,
      groups: Object.fromEntries(Object.entries(groups).map(([g, r]) => [g.toLowerCase(), projectRole(r)])) as Record<string, Role>,
      password: opts.password ?? env.FLOWBOUND_PASSWORD,
      issuer: opts.issuer ?? env.FLOWBOUND_LOGIN_ISSUER,
    }
  }
  let s: ReturnType<typeof set>
  const login = (): Login | undefined => {
    if (!s.kind) return undefined
    const no = (why: string) => new Refused(`The door's sign-in is not set up: ${why}`)
    const clientId = env.FLOWBOUND_LOGIN_CLIENT_ID
    const clientSecret = env.FLOWBOUND_LOGIN_CLIENT_SECRET
    if (!clientId || !clientSecret) throw no("put the two values from the login's own console in FLOWBOUND_LOGIN_CLIENT_ID and FLOWBOUND_LOGIN_CLIENT_SECRET on the host.")
    if (s.kind === "google" && !s.domains.length && !s.emails.length)
      throw no('Google needs the company\'s domain (domain: "acme.com") or a short list of emails (emails: [...]). Without one, anyone with a Google account could sign in.')
    if (s.kind === "microsoft" && !/^[0-9a-f-]{36}$/.test(s.tenant)) throw no('Microsoft needs the company\'s directory id (tenant: "..."), so only its own people can sign in.')
    if (s.defaultRole && (s.defaultRole !== "member" || !(s.kind === "microsoft" || (s.kind === "google" && s.domains.length)))) {
      throw no("the default Member role needs a Google Workspace domain or a Microsoft directory.")
    }
    if (Object.values(s.groups).some((r) => !ROLES.includes(r))) throw no(`a group's rights must be one of ${ROLES.join(", ")}.`)
    if (!s.managers.length && !s.emails.length && !Object.values(s.groups).some((role) => can({ role }, "admin")))
      throw no('name the first manager by email (managers: ["you@acme.com"]). Managers give the others their rights.')
    const issuer = s.issuer ?? (s.kind === "google" ? "https://accounts.google.com" : s.kind === "microsoft" ? `https://login.microsoftonline.com/${s.tenant}/v2.0` : s.named!)
    if (!/^https:\/\//.test(issuer) && !privateAddress(issuer)) throw no("the login's address must start with https://")
    const label = s.kind === "google" ? "Google" : s.kind === "microsoft" ? "Microsoft" : /vercel\.com/.test(issuer) ? "Vercel" : /okta/.test(issuer) ? "Okta" : "your work account"
    return { id: s.kind as Login["id"], label, issuer, clientId, clientSecret }
  }
  const secret = () => {
    if (!env.FLOWBOUND_SECRET) throw new Refused("This live Flowbound has no FLOWBOUND_SECRET on its host.", undefined, 503)
    return env.FLOWBOUND_SECRET
  }
  const engine = () => {
    if (!eng) throw new Refused("A Flowbound on your own computer needs no sign-in.", undefined, 404)
    return eng
  }

  /** May somebody with this email come in at all, as the settings stand now? A reason when not. */
  const listed = (email: string): string | undefined => {
    if (!email) return "The login did not say what your email is."
    if (email.endsWith(TEAM)) return s.password ? undefined : "The team password is switched off here."
    if (!s.kind) return "Nobody vouches for people here."
    if (s.emails.length && !s.emails.includes(email)) return `You signed in as ${email}. That email is not on this Flowbound's list.`
    return undefined
  }
  /** The allowed domains: whose people may sign in, as Viewers. The first come from the settings; Owners edit them on the People tab. */
  const domains = async (): Promise<string[]> => (await q("select domain from fb_door.domains where not removed order by added_at, domain")).map((r: any) => r.domain)
  /** Is the login's own word that this account is the company's? Google: its Workspace domain (hd). Microsoft: its directory, and its email's domain when any are listed. */
  const company = async (email: string, claims: Claims): Promise<string | undefined> => {
    const allowed = await domains()
    if (s.kind === "google" && !s.emails.length && !allowed.includes(String(claims.hd ?? "").toLowerCase()))
      return allowed.length
        ? `You signed in as ${email}. This Flowbound is for people at ${allowed.join(" or ")}, and for people invited by email.`
        : `You signed in as ${email}. Only people invited by email may sign in here.`
    if (s.kind === "microsoft" && String(claims.tid ?? "").toLowerCase() !== s.tenant) return `You signed in as ${email}. This Flowbound is for one company's own directory, and that account is not in it.`
    if (s.kind === "microsoft" && allowed.length && !allowed.includes(email.split("@")[1] ?? ""))
      return `You signed in as ${email}. This Flowbound is for people at ${allowed.join(" or ")}, and for people invited by email.`
    return undefined
  }
  /** Someone an Admin or Owner invited by email (or gave a role): they may come in at any domain, with the login's checked email. */
  const invited = async (email: string, claims: Claims) => {
    const p = await person(email)
    return !!p && !p.blocked && p.role !== "none" && claims.verified === true
  }
  /** And as the login just described them: the right company, the right directory, or invited; an email it has checked. */
  const vet = async (email: string, claims: Claims): Promise<string | undefined> => {
    if (listed(email) || email.endsWith(TEAM)) return listed(email)
    if (claims.verified === false) return `The login has not checked that ${email} is yours.`
    const why = await company(email, claims)
    if (why && !(await invited(email, claims))) return why
    return undefined
  }
  const fromGroups = (claims: Claims) => {
    const mine = new Set(["*", ...(claims.groups ?? []).map((g) => g.toLowerCase())])
    return ROLES.findLast((r) => Object.entries(s.groups).some(([g, role]) => role === r && mine.has(g))) ?? "none"
  }
  /** Where a person's rights come from: the settings name them, a group does, or a manager set them by hand. */
  const fixed = (email: string, claims?: Claims): Role | undefined => {
    if (email.endsWith(TEAM)) return "admin" // A typed name cannot own the project.
    if (s.managers.includes(email)) return "owner"
    if (Object.keys(s.groups).length) return claims ? fromGroups(claims) : undefined
    if (s.emails.length && !s.managers.length) return "admin" // a few people who trust each other
    return undefined
  }
  const person = async (email: string) => (await q("select email, name, role, checked, blocked, checked_at from fb_door.people where email = $1", [email]))[0] as Person | undefined
  const withSettings = (p: Person): Person => {
    const role = fixed(p.email) ?? p.role
    return role === p.role ? p : { ...p, role }
  }
  /** After the login vouched: put the person on the list (with nothing, unless the settings or a group say more). */
  const enter = async (u: Signed): Promise<Person | string> => {
    const claims = await engine().claims(u.user)
    const why = await vet(u.email, claims)
    if (why) return why
    const was = await person(u.email)
    if (was?.blocked) return `A manager removed ${u.email} from this Flowbound.`
    // Someone at an allowed domain comes in as a Viewer (a Member where the settings say so); an invited person with their role.
    const ours = !s.emails.length && s.kind !== "sso" && !(await company(u.email, claims))
    const first = ours ? (s.defaultRole === "member" ? "member" : "viewer") : "none"
    const role = fixed(u.email, claims) ?? (was && was.role !== "none" ? was.role : first)
    await q(
      `insert into fb_door.people (email, name, role, checked, checked_at, seen_at) values ($1, $2, $3, $4, now(), now())
       on conflict (email) do update set name = $2, role = $3, checked = $4, checked_at = now(), seen_at = now()`,
      [u.email, u.name || u.email, role, !u.email.endsWith(TEAM)],
    )
    if (was && was.role !== role) {
      const by: Who = { kind: "system", name: s.kind === "sso" ? "The login's groups" : "The settings", via: "sign-in" }
      await wrote(by, "rights", u.email, was.role, role)
    }
    return (await person(u.email))!
  }
  /** A person on the list who may still come in, or why not. Someone the settings no longer allow is out at once. */
  const admitted = async (u: Signed): Promise<Person | string> => {
    const p = await person(u.email)
    if (!p) return "not vetted"
    if (p.blocked) return `A manager removed ${u.email} from this Flowbound.`
    return listed(u.email) ?? withSettings(p)
  }
  /** For agents: an hour after the login last vouched for their person, ask it again. A person who left is out. */
  const stillThere = async (p: Person): Promise<string | undefined> => {
    if (!p.checked) return undefined
    const age = Date.now() - new Date(p.checked_at ?? 0).getTime()
    if (age < HOUR) return undefined
    const said = await engine().recheck(p.email)
    // Still there: and what the login says now (the company, the groups) counts from here on.
    if (typeof said !== "string") return ((r) => (typeof r === "string" ? r : undefined))(await enter(said))
    // The login gave no way to ask, or could not be reached: the person's own last sign-in counts for a day.
    if (said !== "gone" && age < 24 * HOUR) return undefined
    // It said no: that holds until the person signs in again themselves.
    if (said === "gone") {
      await q("update fb_door.people set checked_at = null where email = $1", [p.email])
    }
    return `${p.email} has to sign in again: ${said === "gone" || !p.checked_at ? "the company's login no longer vouches for them" : "it is more than a day since the company's login vouched for them"}.`
  }
  const whoIs = (p: Person, via: string): Who => ({ kind: "person", name: p.checked ? `${p.name} (${p.email})` : p.name, checked: p.checked, via, email: p.checked ? p.email : undefined, role: p.role })
  /** An agent acts for its person and never more: it can do what they can, up to Member. A yes reaches Flowbound through the person's agent; it never manages (keys, people). */
  const agentOf = (p: Person, label: string, via: string): Who => ({
    kind: "token",
    name: `${label}, for ${p.checked ? `${p.name} (${p.email})` : p.name}`,
    checked: p.checked,
    via,
    email: p.checked ? p.email : undefined,
    role: can({ role: p.role }, "member") ? "member" : p.role,
    personName: p.name,
  })

  const wrote: Door["wrote"] = async (who, what, on, before, after) => {
    await q("insert into fb_door.history (who, through, what, on_what, before, after) values ($1, $2, $3, $4, $5, $6)", [
      who.name,
      who.kind === "token" ? "an agent" : who.via,
      what,
      on,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
    ])
  }

  const local = (to: string) => (to.startsWith("/") && !to.startsWith("//") && !to.includes("\\") ? to : `${fb.base}/`)
  // Sign-in and "Allow an app" stand alone, in the pages' own style sheet. With no pages plug-in they are plain HTML.
  const head = (title: string) => (fb.has("pages") ? fb.use("pages").head(title) : `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Flowbound</title>`)
  const page = (file: string, fill: Record<string, unknown>, status = 200) => {
    let html = fs
      .readFileSync(asset(file), "utf8")
      .replace(/(url\(|action=)"\//g, `$1"${fb.base}/`)
      .replace("__HEAD__", () => head(file.includes("allow") ? "Allow an app" : "Sign in"))
    for (const [k, v] of Object.entries(fill)) html = html.replaceAll(k, () => JSON.stringify(v ?? null).replace(/</g, "\\u003c"))
    return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "frame-ancestors 'none'" } })
  }
  const signIn = (o: { to?: string; no?: string; wait?: string; status?: number }) =>
    page("door/sign-in.html", { __LOGIN__: s.kind ? login()!.label : null, __PASSWORD__: !!s.password, __TO__: o.to ?? `${fb.base}/`, __NO__: o.no ?? null, __WAIT__: o.wait ?? null }, o.status)
  const toDoor = (url: URL) => new Response(null, { status: 302, headers: { location: `${fb.base}/door?to=${encodeURIComponent(fb.base + url.pathname + url.search)}` } })
  const needsToken = (error: string) => Response.json({ ok: false, error }, { status: 401, headers: CORS })
  const withCors = (res: Response) => {
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(CORS)) if (!out.headers.has(k)) out.headers.set(k, v)
    return out
  }
  const waiting = (p: Person) => `You are signed in as ${p.email}. Nobody has given you rights here yet. Ask ${s.managers.length ? s.managers.join(" or ") : "a manager"}.`

  return plugin({
    name: "door",
    provides: "door",
    needs: ["records"],
    /** For `deploy`, to say how people sign in. */
    signIn:
      opts.password && !opts.login
        ? "the team password"
        : opts.login === "google"
          ? `Google${opts.domain ? ` (${[opts.domain].flat().join(", ")})` : ""}`
          : opts.login === "microsoft"
            ? "Microsoft"
            : opts.login
              ? "your company's login"
              : undefined,
    card: liveUrl()
      ? {
          name: "door",
          label: "Live Flowbound token",
          host: liveUrl()!,
          key: { header: "authorization", prefix: "Bearer ", name: "FLOWBOUND_LIVE_TOKEN" },
          hint: "A token for an agent on the live Flowbound (its make-token tool). Lets `--live` commands on this computer reach it.",
        }
      : undefined,
    migrations: [
      "create table fb_door.tokens (id bigserial primary key, label text not null, hash text not null unique, made_by text not null, made_at timestamptz not null default now(), used_at timestamptz)",
      // (The door before work logins gave chat apps a token of this kind. They now sign in through the engine.)
      "alter table fb_door.tokens add column grant_hash text unique",
      // The door's own list of people: who may come in and what each may do. A token belongs to one of them.
      `create table fb_door.people (email text primary key, name text not null default '', role text not null default 'none', checked boolean not null default true,
         blocked boolean not null default false, checked_at timestamptz, seen_at timestamptz, added_by text, added_at timestamptz not null default now());
       alter table fb_door.tokens add column person text;
       create table fb_door.history (id bigserial primary key, at timestamptz not null default now(), who text not null, through text not null, what text not null, on_what text not null, before jsonb, after jsonb);
       create function fb_door.history_is_kept() returns trigger language plpgsql as $$ begin raise exception 'History is kept as it was written: it cannot be changed or deleted.'; end $$;
       create trigger history_is_kept before update or delete on fb_door.history for each row execute function fb_door.history_is_kept()`,
      ...ENGINE_TABLES,
      `update fb_door.people set role = case role
        when 'view' then 'viewer' when 'edit' then 'member' when 'approve' then 'member' when 'manage' then 'admin' else role end`,
      // Allowed domains: several, whose people may sign in as Viewers. One taken away stays away, even if the settings name it.
      "create table fb_door.domains (domain text primary key, added_by text not null, added_at timestamptz not null default now(), removed boolean not null default false)",
    ],
    async start(f) {
      fb = f
      s = set()
      const off = !s.kind && !s.password
      if (fb.live && off)
        throw new Refused(
          'Sign-in is off, and this Flowbound is live. Running with nobody signing in is only for your own computer. Set who vouches for people in flowbound.config.ts, for example door({ login: "google", domain: "yourcompany.com", managers: ["you@yourcompany.com"] }), or a team password (FLOWBOUND_PASSWORD) for a first try-out. See `npx flowbound docs door`.',
        )
      if (!fb.live && !privateAddress(fb.url))
        throw new Refused(
          `Sign-in is off, and ${fb.url} is a public address: anyone who finds it would be in. Run it as a shared Flowbound (FLOWBOUND_LIVE=1) with a sign-in set, or keep it on an address only you can reach. See \`npx flowbound docs door\`.`,
        )
      if (fb.live) {
        const { engine: make } = await import("./door/engine.ts")
        eng = await make({ fb, secret: secret(), login: login(), password: s.password })
        // The first allowed domains come from the deploy settings; after that, Owners edit them on the People tab.
        for (const d of s.domains) await q("insert into fb_door.domains (domain, added_by) values ($1, 'the settings') on conflict (domain) do nothing", [d])
      }
      return { live: liveUrl, wrote, engine } satisfies Door & { engine: typeof engine }
    },
    async guard(req, url, route) {
      if (!fb.live) {
        // `--live`: pass the call on to the live Flowbound, with the token the keys plugin holds.
        if (!url.searchParams.has("live") || !url.pathname.startsWith("/api")) return undefined
        if (!liveUrl()) throw new Refused("There is no live Flowbound yet. Make one with: npx flowbound deploy")
        const res = await fb.use("keys").fetch("door", url.pathname, {
          method: req.method,
          headers: { "content-type": "application/json", "x-flowbound-via": req.headers.get("x-flowbound-via") ?? "api" },
          body: req.method === "GET" ? undefined : await req.text(),
        })
        return new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } })
      }
      const via = req.headers.get("x-flowbound-via") ?? "api"
      if (route?.open === "all" || url.pathname.startsWith("/door")) return { kind: "system", name: "anyone", via }
      const bearer = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1]
      if (route?.open === "token" && (bearer || url.pathname === "/mcp")) {
        let p: Person | undefined
        let label: string
        if (bearer?.startsWith("fb_live_")) {
          // A token a person made on the Connect page, for an agent that cannot sign in by itself.
          const t = (await q("update fb_door.tokens set used_at = now() where hash = $1 returning label, person, made_by", [sha(bearer)]))[0]
          if (!t) return needsToken("That token is not known here. Make one on the Connect page.")
          p = t.person ? await person(t.person) : undefined
          if (!p || p.blocked) return needsToken("That token's person is not on this Flowbound's list any more. Make a new one on the Connect page.")
          label = t.label
        } else {
          // A chat app that signed a person in.
          const b = await engine().bearer(req)
          if (b instanceof Response) return withCors(b)
          const ok = await admitted(b)
          if (typeof ok === "string") return needsToken(ok === "not vetted" ? `${b.email} is not on this Flowbound's list.` : ok)
          p = ok
          label = b.app
        }
        const stale = await stillThere(p)
        if (stale) return needsToken(stale)
        const fresh = await person(p.email)
        if (!fresh || fresh.blocked || listed(fresh.email)) return needsToken("This person no longer has access here.")
        return agentOf(withSettings(fresh), label, via)
      }
      const u = await engine().session(req)
      const p = u && (await admitted(u))
      // A page's own calls carry this header; a form on another site cannot set it.
      if (p && typeof p !== "string" && (req.method === "GET" || via === "page")) {
        if (p.role === "none" && !url.pathname.startsWith("/api") && !url.pathname.startsWith("/assets")) return signIn({ wait: waiting(p), status: 403 })
        return whoIs(p, "page")
      }
      if (route?.open === "token") return needsToken("This needs a token: Authorization: Bearer fb_live_... Make one on the Connect page.")
      return toDoor(url)
    },
    routes: {
      "GET /door": async (req, at) => {
        if (!fb.live) return new Response(null, { status: 302, headers: { location: `${fb.base}/` } })
        const p = at.url.searchParams
        // A chat app sent the person here to sign in: afterwards, carry on with what the app asked.
        const to = p.has("client_id") ? `${fb.base}/door/resume?${p}` : local(p.get("to") ?? "")
        const u = await engine().session(req)
        const in_ = u && (await admitted(u))
        if (in_ && typeof in_ !== "string" && !p.has("no")) return engine().go(to)
        return signIn({ to, no: p.get("no") === "password" ? "That is not the team password, or the name is missing." : p.has("no") ? "The login did not let you in. Try again." : undefined })
      },
      "GET /door/login": async (req, at) => (await engine().start(req, local(at.url.searchParams.get("to") ?? ""))) ?? signIn({ no: "This Flowbound has no login to sign in with." }),
      // Back from the company's login. The engine checks the login's signed answer and starts the browser's session.
      "GET /door/callback": (req, at) => engine().handle(req, `${engine().base}/callback/${login()?.id}${at.url.search}`),
      // Then the door's own question: may this person come in here? Signing in alone gives nothing.
      "GET /door/in": async (req, at) => {
        const u = await engine().session(req)
        if (!u) return toDoor(new URL(local(at.url.searchParams.get("to") ?? ""), fb.url))
        const p = await enter(u)
        if (typeof p !== "string") return engine().go(local(at.url.searchParams.get("to") ?? ""))
        const cookies = await engine().out(req)
        await engine().forget(u.email)
        const res = signIn({ no: p, status: 403 })
        for (const c of cookies) res.headers.append("set-cookie", c)
        return res
      },
      "POST /door/password": async (req) => {
        const form = await req.formData()
        const to = local(String(form.get("to") ?? ""))
        const r = await engine().password(req, { password: String(form.get("password") ?? ""), name: String(form.get("name") ?? "") })
        return engine().go(r.cookies ? `${fb.base}/door/in?to=${encodeURIComponent(to)}` : `${fb.base}/door?no=password&to=${encodeURIComponent(to)}`, r.cookies)
      },
      "GET /door/resume": (_req, at) => {
        const p = new URLSearchParams(at.url.search)
        // The engine signed the app's question for the sign-in page; asked again without that, it starts over signed in.
        for (const k of ["ba_param", "ba_iat", "sig", "exp"]) p.delete(k)
        return engine().go(`${engine().base}/oauth2/authorize?${p}`)
      },
      // The person's part of connecting a chat app: signed in here, they see which app is asking and what it will be able to do.
      "GET /door/allow": async (req, at) => {
        const u = await engine().session(req)
        const p = u && (await admitted(u))
        const app = await engine().app(at.url.searchParams)
        if (!p || typeof p === "string") return engine().go(`${fb.base}/door?${at.url.searchParams}`)
        if (!app) throw new Refused("This app is not known to this Flowbound. Remove the connector in the app and add it again.", undefined, 400)
        return page("door/allow.html", { __APP__: app.name, __BACK__: app.back ? new URL(app.back).host : "", __QUERY__: at.url.search.slice(1), __WHO__: whoIs(p, "page").name })
      },
      "POST /door/allow": async (req) => {
        const form = await req.formData()
        const u = await engine().session(req)
        const p = u && (await admitted(u))
        if (!p || typeof p === "string") throw new Refused("Sign in first, then start again from the app.", undefined, 403)
        const r = await engine().consent(req, form.get("answer") === "allow", String(form.get("query") ?? ""))
        if (!r.to) throw new Refused(r.why ?? "That did not come from this Flowbound's own page. Start again from the app.", undefined, 403)
        if (form.get("answer") === "allow") await wrote(whoIs(p, "page"), "connected an app", (await engine().app(new URLSearchParams(String(form.get("query")))))?.name ?? "An app")
        return engine().go(r.to)
      },
      "POST /door/out": async (req) => engine().go(`${fb.base}/door`, await engine().out(req)),
      // Everything else under /door/auth is the engine's own: the addresses a chat app uses to sign a person in.
      // Only those: every other address of the engine (its own sign-in, changing a name) is the door's to call, not the world's.
      "ANY /door/auth/:rest*": async (req, at) => {
        if (!/^(oauth2\/(authorize|token|register|userinfo|revoke|introspect)|jwks|\.well-known\/.+)$/.test(at.params.rest ?? ""))
          return Response.json({ ok: false, error: `Nothing is at ${at.url.pathname}.` }, { status: 404 })
        const res = await engine().handle(req, `${fb.url}${at.url.pathname}${at.url.search}`)
        // The person's browser is sent here by the app. Whatever kind of request the engine takes it for, the person
        // must end up on a page: where the engine answers "go there" as data, make it a real redirect.
        if (at.params.rest === "oauth2/authorize" && res.status === 200 && res.headers.get("content-type")?.includes("json")) {
          const said = (await res
            .clone()
            .json()
            .catch(() => ({}))) as { redirect?: boolean; url?: string }
          if (said.redirect && said.url) return engine().go(said.url, res.headers.getSetCookie())
        }
        return withCors(res)
      },
      "OPTIONS /.well-known/:doc*": open(() => new Response(null, { status: 204, headers: CORS })),
      // What a chat app reads first to learn how to sign a person in here (OAuth's discovery documents).
      "GET /.well-known/:doc*": open(async (req: Request, at: { url: URL }) => (fb.live ? withCors(await engine().handle(req, `${fb.url}${at.url.pathname}`)) : new Response(null, { status: 404 }))),
    },
    tools: {
      tokens: {
        about: "The agents and chat apps that can reach this live Flowbound, and whose each one is. Never a token itself.",
        role: "viewer",
        run: async (_i, who) => {
          const all = can(who, "admin")
          const mine = who.email ?? "-"
          // Under the team password a person has no email: show the name they typed, and that it is not checked.
          const typed = new Map((await q("select email, name from fb_door.people where not checked")).map((p: any) => [p.email, `${p.name} (name not checked)`]))
          const whose = (email: string) => typed.get(email) ?? email
          const tokens = (await q("select id, label, person, made_by, made_at, used_at from fb_door.tokens where $1::text is null or person = $1 order by id", [all ? null : mine])).map((t: any) => ({
            id: `token-${t.id}`,
            kind: "token",
            label: t.label,
            person: whose(t.person ?? t.made_by),
            made: day(t.made_at),
            lastUsed: t.used_at ? day(t.used_at) : "never",
            usedAt: t.used_at ? new Date(t.used_at).toISOString() : null,
            mine: (t.person ?? t.made_by) === mine,
          }))
          const apps = eng
            ? (await eng.connections(all ? undefined : (mine ?? "-"))).map((c) => ({
                id: `app-${c.id}`,
                kind: "app",
                label: c.app,
                person: whose(c.email),
                made: day(c.since),
                lastUsed: c.used ? day(c.used) : "",
                usedAt: c.used ? new Date(c.used).toISOString() : null,
                mine: c.email === mine,
              }))
            : []
          return [...apps, ...tokens]
        },
      },
      "make-token": {
        about: "Make a token for an agent that cannot sign in by itself. It is shown once, belongs to you, and can do what you can, up to passing on your yes; never manage.",
        by: "people",
        input: { label: { about: "which agent it is for", required: true } },
        run: async (i, who) => {
          if (!fb.live) throw new Refused("Tokens are for a live Flowbound.")
          const token = `fb_live_${crypto.randomBytes(24).toString("hex")}`
          const owner = who.email ?? `${who.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ".")}${TEAM}`
          await q("insert into fb_door.tokens (label, hash, made_by, person) values ($1, $2, $3, $4)", [String(i.label).slice(0, 80), sha(token), who.name, owner])
          await wrote(who, "made a token", String(i.label).slice(0, 80))
          return { token, mcp: `${fb.url}/mcp` }
        },
      },
      "drop-token": {
        about: "Take an agent's token or a chat app's connection away. Your own; a manager can take anyone's.",
        by: "people",
        input: { id: { about: "its id, from the tokens tool", required: true } },
        run: async (i, who) => {
          const [kind, id] = String(i.id).split(/-(.*)/s)
          const only = can(who, "admin") ? undefined : (who.email ?? "-")
          if (kind === "app") {
            const gone = await engine().disconnect(id!, only)
            if (gone) await wrote(who, "removed an app", `${gone.app}, for ${gone.email}`)
            return { dropped: gone ? 1 : 0 }
          }
          const gone = await q("delete from fb_door.tokens where id = $1 and ($2::text is null or person = $2) returning label, person", [Number(id), only ?? null])
          for (const t of gone) await wrote(who, "removed a token", `${t.label}, for ${t.person}`)
          return { dropped: gone.length }
        },
      },
      people: {
        about: "Who can come in to this live Flowbound and which project role each person has.",
        role: "viewer",
        run: async (_i, who) => {
          if (!fb.live) return { signIn: "off", note: "On your own computer nobody signs in.", people: [] }
          const rows = (await q("select email, name, role, checked, blocked, checked_at, seen_at from fb_door.people order by blocked, email")) as (Person & { seen_at: Date | null })[]
          return {
            signIn: s.kind ? `${login()!.label}${s.domains.length ? `, for ${s.domains.join(" and ")}` : ""}` : "team password (names not checked)",
            rightsFrom: Object.keys(s.groups).length ? "groups" : "managers",
            you: who.email ?? who.name,
            canManage: can(who, "admin") && who.kind === "person",
            isOwner: can(who, "owner") && who.kind === "person",
            domains: s.kind === "google" || s.kind === "microsoft" ? await domains() : null,
            people: rows.map((p) => ({
              email: p.checked ? p.email : null,
              name: p.name,
              rights: p.blocked ? "removed" : withSettings(p).role,
              checked: p.checked,
              setBy: p.blocked || fixed(p.email, {}) === undefined ? "a manager" : Object.keys(s.groups).length && !s.managers.includes(p.email) ? "their groups" : "the settings",
              lastSeen: p.seen_at ? day(p.seen_at) : "never",
              invited: !p.seen_at && !p.blocked,
            })),
          }
        },
      },
      "set-domain": {
        about: "Add or take away an allowed domain: people with a work email there may sign in, as Viewers. Owners only. Taking one away stops new sign-ins from it; people already in keep their role.",
        by: "people",
        role: "owner",
        input: { domain: { about: "the domain, like acme.com", required: true }, remove: { type: "boolean", about: "take it away" } },
        run: async (i, who) => {
          if (!fb.live) throw new Refused("Allowed domains are for a live Flowbound.")
          if (s.kind !== "google" && s.kind !== "microsoft") throw new Refused("Allowed domains are for a Google or Microsoft sign-in. Here the login's own groups say who comes in.")
          const domain = String(i.domain).trim().toLowerCase().replace(/^@/, "")
          if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Refused("That is not a domain. Write it like acme.com.")
          if (i.remove) await q("update fb_door.domains set removed = true where domain = $1", [domain])
          else await q("insert into fb_door.domains (domain, added_by) values ($1, $2) on conflict (domain) do update set removed = false, added_by = $2", [domain, who.name])
          await wrote(who, "allowed domain", domain, i.remove ? "allowed" : null, i.remove ? "removed" : "allowed")
          return { domain, allowed: !i.remove, domains: await domains() }
        },
      },
      "set-rights": {
        about: "Give a person their rights on this live Flowbound, or change them. A new email is added to the list before they first sign in.",
        by: "people",
        role: "admin",
        input: { email: { about: "the person's work email", required: true }, rights: { about: "none, viewer, member, admin or owner", required: true } },
        run: async (i, who) => {
          const email = String(i.email).trim().toLowerCase()
          const role = String(i.rights) as Role
          if (!ROLES.includes(role)) throw new Refused(`Rights are one of: ${ROLES.join(", ")}.`)
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.endsWith(TEAM)) throw new Refused("That is not a work email.")
          if (s.managers.includes(email)) throw new Refused(`${email} is named as a manager in the settings. Change the settings to change that.`)
          if (Object.keys(s.groups).length) throw new Refused("Rights here come from the login's groups. Change the person's groups there.")
          const was = await person(email)
          if (!can(who, "owner") && (can({ role }, "admin") || (was && can(was, "admin")))) throw new Refused("Only an owner can change admin or owner access.", undefined, 403)
          const updated = await q(
            "insert into fb_door.people (email, name, role, added_by) values ($1, $1, $2, $3) on conflict (email) do update set role = $2, blocked = false where $4 or fb_door.people.role not in ('admin', 'owner') returning email",
            [email, role, who.name, can(who, "owner")],
          )
          if (!updated.length) throw new Refused("Only an owner can change admin or owner access.", undefined, 403)
          await wrote(who, "rights", email, was ? (was.blocked ? "removed" : was.role) : null, role)
          return { email, rights: role }
        },
      },
      "remove-person": {
        about: "Take a person off this live Flowbound at once: they are signed out, and every agent and chat app they connected stops.",
        by: "people",
        role: "admin",
        input: { email: { about: "the person's email", required: true } },
        run: async (i, who) => {
          const email = String(i.email).trim().toLowerCase()
          if (email === who.email) throw new Refused("You cannot remove yourself.")
          const was = await person(email)
          if (!was) throw new Refused(`${email} is not on the list.`)
          if (s.managers.includes(email)) throw new Refused(`${email} is named as an owner in the settings. Change the settings to remove them.`)
          if (!can(who, "owner") && can(was, "admin")) throw new Refused("Only an owner can remove an admin or owner.", undefined, 403)
          const removed = await q("update fb_door.people set blocked = true, role = 'none' where email = $1 and ($2 or role not in ('admin', 'owner')) returning email", [email, can(who, "owner")])
          if (!removed.length) throw new Refused("Only an owner can remove an admin or owner.", undefined, 403)
          const tokens = await q("delete from fb_door.tokens where person = $1 returning id", [email])
          await engine().forget(email)
          await wrote(who, "removed a person", email, was.role, "removed")
          return { email, removed: true, tokensDropped: tokens.length }
        },
      },
      history: {
        about: "Who changed what: rights, people, keys, tokens, and every yes and stop of a run. Each with who, through what, before, after and when. It cannot be edited.",
        role: "viewer",
        input: { csv: { type: "boolean", about: "as a CSV file" }, limit: { type: "number", about: "how many lines, newest first (200)" } },
        run: async (i) => {
          const rows = await q("select id, at, who, through, what, on_what, before, after from fb_door.history order by id desc limit $1", [i.csv ? 1_000_000 : Math.min(Number(i.limit ?? 200), 5000)])
          const lines = rows.map((r: any) => ({ id: r.id, when: new Date(r.at).toISOString(), who: r.who, through: r.through, what: r.what, on: r.on_what, before: r.before, after: r.after }))
          if (!i.csv) return lines
          const cell = (v: unknown) => `"${(v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)).replace(/"/g, '""')}"`
          return {
            rows: lines.length,
            save: {
              name: "history.csv",
              text: `${["when", "who", "through", "what", "on", "before", "after"].join(",")}\n${lines.map((l: any) => [l.when, l.who, l.through, l.what, l.on, l.before, l.after].map(cell).join(",")).join("\n")}\n`,
            },
          }
        },
        print: (r) =>
          Array.isArray(r)
            ? r
                .map(
                  (l: any) =>
                    `${l.when.slice(0, 16).replace("T", " ")}  ${l.who} (${l.through})  ${l.what}: ${l.on}${l.before != null || l.after != null ? `  ${JSON.stringify(l.before)} -> ${JSON.stringify(l.after)}` : ""}`,
                )
                .join("\n") || "Nothing yet."
            : `${r.save.name}   ${r.rows} lines`,
      },
    },
    /** For the check-up, live: people who signed in and wait for a manager to give them rights. */
    async attention() {
      if (!fb.live) return []
      const waits = (await q("select email from fb_door.people where role = 'none' and not blocked and seen_at is not null order by email limit 20")).map((r: any) => r.email as string)
      return waits.length
        ? [
            {
              what: `${waits.length === 1 ? `${waits[0]} has` : `${waits.length} people have`} signed in and can do nothing yet: nobody has given them rights.`,
              fix: "An Admin or Owner gives them a role (or removes them) on Permissions, People.",
              page: "/permissions",
              params: { tab: "people" },
            } satisfies Attention,
          ]
        : []
    },
    // Live only, and not tabs of their own: agents' tokens sit with the keys, people and their rights with the permissions.
    pages: { "/connect": { title: "Agents", file: asset("door/connect.html"), menu: true, order: 8 }, "/people": { title: "People", file: asset("door/people.html"), live: true } },
    docs: asset("door/door.md"),
  })
}
