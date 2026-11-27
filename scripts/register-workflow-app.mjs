// Run by the repository owner. GitHub's manifest exchange streams the private key to Vercel without a key file.
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"

const [repository, scope, project, homepage, orgFlag] = process.argv.slice(2)
const words = /^[a-z0-9][a-z0-9_.-]*$/i
const names = repository?.split("/") ?? []
if (names.length !== 2 || names.some((name) => !words.test(name)) || !words.test(scope ?? "") || !words.test(project ?? "") || !homepage?.startsWith("https://") || (orgFlag && orgFlag !== "--org")) {
  console.error("Usage: node scripts/register-workflow-app.mjs OWNER/REPO VERCEL_TEAM VERCEL_PROJECT https://FLOWBOUND_URL [--org]")
  process.exit(1)
}

const [owner] = names
const manifest = JSON.parse(readFileSync(new URL("../.github/flowbound-app.json", import.meta.url), "utf8"))
manifest.name += ` (${owner})`
manifest.url = new URL(homepage).href
const state = randomBytes(32).toString("hex")
const action = new URL(orgFlag ? `https://github.com/organizations/${owner}/settings/apps/new` : "https://github.com/settings/apps/new")
action.searchParams.set("state", state)
const html = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
const finish = (response, status, body) => {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" })
  response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Flowbound GitHub App</title><main>${body}</main>`)
}
let used = false
const server = createServer(async (request, response) => {
  if (request.method !== "GET" || request.headers.host !== new URL(manifest.redirect_url).host) return finish(response, 404, "Open the setup address shown in your terminal.")
  const url = new URL(request.url, manifest.redirect_url)
  if (url.pathname === "/") {
    return finish(
      response,
      200,
      `<h1>Register the Flowbound GitHub App</h1><p>GitHub will show the app and ask you to create it. The private key goes to Production for <strong>${html(project)}</strong> in Vercel.</p><form method="post" action="${html(action.href)}"><input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>`,
    )
  }

  const code = url.searchParams.get("code") ?? ""
  if (used || url.pathname !== "/callback" || url.searchParams.get("state") !== state || !/^[a-z0-9]+$/i.test(code)) return finish(response, 400, "The registration request could not be verified.")
  used = true
  try {
    const result = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      redirect: "error",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    })
    if (!result.ok) throw new Error("exchange")
    const app = await result.json()
    if (!Number.isSafeInteger(app.id) || !/^-----BEGIN (RSA )?PRIVATE KEY-----/.test(app.pem) || !words.test(app.slug)) throw new Error("response")

    const target = ["production"]
    const values = [
      { key: "FLOWBOUND_GITHUB_PRIVATE_KEY", type: "sensitive", target, value: app.pem },
      { key: "FLOWBOUND_GITHUB_APP_ID", type: "plain", target, value: String(app.id) },
      { key: "FLOWBOUND_GITHUB_REPO", type: "plain", target, value: repository },
    ]
    const saved = spawnSync("vercel", ["api", `/v10/projects/${project}/env`, "--scope", scope, "--method", "POST", "--input", "-", "--raw"], {
      input: JSON.stringify(values),
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "ignore"],
    })
    if (saved.status !== 0 || JSON.parse(saved.stdout)?.failed?.length) throw new Error("secret store")
    finish(
      response,
      200,
      `<h1>App registered</h1><p>The private key is in Vercel Production. <a href="https://github.com/apps/${app.slug}/installations/new">Install the App</a> on ${html(repository)} only. Add the installation ID to Vercel Production as FLOWBOUND_GITHUB_INSTALLATION_ID.</p>`,
    )
  } catch {
    finish(response, 502, "The setup did not finish. Check the App in GitHub and the production variables in Vercel before trying again.")
  } finally {
    server.close()
  }
})
server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`
  manifest.redirect_url = `${url}/callback`
  console.log(`Open ${url} on this computer to register the GitHub App.`)
})
