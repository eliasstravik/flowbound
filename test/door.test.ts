// The live door, against a stand-in for the company's login (test/stand-in-idp.ts): no account anywhere, nothing paid.
// A live Flowbound runs in-process; "browsers" are cookie jars; the chat app is walked by hand, the way Claude does it.
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { wanted } from "../scripts/door-tables.ts"
import { plugin, use } from "../src/core/plugin.ts"
import { boot, listen } from "../src/core/server.ts"
import { type DoorOptions, door, privateAddress } from "../src/plugins/door.ts"
import { ledger } from "../src/plugins/ledger.ts"
import { signIn } from "../src/plugins/mcp/company.ts"
import { mcp } from "../src/plugins/mcp.ts"
import { pages } from "../src/plugins/pages.ts"
import { CLIENT, standIn, TENANT } from "./stand-in-idp.ts"

const U = "https://fb.example"
const CALLBACK = "https://claude.ai/api/mcp/auth_callback"
let idp: Awaited<ReturnType<typeof standIn>>
before(async () => {
  idp = await standIn()
  process.env.FLOWBOUND_SECRET = "host-secret-for-test"
  for (const k of Object.keys(process.env)) if (/^FLOWBOUND_(LOGIN|PASSWORD|MANAGERS)/.test(k)) delete process.env[k]
})
/** The two values a company pastes from its login's console. */
const pasted = (on: boolean) =>
  on ? Object.assign(process.env, { FLOWBOUND_LOGIN_CLIENT_ID: CLIENT.id, FLOWBOUND_LOGIN_CLIENT_SECRET: CLIENT.secret }) : (delete process.env.FLOWBOUND_LOGIN_CLIENT_ID, delete process.env.FLOWBOUND_LOGIN_CLIENT_SECRET)
after(() => idp.close())

/** A few tools the way plugins write them: one to read, one that changes something, one that passes on a yes to spending. */
const desk = () =>
  plugin({
    name: "desk",
    needs: ["ledger"],
    tools: {
      look: { about: "read", role: "viewer", run: (_i, who) => ({ who }) },
      change: { about: "change", run: (_i, who) => ({ who }) },
      approve: {
        about: "a yes to spending, passed on",
        role: "member",
        run: async (_i, who) => use("ledger").yesOf(await use("ledger").yes({ workflow: "find-sales-heads", hash: "h", maxUsd: 5, who })),
      },
    },
  })

async function live(opts: DoorOptions, url = U) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-door-"))
  // The records part, in memory: a live Flowbound's own postgres plugin wants a real database address.
  const db = new PGlite()
  const records = plugin({
    name: "records",
    provides: "records",
    async start(fb) {
      for (const p of fb.plugins) for (const sql of p.migrations ?? []) await db.exec(`create schema if not exists fb_${p.name}; ${sql}`)
      return { query: async (sql: string, params?: unknown[]) => ((r) => ({ rows: r.rows, count: r.affectedRows ?? r.rows.length, columns: r.fields.map((f) => f.name) }))(await db.query(sql, params as any[])) }
    },
  })
  pasted(!!opts.login)
  const app = await boot([records, ledger(), pages(), mcp(), door(opts), desk()], { root, url, live: true })
  /** A person's browser: it keeps cookies, and follows the sign-in from Flowbound to the login and back. */
  const browser = () => {
    const jar = new Map<string, string>()
    const call = async (to: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      // What a real browser adds to a form it posts. The door's own calls to the engine must not pass these on.
      if (headers.get("content-type") === "application/x-www-form-urlencoded")
        for (const [k, v] of Object.entries({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", origin: url })) headers.set(k, v)
      if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "))
      const res = await app.fetch(new Request(to.startsWith("http") ? to : url + to, { ...init, headers }))
      for (const c of res.headers.getSetCookie()) {
        const [, k, v] = /^([^=]+)=([^;]*)/.exec(c)!
        if (v && !/max-age=0/i.test(c)) jar.set(k!, v)
        else jar.delete(k!)
      }
      return res
    }
    /** Open an address and go where it sends you, picking `as` on the login's page. Ends on a page, or outside Flowbound. */
    const go = async (to: string, as?: string): Promise<{ status: number; text: string; at: string }> => {
      for (let i = 0; i < 12; i++) {
        if (to.startsWith(idp.url)) {
          const picked = await idp.pick(to, as ?? "nobody")
          if (!picked.location) return { status: picked.status, text: picked.text, at: to }
          to = picked.location
          continue
        }
        if (to.startsWith("http") && !to.startsWith(url)) return { status: 302, text: "", at: to }
        const res = await call(to)
        const next = res.headers.get("location")
        if (res.status !== 302 || !next) return { status: res.status, text: await res.text(), at: to }
        to = next
      }
      throw new Error("too many redirects")
    }
    const tool = async (name: string, input: unknown = {}) => {
      const res = await call(`/api/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-flowbound-via": "page" }, body: JSON.stringify(input) })
      return { status: res.status, ...((await res.json().catch(() => ({}))) as { ok?: boolean; result?: any; error?: string }) }
    }
    return { call, go, tool, signIn: (as: string, to = "/people") => go(`/door/login?to=${encodeURIComponent(to)}`, as), jar }
  }
  const rpc = async (token: string | undefined, method: string, params?: unknown) => {
    const res = await app.fetch(
      new Request(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    )
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as any }
  }
  /** Connect a chat app the way Claude does: find out how to sign in, register, send the person to allow it, swap the code. */
  const connect = async (b: ReturnType<typeof browser>, as: string, answer = "allow") => {
    const no = await rpc(undefined, "tools/list")
    assert.equal(no.status, 401)
    const resource = await (await b.call(/resource_metadata="([^"]+)"/.exec(no.headers.get("www-authenticate")!)![1]!)).json()
    assert.equal(resource.resource, `${url}/mcp`)
    const issuer = new URL(resource.authorization_servers[0])
    const meta = await (await b.call(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json()
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"])
    // The app's own server does this part: it has none of the person's cookies.
    const server = (to: string, init: RequestInit) => app.fetch(new Request(to, init))
    const made = await server(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    })
    assert.equal(made.status, 201)
    const client = (await made.json()).client_id as string
    const verifier = crypto.randomBytes(32).toString("base64url")
    const ask = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: CALLBACK,
      state: "s1",
      scope: "openid profile email offline_access",
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: `${url}/mcp`,
    })
    // However the person's browser asks, it is sent on to a page, never shown data.
    const asData = await app.fetch(new Request(`${meta.authorization_endpoint}?${ask}`, { headers: { accept: "*/*", "sec-fetch-mode": "cors" } }))
    assert.deepEqual([asData.status, new URL(asData.headers.get("location")!).pathname], [302, "/door"])
    // Not signed in: the sign-in page first. Signed in: the page that asks whether to allow the app.
    let shown = await b.go(`${meta.authorization_endpoint}?${ask}`)
    if (process.env.TRACE) console.log("authorize ->", shown.status, shown.at.slice(0, 120), shown.text.slice(0, 200))
    if (/Sign in · Flowbound/.test(shown.text)) {
      const to = JSON.parse(/el\("to2"\)\.value = (".*")/.exec(shown.text)![1]!)
      shown = await b.go(`/door/login?to=${encodeURIComponent(to)}`, as)
      if (process.env.TRACE) console.log("signed in ->", shown.status, shown.at.slice(0, 120), shown.text.slice(0, 120))
    }
    if (!/Allow an app/.test(shown.text)) return { shown }
    // Every blank in the page is filled in (one left over stops the page's script, and the Allow button with it).
    assert.doesNotMatch(shown.text, /__[A-Z]+__/)
    const query = JSON.parse(/getElementById\("query"\)\.value = (".*")/.exec(shown.text)![1]!)
    const tapped = await b.call("/door/allow", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query, answer }) })
    const back = new URL(tapped.headers.get("location")!)
    assert.equal(back.origin + back.pathname, CALLBACK)
    const form = (o: Record<string, string>) => server(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) })
    const swap = (o: Record<string, string> = {}) =>
      form({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", client_id: client, redirect_uri: CALLBACK, code_verifier: verifier, resource: `${url}/mcp`, ...o })
    const renew = (refresh_token: string) => form({ grant_type: "refresh_token", refresh_token, client_id: client, resource: `${url}/mcp` })
    return { shown, back, swap, renew }
  }
  const sql = async (text: string, params?: unknown[]) => (await db.query(text, params as any[])).rows as any[]
  return {
    app,
    browser,
    rpc,
    connect,
    sql,
    stop: async () => {
      await app.stop()
      await db.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
const google: DoorOptions = { login: "google", domain: "acme.example", managers: ["maya@acme.example"] }

test("company sign-in gives new colleagues Member access when the owner enables it", async () => {
  for (const options of [{ ...google, issuer: idp.google }, { login: "microsoft", tenant: TENANT, managers: ["maya@acme.example"], issuer: idp.microsoft } satisfies DoorOptions]) {
    const fb = await live({ ...options, defaultRole: "member" })
    try {
      const owner = fb.browser()
      assert.equal((await owner.signIn("maya@acme.example")).status, 200)
      assert.equal((await owner.tool("look")).result.who.role, "owner")
      const sam = fb.browser()
      assert.equal((await sam.signIn("sam@acme.example")).status, 200)
      assert.equal((await sam.tool("change")).result.who.role, "member")
      assert.equal((await sam.tool("set-rights", { email: "sam@acme.example", rights: "admin" })).status, 403)
      assert.equal((await fb.browser().signIn("olle@other.example")).status, 403)
      assert.equal((await owner.tool("remove-person", { email: "sam@acme.example" })).ok, true)
      assert.equal((await fb.browser().signIn("sam@acme.example")).status, 403)
    } finally {
      await fb.stop()
    }
  }
})

test("the company plugin signs in through its loopback callback and acts as the member", async (t) => {
  let fb!: Awaited<ReturnType<typeof live>>
  const server = await listen(0, async (port) => {
    fb = await live({ ...google, issuer: idp.google }, `http://127.0.0.1:${port}`)
    return fb.app.fetch
  })
  t.after(async () => {
    await server.close()
    await fb.stop()
  })
  const owner = fb.browser()
  await owner.signIn("maya@acme.example")
  assert.equal((await owner.tool("set-rights", { email: "sam@acme.example", rights: "member" })).ok, true)
  const browser = fb.browser()
  const client = await signIn(new URL(`http://127.0.0.1:${server.port}/mcp`), AbortSignal.timeout(15_000), async (address) => {
    const signInPage = await browser.go(address.href)
    const to = JSON.parse(/el\("to2"\)\.value = (".*")/.exec(signInPage.text)![1]!)
    const consent = await browser.signIn("sam@acme.example", to)
    assert.match(consent.text, /Allow an app/)
    const query = JSON.parse(/getElementById\("query"\)\.value = (".*")/.exec(consent.text)![1]!)
    const allow = await browser.call("/door/allow", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query, answer: "allow" }) })
    const back = new URL(allow.headers.get("location")!)
    const wrong = new URL(back)
    wrong.searchParams.set("state", "wrong")
    assert.equal((await fetch(wrong)).status, 400)
    assert.equal((await fetch(back)).status, 200)
  })
  t.after(() => client.close())
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["search", "execute"],
  )
  const result = await client.callTool({ name: "execute", arguments: { code: "return await flowbound.change({})" } })
  assert.equal(result.isError, undefined)
  const data = result.structuredContent as { result: { who: { email: string; role: string } } }
  assert.equal(data.result.who.email, "sam@acme.example")
  assert.equal(data.result.who.role, "member")
})

test("off is for your own computer: it will not start live, or on a public address", async () => {
  pasted(false)
  const start = (o: { live?: boolean; url: string }) => boot([plugin({ name: "records", provides: "records", start: () => ({ query: async () => ({ rows: [] }) }) }), door()], { root: os.tmpdir(), ...o })
  await assert.rejects(start({ live: true, url: U }), /Sign-in is off, and this Flowbound is live/)
  await assert.rejects(start({ url: "https://flowbound.acme.com" }), /is a public address/)
  for (const url of ["http://localhost:4111", "https://my-laptop.tailnet.ts.net/flowbound", "http://192.168.1.20:4111"]) await (await start({ url })).stop()
  assert.deepEqual(["http://127.0.0.1:4111", "https://flowbound.example", "http://172.20.0.3", "https://8.8.8.8"].map(privateAddress), [true, false, true, false])
  // A sign-in that could let anyone in is refused too: Google with no company and no list, Microsoft with no directory.
  pasted(true)
  for (const o of [{ login: "google" }, { login: "microsoft" }, { login: "google", domain: "acme.example" }] as DoorOptions[])
    await assert.rejects(boot([plugin({ name: "records", provides: "records", start: () => ({ query: async () => ({ rows: [] }) }) }), door(o)], { root: os.tmpdir(), live: true, url: U }), /sign-in is not set up/)
})

test("the company's own Google: an outsider is refused, signing in gives nothing by itself, a manager gives rights", async () => {
  const fb = await live({ ...google, issuer: idp.google })
  try {
    // Nobody is in before signing in: a page goes to the door, a call is turned away.
    const anyone = fb.browser()
    assert.match((await anyone.go("/people")).text, /Sign in with \$\{login\}/)
    assert.equal((await anyone.tool("look")).status, 401)

    // The manager named in the settings signs in with her work account and may do everything.
    const maya = fb.browser()
    const first = await maya.signIn("maya@acme.example")
    assert.equal(first.status, 200, (/const login = .*/.exec(first.text) ?? [first.text.slice(0, 300)])[0])
    assert.match(first.text, /<title>People · Flowbound<\/title>/)
    assert.match(first.text, /"name":"Maya Manager \(maya@acme.example\)","kind":"person","checked":true/)
    assert.deepEqual((await maya.tool("look")).result.who, { kind: "person", name: "Maya Manager (maya@acme.example)", checked: true, via: "page", email: "maya@acme.example", role: "owner" })

    // An outsider with a Google account at another company, and one with a private account, are refused and stay out.
    for (const [who, why] of [
      ["olle@other.example", /You signed in as olle@other.example. This Flowbound is for people at acme.example./],
      ["pat@gmail.example", /You signed in as pat@gmail.example. This Flowbound is for people at acme.example./],
    ] as const) {
      const out = fb.browser()
      const refused = await out.signIn(who)
      assert.equal(refused.status, 403)
      assert.match(refused.text.replace(/\\u003c/g, "<"), why)
      assert.equal((await out.tool("look")).status, 401)
      assert.match((await out.go("/runs")).text, /Sign in · Flowbound/)
    }
    assert.deepEqual(
      (await fb.sql("select email from fb_door.people order by 1")).map((r) => r.email),
      ["maya@acme.example"],
    )

    // A colleague signs in: he works there, and that alone gives him nothing.
    const sam = fb.browser()
    const waiting = await sam.signIn("sam@acme.example")
    assert.equal(waiting.status, 403)
    assert.match(waiting.text, /You are signed in as sam@acme.example. Nobody has given you rights here yet. Ask maya@acme.example./)
    assert.equal((await sam.tool("look")).status, 403)

    // The manager gives him rights to edit. A member can approve runs, but cannot administer people.
    assert.equal((await maya.tool("set-rights", { email: "sam@acme.example", rights: "member" })).ok, true)
    assert.equal((await sam.go("/people")).status, 200)
    assert.equal((await sam.tool("change")).result.who.role, "member")
    assert.equal((await sam.tool("set-rights", { email: "sam@acme.example", rights: "admin" })).status, 403)
    assert.equal((await sam.tool("remove-person", { email: "maya@acme.example" })).status, 403)
    assert.equal((await sam.tool("people")).result.canManage, false)

    // The yes has a name on it: the manager's tap is saved with her checked work email.
    const yes = (await maya.tool("approve")).result
    assert.deepEqual([yes.who, yes.checked, yes.place, yes.max_usd], ["Maya Manager (maya@acme.example)", true, "page", 5])

    // Who changed what is kept, with before and after, and cannot be edited.
    const history = (await maya.tool("history")).result
    assert.deepEqual(history.map((h: any) => [h.who, h.through, h.what, h.on, h.before, h.after?.maxUsd ?? h.after]).reverse(), [
      ["Maya Manager (maya@acme.example)", "page", "rights", "sam@acme.example", "none", "member"],
      ["Maya Manager (maya@acme.example)", "page", "said yes", "find-sales-heads", null, 5],
    ])
    await assert.rejects(fb.sql("update fb_door.history set who = 'someone else'"), /cannot be changed or deleted/)
    await assert.rejects(fb.sql("delete from fb_door.history"), /cannot be changed or deleted/)
    assert.match((await maya.tool("history", { csv: true })).result.save.text, /^when,who,through,what,on,before,after\n"[^"]+","Maya Manager \(maya@acme.example\)","page","said yes"/)

    assert.equal((await sam.tool("approve")).ok, true)

    // Signing out ends it.
    await maya.call("/door/out", { method: "POST" })
    assert.equal((await maya.tool("look")).status, 401)
  } finally {
    await fb.stop()
  }
})

test("a person who left can no longer get in: the login refuses them, their agents stop within the hour, a manager's remove is at once", async () => {
  const fb = await live({ ...google, issuer: idp.google })
  try {
    const maya = fb.browser()
    await maya.signIn("maya@acme.example")
    await maya.tool("set-rights", { email: "sam@acme.example", rights: "member" })
    const sam = fb.browser()
    assert.equal((await sam.signIn("sam@acme.example")).status, 200)

    // Sam connects Claude, and makes a token for a script. Both act as him.
    const claude = await fb.connect(sam, "sam@acme.example")
    const got = await (await claude.swap!()).json()
    assert.equal(got.token_type, "Bearer")
    assert.equal(got.expires_in, 3600)
    const made = (await sam.tool("make-token", { label: "nightly script" })).result.token as string
    const asWho = async (token: string) => JSON.parse((await fb.rpc(token, "tools/call", { name: "execute", arguments: { code: `return await flowbound.change({})` } })).body.result.content[0].text).who
    assert.equal((await asWho(got.access_token)).name, "Claude, for Sam Seller (sam@acme.example)")
    assert.equal((await asWho(made)).name, "nightly script, for Sam Seller (sam@acme.example)")

    // An hour on, Flowbound asks the company's login again. He still works there: nothing changes.
    const hourOn = () => fb.sql("update fb_door.people set checked_at = now() - interval '61 minutes' where email = 'sam@acme.example'")
    await hourOn()
    assert.equal((await fb.rpc(got.access_token, "tools/list")).status, 200)
    assert.ok(Date.now() - new Date((await fb.sql("select checked_at from fb_door.people where email = 'sam@acme.example'"))[0].checked_at).getTime() < 60_000)

    // He leaves the company. His agents stop at the next check, and he cannot sign in again.
    idp.leaves("sam@acme.example")
    await hourOn()
    const stopped = await fb.rpc(got.access_token, "tools/list")
    assert.deepEqual([stopped.status, stopped.body.error], [401, "sam@acme.example has to sign in again: the company's login no longer vouches for them."])
    assert.equal((await fb.rpc(made, "tools/list")).status, 401)
    assert.equal((await fb.rpc(got.access_token, "tools/list")).status, 401)
    const renewed = await (await claude.renew!(got.refresh_token)).json()
    if (renewed.access_token) assert.equal((await fb.rpc(renewed.access_token, "tools/list")).status, 401)
    const again = await fb.browser().signIn("sam@acme.example")
    assert.deepEqual([again.status, /This account has been removed by its company/.test(again.text)], [403, true])

    // A manager does not have to wait for any of that: remove is at once, for the browser, the chat app and the token.
    // (He is hired back, and signs in again: that alone brings his agents back.)
    idp.leaves("sam@acme.example", false)
    assert.equal((await sam.signIn("sam@acme.example")).status, 200)
    assert.equal((await fb.rpc(made, "tools/list")).status, 200)
    assert.equal((await sam.tool("look")).status, 200)
    const removed = (await maya.tool("remove-person", { email: "sam@acme.example" })).result
    assert.deepEqual(removed, { email: "sam@acme.example", removed: true, tokensDropped: 1 })
    assert.equal((await sam.tool("look")).status, 401)
    assert.equal((await fb.rpc(made, "tools/list")).status, 401)
    assert.equal((await fb.rpc(got.access_token, "tools/list")).status, 401)
    const back = await sam.signIn("sam@acme.example")
    assert.match(back.text, /A manager removed sam@acme.example from this Flowbound./)
    assert.deepEqual((await maya.tool("people")).result.people.find((p: any) => p.email === "sam@acme.example").rights, "removed")
  } finally {
    idp.leaves("sam@acme.example", false)
    await fb.stop()
  }
})

test("a chat app signs in as a named person, and can never do more than they can", async () => {
  const fb = await live({ ...google, issuer: idp.google })
  try {
    // The person is not signed in when the app sends them here: the sign-in page first, then the question.
    const maya = fb.browser()
    const claude = await fb.connect(maya, "maya@acme.example")
    assert.match(claude.shown.text, /textContent = `Let \$\{"Claude"\} use this Flowbound\?`/)
    assert.match(claude.shown.text, /You are signed in as \$\{"Maya Manager \(maya@acme.example\)"\}/)
    assert.equal(claude.back!.searchParams.get("state"), "s1")
    // The code is swapped once, by the app that asked.
    assert.equal((await claude.swap!({ code_verifier: "wrong" })).status, 400)
    const got = await (await claude.swap!()).json()
    assert.ok(got.access_token && got.refresh_token)

    // The same signed-in connection opens the app and calls tools as "Claude, for" the person.
    const tools = (await fb.rpc(got.access_token, "tools/list")).body.result.tools
    assert.deepEqual(
      tools.map((t: any) => t.name),
      ["search", "execute", "show"],
    )
    const run = (tool: string) => fb.rpc(got.access_token, "tools/call", { name: "execute", arguments: { code: `return await flowbound["${tool}"]({})` } })
    const uri = tools.find((t: any) => t.name === "show")._meta.ui.resourceUri
    assert.equal((await fb.rpc(undefined, "resources/read", { uri })).status, 401)
    assert.equal((await fb.rpc(got.access_token, "resources/read", { uri })).body.result.contents[0].uri, uri)
    const shown = await fb.rpc(got.access_token, "tools/call", { name: "show", arguments: { page: "permissions" } })
    assert.equal(shown.body.result.structuredContent.view.path, "/permissions")
    assert.equal(shown.body.result._meta.flowbound.role, "member")
    const who = JSON.parse((await run("change")).body.result.content[0].text).who
    assert.deepEqual(who, { kind: "token", name: "Claude, for Maya Manager (maya@acme.example)", checked: true, via: "mcp", email: "maya@acme.example", role: "member", personName: "Maya Manager" })
    // Maya may approve: the app that acts for her passes her yes on, saved with its name. It still cannot manage.
    const passed = JSON.parse((await run("approve")).body.result.content[0].text)
    assert.deepEqual([passed.who, passed.place], ["Claude, for Maya Manager (maya@acme.example)", "chat"])
    assert.match((await run("set-rights")).body.result.content[0].text, /is for a person on a page, not for an agent/)
    // It renews by itself.
    const renewed = await (await claude.renew!(got.refresh_token)).json()
    assert.equal((await fb.rpc(renewed.access_token, "tools/list")).status, 200)
    // A coding agent on the person's own computer may come back over http to that computer; nothing else may.
    const register = async (redirect: string) =>
      (
        await fb.app.fetch(
          new Request(`${U}/door/auth/oauth2/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_name: "Codex", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
          }),
        )
      ).status
    assert.deepEqual([await register("http://localhost:4198/callback"), await register("http://evil.example/cb")], [201, 400])
    // The engine's other addresses (its own sign-in, changing a name) are not the world's to call.
    for (const p of ["sign-in/social", "update-user", "sign-in/team-password", "oauth2/consent", "get-session"])
      assert.equal((await maya.call(`/door/auth/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404)
    // A made-up token, and a call from another origin's browser.
    assert.equal((await fb.rpc("fb_live_nope", "tools/list")).status, 401)
    assert.equal((await fb.rpc("not.a.token", "tools/list")).status, 401)
    assert.equal((await fb.app.fetch(new Request(`${U}/mcp`, { method: "OPTIONS" }))).headers.get("access-control-allow-origin"), "*")

    // It is listed on the Connect page with her name, and she can take it away: it stops at once.
    const listed = (await maya.tool("tokens")).result
    assert.deepEqual([listed[0].kind, listed[0].label, listed[0].person], ["app", "Claude", "maya@acme.example"])
    assert.equal((await maya.tool("drop-token", { id: listed[0].id })).result.dropped, 1)
    assert.equal((await fb.rpc(got.access_token, "tools/list")).status, 401)

    // A code is good once: used again, the engine takes away what it gave for it.
    const again = await fb.connect(maya, "maya@acme.example")
    const twice = await (await again.swap!()).json()
    assert.notEqual((await again.swap!()).status, 200)
    assert.notEqual((await again.renew!(twice.refresh_token)).status, 200)

    // Somebody the company's login knows but Flowbound does not let in gets no further than the sign-in page.
    const olle = await fb.connect(fb.browser(), "olle@other.example")
    assert.match(olle.shown.text, /You signed in as olle@other.example/)
    assert.equal(olle.back, undefined)
  } finally {
    await fb.stop()
  }
})

test("a short list of emails: a small team on Google, everybody on the list may do everything", async () => {
  const fb = await live({ login: "google", emails: ["sam@acme.example", "pat@gmail.example"], issuer: idp.google })
  try {
    const pat = fb.browser()
    assert.equal((await pat.signIn("pat@gmail.example")).status, 200)
    assert.equal((await pat.tool("look")).result.who.role, "admin")
    const maya = await fb.browser().signIn("maya@acme.example")
    assert.deepEqual([maya.status, /That email is not on this Flowbound's list/.test(maya.text)], [403, true])
  } finally {
    await fb.stop()
  }
})

test("the company's own Microsoft: only its directory", async () => {
  const fb = await live({ login: "microsoft", tenant: TENANT, managers: ["maya@acme.example"], issuer: idp.microsoft })
  try {
    const maya = fb.browser()
    assert.equal((await maya.signIn("maya@acme.example")).status, 200)
    assert.equal((await maya.tool("look")).result.who.name, "Maya Manager (maya@acme.example)")
    // Microsoft itself turns away an account from another directory.
    const olle = await fb.browser().signIn("olle@other.example")
    assert.deepEqual([olle.status, /does not exist in this company's directory/.test(olle.text)], [403, true])
  } finally {
    await fb.stop()
  }
})

test("any provider (Okta): the same sign-in, and the login's groups set each person's rights", async () => {
  const fb = await live({ login: idp.okta, groups: { "flowbound-managers": "manage", "flowbound-sellers": "approve", "*": "view" } })
  try {
    const rights = async (email: string) => {
      const b = fb.browser()
      const page = await b.signIn(email)
      assert.equal(page.status, 200)
      return { b, role: (await b.tool("look")).result.who.role }
    }
    const maya = await rights("maya@acme.example")
    assert.deepEqual([maya.role, (await rights("sam@acme.example")).role, (await rights("vera@acme.example")).role], ["admin", "member", "viewer"])
    assert.equal((await (await rights("vera@acme.example")).b.tool("change")).status, 403)
    // Rights are IT's to set in the login, not a manager's here; a changed group counts from the next sign-in.
    assert.match((await maya.b.tool("set-rights", { email: "vera@acme.example", rights: "admin" })).error!, /come from the login's groups/)
    idp.people.find((p) => p.at === "okta" && p.email === "vera@acme.example")!.groups = ["flowbound-sellers"]
    assert.equal((await rights("vera@acme.example")).role, "member")
    assert.deepEqual((await maya.b.tool("history")).result[0], { ...(await maya.b.tool("history")).result[0], who: "The login's groups", what: "rights", on: "vera@acme.example", before: "viewer", after: "member" })
  } finally {
    await fb.stop()
  }
})

test("the team password stays for a first try-out: a typed name, marked as not checked", async () => {
  const fb = await live({ password: "team-pass-1" })
  try {
    const dana = fb.browser()
    const enter = (password: string, name: string) =>
      dana.call("/door/password", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password, name, to: "/people" }) })
    assert.match((await enter("nope", "Dana")).headers.get("location")!, /\/door\?no=password/)
    assert.equal((await dana.tool("look")).status, 401)
    assert.match((await enter("team-pass-1", "Dana")).headers.get("location")!, /\/door\/in\?to=/)
    assert.equal((await dana.go("/door/in?to=/people")).status, 200)
    const yes = (await dana.tool("approve")).result
    assert.deepEqual([yes.who, yes.checked], ["Dana", false])
    // A chat app still connects, as that unchecked name.
    const got = await (await (await fb.connect(dana, "")).swap!()).json()
    assert.equal(JSON.parse((await fb.rpc(got.access_token, "tools/call", { name: "execute", arguments: { code: `return await flowbound.change({})` } })).body.result.content[0].text).who.name, "Claude, for Dana")
  } finally {
    await fb.stop()
  }
})

test("the engine's tables are all in the door's own list of table changes", async () => {
  // When this fails after an upgrade of better-auth: node scripts/door-tables.ts, and add what it prints.
  assert.deepEqual(await wanted(), { sql: "", todo: 0 })
})
