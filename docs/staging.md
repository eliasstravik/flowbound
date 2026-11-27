# A staging installation on Vercel

The `staging/` project is a build example. Import the repository in Vercel and set the root directory to `staging`. The build script packs the current checkout and builds the staging project with that package.

Follow the [hosting guide](homes.md) to connect Postgres and set the deployment URL and secret. Set up [sign-in](sign-in.md) before giving anyone access. Give the staging installation a separate database and add provider keys on Flowbound’s Keys page.

The example list is `staging/targets.csv`. The workflow calls a paid provider when a key is configured. For a free local example use `flowbound init --example`.

To check staging, open its sign-in page and connect a chat client to the deployment’s `/mcp` address. `test/live/chat-app.mjs` provides a stand-in chat client for a disposable installation.
