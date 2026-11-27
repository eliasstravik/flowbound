// Needs you: the page a person opens first, and the check-up an agent runs first. Neither knows any other plug-in:
// each plug-in says what needs a person (its `attention`: a yes that waits, a key), and this one only gathers it.
import { type Attention, type Flowbound, plugin } from "../core/plugin.ts"
import { asset } from "./util.ts"

export type Need = Attention & { from: string; link?: string }
export type Checkup = {
  /** True when nothing is stopped or broken now. Things that only come due soon do not make it false. */
  ok: boolean
  needs: Need[]
  /** The plug-ins that were asked. */
  checked: string[]
  page: string
}
export type Overview = { checkup: (o?: { deep?: boolean }) => Promise<Checkup> }

export const overview = () => {
  let fb: Flowbound

  const checkup: Overview["checkup"] = async ({ deep } = {}) => {
    const needs: Need[] = []
    const checked: string[] = []
    for (const p of fb.plugins) {
      if (typeof p.attention !== "function") continue
      checked.push(p.name)
      try {
        for (const a of await p.attention({ deep })) {
          const query = a.params && Object.keys(a.params).length ? `?${new URLSearchParams(Object.entries(a.params).map(([k, v]) => [k, String(v)]))}` : ""
          needs.push({ ...a, from: p.name, ...(a.page ? { link: `${fb.url}${a.page}${query}` } : {}) })
        }
      } catch (e: any) {
        // One plug-in that cannot answer must not hide what the others found.
        needs.push({ from: p.name, what: `The ${p.name} plugin could not say how it is: ${String(e?.message ?? e).split("\n")[0]}`, fix: "Run the check-up again. If it stays, look at .flowbound/dev.log." })
      }
    }
    // What is stopped now comes before what only comes due soon; within each, as the plug-ins are listed.
    needs.sort((a, b) => Number(a.when === "soon") - Number(b.when === "soon"))
    return { ok: !needs.some((n) => n.when !== "soon"), needs, checked, page: `${fb.url}/needs` }
  }

  return plugin({
    name: "overview",
    provides: "overview",
    start(f) {
      fb = f
      return { checkup } satisfies Overview
    },
    tools: {
      doctor: {
        about:
          "Needs you: everything that needs a person or is not right, each with the one thing to do about it. A yes that waits (ask mode, or a run paused at a cap), a key a workflow needs, a workflow file that is not well formed, a run that stopped short or seems stuck, a webhook with no signing secret. Run it first when something seems off, and before telling the person all is well.",
        role: "viewer",
        input: { deep: { type: "boolean", about: "also try every saved key again at its provider (a free call each)" } },
        run: (i) => checkup({ deep: i.deep === true }),
        print: (r: Checkup) => {
          const line = (n: Need, i: number) => `${i + 1}. ${n.what}\n   Do: ${n.fix}${n.link ? `\n   ${n.link}` : ""}`
          const now = r.needs.filter((n) => n.when !== "soon")
          const soon = r.needs.filter((n) => n.when === "soon")
          return [
            now.length ? `${now.length} ${now.length === 1 ? "thing needs" : "things need"} a person:` : "Nothing is stopped or broken.",
            ...now.map(line),
            ...(soon.length ? ["", "Coming up:", ...soon.map(line)] : []),
            "",
            `Looked at: ${r.checked.join(", ") || "nothing (no plugin in the list says how it is)"}.`,
            `Page: ${r.page}`,
          ].join("\n")
        },
      },
    },
    pages: { "/needs": { title: "Needs you", file: asset("overview/overview.html"), menu: true, first: true, order: 1 } },
    docs: asset("overview/overview.md"),
  })
}
