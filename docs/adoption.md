# Install and configure

This is the consumer guide: install the published package, mount the component, put its
credentials on the Convex deployment, send a first event, and upgrade safely. Tinybird-side
provisioning (workspaces, schema, tokens, browser reads) is in [Tinybird setup](tinybird-setup.md).

## Install from npm

The package is published publicly to npmjs.com. Install the pinned version alongside Convex; no
registry token or `.npmrc` scope mapping is needed:

```bash
npm install @fantastic.dev/convex-tinybird@0.2.0 convex@^1.44.0
```

Each release is published from this repository's `Release` workflow with npm provenance, so
`npm audit signatures` can confirm the tarball was built from the tagged commit.

The app's only direct runtime dependencies for this integration are the component and Convex;
Workpool is installed transitively. Test tooling belongs in development dependencies.

## Mount

Create or update your app's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import tinybird from "@fantastic.dev/convex-tinybird/convex.config";

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

Each mount has its own tables, settings, health, credentials and Workpool. Mount as many named
instances as you have independent streams, and keep mount names stable: renaming a mount orphans
its tables. The left-hand keys are the component's contract (`TINYBIRD_TOKEN`, `TINYBIRD_HOST`,
and for browser reads `TINYBIRD_ADMIN_TOKEN`, `TINYBIRD_WORKSPACE_ID`); the right-hand
`process.env.*` names are yours, so two mounts can read differently named variables.

On TypeScript 6 or later, `convex dev` fails its typecheck with `Cannot find name 'process'` unless
`convex/tsconfig.json` names Node's types. TypeScript 6 no longer includes installed `@types/*`
packages automatically, and the `convex/tsconfig.json` that Convex generates doesn't list any. Install
`@types/node` as a development dependency and add `"types": ["node"]` to that file's
`compilerOptions`.

## Configure the Convex deployment

**The variables live on the Convex deployment, not in a local `.env` file.** The `process.env.*`
reads in `convex.config.ts` are evaluated by the Convex backend inside its own runtime, against
that deployment's environment variables. A `.env.local` in your repo, a shell `export`, or a
CI secret configures your tooling, not the backend. With no variables on the deployment the
component is inert rather than broken: enqueue still stores events, nothing is scheduled, no
request leaves, and no error is raised anywhere. That silence is why this section exists.

Set the values with the Convex CLI from your backend directory, after selecting the intended
deployment, and then push the configuration so the mounts receive it:

```sh
# Development deployment
npx convex env set TINYBIRD_HOST "https://api.us-east.tinybird.co"
npx convex env set TINYBIRD_TOKEN "$TINYBIRD_APPEND_TOKEN"   # supplied securely in the shell
npx convex dev --once

# Production deployment
npx convex env set --prod TINYBIRD_HOST "https://api.us-east.tinybird.co"
npx convex env set --prod TINYBIRD_TOKEN "$TINYBIRD_APPEND_TOKEN"
npx convex deploy
```

Use the variable names your mount mapping reads (`PRODUCT_TINYBIRD_TOKEN` and so on if you
renamed them). Set them separately on every deployment, with that environment's own Tinybird
workspace and token; never point a preview or development deployment at production credentials.
Re-push (`convex dev --once` or `convex deploy`) after changing a value: the mounts read the
environment when the configuration is pushed, not on every request. You can also set the
variables in the Convex dashboard under Settings → Environment Variables; the same re-push rule
applies.

Always set `TINYBIRD_HOST` explicitly, even though the component has a default: use the exact
[regional API origin](https://www.tinybird.co/docs/api-reference), not the dashboard URL.
Tinybird Local (`http://127.0.0.1:7181`) only works from a local Convex backend that can reach
your loopback address; a hosted deployment cannot reach it.

Run `npx convex dev` to generate the app's component bindings and deploy its functions. For a
disposable experiment, `CONVEX_AGENT_MODE=anonymous npx convex dev` sets up a local Convex
backend without a cloud account.

## First event

In an existing authenticated host mutation, construct the client from the generated mount and
enqueue alongside the domain write:

```ts
import { TinybirdDelivery } from "@fantastic.dev/convex-tinybird";
import { components } from "./_generated/api";

const analytics = new TinybirdDelivery(components.events);

// Inside your mutation, after checking the caller's access and writing the ticket:
await analytics.enqueue(ctx, {
  datasource: "tickets",
  eventId: `${ticketId}:opened`,
  payload: { ticket_id: ticketId, workspace_key: authorizedWorkspaceKey },
});
```

Replace the example datasource and payload with your deployed Tinybird schema. Choose a stable
event ID and retain the same payload for retries of that identity. The host owns authentication
and tenancy. The component accepts opaque data and does not infer a resource table or an
authorization model.

## Verify delivery

Use `analytics.status(ctx, { datasource: "tickets", eventId: ticketId + ":opened" })` from an
authorized host query. Acceptance into the outbox is not delivery; expect state `delivered`
after the worker's request succeeds. `health.configured` reports whether an append token is
present on the deployment, which is the first thing to check when events sit in `pending`.
The full pre-production checklist, including a synthetic event and a duplicate-safe read, is in
[Verify before enabling producers](tinybird-setup.md#verify-before-enabling-producers). The
package README covers health, pause and resume, replay and retention.

## Upgrade

Review the changelog for every upgrade. Published versions follow semantic versioning; during
`0.x`, minor versions can break compatibility. Pin a reviewed version, deploy and test staging
first, and run `convex dev` to regenerate your app's `_generated` bindings. Verify your
datasource migrations separately before production enablement. Do not modify package internals
to adapt it to your schema.

For your app's own integration tests, install Vitest, Vite and `convex-test` as development
dependencies, register each mount with the package's `test` helper, and stub all outgoing
delivery requests. The helper is TypeScript source and requires Vitest's glob transform, as does
Workpool's helper. See [Testing against it](../README.md#testing-against-it).
