import type { App } from "./server.ts"

export function liveApp(start: () => Promise<App>, retryMs = 1000) {
  let ready: Promise<App> | undefined
  let retryAt = 0
  return () => {
    if (!ready || Date.now() >= retryAt) {
      retryAt = Infinity
      ready = start().catch((error) => {
        console.error("Flowbound start failed", error?.code ?? error?.name ?? "Error")
        retryAt = Date.now() + retryMs
        throw error
      })
    }
    return ready
  }
}
