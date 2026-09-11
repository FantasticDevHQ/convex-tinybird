# Install in another app

Repeat this setup for each app that consumes the component. Installing or mounting the package
does not create a Tinybird account, workspace, datasource, endpoint, or credential. The host app
owns those resources and supplies the destination to each component mount. No existing app's
Tinybird workspace, schema, secrets, deployment workflow, or authentication system is required.

## Choose the destinations

Use separate cloud workspaces for each app's staging and production environments. Develop against
Tinybird Local when possible. Keep a configuration inventory like this for each installation:

| Convex deployment | Mount           | Tinybird destination      | Host environment variables                        |
| ----------------- | --------------- | ------------------------- | ------------------------------------------------- |
| Local development | `productEvents` | Disposable Tinybird Local | `PRODUCT_TINYBIRD_HOST`, `PRODUCT_TINYBIRD_TOKEN` |
| App A staging     | `productEvents` | `app_a_staging`           | Same names, staging values                        |
| App A production  | `productEvents` | `app_a_prod`              | Same names, production values                     |
| App B production  | `productEvents` | `app_b_prod`              | Same names, App B values                          |

The names are examples. Record each workspace ID, regional API origin, datasource names, owning
app, and deployment target. Store token values in the relevant secret stores, separately from
this inventory. Never route preview data into production merely because the schemas match.

A new mount does not require a new cloud workspace. Two mounts can deliberately share a workspace
and use different datasources and append tokens. Their Convex queues, pause settings, retention,
and Workpools remain independent. Their Tinybird storage does not become isolated automatically:
if both write the same table, its event identity and query rules must distinguish their records.
Use separate workspaces when streams need independent access or deployment ownership. Do not
point independent infrastructure projects at one workspace and assume their deployments are isolated.

## Install the component

The package is published to GitHub Packages as `@fantasticdevhq/convex-tinybird`; the repository
is private for now, so installs need a token with `read:packages` as described in
[Adoption](adoption.md). Add the pinned version to the consuming backend's dependencies together
with its compatible `convex` peer version from [package.json](../package.json), map the
`@fantasticdevhq` scope to `https://npm.pkg.github.com` in that app's `.npmrc`, and run
`pnpm install` (or `npm install`). Its source imports only Convex and its nested Workpool
dependency. This repository's TypeScript configuration is development tooling, not something the
consuming app must adopt.

Use the [mount configuration in the README](../README.md#install-and-mount) and keep mount names
stable. `productEvents` and `auditEvents` demonstrate two mounts with separate host variable names.
Each maps its chosen host variables into the same component contract, `TINYBIRD_HOST` and
`TINYBIRD_TOKEN`. Instantiate `TinybirdDelivery` using that mount's generated component reference.

## Provision Tinybird and deploy your schema

1. Create or select the app's staging and production workspaces in your Tinybird organization.
   Check workspace availability under your existing plan before provisioning. Record the exact
   [regional API origin](https://www.tinybird.co/docs/api-reference), not the dashboard URL.
2. Put datasource and pipe definitions in the consuming app's own infrastructure directory. Start
   from the [generic datafiles or SDK definitions](../tinybird/README.md), then adapt the columns
   to your domain. The sample `events` schema and example app's `orders` payload are different;
   they cannot be combined unchanged. Keep the SDK in infrastructure tooling, outside the component
   and browser runtime.
3. Declare an append token on each intended datasource. For a datafile named `events.datasource`,
   add `TOKEN app_events_append APPEND` above its `SCHEMA` section. Give it access only to the
   tables that mount writes. Declare read permissions separately on the endpoints that need them.
   See Tinybird's [static token reference](https://www.tinybird.co/docs/forward/core-concepts/static-tokens).
4. Authenticate the CLI in that infrastructure directory, select the intended workspace, inspect
   the target, and deploy staging first. For a datafile project:

   ```sh
   tb login --host "$APP_TINYBIRD_API_ORIGIN" --workspace app_a_staging
   tb --cloud workspace current
   tb --cloud deploy
   ```

   Supply `APP_TINYBIRD_API_ORIGIN` from your inventory. For an SDK project, use its pinned SDK
   deployment command instead of treating TypeScript definitions as datafiles. Review schema
   changes before deploying production. Keep repeat deliveries safe with stable identities and
   deduplicated reads as described in the generic guide.

5. Retrieve the deployed append token from the selected workspace's Tokens page. Keep the
   deployment credential separate. CI can use a token with `WORKSPACE:DEPLOY` created through
   `tb --cloud token create static app_ci_deploy --scope WORKSPACE:DEPLOY`.

## Configure the consuming Convex deployment

| Credential or setting                            | Store                                                      | Purpose                                    |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------ |
| Datasource append token                          | Each target Convex deployment, mapped into each mount      | Runtime event delivery                     |
| Regional API origin                              | Same Convex deployment, mapped to `TINYBIRD_HOST`          | Runtime destination                        |
| Workspace deployment token                       | App's CI environment secrets                               | Deploy datasource and endpoint definitions |
| Deployment API origin                            | App's CI environment configuration                         | Target the correct region                  |
| Workspace admin signing token, if reads are used | Target Convex deployment, mapped to `TINYBIRD_ADMIN_TOKEN` | Sign short-lived browser JWTs              |
| Workspace ID, if reads are used                  | Same deployment, mapped to `TINYBIRD_WORKSPACE_ID`         | Bind JWTs to the intended workspace        |

GitHub environment secrets do not configure Convex, and logging into `tb` does not configure
either store. Set the variables on the Convex deployment that runs the consuming app. Shell
variables and the app's `.env.local` alone do not supply mount-time values to the Convex backend.
Provision the Convex deployment first, using the app's normal setup process. From its backend
directory, for the `productEvents` mapping:

```sh
# Select and verify the app's development deployment before running these commands.
# Supply APP_TINYBIRD_APPEND_TOKEN securely in the shell; never commit or log it.
pnpm exec convex env set PRODUCT_TINYBIRD_HOST "$APP_TINYBIRD_API_ORIGIN"
pnpm exec convex env set PRODUCT_TINYBIRD_TOKEN "$APP_TINYBIRD_APPEND_TOKEN"
pnpm exec convex dev --once
```

Repeat for `AUDIT_TINYBIRD_HOST` and `AUDIT_TINYBIRD_TOKEN` if mounting `auditEvents`.
For production, explicitly target that app's production deployment with `convex env set --prod`
and run its normal `convex deploy` process. Re-push the configuration after changing values so
the mounts receive them. Repeat for every app and environment; do not reuse another app's secrets.

Always set the host explicitly, even though the component has a default. Tinybird Local requires
a local Convex backend that can reach its loopback address. A hosted Convex deployment cannot
reach Tinybird Local on your laptop via `127.0.0.1`. Its credentials are disposable local values,
not the cloud tokens.

## Configure browser reads

Repeat this for every app and environment that needs browser analytics. Retrieve the intended
workspace's admin signing token and workspace ID from Tinybird. An append or CI deployment token
cannot substitute for the signing secret. Keep the secret in that app's Convex deployment.
Extend its `productEvents` mount mapping:

```ts
app.use(tinybird, {
  name: "productEvents",
  env: {
    TINYBIRD_TOKEN: process.env.PRODUCT_TINYBIRD_TOKEN,
    TINYBIRD_HOST: process.env.PRODUCT_TINYBIRD_HOST,
    TINYBIRD_ADMIN_TOKEN: process.env.PRODUCT_TINYBIRD_ADMIN_TOKEN,
    TINYBIRD_WORKSPACE_ID: process.env.PRODUCT_TINYBIRD_WORKSPACE_ID,
  },
});
```

Use the workspace token with `ADMIN` scope for signing. A personal or CLI token with
`ADMIN_USER` scope is not a JWT signing key, even when it can ingest or query that workspace.

Using securely supplied values, set `PRODUCT_TINYBIRD_ADMIN_TOKEN` and
`PRODUCT_TINYBIRD_WORKSPACE_ID` with `convex env set`, then re-push the app configuration as
above. Repeat with the audit mount's own variables if it also supports reads. A shared workspace
means a shared signing authority; separate Convex mounts do not change that authority.

Create an app-owned public mutation that authorizes the viewer and requested tenant/project,
then calls `productEvents.mintReadToken`. The host chooses the allowed pipes, fixed parameter
values, lifetime, and rate limit. Use the [read-token API contract](../README.md#reading-from-the-browser).
The generic endpoint is not a tenant isolation template; adapt and test its tenant filter before
allowing browser access.

Check `health.readTokensConfigured`, then verify an actual endpoint request with the minted JWT.
Test a denied viewer, a foreign tenant, an attempted override of the fixed parameters, and expiry.
Keep the returned JWT in browser memory. Never ship append, deployment, or admin tokens to the
browser, and never store them in public frontend environment variables. Signing-token rotation
affects every JWT signed by that workspace token; update all mounts using it and re-push.

Use the package's `./browser` entry for endpoint requests. Your app must supply a token issuer
with its own authorization rules and an in-memory refresh mechanism. Share pending token mints
between charts with the same viewer and tenant/project scope. Refresh a minute before expiry,
retry an endpoint 403 only once with a refreshed token, and clear tokens and results on sign-out
or scope changes. Pass an `AbortSignal` to `queryPipe` when replacing or unmounting a request.
Do not import the server client or infrastructure SDK into frontend code. The package boundary
check enforces this separation for its browser entry; keep an equivalent check in your app's
frontend build.

## Verify before enabling producers

Deploy the Tinybird schema before enabling live event emission. For each mount:

1. Confirm `health.configured` is true. This checks configuration presence, not that the token
   has permission or the datasource exists. Without a token, enqueue stores events but schedules
   no delivery.
2. Enqueue a synthetic event through an authorized host mutation, matching the deployed columns.
   Verify both the host domain write and component event commit together. Use a stable event ID
   that cannot collide with real data.
3. Inspect the event's delivery status and confirm its row through an authorized Tinybird read.
   Test repeated delivery against the duplicate-safe query, then verify every additional mount.
4. Register bounded recovery and retention maintenance and protect operator actions with the
   app's authorization. Follow the [maintenance and recovery guide](../README.md#maintenance-and-recovery).
5. Enable the app's producers gradually and monitor pause state, failed events, and pending age.

If delivery pauses after a bad destination or token, correct that deployment's configuration,
re-push, and use the authorized resume operation. Resume also schedules pending events that were
enqueued before credentials existed. Failed events require inspection and bounded replay after
their cause is fixed. Follow the [operator guide](../README.md#pausing-and-resuming).

Keep mount names, destination mappings, and event identities stable during upgrades. Changing a
mount's destination while it has a backlog can send its pending events to the new destination;
treat that as a data migration, not a routine installation step.

For browser readers, add security checks in each consuming app. Create an authenticated caller,
then remove its membership or downgrade its role and verify the issuer returns the same denial
as a foreign tenant or project request, without calling `mintReadToken`. Against that app's
Tinybird schema, sign a read JWT fixed to tenant A and request tenant B through URL parameters;
only A's data may return. The package's `/test` entry exports `signReadToken` for these checks;
use synthetic or Local-only signing keys. Verify that an expired JWT is refused. Run these checks against Local
before using staging credentials.

Inspect the consuming app's production bundle as well. Reject the Tinybird server SDK by its
bundled module identity, since minification can erase package names. Scan emitted scripts and
source maps for static Tinybird tokens and server environment names. These are host build checks;
installing the component does not configure another app's bundler or authorization tests.
