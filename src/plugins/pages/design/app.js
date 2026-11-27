// The one script every page shares. A page asks for data with fb.call(tool, input), which goes to this Flowbound's
// HTTP API. It also holds the parts every page is made of (fb.ui), so a page says what it shows and never how it looks.
import arrowDown from "lucide-static/icons/arrow-down.svg"
import arrowUp from "lucide-static/icons/arrow-up.svg"
import arrowUpRight from "lucide-static/icons/arrow-up-right.svg"
import chevronDown from "lucide-static/icons/chevron-down.svg"
import chevronLeft from "lucide-static/icons/chevron-left.svg"
import chevronRight from "lucide-static/icons/chevron-right.svg"
import circleAlert from "lucide-static/icons/circle-alert.svg"
import circleCheck from "lucide-static/icons/circle-check.svg"
import clock from "lucide-static/icons/clock.svg"
import code from "lucide-static/icons/code.svg"
import coins from "lucide-static/icons/coins.svg"
import copy from "lucide-static/icons/copy.svg"
import database from "lucide-static/icons/database.svg"
import download from "lucide-static/icons/download.svg"
import fileText from "lucide-static/icons/file-text.svg"
import folder from "lucide-static/icons/folder.svg"
import squareArrowOutUpRight from "lucide-static/icons/square-arrow-out-up-right.svg"
import globe from "lucide-static/icons/globe.svg"
import menu from "lucide-static/icons/menu.svg"
import play from "lucide-static/icons/play.svg"
import repeat from "lucide-static/icons/repeat.svg"
import search from "lucide-static/icons/search.svg"
import sparkles from "lucide-static/icons/sparkles.svg"
import squarePen from "lucide-static/icons/square-pen.svg"
import table from "lucide-static/icons/table.svg"
import triangleAlert from "lucide-static/icons/triangle-alert.svg"
import upload from "lucide-static/icons/upload.svg"
import userCheck from "lucide-static/icons/user-check.svg"
import x from "lucide-static/icons/x.svg"

const ICONS = { "arrow-down": arrowDown, "arrow-up": arrowUp, "arrow-up-right": arrowUpRight, "chevron-down": chevronDown, "chevron-left": chevronLeft, "chevron-right": chevronRight, "circle-alert": circleAlert, "circle-check": circleCheck, clock, code, coins, copy, database, download, "file-text": fileText, folder, globe, menu, play, repeat, search, sparkles, "square-pen": squarePen, "square-arrow-out-up-right": squareArrowOutUpRight, table, "triangle-alert": triangleAlert, upload, "user-check": userCheck, x }

const fb = (() => {
  const boot = window.FB
  const bridge = window.FB_BRIDGE
  const renders = {}
  const templates = {}
  let ids = 0
  let params = Object.fromEntries(new URLSearchParams(location.search))
  let current = boot.page
  let tools
  let paths

  /** h("div", { class: "card" }, child, "text") - text is always set as text, never as HTML. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
      else if (v === true) el.setAttribute(k, "")
      else if (v !== false && v != null) el.setAttribute(k, v)
    }
    for (const kid of kids.flat(3)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid))
    return el
  }
  /** One of the icons above, drawn in the page: 16px, never read aloud. */
  function icon(name) {
    const t = document.createElement("template")
    t.innerHTML = ICONS[name] || ""
    const svg = t.content.querySelector("svg")
    if (!svg) return document.createTextNode("")
    for (const a of ["class", "width", "height"]) svg.removeAttribute(a)
    svg.setAttribute("aria-hidden", "true")
    svg.setAttribute("class", "size-4 shrink-0")
    return svg
  }

  async function call(tool, input) {
    if (bridge) return bridge.call(tool, input)
    const res = await fetch(`${base}/api/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-flowbound-via": "page" }, body: JSON.stringify(input || {}) })
    if (res.status === 401 || res.redirected) {
      // Signed out: on the way to the door. The page that asked is left waiting, so it never draws half an answer.
      location.href = `${base}/door?to=${encodeURIComponent(location.pathname + location.search)}`
      return new Promise(() => {})
    }
    // Something between the person and this Flowbound answered instead (a proxy's error page).
    const out = await res.json().catch(() => {
      throw new Error("This Flowbound did not answer. Try again in a moment.")
    })
    if (!out.ok) throw Object.assign(new Error(out.error), out)
    return out.result
  }

  // Where this Flowbound is shared under a path (https://host/flowbound), every address of its own starts with it.
  const base = boot.base || ""
  const plain = (path, p) => {
    const q = new URLSearchParams(Object.entries(p || {}).filter(([, v]) => v != null && v !== ""))
    return `${path}${q.size ? `?${q}` : ""}`
  }
  /** The address of one of this Flowbound's own pages or routes, for a link or a fetch. */
  const href = (path, p) => base + plain(path, p)
  /** Open a page of this Flowbound, or any address. */
  function open(path, p) {
    const url = /^https?:/.test(path) ? path : boot.url + plain(path, p)
    if (bridge) return bridge.open(url).catch(trouble)
    location.href = url
  }
  /** Move to another page. */
  function go(path, p) {
    if (bridge) {
      if (!paths?.has(path)) return open(path, p)
      current = path
      params = p || {}
      for (const el of document.querySelectorAll(".menu [data-go]")) {
        if (el.dataset.go === path) el.setAttribute("aria-current", "page")
        else el.removeAttribute("aria-current")
      }
      return draw()
    }
    location.href = href(path, p)
  }
  /** A link to one of this Flowbound's pages. */
  const link = (path, p, kids, attrs) => h("a", { href: href(path, p), ...attrs }, kids)
  /** Stay on this page with other settings (a table's page, its search): the address keeps the place. */
  let staying
  let stayAgain = false
  function stay(p) {
    params = Object.fromEntries(Object.entries({ ...params, ...p }).filter(([, v]) => v != null && v !== ""))
    if (!bridge) history.replaceState(null, "", href(current, params))
    // One redraw at a time, always with the newest settings: an older, slower answer never lands on top of a newer one.
    if (staying) return void (stayAgain = true), staying
    staying = (async () => {
      do {
        stayAgain = false
        // Whoever is typing in a field keeps typing in it: the new field gets every key pressed meanwhile, and the cursor.
        const el = document.activeElement && document.activeElement.name ? document.activeElement : null
        await draw()
        const again = el && section(current)?.querySelector(`[name="${CSS.escape(el.name)}"]`)
        if (again && again !== el) {
          const more = again.value !== el.value
          again.value = el.value
          again.focus()
          if (el.selectionStart != null) again.setSelectionRange?.(el.selectionStart, el.selectionEnd)
          if (more) again.dispatchEvent(new Event("input", { bubbles: true }))
        }
      } while (stayAgain)
    })().finally(() => (staying = null))
    return staying
  }

  // ---- what went wrong, and what just happened --------------------------------------------------------------
  /** Say what went wrong where it is seen: on top of the page, and it stays until the next thing the person does. */
  function trouble(e) {
    const el = document.getElementById("trouble")
    if (!el) return
    if (!e) return void (el.hidden = true)
    el.replaceChildren(icon("circle-alert"), h("section", {}, String(e.message || e)), h("footer", {}, h("button", { class: "btn", "data-variant": "ghost", "data-size": "icon-sm", type: "button", "aria-label": "Close", onclick: () => trouble() }, icon("x"))))
    el.hidden = false
    el.scrollIntoView({ block: "nearest" })
  }
  let toastTimer
  /** One short line over the page, read aloud once, gone after a few seconds. */
  function say(text, tone) {
    const el = document.getElementById("said")
    if (!el) return
    clearTimeout(toastTimer)
    el.replaceChildren(icon(tone === "bad" ? "circle-alert" : "circle-check"), text)
    el.dataset.tone = tone || "ok"
    el.hidden = false
    toastTimer = setTimeout(() => (el.hidden = true), tone === "bad" ? 12_000 : 4000)
  }
  /** Run what a button starts: it shows it is working, cannot be tapped twice, and a failure is said out loud. */
  async function act(btn, fn) {
    if (btn.getAttribute("aria-busy") === "true") return
    btn.setAttribute("aria-busy", "true")
    trouble()
    try {
      return await fn()
    } catch (e) {
      trouble(e)
    } finally {
      btn.removeAttribute("aria-busy")
    }
  }
  /** Put a text on the clipboard, also where the browser's own way is not allowed (a plain http address). */
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const t = h("textarea", { class: "sr-only", "aria-hidden": "true" }, text)
      document.body.append(t)
      t.select()
      const ok = document.execCommand("copy")
      t.remove()
      if (!ok) return say("It could not be copied. Select it and copy it by hand.", "bad")
    }
    say("Copied.")
  }
  /** A question before something that cannot be taken back. Resolves to true only on the named action. */
  function confirm(o) {
    return new Promise((done) => {
      const yes = h("button", { class: "btn", "data-variant": o.tone === "bad" ? "destructive" : "primary", type: "button", onclick: () => d.close("yes") }, o.yes)
      const d = h("dialog", { class: "dialog", "aria-labelledby": "ask-title" }, h("div", {}, h("header", {}, h("h2", { id: "ask-title" }, o.title), o.text ? h("p", {}, o.text) : null), h("footer", {}, h("button", { class: "btn", "data-variant": "outline", type: "button", onclick: () => d.close() }, o.no || "Cancel"), yes)))
      d.addEventListener("close", () => (d.remove(), done(d.returnValue === "yes")))
      document.body.append(d)
      d.showModal()
    })
  }

  // ---- drawing ---------------------------------------------------------------------------------------------
  let drawing = 0
  let timer
  let misses = 0
  const section = (path) => document.querySelector(`section[data-page="${CSS.escape(path)}"]`)
  const loading = () => h("div", { class: "loading", role: "status", "aria-label": "Loading" }, ...["w-40 h-6", "w-full", "w-11/12", "w-4/5", "w-2/3"].map((c) => h("span", { class: `skeleton ${c}` })))
  /** Nothing could be shown: say why, and give the ways out. */
  function failed(root, e) {
    const view = root.querySelector("[data-view]") || root
    const menu = document.querySelector(`.menu a[data-go="${CSS.escape(current)}"]`)
    // What is missing will still be missing on a second try, so the way back comes first. A line that tells an agent
    // which command to run is not for a person on a page.
    const back = Object.keys(params).length && menu ? link(current, {}, `All ${menu.textContent.toLowerCase()}`, { class: "btn" }) : null
    const text = String(e.message || e).replace(/\s+[A-Z][^.:]*: npx flowbound[^.]*\.?\s*$/, "")
    view.replaceChildren(ui.head({ title: menu ? menu.textContent : "Flowbound" }), ui.empty({ title: text, actions: [back, h("button", { class: "btn", "data-variant": back ? "outline" : null, type: "button", onclick: () => draw() }, "Try again")] }))
  }
  /** While a run goes on the page is refreshed, never rebuilt: only the parts marked data-live that changed are
      swapped, so what the person is doing (a scroll, a focus, a selection, a typed cap) is left alone. */
  function patch(live, fresh) {
    const shape = (el) => {
      const c = el.cloneNode(true)
      for (const part of c.querySelectorAll("[data-live]")) part.replaceWith(document.createComment(part.dataset.live))
      return c.innerHTML
    }
    if (shape(live) === shape(fresh)) {
      const now = fresh.querySelectorAll("[data-live]")
      live.querySelectorAll("[data-live]").forEach((el, i) => {
        if (el.isEqualNode(now[i])) return
        // A table that grew a row is still scrolled to where the person left it.
        const was = [...el.querySelectorAll(".table-container")].map((box) => [box.scrollLeft, box.scrollTop])
        el.replaceWith(now[i])
        now[i].querySelectorAll(".table-container").forEach((box, k) => was[k] && box.scrollTo(was[k][0], was[k][1]))
      })
      return
    }
    // The page changed its shape (a run ended, a button went away): take the new one, and keep what can be kept.
    const typed = new Map([...live.querySelectorAll("input[name]")].filter((i) => i.value !== i.defaultValue).map((i) => [i.name, i.value]))
    const at = document.activeElement && live.contains(document.activeElement) ? `${document.activeElement.tagName}|${document.activeElement.getAttribute("name") || document.activeElement.textContent}` : null
    const scrolled = [...live.querySelectorAll(".table-container")].map((el) => el.scrollLeft)
    live.replaceChildren(...fresh.childNodes)
    for (const [name, value] of typed) for (const i of live.querySelectorAll(`input[name="${CSS.escape(name)}"]`)) i.value = value
    live.querySelectorAll(".table-container").forEach((el, i) => (el.scrollLeft = scrolled[i] || 0))
    if (at) [...live.querySelectorAll("a,button,input,select")].find((el) => `${el.tagName}|${el.getAttribute("name") || el.textContent}` === at)?.focus()
  }
  function offline(on) {
    const el = document.getElementById("offline")
    if (el) el.hidden = !on
  }
  async function draw(o = {}) {
    const mine = ++drawing
    clearTimeout(timer)
    for (const s of document.querySelectorAll("section[data-page]")) s.hidden = s.dataset.page !== current
    const root = section(current)
    if (!root || !renders[current]) return false
    if (o.refresh) {
      const fresh = root.cloneNode(false)
      fresh.innerHTML = templates[current] ?? "<div data-view></div>"
      try {
        await renders[current](fresh, params)
      } catch {
        // The page stays as it was, says the connection is gone, and tries again a little later each time.
        if (mine !== drawing) return
        offline(true)
        timer = setTimeout(() => draw({ refresh: true }), Math.min(30_000, 2000 * 2 ** misses++))
        return
      }
      if (mine !== drawing) return
      misses = 0
      offline(false)
      const live = root.querySelector("[data-view]")
      const next = fresh.querySelector("[data-view]")
      if (live && next) patch(live, next)
      return
    }
    trouble()
    const view = root.querySelector("[data-view]")
    if (view && !view.childElementCount) view.replaceChildren(loading())
    try {
      await renders[current](root, params)
    } catch (e) {
      if (mine === drawing) failed(root, e)
      return false
    }
  }
  /** Ask for this page to be refreshed in a while: for a run in progress. It rests while the tab is not looked at. */
  function poll(ms) {
    if (bridge && document.body.hidden) return
    clearTimeout(timer)
    const mine = drawing
    timer = setTimeout(function again() {
      if (mine !== drawing) return
      if (document.hidden) return document.addEventListener("visibilitychange", again, { once: true })
      draw({ refresh: true })
    }, ms)
  }

  // ---- words and numbers -----------------------------------------------------------------------------------
  const money = (n) => (Math.abs(n) >= 1000 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : n ? `$${n.toFixed(Math.abs(n) >= 0.095 ? 2 : Math.min(6, 1 - Math.floor(Math.log10(Math.abs(n))))).replace(/(\.\d\d\d*?)0+$/, "$1")}` : "$0.00")
  /** 9991 -> 9,991 */
  const num = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? ""))
  /** A moment in the reader's own time: "18:41" today, "26 Nov, 18:41" before, with the year when it is another one. */
  function when(at) {
    const d = new Date(at)
    if (!at || Number.isNaN(d.getTime())) return ""
    const now = new Date()
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    if (d.toDateString() === now.toDateString()) return time
    return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })}, ${time}`
  }
  /** How long ago, in plain words: "now", "2 min ago", "3 h ago", "yesterday", "5 days ago", then the date. */
  function ago(at) {
    const d = new Date(at)
    if (!at || Number.isNaN(d.getTime())) return ""
    const s = (Date.now() - d.getTime()) / 1000
    if (s < 60) return "now"
    if (s < 3600) return `${Math.floor(s / 60)} min ago`
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000)
    if (days === 0) return `${Math.floor(s / 3600)} h ago`
    if (days === 1) return "yesterday"
    if (days < 7) return `${days} days ago`
    return when(at)
  }
  /** How soon, in plain words: "in 15 min", "in 3 h", "tomorrow", "in 3 days". */
  function ahead(at) {
    const d = new Date(at)
    if (!at || Number.isNaN(d.getTime())) return ""
    const s = (d.getTime() - Date.now()) / 1000
    if (s < 60) return "now"
    if (s < 3600) return `in ${Math.ceil(s / 60)} min`
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
    if (days === 0) return `in ${Math.round(s / 3600)} h`
    if (days === 1) return "tomorrow"
    return `in ${days} days`
  }
  /** What a person typed as dollars: "$1.64", "1 000", "2,50" (two and a half, as most of Europe writes it) and
      "1,000.50". NaN when it is not an amount, so an empty box is never a cap of $0. */
  function dollars(text) {
    let t = String(text).replace(/[$\s]/g, "")
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "")
    else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(",", ".")
    return /^\d+(\.\d+)?$|^\.\d+$/.test(t) ? Number(t) : Number.NaN
  }
  const ROLES = ["none", "viewer", "member", "admin", "owner"]
  /** May the person looking at the page do this? On your own computer: everything. */
  const can = (role) => !boot.who || !boot.who.role || ROLES.indexOf(boot.who.role) >= ROLES.indexOf(role)
  /** The browser tab's name, so two runs open side by side can be told apart. */
  const title = (text) => (document.title = `${text} · Flowbound`)

  // ---- the parts pages are made of ---------------------------------------------------------------------------
  const TONES = { running: "running", done: "ok", active: "ok", saved: "ok", stopped: "bad", failed: "bad", paused: "warn", waiting: "warn", asked: "warn", "needs a yes": "warn", missing: "warn" }
  const ui = {
    icon,
    link,
    /** A state as a dot and a word: ui.status("running"), ui.status("stopped", "Stopped at its cap", "warn") */
    status: (state, text, tone) => h("span", { class: "status", "data-tone": tone || TONES[state] || "idle" }, text || state.replace(/^./, (c) => c.toUpperCase())),
    /** A run's state as the Runs list and a run's page say it: Running · 57 of 200, Waiting for a yes, Done, Failed. */
    runState: (r, short) =>
      r.asks
        ? ui.status("waiting", "Waiting for a yes", "warn")
        : r.state === "running"
          ? ui.status("running", short ? "Running" : `Running · ${num(r.rows.done)} of ${num(r.rows.of)}`)
          : r.state === "stopped"
            ? ui.status("stopped", r.code === "person" ? "Stopped" : "Failed", "bad")
            : ui.status(r.state),
    badge: (text, tone) => h("span", { class: "badge", "data-variant": tone === "bad" ? "destructive" : "secondary", "data-tone": tone }, text),
    /** The top of a page: ui.head({ title, sub, back: ["/runs", "All runs"], status, actions }) */
    head(o) {
      title(o.title)
      return h(
        "header",
        { class: "page-head" },
        h("div", {}, o.back ? link(o.back[0], {}, [icon("chevron-left"), o.back[1]], { class: "crumb" }) : null, h("div", { class: "title" }, h("h1", { class: o.mono ? "font-mono text-lg" : null }, o.title), o.status), o.sub ? h("p", {}, o.sub) : null),
        o.actions && o.actions.filter(Boolean).length ? h("div", { class: "actions" }, o.actions) : null,
      )
    },
    /** Nothing here yet: one line, what to do, at most two ways on. */
    empty: (o) => h("div", { class: "empty" }, h("header", {}, h("h2", {}, o.title), o.text ? h("p", {}, o.text) : null), o.actions && o.actions.filter(Boolean).length ? h("section", {}, h("div", { class: "actions" }, o.actions)) : null, o.more),
    /** Name and value, one per line: ui.facts([["Yes by", "Maya"], ["Results", link]]) */
    facts: (list, attrs) => h("dl", { class: "facts", ...attrs }, list.filter(Boolean).map(([k, v, live]) => h("div", { "data-live": live }, h("dt", {}, k), h("dd", {}, v)))),
    /** A strip of numbers: ui.stats([["Rows", "57 of 9,991", bar], ...]) */
    stats: (list, attrs) => h("dl", { class: "stats", ...attrs }, list.filter(Boolean).map(([k, v, more]) => h("div", {}, h("dt", {}, k), h("dd", {}, v), more))),
    progress: (done, of, tone) => h("span", { class: "progress", "data-tone": tone, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(of), "aria-valuenow": String(done), "aria-label": `${num(done)} of ${num(of)}` }, h("span", { style: `width:${of ? Math.min(100, (100 * done) / of) : 0}%` })),
    /** A note in the page: ui.note("Stopped at the $0.05 cap ...", "warn") */
    note: (text, tone, attrs) => h("div", { class: "alert", "data-tone": tone === "warn" ? "warn" : null, "data-variant": tone === "bad" ? "destructive" : null, ...attrs }, icon(tone === "bad" ? "circle-alert" : tone === "warn" ? "triangle-alert" : "circle-check"), h("section", {}, h("p", {}, text))),
    /** What needs a person: what is the matter, the one thing to do, and the way there.
        ui.todo([{ what, fix, page: "/keys", params, when: "soon" }]) */
    todo: (items) =>
      h("ul", { class: "todo", role: "list" }, items.map((n) =>
        h("li", {},
          h("div", {}, h("p", {}, n.when === "soon" ? [ui.badge("Soon"), " "] : null, n.what), h("p", {}, n.fix)),
          n.page ? link(n.page, n.params || {}, "Open", { class: "btn", "data-variant": "outline", "data-size": "sm" }) : null))),
    /** A field with its name above and a line of help below. */
    field: (label, input, hint) => {
      const id = input.id || `f${++ids}`
      input.id = id
      if (hint) input.setAttribute("aria-describedby", `${id}-hint`)
      return h("div", { class: "field" }, h("label", { for: id }, label), input, hint ? h("p", { id: `${id}-hint` }, hint) : null)
    },
    /** A table of data inside its own sideways scroll: ui.table(["Row", "Why"], rows.map((r) => [r.row, r.reason])) */
    table: (heads, rows, attrs) =>
      h("div", { class: "table-container", tabindex: "0", role: "region", "aria-label": (attrs && attrs.label) || "Table" }, h("table", { class: "table" }, h("thead", {}, h("tr", {}, heads.map((t) => h("th", { scope: "col" }, t)))), h("tbody", {}, rows.map((r) => (r.nodeType ? r : h("tr", {}, r.map((c) => (c && c.nodeType === 1 && c.tagName === "TD" ? c : h("td", {}, c))))))))),
    /** Where you are, as a path back up: ui.path([["/workflows", {}, "Workflows"], ["/workflows", { folder: "tam" }, "Tam"]], "Find sales heads") */
    path: (ups, here) =>
      h("nav", { class: "path", "aria-label": "Where you are" }, ups.map(([p, q, label]) => [link(p, q, label, { class: "link" }), h("span", { "aria-hidden": "true" }, "/")]), h("span", { "aria-current": "page" }, here)),
    /** Tabs that keep their place in the address: ui.tabs(["Diagram", "Code"], "Code", "tab") */
    tabs: (names, on, key) =>
      h("nav", { class: "tabs", "aria-label": "Tabs" }, names.map((n) => link(current, { ...params, [key]: n.toLowerCase() }, n, { "aria-current": n === on ? "page" : null, onclick: (e) => (e.preventDefault(), stay({ [key]: n.toLowerCase() })) }))),
    /** Words with their web addresses made into links (a reason that names a manual page). */
    linked: (text) => String(text).split(/(https?:\/\/[^\s)"]+)/).map((part, i) => (i % 2 ? h("a", { class: "link", href: part, target: "_blank", rel: "noreferrer" }, part) : part)),
  }

  /** Can this page call the tool here? In a chat's app only the tools the host hands over. */
  const supports = (tool) => !bridge || !!tools?.has(tool)
  // ---- a table's rows: the Data page's grid, also on a workflow's Data tab ----------------------------------------
  const cellText = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))
  /** The kept fact behind one answer, in a small panel: where it came from, what was asked, when, what it cost. */
  async function factOf(t, r, i) {
    const value = cellText(r.cells[i]) || "not found"
    const dialog = h("dialog", { class: "dialog", "aria-label": "Where this came from", onclose: () => dialog.remove() })
    const body = h("section", {}, h("div", { class: "loading", role: "status", "aria-label": "Loading" }, h("span", { class: "skeleton w-full" }), h("span", { class: "skeleton w-4/5" }), h("span", { class: "skeleton w-2/3" })))
    dialog.append(h("div", {}, h("header", {}, h("h2", { class: "pr-6 leading-snug wrap-anywhere" }, value), h("p", {}, `${t.columns[i].name}, row ${num(r.id)}`)), body, h("footer", {}, h("button", { class: "btn", "data-variant": "outline", type: "button", onclick: () => dialog.close() }, "Close"))))
    document.body.append(dialog)
    dialog.showModal()
    try {
      if (r.facts[i]) {
        const f = await call("fact", { id: r.facts[i] })
        const asked = h("span", { class: "font-mono wrap-anywhere" }, [f.endpoint, f.question].filter(Boolean).join(" "))
        body.replaceChildren(ui.facts(f.write
          ? [["To", f.from], ["Wrote", asked], ["When", `${f.boughtOn} (${f.age})`], ["Kind", "A write to another tool: done every time, never answered from memory"], ["By", f.by]]
          : [["From", f.from], ["Asked", asked], ["Bought", `${f.boughtOn} (${f.age})`], ["Cost", f.cost], ["Fresh", f.fresh ? "Yes: asked again, it is free" : "No: it is bought again next time"], ["By", f.by]]))
      } else {
        const f = await call("fact", { into: t.name, row: r.id })
        body.replaceChildren(
          h("p", { class: "mb-3" }, `Worked out by ${f.workedOutBy || "the workflow"}, not picked from one answer. The calls made for this row:`),
          f.calls.length ? ui.facts(f.calls.map((c) => [`${c.from} ${c.request && c.request.path ? c.request.path : ""}`, c.cost])) : h("p", { class: "text-muted-foreground" }, "No calls were made for this row."))
      }
    } catch (e) {
      body.replaceChildren(ui.note(String(e.message || e), "bad"))
    }
  }
  /** Open the database one step deeper: Drizzle Studio here (started on the first tap), the project's Neon console live. */
  function deeper(way) {
    if (!way || !supports("data-open")) return null
    if (way.href) return h("a", { class: "btn", "data-variant": "outline", href: way.href, target: "_blank", rel: "noreferrer", title: way.where }, way.label, icon("arrow-up-right"))
    const b = h("button", { class: "btn", "data-variant": "outline", type: "button", title: way.where }, way.label, icon("arrow-up-right"))
    b.onclick = () => {
      // A window opened now, while the tap counts, and sent on once Studio is up: a later one would be blocked.
      const w = bridge ? null : window.open("", "_blank")
      return act(b, async () => {
        try {
          const up = await call("data-open", {})
          if (w) w.location.href = up.href
          else open(up.href)
          say(up.note || `${way.label}.`)
        } catch (e) {
          w?.close()
          throw e
        }
      })
    }
    return b
  }
  /**
   * One table, a page of its rows at a time: Search, Download CSV, Open in (only where it works), then the grid with
   * every bought answer's source, age and cost under it (tap it for the kept fact), then Previous and Next.
   * ui.grid(view, { page, size, open }): view is what the table tool answered; the address keeps q, sort, desc, page.
   */
  function grid(t, o) {
    const size = o.size || 50
    const page = o.page || 1
    const all = t.found ?? t.total
    let typing
    const q = h("input", { class: "input", type: "search", name: "q", placeholder: "Search this table", "aria-label": "Search this table", autocomplete: "off", value: params.q || "" })
    const find = () => (clearTimeout(typing), (q.value.trim() || "") !== (params.q || "") && stay({ q: q.value.trim(), page: null }))
    q.addEventListener("input", () => (clearTimeout(typing), (typing = setTimeout(find, 350))))
    const download = h("button", { class: "btn", "data-variant": "outline", type: "button" }, icon("download"), "Download CSV")
    download.onclick = () =>
      act(download, async () => {
        const out = await call("export", { table: t.name })
        if (out.tooBigForChat) return say(out.tooBigForChat)
        const a = h("a", { href: URL.createObjectURL(new Blob([out.save.text], { type: "text/csv" })), download: out.save.name })
        a.click()
        URL.revokeObjectURL(a.href)
      })
    const inline = !!bridge && document.body.dataset.mode === "inline"
    const tools = h("form", { class: "toolbar", role: "search", onsubmit: (e) => (e.preventDefault(), find()) }, q, supports("export") && !inline ? download : null, inline ? null : deeper(o.open))
    /** A column's name is also how to sort by it: once from the lowest, again from the highest, a third time as it was. */
    const heading = (c) => {
      const on = params.sort === c.name
      const next = !on ? { sort: c.name, desc: null } : params.desc ? { sort: null, desc: null } : { sort: c.name, desc: 1 }
      return h("th", { scope: "col", "aria-sort": on ? (params.desc ? "descending" : "ascending") : null },
        h("button", { class: "hover:text-foreground -ml-1 inline-flex cursor-pointer items-center gap-1 rounded-sm px-1", type: "button", title: `Sort by ${c.name}`, onclick: () => stay({ ...next, page: null }) }, c.name, on ? icon(params.desc ? "arrow-down" : "arrow-up") : null))
    }
    const line = (r) =>
      h("tr", {}, t.columns.map((c, i) => {
        const v = cellText(r.cells[i])
        if (c.of !== "result") return h("td", { class: "cut", title: v.length > 34 ? v : null }, v)
        // Where it came from, how old it is and what it cost: on every answered cell, as one small line.
        const src = r.sources && r.sources[i]
        const tap = supports("fact") && r.id != null && (r.facts[i] || v)
        return h("td", { class: v ? null : "none" }, tap ? h("button", { type: "button", title: v.length > 34 ? v : null, onclick: () => factOf(t, r, i) }, v || "not found") : v || "not found", src ? h("span", { class: "src" }, src) : null)
      }))
    const from = all ? (page - 1) * size + 1 : 0
    const turn = (label, to, off) => h("button", { class: "btn", "data-variant": "outline", "data-size": "sm", type: "button", disabled: off, onclick: () => stay({ page: to > 1 ? to : null }) }, label)
    return [
      tools,
      t.rows.length
        ? h("div", { class: "table-container", tabindex: "0", role: "region", "aria-label": t.name }, h("table", { class: "table" }, h("thead", {}, h("tr", {}, t.columns.map(heading))), h("tbody", {}, t.rows.map(line))))
        : params.q
          ? ui.empty({ title: `Nothing in ${o.label || t.name} has "${params.q}"`, actions: [h("button", { class: "btn", "data-variant": "outline", type: "button", onclick: () => stay({ q: null, page: null }) }, "Show every row")] })
          : h("p", { class: "text-muted-foreground" }, o.none || "No rows yet."),
      all ? h("div", { class: "pager" }, h("p", { class: "num", role: "status" }, `${num(from)} to ${num(from + t.rows.length - 1)} of ${num(all)}`), all > size ? h("div", { class: "actions" }, turn("Previous", page - 1, page <= 1), turn("Next", page + 1, from + t.rows.length - 1 >= all)) : null) : null,
    ]
  }

  // ---- Markdown, read: a file of context drawn as a page. Built as elements, never as HTML, so a file runs nothing. --
  /** **bold**, *italic*, `code`, [a link](https://...) and bare web addresses, inside one line. */
  function inline(text) {
    const out = []
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)<]+)/g
    let at = 0
    for (let m; (m = re.exec(text)); ) {
      if (m.index > at) out.push(text.slice(at, m.index))
      if (m[1]) out.push(h("code", {}, m[1]))
      else if (m[2] || m[3]) out.push(h("strong", {}, inline(m[2] || m[3])))
      else if (m[4] || m[5]) out.push(h("em", {}, inline(m[4] || m[5])))
      else if (m[6]) out.push(/^(https?:|mailto:)/.test(m[7]) ? h("a", { href: m[7], target: "_blank", rel: "noreferrer" }, inline(m[6])) : h("span", {}, inline(m[6])))
      else if (m[8]) out.push(h("a", { href: m[8], target: "_blank", rel: "noreferrer" }, m[8]))
      at = m.index + m[0].length
    }
    out.push(text.slice(at))
    return out
  }
  function markdown(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n")
    const out = []
    const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
    for (let i = 0; i < lines.length; ) {
      const l = lines[i]
      if (!l.trim()) {
        i++
        continue
      }
      const fence = /^\s*(```|~~~)/.exec(l)
      if (fence) {
        const body = []
        for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i])
        i++
        out.push(h("pre", {}, h("code", {}, body.join("\n"))))
        continue
      }
      const head = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l)
      if (head) {
        out.push(h(`h${Math.min(6, head[1].length)}`, {}, inline(head[2])))
        i++
        continue
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
        out.push(h("hr", {}))
        i++
        continue
      }
      if (/^\s*>/.test(l)) {
        const body = []
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""))
        out.push(h("blockquote", {}, markdown(body.join("\n"))))
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
        const heads = row(l)
        const body = []
        for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) body.push(row(lines[i]))
        out.push(h("div", { class: "table-container", tabindex: "0", role: "region", "aria-label": "Table" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map((c) => h("th", {}, inline(c))))), h("tbody", {}, body.map((r) => h("tr", {}, r.map((c) => h("td", {}, inline(c)))))))))
        continue
      }
      const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/
      if (item.test(l)) {
        const ordered = /\d/.test(item.exec(l)[1])
        const items = []
        for (; i < lines.length && (item.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
          const m = item.exec(lines[i])
          if (m) items.push([m[2].replace(/^\[([ xX])\]\s+/, (_, x) => (x === " " ? "☐ " : "☑ "))])
          else items.at(-1).push(lines[i].trim())
        }
        out.push(h(ordered ? "ol" : "ul", {}, items.map((x) => h("li", {}, inline(x.join(" "))))))
        continue
      }
      const para = []
      for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]); i++) para.push(lines[i].trim())
      out.push(h("p", {}, inline(para.join(" "))))
    }
    return out
  }
  ui.grid = grid
  ui.markdown = markdown

  function frame() {
    for (const el of document.querySelectorAll("[data-icon]")) el.replaceChildren(icon(el.dataset.icon))
    const drawer = document.getElementById("menu")
    document.getElementById("menu-open")?.addEventListener("click", () => drawer.showModal())
    // A tap beside the menu closes it, as does a tap on a link in it.
    drawer?.addEventListener("click", (e) => (e.target === drawer || e.target.closest("a, [data-close]")) && drawer.close())
    if (bridge) document.addEventListener("click", (e) => {
      const link = e.target.closest("a[href]")
      if (!link || link.hasAttribute("download") || link.hash.startsWith("#main")) return
      const address = link.getAttribute("href")
      if (!address.startsWith("/") && !/^https?:/.test(address)) return
      e.preventDefault()
      if (link.classList.contains("brand")) return paths?.size && go(paths.values().next().value, {})
      if (link.dataset.go) return go(link.dataset.go, {})
      if (/^https?:/.test(address)) return open(address)
      const [path, query] = address.slice(base.length).split("?")
      const args = Object.fromEntries(new URLSearchParams(query))
      return link.hasAttribute("data-web") ? open(path, args) : go(path, args)
    })
    menuNews()
    for (const s of document.querySelectorAll("section[data-page]")) {
      const t = s.cloneNode(true)
      for (const script of t.querySelectorAll("script")) script.remove()
      templates[s.dataset.page] = t.innerHTML
    }
  }
  /** Home's count in the menu: the number of things under Needs attention. */
  function count(n) {
    for (const el of document.querySelectorAll(".menu [data-count]")) {
      el.textContent = n ? String(n) : ""
      el.hidden = !n
    }
  }
  /** The menu's news, asked once a page opens: Home's count, and how many saved changes are not live yet. */
  function menuNews() {
    if (bridge) return
    if (document.querySelector(".menu [data-count]") && current !== "/home" && current !== "/needs") call("doctor").then((r) => count(r.needs.length), () => {})
    if (document.querySelector(".menu [data-changes]"))
      call("workflow-changes", {}).then(
        (r) => {
          const n = (r.changes || []).length
          for (const el of document.querySelectorAll(".menu [data-changes]")) {
            el.replaceChildren(`${n} ${n === 1 ? "change" : "changes"} not live · `, h("u", {}, "See them"))
            el.hidden = !n
          }
        },
        () => {},
      )
  }
  async function start() {
    frame()
    if (bridge) {
      try {
        await bridge.start((view) => {
          boot.url = view.url
          boot.live = view.live
          for (const place of document.querySelectorAll("[data-place]")) {
            place.dataset.place = view.live ? "live" : "local"
            place.textContent = view.live ? "Live" : "Your computer"
          }
          boot.who = { role: view.role ?? "viewer" }
          tools = new Set(view.tools ?? [])
          paths = new Set(view.paths)
          for (const link of document.querySelectorAll(".menu [data-go]")) link.hidden = !paths.has(link.dataset.go)
          return go(view.path, view.params)
        })
      } catch (error) {
        trouble(error)
      }
      return
    }
    return draw()
  }

  return {
    get live() { return boot.live },
    get url() { return boot.url },
    get who() { return boot.who },
    /** Where Mermaid is, for a page that draws a diagram. */
    get mermaid() { return bridge ? `${boot.url}/assets/mermaid.js` : boot.mermaid },
    embedded: !!bridge,
    compact: () => !!bridge && document.body.dataset.mode === "inline",
    supports,
    route: () => plain(current || "/runs", params),
    h,
    call,
    open,
    go,
    stay,
    href,
    money,
    num,
    when,
    ago,
    ahead,
    count,
    dollars,
    can,
    title,
    trouble,
    say,
    act,
    copy,
    confirm,
    poll,
    ui,
    redraw: () => draw(),
    stopRefresh() {
      drawing++
      clearTimeout(timer)
    },
    /** Each page file registers how it draws itself: fb.page("/runs", async (root, params) => { ... }) */
    page(path, render) {
      renders[path] = render
    },
    start,
  }
})()
window.fb = fb
addEventListener("DOMContentLoaded", () => fb.start())
