// `execute`: an agent writes a few lines of JavaScript that call Flowbound's tools, and gets back what it returns.
// Several calls in one go, and only the part of a big answer it needs. The code runs in QuickJS, a small JavaScript
// engine of its own inside WebAssembly: it reaches nothing of this process (no files, no network, no keys), only
// the tools, each called as the person or agent who sent the code, with their rights. Time and memory are capped.
import { setTimeout as sleep } from "node:timers/promises"
import variant from "@jitl/quickjs-wasmfile-release-sync"
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core"

let engine: Promise<QuickJSWASMModule> | undefined
const MEMORY = 64 * 1024 * 1024
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v))
type Call = (tool: string, input: unknown) => Promise<unknown>

async function waitForRun(input: { run?: number; seconds?: number } | null, call: Call, deadline: number, signal: AbortSignal) {
  const run = input?.run
  const seconds = input?.seconds === undefined ? 30 : input.seconds
  if (typeof run !== "number" || !Number.isSafeInteger(run) || run <= 0) throw new Error("Give flowbound.wait the run's number.")
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw new Error("Set seconds from 0 to 30.")
  // Leave time to return the last read even when this execute has a shorter limit.
  const until = Math.min(Date.now() + seconds * 1000, deadline - 100)
  for (;;) {
    signal.throwIfAborted()
    const result = (await call("runs", { run })) as { state?: string }
    const left = until - Date.now()
    if (result.state !== "running" || left <= 0) return result
    await sleep(Math.min(500, left), undefined, { signal })
  }
}

/** Run the code with `flowbound.<tool>(input)` in scope. Returns what it returns, and what it logged. */
export async function execute(code: string, call: Call, o: { timeoutMs?: number } = {}): Promise<{ result: unknown; logs: string[] }> {
  const timeoutMs = o.timeoutMs ?? 10 * 60_000
  engine ??= newQuickJSWASMModuleFromVariant(variant as any)
  const rt = (await engine).newRuntime()
  rt.setMemoryLimit(MEMORY)
  rt.setMaxStackSize(1024 * 1024)
  const deadline = Date.now() + timeoutMs
  // Code that loops without waiting is stopped by the engine itself; waiting on a tool is stopped by the timer below.
  rt.setInterruptHandler(() => Date.now() > deadline)
  const vm = rt.newContext()
  const waits = new AbortController()
  const logs: string[] = []
  let gone = false
  let pending = 0
  try {
    const log = vm.newFunction("log", (...args) => {
      if (logs.length < 200)
        logs.push(
          args
            .map((a) => show(vm.dump(a)))
            .join(" ")
            .slice(0, 2000),
        )
    })
    const console_ = vm.newObject()
    vm.setProp(console_, "log", log)
    vm.setProp(console_, "error", log)
    vm.setProp(vm.global, "console", console_)
    console_.dispose()
    log.dispose()
    const host = vm.newFunction("__call", (nameH, inputH) => {
      const name = vm.getString(nameH)
      const input = JSON.parse(vm.getString(inputH) || "{}")
      const d = vm.newPromise()
      pending++
      const settle = (fn: () => void) => {
        pending--
        if (gone) return
        fn()
        d.dispose()
        rt.executePendingJobs()
      }
      Promise.resolve()
        .then(() => {
          if (name === "execute") throw new Error("execute cannot call itself.")
          if (name === "wait") return waitForRun(input, call, deadline, waits.signal)
          return call(name, input)
        })
        .then(
          (r) =>
            settle(() => {
              const h = vm.newString(JSON.stringify(r ?? null))
              d.resolve(h)
              h.dispose()
            }),
          (e) =>
            settle(() => {
              const h = vm.newError(String(e?.message ?? e))
              d.reject(h)
              h.dispose()
            }),
        )
      return d.handle
    })
    vm.setProp(vm.global, "__call", host)
    host.dispose()
    vm.evalCode(`globalThis.flowbound = new Proxy({}, { get: (_, name) => async (input) => JSON.parse(await __call(String(name), JSON.stringify(input === undefined ? {} : input))) });`).unwrap().dispose()
    const started = vm.evalCode(`(async () => {\n${code}\n})()`, "execute.js")
    if (started.error) {
      const e = vm.dump(started.error)
      started.error.dispose()
      throw new Error(`The code did not start: ${e?.message ?? show(e)}`)
    }
    const promise = vm.resolvePromise(started.value)
    started.value.dispose()
    rt.executePendingJobs()
    let timer: NodeJS.Timeout | undefined
    const settled = await Promise.race([promise, new Promise<"late">((r) => (timer = setTimeout(() => r("late"), Math.max(0, deadline - Date.now()))))])
    clearTimeout(timer)
    if (settled === "late") throw new Error(`The code was still going after ${Math.round(timeoutMs / 1000)} s and was stopped. Tools it started may still finish.`)
    if (settled.error) {
      const e = vm.dump(settled.error)
      settled.error.dispose()
      throw new Error(e?.message ?? show(e))
    }
    const result = vm.dump(settled.value)
    settled.value.dispose()
    return { result: result === undefined ? null : result, logs }
  } finally {
    gone = true
    waits.abort()
    // A call still in the air holds a handle into this runtime: then it is left to the garbage collector, not freed.
    if (!pending)
      try {
        vm.dispose()
        rt.dispose()
      } catch {}
  }
}
