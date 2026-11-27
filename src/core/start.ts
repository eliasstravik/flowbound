#!/usr/bin/env node
// Where every `flowbound` command starts. It checks Node's version first and says plainly what is needed: the rest of
// Flowbound is loaded only after that, because on an old Node loading it would fail with an error nobody can read.
import { tooOld } from "./node-version.ts"

const problem = tooOld(process.version)
if (problem) {
  console.error(problem)
  process.exit(1)
}
await import("./bin.ts")
