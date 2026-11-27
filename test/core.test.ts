// Step 1 of the build order: the list, plugin(), needs and provides, `flowbound plugins`. Plus the small pure parts.
import assert from "node:assert/strict"
import { test } from "node:test"
import { docs } from "../src/core/docs.ts"
import { liveApp } from "../src/core/live.ts"
import { check, table } from "../src/core/load.ts"
import { type Plugin, plugin } from "../src/core/plugin.ts"
import { boot, Refused } from "../src/core/server.ts"
import { flowbound, starter } from "../src/index.ts"
import { fromCsv, toCsv } from "../src/plugins/csv.ts"
import { age, clean, cleanValue, inputsOf } from "../src/plugins/ledger/clean.ts"
import { capsOf, checkPermissions, DEFAULT_PERMISSIONS, ledger } from "../src/plugins/ledger.ts"
import { execute } from "../src/plugins/mcp/execute.ts"
import { answer, mcp } from "../src/plugins/mcp.ts"
import { pages } from "../src/plugins/pages.ts"
import { listName, snake } from "../src/plugins/postgres.ts"
import { hook, schedule, schedules } from "../src/plugins/schedules.ts"
import { camel, title, usd } from "../src/plugins/util.ts"
import { cleanDiagram } from "../src/plugins/workflow-sdk/diagram.ts"
import { nextAfter, toCron } from "../src/plugins/workflow-sdk/every.ts"

const p = (name: string, more: Partial<Plugin> = {}): Plugin => ({ name, ...more })

test("a chat reads the same current guide and named recipes as the command line", async () => {
  const list = [mcp(), p("example", { docs: "## Example\nCurrent plugin guide", guides: { recipe: "## Recipe\nCurrent recipe" } })]
  const app = await boot(list, { root: "/tmp", url: "http://localhost:4111" })
  const who = { kind: "token" as const, name: "Chat", role: "viewer" as const, via: "mcp" }
  for (const topic of [undefined, "start", "example", "recipe", "topics", "unknown"]) {
    assert.equal(await app.fb.call("docs", { topic }, who), docs(list, topic))
  }
  assert.match(String(await app.fb.call("docs", { topic: "topics" }, who)), /start, mcp, example, recipe/)
  assert.match(String(await app.fb.call("docs", { topic: "start" }, who)), /^# Flowbound/)
  await app.stop()
})

test("a failed live start releases parts and retries instead of keeping the outage forever", async () => {
  let attempts = 0
  const closed: string[] = []
  const get = liveApp(
    () =>
      boot(
        [
          p("store", {
            start: () => ({}),
            stop: () => {
              closed.push("store")
            },
          }),
          p("later", {
            needs: ["store"],
            start: async () => {
              attempts++
              if (attempts === 1) throw new Error("Client network socket disconnected before secure TLS connection was established")
            },
            stop: () => {
              closed.push("later")
            },
          }),
        ],
        { root: "/tmp", url: "http://localhost:4111" },
      ),
    20,
  )
  const first = get()
  assert.equal(get(), first)
  await assert.rejects(first, /TLS/)
  assert.deepEqual(closed, ["later", "store"])
  await new Promise((resolve) => setTimeout(resolve, 25))
  const app = await get()
  assert.equal(await get(), app)
  assert.equal(attempts, 2)
  await app.stop()
})

test("needs come before the plugins that need them", () => {
  const { order, problems } = check([p("b", { needs: ["a-part"] }), p("a", { provides: "a-part" })])
  assert.deepEqual(
    order.map((x) => x.name),
    ["a", "b"],
  )
  assert.equal(problems.length, 0)
})

test("a missing need, a double and a circle are problems, said plainly", () => {
  assert.match(check([p("b", { needs: ["records"] })]).problems[0]!, /b needs records, and no plugin in the list gives it/)
  assert.match(check([p("a"), p("a")]).problems[0]!, /a is in the list twice/)
  assert.match(check([p("a", { needs: ["b"] }), p("b", { needs: ["a"] })]).problems[0]!, /circle/)
  assert.match(check([undefined as any]).problems[0]!, /not a plugin/)
})

test("a later plugin with the same `provides` replaces an earlier one", () => {
  const { order, replaced } = check([p("postgres", { provides: "records" }), p("my-db", { provides: "records" }), p("x", { needs: ["records"] })])
  assert.deepEqual(
    order.map((x) => x.name),
    ["my-db", "x"],
  )
  assert.deepEqual(
    replaced.map((x) => x.name),
    ["postgres"],
  )
})

test("`flowbound plugins` prints the parts inside and what the project adds", () => {
  const out = table(starter())
  assert.match(out, /^plugin\s+gives\s+from\n/)
  assert.match(out, /postgres\s+records\s+flowbound/)
  assert.match(out, /workflow-sdk\s+runs\s+flowbound/)
  assert.match(out, /mcp\s+-\s+flowbound/)
  assert.match(out, /ledger\s+ledger\s+flowbound/)
  assert.match(out, /firecrawl\s+-\s+flowbound/)
  assert.match(out, /13 plugins, 0 problems$/)
})

test("the project says only its providers and permissions; a part inside is swapped in one line", () => {
  const names = (l: Plugin[]) => l.map((x) => x.name)
  assert.deepEqual(names(flowbound({})), ["postgres", "workflow-sdk", "keys", "ledger", "overview", "pages", "mcp", "changes", "cli", "door"])
  const mine = plugin({ name: "my-store", provides: "records" })
  assert.equal(flowbound({ parts: { store: mine } })[0], mine)
  const s = schedule({ id: "weekly-heads", workflow: "w", every: "hour" })
  assert.deepEqual(names(flowbound({ schedules: [s] })).slice(-2), ["schedules", "weekly-heads"])
  assert.equal(check(flowbound({ schedules: [s] })).problems.length, 0)
})

test("permissions as written: a mode and caps, a rule per workflow or provider, the strictest wins; a mistake is said plainly", () => {
  assert.deepEqual(checkPermissions(undefined), DEFAULT_PERMISSIONS)
  assert.equal(DEFAULT_PERMISSIONS.mode, "auto")
  assert.deepEqual(capsOf({ mode: "auto", caps: { perRun: 5 }, writesPerRun: 200 }), { perRun: 5, writesPerRun: 200 })
  assert.throws(() => checkPermissions({ mode: "sometimes" }), /mode must be "ask", "auto" or "skip"/)
  assert.throws(() => checkPermissions({ caps: { perRun: -1 } }), /perRun must be a number of 0 or more/)
  assert.throws(() => checkPermissions({ workflows: { x: { perDay: 2 } } }), /workflows\["x"\] has "perDay", which is not a setting/)
  // The strictest wins: a workflow's own ask beats auto; a provider's skip does not loosen anything.
  const l = ledger({ permissions: { mode: "auto", caps: { perRun: 5 }, workflows: { big: { mode: "ask", perRun: 2 } }, providers: { crm: { mode: "skip" }, risky: { mode: "ask" } } } })
  const api = (l.start as any)({ live: false, plugins: [], use: () => ({ query: async () => ({ rows: [] }) }), has: () => false }) as Promise<any>
  return api.then((a) => {
    assert.equal(a.modeFor("small", ["crm"]), "auto")
    assert.equal(a.modeFor("big", []), "ask")
    assert.equal(a.modeFor("small", ["risky"]), "ask")
    assert.deepEqual(a.runCaps("big"), { maxUsd: 2, maxCalls: null })
    assert.deepEqual(a.runCaps("small"), { maxUsd: 5, maxCalls: null })
  })
})

test("plugin() notes which file wrote it", () => {
  assert.equal((plugin({ name: "mine" }) as Plugin).from, `./${"test/core.test.ts"}`)
  assert.equal(starter()[0]!.from, "flowbound")
})

test("nothing is special: the core starts any list and offers its tools", async () => {
  const seen: string[] = []
  const app = await boot(
    [
      p("greeter", {
        needs: ["names"],
        start: (fb) => (seen.push(`greeter sees ${fb.use("names").default}`), undefined),
        tools: { hello: { about: "say hello", input: { who: { about: "who", required: true } }, run: (i) => `hello ${i.who}` }, secret: { about: "people only", by: "people", run: () => "ok" } },
      }),
      p("names", { provides: "names", start: () => ({ default: "world" }) }),
    ],
    { root: "/tmp", url: "http://localhost:0" },
  )
  assert.deepEqual(seen, ["greeter sees world"])
  const call = async (tool: string, body: unknown, via = "cli") =>
    (await app.fetch(new Request(`http://localhost/api/${tool}`, { method: "POST", headers: { "x-flowbound-via": via }, body: JSON.stringify(body) }))).json()
  assert.deepEqual(await call("hello", { who: "you" }), { ok: true, result: "hello you" })
  assert.match((await call("hello", {})).error, /needs "who"/)
  assert.match((await call("nope", {})).error, /No tool is called "nope"/)
  assert.match((await call("secret", {})).error, /for a person on a page/)
  assert.equal((await call("secret", {}, "page")).result, "ok")
  const about = await (await app.fetch(new Request("http://localhost/api"))).json()
  assert.deepEqual(
    about.tools.map((t: any) => t.name),
    ["hello"],
  )
  await assert.rejects(() => boot([p("b", { needs: ["nothing"] })], { root: "/tmp", url: "" }), Refused)
})

test("boot takes the project as flowbound.config.ts exports it, not only a plain list", async () => {
  // The live function hands boot the config's default export as it is. A project object once crashed every live
  // start with "list is not iterable". Here the object's own plugin has a need nobody gives, so boot refuses before
  // starting anything, which proves it read the object as the list of parts.
  await assert.rejects(
    () => boot({ plugins: [p("lonely", { needs: ["nothing"] })] }, { root: "/tmp", url: "" }),
    (e: unknown) => e instanceof Refused && /lonely needs nothing/.test((e as Error).message),
  )
})

test("shared under a path: links carry it, and requests work with or without it", async () => {
  const page = `${import.meta.dirname}/../src/plugins/keys/keys.html`
  const list = [pages(), p("x", { tools: { t: { about: "t", run: () => 1 } }, pages: { "/runs": { title: "Runs", file: page, menu: true } } })]
  const app = await boot(list, { root: "/tmp", url: "https://host.example/play/", local: "http://localhost:4111" })
  assert.deepEqual([app.fb.url, app.fb.base, app.fb.local], ["https://host.example/play", "/play", "http://localhost:4111"])
  const get = (path: string) => app.fetch(new Request(`http://localhost${path}`))
  for (const path of ["/", "/play", "/play/"]) assert.equal((await get(path)).headers.get("location"), "/play/runs")
  for (const path of ["/runs", "/play/runs"]) {
    const html = await (await get(path)).text()
    assert.match(html, /<a href="\/play\/runs" data-go="\/runs" aria-current="page">Runs<\/a>/)
    assert.match(html, /<link rel="stylesheet" href="\/play\/assets\/page\.css\?v=\w+">/)
    assert.match(html, /"base":"\/play"/)
  }
  for (const path of ["/api/t", "/play/api/t"]) assert.equal((await (await app.fetch(new Request(`http://localhost${path}`, { method: "POST", body: "{}" }))).json()).result, 1)
  assert.equal((await get("/playground/runs")).status, 404)
  const plain = await boot(list, { root: "/tmp", url: "http://localhost:4111" })
  assert.equal(plain.fb.base, "")
  assert.match(await (await plain.fetch(new Request("http://localhost/runs"))).text(), /<a href="\/runs" data-go="\/runs" aria-current="page">Runs<\/a>/)
})

test("live with no door plugin lets nobody in", async () => {
  const app = await boot([p("x", { tools: { t: { about: "t", run: () => 1 } } })], { root: "/tmp", url: "", live: true })
  assert.equal((await app.fetch(new Request("http://localhost/api/t", { method: "POST", body: "{}" }))).status, 401)
})

test("CSV: quotes, commas and line breaks survive both ways", () => {
  const rows = [
    ["name", "note"],
    ["Acme, Inc.", 'said "hi"\nthen left'],
    ["Globex", ""],
  ]
  assert.deepEqual(fromCsv(toCsv(rows)), rows)
  assert.deepEqual(fromCsv("﻿a,b\r\n1,2\r\n\r\n"), [
    ["a", "b"],
    ["1", "2"],
  ])
})

test("names: targets.csv becomes target_list; ids become titles and function names", () => {
  assert.equal(listName("targets.csv"), "target_list")
  assert.equal(listName("/tmp/My Accounts 2026.csv"), "my_accounts_2026_list")
  assert.equal(listName("target_list.csv"), "target_list")
  assert.equal(snake("Company Name"), "company_name")
  assert.equal(title("find-sales-heads"), "Find sales heads")
  assert.equal(camel("find-sales-heads"), "findSalesHeads")
  assert.equal(usd(0.74), "$0.74")
  assert.equal(usd(0.004), "$0.004")
  assert.equal(usd(1.6), "$1.60")
  assert.equal(usd(0), "$0.00")
})

test('every = "monday 08:00" and its other forms', () => {
  const tue = new Date(2026, 10, 24, 9, 30) // Tuesday 24 Nov 2026, 09:30
  assert.equal(nextAfter("monday 08:00", tue).toString(), new Date(2026, 10, 30, 8, 0).toString())
  assert.equal(nextAfter("day 08:00", tue).toString(), new Date(2026, 10, 25, 8, 0).toString())
  assert.equal(nextAfter("day 10:00", tue).toString(), new Date(2026, 10, 24, 10, 0).toString())
  assert.equal(nextAfter("weekday 08:00", new Date(2026, 10, 27, 9, 0)).getDay(), 1)
  assert.equal(nextAfter("hour", tue).getMinutes(), 0)
  assert.equal(nextAfter("15 minutes", tue).getTime() - tue.getTime(), 15 * 60_000)
  assert.throws(() => nextAfter("sometimes", tue), /not a schedule Flowbound knows/)
})

test("a schedule's time is the wall clock of its timezone, also across a clock change", () => {
  const thu = new Date("2026-11-26T10:00:00Z")
  assert.equal(nextAfter("monday 08:00", thu, "Europe/Stockholm").toISOString(), "2026-11-30T07:00:00.000Z")
  assert.equal(nextAfter("day 08:00", thu, "America/New_York").toISOString(), "2026-11-26T13:00:00.000Z")
  // Sweden moves its clocks forward on 28 Mar 2027: 08:00 there is 06:00 UTC from that morning on.
  assert.equal(nextAfter("day 08:00", new Date("2027-03-27T12:00:00Z"), "Europe/Stockholm").toISOString(), "2027-03-28T06:00:00.000Z")
  assert.throws(() => nextAfter("day 08:00", thu, "Mars/Olympus"), /time zone/i)
})

test("a schedule line as a host's cron line; one it cannot say exactly gets the next finer one", () => {
  assert.deepEqual(["monday 08:00", "day 08:00", "weekday 08:30", "hour", "2 hours", "5 hours", "15 minutes", "7 minutes"].map(toCron), [
    "0 8 * * 1",
    "0 8 * * *",
    "30 8 * * 1,2,3,4,5",
    "0 * * * *",
    "0 */2 * * *",
    "0 * * * *",
    "*/15 * * * *",
    "* * * * *",
  ])
})

test("schedule() and hook() are lines that need the schedules part, and say what is wrong with a line when the list is read", () => {
  const s = schedule({ id: "weekly-heads", workflow: "find-sales-heads", every: "monday 08:00", timezone: "Europe/Stockholm" })
  assert.deepEqual([s.name, s.needs], ["weekly-heads", ["schedules"]])
  assert.match(table([...starter(), schedules(), s, hook({ id: "new-leads", workflow: "lead-heads" })]), /16 plugins, 0 problems$/)
  assert.match(table([...starter(), s]), /problem: weekly-heads needs schedules, and no plugin in the list gives it/)
  assert.throws(() => schedule({ id: "weekly", workflow: "x", every: "now and then" }), /not a schedule Flowbound knows/)
  assert.throws(() => schedule({ id: "Weekly Heads", workflow: "x", every: "hour" }), /short name in lower-case letters/)
  assert.throws(() => hook({ id: "new-leads", workflow: "" }), /must name its workflow/)
})

test("MCP offers search and execute when no app pages are installed", async () => {
  const tools: any[] = [
    { name: "tables", about: "List your tables", input: {} },
    { name: "blitzapi", about: "Call BlitzAPI", input: { path: { about: "the path", required: true } }, price: "$0.0005 a call" },
  ]
  const calls: unknown[] = []
  const behind = { about: async () => ({ url: "http://localhost:4111", live: false, tools }), call: async (tool: string, input: unknown) => (calls.push({ tool, input }), { result: [1, 2], logs: ["hi"] }) }
  const rpc = (method: string, params?: unknown) => answer({ jsonrpc: "2.0", id: 1, method, params }, behind) as Promise<any>
  assert.deepEqual(
    (await rpc("tools/list")).result.tools.map((t: any) => t.name),
    ["search", "execute"],
  )
  const found = (await rpc("tools/call", { name: "search", arguments: { query: "blitz" } })).result.content[0].text
  assert.match(found, /blitzapi: Call BlitzAPI\n\s+price: \$0\.0005 a call\n\s+path \(needed\)/)
  assert.match(found, /Call them with execute: const r = await flowbound\.<tool>/)
  assert.doesNotMatch(found, /tables:/)
  const ran = (await rpc("tools/call", { name: "execute", arguments: { code: "return 1" } })).result
  assert.deepEqual(calls, [{ tool: "execute", input: { code: "return 1" } }])
  assert.deepEqual(ran.structuredContent, { result: [1, 2], logs: ["hi"] })
  assert.equal(ran.content[0].text, "hi\n---\n[\n  1,\n  2\n]")
  assert.match((await rpc("tools/call", { name: "show", arguments: {} })).result.content[0].text, /two MCP tools: search and execute/)
  assert.equal(await answer({ jsonrpc: "2.0", method: "notifications/initialized" }, behind), undefined)
})

test("MCP execute selects a view for displayable results and keeps other results plain", async () => {
  const url = "https://example.test/flowbound"
  const run = { run: 2, page: `${url}/runs?run=2`, state: "waiting" }
  const workflow = { id: "sample", page: `${url}/workflows?workflow=sample` }
  const table = { name: "sample", total: 4, columns: [], rows: [] }
  const values = { run, workflow, table, guide: "# Guide", invalid: { flowboundView: { page: "keys" } }, pick: { flowboundView: { table: "example & test" } } }
  let calls = 0
  const behind = {
    about: async () => ({ url, live: true, tools: [] }),
    call: async (_tool: string, input: unknown) => {
      calls++
      return { result: values[(input as { code: keyof typeof values }).code], logs: [] }
    },
    app: { url, live: true, role: "viewer", tools: ["runs"], paths: ["/runs", "/tables", "/workflows"] },
  }
  const rpc = (method: string, params?: unknown) => answer({ jsonrpc: "2.0", id: 1, method, params }, behind) as Promise<any>
  const { tools } = (await rpc("tools/list")).result
  assert.deepEqual(
    tools.map((t: any) => t.name),
    ["search", "execute"],
  )
  assert.equal(tools[0]._meta?.ui, undefined)
  const uri = tools[1]._meta.ui.resourceUri
  const {
    contents: [resource],
  } = (await rpc("resources/read", { uri })).result
  assert.equal(resource.uri, uri)
  assert.equal(resource.mimeType, "text/html;profile=mcp-app")
  assert.match(resource.text, /data-page="\/runs"/)
  assert.match(resource.text, /<body[^>]+ hidden>/)
  assert.doesNotMatch(resource.text, /example\.test/)
  const call = async (args: object) => (await rpc("tools/call", { name: "execute", arguments: args })).result
  assert.equal((await call({})).structuredContent.view.path, "/runs")
  assert.equal(calls, 0)
  const shown = await call({ code: "run" })
  assert.deepEqual(shown.structuredContent.result, run)
  assert.equal(shown.structuredContent.link, `${url}/runs?run=2`)
  assert.ok(shown.content[0].text.includes(`${url}/runs?run=2`))
  assert.equal(shown._meta.flowbound.role, "viewer")
  assert.equal((await call({ code: "workflow" })).structuredContent.link, `${url}/workflows?workflow=sample`)
  assert.equal((await call({ code: "table" })).structuredContent.link, `${url}/tables?table=sample`)
  assert.equal((await call({ code: "pick" })).structuredContent.link, `${url}/tables?table=example+%26+test`)
  assert.deepEqual((await call({ code: "guide" })).structuredContent, { result: "# Guide", logs: [] })
  assert.equal((await call({ code: "invalid" })).structuredContent.view, undefined)
  assert.deepEqual((await call({ code: "run", render: false })).structuredContent, { result: run, logs: [] })
})

test("execute runs code in a sandbox of its own: it reaches only the tools, as the caller, with time and memory capped", async () => {
  const seen: string[] = []
  const call = async (tool: string, input: any) => {
    seen.push(tool)
    if (tool === "nope") throw new Error("No tool is called nope.")
    return { tool, n: input.n ?? 0 }
  }
  const out = await execute('const [a, b] = await Promise.all([flowbound.runs({ n: 1 }), flowbound["schedule-run"]({ n: 2 })]); console.log("both"); return a.n + b.n', call)
  assert.deepEqual(out, { result: 3, logs: ["both"] })
  await assert.rejects(execute("await flowbound.nope(); return 1", call), /No tool is called nope/)
  await assert.rejects(execute('return require("fs")', call), /require.* is not defined/)
  await assert.rejects(execute("return process.env", call), /process.* is not defined/)
  await assert.rejects(execute("return await fetch('http://example.com')", call), /fetch.* is not defined/)
  await assert.rejects(execute("while (true) {}", call, { timeoutMs: 300 }), /interrupted/)
  await assert.rejects(execute("await flowbound.execute({ code: '1' })", call), /execute cannot call itself/)
  await assert.rejects(execute("this is not code", call), /did not start/)
  assert.deepEqual(seen, ["runs", "schedule-run", "nope"])
})

test("kept facts: inputs are cleaned by exact inputs, and no guessing who is who", () => {
  assert.equal(cleanValue("  Maya@Acme.COM "), "maya@acme.com")
  assert.equal(cleanValue("https://www.Acme.com/"), "acme.com")
  assert.equal(cleanValue("http://acme.com/about/?utm=x"), "acme.com/about")
  assert.equal(cleanValue("https://www.linkedin.com/in/Maya-Lind/"), "linkedin.com/in/maya-lind")
  assert.equal(cleanValue("Acme  Inc"), "Acme Inc")
  assert.notEqual(cleanValue("Acme Inc"), cleanValue("acme.com"))
  assert.deepEqual(clean({ body: { domain: "WWW.ACME.COM", n: 3, list: [" A@B.co "] } }), { body: { domain: "acme.com", n: 3, list: ["a@b.co"] } })
  assert.deepEqual(inputsOf({ company: "Co1", domain: "https://co1.example", n: 2 }).sort(), ["Co1", "co1.example"])
  assert.equal(age(new Date(Date.now() - 140 * 86_400_000)), "140 days")
  assert.equal(age(new Date(Date.now() - 86_400_000)), "1 day")
})

test("a diagram the agent drew is shown as drawn, with everything that is not drawing taken out", () => {
  const drawn =
    '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect x="1" width="2" fill="currentColor" style="x"/><a href="javascript:alert(3)"><text>link</text></a><text x="1">A &amp; B</text><foreignObject><div>html</div></foreignObject><image href="https://evil.example/x.png"/><path d="M0 0" marker-end="url(#m)" fill="url(https://evil.example/f)"/></svg>'
  const { svg } = cleanDiagram(drawn)
  assert.equal(svg, '<svg viewBox="0 0 10 10" role="img"><rect x="1" width="2" fill="currentColor"/><text x="1">A &amp; B</text><path d="M0 0" marker-end="url(#m)"/></svg>')
  assert.deepEqual(cleanDiagram(undefined), {})
  assert.match(cleanDiagram("<div>no</div>").problem!, /must start with <svg/)
  assert.match(cleanDiagram(42).problem!, /must be the text of an SVG drawing/)
})
