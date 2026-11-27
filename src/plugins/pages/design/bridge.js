// The shared pages use the host's connection inside chat. No cookies, credentials or requests from this frame.
import { App } from "@modelcontextprotocol/ext-apps"

const app = new App({ name: "Flowbound", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] })
let display
let context
app.ontoolresult = (result) => {
  const view = result.structuredContent?.view
  if (result.isError || !view) {
    window.fb.trouble(result.content?.find((item) => item.type === "text")?.text || "Flowbound could not open this view.")
    return
  }
  display({ ...view, ...result._meta?.flowbound })
}
app.ontoolcancelled = () => window.fb.trouble("Opening Flowbound was cancelled.")
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
  if (before !== document.body.dataset.mode) window.fb.redraw()
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
    const web = window.fb.h("button", { class: "btn", type: "button", "data-variant": "ghost", "data-size": "sm", onclick: () => window.fb.act(web, () => this.open(window.FB.url + window.fb.route())) }, "Open web page")
    actions.replaceChildren(expand, web)
    actions.hidden = false
    await app.connect()
    update(app.getHostContext())
  },
  async call(name, input) {
    const code = `return await flowbound[${JSON.stringify(name)}](${JSON.stringify(input ?? {})})`
    return (await tool("execute", { code })).result
  },
  async open(url) {
    if ((await app.openLink({ url })).isError) throw new Error("The chat could not open this link.")
  },
}
