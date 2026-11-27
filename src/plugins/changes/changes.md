## Changes

Workflows are TypeScript files in your project's Git repository. A Member can create, change, try and publish
workflows from chat. Save makes a commit on a branch. On GitHub, Flowbound's App writes the commit and names the
person who requested it. The pull request keeps the normal GitHub diff and review. Engineers can keep using GitHub.
Pull requests that touch this project's workflows appear under Changes.

### From a chat

Use MCP `search` for the tool inputs and `execute` to call the tools. Read `workflow-sdk` and `recipes` for file formats.

1. **Read.** Call `flowbound["workflow-file"]({ file: "workflows/find-sales-heads.ts" })`. Keep the returned
   `head`. For an existing change, include its `id`. A missing file returns null.
2. **Save.** Write the complete file in chat. Call `flowbound["workflow-save"]({ title, head, files: [{ path, text }] })`.
   Use paths like `workflows/find-sales-heads.ts`. Use `text: null` to remove a file. Include `id` to add to a
   saved change and use the head you read from that change. If it moved, read again and keep the newer edits.
3. **Try.** Open the saved change's `page`, or call `flowbound["workflow-change"]({ id })` for checks, preview and
   pull request. On a laptop, start it with `{ id, head, startPreview: true }`. Use the preview's own Flowbound
   address, sign in if needed, and import a small test list there. Run through the preview's connector with
   `try`, `maxUsd` and `maxCalls`. Pass on the person's own yes if Flowbound asks for one. On Vercel, the owner
   can run a connector test through authenticated preview access.
4. **Publish.** When the person asks to publish, call `flowbound["workflow-publish"]({ id, head })` or use the Publish
   button. The types, workflow and test checks must all pass for that commit. If GitHub asks for review, give the
   person the named reviewer or team and the pull request link. If GitHub asks for an update, update the branch in
   GitHub and wait for its new checks. A merge starts deployment. Check the production workflow before saying it's live.
5. **Undo.** Call `flowbound["workflow-undo"]({ id })` with the published change ID, or open it under **Changes → Published changes**
   and tap Undo. This saves a Git revert. Check and publish it the same way. Run results and provider charges stay
   in the history. Use GitHub to revert an engineer's squash, rebase, or mixed-file merge.

### Project roles

| Role | What they can do |
| --- | --- |
| Viewer | Read workflows, changes, runs and results. |
| Member | Also create, save, run, approve spending within project rules and publish workflows. |
| Admin | Also manage keys, settings and access for Members and Viewers. |
| Owner | Also appoint or remove Admins and other Owners, and remove the project through its host. |

A chat acts for its signed-in person, up to Member. Old View is Viewer, Edit and Approve are Member, and Manage
is Admin. Addresses named in the former managers setting are Owners. People with no access stay out. Existing
group settings still work and map the old words the same way. New settings use `door({ owners: [...] })` or
`FLOWBOUND_OWNERS`. For a team password, typed names have Admin access on the page and Member access in chat.
Use a work login to identify individual users.

### On a laptop

Use a Git checkout with an initial commit on `main` (or set `changes: { branch: "..." }`). Install the project's
dependencies, including TypeScript. For a project without Git, run `git init -b main`, stage the project files you
intend to keep in Git, then make the first commit. Keep local keys and `.flowbound/` out of Git.

Save leaves the working files alone. The checks run from a separate Git worktree, using installed dependencies.
Use a `types` script or a `tsconfig.json`, and a `test` script or Node's test runner. A preview starts in a
separate app with empty tables and no keys. Starting another preview replaces it. Publish from a clean checkout
of the publish branch. Git merges the checked files and Flowbound reloads if a workflow changed. Put other working
edits away first.

### Set up hosted Save and Publish

A repository owner does this once. Use the permissions in `.github/flowbound-app.json`.

1. On your own computer, sign in to the Vercel CLI and open a checkout of the Flowbound package repo. Run
   `node scripts/register-workflow-app.mjs OWNER/REPO VERCEL_TEAM VERCEL_PROJECT https://FLOWBOUND_URL`.
   Add `--org` if GitHub owns the repo under an organization. Open the address the command prints on that computer.
2. Choose **Continue to GitHub**, check the name and click **Create GitHub App**. The manifest asks for
   Contents and Pull requests write, Checks read, and Deployments and Commit statuses read for preview links.
   GitHub adds Metadata read. The App is private with no webhook. The setup sends the private key straight to
   Vercel Production, along with the App ID and repo. Skip the private key download in GitHub.
3. Follow **Install the App**. Choose the account that owns the repo, then **Only select repositories**, select
   this repo, and click **Install**. Copy the number from the end of the installation settings URL and set it
   as `FLOWBOUND_GITHUB_INSTALLATION_ID` in Vercel Production. For a different host, use the same manifest and
   put those four values in the host's Production secret settings.
4. If the Flowbound project is inside the repository, set its relative folder with
   `changes: { directory: "staging" }` in `flowbound.config.ts`. Deploy main and open Changes to check the connection.
5. On GitHub, enable **Allow merge commits**. In the rule for the default branch, require pull requests and the
   GitHub Actions checks **types**, **workflows**, and **tests**. Turn on **Require branches to be up to date
   before merging**. Leave the App off the bypass list. Add required reviews or code owners if your team wants
   human review. For different job names, set the three names with `changes: { checks: [...] }`. The jobs must run
   on a push to the saved branch so Flowbound can read results for the exact commit.
6. In Vercel, connect the same GitHub repo and set the production branch. Enable deployments for other branches
   and turn on Deployment Protection for previews. If you use Neon, enable a separate Neon database branch for
   each Preview branch through the Neon integration. Use a test parent with no production data or keys, and give
   Preview its own Flowbound sign-in secret. Keep production database credentials and the GitHub App secret out
   of Preview. Confirm one test branch works before inviting Members.

Grant Member to people you trust to ship project code. Workflow steps run as application code in the deployed
environment. Vercel's rules about who can trigger a deployment on a private repository still apply. On an
organization repo, verify that Vercel accepts commits made by the App before relying on previews.

GitHub: [App settings](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
Vercel: [Git integration](https://vercel.com/docs/git/vercel-for-github), [deployment protection](https://vercel.com/docs/deployment-protection).
Neon: [Vercel integration](https://neon.com/docs/guides/vercel-native-integration).
