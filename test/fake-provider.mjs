// An honest fake provider for tests: answers like a people-data API, counts its calls, can be told to misbehave.
import http from "node:http"
const MANUAL = `# Acme People API

A small people-data API (a test provider that runs on this machine).

- Address: http://127.0.0.1:4999
- Key: send it in the header \`x-api-key\`
- Price: $0.002 for every call, found or not
- Speed limit: 20 calls a second

## POST /v2/head
Find the head of sales at a company.
Body: \`{"company": "<company name>"}\`
Found: 200 \`{"found": true, "person": {"full_name": "...", "linkedin_url": "https://..."}}\`
Not found: 404 \`{"found": false}\`

## POST /v2/email
Find a person's work email from their LinkedIn URL.
Body: \`{"linkedin_url": "https://..."}\`
Found: 200 \`{"found": true, "email": "..."}\`
Not found: 200 \`{"found": false, "email": null}\`
`
let calls = 0, mode = process.env.MODE ?? "ok", delay = 0
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {}
  const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)) }
  if (req.url === "/docs") { res.writeHead(200, { "content-type": "text/markdown" }); return res.end(MANUAL) }
  if (req.url === "/_calls") return send(200, { calls })
  if (req.url.startsWith("/_delay/")) { delay = Number(req.url.split("/")[2]); return send(200, { delay }) }
  if (req.url.startsWith("/_mode/")) { mode = req.url.split("/")[2]; return send(200, { mode }) }
  if (req.headers["x-api-key"] !== "sk-test-123") return send(401, { message: "bad key" })
  if (req.url === "/v2/me") return send(200, { account: "fake" }) // where a typed key is tried, at no cost
  calls++
  if (delay) await new Promise((r) => setTimeout(r, delay))
  if (mode === "busy") return send(429, { message: "too many requests" })
  if (mode === "empty") return send(200, { found: false })
  if (req.url === "/v2/head") { const n = Number(String(body.company).replace(/\D/g, "")) ; return n % 10 === 7 ? send(404, { found: false }) : send(200, { found: true, person: { full_name: "Head Of " + body.company, linkedin_url: "https://linkedin.example/in/" + body.company.toLowerCase() } }) }
  if (req.url === "/v2/email") { const n = Number(String(body.linkedin_url).replace(/\D/g, "")); return n % 5 === 3 ? send(200, { found: false, email: null }) : send(200, { found: true, email: body.linkedin_url.split("/").pop() + "@corp.example" }) }
  // A FAKE model: the shape of the Messages API, a made-up answer, token counts worked out from the text.
  if (req.url === "/v1/messages") { const prompt = String(body.messages?.[0]?.content ?? ""); return send(200, { id: "msg_fake_" + calls, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "FAKE one-liner (" + prompt.length + " characters read)" }], stop_reason: "end_turn", usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 25 } }) }
  send(400, { message: "unknown path" })
}).listen(4999, "127.0.0.1", () => console.log("fake provider on 4999"))
