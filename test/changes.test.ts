import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { can, type Plugin, type Who } from "../src/core/plugin.ts"
import { boot, listen } from "../src/core/server.ts"
import { GitHub } from "../src/plugins/changes/github.ts"
import { changes } from "../src/plugins/changes.ts"
import { mcp } from "../src/plugins/mcp.ts"

const member: Who = { kind: "token", role: "member", name: "Test chat, for Sam Lane", personName: "Sam Lane", email: "sam@example.com", checked: true, via: "mcp" }
const viewer: Who = { ...member, role: "viewer" }
const projectFile = "workflows/find-sales-heads.ts"
const initial = `export const from = "target_list"
export const into = "sales_heads"
export async function findSalesHeads(row: { employees: number }) {
  "use workflow"
  return { kept: true }
}
`
const update = initial.replace("kept: true", "kept: row.employees >= 50")

test("member saves and publishes checked code over MCP, and undo saves a checked revert", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowbound-git-test-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  git("init", "-b", "main", "-q")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.com")
  fs.mkdirSync(path.join(root, "workflows"))
  fs.writeFileSync(path.join(root, "flowbound.config.ts"), "export default {}\n")
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { types: "tsc -p tsconfig.json", test: "node --test" } }))
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ["workflows"] }))
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir")
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n.flowbound\n")
  fs.writeFileSync(path.join(root, projectFile), initial)
  git("add", ".")
  git("commit", "-qm", "Initial workflow")
  const gate: Plugin = { name: "test-sign-in", guard: (request) => (request.headers.get("authorization") === "Bearer viewer" ? viewer : member) }
  let closeApp: () => Promise<void> = async () => {}
  const server = await listen(0, async (port) => {
    const app = await boot([changes(), mcp(), gate], { root, url: `http://localhost:${port}` })
    closeApp = app.stop
    return app.fetch
  })
  t.after(async () => {
    await server.close()
    await closeApp()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const client = async (role: string) => {
    const client = new Client({ name: "stand-in-chat", version: "1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${role}` } } }))
    t.after(() => client.close())
    return async (name: string, input: unknown) => client.callTool({ name: "execute", arguments: { code: `return await flowbound[${JSON.stringify(name)}](${JSON.stringify(input)})` } }) as Promise<any>
  }
  const ask = await client("member")
  const readOnly = await client("viewer")
  const call = async (name: string, args: unknown = {}) => {
    const result = await ask(name, args)
    assert.ok(!result.isError, result.content[0]?.text)
    return result.structuredContent.result as any
  }
  const ready = async (id: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const change = await call("workflow-change", { id })
      assert.equal(change.blocked, undefined)
      if (change.checks.every((check: { state: string }) => check.state === "passed")) return change
      assert.ok(
        change.checks.every((check: { state: string }) => check.state !== "failed"),
        JSON.stringify(change.checks),
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.fail("checks did not finish")
  }
  const { head, text } = await call("workflow-file", { file: projectFile })
  assert.equal(text, initial)
  const request = { title: "Skip companies under 50 people", head, files: [{ path: projectFile, text: update }] }
  assert.equal((await readOnly("workflow-save", request)).isError, true)
  assert.equal((await ask("workflow-save", { ...request, files: [{ path: "workflows/../flowbound.config.ts", text: update }] })).isError, true)
  const saved = await call("workflow-save", request)
  assert.equal(saved.state, "open")
  assert.equal(fs.readFileSync(path.join(root, projectFile), "utf8"), initial)
  assert.match(git("show", "-s", "--format=%an%n%B", saved.head), /Sam Lane[\s\S]*Requested by Sam Lane\./)
  assert.equal((await ask("workflow-publish", { id: saved.id, head })).isError, true)
  assert.equal((await readOnly("workflow-publish", { id: saved.id, head: saved.head })).isError, true)
  const checked = await ready(saved.id)
  assert.deepEqual(
    checked.checks.map((c: { state: string }) => c.state),
    ["passed", "passed", "passed"],
  )
  const published = await call("workflow-publish", { id: saved.id, head: saved.head })
  assert.equal(published.state, "published")
  assert.equal((await call("workflow-changes", { published: true })).changes[0].id, saved.id)
  assert.equal(fs.readFileSync(path.join(root, projectFile), "utf8"), update)
  const reverted = await call("workflow-undo", { id: saved.id })
  assert.equal(fs.readFileSync(path.join(root, projectFile), "utf8"), update)
  await ready(reverted.id)
  await call("workflow-publish", { id: reverted.id, head: reverted.head })
  assert.equal(fs.readFileSync(path.join(root, projectFile), "utf8"), initial)
  assert.equal(git("rev-list", "--count", "--first-parent", "main"), "3")
})

test("GitHub App saves attributed commits, observes checks and review, publishes by head, and saves a revert", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const options = {
    appId: "123",
    installation: "321",
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    name: "example/project",
    directory: "staging",
  }
  const a = "a".repeat(40),
    b = "b".repeat(40),
    c = "c".repeat(40),
    d = "d".repeat(40)
  const file = `staging/${projectFile}`
  let main = a
  let branch = ""
  let head = a
  let checked = false
  let approval = true
  let merged = false
  const restored = "e".repeat(40)
  let deploymentReported = true
  const commitBodies: string[] = []
  const pulls: Record<number, any> = {
    2: {
      number: 2,
      title: "Engineer's workflow change",
      state: "open",
      changed_files: 1,
      head: { ref: "engineer-work", sha: b, repo: { full_name: options.name } },
      base: { ref: "main", sha: a },
      user: { login: "engineer", type: "User" },
    },
  }
  const prefix = "/repos/example/project"
  const fake: typeof fetch = async (address, init) => {
    const u = new URL(String(address))
    const key = u.pathname
    const method = init?.method
    const data = init?.body ? JSON.parse(String(init.body)) : undefined
    const reply = (value: unknown) => Response.json(value)
    assert.equal(u.hostname, "api.github.com")
    if (key === "/app/installations/321/access_tokens") {
      assert.deepEqual(data.repositories, ["project"])
      assert.deepEqual(data.permissions, { contents: "write", pull_requests: "write", checks: "read", deployments: "read", statuses: "read" })
      assert.equal(String(new Headers(init?.headers).get("authorization")).split(".").length, 3)
      return reply({ token: "fake-installation", expires_at: new Date(Date.now() + 3600_000).toISOString() })
    }
    if (key === "/app") return reply({ slug: "flowbound-workflows" })
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-installation")
    if (key === prefix) return reply({ full_name: options.name, default_branch: "main" })
    if (key === `${prefix}/git/ref/heads/main`) return reply({ object: { sha: main } })
    if (key === `${prefix}/git/refs`) {
      branch = data.ref.slice("refs/heads/".length)
      head = data.sha
      assert.match(branch, /^flowbound\/[a-f0-9]{32}$/)
      return reply({})
    }
    if (key === "/graphql" && data.variables.input) {
      const input = data.variables.input
      assert.equal(input.expectedHeadOid, head)
      assert.equal(input.branch.refName, `refs/heads/${branch}`)
      assert.equal(input.fileChanges.additions[0].path, file)
      assert.equal(Buffer.from(input.fileChanges.additions[0].contents, "base64").toString(), head === a ? update : initial)
      head = head === a ? b : d
      commitBodies.push(input.message.body)
      return reply({ data: { createCommitOnBranch: { commit: { oid: head } } } })
    }
    if (key === "/graphql")
      return reply({
        data: { repository: { pullRequest: { reviewDecision: approval ? "APPROVED" : "REVIEW_REQUIRED", mergeStateStatus: "CLEAN", reviewRequests: { nodes: [{ requestedReviewer: { login: "reviewer" } }] } } } },
      })
    if (key === `${prefix}/pulls`) {
      if (method !== "POST") return reply(Object.values(pulls).filter((pull) => pull.state === (u.searchParams.get("state") ?? "open")))
      const number = head === b ? 1 : 3
      pulls[number] = {
        number,
        title: data.title,
        state: "open",
        changed_files: 1,
        head: { ref: branch, sha: head, repo: { full_name: options.name } },
        base: { ref: "main", sha: main },
        user: { login: "flowbound-workflows[bot]", type: "Bot" },
      }
      return reply(pulls[number])
    }
    if (/\/pulls\/\d+$/.test(key)) return reply(pulls[Number(key.split("/").pop())])
    if (key.endsWith("/files")) return reply([{ filename: file }])
    if (key.endsWith("/check-runs"))
      return reply({
        check_runs: ["types", "workflows", "tests"].map((name, id) => ({ id, name, head_sha: key.split("/").at(-2), app: { slug: "github-actions" }, status: "completed", conclusion: checked ? "success" : "skipped" })),
      })
    if (key === `${prefix}/deployments`) return reply(deploymentReported ? [{ id: 4, production_environment: false, environment: "Preview", creator: { login: "vercel[bot]" } }] : [])
    if (key.endsWith("/status")) return reply({ statuses: [{ context: "Vercel", state: "success", target_url: "https://vercel.com/example/project/preview123" }] })
    if (key.endsWith("/statuses")) return reply([{ state: "success", environment_url: "https://preview-nonproduction.vercel.app/" }])
    if (key.startsWith(`${prefix}/git/commits/`)) return reply({ tree: { sha: key.split("/").pop() }, parents: [{ sha: a }, { sha: b }] })
    if (key.startsWith(`${prefix}/git/trees/`)) return reply({ tree: [{ path: file, mode: "100644", sha: [a, d, restored].includes(key.split("/").pop()!) ? a : b }], truncated: false })
    if (key.startsWith(`${prefix}/git/blobs/`)) {
      const raw = key.endsWith(a) ? initial : update
      return reply({ content: Buffer.from(raw).toString("base64"), encoding: "base64", size: raw.length })
    }
    if (key.startsWith(`${prefix}/compare/`)) return reply({ status: "ahead" })
    if (key.endsWith("/merge")) {
      const number = Number(key.split("/").at(-2))
      assert.equal(data.sha, pulls[number].head.sha)
      assert.equal(data.merge_method, "merge")
      assert.ok(checked && approval)
      main = number === 1 ? c : restored
      merged = true
      Object.assign(pulls[number], { state: "closed", merged_at: new Date().toISOString(), merge_commit_sha: main })
      return reply({ merged: true })
    }
    assert.fail(`Unexpected fake API route ${method} ${key}`)
  }

  const repo = new GitHub(options, fake)
  assert.equal((await repo.list())[0]?.external, true)
  assert.deepEqual(await repo.read(undefined, projectFile), { head: a, text: initial })
  const saved = await repo.save({ title: "Skip companies under 50 people", head: a, edits: [{ path: projectFile, text: update }] }, member)
  assert.equal(saved.preview, "https://preview-nonproduction.vercel.app/")
  assert.equal(saved.external, false)
  deploymentReported = false
  assert.equal((await repo.change(saved.id)).preview, "https://vercel.com/example/project/preview123")
  assert.equal(commitBodies[0], "Requested by Sam Lane.")
  await assert.rejects(repo.publish(saved.id, a, member), /moved/)
  await assert.rejects(repo.publish(saved.id, b, member), /All three checks/)
  checked = true
  approval = false
  await assert.rejects(repo.publish(saved.id, b, member), /approval from @reviewer/)
  approval = true
  assert.equal((await repo.publish(saved.id, b, member)).published, c)
  assert.ok(merged)
  const reverted = await repo.undo(saved.id, member)
  assert.equal(reverted.state, "open")
  assert.match(commitBodies[1]!, new RegExp(`Reverts ${c}`))
  assert.equal((await repo.list(true))[0]?.id, saved.id)
  assert.equal((await repo.publish(reverted.id, d, member)).published, restored)
  assert.equal((await repo.read(undefined, projectFile)).text, initial)
})

test("only roles with access can read and only Members and above can make changes", () => {
  assert.equal(can({ role: "none" }, "viewer"), false)
  assert.equal(can(viewer, "member"), false)
  assert.equal(can(member, "member"), true)
  assert.equal(can(member, "admin"), false)
  assert.equal(can({ role: "admin" }, "owner"), false)
  assert.equal(can({ role: "owner" }, "admin"), true)
})
