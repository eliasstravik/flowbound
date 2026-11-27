// The page: what people see, on a phone or a desktop. The menu: Home, Workflows, Runs, Schedules, Data, Context, then
// Connections, Agents and Permissions after a line; Changes is reached from "N changes not live" under the menu.
// Each is one plain HTML file. How they look is one style sheet and one script, built once when Flowbound itself is
// built (scripts/build-pages.mjs).
import fs from "node:fs"
import { type Flowbound, type Page, plugin, type Route, type Who } from "../core/plugin.ts"
import { asset, sha } from "./util.ts"

export type Pages = {
  list: () => { path: string; title: string }[]
  /** The whole page as one HTML document. */
  render: (o: { path?: string; who?: Who }) => string
  /** The head of a page that stands alone (sign-in, "Allow an app"): the same style sheet, and nothing else. */
  head: (title: string) => string
}

/** A file the build made. From a fresh checkout it is not there yet. */
const built = (name: string) => {
  const file = asset(`pages/built/${name}`)
  if (!fs.existsSync(file)) throw new Error(`The pages are not built yet (${name} is missing). Run: npm run build`)
  return file
}
const FILES: Record<string, string> = {
  "page.css": "text/css; charset=utf-8",
  "page.js": "text/javascript; charset=utf-8",
  "geist.woff2": "font/woff2",
  "geist-ext.woff2": "font/woff2",
  "geist-mono.woff2": "font/woff2",
  "mermaid.js": "text/javascript; charset=utf-8",
}
// The sheet follows the system's light or dark before anything is drawn.
const THEME = `<script>(function(m){var d=document.documentElement,s=function(){d.dataset.theme||d.classList.toggle("dark",m.matches)};s();m.addEventListener("change",s)})(matchMedia("(prefers-color-scheme: dark)"))</script>`

const read = (file: string) => fs.readFileSync(file, "utf8")
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
// Each built file is read once (again when it changed on disk), and named with a mark of its content: a browser
// keeps it until it changes.
const kept = new Map<string, { body: Buffer; mark: string; at: number }>()
const get = (name: string) => {
  const at = fs.statSync(built(name)).mtimeMs
  if (kept.get(name)?.at !== at) {
    const body = fs.readFileSync(built(name))
    kept.set(name, { body, mark: sha(body.toString("base64")).slice(0, 10), at })
  }
  return kept.get(name)!
}
const at = (base: string, name: string) => `${base}/assets/${name}?v=${get(name).mark}`
const FONT = /url\((["']?)(geist[a-z-]*\.woff2)\1\)/g
/** The style sheet as a file: its fonts are beside it, each with its own mark. */
const sheet = () =>
  get("page.css")
    .body.toString("utf8")
    .replace(FONT, (_m, _q, name: string) => `url("${name}?v=${get(name).mark}")`)
/** Where "/" and the name in the corner lead: the page that says it comes first (Home), else the runs, else any page in the menu. */
const home = (all: Map<string, Page>) => [...all].find(([, p]) => p.first)?.[0] ?? (all.has("/runs") ? "/runs" : ([...all].find(([, p]) => p.menu)?.[0] ?? "/api"))
const head = (base: string, title: string) => `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · Flowbound</title>
${THEME}
<link rel="stylesheet" href="${at(base, "page.css")}">`

const render = (
  all: Map<string, Page>,
  {
    path,
    who,
    live = false,
    url = "",
    base = "",
    app = false,
  }: {
    path?: string
    who?: Who
    live?: boolean
    url?: string
    base?: string
    app?: boolean
  },
) => {
  const shown = [...all].filter(([p]) => app || p === path)
  // The tabs in their order (a page of your own goes after the built-in tabs, in the order of the list).
  const menu = (app ? shown : [...all]).filter(([, p]) => p.menu).sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99))
  // Mermaid is big and only a workflow's page needs it: the page fetches it from here when it draws a diagram.
  const boot = {
    app,
    live: live,
    url: url,
    base: base,
    page: path ?? null,
    mermaid: app ? `${url}/assets/mermaid.js` : at(base, "mermaid.js"),
    who: who ? { name: who.name, kind: who.kind, checked: who.checked !== false, role: who.role ?? null } : null,
  }
  // Where you set things up (Connections, Agents, Permissions) sits under a line, after what you look at. Home's count
  // and "N changes not live" are filled in by the page once it asks.
  const links = menu
    .map(
      ([p, x], i) =>
        `${(x.order ?? 99) >= 7 && (menu[i - 1]?.[1].order ?? 99) < 7 ? '<hr class="sep">' : ""}<a href="${base}${p}" data-go="${p}"${p === path || (x.first && path === "/needs") ? ' aria-current="page"' : ""}>${esc(x.title)}${x.first ? '<span class="count" data-count hidden></span>' : ""}</a>`,
    )
    .join("")
  const changes = all.has("/changes") ? `<a class="publish" href="${base}/changes" data-go="/changes" data-changes hidden></a>` : ""
  const brand = `<a class="brand" href="${base}/" data-go="${home(all)}">Flowbound</a>`
  const place = `<span class="place" data-place="${live ? "live" : "local"}">${live ? "Live" : "Your computer"}</span>`
  const me =
    live && who?.kind === "person"
      ? `<form class="me" action="${base}/door/out" method="post"><span title="${esc(who.name)}">${esc(who.name.replace(/ \(.*\)$/, ""))}</span><button class="btn" data-variant="outline" data-size="sm" type="submit">Sign out</button></form>`
      : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(all.get(path ?? "")?.title ?? "Flowbound")} · Flowbound</title>
${THEME}
${
  app
    ? `<style>${get("page.css")
        .body.toString("utf8")
        .replace(FONT, (_m, _q, name: string) => `url("data:font/woff2;base64,${get(name).body.toString("base64")}")`)}</style>`
    : `<link rel="stylesheet" href="${at(base, "page.css")}">`
}
<script>window.FB = ${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>
${
  app
    ? `<script>${get("app.js")
        .body.toString("utf8")
        .replace(/<\/script/gi, "<\\/script")}</script>
<script>${get("page.js")
        .body.toString("utf8")
        .replace(/<\/script/gi, "<\\/script")}</script>`
    : `<script src="${at(base, "page.js")}"></script>`
}
</head>
<body${app ? ' data-embedded data-mode="inline" hidden' : ""}>
<a class="skip" href="#main">Skip to the page</a>
<div class="app">
<aside class="side"><div class="flex items-center justify-between gap-2">${brand}${place}</div><nav class="menu" aria-label="Pages">${links}${changes}</nav>${me}</aside>
<header class="top">${brand}${place}<button class="btn ml-auto" data-variant="ghost" data-size="icon" type="button" id="menu-open" aria-label="Menu" aria-haspopup="dialog" data-icon="menu"></button></header>
<dialog class="drawer" id="menu" aria-label="Menu"><div><div class="flex h-10 items-center gap-1"><button class="btn" data-variant="ghost" data-size="icon" type="button" data-close aria-label="Close the menu" data-icon="x"></button>${brand}</div><nav class="menu" aria-label="Pages">${links}${changes}</nav>${me}</div></dialog>
<main id="main" tabindex="-1"><div class="page">
${app ? '<header class="app-bar" id="app-actions" hidden><b>Flowbound</b><span id="app-title"></span></header><div id="app-loading" class="loading" role="status" aria-label="Loading"><span class="skeleton w-2/5"></span><span class="skeleton w-full"></span><span class="skeleton w-4/5"></span><span class="skeleton w-2/3"></span></div>' : ""}
<div id="trouble" class="alert" data-variant="destructive" role="alert" hidden></div>
${shown.map(([p, x]) => `<section data-page="${p}" hidden>\n${read(x.file)}\n</section>`).join("\n")}
</div></main>
</div>
<div id="said" class="toast" role="status" hidden></div>
<div id="offline" class="toast" data-tone="bad" role="status" hidden>Lost the connection. Trying again.</div>
</body>
</html>`
}

// Built-in views only. Hosts can fetch the static resource before the person opens a project.
export const appPages = new Map<string, Page>([
  ["/home", { title: "Home", file: asset("overview/overview.html"), menu: true, first: true, order: 1 }],
  ["/workflows", { title: "Workflows", file: asset("workflow-sdk/workflows.html"), menu: true, order: 2 }],
  ["/runs", { title: "Runs", file: asset("workflow-sdk/runs.html"), menu: true, order: 3 }],
  ["/schedules", { title: "Schedules", file: asset("workflow-sdk/schedules.html"), menu: true, order: 4 }],
  ["/tables", { title: "Data", file: asset("postgres/tables.html"), menu: true, order: 5 }],
  ["/context", { title: "Context", file: asset("context/context.html"), menu: true, order: 6 }],
  ["/keys", { title: "Connections", file: asset("keys/keys.html"), menu: true, order: 7 }],
  ["/connect", { title: "Agents", file: asset("door/connect.html"), menu: true, order: 8 }],
  ["/permissions", { title: "Permissions", file: asset("ledger/permissions.html"), menu: true, order: 9 }],
  // Not in the menu: Home's old address (an agent's show({ page: "needs" }) still lands on Home), Changes and People.
  ["/needs", { title: "Home", file: asset("overview/overview.html") }],
  ["/changes", { title: "Changes", file: asset("changes/changes.html") }],
  ["/people", { title: "People", file: asset("door/people.html") }],
])
let appDocument: string | undefined
export const renderApp = () => (appDocument ??= render(appPages, { app: true }))

export const pages = () => {
  let fb: Flowbound
  const all = new Map<string, Page>()
  const web: Pages["render"] = (o) => render(all, { ...o, live: fb.live, url: fb.url, base: fb.base })

  const self = plugin({
    name: "pages",
    provides: "pages",
    routes: {} as Record<string, Route>,
    start(f) {
      fb = f
      // A page that is only for a live Flowbound (people and their rights, agents' tokens) is not there on your own computer.
      for (const p of fb.plugins) for (const [path, page] of Object.entries(p.pages ?? {})) if (!page.live || fb.live) all.set(path, page)
      const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
      for (const path of all.keys()) self.routes[`GET ${path}`] = (_req, at) => html(web({ path, who: at.who }))
      self.routes["GET /"] = () => new Response(null, { status: 302, headers: { location: fb.base + home(all) } })
      // The sheet, the script and the fonts: open to all (the sign-in page needs them), kept by the browser for a year
      // because a changed file has a new mark in its address.
      for (const [name, type] of Object.entries(FILES))
        self.routes[`GET /assets/${name}`] = Object.assign(
          () =>
            new Response(name === "page.css" ? sheet() : new Uint8Array(get(name).body), { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } }),
          {
            open: "all" as const,
          },
        )
      return { list: () => [...all].map(([path, p]) => ({ path, title: p.title })), render: web, head: (title) => head(fb.base, title) } satisfies Pages
    },
    docs: `## The page, for people
People read, find their way, understand, and see what needs them, on a phone or a desktop. The page is at the address \`flowbound dev\` prints (http://localhost:4111). The menu: \`/home\` (Home: what needs attention, such as a yes that waits or a missing key, recent runs, this month's spend, and a Get started list on a first day), \`/workflows\` (workflows in their folders; each with the Mermaid diagram you wrote, its code, runs and data), \`/runs\` (what ran, what failed and why), \`/schedules\` (every schedule and webhook), \`/tables\` (Data: every table in the folders of its workflows, each bought answer with its source, age and cost, and Flowbound's own tables), \`/context\` (the files in context/, to read), \`/keys\` (Connections: each a name and a key, typed only there), \`/connect\` (Agents: how to connect one, and the connected ones), \`/permissions\` (the mode and caps; live, a People tab for Admins and Owners). \`/changes\` (saved changes not live yet, with their checks; ask the agent to publish) is reached from "N changes not live · See them" under the menu.
When the person needs a view, return the run, table or workflow from MCP execute and call show with the suggested arguments. Skip show if they ask for no app. The run view updates live. Open it once and say it will show the outcome. Leave the link to the app's Open web page button. In text-only chats, give them the returned page link. A yes is never a button on the page: the person tells you, and you pass it on.
A plugin's own page is one HTML file (\`pages: { "/path": { title, file, menu: true } }\`) with one script, \`fb.page("/path", async (root, params) => { ... })\`. Build it from the shared parts so it looks and behaves like the rest: \`fb.ui.head\`, \`fb.ui.status\`, \`fb.ui.facts\`, \`fb.ui.table\`, \`fb.ui.empty\`, \`fb.ui.note\`, \`fb.ui.field\`, buttons with \`class="btn"\`, and \`fb.call\`, \`fb.act\`, \`fb.confirm\`, \`fb.say\`, \`fb.poll\`. Only those parts are styled: other class names do nothing.`,
  })
  return self
}
