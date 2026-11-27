import path from "node:path"
import { fileURLToPath } from "node:url"
import { type Flowbound, plugin } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import { GitHub } from "./changes/github.ts"
import { LocalGit } from "./changes/local.ts"
import { type Change, type Edit, plain, type Repository, shaPattern, workflowFile } from "./changes/model.ts"
import { asset } from "./util.ts"

export type ChangesOptions = {
  /** A single owner/repo, installed in GitHub. Defaults to FLOWBOUND_GITHUB_REPO. */
  repo?: string
  /** The project's folder from the repository root, for example "staging". */
  directory?: string
  /** Local publish branch. Defaults to main. GitHub uses the repository's default branch. */
  branch?: string
  /** Names of the GitHub Actions jobs that must pass. Defaults to types, workflows and tests. */
  checks?: [string, string, string]
  /** Vercel project name when several deployment statuses are posted to a commit. */
  vercelProject?: string
}

const idInput = { about: "the change ID shown by workflow-changes or workflow-save", required: true }
const headInput = { about: "the commit shown by workflow-change or workflow-file, so a newer edit cannot be overwritten", required: true }
const idOf = (id: unknown) => {
  const s = String(id)
  if (!/^(?:[1-9][0-9]{0,11}|[a-f0-9]{32})$/.test(s)) throw new Refused("Use the change ID Flowbound showed you.")
  return s
}
const headOf = (head: unknown) => {
  if (typeof head !== "string" || !shaPattern.test(head)) throw new Refused("Use the commit shown by Flowbound.")
  return head
}
const fileOf = (file: unknown) => {
  if (typeof file !== "string" || file.length > 180 || !workflowFile.test(file)) throw new Refused("Use a TypeScript path under workflows/, such as workflows/find-sales-heads.ts.")
  return file
}

export function changes(options: ChangesOptions = {}) {
  let fb: Flowbound
  let repo: Repository | undefined
  let unavailable: string
  const local = () => {
    if (!repo && !fb.live && process.env.FLOWBOUND_PREVIEW !== "1" && process.env.VERCEL_ENV !== "preview") {
      const bin = fileURLToPath(new URL(`../core/bin${path.extname(import.meta.url)}`, import.meta.url))
      repo = LocalGit.open(fb.root, options.branch ?? "main", bin)
    }
    return repo
  }
  const need = () => {
    const found = local()
    if (!found) throw new Refused(unavailable, undefined, 409)
    return found
  }
  const shown = (change: Change) => ({ ...change, page: `${fb.url}/changes?id=${change.id}` })
  return plugin({
    name: "changes",
    start(f) {
      fb = f
      if (process.env.VERCEL_ENV === "preview" || process.env.FLOWBOUND_PREVIEW === "1") {
        unavailable = "This is a preview. Open your main Flowbound to save or publish."
        return
      }
      if (!fb.live) {
        unavailable = "This project needs a Git repository with a commit on main. Open the Changes guide for setup."
        return
      }
      const name = options.repo ?? process.env.FLOWBOUND_GITHUB_REPO
      const { FLOWBOUND_GITHUB_APP_ID: appId, FLOWBOUND_GITHUB_PRIVATE_KEY: key, FLOWBOUND_GITHUB_INSTALLATION_ID: installation } = process.env
      unavailable = "Connect the Flowbound GitHub App to this project to save and publish. See the Changes guide."
      if (name && appId && key && installation)
        repo = new GitHub({ name, appId, key, installation, directory: options.directory, checks: options.checks, vercelProject: options.vercelProject ?? process.env.FLOWBOUND_VERCEL_PROJECT })
    },
    stop: () => (repo instanceof LocalGit ? repo.stop() : undefined),
    pages: { "/changes": { title: "Changes", file: asset("changes/changes.html") } },
    docs: asset("changes/changes.md"),
    tools: {
      "workflow-file": {
        about: "Read a workflow file from Git. Get the commit to use when saving. A missing file returns null so you can create it.",
        role: "viewer",
        input: { file: { about: "path such as workflows/find-sales-heads.ts", required: true }, id: { about: "a saved change ID, or omit for the published branch" } },
        run: (i) => need().read(i.id === undefined ? undefined : idOf(i.id), fileOf(i.file)),
      },
      "workflow-changes": {
        about: "See unpublished workflow changes, including pull requests engineers opened in GitHub. Use published to find an earlier change to undo.",
        role: "viewer",
        input: { published: { type: "boolean", about: "show recent published changes instead" } },
        run: async (i) => {
          const found = local()
          return { changes: found ? (await found.list(i.published === true)).map(shown) : [], setup: found ? undefined : unavailable }
        },
      },
      "workflow-change": {
        about: "Open a saved workflow change. See its checks, preview and pull request. Members can start a local preview with startPreview.",
        role: "viewer",
        input: { id: idInput, startPreview: { type: "boolean", about: "start the local preview if it is not running" }, head: { about: headInput.about } },
        run: async (i, who) => {
          if (i.startPreview && need().preview) {
            if (!["local", "system"].includes(who.kind)) throw new Refused("Start the local preview on your computer.", undefined, 403)
            return shown(await need().preview!(idOf(i.id), headOf(i.head)))
          }
          return shown(await need().change(idOf(i.id)))
        },
      },
      "workflow-save": {
        about: "Save workflow code to a branch. This opens a change with a pull request on GitHub. It does not publish.",
        role: "member",
        input: {
          title: { about: "a short description of what changed", required: true },
          head: headInput,
          files: { type: "json", about: "array of {path, text}; text is the complete new file, or null to remove a file", required: true },
          id: { about: "the ID of an existing change to add a commit to" },
        },
        run: async (i, who) => {
          const title = typeof i.title === "string" ? plain(i.title) : ""
          if (!title || title.length > 100) throw new Refused("Give the change a title of 1 to 100 characters.")
          if (!Array.isArray(i.files) || !i.files.length || i.files.length > 20) throw new Refused("Send between 1 and 20 workflow files.")
          const edits: Edit[] = i.files.map((file: Edit) => {
            const p = fileOf(file?.path)
            if (file.text !== null && (typeof file.text !== "string" || file.text.includes("\0"))) throw new Refused("Each workflow needs its complete text, or null to remove it.")
            return { path: p, text: file.text }
          })
          if (new Set(edits.map((f) => f.path)).size !== edits.length || edits.reduce((n, f) => n + Buffer.byteLength(f.text ?? ""), 0) > 512_000)
            throw new Refused("Send each workflow only once, with no more than 500 KB of changes.")
          return shown(await need().save({ title, head: headOf(i.head), edits, id: i.id === undefined ? undefined : idOf(i.id) }, who))
        },
      },
      "workflow-publish": {
        about: "Publish a saved workflow change after its checks pass and GitHub allows the merge. Use the commit the person agreed to publish.",
        role: "member",
        input: { id: idInput, head: headInput },
        run: async (i, who) => shown(await need().publish(idOf(i.id), headOf(i.head), who)),
      },
      "workflow-undo": {
        about: "Save a revert of a published workflow change. The revert has its own checks and preview. Publish it to finish the undo.",
        role: "member",
        input: { id: idInput },
        run: async (i, who) => shown(await need().undo(idOf(i.id), who)),
      },
    },
  })
}
