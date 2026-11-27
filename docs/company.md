# Set up Flowbound for a company

## The engineer

1. [Deploy Flowbound](homes.md#start-from-the-deploy-button) with its own Neon database. Use a production HTTPS address and a separate Preview database without company data or keys.
2. Choose [Google Workspace or Microsoft Entra](sign-in.md#try-it-with-a-real-google-workspace). In the identity provider, register your Flowbound’s production address followed by `/door/callback`. For Microsoft, choose a single-tenant app.
3. In Vercel Production, set `FLOWBOUND_LOGIN` to `google` or `microsoft`. Set `FLOWBOUND_LOGIN_DOMAIN` for Google or `FLOWBOUND_LOGIN_TENANT` for Microsoft. Set `FLOWBOUND_OWNERS` to the work email addresses that will administer Flowbound. Add the client ID and secret as `FLOWBOUND_LOGIN_CLIENT_ID` and `FLOWBOUND_LOGIN_CLIENT_SECRET`. Remove the starter team password and deploy.
4. To make new colleagues Members on first sign-in, set `FLOWBOUND_LOGIN_DEFAULT_ROLE=member`. Enable it if all people who can sign in to this Flowbound should be able to save and ship workflows. For a smaller rollout, leave it unset and assign Member on the People page. An owner can remove access from that page.
5. For workflow edits and publishing from chat, [install Flowbound’s GitHub App on the project repository](../src/plugins/changes/changes.md#set-up-hosted-save-and-publish). Once a Member signs in, check that they can save a change, see its preview and publish a checked change.

## Claude Team and Enterprise

1. The organization Owner or Primary Owner opens **Organization settings → Connectors → Add → Custom → Web**. On Enterprise, a custom role with **Manage access to Libraries** can also add it.
2. Name it **Flowbound** and enter `https://your-flowbound.example/mcp`. Continue through the detected authentication settings. Choose **Sign in now** and **Register automatically** for the OAuth client. Leave shared request headers empty, then click **Add**.
3. Each salesperson opens **Customize → Connectors**, finds Flowbound and selects **Connect**. They sign in on Flowbound’s page with their work account and tap **Allow**.
4. In a conversation, open **+ → Connectors** and turn on Flowbound. Ask for the current workflows.

[Claude’s custom connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## ChatGPT Business and Enterprise/Edu

1. A workspace admin opens **Plugins** on ChatGPT web and chooses **+ → Add custom MCP server**. On Enterprise/Edu, the workspace’s **Create plugins with MCPs** permission can also let selected people create a draft.
2. Enter **Flowbound** and its full HTTPS `/mcp` URL. Choose OAuth with automatic discovery. Review the warning, create the plugin, and complete work sign-in if prompted. Check that the tool list contains `search` and `execute`.
3. The admin opens **Plugins → Personal → ⋯ → Publish** for Flowbound and selects the workspace roles that should get access. For a workspace using the earlier app interface, use **Admin Console → Plugins → Manage Legacy Apps → Drafts → Publish**.
4. Each salesperson opens Flowbound in the workspace’s Plugins list and installs or connects it if prompted. They sign in to Flowbound with their work account. In a Work chat, type `@` and pick Flowbound.

[ChatGPT custom MCP connections](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) · [Publish to a workspace](https://developers.openai.com/plugins/build/plugins#publish-a-local-plugin-to-your-workspace)

## Coding agents

Run `npx flowbound connect https://your-flowbound.example` once and restart the agent app. The first Flowbound tool call opens your browser for work sign-in. Switch to your own project with `npx flowbound connect --local` and restart.

A local developer checkout has its own data and provider keys. Test there, then use Save and Publish to send workflow changes to the company.
