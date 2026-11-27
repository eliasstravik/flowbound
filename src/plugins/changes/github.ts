import { createSign, randomUUID } from "node:crypto"
import type { Who } from "../../core/plugin.ts"
import { Refused } from "../../core/server.ts"
import { authorLine, branchPrefix, type Change, checkNames, type Edit, link, type Repository, requester, type Save, stale, workflowFile } from "./model.ts"

type Options = {
  name: string
  appId: string
  key: string
  installation: string
  directory?: string
  checks?: string[]
  vercelProject?: string
}
type Pull = {
  number: number
  title: string
  state: "open" | "closed"
  merged_at?: string
  body?: string | null
  updated_at?: string
  draft: boolean
  changed_files: number
  merge_commit_sha: string
  user: { login: string; type: string }
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string; sha: string }
}
type TreeEntry = { path: string; mode: string; sha: string }
type Review = { reviewDecision: string | null; mergeStateStatus: string; reviewRequests: { nodes: { requestedReviewer: { login?: string; slug?: string; organization?: { login: string } } | null }[] } }
type CheckRun = { id: number; name: string; head_sha: string; status: string; conclusion: string; html_url: string; app: { slug: string } | null }
type Deployment = { id: number; production_environment: boolean; environment: string; creator: { login: string } }
type DeploymentStatus = { state: string; environment_url: string }
class GitHubError extends Refused {
  constructor(status: number) {
    super("GitHub could not complete this request. Check the GitHub App installation or try again.", undefined, status)
    this.status = status
  }
}

export class GitHub implements Repository {
  private readonly options: Options
  private readonly request: typeof fetch
  private readonly prefix: string
  private readonly names: string[]
  private readonly repo: string
  private readonly web: string
  private token?: Promise<{ token: string; expires_at: string }>
  private app?: Promise<{ slug: string }>

  constructor(options: Options, request = fetch) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.name) || !/^\d+$/.test(options.appId) || !/^\d+$/.test(options.installation))
      throw new Refused("Set the GitHub App ID, installation ID, and its one owner/repo in the host settings.")
    if (options.directory && !/^[\w-]+(?:\/[\w-]+)*$/.test(options.directory)) throw new Refused("Use a project folder inside the configured GitHub repository.")
    this.options = options
    this.request = request
    this.prefix = options.directory ? `${options.directory}/` : ""
    this.names = options.checks ?? checkNames
    if (this.names.length !== checkNames.length || new Set(this.names).size !== checkNames.length || this.names.some((name) => !name.trim()))
      throw new Refused("Give the three distinct GitHub check names for types, workflows and tests.")
    this.repo = `/repos/${options.name}`
    this.web = `https://github.com/${options.name}`
  }

  private jwt() {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const now = Math.floor(Date.now() / 1000)
    const claim = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: this.options.appId })}`
    try {
      return `${claim}.${createSign("RSA-SHA256").update(claim).sign(this.options.key.replace(/\\n/g, "\n")).toString("base64url")}`
    } catch {
      throw new Refused("The GitHub App private key on this host could not be read.")
    }
  }

  private async fetchJson<T>(url: string, token: string, method = "GET", data?: unknown): Promise<T> {
    const res = await this.request(`https://api.github.com${url}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }).catch(() => {
      throw new GitHubError(503)
    })
    if (!res.ok) throw new GitHubError(res.status)
    return res.json()
  }

  private async installationToken() {
    if (this.token && Date.parse((await this.token).expires_at) < Date.now() + 60_000) this.token = undefined
    this.token ??= this.fetchJson<{ token: string; expires_at: string }>(`/app/installations/${this.options.installation}/access_tokens`, this.jwt(), "POST", {
      repositories: [this.options.name.split("/")[1]],
      permissions: { contents: "write", pull_requests: "write", checks: "read", deployments: "read", statuses: "read" },
    }).catch((error) => {
      this.token = undefined
      throw error
    })
    return (await this.token).token
  }

  private async api<T>(url: string, method?: string, data?: unknown) {
    return this.fetchJson<T>(url, await this.installationToken(), method, data)
  }

  private async graph<T>(query: string, variables: object, rejection?: Error): Promise<T> {
    const result = await this.api<{ data?: T; errors?: unknown[] }>("/graphql", "POST", { query, variables })
    if (!result.data || result.errors?.length) throw rejection ?? new GitHubError(422)
    return result.data
  }

  private async pages<T>(url: string) {
    const result: T[] = []
    for (let page = 1; page <= 30; page++) {
      const items = await this.api<T[]>(`${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
      result.push(...items)
      if (items.length < 100) break
    }
    return result
  }

  private async base() {
    const data = await this.api<{ full_name: string; default_branch: string }>(this.repo)
    if (data.full_name.toLowerCase() !== this.options.name.toLowerCase()) throw new Refused("The GitHub App installation points at a different repository.")
    return data.default_branch
  }

  private async ref(branch: string) {
    const { object } = await this.api<{ object: { sha: string } }>(`${this.repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`)
    return object.sha
  }

  private async pull(id: string) {
    if (!/^\d+$/.test(id)) throw new Refused("Use the GitHub change number shown by Flowbound.")
    try {
      return await this.api<Pull>(`${this.repo}/pulls/${id}`)
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) throw new Refused("This change could not be found.", undefined, 404)
      throw error
    }
  }

  private async owned(pull: Pull) {
    if (!pull.head.ref.startsWith(branchPrefix) || pull.user.type !== "Bot") return false
    this.app ??= this.fetchJson<{ slug: string }>("/app", this.jwt()).catch((error) => {
      this.app = undefined
      throw error
    })
    return pull.user.login === `${(await this.app).slug}[bot]`
  }

  private allowed(file: string) {
    return file.startsWith(this.prefix) && workflowFile.test(file.slice(this.prefix.length))
  }

  private files(id: number) {
    return this.pages<{ filename: string; previous_filename?: string }>(`${this.repo}/pulls/${id}/files`)
  }

  private async tree(head: string) {
    const { tree } = await this.api<{ tree: { sha: string } }>(`${this.repo}/git/commits/${head}`)
    const result = await this.api<{ tree: TreeEntry[]; truncated: boolean }>(`${this.repo}/git/trees/${tree.sha}?recursive=1`)
    if (result.truncated) throw new Refused("GitHub could not list all files in this tree. Open the change in GitHub.")
    return new Map(result.tree.map((file) => [file.path, file]))
  }

  private async text(file?: TreeEntry) {
    if (!file) return null
    if (file.mode !== "100644") throw new Refused("Only regular workflow files can be read or saved.")
    const data = await this.api<{ content: string; encoding: string; size: number }>(`${this.repo}/git/blobs/${file.sha}`)
    if (data.encoding !== "base64" || data.size > 512_000) throw new Refused("This workflow file is too large to open here.")
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data.content, "base64"))
    } catch {
      throw new Refused("This workflow is not a UTF-8 text file.")
    }
  }

  async read(id: string | undefined, file: string) {
    const pull = id ? await this.pull(id) : undefined
    const head = pull?.head.sha ?? (await this.ref(await this.base()))
    return { head, text: await this.text((await this.tree(head)).get(this.prefix + file)) }
  }

  private async checks(head: string): Promise<Change["checks"]> {
    const { check_runs } = await this.api<{ check_runs: CheckRun[] }>(`${this.repo}/commits/${head}/check-runs?filter=latest&per_page=100&app_id=15368`)
    return this.names.map((name) => {
      const job = check_runs.filter((job) => job.head_sha === head && job.name === name && job.app?.slug === "github-actions").sort((a, b) => b.id - a.id)[0]
      const state = !job || job.status !== "completed" ? "waiting" : job.conclusion === "success" ? "passed" : "failed"
      return { name, state, url: link(job?.html_url, (host) => host === "github.com") }
    })
  }

  private async previewStatus(head: string) {
    const deployments = await this.api<Deployment[]>(`${this.repo}/deployments?sha=${head}&per_page=30`)
    const deployment = deployments.find((d) => !d.production_environment && /^preview\b/i.test(d.environment) && d.creator?.login === "vercel[bot]")
    if (deployment) {
      const [latest] = await this.api<DeploymentStatus[]>(`${this.repo}/deployments/${deployment.id}/statuses?per_page=1`)
      const preview = latest?.state === "success" && link(latest.environment_url, (host) => host.endsWith(".vercel.app"))
      if (preview) return { preview, previewState: "Preview ready" }
      if (latest?.state === "failure" || latest?.state === "error") return { previewState: "Preview failed" }
    }

    // Some Vercel projects report only a commit status. It links to the immutable deployment's dashboard.
    const status = await this.api<{ statuses: { context: string; state: string; target_url: string }[] }>(`${this.repo}/commits/${head}/status?per_page=100`)
    const candidates = status.statuses.filter(({ context }) => (this.options.vercelProject ? context === `Vercel – ${this.options.vercelProject}` || context === "Vercel" : context === "Vercel"))
    const vercel = candidates[0]
    const preview = link(vercel?.target_url, (host) => host === "vercel.com")
    if (vercel?.state === "success" && preview && /^\/[\w.-]+\/[\w.-]+\/[\w-]+\/?$/.test(new URL(preview).pathname)) return { preview, previewState: "Preview ready on Vercel" }
    if (vercel?.state === "failure" || vercel?.state === "error") return { previewState: "Preview failed" }
    return { previewState: "Waiting for preview" }
  }

  private review(id: number) {
    const [owner, repo] = this.options.name.split("/")
    return this.graph<{ repository: { pullRequest: Review } }>(
      `query($owner:String!,$repo:String!,$id:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$id){
        reviewDecision mergeStateStatus reviewRequests(first:50){nodes{requestedReviewer{... on User{login} ... on Team{slug organization{login}}}}}
      }}}`,
      { owner, repo, id },
    ).then((r) => r.repository.pullRequest)
  }

  private reviewMessage(review: Review) {
    if (review.reviewDecision !== "REVIEW_REQUIRED" && review.reviewDecision !== "CHANGES_REQUESTED") return undefined
    const names = review.reviewRequests.nodes.flatMap(({ requestedReviewer: r }) => (r?.login ? [`@${r.login}`] : r?.slug && r.organization ? [`@${r.organization.login}/${r.slug}`] : []))
    return names.length ? `GitHub requires approval from ${names.join(", ")}.` : "GitHub requires approval from an eligible reviewer or code owner. Open the pull request to see the rule."
  }

  private async describe(p: Pull, files?: Awaited<ReturnType<GitHub["files"]>>): Promise<Change> {
    const state = p.merged_at ? "published" : p.state
    const change: Change = {
      id: String(p.number),
      title: p.title,
      branch: p.head.ref,
      head: p.head.sha,
      state,
      checks: [],
      pull: `${this.web}/pull/${p.number}`,
      external: !(await this.owned(p)),
      by: requester(p.body) ?? p.user.login,
      at: p.updated_at,
    }
    if (state === "published") change.published = p.merge_commit_sha
    if (state !== "open") return change
    const [checks, preview, review, paths, base] = await Promise.all([
      this.checks(p.head.sha),
      this.previewStatus(p.head.sha).catch(() => ({ previewState: "Preview status unavailable" })),
      this.review(p.number),
      files ?? this.files(p.number),
      this.base(),
    ])
    let blocked = this.reviewMessage(review)
    if (p.head.repo?.full_name.toLowerCase() !== this.options.name.toLowerCase() || p.base.ref !== base) blocked = "Publish this pull request in GitHub."
    else if (!paths.length || paths.length !== p.changed_files || paths.some((f) => !this.allowed(f.filename) || (f.previous_filename && !this.allowed(f.previous_filename))))
      blocked = "This pull request includes changes outside workflow files. Publish it in GitHub."
    else if (p.draft) blocked = "Mark the pull request ready for review in GitHub."
    else if (review.mergeStateStatus === "DIRTY") blocked = "Resolve the conflicts in GitHub before publishing."
    else if (review.mergeStateStatus === "BEHIND") blocked = "Update this branch in GitHub before publishing."
    return { ...change, ...preview, checks, blocked }
  }

  async change(id: string) {
    return this.describe(await this.pull(id))
  }

  async list(published = false) {
    const base = await this.base()
    const query = `${this.repo}/pulls?base=${encodeURIComponent(base)}`
    const recent = published ? (await this.api<Pull[]>(`${query}&state=closed&sort=updated&direction=desc&per_page=30`)).filter((pull) => pull.merged_at) : await this.pages<Pull>(`${query}&state=open`)
    const changes: Change[] = []
    for (const entry of recent) {
      const files = await this.files(entry.number)
      if (files.some((f) => this.allowed(f.filename) || (f.previous_filename && this.allowed(f.previous_filename)))) {
        const pull = await this.pull(String(entry.number))
        changes.push(await this.describe(pull, files))
      }
    }
    return changes
  }

  private async append(branch: string, head: string, title: string, body: string, edits: Edit[]) {
    const input = {
      branch: { repositoryNameWithOwner: this.options.name, refName: `refs/heads/${branch}` },
      expectedHeadOid: head,
      message: { headline: title, body },
      fileChanges: {
        additions: edits.flatMap((f) => (f.text === null ? [] : [{ path: this.prefix + f.path, contents: Buffer.from(f.text).toString("base64") }])),
        deletions: edits.flatMap((f) => (f.text === null ? [{ path: this.prefix + f.path }] : [])),
      },
    }
    await this.graph(
      "mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}",
      { input },
      new Refused("GitHub did not save this commit. Refresh the change and check the repository rules.", undefined, 409),
    )
  }

  private async newChange(head: string, title: string, edits: Edit[], who: Who, undoOf?: string) {
    const base = await this.base()
    if (head !== (await this.ref(base))) throw stale()
    const branch = branchPrefix + randomUUID().replaceAll("-", "")
    const body = `${authorLine(who)}${undoOf ? `\n\nReverts ${undoOf}.` : ""}`
    await this.api(`${this.repo}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: head })
    try {
      await this.append(branch, head, title, body, edits)
    } catch (error) {
      const current = await this.ref(branch).catch(() => undefined)
      if (!current || current === head) throw error
    }
    let pull: Pull
    try {
      pull = await this.api<Pull>(`${this.repo}/pulls`, "POST", { title, body, head: branch, base })
    } catch (_error) {
      const [found] = await this.pages<Pull>(`${this.repo}/pulls?state=open&head=${encodeURIComponent(`${this.options.name.split("/")[0]}:${branch}`)}`).catch(() => [])
      if (!found) throw new Refused(`The commit is saved on branch ${branch}. Open its pull request in GitHub, then return to Changes.`, undefined, 409)
      pull = found
    }
    return this.change(String(pull.number))
  }

  async save(input: Save, who: Who) {
    const { head, title, id } = input
    const pull = id ? await this.pull(id) : undefined
    if (pull && (pull.state !== "open" || pull.head.repo?.full_name.toLowerCase() !== this.options.name.toLowerCase() || !(await this.owned(pull))))
      throw new Refused("This pull request is read-only here. Save a new change or edit it in GitHub.")
    if (pull ? pull.head.sha !== head : (await this.ref(await this.base())) !== head) throw stale()
    const tree = await this.tree(head)
    const edits: Edit[] = []
    for (const edit of input.edits) {
      const previous = await this.text(tree.get(this.prefix + edit.path))
      if (previous !== edit.text) edits.push(edit)
    }
    if (!edits.length) throw new Refused("These workflow files have no changes.")
    if (!pull) return this.newChange(head, title, edits, who)
    await this.append(pull.head.ref, head, title, authorLine(who), edits)
    return this.change(id!)
  }

  private async regularFiles(pull: Pull) {
    const [base, head, files] = await Promise.all([this.tree(pull.base.sha), this.tree(pull.head.sha), this.files(pull.number)])
    for (const entry of files) {
      const before = base.get(entry.previous_filename ?? entry.filename)
      const after = head.get(entry.filename)
      if ((before && before.mode !== "100644") || (after && after.mode !== "100644")) throw new Refused("This change contains a workflow that is not a regular text file. Open the pull request in GitHub.")
    }
  }

  async publish(id: string, head: string, who: Who) {
    const pull = await this.pull(id)
    if (pull.head.sha !== head) throw stale()
    const change = await this.describe(pull)
    if (change.state === "published") return change
    if (change.state !== "open") throw new Refused("This pull request is closed.")
    if (change.blocked) throw new Refused(change.blocked, { pull: change.pull }, 409)
    if (change.checks.some((check) => check.state !== "passed")) throw new Refused("All three checks must pass before publishing.", { checks: change.checks }, 409)
    await this.regularFiles(pull)
    const base = await this.ref(pull.base.ref)
    const comparison = await this.api<{ status: string }>(`${this.repo}/compare/${base}...${head}`)
    if (comparison.status !== "ahead") throw new Refused("Update this branch in GitHub and wait for its checks before publishing.", { pull: change.pull }, 409)
    try {
      const result = await this.api<{ merged: boolean }>(`${this.repo}/pulls/${id}/merge`, "PUT", { sha: head, merge_method: "merge", commit_title: `${pull.title} (#${id})`, commit_message: authorLine(who) })
      if (!result.merged) throw new GitHubError(405)
    } catch (error) {
      if (!(error instanceof GitHubError) || ![403, 405, 409, 422].includes(error.status)) throw error
      const fresh = await this.change(id)
      if (fresh.state === "published" && fresh.head === head) return fresh
      if (fresh.head !== head) throw stale()
      throw new Refused(fresh.blocked ?? "GitHub blocked the merge. Open the pull request to see which approval or rule is still required.", { pull: change.pull }, 409)
    }
    return this.change(id)
  }

  async undo(id: string, who: Who) {
    const pull = await this.pull(id)
    if (!pull.merged_at || pull.base.ref !== (await this.base())) throw new Refused("Undo needs a workflow change published to this project's main branch.")
    const merge = await this.api<{ parents: { sha: string }[] }>(`${this.repo}/git/commits/${pull.merge_commit_sha}`)
    if (merge.parents.length !== 2 || merge.parents[1]?.sha !== pull.head.sha) throw new Refused("Use Revert on GitHub for a change published with squash or rebase.")
    const current = await this.ref(pull.base.ref)
    const [before, after, now] = await Promise.all([this.tree(merge.parents[0]!.sha), this.tree(pull.merge_commit_sha), this.tree(current)])
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => {
      const old = before.get(p)
      const next = after.get(p)
      return old?.mode !== "040000" && next?.mode !== "040000" && (old?.sha !== next?.sha || old?.mode !== next?.mode)
    })
    if (!changed.length || changed.length > 20 || changed.some((p) => !this.allowed(p))) throw new Refused("Open this pull request in GitHub to revert it.")
    const edits: Edit[] = []
    for (const p of changed) {
      if ([before.get(p), after.get(p)].some((file) => file && file.mode !== "100644")) throw new Refused("Use Revert on GitHub for changes to file permissions.")
      if (before.get(p)?.sha === now.get(p)?.sha && before.get(p)?.mode === now.get(p)?.mode) continue
      if (after.get(p)?.sha !== now.get(p)?.sha || after.get(p)?.mode !== now.get(p)?.mode) throw new Refused("A later change edited these workflows. Revert this pull request in GitHub.", undefined, 409)
      edits.push({ path: p.slice(this.prefix.length), text: await this.text(before.get(p)) })
    }
    if (!edits.length) throw new Refused("These workflow files already match the version before this change.")
    return this.newChange(current, `Revert: ${pull.title.slice(0, 90)}`, edits, who, pull.merge_commit_sha)
  }
}
