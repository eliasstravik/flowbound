## Home, and the check-up

`npx flowbound doctor` says everything that needs a person or is not right, each with the one thing to do about it.
Run it first when something seems off, and before you tell the person all is well. It looks at:

- a yes that waits: a run in ask mode, or a run paused at a cap. Show the person the question word for word and pass
  their answer on (`npx flowbound yes <run>`, `npx flowbound no <run>`); never answer for them
- keys: a card with no key that a workflow file reaches with `use("...")`
- workflows: a file that is not well formed; the newest run of a workflow when it paused or stopped short; a run that
  says it is running while no row has moved for half an hour
- webhooks: no signing secret
- money: a provider that reported a higher price than its card says
- live: people who signed in and wait for a manager to give them rights

`npx flowbound doctor --deep` also tries every saved key again at its provider (the same free call a typed key is
tried with), and says which one the provider no longer takes. `--live` asks the live Flowbound.

"Coming up" is what works today and will not for long. Tell the person about those too, in one line.

The person sees the same list first on the page, on Home (http://localhost:4111/needs): each yes that waits,
with Not now beside it (a yes is never a button: they tell you), and what else needs them.

A plug-in of your own says what needs a person with one more line, and it shows up in both places:

```ts
plugin({
  name: "my-crm-sync",
  attention: async () => (await lastSyncFailed()) ? [{ what: "The CRM sync failed last night.", fix: "Sign in to the CRM again on its page.", page: "/crm" }] : [],
})
```

`what` is one plain sentence, `fix` the one thing to do, `page` where a person does it. `when: "soon"` is for what
is not broken yet.
