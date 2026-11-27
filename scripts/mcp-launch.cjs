// Portable plugin hosts can time out while npm downloads a cold install. Answer discovery immediately
// and start the real stdio server only when the user calls a tool.
const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Flowbound needs Node.js 22.18 or newer. This computer has Node.js ${process.versions.node}. Get the current LTS from https://nodejs.org and restart your agent app.`)
  process.exit(1)
}

const { spawn } = require("node:child_process")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
const source = path.join(__dirname, "../src/plugins/mcp/catalog.json")
const catalog = require(fs.existsSync(source) ? source : "../dist/plugins/mcp/catalog.json")
const { version } = require("../package.json")
const hello = randomUUID()
const requests = new Set()
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let initialize
let child
let closed = false

function start() {
  const args = ["-y", "flowbound", "mcp"]
  const running = process.platform === "win32" ? spawn("cmd.exe", ["/d", "/c", "npx", ...args], { stdio: ["pipe", "pipe", "inherit"] }) : spawn("npx", args, { stdio: ["pipe", "pipe", "inherit"] })
  child = running
  const write = (message) => running.stdin.write(`${JSON.stringify(message)}\n`)
  const stopped = () => {
    if (child !== running) return
    child = undefined
    if (closed) return
    for (const id of requests) {
      send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Flowbound could not start. Check the agent's MCP logs and try again." }] } })
    }
    requests.clear()
  }
  running.on("error", stopped).on("close", stopped)
  running.stdin.on("error", stopped)
  readline.createInterface({ input: running.stdout }).on("line", (line) => {
    try {
      const reply = JSON.parse(line)
      if (!closed && reply.id !== hello) {
        if (!reply.method) requests.delete(reply.id)
        send(reply)
      }
    } catch {}
  })
  write({ jsonrpc: "2.0", method: "initialize", params: initialize, id: hello })
  write({ jsonrpc: "2.0", method: "notifications/initialized" })
  return running
}

const input = readline.createInterface({ input: process.stdin })
input.on("line", (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (!request || typeof request !== "object") return
  const { method, id, params } = request
  const ok = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result })
  if (method === "initialize") {
    initialize = params
    return ok({
      protocolVersion: params && catalog.versions.includes(params.protocolVersion) ? params.protocolVersion : catalog.versions[0],
      capabilities: { tools: {} },
      serverInfo: { name: "flowbound", version },
      instructions: catalog.instructions,
    })
  }
  if (method === "ping") return ok({})
  if (method === "tools/list") return ok({ tools: catalog.tools })
  if (method === "resources/list") return ok({ resources: [] })
  if (method === "resources/templates/list") return ok({ resourceTemplates: [] })
  if (method === "tools/call" && id !== undefined) {
    requests.add(id)
    if (!child) start()
  }
  if (child) child.stdin.write(`${line}\n`)
  else if (method && !method.startsWith("notifications/") && id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Flowbound's MCP server has no ${method}.` } })
  }
})
input.on("close", () => {
  closed = true
  if (child) child.stdin.end()
})
