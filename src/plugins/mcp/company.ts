import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import http from "node:http"
import { promisify } from "node:util"
import type { ClientCapabilities } from "@modelcontextprotocol/client"
import { Client, type OAuthClientProvider, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client"

const exec = promisify(execFile)

function openBrowser(url: URL) {
  if (process.platform === "darwin") return exec("open", [url.href])
  if (process.platform === "win32") return exec("rundll32.exe", ["url.dll,FileProtocolHandler", url.href])
  return exec("xdg-open", [url.href])
}

/** Use the same OAuth and HTTP MCP as chat connectors. Keep the authorization in this process only. */
export async function signIn(address: URL, signal: AbortSignal, browse: (url: URL) => Promise<unknown> = openBrowser, capabilities?: ClientCapabilities): Promise<Client> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  const state = randomBytes(32).toString("base64url")
  let verifier = ""
  let registered: Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>
  let tokens: Awaited<ReturnType<OAuthClientProvider["tokens"]>>
  let discovery: Awaited<ReturnType<NonNullable<OAuthClientProvider["discoveryState"]>>>
  let callback!: (params: URLSearchParams) => void
  const returned = new Promise<URLSearchParams>((resolve) => {
    callback = resolve
  })
  let redirect: URL
  const server = http.createServer((req, res) => {
    const received = new URL(req.url ?? "/", redirect)
    res.setHeader("content-type", "text/plain; charset=utf-8")
    res.setHeader("cache-control", "no-store")
    if (req.method !== "GET" || received.origin !== redirect.origin || received.pathname !== redirect.pathname || received.searchParams.get("state") !== state) {
      res.writeHead(400).end("This sign-in request does not match Flowbound.")
      return
    }
    res.end(received.searchParams.has("code") ? "You can return to Flowbound in your agent app." : "Flowbound sign-in was canceled.")
    callback(received.searchParams)
  })
  const stop = () => {
    server.close()
    server.closeAllConnections()
  }
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirect
    },
    get clientMetadata() {
      return {
        client_name: "Flowbound agent plugin",
        redirect_uris: [redirect.href],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }
    },
    state: () => state,
    clientInformation: () => registered,
    saveClientInformation: (value) => {
      registered = value
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value
    },
    saveCodeVerifier: (value) => {
      verifier = value
    },
    codeVerifier: () => verifier,
    discoveryState: () => discovery,
    saveDiscoveryState: (value) => {
      discovery = value
    },
    redirectToAuthorization: async (url) => {
      if (url.origin !== address.origin) throw new Error("The sign-in address did not match your company Flowbound.")
      if (!server.listening) throw new UnauthorizedError()
      await browse(url).catch(() => {
        throw new Error("Flowbound could not open your browser for work sign-in. Open the agent app on your computer and try again.")
      })
    },
  }
  const transport = () =>
    new StreamableHTTPClientTransport(address, {
      authProvider: provider,
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.origin !== address.origin) throw new Error("Company Flowbound sent a request outside its own address.")
        return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })
      },
    })
  const attempt = async (http: StreamableHTTPClientTransport) => {
    const client = new Client({ name: "Flowbound agent plugin", version: "1" }, { capabilities })
    try {
      await client.connect(http, { signal: lifetime })
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }
  const onAbort = () => callback(new URLSearchParams())
  lifetime.addEventListener("abort", onAbort, { once: true })
  try {
    lifetime.throwIfAborted()
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
    const bound = server.address()
    if (!bound || typeof bound === "string") throw new Error("Could not start Flowbound's local sign-in callback.")
    redirect = new URL(`http://127.0.0.1:${bound.port}/sign-in`)
    const first = transport()
    try {
      return await attempt(first)
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error
    }
    const params = await returned
    lifetime.throwIfAborted()
    if (!params.has("code")) throw new Error("Work sign-in was canceled. Try the Flowbound tool again to sign in.")
    await first.finishAuth(params)
    return await attempt(transport())
  } finally {
    lifetime.removeEventListener("abort", onAbort)
    stop()
  }
}
