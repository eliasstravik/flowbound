// A stand-in for a chat app, for seeing Flowbound's pages the way a chat app shows them. It is a real MCP client
// (the official SDK) and a real MCP Apps host (the official AppBridge from @modelcontextprotocol/ext-apps):
// it calls Flowbound's `show` tool, reads the view resource, puts it in a sandboxed frame and bridges the view's calls.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

const log = (line) => (document.getElementById("log").textContent += `${line}\n`)
const say = (who, text) => {
  const el = document.createElement("div")
  el.className = `msg ${who}`
  el.textContent = text
  document.getElementById("chat").append(el)
  return el
}

async function main() {
  const args = Object.fromEntries(new URLSearchParams(location.search))
  const input = { page: args.page ?? "runs", ...(args.run ? { run: Number(args.run) } : {}), ...(args.table ? { table: args.table } : {}), ...(args.workflow ? { workflow: args.workflow } : {}) }
  // It says it can show MCP Apps views, as a chat app that shows them does.
  const client = new Client({ name: "chat-host", version: "0" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } })
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.origin)))
  const { tools } = await client.listTools()
  log(`tools: ${tools.map((t) => t.name).join(", ")}`)
  const show = tools.find((t) => t.name === "show")
  const uri = show._meta.ui.resourceUri

  say("you", args.say ?? "Show me that.")
  const result = await client.callTool({ name: "show", arguments: input })
  say("agent", result.content[0].text.split("\n")[0])
  const resource = await client.readResource({ uri })
  log(`view: ${uri} (${resource.contents[0].mimeType}, ${resource.contents[0].text.length} bytes)`)

  const frame = document.createElement("iframe")
  frame.sandbox = "allow-scripts allow-forms"
  frame.className = "view"
  document.getElementById("chat").append(frame)
  const context = { theme: args.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), displayMode: args.mode ?? "inline", availableDisplayModes: ["inline", "fullscreen"], platform: innerWidth < 500 ? "mobile" : "web" }
  const bridge = new AppBridge(client, { name: "chat-host", version: "0" }, { openLinks: {}, serverTools: {} }, { hostContext: context })
  bridge.oninitialized = () => {
    log("view said hello (ui/initialize)")
    // ?mode=fullscreen&entry=1: opened from the app list, big, with no question asked and so no tool input.
    if (args.entry) return
    bridge.sendToolInput({ arguments: input })
    // ?delay=<ms>: the answer comes late, to see what the view shows while it waits.
    setTimeout(() => bridge.sendToolResult(result), Number(args.delay ?? 0))
  }
  if (args.mode === "fullscreen") document.body.classList.add("full")
  bridge.onsizechange = ({ height }) => {
    log(`view asked for height ${height}`)
    if (height !== undefined && context.displayMode === "inline") frame.style.height = `${height}px`
  }
  // Expand: the host gives the view the whole window.
  bridge.onrequestdisplaymode = async ({ mode }) => {
    log(`view asked for ${mode}`)
    context.displayMode = mode
    document.body.classList.toggle("full", mode === "fullscreen")
    bridge.sendHostContextChange({ displayMode: mode })
    return { mode }
  }
  bridge.onopenlink = async ({ url }) => {
    log(`view asked to open ${url}`)
    say("agent", `(the chat app opens ${url} in your browser)`)
    return {}
  }
  // The view's tool calls go to the MCP server, as a chat app passes them on.
  bridge.oncalltool = async (params) => {
    log(`view called ${params.name} ${JSON.stringify(params.arguments).slice(0, 120)}`)
    return client.callTool(params)
  }
  // Listen first, then load the view: it says hello as soon as it is loaded.
  await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow))
  // Like Claude, the view gets no network at all except what the server declared for it (here: its font).
  const allowed = (resource.contents[0]._meta?.ui?.csp?.resourceDomains ?? []).join(" ")
  const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: ${allowed}; font-src ${allowed || "'none'"}; connect-src 'none'`
  log(`view rules: ${csp}`)
  frame.srcdoc = resource.contents[0].text.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
}
main().catch((e) => log(`error: ${e.stack ?? e}`))
