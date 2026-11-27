// Runs: workflows are plain TypeScript on the open Workflow SDK. Flowbound reads the list, saves, skips and links.
import fs from "node:fs"
import path from "node:path"
import { type Attention, can, type Flowbound, plugin, type Route, type Who } from "../core/plugin.ts"
import { Refused } from "../core/server.ts"
import type { Ledger } from "./ledger.ts"
import type { Records } from "./postgres.ts"
import { asset, day, sha, sleep, usd } from "./util.ts"
import type { Manifest, Wf } from "./workflow-sdk/build.ts"
import { editorHere, openInEditor, placeOf, vercelNames, vercelPage, workflowUi } from "./workflow-sdk/open.ts"

type Run = {
  id: number
  workflow: string
  title: string
  kind: "tryout" | "run" | "schedule" | "webhook"
  state: "waiting" | "running" | "paused" | "stopped" | "done"
  code: string | null
  reason: string | null
  file_hash: string
  list: string
  into_table: string
  total: number
  lanes: number
  budgets: string[]
  yes: number | null
  asked_by: string | null
  started_at: string
  finished_at: string | null
  /** What started it, when nobody asked ("schedule:weekly-heads", "webhook:new-leads"); and the cap that paused it, waiting for a yes. */
  standing: number | null
  started_by: string | null
  cap_kind: string | null
  /** The permission mode it runs in, worked out when it began: the strictest rule that holds for it. */
  mode: "ask" | "auto" | "skip"
  /** Caps a yes lifted for this run (a month's cap the person said to go past). */
  lifted: string[]
  /** Its habits, from the workflow file: extra tries for a busy provider, and when too many failures pause it. */
  retries: number
  pause_failed: number | null
  pause_of: number | null
  /** How far down the list this run has taken rows, and how many it has taken: the next batch starts after `cursor`. */
  cursor: number
  claimed: number
}
type Ready = Wf & { from: string; into: string }
/** What the schedules part gets from the runner: the only way a run starts with nobody there. */
export type Auto = {
  workflow: (id: string) => Ready
  rowsLeft: (wf: Ready) => Promise<number>
  /** A run of this workflow that is going now, of any kind. */
  going: (workflow: string) => Promise<{ run: number; by: string | null } | undefined>
  /** A run of this workflow that waits for a yes (asked first, or paused at a cap): while one waits, a schedule skips. */
  waitingYes: (workflow: string) => Promise<number | undefined>
  /** Start a run under the permissions, like any other. Undefined when another one of this workflow started in the same moment. */
  launch: (o: { wf: Ready; kind: "schedule" | "webhook"; by: string }) => Promise<{ run: number; state: string } | undefined>
  /** Rows that arrived while a run started the same way is going: it takes them too. Undefined when that run has just ended. */
  absorb: (by: string, rows: number) => Promise<number | undefined>
  last: (by: string) => Promise<unknown>
}
export type Home = "local" | "vercel" | "postgres" | "cloudflare"

/** 42 s, 3 min 12 s, 2 h 5 min: how long something took, in the two biggest parts. */
export const took = (from: Date | string, to?: Date | string | null) => {
  const s = Math.max(0, Math.round((new Date(to ?? Date.now()).getTime() - new Date(from).getTime()) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`
  if (s < 86400) return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`
  return `${Math.floor(s / 86400)} d${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)} h` : ""}`
}

const TRY_MAX = 10
/** Rows one lane takes at a time: one small workflow run does them one after the other. Found by measuring (docs/scale.md). */
const ROWS_PER_BATCH = 25
/**
 * Batches one run of the driver hands out before it carries on in a fresh run of itself, so its history stays small:
 * a batch is about 10 events in the driver's own history, and the Workflow SDK replays slower past 2,000 (docs/scale.md).
 */
const BATCHES_PER_DRIVER = 100
const S = "fb_workflow_sdk"

export const workflowSdk = (opts: { on?: Home; editor?: string; vercel?: string } = {}) => {
  let fb: Flowbound
  let ui: Promise<(req: Request) => Promise<Response>> | undefined
  let manifest: Manifest = { workflows: {}, ids: { run: "", row: "", clock: "" } }
  let flow: { POST: (req: Request) => Promise<Response> } | undefined
  let webhook: Record<string, (req: Request) => Promise<Response>> | undefined
  const db = () => fb.use<Records>("records")
  const ledger = () => fb.use<Ledger>("ledger")
  const q = async <T = any>(sql: string, params?: unknown[]) => (await db().query<T>(sql, params)).rows
  const getRun = async (id: number) => (await q<Run>(`select * from ${S}.runs where id = $1`, [id]))[0]
  const startWf = async (id: string, args: unknown[]) => (await import("workflow/api")).start({ workflowId: id } as any, args)
  const claims = new Map<number, Promise<unknown>>()

  /** The schedule and webhook lines of the list, as the schedules part declares them. */
  type Line = { name: string; kind: "schedule" | "webhook"; workflow: string; every?: string; timezone?: string }
  const lines = (): Line[] =>
    fb.plugins.flatMap((p): Line[] => {
      const line = (p.schedule ?? p.hook) as { workflow: string; every?: string; timezone?: string } | undefined
      return line ? [{ name: p.name, kind: p.schedule ? "schedule" : "webhook", workflow: line.workflow, every: line.every, timezone: line.timezone }] : []
    })
  const schedulesPart = () => (fb.has("schedules") ? fb.use<{ nextDue: () => string | null; tick: () => Promise<unknown> }>("schedules") : undefined)

  const wfOf = (id: string): Wf & { from: string; into: string } => {
    // Never run a file other than the one on disk: if it was edited a moment ago, Flowbound is about to restart with it.
    const onDisk = !fb.live && manifest.workflows[id] && fs.existsSync(path.join(fb.root, "workflows", `${id}.ts`)) ? sha(fs.readFileSync(path.join(fb.root, "workflows", `${id}.ts`), "utf8")) : undefined
    if (onDisk && onDisk !== manifest.workflows[id]?.hash) throw new Refused(`workflows/${id}.ts was just changed and Flowbound is starting again with it. Run the command again in a moment.`, { code: "restarting" })
    const wf = manifest.workflows[id]
    if (!wf) throw new Refused(`There is no workflow called "${id}". Workflows: ${Object.keys(manifest.workflows).join(", ") || "none yet (add a file to workflows/)"}`)
    if (wf.problem) throw new Refused(`workflows/${id}.ts is not ready: ${wf.problem}.`)
    return wf as Wf & { from: string; into: string }
  }

  const halt = (run: Run, state: Run["state"], code: string, reason: string) =>
    q(`update ${S}.runs set state = $2, code = $3, reason = $4, finished_at = now() where id = $1 and state = 'running'`, [run.id, state, code, reason])

  /** A provider card's name as people read it ("BlitzAPI"). */
  const labelOf = (name: string) => (fb.plugins.find((p) => p.name === name)?.card as { label?: string } | undefined)?.label ?? name
  /** The providers a workflow reaches, as people name them: "BlitzAPI", "BlitzAPI and FakeData". */
  const paidFrom = (workflow: string) => {
    const names = (manifest.workflows[workflow]?.uses ?? []).filter((u) => fb.plugins.some((p) => p.name === u && p.card)).map(labelOf)
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "")
  }
  /** How a run began, in one word: what started it, or that someone asked. */
  const howOf = (run: Run) => (run.kind === "schedule" || run.kind === "webhook" ? run.kind : run.kind === "tryout" ? "try-out" : "asked")

  /** How a run looks to people and agents: the rows, the money, who said yes. */
  async function view(run: Run) {
    const counts = (
      await q(
        `select count(*) filter (where state = 'done')::int as done, count(*) filter (where state = 'failed')::int as failed, count(*) filter (where state in ('done', 'failed'))::int as tried from ${S}.rows where run = $1`,
        [run.id],
      )
    )[0]
    const paid = await ledger().filled({ run: run.id })
    const cap = await ledger().spent(`run:${run.id}`)
    const yes = run.yes ? await ledger().yesOf(run.yes) : undefined
    const cols = (await q("select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [run.into_table]))
      .map((r) => r.c as string)
      .filter((c) => c !== "id" && !c.endsWith("__fact"))
    const fill = cols.length
      ? (await q(`select ${cols.map((c, i) => `count(r."${c}")::int as f${i}`).join(", ")} from "${run.into_table}" r join ${S}.rows x on x.row = r.id and x.run = $1 and x.state = 'done'`, [run.id]))[0]
      : {}
    const fields = counts.tried ? cols.map((name, i) => ({ name, filled: fill[`f${i}`] as number, of: counts.tried as number })) : []
    const found =
      cols.length && counts.done
        ? (await q(`select count(*)::int as n from "${run.into_table}" r join ${S}.rows x on x.row = r.id and x.run = $1 and x.state = 'done' where ${cols.map((c) => `r."${c}" is not null`).join(" or ")}`, [run.id]))[0]
            .n
        : 0
    const where = yes ? (yes.place === "page" ? "on the page" : yes.place === "chat" ? "in chat" : `by ${yes.place}`) : ""
    const waitsForYes = run.state === "waiting" || (run.state === "paused" && run.code === "cap")
    const yesBy = yes
      ? `${yes.checked ? yes.who : `"${yes.who}" (team password, name not checked)`}, ${where}`
      : waitsForYes
        ? "waiting for a yes"
        : run.mode === "skip"
          ? "not asked (skip asking)"
          : run.mode === "auto"
            ? "not needed (auto inside caps)"
            : "not needed (no paid call)"
    // Writes count by number, not dollars: a run that only writes says how many.
    const spentText = paid.writes && !paid.usd ? `${paid.writes} ${paid.writes === 1 ? "write" : "writes"}` : paid.unpriced && !paid.usd ? `${paid.calls} calls` : usd(paid.usd)
    const capText = cap ? (cap.maxUsd !== null ? usd(cap.maxUsd) : cap.maxCalls !== null ? `${cap.maxCalls} calls` : "") : ""
    const out = {
      run: run.id,
      workflow: run.workflow,
      name: `${run.title}, ${run.kind === "tryout" ? "try-out" : run.kind === "run" ? day(run.started_at).replace(/ \d{4}$/, "") : run.kind}`,
      title: run.title,
      /** The folder its workflow sits in under workflows/ ("tam-mapping"), "" for none. */
      folder: manifest.workflows[run.workflow]?.folder ?? (run.workflow.includes("/") ? run.workflow.slice(0, run.workflow.lastIndexOf("/")) : ""),
      kind: run.kind,
      state: run.state,
      /** Why it ended short, in one word: "person" (stopped or Not now), "cap", "failures", "no-key", "changed". */
      code: run.code ?? undefined,
      startedBy: run.started_by ?? undefined,
      /** What began it: its schedule, its webhook, or someone who asked (a try-out is always asked). */
      how: howOf(run),
      /** When it was asked for or began: a run that waits for a yes has not begun, but it was asked at this moment. */
      at: new Date(run.started_at).toISOString(),
      // When it began and how long it took (so far, while it is going). A run that waits for a yes has not begun.
      ...(run.state === "waiting" ? {} : { started: new Date(run.started_at).toISOString(), ended: run.finished_at ? new Date(run.finished_at).toISOString() : undefined, took: took(run.started_at, run.finished_at) }),
      why: run.reason?.replaceAll("{n}", String(counts.done)).replaceAll("{left}", String(run.total - counts.tried)) ?? undefined,
      askedBy: run.asked_by ?? undefined,
      rows: { done: counts.done as number, failed: counts.failed as number, of: run.total, found: found as number },
      spent: { usd: paid.usd, calls: paid.calls, writes: paid.writes, text: capText && !(paid.writes && !paid.usd) ? `${spentText} of ${capText}` : spentText },
      /** The cap that paused it, in its own unit, when it waits for a yes after one. */
      capHit: run.state === "paused" && run.code === "cap" ? ledger().capName(run.cap_kind ?? `run:${run.id}`, await ledger().spent(run.cap_kind ?? `run:${run.id}`)) : undefined,
      mode: run.mode,
      /** The yes this run waits for, in words, when it waits for one. */
      asks: waitsForYes ? await asks(run, counts.tried as number) : undefined,
      /** Where the run's cap came from: the permissions, a budget said in chat, or the person's yes. */
      capFrom:
        !cap || (cap.maxUsd === null && cap.maxCalls === null) ? undefined : yes ? "your yes" : run.mode !== "skip" && cap.maxUsd === ledger().runCaps(run.workflow).maxUsd ? "your permissions" : "a budget said in chat",
      // Who was paid and how: one line per provider, and per way where a provider has more than one (a model step).
      paidTo: (await ledger().paidTo({ run: run.id })).map((x) => ({
        ...x,
        text: `${x.how ? `${x.from}, through ${x.how}` : x.from}: ${x.calls} call${x.calls === 1 ? "" : "s"}, ${usd(x.usd)}${x.fromMemory ? `, and ${x.fromMemory} from memory` : ""}`,
      })),
      cap: cap && (cap.maxUsd !== null || cap.maxCalls !== null) ? { usd: cap.maxUsd, calls: cap.maxCalls } : undefined,
      yesBy,
      into: run.into_table,
      fields,
      /** "Open in workflow UI" for this run, where it works. */
      open: uiWay() ? `${uiWay()}?run=${run.id}` : null,
      page: `${fb.url}/runs?run=${run.id}`,
    }
    if (run.kind !== "tryout") return out
    // The estimate for all rows is the try-out's spend per row times every row in the list, so it errs high.
    const all = (await db().count(run.list, run.into_table)).all
    const per = counts.tried ? 1 / counts.tried : 0
    // Answers that came from memory this time are counted at what they cost when bought: the other rows will pay.
    const estimateUsd = Math.max(paid.usd, paid.worth) * per * all
    const estimateCalls = Math.ceil(paid.unpriced * per * all)
    const estimateWrites = Math.ceil(paid.writes * per * all)
    return {
      ...out,
      tryout: {
        tried: counts.tried as number,
        all,
        left: all - (await db().count(run.list, run.into_table)).done,
        estimateUsd,
        suggestedUsd: Math.max(0.01, Math.ceil(estimateUsd * 2 * 100) / 100),
        ...(estimateCalls ? { estimateCalls, suggestedCalls: estimateCalls * 2 } : {}),
        ...(estimateWrites ? { estimateWrites } : {}),
        filledNothing: run.state === "done" && counts.tried > 0 && fields.every((f) => !f.filled),
      },
    }
  }
  type View = Awaited<ReturnType<typeof view>>

  const scheduled = (workflow: string) => lines().some((l) => l.kind === "schedule" && l.workflow === workflow)
  /** The yes a run waits for, as the question the person answers. */
  type Asks = {
    kind: "start" | "more"
    question: string
    /** The same question without the workflow's name, for the run's own page where the name is the title. */
    short: string
    why: string
    cap?: string
    suggestUsd: number | null
    /** What the newest try-out of the same file did, so the person can judge the yes. */
    tried?: { rows: number; found: number; usd: number; into: string }
  }
  async function asks(run: Run, tried: number): Promise<Asks> {
    const cap = await ledger().spent(`run:${run.id}`)
    if (run.state === "waiting") {
      // What it should cost, from the newest try-out of the same file: so the person can judge the yes.
      const last =
        run.kind === "tryout"
          ? undefined
          : (await q<Run>(`select * from ${S}.runs where workflow = $1 and kind = 'tryout' and file_hash = $2 and state = 'done' order by id desc limit 1`, [run.workflow, run.file_hash]))[0]
      const v: any = last ? await view(last) : undefined
      const t: any = v?.tryout
      const about: number | undefined = t && t.tried ? Math.max(t.estimateUsd / Math.max(1, t.all), 0) * run.total : undefined
      const from = paidFrom(run.workflow)
      const rest = `on ${run.total} ${run.total === 1 ? "row" : "rows"}${run.kind === "tryout" ? " first" : ""}${about ? `, about ${usd(about)}${from ? ` from ${from}` : ""}` : ""}${cap?.maxUsd != null ? `, stop at ${usd(cap.maxUsd)}` : ""}?`
      return {
        kind: "start" as const,
        question: `${run.kind === "tryout" ? "Try" : "Run"} "${run.title}" ${rest}`,
        short: `${run.kind === "tryout" ? "Try" : "Run"} ${rest}`,
        tried: v && t.tried ? { rows: t.tried as number, found: v.rows.found as number, usd: v.spent.usd as number, into: run.into_table } : undefined,
        why: `${run.kind === "schedule" || run.kind === "webhook" ? `Its ${run.kind} started it, and the mode is ask every time.` : "The mode is ask every time."}${scheduled(run.workflow) ? " Its schedule skips its next run until this is answered." : ""}`,
        suggestUsd: cap?.maxUsd ?? null,
      }
    }
    const hit = run.cap_kind ?? `run:${run.id}`
    const b = await ledger().spent(hit)
    const left = run.total - tried
    const more = b?.maxUsd != null ? Math.max(0.01, Math.ceil(b.maxUsd * 2 * 100) / 100) : null
    return {
      kind: "more" as const,
      question: `Go on with "${run.title}" past ${ledger().capName(hit, b)}, for the ${left} ${left === 1 ? "row" : "rows"} left${hit === `run:${run.id}` && more ? `, up to ${usd(more)}` : ""}?`,
      short: `Go on past ${ledger().capName(hit, b)}, for the ${left} ${left === 1 ? "row" : "rows"} left${hit === `run:${run.id}` && more ? `, up to ${usd(more)}` : ""}?`,
      why: `It paused at ${ledger().capName(hit, b)}.${scheduled(run.workflow) ? " Its schedule skips its next run until this is answered." : ""}`,
      cap: hit,
      suggestUsd: hit === `run:${run.id}` ? more : (cap?.maxUsd ?? null),
    }
  }

  const hint = (v: View) => {
    const t = (v as any).tryout
    if (v.asks)
      return `It waits for the person's yes: ${v.asks.question} Pass their answer on: npx flowbound yes ${v.run}${v.asks.suggestUsd ? ` --max-usd ${v.asks.suggestUsd.toFixed(2)}` : ""} (or: npx flowbound no ${v.run}). It also shows on Home: ${v.page.replace(/\/runs\?run=\d+$/, "/needs")}`
    if (v.state === "done" && t) {
      if (t.filledNothing) return `It filled no field, so a full run is blocked. Try another provider or call first. To run it as it is, add --anyway.`
      return t.left
        ? `To run all ${t.left} that are left: npx flowbound run ${v.workflow}${v.mode === "ask" ? " (it will ask the person first)" : ""}. A budget the person said in chat is --max-usd.`
        : "Every row has a result now."
    }
    if (v.state === "stopped" || v.state === "paused") return `When it is fixed, carry on with: npx flowbound resume ${v.run}`
    if (v.state === "running") return `See how it goes: npx flowbound runs ${v.run}`
    return ""
  }
  const print = (v: View) => {
    const t = (v as any).tryout
    const lines: [string, string][] = v.fields.map((f) => [f.name, `${f.filled} of ${f.of}`])
    if (t) {
      lines.push([`Spent on ${t.tried}`, v.spent.text])
      if (v.state === "done" && !t.filledNothing && t.left) lines.push([`All ${t.all}, about`, t.estimateCalls && !t.estimateUsd ? `${t.estimateCalls} calls` : usd(t.estimateUsd)])
    } else {
      lines.unshift(["Rows", `${v.rows.done} of ${v.rows.of}`], ["Failed", String(v.rows.failed)])
      lines.push(["Spent", v.spent.text], ["Yes", v.yesBy])
      if (v.took) lines.push([v.state === "running" ? "Going for" : "Took", v.took])
    }
    for (const x of v.paidTo) lines.push(["Paid to", x.text])
    const w = Math.max(...lines.map((l) => l[0].length)) + 3
    const state = v.state === "done" ? "" : v.state === "running" ? " (running)" : v.asks ? " (waits for a yes)" : ` (${v.state})`
    return [`${v.name}${state}`, ...lines.map(([a, b]) => `${a.padEnd(w)}${b}`), v.why, hint(v), `Page: ${v.page}`].filter(Boolean).join("\n")
  }

  /** The providers a workflow file reaches: the cards behind its use("..."), whose rules hold for it. */
  const cardsOf = (wf: Ready) => wf.uses.filter((u) => fb.plugins.some((p) => p.name === u && p.card))

  /**
   * Start a run under the permissions. Ask: a paid run waits for the person's yes. Auto: it runs inside the caps.
   * Skip: it runs with no caps. A budget said in chat is this run's cap in every mode; the strictest wins.
   */
  async function begin(o: { wf: Ready; kind: Run["kind"]; total: number; chatUsd?: number; chatCalls?: number; who?: Who; by?: string }) {
    const paid = cardsOf(o.wf).length > 0
    const mode = ledger().modeFor(o.wf.id, cardsOf(o.wf))
    const caps = mode === "skip" ? { maxUsd: null, maxCalls: null } : ledger().runCaps(o.wf.id)
    const maxUsd = min(caps.maxUsd, o.chatUsd)
    const maxCalls = min(caps.maxCalls, o.chatCalls)
    const waits = mode === "ask" && paid
    const pause = o.wf.pauseAfter
    let r: Run
    try {
      r = (
        await q<Run>(
          `insert into ${S}.runs (workflow, title, kind, state, file_hash, list, into_table, total, lanes, budgets, asked_by, started_by, mode, retries, pause_failed, pause_of)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning *`,
          [
            o.wf.id,
            o.wf.title,
            o.kind,
            waits ? "waiting" : "running",
            o.wf.hash,
            o.wf.from,
            o.wf.into,
            o.total,
            o.wf.concurrency,
            [`run:0`],
            waits ? (o.who?.name ?? o.by ?? null) : null,
            o.by ?? null,
            mode,
            o.wf.retries,
            pause ? pause.failed : null,
            pause ? pause.of : null,
          ],
        )
      )[0]!
    } catch (e: any) {
      // One run at a time for a workflow that runs by itself: the database says so, also across copies of Flowbound.
      if (o.by && (e?.code === "23505" || /runs_one_auto|duplicate key/.test(String(e?.message)))) return undefined
      throw e
    }
    await ledger().budget(`run:${r.id}`, { maxUsd, maxCalls })
    await q(`update ${S}.runs set budgets = $2 where id = $1`, [r.id, [`run:${r.id}`]])
    if (!waits) await startWf(manifest.ids.run, [r.id])
    return (await getRun(r.id))!
  }
  const min = (...v: (number | null | undefined)[]) => {
    const n = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    return n.length ? Math.min(...n) : null
  }
  const finished = async (id: number, waitMs: number) => {
    for (const until = Date.now() + waitMs; Date.now() < until; await sleep(150)) if ((await getRun(id))!.state !== "running") break
    // Rows in the air when it stopped are allowed to finish: give them a moment, so the numbers said are the final ones.
    for (const until = Date.now() + 5000; Date.now() < until; await sleep(100)) if (!(await q(`select 1 from ${S}.rows where run = $1 and state = 'running' limit 1`, [id])).length) break
    return view((await getRun(id))!)
  }

  /**
   * One run of a workflow at a time. A second one would take the same rows again: nothing is paid twice (the answers
   * are already known), but the work is done twice and two runs tell the same story.
   */
  const alone = async (workflow: string, but = 0) => {
    const g = (await q<Run>(`select * from ${S}.runs where workflow = $1 and state = 'running' and id <> $2 order by id desc limit 1`, [workflow, but]))[0]
    if (g)
      throw new Refused(
        `Run ${g.id} of ${workflow} is going now${g.started_by ? ` (started by ${g.started_by.replace(":", " ")})` : ""}. One run of a workflow at a time: wait for it (npx flowbound runs ${g.id}) or stop it (npx flowbound stop ${g.id}).`,
        { code: "going", run: g.id },
      )
  }

  /** The `run` tool: a try-out of the first rows, or the rows that are left, under the permissions. */
  async function run(i: { workflow: string; try?: number; rows?: number; maxUsd?: number; maxCalls?: number; anyway?: boolean; wait?: boolean }, who: Who) {
    const wf = wfOf(i.workflow)
    await db().results(wf.into, wf.from, wf.id, wf.title)
    const { all, done } = await db().count(wf.from, wf.into)
    if (all - done <= 0) throw new Refused(all ? `Every one of the ${all} rows in ${wf.from} already has a result in ${wf.into}. Nothing to run.` : `${wf.from} has no rows yet.`)
    await alone(wf.id)
    if (i.maxUsd !== undefined && !(i.maxUsd >= 0)) throw new Refused("--max-usd is a budget in dollars: a number of 0 or more.")
    if (i.try !== undefined) {
      const total = Math.min(Math.max(1, Math.floor(i.try) || TRY_MAX), TRY_MAX, all - done)
      const r = (await begin({ wf, kind: "tryout", total, chatUsd: i.maxUsd, chatCalls: i.maxCalls, who }))!
      return r.state === "waiting" || i.wait === false ? view(r) : finished(r.id, 10 * 60_000)
    }
    await triedOut(wf, i.anyway)
    // "Do the first 100": the next rows not done yet, down the list, and no more. The caps still hold as well.
    if (i.rows !== undefined && !(Number.isInteger(i.rows) && i.rows > 0)) throw new Refused("--rows is how many rows to do: a whole number above zero. Leave it out to do every row that is left.")
    const some = Math.min(all - done, i.rows ?? all - done)
    const r = (await begin({ wf, kind: "run", total: some, chatUsd: i.maxUsd, chatCalls: i.maxCalls, who }))!
    return i.wait && r.state === "running" ? finished(r.id, 24 * 3600_000) : view(r)
  }

  /** A finished try-out of the file as it is now: what a full run needs first. "Try 10 rows first, then the rest." */
  async function triedOut(wf: Ready, anyway?: boolean) {
    const tryout = (await q<Run>(`select * from ${S}.runs where workflow = $1 and kind = 'tryout' and file_hash = $2 and state = 'done' order by id desc limit 1`, [wf.id, wf.hash]))[0]
    if (!tryout) throw new Refused(`Try it first: npx flowbound run ${wf.id} --try 10. A full run needs a finished try-out of the file as it is now.`, { code: "try-first" })
    const t = (await view(tryout)) as any
    if (t.tryout.filledNothing && !anyway)
      throw new Refused(
        `The try-out of ${t.tryout.tried} rows filled no field, so the full run is blocked. The providers answered, but with nothing in the fields picked. To run it as it is, the person must say "run anyway": add --anyway.`,
        { code: "filled-nothing" },
      )
    return t
  }

  /** Runs that go by themselves, from a schedule or a webhook: under the same permissions as any other run. */
  const auto: Auto = {
    workflow: wfOf,
    async rowsLeft(wf) {
      await db().results(wf.into, wf.from, wf.id, wf.title)
      const { all, done } = await db().count(wf.from, wf.into)
      return all - done
    },
    async going(workflow) {
      const r = (await q<Run>(`select * from ${S}.runs where workflow = $1 and state = 'running' order by id desc limit 1`, [workflow]))[0]
      return r && { run: r.id, by: r.started_by }
    },
    async waitingYes(workflow) {
      return (await q<Run>(`select id from ${S}.runs where workflow = $1 and (state = 'waiting' or (state = 'paused' and code = 'cap')) order by id desc limit 1`, [workflow]))[0]?.id
    },
    async launch(o) {
      const r = await begin({ wf: o.wf, kind: o.kind, total: await auto.rowsLeft(o.wf), by: o.by })
      return r && { run: r.id, state: r.state }
    },
    async absorb(by, rows) {
      return (await q(`update ${S}.runs set total = total + $2 where id = (select max(id) from ${S}.runs where started_by = $1 and state = 'running') and state = 'running' returning id`, [by, rows]))[0]?.id
    },
    async last(by) {
      const r = (await q<Run>(`select * from ${S}.runs where started_by = $1 order by id desc limit 1`, [by]))[0]
      return r ? view(r) : undefined
    },
  }

  /** A failure as people read it: without the runner's own words and Flowbound's markers ("[failed]", "[stop:cap@...]"). */
  const plainWhy = (why: string) =>
    (/\[stop:[\w-]+(?:@[^\]]*)?\]\s*(.*)$/s.exec(why)?.[1] ?? why)
      .replace(/^(?:\w*Error: )?\[failed\]\s*/, "")
      .replace(/^\w*Error: /, "")
      .slice(0, 500)

  /**
   * Every "use step" function of the workflow files is timed: when it began and ended for which row of which run, and
   * why it failed. The runner keeps its steps in one list for the whole process (the Workflow SDK's own); each one of
   * the workflows/ folder is wrapped there once, and Flowbound's own driver steps are left as they are.
   */
  function timeSteps() {
    const all = (globalThis as any)[Symbol.for("@workflow/core//registeredSteps")] as Map<string, any> | undefined
    if (!all) return
    const TIMED = Symbol.for("flowbound.timed")
    for (const [id, fn] of all) {
      if (typeof fn !== "function" || fn[TIMED] || !id.startsWith("step//") || !/(^|\/)workflows\//.test(id) || id.includes(".flowbound/")) continue
      const name = id.slice(id.lastIndexOf("//") + 2)
      const timed = Object.assign(async function (this: unknown, ...args: unknown[]) {
        return time(name, () => fn.apply(this, args))
      }, fn)
      timed.stepId = fn.stepId
      timed[TIMED] = true
      all.set(id, timed)
    }
  }
  async function time<T>(fn: string, go: () => Promise<T>): Promise<T> {
    let key: string | undefined
    try {
      const wf = await import("workflow")
      key = wf.getStepMetadata().stepId
      // The row this batch is on, as the ledger was told: the same place its calls are written down under.
      const got = await q(
        `insert into ${S}.steps (key, run, row, fn) select $1, (scope->>'run')::bigint, (scope->>'row')::bigint, $2 from fb_ledger.scopes where key = $3 and scope->>'row' is not null
         on conflict (key) do update set ended_at = null, error = null returning key`,
        [key, fn, wf.getWorkflowMetadata().workflowRunId],
      )
      if (!got.length) key = undefined
    } catch {
      key = undefined
    }
    if (!key) return go()
    try {
      const out = await go()
      await q(`update ${S}.steps set ended_at = now() where key = $1`, [key]).catch(() => {})
      return out
    } catch (e: any) {
      await q(`update ${S}.steps set ended_at = now(), error = $2 where key = $1`, [key, plainWhy(String(e?.message ?? e))]).catch(() => {})
      throw e
    }
  }

  /** Give rows back that a batch took and will not do: the run stopped or paused before their turn. They stay not done. */
  const release = (runId: number, rows: number[]) =>
    q(`with gone as (delete from ${S}.rows where run = $1 and row = any($2::bigint[]) and state = 'running' returning row) update ${S}.runs set claimed = claimed - (select count(*) from gone)::int where id = $1`, [
      runId,
      rows,
    ])
  /** After a row: is the run still going? Then the ledger is told which row this batch's next calls are for. If not, the rest of the batch goes back. */
  const carryOn = async (r: Run, rest: number[], wfRun: string, going = r.state === "running") => {
    if (!going) {
      if (rest.length) await release(r.id, rest)
      return false
    }
    if (rest.length) await ledger().scope(wfRun, { run: r.id, row: rest[0], workflow: r.workflow, title: r.title, into: r.into_table, mode: r.mode, lifted: r.lifted ?? [], retries: r.retries })
    return rest.length > 0
  }

  const steps = {
    async begin(runId: number) {
      const r = await getRun(runId)
      if (!r || r.state !== "running") return null
      const lanes = Math.max(1, Math.min(r.lanes, 50))
      return { lanes, batch: Math.max(1, Number(process.env.FLOWBOUND_ROWS_PER_BATCH) || ROWS_PER_BATCH), each: Math.ceil(BATCHES_PER_DRIVER / lanes) }
    },
    /**
     * The next rows not done yet, for one lane. Empty when the run is over, capped, paused or stopped.
     * `batch` names this one claim of the driver. Asked a second time under the same name (Flowbound was killed after
     * the rows were taken and before the runner had written that down), it gives the same rows back, so none is left
     * taken with nobody doing it.
     */
    claim(runId: number, most: number, batch = ""): Promise<number[]> {
      const turn = (claims.get(runId) ?? Promise.resolve()).then(async () => {
        const r = await getRun(runId)
        if (!r || r.state !== "running") return []
        if (batch) {
          const mine = await q<{ row: number }>(`select row from ${S}.rows where run = $1 and batch = $2 and state = 'running' order by row`, [runId, batch])
          if (mine.length) return mine.map((x) => Number(x.row))
        }
        if (manifest.workflows[r.workflow]?.hash !== r.file_hash) {
          await halt(r, "stopped", "changed", `workflows/${r.workflow}.ts changed while this ran. A changed file needs a new try-out and a new yes.`)
          return []
        }
        for (;;) {
          // One statement, so two copies of a live Flowbound cannot take the same rows: it holds the run's own row while it
          // takes the next ones after `cursor`. Never more than the run has left, and a short list is shared out between the lanes.
          const got = await q<{ seen: number; row: number | null }>(
            `with r as (select cursor, total - claimed as open from ${S}.runs where id = $1 and state = 'running' for update),
               picked as (select l.id from "${r.list}" l, r where l.id > r.cursor and not exists (select 1 from "${r.into_table}" x where x.id = l.id)
                 order by l.id limit (select greatest(0, least($2::int, open, greatest(1, ceil(open::numeric / $3)::int))) from r)),
               taken as (insert into ${S}.rows (run, row, state, batch) select $1, id, 'running', $4 from picked on conflict do nothing returning row),
               moved as (update ${S}.runs set cursor = (select max(id) from picked), claimed = claimed + (select count(*) from taken)::int where id = $1 and exists (select 1 from picked))
             select (select count(*)::int from picked) as seen, t.row from (select 1) one left join taken t on true order by t.row`,
            [runId, most, Math.max(1, r.lanes), batch || null],
          )
          const rows = got.flatMap((x) => (x.row === null ? [] : [Number(x.row)]))
          // Rows this run tried before (it was paused and carried on) are passed over: look further down the list.
          if (rows.length || !got[0]?.seen) return rows
        }
      })
      claims.set(
        runId,
        turn.catch(() => {}),
      )
      return turn
    },
    /** A batch starts: read its rows, and tell the ledger which row the first calls are for. */
    async beginBatch(runId: number, rowIds: number[], wfRun: string) {
      const r = await getRun(runId)
      if (!r) return null
      const rows = r.state === "running" ? await q<Record<string, unknown>>(`select * from "${r.list}" where id = any($1::bigint[]) order by id`, [rowIds]) : []
      // The run stopped before this batch began, or a row left the list meanwhile: those go back.
      const gone = rowIds.filter((id) => !rows.some((x) => Number(x.id) === id))
      if (gone.length) await release(runId, gone)
      if (!rows.length) return null
      await q(`update ${S}.rows set wf_run = $3 where run = $1 and row = any($2::bigint[])`, [runId, rowIds, wfRun])
      await carryOn(r, [Number(rows[0]!.id)], wfRun)
      return { workflow: r.workflow, rows }
    },
    /** Save one row's answer. True when the batch should go on with its next row. */
    async saveRow(runId: number, rowId: number, out: unknown, rest: number[] = [], wfRun = "") {
      const r = (await getRun(runId))!
      const fields = out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : { value: out }
      await db().save(r.into_table, rowId, fields)
      await q(`update ${S}.rows set state = 'done', reason = null, at = now() where run = $1 and row = $2`, [runId, rowId])
      return carryOn(r, rest, wfRun)
    },
    /** A row failed, or the run must stop (the cap, a missing key). True when the batch should go on with its next row. */
    async failRow(runId: number, rowId: number, why: string, rest: number[] = [], wfRun = "") {
      const r = (await getRun(runId))!
      const stop = /\[stop:([\w-]+)(?:@([^\]]*))?\]\s*(.*)$/s.exec(why)
      const reason = (stop?.[3] ?? why).replace(/^(?:\w*Error: )?\[failed\]\s*/, "").slice(0, 500)
      if (stop) {
        // The cap, a missing key: the row is not at fault. It stays not done, with the rest of its batch, and the run stops before spending more.
        await release(runId, [rowId, ...rest])
        // Rows already in the air when a run stops are allowed to finish, so the count is filled in when it is read
        // ({n} rows done, {left} left), not frozen as it was in this instant.
        if (stop[1] === "cap") {
          // A hit cap pauses the run and puts a yes on Home: it waits there until the person answers.
          await q(`update ${S}.runs set state = 'paused', code = 'cap', cap_kind = $2, reason = $3, finished_at = now() where id = $1 and state = 'running'`, [
            r.id,
            stop[2] ?? `run:${r.id}`,
            `${reason.replace(/\.$/, "")} after {n} of ${r.total} rows, so it paused. Nothing more was spent. A yes carries it on.`,
          ])
          return false
        }
        const text = stop[1] === "no-key" ? `${reason} The run stopped before spending anything more: {n} of ${r.total} rows are done.` : reason
        await halt(r, "stopped", stop[1]!, text)
        return false
      }
      await q(`update ${S}.rows set state = 'failed', reason = $3, at = now() where run = $1 and row = $2`, [runId, rowId, reason])
      // The habit: when too many of the last rows failed, pause and say why. A row that failed in an earlier run
      // and fails again is not news: a new run starts with those, and would pause on them every time.
      const last = await q(
        `select x.state, x.reason from ${S}.rows x where x.run = $1 and x.state <> 'running'
           and not (x.state = 'failed' and exists (select 1 from ${S}.rows y join ${S}.runs o on o.id = y.run where y.row = x.row and y.run < x.run and y.state = 'failed' and o.into_table = $2))
         order by x.at desc limit $3`,
        [runId, r.into_table, r.pause_of ?? 20],
      )
      const failed = last.filter((x) => x.state === "failed")
      // The habit, as the workflow file has it (11 of the last 20 unless it says otherwise; false never pauses).
      if (r.pause_failed !== null && failed.length >= r.pause_failed) {
        const count = new Map<string, number>()
        for (const f of failed) count.set(f.reason, (count.get(f.reason) ?? 0) + 1)
        const [top] = [...count].sort((a, b) => b[1] - a[1])
        const n = (await q(`select count(*)::int as n from ${S}.rows where run = $1`, [runId]))[0].n
        await halt(r, "paused", "failures", `Paused at row ${n} of ${r.total}: ${failed.length} of the last ${last.length} rows failed. Most often: ${top![0]}`)
        return carryOn(r, rest, wfRun, false)
      }
      return carryOn(r, rest, wfRun)
    },
    /** A whole batch came to nothing (its own run broke): its rows that never finished are failed, with why. */
    async failBatch(runId: number, rowIds: number[], why: string) {
      await q(`update ${S}.rows set state = 'failed', reason = $3, at = now() where run = $1 and row = any($2::bigint[]) and state = 'running'`, [runId, rowIds, why.slice(0, 500)])
    },
    /** End the run, unless a row arrived in the last moment (by webhook, say): then true, and the driver carries on. */
    async finish(runId: number): Promise<boolean> {
      const r = await getRun(runId)
      if (!r || r.state !== "running") return false
      if (r.claimed < r.total && (await q(`select 1 from "${r.list}" l where l.id > $1 and not exists (select 1 from "${r.into_table}" x where x.id = l.id) limit 1`, [r.cursor])).length) return true
      // Only when no row was added while we looked: a run never ends with a row waiting for it.
      const ended = await q(`update ${S}.runs set state = 'done', finished_at = now() where id = $1 and state = 'running' and total = $2 returning id`, [runId, r.total])
      return !ended.length && (await getRun(runId))?.state === "running"
    },
    async nextDue(generation: string): Promise<string | null> {
      if ((await q(`select generation from ${S}.clock where id = 1`))[0]?.generation !== generation) return null
      return schedulesPart()?.nextDue() ?? null
    },
    async fire(generation: string) {
      if ((await q(`select generation from ${S}.clock where id = 1`))[0]?.generation !== generation) return
      await schedulesPart()
        ?.tick()
        .catch((e) => console.error(`The clock's tick failed: ${e?.message ?? e}`))
    },
  }

  /**
   * Make sure one clock is ticking for the schedule lines as they are written now. An older clock stops at its next tick.
   * On a host with a clock of its own (Vercel's schedules call /clock) there is none of ours: `hosted`.
   */
  async function clock(fresh: boolean, hosted = false) {
    const scheduled = lines().filter((l) => l.kind === "schedule")
    const base = hosted ? "host" : scheduled.length ? sha(JSON.stringify(scheduled)).slice(0, 16) : "none"
    const old: string | undefined = (await q(`select generation from ${S}.clock where id = 1`))[0]?.generation
    if (!fresh && old?.startsWith(`${base}:`)) return
    const generation = `${base}:${Date.now()}`
    await q(`insert into ${S}.clock (id, generation) values (1, $1) on conflict (id) do update set generation = $1`, [generation])
    if (scheduled.length && !hosted) await startWf(manifest.ids.clock, [generation])
  }

  type Listed = Awaited<ReturnType<typeof listed>>
  /** One workflow as listed for people and agents. */
  async function listed(w: Wf) {
    const c =
      w.problem || !w.from || !w.into
        ? undefined
        : await db()
            .count(w.from, w.into)
            .catch(() => undefined)
    const ready = w.problem ? undefined : (w as Ready)
    return {
      id: w.id,
      title: w.title,
      /** The folder it sits in under workflows/, "" for none. */
      folder: w.folder ?? "",
      from: w.from,
      into: w.into,
      rows: c ? `${c.done} of ${c.all} done` : undefined,
      runsBy:
        lines()
          .filter((l) => l.workflow === w.id)
          .map((l) =>
            l.kind === "schedule"
              ? `the schedule "${l.name}" (every ${l.every})`
              : `rows posted to ${fb.url}/hooks/${l.name}${fb.live ? "" : " (only from this computer: a sender elsewhere needs it live, or the page shared privately)"}`,
          )
          .join(", ") || "when asked",
      // The parts the file reaches with use("..."): which cards (and so which keys) it needs.
      uses: w.uses ?? [],
      mode: ready ? ledger().modeFor(w.id, cardsOf(ready)) : ledger().modeFor(w.id),
      summary: w.summary ?? null,
      hasDiagram: !!w.diagram,
      /** "use step" functions with no box in the diagram (no click line): the diagram may be behind the code. */
      notDrawn: w.diagram ? (w.steps ?? []).filter((fn) => !(w.clicks ?? []).some((c) => c.fn === fn)) : [],
      diagramProblem: w.diagramProblem,
      problem: w.problem,
    }
  }

  /** The column of a list that names its rows for people: a name, a company, a domain; else its first column. */
  const NAMES = ["name", "company", "company_name", "full_name", "domain", "website", "email", "title", "url", "linkedin_url"]
  async function nameColumn(list: string): Promise<string | undefined> {
    const cols = (await q("select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [list])).map((r) => r.c as string)
    return NAMES.find((n) => cols.includes(n)) ?? cols.find((c) => c !== "id" && !c.endsWith("__fact"))
  }
  /** What one row cost, as the rows list says it: "$0.004", "free" (all of it already known), "$0" (nothing bought). */
  const costText = (calls: { usd: number; fromMemory: boolean }[]) => {
    const paid = calls.reduce((n, c) => n + c.usd, 0)
    return paid ? usd(paid) : calls.length && calls.every((c) => c.fromMemory) ? "free" : "$0"
  }
  const ROWS_PAGE = 50
  /** A run's rows, 50 at a time in list order: each with its name, how it went and what it cost. */
  async function rowsOf(r: Run, page: number) {
    const col = await nameColumn(r.list).catch(() => undefined)
    const total = (await q(`select count(*)::int as n from ${S}.rows where run = $1`, [r.id]))[0].n as number
    const got = await q<{ row: string; state: string; reason: string | null; label: unknown }>(
      `select x.row, x.state, x.reason, ${col ? `l."${col}"` : "null"} as label from ${S}.rows x left join "${r.list}" l on l.id = x.row where x.run = $1 order by x.row limit $2 offset $3`,
      [r.id, ROWS_PAGE, (page - 1) * ROWS_PAGE],
    )
    const calls = await ledger().rowCalls(
      r.id,
      got.map((x) => Number(x.row)),
    )
    return {
      page,
      of: Math.max(1, Math.ceil(total / ROWS_PAGE)),
      total,
      list: got.map((x) => {
        const row = Number(x.row)
        return {
          row,
          name: x.label === null || x.label === undefined || x.label === "" ? `Row ${row}` : String(x.label),
          state: x.state as "running" | "done" | "failed",
          reason: x.reason ?? undefined,
          cost: costText(calls.filter((c) => c.row === row)),
        }
      }),
    }
  }

  /** The box of the diagram that stands for a step: its words ("Find the head of sales"), or undefined when none does. */
  const boxOf = (wf: Wf | undefined, fn: string) => {
    const node = wf?.clicks?.find((c) => c.fn === fn)?.node
    if (!node || !wf?.diagram) return undefined
    // b[Words], b(Words), b{Words}, b([Words]), b["Words"], b[/Words/]: the words inside the box's brackets.
    const m = new RegExp(`(?:^|[^\\w-])${node.replace(/-/g, "\\-")}\\s*[[({>]+\\s*"?([^"\\])}]*?)"?\\s*[\\])}]`, "m").exec(wf.diagram)
    return (
      m?.[1]
        ?.replace(/<br\s*\/?>/gi, " ")
        .replace(/^[/\\]+|[/\\]+$/g, "")
        .trim() || undefined
    )
  }
  /** The providers one step function reaches with use("..."), read from its own lines in the file. */
  const callsOf = (wf: Wf | undefined, fn: string) => {
    const text = wf?.text ?? ""
    const at = text.search(new RegExp(`function\\s+${fn}\\s*\\(`))
    if (at < 0) return []
    const end = text.slice(at + 1).search(/\n(?:export\s|async\s+function\s|function\s)/)
    const body = end < 0 ? text.slice(at) : text.slice(at, at + 1 + end)
    return [...new Set([...body.matchAll(/\buse(?:<[^>]*>)?\(\s*["'`]([\w.-]+)["'`]\s*\)/g)].map((m) => m[1]!))].filter((u) => fb.plugins.some((p) => p.name === u && p.card)).map(labelOf)
  }
  /** "12 days old", "1 day old", "bought today": how old an answer from memory is. */
  const ageOf = (at: string | null) => {
    if (!at) return null
    const d = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000)
    return d <= 0 ? "bought today" : `${d} ${d === 1 ? "day" : "days"} old`
  }
  /** One row's steps on a time axis: each with its name, when it began and how long it took, who was paid and what, or why it failed. */
  async function stepsOfRow(r: Run, row: number) {
    const wf = manifest.workflows[r.workflow]
    const x = (await q(`select state, reason from ${S}.rows where run = $1 and row = $2`, [r.id, row]))[0]
    if (!x) throw new Refused(`Row ${row} is not in run ${r.id}.`)
    const steps = await q<{ key: string; fn: string; started_at: string; ended_at: string | null; error: string | null }>(
      `select key, fn, started_at, ended_at, error from ${S}.steps where run = $1 and row = $2 order by started_at, key`,
      [r.id, row],
    )
    const calls = await ledger().rowCalls(r.id, [row])
    const now = Date.now()
    const t = (at: string | null) => (at ? new Date(at).getTime() : now)
    const from = steps.length ? t(steps[0]!.started_at) : now
    const to = steps.length ? Math.max(...steps.map((s) => t(s.ended_at))) : now
    const list = steps.map((s) => {
      const mine = calls.filter((c) => c.step === s.key)
      const paid = mine.filter((c) => !c.fromMemory)
      const by = [...new Set(paid.map((c) => c.from))]
      const state = s.error ? "failed" : s.ended_at ? "done" : x.state === "running" ? "running" : "failed"
      const where = callsOf(wf, s.fn)
      const text =
        state === "failed"
          ? s.error || x.reason || "It did not finish."
          : state === "running"
            ? where.length
              ? `waiting for ${where.join(" and ")}…`
              : "running…"
            : paid.length
              ? by.map((b) => `${b} · ${usd(paid.filter((c) => c.from === b).reduce((n, c) => n + c.usd, 0))}`).join(" · ")
              : mine.length
                ? [
                    "already known",
                    ageOf(
                      mine
                        .map((c) => c.boughtAt)
                        .filter((a): a is string => !!a)
                        .sort()[0] ?? null,
                    ),
                    "free",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "no provider call · free"
      return { fn: s.fn, name: boxOf(wf, s.fn) ?? s.fn, state, text, at: t(s.started_at) - from, ms: t(s.ended_at) - t(s.started_at) }
    })
    return { run: r.id, row, state: x.state as string, reason: x.reason ?? undefined, ms: to - from, steps: list }
  }

  /** "Open in workflow UI": where it leads, or null where it does not work (a server of your own, for who may not manage). */
  const uiWay = () => (placeOf(fb.live) === "server" ? null : `${fb.url}/open/workflow-ui`)
  /** The Workflow SDK's own UI, inside this Flowbound. It has no door of its own: Flowbound's is in front of it. */
  const served = async (req: Request, url: URL, who: Who): Promise<Response> => {
    if (placeOf(fb.live) === "vercel") return new Response("On Vercel the workflow UI is Vercel's own page.", { status: 404 })
    if (fb.live && !can(who, "admin")) return new Response("The workflow UI is for Admins and Owners of this Flowbound.", { status: 403 })
    ui ??= workflowUi(fb.root, `${fb.base}/workflow-ui`, [new URL(fb.url).hostname])
    let handler: Awaited<typeof ui>
    try {
      handler = await ui
    } catch (e: any) {
      ui = undefined
      return new Response(String(e?.message ?? e), { status: 501 })
    }
    // Flowbound may be shared under a path a proxy cut off: the UI is told its whole address either way.
    const to = new URL(url)
    to.pathname = fb.base + url.pathname
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
    return handler(new Request(to, { method: req.method, headers: req.headers, body }))
  }

  return plugin({
    name: "workflow-sdk",
    provides: "runs",
    needs: ["records", "ledger"],
    on: opts.on,
    migrations: [
      `create table ${S}.runs (id bigserial primary key, workflow text not null, title text not null, kind text not null, state text not null, code text, reason text,
         file_hash text not null, list text not null, into_table text not null, total int not null default 0, lanes int not null default 5, budgets text[] not null default '{}',
         yes bigint, asked_by text, started_at timestamptz not null default now(), finished_at timestamptz);
       create table ${S}.rows (run bigint not null, row bigint not null, state text not null, reason text, wf_run text, at timestamptz not null default now(), primary key (run, row));
       create table ${S}.clock (id int primary key, generation text not null);
       create table ${S}.fired (workflow text primary key, at timestamptz not null)`,
      // Runs that start by themselves: the standing yes they run inside, what started them, which cap stopped them. One at a time per workflow.
      `alter table ${S}.runs add column standing bigint, add column started_by text, add column cap_kind text;
       create unique index runs_one_standing on ${S}.runs (workflow) where state = 'running' and standing is not null;
       drop table ${S}.fired`,
      // Rows are taken a batch at a time, after a place in the list the run remembers, so a claim costs the same at row 10 and at row 1,000,000.
      `alter table ${S}.runs add column cursor bigint not null default 0, add column claimed int not null default 0;
       update ${S}.runs r set claimed = (select count(*) from ${S}.rows x where x.run = r.id);
       alter table ${S}.rows add column batch text;
       create index rows_recent on ${S}.rows (run, at desc);
       create index rows_row on ${S}.rows (row, run)`,
      // Permission modes: the mode a run began in, caps a yes lifted for it, and its habits from the workflow file.
      // What runs by itself is one at a time per workflow, kept by the database.
      `alter table ${S}.runs add column mode text not null default 'auto', add column lifted text[] not null default '{}',
         add column retries int not null default 2, add column pause_failed int default 11, add column pause_of int default 20;
       drop index if exists ${S}.runs_one_standing;
       create unique index runs_one_auto on ${S}.runs (workflow) where state = 'running' and started_by is not null`,
      // Each step a row went through: which function, when it began and ended, and why it failed. A row's timeline on its run's page.
      `create table ${S}.steps (key text primary key, run bigint not null, row bigint not null, fn text not null,
         started_at timestamptz not null default now(), ended_at timestamptz, error text);
       create index steps_row on ${S}.steps (run, row, started_at)`,
    ],
    async start(f) {
      fb = f
      const baked = (globalThis as any)[Symbol.for("flowbound")].built as { manifest: Manifest } | undefined
      if (baked) {
        manifest = baked.manifest
        // Live on Vercel the host's own schedules are the clock (they call /clock): none of ours sleeps there.
        await clock(false, true)
      } else {
        const home = opts.on === "postgres" && process.env.DATABASE_URL ? "postgres" : "local"
        process.env.WORKFLOW_TARGET_WORLD ??= home === "postgres" ? "@workflow/world-postgres" : "local"
        process.env.WORKFLOW_LOCAL_DATA_DIR ??= path.join(fb.root, ".flowbound", "workflow")
        // On your own computer the runner calls this process directly, also when the pages are shared at another address.
        process.env.WORKFLOW_LOCAL_BASE_URL ??= fb.live ? fb.url : fb.local
        const { buildLocal } = await import("./workflow-sdk/build.ts")
        ;({ manifest, flow, webhook } = await buildLocal(fb.root))
        for (const w of Object.values(manifest.workflows)) if (w.problem) console.log(`workflows/${w.id}.ts is not ready: ${w.problem}`)
        // Runs that were going when Flowbound stopped carry on by themselves from here.
        setTimeout(async () => {
          try {
            const going = await q<Run>(`select * from ${S}.runs where state = 'running'`)
            const world = await (await import("workflow/runtime")).getWorld()
            // On a server of your own the runner hands its work over inside this process, so its address can stay shut.
            if (fb.live) world.registerHandler?.("__wkf_workflow_" as any, (req: Request) => flow!.POST(req))
            await world.start?.()
            for (const r of going) console.log(`Picked up run ${r.id} (${r.title}) where it stopped.`)
            await clock(true)
          } catch (e) {
            console.error(e)
          }
        }, 50)
      }
      timeSteps()
      return { steps, workflows: () => manifest.workflows, clock, auto }
    },
    routes: {
      // One address for "Open in workflow UI", right for where this runs: the Workflow SDK's own UI here, Vercel's page there.
      "GET /open/workflow-ui": (async (req, at) => {
        const n = Number(at.url.searchParams.get("run")) || undefined
        const run = n ? ((await q("select wf_run from fb_workflow_sdk.rows where run = $1 and wf_run is not null order by at desc limit 1", [n]))[0]?.wf_run as string | undefined) : undefined
        const to =
          placeOf(fb.live) === "vercel"
            ? vercelPage({
                names: opts.vercel?.includes("/") ? { team: opts.vercel.split("/")[0]!, project: opts.vercel.split("/")[1]! } : vercelNames(req.headers.get("x-vercel-oidc-token") ?? process.env.VERCEL_OIDC_TOKEN),
                run,
                env: process.env.VERCEL_ENV,
              })
            : `${fb.base}/workflow-ui${run ? `/run/${encodeURIComponent(run)}` : ""}`
        return new Response(null, { status: 302, headers: { location: to } })
      }) satisfies Route,
      "ANY /workflow-ui": ((req, at) => served(req, at.url, at.who)) satisfies Route,
      "ANY /workflow-ui/:rest*": ((req, at) => served(req, at.url, at.who)) satisfies Route,
      // The runner's own address. On your computer the runner signs its deliveries; live, nothing from outside gets here.
      "ANY /.well-known/workflow/v1/flow": Object.assign((req: Request) => (flow && !fb.live ? flow.POST(req) : new Response("Nothing is here.", { status: 404 })), { open: "all" as const }),
      "ANY /.well-known/workflow/v1/webhook/:token": Object.assign((req: Request) => (webhook?.[req.method] ? webhook[req.method]!(req) : new Response("no", { status: 404 })), { open: "all" as const }),
    },
    tools: {
      workflows: {
        about:
          "List the workflow files: each one's list, results table, what starts it (a schedule or webhook line in flowbound.config.ts, or only when asked), the permission mode it runs in, anything wrong with the file, and whether it has the summary and diagram you write for people. With check: fails when a file is not ready.",
        role: "viewer",
        input: { check: { type: "boolean", about: "fail when a workflow is not ready" } },
        run: async (i) => {
          const all = await Promise.all(Object.values(manifest.workflows).map(listed))
          const wrong = all.flatMap((w) => [...(w.problem ? [`workflows/${w.id}.ts is not ready: ${w.problem}`] : []), ...(w.diagramProblem ? [`workflows/${w.id}.ts: ${w.diagramProblem}`] : [])])
          if (i.check && wrong.length) throw new Refused(wrong.join("\n"), { code: "check" })
          return all
        },
        print: (r: Listed[]) =>
          r.length
            ? r
                .map(
                  (w) =>
                    `${w.id}   ${w.from ?? "?"} -> ${w.into ?? "?"}   ${w.rows ?? ""}   ${w.runsBy}   mode: ${w.mode}${w.problem ? `\n  not ready: ${w.problem}` : ""}${w.summary ? "" : "\n  no summary yet: write export const summary for people"}${w.hasDiagram || w.problem ? "" : "\n  no diagram yet: write export const diagram, a Mermaid flowchart"}${w.notDrawn.length ? `\n  the diagram has no box for: ${w.notDrawn.join(", ")} (add a click line for each)` : ""}${w.diagramProblem ? `\n  ${w.diagramProblem}` : ""}`,
                )
                .join("\n")
            : "No workflows yet. Write one in workflows/<id>.ts",
      },
      workflow: {
        about: "One workflow as people see it on the Workflows page: the summary and diagram you wrote for them, its code, and its last run.",
        role: "viewer",
        input: { id: { about: "the workflow's id", required: true }, includeCode: { type: "boolean", about: "include the source code (default true)" } },
        run: async (i) => {
          const w = manifest.workflows[String(i.id)]
          if (!w) throw new Refused(`There is no workflow called "${i.id}". Workflows: ${Object.keys(manifest.workflows).join(", ") || "none yet"}`)
          const last =
            (await q<Run>(`select * from ${S}.runs where workflow = $1 and kind <> 'tryout' order by id desc limit 1`, [w.id]))[0] ??
            (await q<Run>(`select * from ${S}.runs where workflow = $1 order by id desc limit 1`, [w.id]))[0]
          const v = last ? await view(last) : undefined
          // What starts it: its schedule and webhook lines, with the next time and the webhook's address.
          const starts = fb.has("schedules") ? ((await fb.call("schedules", {}, { kind: "system", name: "Flowbound", via: "page" })) as any[]).filter((s) => s.workflow === w.id) : []
          return {
            ...(await listed(w)),
            file: `workflows/${w.id}.ts`,
            /** The Mermaid flowchart the agent wrote, without its click lines; the boxes tied to steps are in `clicks`. */
            diagram: w.diagram ?? null,
            clicks: w.clicks ?? [],
            steps: w.steps ?? [],
            starts: starts.map((s) => ({
              name: s.name,
              kind: s.kind,
              text: s.starts,
              ...(s.nextDue ? { next: s.nextDue } : {}),
              ...(s.webhook ? { address: s.webhook.address, secretSaved: s.webhook.secretSaved, lastDelivery: s.recent?.[0]?.at ?? null } : {}),
            })),
            // The ways further in: the file in an editor (only on your own computer) and the workflow UI (only where it works).
            open: { editor: fb.live ? null : (editorHere(opts.editor)?.name ?? null), ui: uiWay() },
            ...(i.includeCode === false ? {} : { code: w.text ?? "" }),
            page: `${fb.url}/workflows?workflow=${w.id}`,
            lastRun: v
              ? {
                  run: v.run,
                  text: v.asks ? `waits for a yes: ${v.asks.question}` : v.spent.writes ? `${v.rows.done} rows · ${v.spent.writes} written` : `${v.rows.done} rows · ${v.rows.found} found · ${usd(v.spent.usd)}`,
                  state: v.state,
                }
              : null,
            // While a yes waits, its schedule skips: the page says so where the schedule is.
            waitingYes: (await auto.waitingYes(w.id)) ?? null,
          }
        },
        print: (r: any) =>
          [
            r.title,
            r.summary ?? "No summary yet: ask your agent to write one.",
            r.diagram ? "(a diagram, shown on the page)" : "",
            r.notDrawn?.length ? `The diagram has no box for: ${r.notDrawn.join(", ")}` : "",
            r.lastRun ? `Last run: ${r.lastRun.text}` : "",
            `Page: ${r.page}`,
          ]
            .filter(Boolean)
            .join("\n"),
      },
      "open-file": {
        about: "Open a workflow's file in the person's editor, on the computer Flowbound runs on. Only on your own computer: live there is no file to open, and the code is read on the workflow's page.",
        by: "people",
        input: { id: { about: "the workflow's id", required: true }, line: { type: "number", about: "the line to land on" } },
        run: async (i) => {
          if (fb.live) throw new Refused("A file opens in an editor on your own computer. Here the code is read on the workflow's page.")
          const wf = manifest.workflows[String(i.id)]
          if (!wf) throw new Refused(`There is no workflow called "${i.id}".`)
          const file = path.join(fb.root, "workflows", `${wf.id}.ts`)
          const editor = editorHere(opts.editor)
          if (!editor) throw new Refused(`No editor was found on this computer. The file is ${file}. Name your editor's command in FLOWBOUND_EDITOR.`, { code: "no-editor", file })
          await openInEditor(editor, file, Number(i.line) || 1).catch((e) => {
            throw new Refused(`${e.message}. The file is ${file}`, { code: "no-editor", file })
          })
          return { opened: file, line: Number(i.line) || 1, with: path.basename(editor.name) }
        },
        print: (r) => `Opened ${r.opened} in ${r.with}`,
      },
      run: {
        about:
          "Run a workflow over its list, under the person's permissions. With try: the first rows not done yet (at most 10). Without: the rows that are left, after a finished try-out. Ask mode: a paid run waits for the person's yes (pass it on with the yes tool). Auto: it runs inside the caps, and pauses with a yes on Home when one is reached. Skip: no caps. A budget the person said in chat (\"don't spend more than $5\") is maxUsd: that run's cap in every mode.",
        input: {
          workflow: { about: "the workflow's id: its file name without .ts", required: true },
          try: { type: "number", about: "try-out on this many rows (at most 10)" },
          maxUsd: { type: "number", about: "a budget the person said in chat, in USD: this run's cap" },
          maxCalls: { type: "number", about: "a cap in calls, for providers with no price on their card" },
          anyway: { type: "boolean", about: 'the person said "run anyway" after a try-out that filled no field' },
          rows: { type: "number", about: "only this many rows: the next ones not done yet (leave out for all that are left)" },
          wait: { type: "boolean", about: "wait until the run has finished (default true for try-outs and false for full runs)" },
        },
        run,
        print,
      },
      runs: {
        about: "See runs: all of them, newest first, or one with its failed rows and why each failed. With rows: a page of 50 of that run's rows, each with its state and cost.",
        role: "viewer",
        input: {
          run: { type: "number", about: "one run's number" },
          workflow: { about: "only runs of this workflow (its id)" },
          state: { about: "only runs in this state: running, waiting, paused, stopped or done" },
          offset: { type: "number", about: "skip this many of the newest runs (to see older ones)" },
          limit: { type: "number", about: "at most this many runs (50 unless said, 51 at most)" },
          rows: { type: "number", about: "with run: this page of its rows, 50 to a page (1 is the first)" },
        },
        run: async (i) => {
          if (i.run === undefined) {
            // The newest that fit, 50 at a time. Both filters are optional and are compared as values, never put into the SQL.
            const where = [i.workflow ? "workflow = $1" : "", i.state ? `state = $${i.workflow ? 2 : 1}` : ""].filter(Boolean)
            const limit = Math.max(1, Math.min(51, Math.floor(Number(i.limit)) || 50))
            const offset = Math.max(0, Math.floor(Number(i.offset)) || 0)
            const found = await q<Run>(`select * from ${S}.runs${where.length ? ` where ${where.join(" and ")}` : ""} order by id desc limit ${limit} offset ${offset}`, [i.workflow, i.state].filter(Boolean))
            return Promise.all(found.map(view))
          }
          const r = await getRun(i.run)
          if (!r) throw new Refused(`There is no run ${i.run}.`)
          const failed = await q(`select row, reason from ${S}.rows where run = $1 and state = 'failed' order by row limit 200`, [r.id])
          return { ...(await view(r)), failedRows: failed, ...(i.rows !== undefined ? { rowsPage: await rowsOf(r, Math.max(1, Math.floor(Number(i.rows)) || 1)) } : {}) }
        },
        print: (r: any) =>
          Array.isArray(r)
            ? r.length
              ? r
                  .map(
                    (v: View) =>
                      `${String(v.run).padEnd(4)}${v.name.padEnd(34)} ${`${v.rows.done} of ${v.rows.of}`.padEnd(12)} failed ${String(v.rows.failed).padEnd(4)} ${v.spent.text.padEnd(16)} ${v.asks ? "waits for a yes" : v.state === "done" ? "" : v.state}`,
                  )
                  .join("\n")
              : "No runs yet."
            : [print(r), ...r.failedRows.map((f: any) => `  row ${f.row} failed: ${f.reason}`)].join("\n"),
      },
      steps: {
        about: "One row of a run, step by step: each step's name, when it began and how long it took, who was paid and what, an answer already known, or why it failed.",
        role: "viewer",
        input: { run: { type: "number", about: "the run's number", required: true }, row: { type: "number", about: "the row's id in its list", required: true } },
        run: async (i) => {
          const r = await getRun(i.run)
          if (!r) throw new Refused(`There is no run ${i.run}.`)
          return stepsOfRow(r, Number(i.row))
        },
        print: (r: Awaited<ReturnType<typeof stepsOfRow>>) =>
          r.steps.length ? r.steps.map((x) => `${x.name.padEnd(32)} ${`${x.ms} ms`.padEnd(9)} ${x.text}`).join("\n") : `No steps were written down for row ${r.row}.${r.reason ? ` ${r.reason}` : ""}`,
      },
      yes: {
        about:
          "The person's yes, passed on by you: start a run that waits for one (ask mode), or carry on a run that paused at a cap. Only ever their own answer, word for word: never say yes for them. maxUsd: the new cap they said (for a paused run, the cap that was reached is lifted for this run).",
        role: "member",
        input: {
          run: { type: "number", about: "the run that waits for a yes", required: true },
          maxUsd: { type: "number", about: "the cap the person said, in USD" },
        },
        run: async (i, who) => {
          const r = await getRun(i.run)
          if (!r) throw new Refused(`There is no run ${i.run}.`)
          const capped = r.state === "paused" && r.code === "cap"
          if (r.state !== "waiting" && !capped) throw new Refused(`Run ${r.id} does not wait for a yes: it is ${r.state}.`)
          if (i.maxUsd !== undefined && !(i.maxUsd >= 0)) throw new Refused("maxUsd is a cap in dollars: a number of 0 or more.")
          const wf = wfOf(r.workflow)
          if (wf.hash !== r.file_hash) throw new Refused(`workflows/${r.workflow}.ts changed since this was asked. Start a new run: the yes is for the file as it was.`)
          await alone(wf.id, r.id)
          const own = `run:${r.id}`
          const before = await ledger().spent(own)
          if (capped) {
            const hit = r.cap_kind ?? own
            const b = await ledger().spent(hit)
            if (hit === own) {
              // The run's own cap was reached: the yes says the new one (twice the old unless they said a number).
              const next = i.maxUsd ?? (before?.maxUsd != null ? Math.ceil(before.maxUsd * 2 * 100) / 100 : null)
              await ledger().budget(own, { maxUsd: next, maxCalls: before?.maxCalls != null && i.maxUsd === undefined ? before.maxCalls * 2 : (before?.maxCalls ?? null) })
            } else {
              // Another cap (this month's, a provider's): lifted for this run only, by this yes. The run's own still holds.
              await q(`update ${S}.runs set lifted = array_append(lifted, $2) where id = $1`, [r.id, hit])
              if (i.maxUsd !== undefined) await ledger().budget(own, { maxUsd: i.maxUsd, maxCalls: before?.maxCalls ?? null })
              void b
            }
          } else if (i.maxUsd !== undefined) await ledger().budget(own, { maxUsd: i.maxUsd, maxCalls: before?.maxCalls ?? null })
          const after = await ledger().spent(own)
          const yes = await ledger().yes({ workflow: wf.id, hash: wf.hash, run: r.id, maxUsd: after?.maxUsd ?? null, who })
          if (capped) {
            await q(`update ${S}.rows set at = now() - interval '1 day' where run = $1 and state = 'failed'`, [r.id])
            await q(
              `update ${S}.runs set state = 'running', code = null, reason = null, cap_kind = null, finished_at = null, yes = $2, cursor = 0, claimed = (select count(*) from ${S}.rows where run = $1) where id = $1`,
              [r.id, yes],
            )
          } else await q(`update ${S}.runs set state = 'running', yes = $2, started_at = now() where id = $1`, [r.id, yes])
          await startWf(manifest.ids.run, [r.id])
          return view((await getRun(r.id))!)
        },
        print,
      },
      no: {
        about: "Not now: the person's no to a run that waits for a yes. It stops; nothing more is spent.",
        role: "member",
        input: { run: { type: "number", about: "the run that waits for a yes", required: true } },
        run: async (i, who) => {
          const r = await getRun(i.run)
          if (!r) throw new Refused(`There is no run ${i.run}.`)
          await q(`update ${S}.runs set state = 'stopped', code = 'person', reason = $2, finished_at = now() where id = $1 and (state = 'waiting' or (state = 'paused' and code = 'cap'))`, [
            r.id,
            `Not now, said ${who.name === "You" ? "by you" : `by ${who.name}`}.`,
          ])
          if (fb.has("door")) await fb.use("door").wrote(who, "said not now", `${r.workflow}, run ${r.id}`)
          return view((await getRun(r.id))!)
        },
        print,
      },
      resume: {
        about: "Carry on with a run that paused because too many rows failed, or stopped for a missing key, once that is fixed. A run paused at a cap needs a yes instead.",
        input: { run: { type: "number", about: "the run's number", required: true } },
        run: async (i) => {
          const r = await getRun(i.run)
          if (!r || !["paused", "stopped"].includes(r.state)) throw new Refused(`Run ${i.run} is not paused or stopped.`)
          if (r.code === "cap") throw new Refused(`Run ${r.id} paused at a cap: going on is the person's yes. Pass it on with: npx flowbound yes ${r.id}`)
          if (r.code === "person") throw new Refused(`Run ${r.id} was stopped by a person. Start a new run for the rows that are left.`)
          if (r.code === "changed" || wfOf(r.workflow).hash !== r.file_hash) throw new Refused(`workflows/${r.workflow}.ts changed since run ${r.id} began. Start a new run: npx flowbound run ${r.workflow}`)
          await alone(r.workflow, r.id)
          await q(`update ${S}.rows set at = now() - interval '1 day' where run = $1 and state = 'failed'`, [r.id])
          // It looks through the list from the top again: rows given back when it stopped are before the place it had reached.
          await q(`update ${S}.runs set state = 'running', code = null, reason = null, finished_at = null, cursor = 0, claimed = (select count(*) from ${S}.rows where run = $1) where id = $1`, [r.id])
          await startWf(manifest.ids.run, [r.id])
          return view((await getRun(r.id))!)
        },
        print,
      },
      stop: {
        about: "Stop a run. Rows already done stay done; nothing more is spent.",
        role: "member",
        input: { run: { type: "number", about: "the run's number", required: true } },
        run: async (i, who) => {
          const r = await getRun(i.run)
          if (!r) throw new Refused(`There is no run ${i.run}.`)
          await q(`update ${S}.runs set state = 'stopped', code = 'person', reason = $2, finished_at = now() where id = $1 and state in ('running', 'waiting', 'paused')`, [
            r.id,
            `Stopped by ${who.name === "You" ? "you" : who.name}.`,
          ])
          if (fb.has("door")) await fb.use("door").wrote(who, "stopped a run", `${r.workflow}, run ${r.id}`)
          return view((await getRun(r.id))!)
        },
        print,
      },
    },
    /** For Home: a yes that waits, a workflow file that is not well formed, a run that stopped short, and a run that seems stuck. */
    async attention() {
      const out: Attention[] = []
      for (const r of await q<Run>(`select * from ${S}.runs where state = 'waiting' or (state = 'paused' and code = 'cap') order by id desc limit 20`)) {
        const v = await view(r)
        out.push({
          what: v.asks!.question,
          fix: `Tell your agent yes (it passes it on: npx flowbound yes ${r.id}${v.asks!.suggestUsd ? ` --max-usd ${v.asks!.suggestUsd.toFixed(2)}` : ""}), or Not now. ${v.asks!.why}`,
          page: "/runs",
          params: { run: r.id },
          yes: { run: r.id },
          // Since when it waits: when it was asked, or when it paused at its cap.
          at: new Date(r.finished_at ?? r.started_at).toISOString(),
        } as Attention)
      }
      for (const w of Object.values(manifest.workflows))
        if (w.problem)
          out.push({
            what: `workflows/${w.id}.ts is not ready: ${w.problem}.`,
            fix: "Ask your agent to fix the file. `npx flowbound workflows` says when it is well formed.",
            page: "/workflows",
            params: { workflow: w.id },
          })
      // Only the newest run of each workflow counts: a run that stopped and was followed by another is history.
      for (const r of await q<Run>(`select distinct on (workflow) * from ${S}.runs where kind <> 'tryout' order by workflow, id desc`)) {
        if (!(r.state === "paused" && r.code !== "cap") && !(r.state === "stopped" && r.code !== "person")) continue
        const v = await view(r)
        out.push({
          what: `${r.title}, run ${r.id}: ${v.why ?? `it ${r.state} with ${r.total - v.rows.done} rows left.`}`,
          fix: r.code === "changed" ? "A changed workflow file needs a new try-out and a new run." : "Fix the cause (a key on the Connections page, a speed limit on the card), then ask your agent to carry on.",
          page: "/runs",
          params: { run: r.id },
        })
      }
      // Says it is running, and no row has moved for a long while: nobody is doing it (a crash the runner did not pick up).
      const stuck = await q<Run>(
        `select r.* from ${S}.runs r where r.state = 'running' and r.started_at < now() - interval '30 minutes'
           and not exists (select 1 from ${S}.rows x where x.run = r.id and x.at > now() - interval '30 minutes') order by r.id limit 20`,
      )
      for (const r of stuck)
        out.push({
          what: `${r.title}, run ${r.id}, says it is running, but no row has moved for half an hour.`,
          fix: "If a provider is only slow, wait. If not, stop it on its page: a new run does the rows that are left, and nothing is paid twice.",
          page: "/runs",
          params: { run: r.id },
        })
      return out
    },
    pages: {
      "/workflows": { title: "Workflows", file: asset("workflow-sdk/workflows.html"), menu: true, order: 2 },
      "/runs": { title: "Runs", file: asset("workflow-sdk/runs.html"), menu: true, order: 3 },
      "/schedules": { title: "Schedules", file: asset("workflow-sdk/schedules.html"), menu: true, order: 4 },
    },
    commands: {
      "workflow-check": {
        about: "check the workflow files without starting Flowbound",
        run: async (_args, cl) => {
          const { readWorkflows } = await import("./workflow-sdk/build.ts")
          const all = Object.values(await readWorkflows(cl.root))
          const problems = all.flatMap((w) => [w.problem, w.diagramProblem].filter(Boolean).map((problem) => `workflows/${w.id}.ts: ${problem}`))
          if (problems.length) throw new Refused(problems.join("\n"))
          console.log(`Checked ${all.length} workflow file${all.length === 1 ? "" : "s"}.`)
        },
      },
      deploy: {
        about: "put the same project live (Vercel with a Neon database)",
        run: async (args, cl) => (await import("./workflow-sdk/deploy.ts")).deploy(args, cl, opts.on),
      },
    },
    docs: asset("workflow-sdk/workflows.md"),
    // Read only when a job asks for one: `flowbound docs recipes`.
    guides: { recipes: asset("workflow-sdk/recipes.md") },
  })
}
