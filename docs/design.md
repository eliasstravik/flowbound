# How the pages look, and how to make one

Every page (the six tabs: Needs you, Runs, Tables, Workflows, Keys, Permissions; live also People, Connect an agent,
sign-in and "Allow an app") is drawn from one style sheet and one script. A page says what it shows; it never says how it looks. Why it is built this way:
[decisions.md](decisions.md), "Design".

## What it stands on

| What | Where | Why this one |
| --- | --- | --- |
| The design system | [Basecoat](https://basecoatui.com) 1.3, on Tailwind 4 | shadcn/ui's own look and parts as plain HTML and CSS: no React, no runtime |
| The letters | Geist and Geist Mono, latin and latin-extended | 29 KB of subsetted fonts |
| The icons | lucide, drawn into the page | the set shadcn/ui uses; 14 of them, about 300 bytes each |
| Dialogs, selects, the phone menu | the browser's own `<dialog>` and `<select>` | focus, Escape and phones are handled by the browser |

Sources: `src/plugins/pages/design/style.css` (tokens, type, the frame, the few parts Basecoat lacks) and
`src/plugins/pages/design/app.js` (the bridge to the API, and the parts). `npm run build` makes them
into `src/plugins/pages/built/` (not in git) with `scripts/build-pages.mjs`; nobody who uses Flowbound builds anything.

## Tokens

shadcn/ui's names, Flowbound's values. Black on white, hairlines, one blue for focus. Four colours that only ever say
a state, always beside a word: green (done, saved), blue (running), amber (waiting, at its cap), red (stopped,
failed). Dark follows the system. `node test/design/contrast.mjs` checks
that every pair of text and ground is at least 4.5 to 1.

Type: 14px from 640px wide, 16px on a phone (nothing is zoomed on focus). One page title (`h1`, 20px), section
titles (`h2`, 16px), body, and a quiet line (`.sub`, 12px). Names of files, tables and addresses are in Geist Mono.
On a phone everything that is tapped is at least 44px tall.

## The parts a page is made of

A page file is plain HTML with one script: `fb.page("/path", async (root, params) => { ... })`. It builds its
content with `fb.h(tag, attributes, ...children)` and these parts. Only these class names are in the style sheet:
a class the build never saw does nothing, so a page of your own uses the parts, not loose utility classes.

| Part | How |
| --- | --- |
| The top of a page | `fb.ui.head({ title, sub, back: ["/runs", "All runs"], status, actions })` (also names the browser tab) |
| A state | `fb.ui.status("running")`, `fb.ui.status("stopped", "Stopped at its cap", "warn")` |
| A small label | `fb.ui.badge("Saved", "ok")` |
| A strip of numbers | `fb.ui.stats([["Rows", "57 of 9,991", fb.ui.progress(57, 9991)]])` |
| Name and value | `fb.ui.facts([["Yes by", "Maya"]])` |
| A list whose rows lead somewhere | `<ul class="rows">` of `fb.ui.link(path, params, [...])`: columns on a desktop, two lines on a phone |
| A table of data | `fb.ui.table(["Row", "Why"], rows)`; with `class="table-container fill"` it fills the window and its header stays |
| A note | `fb.ui.note(text, "warn")` (also `"bad"`) |
| Nothing here yet | `fb.ui.empty({ title, text, actions })` |
| A field | `fb.ui.field("Stop at", input, "a line of help")`, inputs with `class="input"` |
| A button | `class="btn"`, with `data-variant="outline"`, `"ghost"` or `"destructive"`, `data-size="sm"` |
| A card | `<article class="card" data-size="sm">` with `header`, `section`, `footer` |
| The yes | `<section class="decision">`: a question that waits for the person (said to their agent, never a Yes button), with Not now |
| An icon | `fb.ui.icon("download")` |
| The three permission modes | `<ul class="modes">` of `<li>`, the one in force with `aria-current` |
| A workflow's summary and diagram | `<div class="workflow">` with `<p class="lead">` and `<figure class="diagram">` around the agent's cleaned SVG |
| Small names in a row | `<div class="chips">` of `<span>` |
| A file's code, to read | `<div class="code">`: a column of line numbers and a `<pre>`; `.tok-note`, `.tok-word`, `.tok-text` colour it |
| What needs a person | `fb.ui.todo([{ what, fix, page: "/keys", when: "soon" }])`: what is the matter, the one thing to do, the way there; Needs you uses `class="todo needs"` with a kind beside each (Yes?, Key) |
| Where an answer came from | `<span class="src">` under a table cell: source, age, cost |

What a page does, it does through these, so every page behaves the same:

- `fb.call(tool, input)`: this Flowbound's HTTP API.
- `fb.act(button, async () => { ... })`: the button shows it is working, cannot be tapped twice, and a failure is said
  on top of the page.
- `fb.confirm({ title, text, yes, tone: "bad" })`: a question before what cannot be taken back.
- `fb.say("Saved.")`: one line over the page, read aloud once.
- `fb.poll(2000)`: refresh this page in two seconds. Only the parts marked `data-live` that changed are swapped, so a
  scroll, a focus and a selection are left alone. It rests while the tab is hidden and says so when the
  connection is gone.
- `fb.stay({ page: 2 })`: stay on the page with other settings; the address keeps the place.
- `fb.can("approve")`: may the person looking do this? A page shows what they may do, not a button that refuses.
- `fb.dollars("2,50")`: what a person typed as money (2.5), or NaN.
- `fb.when(iso)`: a moment in the reader's own time: "18:41" today, "26 Nov, 18:41" before.

## States every page has

Loading (a skeleton, only after 200 ms, so a fast page never flashes), empty (one line, what to do, at most two ways
on), failed (the reason, "Try again", and the way back), and, where something runs, in progress.

## Looking at every screen

```
npm run build
node test/design/seed.ts                 # three throwaway Flowbounds with every state; nothing is spent
test/design/shots.sh out/                # every screen: phone and desktop, light and dark
test/design/states.sh out/states         # the menu, dialogs, questions, a search being typed
test/design/stop.sh
```

The two screenshot scripts drive `agent-browser`; set `BROWSER` to use another command with the same words.

## What it weighs (26 Nov 2026, this machine)

| | Before | Now |
| --- | --- | --- |
| A page's own HTML (Runs) | 20 KB | 15 KB |
| Style sheet and script | inside every page | two files the browser keeps: 13 KB and 6 KB zipped |
| First paint, Runs and a 10,000-row table | 24 to 44 ms | 36 to 64 ms |
| Turning a page, searching or sorting 10,000 rows | not possible | 4 to 25 ms |
| Fonts | 352 KB | 29 KB (+17 KB for names like Łódź, +23 KB when something is in mono) |
| Rows held by a 10,000-row table | up to 10,000 | 100 |
