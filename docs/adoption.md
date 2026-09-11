# Adoption

The package is published to GitHub Packages under the `@fantasticdevhq` scope. While the repository
is private, installing it needs a GitHub token with `read:packages` for an account that can see
`FantasticDevHQ/convex-tinybird`. Map the scope to GitHub Packages in the consuming app's `.npmrc`
and supply the token through the environment; never commit a token:

```ini
@fantasticdevhq:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then install the pinned version alongside Convex:

```bash
NODE_AUTH_TOKEN=<token> npm install @fantasticdevhq/convex-tinybird@0.1.0 convex@^1.44.0
```

pnpm reads the same `.npmrc`. In GitHub Actions, `actions/setup-node` with
`registry-url: https://npm.pkg.github.com` and `scope: "@fantasticdevhq"` writes the mapping for
you; set `NODE_AUTH_TOKEN` on the install step to a token that can read the package (the
workflow's own `GITHUB_TOKEN` once the package grants that repository access, or a fine-grained
token stored as a secret).

To try an unreleased checkout instead, run `npm pack` from the package directory and install the
resulting archive path in place of the version. The app's only direct runtime dependencies for
this integration are the component and Convex; Workpool is installed transitively. Test tooling
belongs in development dependencies.

## Mount and configure

Create or update your app's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import tinybird from "@fantasticdevhq/convex-tinybird/convex.config";

const app = defineApp();
app.use(tinybird, {
  name: "events",
  env: {
    TINYBIRD_TOKEN: process.env.TINYBIRD_TOKEN,
    TINYBIRD_HOST: process.env.TINYBIRD_HOST,
  },
});
export default app;
```

Provision this app's Tinybird datasource and append-only credential using [Install in another app](installing-in-another-app.md). Set the corresponding `TINYBIRD_TOKEN` and regional `TINYBIRD_HOST` in the intended Convex deployment's environment variables. Use separate credentials for each app/environment. Mounting does not create Tinybird resources. Never put append or signing credentials in frontend environment variables.

Run `npx convex dev` to generate this app's component bindings and deploy its functions. For a disposable local experiment, `CONVEX_AGENT_MODE=anonymous npx convex dev` sets up local Convex without a cloud account. Complete the host's own setup before using a production deployment.

## First event

In an existing authenticated host mutation, construct the client from the generated mount and enqueue alongside the domain write:

```ts
import { TinybirdDelivery } from "@fantasticdevhq/convex-tinybird";
import { components } from "./_generated/api";

const analytics = new TinybirdDelivery(components.events);

// Inside your mutation, after checking the caller's access and writing the ticket:
await analytics.enqueue(ctx, {
  datasource: "tickets",
  eventId: `${ticketId}:opened`,
  payload: { ticket_id: ticketId, workspace_key: authorizedWorkspaceKey },
});
```

Replace the example datasource and payload with your deployed Tinybird schema. Choose a stable event ID and retain the same payload for retries of that identity. The host owns authentication and tenancy. The component accepts opaque data and does not infer a resource table or an authorization model.

Use `analytics.status(ctx, { datasource: "tickets", eventId: ticketId + ":opened" })` from an authorized host query to verify delivery. Acceptance into the outbox is not delivery; expect state `delivered` after the worker's request succeeds. With no append credential, enqueue retains the event without scheduling delivery. See the package README for health, replay and retention operations.

## Verify and upgrade

The package's `scripts/clean-consumer.sh` runs the packed archive in an independent ticket app; with `CONVEX_TINYBIRD_CONSUMER_SPEC=@fantasticdevhq/convex-tinybird@<version>` and a `NODE_AUTH_TOKEN` it installs that published version from GitHub Packages instead. Its delivery test imports `register` from the public `test` export and stubs fetch, so it needs no Tinybird credentials. Use the repository's Node 24.19 toolchain when running this maintainer check. Its anonymous Convex deployment and app files are temporary.

For your app's own integration tests, install Vitest, Vite and `convex-test` as development dependencies, register each mount with the package test helper, and stub all outgoing delivery requests. The helper is TypeScript source and requires Vitest's glob transform, as does Workpool's helper.

Review the changelog for every upgrade. Published versions follow semantic versioning; during `0.x`, minor versions can break compatibility. Pin a reviewed version, deploy and test staging first, and run `convex dev` to regenerate your app's `_generated` bindings. Verify your datasource migrations separately before production enablement. Do not manually modify package internals to adapt it to your schema.
