// Shared privately under a path (a tailnet share at https://host/try): every start keeps that address, also one the
// MCP server or the command line makes later without FLOWBOUND_URL, so links open on the person's phone and the page
// finds its style sheet under the path.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, test } from "node:test"
import { project } from "./helpers.ts"

const p = project("http://127.0.0.1:9")
const env: NodeJS.ProcessEnv = p.env
const about = async () => (await (await fetch(`${p.url()}/api`)).json()) as { url: string }
const watcher = () => Number(fs.readFileSync(path.join(p.root, ".flowbound", "dev.pid"), "utf8"))

after(async () => {
  try {
    process.kill(watcher(), "SIGTERM")
  } catch {}
  await p.stop()
})

test("a shared address outlives the start that gave it, and a later one changes or forgets it", { timeout: 180_000 }, async () => {
  env.FLOWBOUND_URL = "https://box.example.ts.net/try"
  await p.start()
  assert.equal((await about()).url, "https://box.example.ts.net/try")
  const html = await (await fetch(`${p.url()}/home`)).text()
  assert.match(html, /href="\/try\/assets\/page\.css\?v=/)
  assert.equal((await fetch(`${p.url()}/try/assets/page.css`)).status, 200)

  // Gone without a goodbye, then started again the way the MCP server and the command line do, with no FLOWBOUND_URL.
  const port = p.url()
  p.kill()
  delete env.FLOWBOUND_URL
  delete env.FLOWBOUND_PORT
  await p.fb("tables --json")
  assert.equal((await about()).url, "https://box.example.ts.net/try")
  assert.equal(p.url(), port, "the share points at the same port")
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, ".flowbound", "share.json"), "utf8")), { url: "https://box.example.ts.net/try", port: Number(new URL(port).port) })
  assert.match(await (await fetch(`${p.url()}/keys`)).text(), /src="\/try\/assets\/page\.js/)

  // Another address while it runs: the running one restarts with it.
  env.FLOWBOUND_URL = "https://box.example.ts.net/other"
  assert.match(await p.fb("dev"), /Already running[\s\S]*shared at https:\/\/box\.example\.ts\.net\/other/)
  await p.until(async () => (await about().catch(() => ({ url: "" }))).url === "https://box.example.ts.net/other")

  // Set to nothing: forgotten, back to this computer's own address.
  env.FLOWBOUND_URL = ""
  await p.fb("dev")
  await p.until(async () => /^http:\/\/localhost:\d+$/.test((await about().catch(() => ({ url: "" }))).url))
  assert.equal(fs.existsSync(path.join(p.root, ".flowbound", "share.json")), false)
})
