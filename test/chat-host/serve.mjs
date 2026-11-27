// Serve the chat-app stand-in (never a real chat app: Flowbound's in-chat view is checked here) and pass /mcp on to a running Flowbound, so the page and the MCP server share an origin.
//   node test/chat-host/serve.mjs <flowbound address> [port] [bearer token]     (or the token in FLOWBOUND_TOKEN)
// Then open http://localhost:<port>/?run=1 (also ?table=, ?workflow=, &mode=fullscreen, &delay=3000 to see it loading)
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const [target = "http://localhost:4111", port = "4190", token = process.env.FLOWBOUND_TOKEN] = process.argv.slice(2)
const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = await esbuild.build({ entryPoints: [path.join(here, "host.js")], bundle: true, format: "esm", write: false, logLevel: "error" })
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat app stand-in</title>
<style>
:root{color-scheme:light dark}body{margin:0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;display:grid;justify-items:center;padding:16px}
main{width:100%;max-width:600px;display:grid;gap:12px}
h1{font-size:13px;font-weight:500;color:gray;margin:0}
#chat{display:grid;gap:10px}
.msg{padding:8px 14px;border-radius:14px;max-width:88%}.you{justify-self:end;background:CanvasText;color:Canvas}.agent{justify-self:start;background:color-mix(in srgb,CanvasText 8%,Canvas)}
.view{width:100%;border:1px solid color-mix(in srgb,CanvasText 14%,Canvas);border-radius:12px;height:0;display:block}
body.full{padding:0}body.full main{max-width:none}body.full #chat>:not(.view),body.full h1,body.full pre{display:none}body.full .view{position:fixed;inset:0;height:100dvh!important;border:0;border-radius:0}
pre{font:12px/1.5 ui-monospace,monospace;color:gray;white-space:pre-wrap;margin:0;border-top:1px solid color-mix(in srgb,CanvasText 12%,Canvas);padding-top:8px}
</style>
<main><h1>A chat app stand-in (official MCP Apps host bridge) talking to Flowbound over MCP</h1><div id="chat"></div><pre id="log"></pre></main>
<script type="module">${bundle.outputFiles[0].text.replace(/<\/script/g, "<\\/script")}</script></html>`

http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/mcp")) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const session = req.headers["mcp-session-id"]
      const headers = { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "application/json", ...(session ? { "mcp-session-id": session } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }
      const out = await fetch(target + req.url, { method: req.method, headers, body: ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : Buffer.concat(chunks) })
      res.writeHead(out.status, { "content-type": out.headers.get("content-type") ?? "application/json", ...(out.headers.get("mcp-session-id") ? { "mcp-session-id": out.headers.get("mcp-session-id") } : {}) })
      return res.end(Buffer.from(await out.arrayBuffer()))
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(page)
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`chat-app stand-in at http://localhost:${port}/?page=runs  ->  ${target}/mcp`))
