// Stand-in for the live host: loads the functions `flowbound deploy` builds for Vercel and serves them on one port.
// The app function answers every address; the SDK's flow function gets the workflow queue's deliveries.
import http from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"

const PORT = Number(process.env.PORT ?? 4130)
process.env.FLOWBOUND_URL = `http://localhost:${PORT}`
process.env.WORKFLOW_TARGET_WORLD = "local" // on Vercel this is Vercel's own world; here the local one stands in
process.env.WORKFLOW_LOCAL_DATA_DIR = ".flowbound/live-workflow"
process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${PORT}`
const fn = (p) => import(pathToFileURL(path.resolve(".vercel/output/functions", p)).href)
const app = await fn("__app.func/index.mjs")
const flow = await fn(".well-known/workflow/v1/flow.func/index.mjs")
await (await (await import("workflow/runtime")).getWorld()).start?.()

http
  .createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
    const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) })
    const out = req.url.startsWith("/.well-known/workflow/v1/flow") ? await flow.POST(request) : await app.default.fetch(request)
    const head = {}
    out.headers.forEach((v, k) => k !== "set-cookie" && (head[k] = v))
    if (out.headers.getSetCookie().length) head["set-cookie"] = out.headers.getSetCookie()
    res.writeHead(out.status, head)
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  .listen(PORT, "127.0.0.1", () => console.log(`live stand-in on http://localhost:${PORT}`))
