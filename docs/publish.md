# Publishing

Release instructions for maintainers. The first npm release is pending.

## The one line to remove

In `package.json`:

```
  "private": true,
```

While it is there, `npm publish` refuses, and the publish workflow stops with a plain message. Remove it in the same
change that is released, and nowhere sooner.

## Before the first release

1. Review the tracked files and the packaged tarball for private details and credentials. Enable private vulnerability reporting on GitHub.
2. **npm.** Sign in at npmjs.com as the account that will own `flowbound` (the name was free on 26 Nov 2026).
   For the first release, make a granular access token that may publish, and save it in the GitHub repo as the
   secret `NPM_TOKEN`, in an environment called `npm` (Settings, Environments; add yourself as a required reviewer
   there, so each release waits for your tap). After the first release, set up trusted publishing on npmjs.com
   (the package's Settings: GitHub Actions, this repo, workflow `publish.yml`, environment `npm`) and delete the
   token.

## Releasing a version

1. In one change: the version in `package.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.antigravity-plugin/plugin.json` and `gemini-extension.json`; a new section at the top
   of CHANGELOG.md, in the words of what a person will notice; for the first release, the line above removed.
2. Merge it to `main`, then tag that commit and push the tag:
   ```
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. The `publish` workflow runs the whole check, makes sure the tag is the version, and publishes with provenance
   (npm shows where and how it was built). Nothing else starts it: not a push to a branch, not a pull request.

Before tagging, look at what would go out: `npm pack --dry-run` lists every file.
