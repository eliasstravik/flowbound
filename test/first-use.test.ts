import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { repo } from "./helpers.ts"

test("two MCP clients set up an empty project once and the last one out stops its runner", { timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flowbound-first-use-"))
  const project = path.join(tmp, "project")
  const home = path.join(tmp, "home")
  fs.mkdirSync(project)
  fs.mkdirSync(home)
  const archive = execFileSync("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: repo, encoding: "utf8" }).trim()
  const clients: { stop(): Promise<void> }[] = []
  t.after(async () => {
    await Promise.all(clients.map((client) => client.stop()))
    // Wait for the managed runner to shut down before removing its database.
    for (let i = 0; i < 60 && fs.existsSync(path.join(project, ".flowbound", "dev.pid")); i++) await delay(250)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function open(cwd: string) {
    const child = spawn(process.execPath, [path.join(repo, "dist/core/start.js"), "mcp"], {
      cwd,
      env: { ...process.env, HOME: home, FLOWBOUND_HOME: home, FLOWBOUND_PORT: "0", FLOWBOUND_INSTALL: path.join(tmp, archive) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const exited = once(child, "exit")
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
    const client = {
      async ask(method: string, params: object) {
        send({ id: 1, method, params })
        for (;;) {
          const line = await lines.next()
          assert.ok(!line.done, stderr)
          const reply = JSON.parse(line.value)
          if (reply.method === "roots/list") {
            send({ id: reply.id, result: { roots: [{ uri: pathToFileURL(project).href }] } })
            continue
          }
          assert.equal(reply.id, 1)
          assert.ok(reply.result && !reply.result.isError, reply.result?.content?.[0]?.text ?? stderr)
          return reply.result
        }
      },
      async stop() {
        child.stdin.end()
        await exited
      },
    }
    clients.push(client)
    return client
  }

  const first = open(project)
  const second = open(home)
  await first.ask("initialize", { capabilities: {} })
  await second.ask("initialize", { capabilities: { roots: {}, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } })
  assert.ok(!fs.existsSync(path.join(project, "flowbound.config.ts")))
  const args = { name: "search", arguments: { query: "keys" } }
  const replies = await Promise.all([first.ask("tools/call", args), second.ask("tools/call", args)])
  for (const reply of replies) assert.match(reply.content[0].text, /keys: /)
  assert.ok(fs.existsSync(path.join(project, "flowbound.config.ts")))
  assert.ok(fs.existsSync(path.join(project, "node_modules/flowbound/package.json")))
  assert.ok(!fs.existsSync(path.join(home, "flowbound.config.ts")))

  const server = path.join(project, ".flowbound", "server.json")
  const { url, pid } = JSON.parse(fs.readFileSync(server, "utf8"))
  assert.equal((await fetch(`${url}/keys`)).status, 200)
  const view = { name: "execute", arguments: { code: 'return { flowboundView: { page: "runs" } }' } }
  const [linked, embedded] = await Promise.all([first.ask("tools/call", view), second.ask("tools/call", view)])
  assert.equal(linked.structuredContent.link, `${url}/runs`)
  assert.equal(linked._meta, undefined)
  assert.equal(embedded._meta.flowbound.view.path, "/runs")
  assert.ok(!JSON.stringify([embedded.content, embedded.structuredContent]).includes(url))
  await first.stop()
  await second.ask("tools/call", args)
  assert.equal(JSON.parse(fs.readFileSync(server, "utf8")).pid, pid)
  await second.stop()
  for (let i = 0; i < 60 && fs.existsSync(path.join(project, ".flowbound", "dev.pid")); i++) await delay(250)
  assert.ok(!fs.existsSync(path.join(project, ".flowbound", "dev.pid")))
  await assert.rejects(fetch(`${url}/keys`))
})
