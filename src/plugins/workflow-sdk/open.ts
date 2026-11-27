// The ways further into a workflow: its file in the person's editor, and the Workflow SDK's own page for its runs.
// "Open in the workflow UI" is one button that leads to the right place for where Flowbound runs: on your own
// computer (and on a server of your own) the SDK's own UI, served by this Flowbound; on Vercel, Vercel's own page.
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

/** Where this Flowbound runs: your own computer, Vercel, or a server of your own. */
export type Place = "local" | "vercel" | "server"
export const placeOf = (live: boolean): Place => (process.env.VERCEL ? "vercel" : live ? "server" : "local")

const onPath = (name: string) => (path.isAbsolute(name) ? fs.existsSync(name) : (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name))))
/** Editors that take a file and a line, and how each wants them said. The first one found is used. */
const EDITORS: [string, (file: string, line: number) => string[]][] = [
  ["code", (f, l) => ["-g", `${f}:${l}`]],
  ["cursor", (f, l) => ["-g", `${f}:${l}`]],
  ["windsurf", (f, l) => ["-g", `${f}:${l}`]],
  ["zed", (f, l) => [`${f}:${l}`]],
  ["subl", (f, l) => [`${f}:${l}`]],
  ["webstorm", (f, l) => ["--line", String(l), f]],
  ["idea", (f, l) => ["--line", String(l), f]],
]
/** The editor a file would open in on this computer: the one named, else the first known one that is installed, else whatever the system opens a file with. */
export function editorHere(named?: string): { name: string; args: (file: string, line: number) => string[] } | undefined {
  const want = named ?? process.env.FLOWBOUND_EDITOR
  if (want) return onPath(want) ? { name: want, args: EDITORS.find(([n]) => n === path.basename(want))?.[1] ?? ((f, l) => (l > 1 ? ["-g", `${f}:${l}`] : [f])) } : undefined
  for (const [name, args] of EDITORS) if (onPath(name)) return { name, args }
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? undefined : "xdg-open"
  return opener && onPath(opener) ? { name: opener, args: (f) => [f] } : undefined
}
/** Open a file at a line in the person's editor, on the computer Flowbound runs on. It is started and left alone. */
export function openInEditor(editor: NonNullable<ReturnType<typeof editorHere>>, file: string, line: number): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(editor.name, editor.args(file, Math.max(1, Math.floor(line) || 1)), { stdio: "ignore", detached: true })
    child.once("error", (e) => fail(new Error(`${editor.name} could not be started: ${e.message}`)))
    child.once("spawn", () => (child.unref(), done()))
  })
}

/**
 * The Workflow SDK's own UI, served from inside this Flowbound under `basename`. It comes with the `workflow`
 * package the project already has (workflow -> @workflow/cli -> @workflow/web), so nothing is installed for it.
 */
export async function workflowUi(root: string, basename: string, allowedHosts: string[]): Promise<(req: Request) => Promise<Response>> {
  const from = (dir: string, name: string) => createRequire(path.join(dir, "noop.js")).resolve(name)
  let entry: string | undefined
  for (const start of [root, path.dirname(new URL(import.meta.url).pathname)]) {
    for (const via of [["@workflow/web/handler"], ["workflow/package.json", "@workflow/cli/package.json", "@workflow/web/handler"]]) {
      try {
        entry = via.reduce((dir, name, n) => (n === via.length - 1 ? from(dir, name) : path.dirname(from(dir, name))), start)
        break
      } catch {}
    }
    if (entry) break
  }
  if (!entry) throw new Error("The Workflow SDK's own UI (@workflow/web) is not installed beside the workflow package.")
  const web = await import(pathToFileURL(entry).href)
  return web.createWorkflowWebHandler({ basename, allowedHosts })
}

/** What Vercel's sign-in for the project says about it: the team's and the project's own names, which its addresses are made of. */
export function vercelNames(token: string | null | undefined): { team: string; project: string } | undefined {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"))
    return typeof claims.owner === "string" && typeof claims.project === "string" ? { team: claims.owner, project: claims.project } : undefined
  } catch {
    return undefined
  }
}
/**
 * Vercel's own page for this project's workflow runs, or for one run. With the team's and project's names it is the
 * page itself. Without them it is Vercel's own "take me to my project" address, which asks the signed-in person
 * which project when it cannot tell: the form Vercel's manual uses for every link into a dashboard.
 */
export function vercelPage(o: { names?: { team: string; project: string }; run?: string; env?: string }): string {
  const tail = `/workflows${o.run ? `/runs/${encodeURIComponent(o.run)}` : ""}?environment=${o.env === "preview" ? "preview" : "production"}`
  if (o.names) return `https://vercel.com/${encodeURIComponent(o.names.team)}/${encodeURIComponent(o.names.project)}${tail}`
  return `https://vercel.com/d?to=${encodeURIComponent(`/[team]/[project]${tail}`)}&title=${encodeURIComponent(o.run ? "Workflow run" : "Workflow runs")}`
}
