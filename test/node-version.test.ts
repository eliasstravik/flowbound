// Every `flowbound` command first checks Node's version, and on one too old says what is needed and how to get it.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { NEEDS, tooOld } from "../src/core/node-version.ts"
import { repo } from "./helpers.ts"

test("a Node older than 22.18 is told plainly what it needs and how to get it", () => {
  for (const old of ["v18.20.4", "v20.19.0", "v22.17.1", "v21.7.3", "v8.0.0"]) {
    const said = tooOld(old)
    assert.ok(said, old)
    assert.match(said, new RegExp(`needs Node\\.js ${NEEDS.replace(".", "\\.")} or newer\\. This computer has Node\\.js ${old.slice(1).replaceAll(".", "\\.")}\\.`))
    assert.match(said, /https:\/\/nodejs\.org/)
    assert.match(said, /nvm install --lts/)
    assert.match(said, /run the same command again/)
  }
})

test("22.18 and newer pass without a word", () => {
  for (const ok of ["v22.18.0", "v22.20.1", "v23.0.0", "v24.21.0", "v30.1.0", process.version]) assert.equal(tooOld(ok), undefined, ok)
})

test("the version Flowbound says it needs is the one package.json asks npm for", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"))
  assert.equal(pkg.engines.node, `>=${NEEDS}`)
})

test("the flowbound command starts at the check, and the check loads nothing else first", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"))
  assert.equal(pkg.bin.flowbound, "dist/core/start.js")
  const start = fs.readFileSync(path.join(repo, "dist", "core", "start.js"), "utf8")
  // The only module loaded before the check is the check itself; the rest comes after, with a dynamic import.
  assert.deepEqual(
    [...start.matchAll(/^import .* from "(.*)"/gm)].map((m) => m[1]),
    ["./node-version.js"],
  )
  assert.match(start, /await import\("\.\/bin\.js"\)/)
  // On a Node that is new enough it is the same command as before.
  assert.match(execFileSync(process.execPath, [path.join(repo, "dist", "core", "start.js"), "help"], { encoding: "utf8", cwd: repo }), /flowbound <command>/)
})
