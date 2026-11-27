# Publishing

The release workflow publishes the public npm package from GitHub Actions with provenance. It runs on a matching release tag and checks that the tag matches `package.json`.

## First release

1. Check the package name in the npm registry and build and inspect the tarball. For a new unscoped package, the npm account owner creates a short-lived granular access token with package read/write publishing access and Bypass 2FA. Use the GitHub Actions secret `NPM_TOKEN` in the `npm` environment. Revoke the token and delete the secret after the first release.
2. Merge the release change to `main`. Tag the checked commit with `v0.1.0` and push only that tag. Check the workflow run and the version and provenance on the npm package page.
3. In the npm package’s Settings, choose **Trusted Publisher**, then **GitHub Actions**. Set owner `eliasstravik`, repository `flowbound`, workflow `publish.yml`, environment `npm`. Allow direct publishing so checked release tags can run without a token or manual approval.

## Later releases

1. Update the version in `package.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.antigravity-plugin/plugin.json` and `gemini-extension.json`. Update the lockfile and add a short changelog entry.
2. Merge the release change. Tag the checked commit, and push the tag. The same workflow gets its short-lived credentials from npm Trusted Publishing.
3. Check the registry and install the new version in a clean project.

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) for supported runners and settings.
