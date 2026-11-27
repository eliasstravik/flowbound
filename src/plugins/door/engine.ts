// The engine under the door: Better Auth, set up from the door's one setting. It does the parts where a mistake hurts
// most and the rules keep moving: signing in with the company's login (OpenID Connect), sessions, and the sign-in
// chat apps use. It is loaded only when somebody has to sign in: a Flowbound on your own computer never touches it.
// What it does not know is Flowbound's own: who may come in, each person's rights, tokens, history. That is door.ts.
import crypto from "node:crypto"
import type { Flowbound } from "../../core/plugin.ts"

/** The company's login, as the door's setting names it. */
export type Login = { id: "google" | "microsoft" | "sso"; label: string; issuer: string; clientId: string; clientSecret: string }
/** What the company's login said about the person, the last time they signed in. */
export type Claims = { hd?: string; tid?: string; groups?: string[]; verified?: boolean }
export type Signed = { user: string; email: string; name: string }
export type Connection = { id: string; app: string; email: string; since: Date }
export type Engine = Awaited<ReturnType<typeof engine>>

const DAY = 12 * 3600 // a browser session lasts a working day
const HOUR = 3600 // a chat app's token lasts an hour, then it renews

export async function engine(o: { fb: Flowbound; secret: string; login?: Login; password?: string }) {
  const { fb } = o
  const { betterAuth } = await import("better-auth")
  const { APIError, createAuthEndpoint } = await import("better-auth/api")
  const { setSessionCookie } = await import("better-auth/cookies")
  const { genericOAuth } = await import("better-auth/plugins/generic-oauth")
  const { jwt } = await import("better-auth/plugins/jwt")
  const { mcp, requireMcpAuth } = await import("@better-auth/mcp")
  const { cimd } = await import("@better-auth/cimd")
  const { fetchClientMetadataResource } = await import("@better-auth/cimd/node")
  const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = await import("kysely")

  const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await fb.use("records").query(sql, params)).rows
  // Better Auth talks to the same database as everything else, through the records part: PGlite or Postgres alike.
  // Its tables sit in the door's own schema. A pooled database hands each statement to whichever connection is free,
  // so there are no transactions here: each statement stands alone.
  const conn = {
    executeQuery: async (c: { sql: string; parameters: readonly unknown[] }) => {
      const r = await fb.use("records").query(c.sql, [...c.parameters])
      return { rows: r.rows, numAffectedRows: BigInt(r.count ?? 0) }
    },
    // biome-ignore lint/correctness/useYield: Better Auth never streams
    async *streamQuery(): AsyncGenerator<never> {
      throw new Error("The door does not stream.")
    },
  }
  const nothing = async () => {}
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: nothing,
        acquireConnection: async () => conn as any,
        beginTransaction: nothing,
        commitTransaction: nothing,
        rollbackTransaction: nothing,
        releaseConnection: nothing,
        destroy: nothing,
      }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })

  const base = `${fb.url}/door/auth`
  const same = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest())
  /** The team password, for a first try-out: one password, a typed name, nothing checked. */
  const teamPassword = {
    id: "team-password",
    endpoints: {
      teamPassword: createAuthEndpoint("/sign-in/team-password", { method: "POST" }, async (ctx) => {
        const body = (ctx.body ?? {}) as { password?: string; name?: string }
        const name = String(body.name ?? "")
          .replace(/[^\p{L}\p{N} .,'_-]/gu, "")
          .trim()
          .slice(0, 60)
        if (!o.password || !same(String(body.password ?? ""), o.password)) throw new APIError("UNAUTHORIZED", { message: "That is not the team password." })
        if (!name) throw new APIError("BAD_REQUEST", { message: "Type your name too. It is saved with what you do." })
        const email = `${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ".")}@team-password.invalid`
        const user = (await ctx.context.internalAdapter.findUserByEmail(email))?.user ?? (await ctx.context.internalAdapter.createUser({ email, name, emailVerified: false }, { method: "team-password" }))
        const session = await ctx.context.internalAdapter.createSession(user.id)
        await setSessionCookie(ctx, { session, user })
        return ctx.json({ ok: true })
      }),
    },
  }

  const login = o.login
  const auth = betterAuth({
    appName: "Flowbound",
    baseURL: base,
    // Its own secret, made from the host's: a leak of one kind of token never opens the keys.
    secret: crypto.createHmac("sha256", o.secret).update("flowbound door").digest("hex"),
    database: { db, type: "postgres", schemaName: "fb_door" },
    telemetry: { enabled: false },
    session: { expiresIn: DAY, disableSessionRefresh: true },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true, trustedProviders: ["google", "microsoft", "sso"] } },
    advanced: { cookiePrefix: "fb" },
    plugins: [
      ...(login
        ? [
            genericOAuth({
              config: [
                {
                  providerId: login.id,
                  name: login.label,
                  discoveryUrl: `${login.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
                  // The person is who the login's signed answer says, checked against the login's own keys.
                  requireIdTokenVerification: true,
                  clientId: login.clientId,
                  clientSecret: login.clientSecret,
                  redirectURI: `${fb.url}/door/callback`,
                  // "offline": a way to ask the login again later whether the person is still there.
                  scopes: ["openid", "email", "profile", ...(login.id === "google" ? [] : ["offline_access"]), ...(login.id === "sso" ? ["groups"] : [])],
                  // Google only hands that out when the person is asked each time.
                  ...(login.id === "google" ? { accessType: "offline", prompt: "consent" as const } : {}),
                  overrideUserInfo: true,
                  mapProfileToUser: (p: Record<string, any>) => ({
                    email: String(p.email ?? p.preferred_username ?? "").toLowerCase(),
                    name: String(p.name ?? p.email ?? p.preferred_username ?? ""),
                    // One company's Microsoft directory vouches for its own addresses; the others say so themselves.
                    emailVerified: login.id === "microsoft" ? true : p.email_verified !== false,
                  }),
                },
              ],
            }),
          ]
        : []),
      jwt(),
      // The sign-in chat apps use (OAuth, as MCP asks for it). Claude and ChatGPT send the person here to allow them.
      mcp({
        loginPage: `${fb.url}/door`,
        consentPage: `${fb.url}/door/allow`,
        resource: `${fb.url}/mcp`,
        accessTokenExpiresIn: HOUR,
        // Only for a person who signed in and allowed the app: no tokens for an app on its own.
        grantTypes: ["authorization_code", "refresh_token"],
        // The older way for an app to introduce itself; the newer way (its own address as its id) is cimd below.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // An app on the person's own computer (Claude Code, Codex, Cursor) comes back to that computer over plain http.
        allowInsecureRedirectUri: (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      ...(o.password ? [teamPassword] : []),
    ],
  } as any)

  const origin = new URL(fb.url).origin
  /** Hand a request to Better Auth at one of its own addresses (under /door/auth, or a discovery document). */
  const handle = (req: Request, at: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    // A call the door makes itself, for the person, carries their cookies and nothing else of the browser's request
    // (a browser says what kind of request it made, and the engine would take the door's call for a forged form).
    const own = init.body !== undefined
    const headers = own ? new Headers({ "content-type": "application/json", origin }) : new Headers(req.headers)
    if (own) for (const k of ["cookie", "user-agent", "x-forwarded-for"]) if (req.headers.get(k)) headers.set(k, req.headers.get(k)!)
    headers.delete("content-length")
    for (const [k, v] of Object.entries(init.headers ?? {})) headers.set(k, v)
    const method = init.method ?? req.method
    const body = init.body !== undefined ? JSON.stringify(init.body) : method === "GET" || method === "HEAD" ? undefined : req.body
    return auth.handler(new Request(at.startsWith("http") ? at : `${origin}${at}`, { method, headers, body, ...(body && init.body === undefined ? { duplex: "half" } : {}) } as RequestInit)) as Promise<Response>
  }
  const cookiesOf = (res: Response) => res.headers.getSetCookie()
  const go = (to: string, cookies: string[] = []) => {
    const headers = new Headers({ location: to })
    for (const c of cookies) headers.append("set-cookie", c)
    return new Response(null, { status: 302, headers })
  }
  const mcpCheck = requireMcpAuth(auth as any, async (_req, claims) => Response.json(claims), { resource: `${fb.url}/mcp` })

  return {
    base,
    /** For scripts/door-tables.ts and the test that says when an upgrade of Better Auth wants new tables. */
    options: auth.options,
    handle,
    go,
    /** Who the browser's session says this is. Nothing here says they may come in: that is the door's list of people. */
    async session(req: Request): Promise<Signed | undefined> {
      if (!req.headers.get("cookie")) return undefined
      const s = (await (auth.api as any).getSession({ headers: req.headers })) as { user: any } | null
      return s?.user ? { user: s.user.id, email: String(s.user.email).toLowerCase(), name: s.user.name } : undefined
    },
    /** What the login last said about this person: its own signed answer, which the engine checked when it came in. */
    async claims(user: string): Promise<Claims> {
      const a = login && (await q(`select "idToken" from fb_door.account where "userId" = $1 and "providerId" = $2`, [user, login.id]))[0]
      try {
        const p = JSON.parse(Buffer.from(String(a?.idToken).split(".")[1] ?? "", "base64url").toString())
        return { hd: p.hd, tid: p.tid, groups: Array.isArray(p.groups) ? p.groups.map(String) : undefined, verified: p.email_verified }
      } catch {
        return {}
      }
    },
    /** Send the person to the company's login. They come back to /door/in. */
    async start(req: Request, to: string) {
      if (!login) return undefined
      const back = (state: string) => `${fb.url}/door${state}`
      const res = await handle(req, `${base}/sign-in/social`, { method: "POST", body: { provider: login.id, callbackURL: back(`/in?to=${encodeURIComponent(to)}`), errorCallbackURL: back("?no=login") } })
      const out = (await res.json().catch(() => ({}))) as { url?: string }
      return out.url ? go(out.url, cookiesOf(res)) : go(back("?no=login"))
    },
    async password(req: Request, form: { password: string; name: string }) {
      const res = await handle(req, `${base}/sign-in/team-password`, { method: "POST", body: form })
      return res.ok ? { cookies: cookiesOf(res) } : { why: ((await res.json().catch(() => ({}))) as { message?: string }).message ?? "That did not work." }
    },
    async out(req: Request) {
      const res = await handle(req, `${base}/sign-out`, { method: "POST", body: {} })
      return cookiesOf(res)
    },
    /** A chat app's token: whose it is and which app holds it. A Response when it is no good (it says where to sign in). */
    async bearer(req: Request): Promise<(Signed & { app: string; client: string }) | Response> {
      const headers = new Headers(req.headers)
      headers.delete("content-length")
      const res = await mcpCheck(new Request(`${fb.url}/mcp`, { method: "POST", headers }))
      if (!res.ok) return res
      const t = (await res.json()) as { sub?: string; azp?: string; client_id?: string }
      const client = String(t.azp ?? t.client_id ?? "")
      // One look-up says who, which app, and that the person's "allow" for this app is still there.
      const row = (
        await q(
          `select u.email, u.name, c.name as app from fb_door."user" u join fb_door."oauthClient" c on c."clientId" = $2
           where u.id = $1 and exists (select 1 from fb_door."oauthConsent" k where k."userId" = u.id and k."clientId" = c."clientId")`,
          [t.sub, client],
        )
      )[0]
      if (!row) return Response.json({ ok: false, error: "This app's connection was removed. Connect it again." }, { status: 401, headers: { "www-authenticate": res.headers.get("www-authenticate") ?? "Bearer" } })
      return { user: String(t.sub), email: String(row.email).toLowerCase(), name: row.name, app: row.app || "An app", client }
    },
    /** Ask the company's login again whether this person is still there. "cannot": it gave no way to ask. */
    async recheck(email: string): Promise<"gone" | "cannot" | "later" | Signed> {
      if (!login) return "cannot"
      const a = (await q(`select a.id, a."userId", a."refreshToken", u.name from fb_door.account a join fb_door."user" u on u.id = a."userId" where lower(u.email) = $1 and a."providerId" = $2`, [email, login.id]))[0]
      if (!a?.refreshToken) return "cannot"
      try {
        await (auth.api as any).refreshToken({ body: { accountId: a.id, userId: a.userId } })
        return { user: a.userId, email, name: a.name }
      } catch (e: any) {
        // The engine does not say why. So ask the login something anyone may ask: if it answers, it was the login
        // that said no (the person left, or their grant was taken away). If it does not, it is down: try again later.
        const up =
          e?.body?.code === "FAILED_TO_REFRESH_ACCESS_TOKEN" &&
          (await fetch(`${login.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) }).then(
            (r) => r.ok,
            () => false,
          ))
        if (!up) return "later"
        await q(`update fb_door.account set "refreshToken" = null where id = $1`, [a.id])
        return "gone"
      }
    },
    /** Take away everything this person is signed in with: browser sessions and every chat app they allowed. */
    async forget(email: string) {
      const users = (await q(`select id from fb_door."user" where lower(email) = $1`, [email])).map((u) => u.id)
      for (const t of ["session", "oauthRefreshToken", "oauthAccessToken", "oauthConsent"]) await q(`delete from fb_door."${t}" where "userId" = any($1)`, [users])
    },
    /** The chat apps people allowed. */
    async connections(email?: string): Promise<Connection[]> {
      return (
        await q(
          `select k.id, c.name as app, lower(u.email) as email, k."createdAt" as since from fb_door."oauthConsent" k join fb_door."user" u on u.id = k."userId"
           join fb_door."oauthClient" c on c."clientId" = k."clientId" where $1::text is null or lower(u.email) = $1 order by k."createdAt"`,
          [email ?? null],
        )
      ).map((r) => ({ ...r, app: r.app || "An app" }))
    },
    async disconnect(id: string, email?: string) {
      const k = (
        await q(
          `select k."userId", k."clientId", lower(u.email) as email, c.name as app from fb_door."oauthConsent" k join fb_door."user" u on u.id = k."userId" join fb_door."oauthClient" c on c."clientId" = k."clientId" where k.id = $1`,
          [id],
        )
      )[0]
      if (!k || (email && k.email !== email)) return undefined
      for (const t of ["oauthRefreshToken", "oauthAccessToken", "oauthConsent"]) await q(`delete from fb_door."${t}" where "userId" = $1 and "clientId" = $2`, [k.userId, k.clientId])
      return { app: k.app || "An app", email: k.email as string }
    },
    /** The person's tap on the allow page. Gives the address to send them to (back to the app). */
    async consent(req: Request, accept: boolean, query: string) {
      const res = await handle(req, `${base}/oauth2/consent`, { method: "POST", body: { accept, oauth_query: query } })
      const out = (await res.json().catch(() => ({}))) as { url?: string; redirect_uri?: string; message?: string; error_description?: string }
      if (process.env.FLOWBOUND_DEBUG) console.error("door consent:", res.status, out)
      return { to: out.url ?? out.redirect_uri, why: out.error_description ?? out.message }
    },
    /** Which app is asking, from the query Better Auth signed for the allow page. */
    async app(query: URLSearchParams) {
      const c = (await q(`select name, "redirectUris" as redirects from fb_door."oauthClient" where "clientId" = $1`, [query.get("client_id")]))[0]
      return c ? { name: (c.name as string) || "An app", back: query.get("redirect_uri") ?? "" } : undefined
    },
  }
}
