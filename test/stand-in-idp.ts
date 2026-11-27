// A stand-in for a company's login, for tests and for trying the door with no account anywhere.
// One small server that answers as three OpenID Connect providers, each the way the real one does:
//   /google                  signs anyone with a Google account in, and says which company they belong to (`hd`)
//   /microsoft/<tenant>/v2.0 one company's directory (`tid`); an account from another directory is turned away there
//   /okta                    sends the person's groups
// A person marked `gone` has left: they cannot sign in, and a renewal for them is refused.
//   node test/stand-in-idp.ts [port]     runs it by hand; the sign-in page then lists the people to pick from.
import crypto from "node:crypto"
import http from "node:http"
import { fileURLToPath } from "node:url"

export type Person = { email: string; name: string; at: "google" | "microsoft" | "okta"; hd?: string; tid?: string; groups?: string[]; gone?: boolean }
export const CLIENT = { id: "flowbound-stand-in", secret: "stand-in-secret" }
export const TENANT = "11111111-2222-3333-4444-555555555555"
export const PEOPLE: Person[] = [
  { email: "maya@acme.example", name: "Maya Manager", at: "google", hd: "acme.example" },
  { email: "sam@acme.example", name: "Sam Seller", at: "google", hd: "acme.example" },
  { email: "olle@other.example", name: "Olle Outsider", at: "google", hd: "other.example" },
  { email: "pat@gmail.example", name: "Pat Private", at: "google" },
  { email: "maya@acme.example", name: "Maya Manager", at: "microsoft", tid: TENANT },
  { email: "sam@acme.example", name: "Sam Seller", at: "microsoft", tid: TENANT },
  { email: "olle@other.example", name: "Olle Outsider", at: "microsoft", tid: "99999999-0000-0000-0000-000000000000" },
  { email: "maya@acme.example", name: "Maya Manager", at: "okta", groups: ["flowbound-managers", "everyone"] },
  { email: "sam@acme.example", name: "Sam Seller", at: "okta", groups: ["flowbound-sellers", "everyone"] },
  { email: "vera@acme.example", name: "Vera Viewer", at: "okta", groups: ["everyone"] },
]

const b64 = (v: Buffer | string | object) => Buffer.from(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v)).toString("base64url")
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

export async function standIn(port = 0) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "stand-in-1", use: "sig", alg: "RS256" }
  const people: Person[] = PEOPLE.map((p) => ({ ...p }))
  type Given = { person: Person; iss: string; client: string; redirect: string; nonce?: string; challenge?: string; scope: string }
  const codes = new Map<string, Given>()
  const renewals = new Map<string, Given>()
  let url = ""

  const find = (at: string, email: string) => people.find((p) => p.at === at && p.email === email)
  const idToken = (g: Given) => {
    const p = g.person
    const now = Math.floor(Date.now() / 1000)
    const claims: Record<string, unknown> = { iss: g.iss, aud: g.client, sub: crypto.createHash("sha256").update(`${p.at}:${p.email}`).digest("hex").slice(0, 21), iat: now, exp: now + 3600, nonce: g.nonce, name: p.name }
    if (p.at === "google") Object.assign(claims, { email: p.email, email_verified: true, ...(p.hd ? { hd: p.hd } : {}) })
    if (p.at === "microsoft") Object.assign(claims, { preferred_username: p.email, email: p.email, tid: p.tid, oid: claims.sub })
    if (p.at === "okta") Object.assign(claims, { email: p.email, email_verified: true, ...(g.scope.split(" ").includes("groups") ? { groups: p.groups ?? [] } : {}) })
    const head = `${b64({ alg: "RS256", typ: "JWT", kid: jwk.kid })}.${b64(claims)}`
    return `${head}.${b64(crypto.sign("RSA-SHA256", Buffer.from(head), privateKey))}`
  }
  const tokens = (g: Given) => {
    const renew = crypto.randomBytes(16).toString("hex")
    // Like the real ones: a way to renew only when it was asked for (Google: access_type=offline; the others: offline_access).
    const wants = g.scope.split(" ").includes("offline_access") || g.scope.includes("access_type=offline")
    if (wants) renewals.set(renew, g)
    return { access_token: crypto.randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 3600, id_token: idToken(g), ...(wants ? { refresh_token: renew } : {}) }
  }

  const server = http.createServer(async (req, res) => {
    const at = new URL(req.url ?? "/", url)
    const m = /^\/(google|okta|microsoft\/([\w-]+)\/v2\.0)(\/.*)?$/.exec(at.pathname)
    const send = (status: number, body: unknown, head: Record<string, string> = {}) =>
      res
        .writeHead(status, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store", ...head })
        .end(typeof body === "string" ? body : JSON.stringify(body))
    if (!m) return send(404, { error: "not_found" })
    const kind = m[1]!.split("/")[0] as Person["at"]
    const tenant = m[2]
    const iss = `${url}/${m[1]}`
    const sub = m[3] ?? ""
    const page = (title: string, body: string) =>
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:20px;font:16px/1.6 ui-sans-serif,system-ui,sans-serif}
main{width:100%;max-width:340px;display:grid;gap:12px}h1{font-size:20px;margin:0}p{margin:0;color:gray;font-size:14px}
a.who{display:grid;padding:10px 12px;border:1px solid color-mix(in srgb,CanvasText 20%,Canvas);border-radius:10px;color:inherit;text-decoration:none}a.who small{color:gray}</style>
<main><h1>${esc(title)}</h1>${body}</main></html>`

    if (sub === "/.well-known/openid-configuration")
      return send(200, {
        issuer: iss,
        authorization_endpoint: `${iss}/authorize`,
        token_endpoint: `${iss}/token`,
        jwks_uri: `${iss}/keys`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      })
    if (sub === "/keys") return send(200, { keys: [jwk] })
    if (sub === "/authorize") {
      const q = at.searchParams
      if (q.get("client_id") !== CLIENT.id) return send(400, page("Stand-in sign-in", "<p>This app is not registered here.</p>"))
      const list = people.filter((p) => p.at === kind)
      const name = kind === "google" ? "Google" : kind === "microsoft" ? "Microsoft" : "Okta"
      return send(
        200,
        page(
          `Sign in with ${name}`,
          `<p>Stand-in for ${name}: pick who you are. No password, no real account.</p>${list.map((p) => `<a class="who" href="${iss}/as?${esc(new URLSearchParams({ ...Object.fromEntries(q), person: p.email }).toString())}"><b>${esc(p.name)}</b><small>${esc(p.email)}${p.gone ? " · has left" : ""}</small></a>`).join("")}`,
        ),
      )
    }
    if (sub === "/as") {
      const q = at.searchParams
      const person = find(kind, q.get("person") ?? "")
      const redirect = q.get("redirect_uri") ?? ""
      if (!person || q.get("client_id") !== CLIENT.id || !redirect) return send(400, page("Stand-in sign-in", "<p>Nobody by that name here.</p>"))
      // What the real ones do themselves: a person who left, or an account from another directory, never gets back to the app.
      if (person.gone) return send(403, page("You can't sign in", "<p>This account has been removed by its company.</p>"))
      if (kind === "microsoft" && person.tid !== tenant) return send(403, page("You can't sign in", "<p>This account does not exist in this company's directory.</p>"))
      const code = crypto.randomBytes(16).toString("hex")
      const scope = `${q.get("scope") ?? ""}${q.get("access_type") === "offline" ? " access_type=offline" : ""}`
      codes.set(code, { person, iss, client: CLIENT.id, redirect, nonce: q.get("nonce") ?? undefined, challenge: q.get("code_challenge") ?? undefined, scope })
      const to = new URL(redirect)
      to.searchParams.set("code", code)
      if (q.get("state")) to.searchParams.set("state", q.get("state")!)
      return send(302, "", { location: to.href })
    }
    if (sub === "/token" && req.method === "POST") {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1]
      const [id, secret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [form.get("client_id"), form.get("client_secret")]
      if (id !== CLIENT.id || secret !== CLIENT.secret) return send(401, { error: "invalid_client" })
      if (form.get("grant_type") === "refresh_token") {
        const g = renewals.get(form.get("refresh_token") ?? "")
        if (!g || g.iss !== iss || g.person.gone) return send(400, { error: "invalid_grant", error_description: "The account is gone or the grant was taken away." })
        const out = tokens(g)
        return send(200, { ...out, refresh_token: form.get("refresh_token") })
      }
      const g = codes.get(form.get("code") ?? "")
      codes.delete(form.get("code") ?? "")
      if (!g || g.iss !== iss || g.redirect !== form.get("redirect_uri")) return send(400, { error: "invalid_grant" })
      if (
        g.challenge &&
        g.challenge !==
          crypto
            .createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url")
      )
        return send(400, { error: "invalid_grant", error_description: "PKCE" })
      return send(200, tokens(g))
    }
    send(404, { error: "not_found" })
  })
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url,
    google: `${url}/google`,
    microsoft: `${url}/microsoft/${TENANT}/v2.0`,
    okta: `${url}/okta`,
    people,
    /** The person leaves the company (or comes back). */
    leaves: (email: string, gone = true) => people.filter((p) => p.email === email).forEach((p) => void (p.gone = gone)),
    /** What a browser does on the stand-in's page: pick a person. Gives the address the person is sent back to, or the page that turned them away. */
    async pick(authorizeUrl: string, email: string) {
      const u = new URL(authorizeUrl)
      u.pathname = u.pathname.replace(/\/authorize$/, "/as")
      u.searchParams.set("person", email)
      const res = await fetch(u, { redirect: "manual" })
      return { status: res.status, location: res.headers.get("location") ?? undefined, text: res.status === 302 ? "" : await res.text() }
    },
    close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const idp = await standIn(Number(process.argv[2] ?? 4199))
  console.log(`stand-in login at ${idp.url}\n  google     ${idp.google}\n  microsoft  ${idp.microsoft}\n  okta       ${idp.okta}\n  client id  ${CLIENT.id}\n  secret     ${CLIENT.secret}`)
}
