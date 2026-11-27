import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Who } from "../../core/plugin.ts"
import { Refused } from "../../core/server.ts"
import { attributed, authorLine, branchPrefix, type Change, type Check, checkNames, lines, type Repository, requester, type Save, stale } from "./model.ts"

type Result = { ok: boolean; out: string }
function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<Result> {
  return new Promise((done) => {
    const child = execFile(command, args, { cwd, env, timeout: 10 * 60_000, maxBuffer: 4_000_000 }, (error, out) => done({ ok: !error, out }))
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
}

type Trial = { base: string; head: string; checks: Check[]; done: Promise<void>; candidate?: string; blocked?: string }

export class LocalGit implements Repository {
  private readonly root: string
  private readonly project: string
  private readonly baseRef: string
  private readonly bin: string
  private readonly trials = new Map<string, Trial>()
  private checking = Promise.resolve()
  private opening = Promise.resolve<unknown>(undefined)
  private readonly previews = new Map<string, { candidate: string; tree: string; child: ChildProcess; url?: string }>()
  private stopped = false

  private constructor(root: string, project: string, branch: string, bin: string) {
    this.root = root
    this.project = project
    this.baseRef = `refs/heads/${branch}`
    this.bin = bin
  }

  static open(project: string, branch: string, bin: string) {
    try {
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root, stdio: "ignore" })
      if (branch.startsWith(branchPrefix)) return undefined
      return new LocalGit(root, path.relative(root, fs.realpathSync(project)), branch, bin)
    } catch {
      return undefined
    }
  }

  private git(args: string[], input?: string, env?: NodeJS.ProcessEnv, cwd = this.root) {
    return run(cwd, "git", ["-c", "core.hooksPath=/dev/null", ...args], env, input)
  }

  private async take(args: string[], input?: string, env?: NodeJS.ProcessEnv, cwd?: string) {
    const result = await this.git(args, input, env, cwd)
    if (!result.ok) throw new Refused("Git could not finish the change. Check the project checkout and try again.", undefined, 409)
    return result.out.trimEnd()
  }

  private ref(id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Refused("Use the local change ID Flowbound showed you.")
    return `refs/heads/${branchPrefix}${id}`
  }

  private async head(ref: string) {
    const result = await this.git(["show-ref", "--hash", "--verify", ref])
    if (!result.ok) throw new Refused("This change could not be found.", undefined, 404)
    return result.out.trim()
  }

  private file(file: string) {
    return this.project ? path.posix.join(this.project, file) : file
  }

  private async readFile(head: string, file: string) {
    const name = this.file(file)
    const entry = await this.take(["ls-tree", head, "--", name])
    if (!entry) return null
    const [mode, , blob] = entry.split(/\s+/)
    if (mode !== "100644") throw new Refused("Only regular workflow files can be read or saved.")
    if (Number(await this.take(["cat-file", "-s", blob!])) > 512_000) throw new Refused("This workflow file is too large to open here.")
    const { ok, out } = await this.git(["cat-file", "blob", blob!])
    if (!ok || out.includes("\0")) throw new Refused("This workflow is not a text file.")
    return out
  }

  async read(id: string | undefined, file: string) {
    const head = await this.head(id ? this.ref(id) : this.baseRef)
    return { head, text: await this.readFile(head, file) }
  }

  private async person(who: Who) {
    const name = await this.git(["config", "user.name"])
    const email = await this.git(["config", "user.email"])
    return {
      ...process.env,
      GIT_AUTHOR_NAME: who.kind === "local" && name.ok ? name.out.trim() : attributed(who),
      GIT_AUTHOR_EMAIL: who.email ?? (who.kind === "local" && email.ok ? email.out.trim() : "flowbound@users.noreply.github.com"),
      GIT_COMMITTER_NAME: "Flowbound",
      GIT_COMMITTER_EMAIL: "flowbound@users.noreply.github.com",
    }
  }

  private async patch(input: Save, who: Who, undoOf?: string) {
    const { head, title, edits } = input
    const env = { ...(await this.person(who)), GIT_INDEX_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flowbound-index-")), "index") }
    try {
      await this.take(["read-tree", head], undefined, env)
      let count = 0
      for (const edit of edits) {
        const previous = await this.readFile(head, edit.path)
        if (previous === edit.text) continue
        const file = this.file(edit.path)
        if (edit.text === null) await this.take(["update-index", "--force-remove", "--", file], undefined, env)
        else {
          const blob = await this.take(["hash-object", "-w", "--stdin"], edit.text, env)
          await this.take(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], undefined, env)
        }
        count++
      }
      if (!count) throw new Refused("These workflow files have no changes.")
      const tree = await this.take(["write-tree"], undefined, env)
      return this.take(["commit-tree", tree, "-p", head, "-m", title, "-m", undoOf ? `${authorLine(who)}\n\nReverts ${undoOf}.` : authorLine(who)], undefined, env)
    } finally {
      fs.rmSync(path.dirname(env.GIT_INDEX_FILE), { recursive: true, force: true })
    }
  }

  async save(input: Save, who: Who) {
    const base = await this.head(this.baseRef)
    const id = input.id ?? randomUUID().replaceAll("-", "")
    const ref = this.ref(id)
    if (input.id) {
      if ((await this.head(ref)) !== input.head) throw stale()
      if (await this.published(id, base)) throw new Refused("This change was already published. Save a new change.")
    } else if (input.head !== base) throw stale()
    const commit = await this.patch(input, who)
    const saved = await this.git(["update-ref", ref, commit, input.id ? input.head : "0".repeat(40)])
    if (!saved.ok) throw stale()
    return this.change(id)
  }

  private async published(id: string, base: string) {
    return (await this.take(["log", "-1", "--first-parent", "--format=%H", `--grep=^Flowbound-Change: ${id}$`, base])) || undefined
  }

  private async addTree(head: string) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "flowbound-change-"))
    try {
      await this.take(["worktree", "add", "--quiet", "--detach", folder, head])
      const project = path.join(folder, this.project)
      for (const relative of new Set(["", this.project])) {
        const installed = path.join(this.root, relative, "node_modules")
        const target = path.join(folder, relative, "node_modules")
        if (fs.existsSync(installed) && !fs.existsSync(target)) fs.symlinkSync(installed, target, "dir")
      }
      return { folder, project }
    } catch (error) {
      await this.removeTree(folder)
      throw error
    }
  }

  private async removeTree(folder: string) {
    await this.git(["worktree", "remove", "--force", folder])
    fs.rmSync(folder, { recursive: true, force: true })
  }

  private isolated() {
    return { PATH: process.env.PATH, HOME: os.homedir(), LANG: process.env.LANG, FLOWBOUND_PREVIEW: "1", GIT_TERMINAL_PROMPT: "0" }
  }

  private trial(id: string, base: string, head: string, title: string): Trial {
    const previous = this.trials.get(id)
    if (previous?.head === head && previous.base === base) return previous
    const trial: Trial = { base, head, checks: checkNames.map((name) => ({ name, state: "waiting" })), done: Promise.resolve() }
    trial.done = this.checking
      .then(async () => {
        if (this.stopped || this.trials.get(id) !== trial) return
        const tree = await this.git(["merge-tree", "--write-tree", base, head])
        if (!tree.ok) {
          trial.blocked = "Resolve the Git conflict before publishing. The published files have stayed as they were."
          return
        }
        const merged = await this.take(["commit-tree", tree.out.trim(), "-p", base, "-p", head, "-m", title, "-m", `Flowbound-Change: ${id}`], undefined, {
          ...process.env,
          GIT_AUTHOR_NAME: "Flowbound",
          GIT_AUTHOR_EMAIL: "flowbound@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Flowbound",
          GIT_COMMITTER_EMAIL: "flowbound@users.noreply.github.com",
        })
        const { folder, project } = await this.addTree(merged)
        try {
          const env = this.isolated()
          const pkg = path.join(project, "package.json")
          const scripts = fs.existsSync(pkg) ? (JSON.parse(fs.readFileSync(pkg, "utf8")).scripts ?? {}) : {}
          const ts = [project, folder].map((p) => path.join(p, "node_modules", "typescript", "bin", "tsc")).find(fs.existsSync)
          const tasks: [string, string[]][] = [
            scripts.types ? ["npm", ["run", "types"]] : [ts ? process.execPath : "tsc", [...(ts ? [ts] : []), "--noEmit"]],
            [process.execPath, [this.bin, "workflow-check"]],
            scripts.test ? ["npm", ["test"]] : [process.execPath, ["--test"]],
          ]
          for (const [i, [command, args]] of tasks.entries()) {
            const result = await run(project, command, args, env)
            trial.checks[i]!.state = result.ok ? "passed" : "failed"
          }
          if (trial.checks.every((check) => check.state === "passed")) trial.candidate = merged
        } finally {
          await this.removeTree(folder)
        }
      })
      .catch(() => {
        trial.blocked = "Could not run the local checks. See the Changes guide for setup."
      })
    this.checking = trial.done
    this.trials.set(id, trial)
    return trial
  }

  async change(id: string): Promise<Change> {
    const [head, base] = await Promise.all([this.head(this.ref(id)), this.head(this.baseRef)])
    const [title, by, body, at] = (await this.take(["show", "-s", "--format=%s%x00%an%x00%b%x00%cI", head])).split("\0")
    const common = { id, title: title!, branch: branchPrefix + id, head, by: requester(body) ?? by, at: at?.trim() }
    const published = await this.published(id, base)
    if (published) return { ...common, state: "published", published, checks: checkNames.map((name) => ({ name, state: "passed" })) }
    const trial = this.trial(id, base, head, title)
    const preview = this.previews.get(id)
    return {
      ...common,
      state: "open",
      checks: trial.checks,
      blocked: trial.blocked,
      preview: preview && preview.candidate === trial.candidate ? preview.url : undefined,
      previewState: preview && preview.candidate === trial.candidate && preview.url ? "Preview ready" : "Open a local preview",
    }
  }

  async list(published = false) {
    const ids = lines(await this.take(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", `refs/heads/${branchPrefix}`]))
    const base = await this.head(this.baseRef)
    const result: Change[] = []
    for (const branch of ids) {
      const id = branch.slice(branchPrefix.length)
      if (/^[a-f0-9]{32}$/.test(id) && Boolean(await this.published(id, base)) === published) result.push(await this.change(id))
    }
    return result
  }

  async publish(id: string, head: string, _who: Who) {
    const current = await this.change(id)
    if (current.head !== head) throw stale()
    if (current.state === "published") return current
    const trial = this.trials.get(id)!
    if (trial.blocked) throw new Refused(trial.blocked, undefined, 409)
    if (!trial.candidate) throw new Refused("All three checks must pass before publishing.", { checks: trial.checks }, 409)
    const checkedOut = (await this.git(["symbolic-ref", "HEAD"])).out.trim()
    if (checkedOut !== this.baseRef) throw new Refused(`Check out ${this.baseRef.slice(11)} before publishing locally.`, undefined, 409)
    if (await this.take(["status", "--porcelain", "--untracked-files=no"])) throw new Refused("Commit or put away your working changes before publishing.", undefined, 409)
    if ((await this.head(this.baseRef)) !== trial.base || (await this.head(this.ref(id))) !== head) throw stale()
    await this.take(["merge", "--ff-only", "--no-edit", trial.candidate])
    return this.change(id)
  }

  async undo(id: string, who: Who) {
    const base = await this.head(this.baseRef)
    const merge = await this.published(id, base)
    if (!merge) throw new Refused("Undo needs a published change.")
    const { folder } = await this.addTree(base)
    try {
      const reverted = await this.git(["revert", "--no-commit", "-m", "1", merge], undefined, await this.person(who), folder)
      if (!reverted.ok) throw new Refused("A later change touched the same lines. Revert this merge in Git.", undefined, 409)
      const tree = await this.take(["write-tree"], undefined, undefined, folder)
      if (tree === (await this.take(["rev-parse", `${base}^{tree}`]))) throw new Refused("This change was already undone.")
      const title = (await this.take(["show", "-s", "--format=%s", merge])).slice(0, 90)
      const commit = await this.take(["commit-tree", tree, "-p", base, "-m", `Revert: ${title}`, "-m", `${authorLine(who)}\n\nReverts ${merge}.`], undefined, await this.person(who))
      const newId = randomUUID().replaceAll("-", "")
      if ((await this.head(this.baseRef)) !== base) throw stale()
      await this.take(["update-ref", this.ref(newId), commit, "0".repeat(40)])
      return this.change(newId)
    } finally {
      await this.removeTree(folder)
    }
  }

  private async closePreview(id: string) {
    const preview = this.previews.get(id)
    if (!preview) return
    this.previews.delete(id)
    if (preview.child.exitCode === null && preview.child.signalCode === null) {
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          preview.child.kill("SIGKILL")
          done()
        }, 4000)
        preview.child.once("exit", () => {
          clearTimeout(timer)
          done()
        })
        preview.child.kill("SIGTERM")
      })
    }
    await this.removeTree(preview.tree)
  }

  preview(id: string, head: string): Promise<Change> {
    const next = this.opening.then(() => this.openPreview(id, head))
    this.opening = next.catch(() => {})
    return next
  }

  private async openPreview(id: string, head: string) {
    const change = await this.change(id)
    if (change.state !== "open") throw new Refused("Open a preview for an unpublished change.")
    if (change.head !== head) throw stale()
    const trial = this.trials.get(id)!
    if (!trial.candidate) throw new Refused("Wait for the checks to pass before opening the local preview.", { checks: trial.checks }, 409)
    if (change.preview) return change
    for (const open of this.previews.keys()) await this.closePreview(open)
    const { folder, project } = await this.addTree(trial.candidate)
    const child = spawn(process.execPath, [this.bin, "dev", "--port", "0"], { cwd: project, env: { ...this.isolated(), FLOWBOUND_CHILD: "1" }, stdio: ["ignore", "pipe", "ignore"] })
    const preview: { candidate: string; tree: string; child: ChildProcess; url?: string } = { candidate: trial.candidate, tree: folder, child }
    this.previews.set(id, preview)
    child.stdout?.on("data", (chunk: Buffer) => {
      const address = /pages at (http:\/\/localhost:\d+)/.exec(chunk.toString())?.[1]
      if (address) preview.url = address
    })
    child.on("error", () => {})
    for (let attempt = 0; attempt < 80 && !preview.url && child.exitCode === null; attempt++) await new Promise((resolve) => setTimeout(resolve, 250))
    if (!preview.url) {
      await this.closePreview(id)
      throw new Refused("The local preview could not start.", undefined, 409)
    }
    child.once("exit", () => {
      if (this.previews.get(id) === preview) void this.closePreview(id)
    })
    return this.change(id)
  }

  async stop() {
    this.stopped = true
    await this.opening
    await this.checking
    for (const id of this.previews.keys()) await this.closePreview(id)
  }
}
