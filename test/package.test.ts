// The package is ready to publish and not published: what it ships, what it says about itself, and how it would go out.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { repo } from "./helpers.ts"

const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")
const pkg = JSON.parse(read("package.json"))

test("it stays private until the owner says go", () => {
  assert.equal(pkg.private, true)
  assert.match(read("docs/publish.md"), /"private": true,/)
})

test("it says where it lives, and every manifest carries the same version", () => {
  assert.equal(pkg.repository.url, "git+https://github.com/eliasstravik/flowbound.git")
  assert.match(pkg.homepage, /^https:\/\/github\.com\/eliasstravik\/flowbound/)
  assert.equal(pkg.license, "MIT")
  for (const file of ["plugin.json", ".claude-plugin/plugin.json", ".antigravity-plugin/plugin.json", "gemini-extension.json"]) assert.equal(JSON.parse(read(file)).version, pkg.version, file)
})

test("the packed package holds what a user needs, and no private notes or names", () => {
  const files: string[] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: repo, encoding: "utf8" }))[0].files.map((f: any) => f.path)
  for (const need of [
    "dist/core/start.js",
    "dist/core/bin.js",
    "dist/index.js",
    "dist/workflow.js",
    "docs/start.md",
    "docs/if-it-breaks.md",
    "skills/flowbound/SKILL.md",
    "template/flowbound.config.ts",
    "README.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "LICENSE",
  ])
    assert.ok(files.includes(need), need)
  for (const f of files) assert.doesNotMatch(f, /^(docs\/(playground|staging|publish)\.md|docs\/vision\/|staging\/|test\/|src\/)/, f)
  const text = files.filter((f) => /\.(md|json|js|ts|html|csv)$/.test(f)).map((f) => read(f))
  for (const t of text) assert.doesNotMatch(t, /<owner>|\.tail[a-z0-9]+\.ts\.net/)
})

test("the publish workflow runs only on a release tag, with provenance", () => {
  const wf = read(".github/workflows/publish.yml")
  const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"))
  assert.match(on, /push:\n\s+tags:/)
  assert.doesNotMatch(on, /branches|pull_request|workflow_dispatch|schedule|release:/)
  assert.match(wf, /id-token: write/)
  assert.match(wf, /npm publish --provenance/)
  assert.match(wf, /still says \\"private\\": true, so nothing is published/)
})
