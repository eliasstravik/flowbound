// Connect to a live Flowbound the way Claude or ChatGPT does, with the official MCP client and nothing but its address:
// find out how to sign in, register, send "the person" to allow it (here: a name, the team password and the Allow
// button, over HTTP), swap the code for a token, then list the tools and run a few lines with execute.
//   FLOWBOUND_PASSWORD=... node test/live/chat-app.mjs https://<address>/mcp
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client"

const address = new URL(process.argv[2] ?? "http://localhost:4130/mcp")
const password = process.env.FLOWBOUND_PASSWORD ?? process.env.FLOWBOUND_STAGING_PASSWORD
const CALLBACK = "https://claude.ai/api/mcp/auth_callback"
const mem = {}
let sentTo
const provider = {
  get redirectUrl() { return CALLBACK },
  get clientMetadata() { return { client_name: "Claude", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" } },
  clientInformation: () => mem.client,
  saveClientInformation: (c) => void (mem.client = c),
  tokens: () => mem.tokens,
  saveTokens: (t) => void (mem.tokens = t),
  redirectToAuthorization: (url) => void (sentTo = url),
  saveCodeVerifier: (v) => void (mem.verifier = v),
  codeVerifier: () => mem.verifier,
  saveDiscoveryState: (state) => void (mem.discovery = state),
  discoveryState: () => mem.discovery,
}
const say = (s) => console.log(s)
const connect = async () => {
  const transport = new StreamableHTTPClientTransport(address, { authProvider: provider })
  const client = new Client({ name: "claude-ai", version: "0" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } })
  return { transport, client, done: client.connect(transport) }
}

let c = await connect()
try {
  await c.done
  say("connected with no sign-in?! the door is open")
  process.exit(1)
} catch (e) {
  if (!(e instanceof UnauthorizedError) && !/unauthorized/i.test(String(e))) throw e
}
say(`1. no token: turned away, sent to sign in at ${sentTo.origin}${sentTo.pathname}`)
say(`   registered itself as "${mem.client.client_name}" (client id ${String(mem.client.client_id).length} chars), PKCE ${sentTo.searchParams.get("code_challenge_method")}, resource ${sentTo.searchParams.get("resource")}`)

// The person's part, in their browser: a cookie jar that goes where it is sent, inside this Flowbound.
const jar = new Map()
const browse = async (to, init = {}) => {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(new URL(to, sentTo), { redirect: "manual", ...init, headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } })
    for (const c of res.headers.getSetCookie()) jar.set(c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1).split(";")[0])
    const next = res.headers.get("location")
    if (res.status !== 302 || !next || new URL(next, sentTo).origin !== sentTo.origin) return { res, at: new URL(to, sentTo), next }
    to = next
    init = {}
  }
  throw new Error("sent in circles")
}
const first = await browse(sentTo)
say(`2. the person, not signed in: sent to ${first.at.pathname} (${/<title>([^<]+)/.exec(await first.res.text())[1]})`)
// The team password is the one sign-in a script can do by itself; a company's login needs the person.
const signedIn = await browse("/door/password", { method: "POST", body: new URLSearchParams({ password, name: process.env.FLOWBOUND_NAME ?? "Test Person", to: `/door/resume${first.at.search}` }) })
const page = await signedIn.res.text()
if (!/Allow an app/.test(page)) throw new Error(`the team password was not taken: ended at ${signedIn.at.pathname}`)
say(`3. signed in with the team password; the page asks: ${/<title>([^<]+)/.exec(page)[1]}`)
const query = JSON.parse(/getElementById\("query"\)\.value = (".*")/.exec(page)[1])
const allowed = await browse("/door/allow", { method: "POST", body: new URLSearchParams({ query, answer: "allow" }) })
const back = new URL(allowed.next)
say(`4. Allow: sent back to ${back.origin}${back.pathname} with a code`)

await c.transport.finishAuth(back.searchParams)
say(`5. code swapped for a token (${mem.tokens.token_type}; value kept in memory only)`)
c = await connect()
await c.done
say(`6. connected: ${c.client.getServerVersion().name} ${c.client.getServerVersion().version}, protocol ${c.transport.protocolVersion ?? "?"}`)
const { tools } = await c.client.listTools()
say(`7. tools: ${tools.map((t) => t.name).join(", ")}`)
const ran = await c.client.callTool({ name: "execute", arguments: { code: "return (await flowbound.tables({})).map((t) => t.name)" } })
say(`8. execute: ${ran.content[0].text.replace(/\s+/g, " ").slice(0, 160)}`)
if (process.env.FLOWBOUND_CHECK_GUIDE === "1") {
  const found = await c.client.callTool({ name: "search", arguments: { query: "docs" } })
  if (!found.content[0].text.includes("docs:")) throw new Error("the chat cannot find the guide")
  for (const topic of ["start", "workflow-sdk", "ledger", "recipes"]) {
    const guide = await c.client.callTool({ name: "execute", arguments: { code: `return await flowbound.docs({ topic: ${JSON.stringify(topic)} })` } })
    if (guide.isError || !guide.content[0].text.startsWith("#")) throw new Error(`the chat cannot read ${topic}`)
    say(`guide ${topic}: readable over MCP (${guide.content[0].text.length} characters)`)
  }
}
if (process.env.FLOWBOUND_CHECK_SOAK === "1") {
  const began = Date.now()
  for (const seconds of [0, 60, 120, 720, 900, 1200]) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, began + seconds * 1000 - Date.now())))
    const checked = await c.client.callTool({ name: "execute", arguments: { code: 'return { tables: (await flowbound.tables({})).length, permissions: (await flowbound.permissions({})).mode }' } })
    if (checked.isError) throw new Error(`soak failed: ${checked.content[0].text}`)
    say(`${new Date().toISOString()} · ${Math.round((Date.now() - began) / 1000)}s · MCP works${seconds === 720 ? " after ten minutes idle" : ""}: ${checked.content[0].text.replace(/\s+/g, " ")}`)
  }
}
if (process.env.FLOWBOUND_CHECK_RUN === "1") {
  const call = async (code) => {
    const out = await c.client.callTool({ name: "execute", arguments: { code } })
    if (out.isError) throw new Error(out.content[0].text)
    return out.structuredContent.result
  }
  const guide = await call('return await flowbound.docs({ topic: "start" })')
  if (!guide.includes("Git repo") || !guide.includes("pull request")) throw new Error("the chat guide does not explain the repo path")
  const workflows = await call("return await flowbound.workflows({ check: true })")
  const workflow = workflows.find((item) => item.hasDiagram && item.mode === "ask" && !item.problem)
  if (!workflow) throw new Error("no ready workflow with a diagram and ask mode to check without spending")
  say(`workflows: ${workflows.map((item) => item.id).join(", ")}`)
  const shown = await call(`return await flowbound.workflow({ id: ${JSON.stringify(workflow.id)} })`)
  if (!shown.diagram?.startsWith("<svg") || !shown.summary || !shown.code) throw new Error("the chat did not get the workflow's summary, diagram and code")
  say(`workflow ${shown.id}: summary, SVG diagram (${shown.diagram.length} characters), code; page ${shown.page}`)
  const run = await call(`return await flowbound.run({ workflow: ${JSON.stringify(workflow.id)}, try: 1, maxUsd: 0 })`)
  if (run.state !== "waiting" || !run.asks?.question || run.spent.usd !== 0 || run.spent.calls !== 0) throw new Error("the run did not stop for a yes without spending")
  const checked = await call(`return await flowbound.runs({ run: ${run.run} })`)
  if (checked.state !== "waiting" || checked.spent.usd !== 0 || checked.spent.calls !== 0) throw new Error("the run did not stay waiting without spending")
  say(`run ${run.run}: waiting for a yes, $0 and zero provider calls; question: ${run.asks.question}`)
  say(`run page: ${run.page}; no yes was sent`)
}
await c.client.close()
