import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function setting() {
  return path.join(process.env.FLOWBOUND_HOME ?? path.join(os.homedir(), ".flowbound"), "company.json")
}

export function companyAddress(input: string): URL {
  let url: URL | undefined
  try {
    url = new URL(input)
  } catch {}
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use your company's HTTPS Flowbound address, with no password, query or fragment.")
  }
  const base = url.pathname.replace(/\/+$/, "")
  url.pathname = base.endsWith("/mcp") ? base : `${base}/mcp`
  return url
}

export function company(): URL | undefined {
  try {
    const { address } = JSON.parse(fs.readFileSync(setting(), "utf8"))
    return companyAddress(address)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export function connect(args: string[]) {
  if (args.length === 0) {
    const address = company()
    return console.log(address ? `Company Flowbound at ${address.href}` : "Run here in the open project folder.")
  }
  if (args.length !== 1 || args[0] === "--help") {
    return console.log("flowbound connect https://your-company.example    Connect to your company\nflowbound connect --local                      Run here")
  }
  const file = setting()
  if (args[0] === "--local") {
    fs.rmSync(file, { force: true })
    return console.log("Run here is selected. Restart your agent app to use it.")
  }
  const address = companyAddress(args[0]!)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const pending = `${file}.${process.pid}`
  try {
    fs.writeFileSync(pending, JSON.stringify({ address: address.href }), { mode: 0o600, flag: "wx" })
    fs.renameSync(pending, file)
  } finally {
    fs.rmSync(pending, { force: true })
  }
  console.log(`Company Flowbound selected at ${address.href}. Restart your agent app, then sign in when Flowbound opens your browser.`)
}
