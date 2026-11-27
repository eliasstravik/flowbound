// The shared pages use the host's connection inside chat. No cookies, credentials or requests from this frame.
import { App } from "@modelcontextprotocol/ext-apps"

const app = new App({ name: "Flowbound", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: false })
let display
let context
let stopSizing
let fallback
let siblings
function stopView() {
  siblings?.close()
  siblings = undefined
  stopSizing?.()
  stopSizing = undefined
  window.fb.stopRefresh()
  document.body.hidden = true
}
async function collapse() {
  stopView()
  await app.sendSizeChanged({ height: 0 })
}
function keepNewestRun(view, instance) {
  if (!view.params.run || !instance || typeof BroadcastChannel === "undefined") return
  // Hosts can sandbox each view into its own origin. When views share an origin,
  // announce only an ordering key, scoped to this Flowbound and run.
  let channel
  try {
    channel = new BroadcastChannel(`flowbound:${view.url}:run:${view.params.run}`)
  } catch {
    // An isolated sandbox can still show the run even if it cannot reach sibling views.
    return
  }
  siblings = channel
  channel.onmessage = ({ data }) => {
    if (typeof data?.instance !== "string") return
    if (data.instance > instance) return void collapse().catch(() => {})
    if (data.hello) channel.postMessage({ instance })
  }
  channel.postMessage({ instance, hello: true })
}
app.ontoolresult = async (result) => {
  const { view, report, role, tools, instance } = result._meta?.flowbound ?? {}
  if (result.isError || !view) return collapse()
  siblings?.close()
  siblings = undefined
  const query = new URLSearchParams(view.params)
  fallback = view.url + view.path + (query.size ? "?" + query : "")
  document.body.hidden = false
  stopSizing ??= app.setupSizeChangedNotifications()
  let status = "error"
  try {
    if ((await display({ ...view, role, tools })) !== false) {
      fallback = undefined
      status = "loaded"
      if (!document.body.hidden) keepNewestRun(view, instance)
    }
  } catch (error) {
    window.fb.trouble(error)
  }
  if (report) {
    void app.callServerTool({
      name: "execute",
      arguments: { code: "return null", render: false },
      _meta: { "flowbound/view-status": { status, platform: context?.platform } },
    }).catch(() => {})
  }
}
app.ontoolcancelled = collapse
app.onteardown = () => {
  stopView()
  return {}
}
app.onhostcontextchanged = (change) => update(change)

function update(change) {
  const before = document.body.dataset.mode
  context = { ...context, ...change }
  const theme = context.theme
  if (theme) {
    document.documentElement.dataset.theme = theme
    document.documentElement.classList.toggle("dark", theme === "dark")
  }
  document.body.dataset.mode = context.displayMode ?? "inline"
  const expand = document.getElementById("app-expand")
  if (expand) expand.hidden = context.displayMode === "fullscreen" || !context.availableDisplayModes?.includes("fullscreen")
  if (!document.body.hidden && before !== document.body.dataset.mode) window.fb.redraw()
}

async function tool(name, args) {
  const result = await app.callServerTool({ name, arguments: args })
  if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text ?? "Flowbound could not complete the request.")
  return result.structuredContent
}

window.FB_BRIDGE = {
  async start(show) {
    display = show
    const actions = document.getElementById("app-actions")
    const expand = window.fb.h("button", { id: "app-expand", class: "btn", type: "button", "data-variant": "outline", "data-size": "sm", hidden: true, onclick: async () => {
      try {
        const { mode } = await app.requestDisplayMode({ mode: "fullscreen" })
        update({ displayMode: mode })
      } catch (error) {
        window.fb.trouble(error)
      }
    } }, "Expand Flowbound")
    const web = window.fb.h("button", { class: "btn", type: "button", "data-variant": "ghost", "data-size": "sm", disabled: true, onclick: () => window.fb.act(web, () => this.open(fallback ?? (window.FB.url + window.fb.route()))) }, "Open web page")
    actions.replaceChildren(expand, web)
    actions.hidden = false
    display = (view) => {
      web.disabled = false
      return show(view)
    }
    await app.connect()
    update(app.getHostContext())
  },
  async call(name, input) {
    const code = `return await flowbound[${JSON.stringify(name)}](${JSON.stringify(input ?? {})})`
    return (await tool("execute", { code, render: false })).result
  },
  async open(url) {
    if ((await app.openLink({ url })).isError) throw new Error("The chat could not open this link.")
  },
}
