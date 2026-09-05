# @fantastic-dev/convex-tinybird

A reusable Convex component for delivering analytics events to Tinybird. Enqueue runs in the
host mutation's transaction, so domain writes and the event commit or roll back together.
Delivery uses Workpool with bounded retries and one event per request.

Delivery is **at least once**. A lost acknowledgement can cause a repeated request; Tinybird
queries must handle those repeats. The component's enqueue identity checks do not provide
exactly-once ingestion or make raw additive aggregates safe.

## Install and mount

Start with [Install in another app](./docs/installing-in-another-app.md) for the complete setup:
per-app staging and production workspaces, host-owned schemas, scoped credentials, Convex
deployment configuration, and delivery verification. Repeat that setup for each consuming app.
Mounting this component does not provision Tinybird or reuse another app's infrastructure.

This is currently a private workspace package, not a published npm release. Add
`@fantastic-dev/convex-tinybird` as a workspace dependency alongside `convex`. The component's
only runtime dependencies are Convex and Workpool; it imports no host schema or authentication.

The [example configuration](./example/convex/convex.config.ts) mounts two independent streams:

<!-- example: example/convex/convex.config.ts -->

```ts
import tinybird from "@fantastic-dev/convex-tinybird/convex.config";
import { defineApp } from "convex/server";

/**
 * Two instances, mounted under different names.
 *
 * This is the portability proof, not decoration. Each mount gets its own tables, its own
 * settings row and its own Workpool, so an event enqueued into `productEvents` is invisible to
 * `auditEvents` — and pausing one does not pause the other. A component that leaked state
 * between mounts would be unusable for anything but a single global stream, and nothing in the
 * component's own test suite can notice that, because it registers one instance.
 *
 * The two also carry different credentials, which is the realistic shape: a product stream and
 * an audit stream usually live in different Tinybird workspaces with separately scoped tokens.
 */
const app = defineApp();

app.use(tinybird, {
  name: "productEvents",
  env: {
    TINYBIRD_TOKEN: process.env.PRODUCT_TINYBIRD_TOKEN,
    TINYBIRD_HOST: process.env.PRODUCT_TINYBIRD_HOST,
  },
});

app.use(tinybird, {
  name: "auditEvents",
  env: {
    TINYBIRD_TOKEN: process.env.AUDIT_TINYBIRD_TOKEN,
    TINYBIRD_HOST: process.env.AUDIT_TINYBIRD_HOST,
  },
});

export default app;
```

Each mount has separate events, settings, health, credentials, and Workpool state. Keep mount
names stable when updating the host. The example tests prove that both mounts accept the same
`(datasource, eventId)` independently and that pausing one leaves the other running.

## Environment

The host supplies the component's declared variables through each mount's `env` mapping.
Component code reads the generated `env` export. Static credentials are not stored in component
tables, returned by functions, or logged. Only the scoped, short-lived read JWT is returned.

| Variable                | Use                                         | When absent                                  |
| ----------------------- | ------------------------------------------- | -------------------------------------------- |
| `TINYBIRD_TOKEN`        | Server-side datasource append credential    | Enqueue stores events, but delivery is inert |
| `TINYBIRD_HOST`         | Regional API origin                         | Uses the component's default Tinybird origin |
| `TINYBIRD_ADMIN_TOKEN`  | Workspace admin signing secret, server only | Read-token minting fails closed              |
| `TINYBIRD_WORKSPACE_ID` | ID of the workspace accepting read JWTs     | Read-token minting fails closed              |

Use a token scoped to `DATASOURCE:APPEND` for the intended datasource. A regional origin such as
`https://api.eu-central-1.aws.tinybird.co` selects that Tinybird region;
`http://127.0.0.1:7181` targets Tinybird Local.

Use a bare HTTPS origin without a path, query, fragment, or embedded credentials. Loopback HTTP
is supported for Tinybird Local. Invalid destinations and authentication failures pause the
mount and appear in its health result.

## Reading from the browser

Each consuming app supplies its own workspace ID and signing secret through the mount's
`env` mapping. See [per-app setup](./docs/installing-in-another-app.md#configure-browser-reads).
Append and read configuration are independent: `health.configured` still checks the append
token, while `health.readTokensConfigured` checks the signing secret and workspace ID. Neither
proves that the remote credentials work.

In an authorized host mutation, call `delivery.mintReadToken(ctx, args)` with a `name`, an
integer `ttlSeconds` from 60 to 3600, and 1 to 10 scopes shaped as
`{ pipe, fixedParams: Record<string, string> }`. Optional `rps` must be a positive safe integer.
The result is `{ token, expiresAt, host }`; `expiresAt` is a Unix timestamp in **seconds**.
Missing signing configuration throws `read_tokens_not_configured`; invalid limits or fixed
parameter values throw `invalid_read_token` or a Convex argument-validation error.

The host must authenticate the viewer and derive allowed pipe names and tenant/project values
from authorized records. Never expose this component method through a pass-through public
mutation that accepts browser-provided scopes. Fixed parameter names must exactly match the
pipe's typed parameters, and every source in its SQL must apply the tenant filter. A signed
parameter alone does not filter rows. An empty project value may mean team-wide access only
if the host and endpoint explicitly share that contract.

The browser sends the returned JWT in `Authorization: Bearer <token>` to the allowed endpoint
on `host`. Keep it in memory and request a fresh token through the authorized mutation before
expiry. Minting is a mutation, never a cached query. The signer uses Web Crypto HMAC SHA-256
without a JWT runtime dependency; signing is verified in a real local Convex mutation.

JWTs remain usable until expiry even if app membership changes. They cannot be revoked
individually; rotating the workspace admin signing token invalidates tokens signed with it.
Update each affected deployment and re-push its mount configuration after rotation. Browser
clients must never receive append, deployment, or admin credentials. See the
[Tinybird JWT contract](https://www.tinybird.co/docs/forward/core-concepts/jwt).

Import `queryPipe` from `@fantastic-dev/convex-tinybird/browser` in browser code. This separate
entry imports neither the component client nor the Tinybird SDK. Pass the token issuer's
`host` and `token`, the allowed `pipe` name, typed query `params`, and an optional abort
`signal`. It returns `{ data, meta, rows }`. Values in `params` are strings, numbers, or
booleans, encoded as URL parameters; the JWT goes only in the authorization header. Requests
omit cookies and browser caching and refuse redirects.

`TinybirdQueryError.code` distinguishes `token_expired_or_invalid` for HTTP 403,
`rate_limited` for 429, `bad_request` for other 4xx responses or invalid request destinations,
and `unavailable` for 5xx, network errors, or malformed responses. Cancellation preserves the
caller's abort reason. Provider response bodies and network error details are not exposed.

Each host owns its token lifecycle. Share one in-memory token and pending mint per authorized
viewer and tenant/project scope. Refresh 60 seconds before expiry. On 403, refresh and retry the
request once; a second 403 or an authorization refusal must surface as forbidden. Abort old
requests and discard cached tokens and results when the scope or viewer changes. The package
does not install React hooks or an authentication provider in another app.

## Enqueue from a host mutation

Inside the example's [`place` mutation](./example/convex/orders.ts), the domain write and enqueue
share `ctx`. The complete file includes the imports, validators, second stream, and rollback test hook.

<!-- example: example/convex/orders.ts -->

```ts
const orderId = await ctx.db.insert("orders", { sku, quantity, placedAt: Date.now() });

await productEvents.enqueue(ctx, {
  datasource: "orders",
  // The identity a host chooses is what makes delivery idempotent end to end: the same
  // `eventId` must map to the same Tinybird row, so the order's id is the natural key.
  eventId: orderId,
  payload: { order_id: orderId, sku, quantity },
});
```

`eventId` must be nonblank and at most **256 UTF-8 bytes**. Oversized IDs are rejected with
`invalid_event_id`. Stored error messages are limited to **200 UTF-8 bytes**, including the
truncation ellipsis, with cuts only between complete Unicode code points.

Identity is `(datasource, eventId)` within one mount. An identical retained payload returns a
duplicate result without scheduling another delivery. A different payload under that identity
throws `identity_conflict`. Payloads are canonicalized and bounded: 64 KiB by default and
512 KiB maximum. Invalid JSON, identifiers, datasource names, and oversized payloads are rejected.

## The Tinybird side

The host owns datasource columns and query semantics. The component sends canonical payload
columns unchanged and does not enforce an `event_id` field. For the supplied generic schema,
the host must set `event_id` to the envelope's `eventId`.

The orders app above sends `order_id`, `sku`, and `quantity` to an `orders` datasource. It is a
separate portability example and does not match the supplied `events` datasource. Copy its
transaction pattern, then construct a payload matching your own Tinybird schema.

See the [Tinybird guide](./tinybird/README.md) for the generic datasource, bounded query, pinned
SDK equivalent, and Docker smoke test. Its `ReplacingMergeTree` table and `FINAL` query count
repeated deliveries once before background merges. Additive materialized views over raw
at-least-once data are unsafe; the guide describes a deduplicated-copy approach and its rebuild
requirements.

## Monitoring

Use `heartbeat` for frequent monitoring: it reads a bounded pair of records and reports pause
state and the age of the oldest pending event. Use `health` for an operator's bounded counts;
`capped: true` means the count is a lower bound. Neither result includes event payloads or credentials.

The example exposes both through an operator query:

<!-- example: example/convex/operations.ts -->

```ts
export const operatorHeartbeat = query({
  args: { datasource: v.optional(v.string()) },
  returns: v.object({ heartbeat: v.any(), health: v.any() }),
  handler: async (ctx, { datasource }) => ({
    heartbeat: await productEvents.heartbeat(ctx),
    health: await productEvents.health(ctx, { datasource }),
  }),
});
```

Alert on a paused mount, growing `oldestPendingAgeMs`, and failed events. Inspect `pausedReason`,
`lastDeliveredAt`, and the redacted failure information when investigating. Delivered events
are governed by retention rather than counted by `health`.

## Pausing and resuming

Authorize operators in the host before exposing these operations. The example wrappers are
unauthenticated demonstrations; a production host must establish the caller and pass its identity
as `actor`. The component records that string but does not authenticate it.

<!-- example: example/convex/operations.ts -->

```ts
export const operatorPause = mutation({
  args: { datasource: v.optional(v.string()), actor: v.string() },
  returns: v.any(),
  // A real host authorizes `actor` before this line.
  handler: async (ctx, { actor, datasource }) => productEvents.pause(ctx, { actor, datasource }),
});
```

After correcting a token or destination, resume the mount. This example processes at most ten
bounded batches per request and reports how much it scheduled. Repeat operator requests if a
larger backlog remains; do not remove the bound.

<!-- example: example/convex/operations.ts -->

```ts
export const operatorResume = mutation({
  args: { datasource: v.optional(v.string()), actor: v.string() },
  returns: v.object({ requeued: v.number() }),
  handler: async (ctx, { actor, datasource }) => {
    let requeued = 0;
    let pass = 0;
    do {
      const result = await productEvents.resume(ctx, { actor, datasource });
      requeued += result.requeued;
      if (result.requeued === 0) break;
      pass += 1;
    } while (pass < 10);
    return { requeued };
  },
});
```

Resume selects pending events without an active Workpool item. Events already waiting for a
retry keep their existing work and retry budget.

## Replaying dead letters

Fix the cause before replaying. This wrapper processes a bounded set of dead letters:

<!-- example: example/convex/operations.ts -->

```ts
export const operatorReplayFailed = mutation({
  args: {
    datasource: v.optional(v.string()),
    actor: v.string(),
    category: v.optional(vFailureCategory),
  },
  returns: v.object({ replayed: v.number() }),
  handler: async (ctx, { actor, category, datasource }) => {
    let replayed = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await productEvents.replayFailed(ctx, { actor, category, datasource });
      replayed += result.replayed;
      if (!result.remaining) break;
    }
    return { replayed };
  },
});
```

The wrapper imports `vFailureCategory` from `@fantastic-dev/convex-tinybird`. Pass an optional
`category`, such as `quarantined`, to replay only that failure category. The index selects matching
rows before applying the batch limit. `remaining` describes that category; omit the argument to
replay all dead letters. Both paths order by last update so repeated failures go to the back.

Replay defaults to **50 events** and accepts at most **100**, matching resume's 100-event
operator work ceiling. The smaller default leaves room for replay's extra attempt and error-history
updates. These are per-transaction work bounds, independent of payload size, rather than Convex's
hard document limits. Active delivery can still cause transaction conflicts: retry a failed operator
call with backoff or request a smaller `limit`. See [the measurements](docs/architecture.md#replay)
for the sizing rationale.

For an existing mount upgraded from a version without `lastErrorCategory`, backfill before using
filtered replay. Run this from the host's backend directory, replacing `productEvents` with the
mount name. It processes at most 100 rows per call without replaying events:

```bash
pnpm exec convex run --component productEvents migrations:backfillErrorCategories \
  '{"limit":100,"cursor":null}'
```

Pass the returned `continueCursor` as `cursor` on the next call and repeat until
`isDone` is true. Run it for each existing mount and deployment. Fresh mounts need no backfill.
Filtered replay throws `category_index_not_ready` if failed rows still lack the indexed category,
so an incomplete upgrade cannot look like an empty backlog. Unfiltered replay remains available.

For a single inspected event:

<!-- example: example/convex/operations.ts -->

```ts
export const operatorReplayEvent = mutation({
  args: { orderId: v.id("orders"), actor: v.string() },
  returns: v.any(),
  handler: async (ctx, { orderId, actor }) =>
    productEvents.replayEvent(ctx, { datasource: "orders", eventId: orderId, actor }),
});
```

Replay preserves the event identity and payload, resets the attempt count, and retains failure
history. `remaining` describes dead letters present now, so persistent failures can keep it true.
Use bounded operator requests and inspect health between them. A `payload_missing` event needs
an identical re-enqueue to restore its payload; replay cannot reconstruct missing data.

`pause`, `resume`, `health`, and `replayFailed` accept an optional `datasource`. For example,
pass `datasource: "clicks"` to repair that stream without replaying or resuming `orders`.
Replay can combine `datasource` and `category`; both predicates are indexed before batching.
Scoped health reports that datasource's counts, oldest pending age, delivery signals, and
scoped operator actions. `heartbeat` remains the cheap mount-wide monitor.

Omitting `datasource` keeps mount-wide controls. A global pause blocks every datasource, and a
scoped resume cannot override it. A global resume clears all pauses and resumes all datasources;
use a scoped resume to preserve another datasource's pause. Credential failures still pause the mount because its datasources share credentials.

Multiple datasources can share a mount. Use separate mounts for separate credentials, workpools,
or retention policies. Existing mounts need no pause-settings migration. Scoped delivery
metadata starts accumulating after upgrade; existing event counts and backlog ages are available
immediately.

## Maintenance and recovery

The host owns the maintenance schedule. Workpool owns ordinary retry scheduling; `requeueStuck`
recovers orphaned or expired work after crash boundaries. `cleanup` handles finished-event retention.
The example registers this cron:

<!-- example: example/convex/crons.ts -->

```ts
import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

// The host chooses the interval. Each invocation processes bounded maintenance pages.
const crons = cronJobs();

crons.daily("tinybird maintenance", { hourUTC: 4, minuteUTC: 0 }, internal.maintenance.maintain);

export default crons;
```

Its handler processes one recovery page and one cleanup page per stream per invocation:

<!-- example: example/convex/maintenance.ts -->

```ts
import { TinybirdDelivery } from "@fantastic-dev/convex-tinybird";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const streams = {
  productEvents: new TinybirdDelivery(components.productEvents),
  auditEvents: new TinybirdDelivery(components.auditEvents),
};

/**
 * One recovery page and one retention page per stream, per cron invocation.
 * Child mutations share this transaction's read budget, so do not loop over their pages.
 * Save unfinished recovery cursors: old but healthy work can occupy many consecutive pages.
 * Retention needs no cursor because each deleted row leaves its scan range.
 */
export const maintain = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const [name, stream] of Object.entries(streams)) {
      const checkpoint = await ctx.db
        .query("maintenanceCursors")
        .withIndex("by_stream", (q) => q.eq("stream", name))
        .unique();
      const result = await stream.requeueStuck(ctx, {
        actor: "example cron",
        cursor: checkpoint?.cursor ?? undefined,
      });
      const cursor = result.remaining ? result.cursor : null;
      if (checkpoint) {
        await ctx.db.patch(checkpoint._id, { cursor });
      } else {
        await ctx.db.insert("maintenanceCursors", { stream: name, cursor });
      }
      await stream.cleanup(ctx, { actor: "example cron" });
    }
    return null;
  },
});
```

The host's [`maintenanceCursors` table](./example/convex/schema.ts) persists unfinished recovery
cursors across invocations. A recovery cursor is a compound object with `delivering` and
`pending` positions; each position is null or an `{ updatedAt, creationTime }` pair. Pass it back
unchanged and reset it when `remaining` is false. Restarting every invocation at the first page
can strand work behind a long prefix of healthy jobs.

Child mutations share their parent transaction's read budget. Looping cleanup pages inside one
host mutation can exceed that budget and roll back every deletion. Separate cron invocations
provide separate transactions. Adjust the interval to the backlog and recovery latency your host
needs; the example's daily schedule is a starting configuration.

## Retention and dedupe window

By default, `cleanup` removes delivered events after seven days and failed events after thirty.
It preserves pending and delivering events regardless of age. Retention uses completion time,
and removes the event and associated payload together.

The retained event is the enqueue dedupe receipt. Once removed, the same identity can enqueue
and deliver again. Set retention for the producer's retry window and retain duplicate-safe
Tinybird reads for older repeats. Invalid negative or non-finite retention values are rejected.

Cleanup has one bounded budget across delivered and failed rows, with delivered rows first.
A sustained delivered backlog can delay failed-row cleanup; monitor maintenance progress and
choose an appropriate schedule. Each cleanup records its actor and deletion count.

`reclaimOrphanedPayloads` is a separate maintenance operation for payloads whose event is gone.
Its default limit is two and maximum is twenty. Large payloads require a conservative limit
because reads and deletes consume the transaction budget. Persist its cursor until `isDone`,
then reset for another pass. It records no operator actor, so the host must provide any required audit trail.

## Host responsibilities

- Authenticate and authorize operational mutations and analytics reads. The component has no
  user or tenant policy, and an `actor` string is not authorization.
- Validate domain events and allowlist payload fields. Exclude prompts, source code, message
  bodies, tool output, email addresses, secrets, and unchecked arbitrary metadata.
- Map tenant and project identity explicitly and enforce tenant filters server-side in query
  endpoints. Keep query and ingestion credentials out of browser bundles.
- Make event IDs unique across tenants sharing a mount and datasource, for example by including
  a tenant prefix or using a globally unique domain ID. A conflicting identity aborts the host mutation.
- Own Tinybird resources, duplicate-safe metric definitions, maintenance scheduling, retention,
  and alerting. Convex remains the operational and billing source of truth.

## Limitations

- One event per HTTP request; Workpool bounds parallel delivery to four.
- Retry uses configured backoff and does not schedule from `Retry-After`.
- No payload column validation, tenant model, dashboard queries, or browser client.
- No datasource-scoped operator controls within a shared mount.

## Testing against it

Import `register` from `@fantastic-dev/convex-tinybird/test` and register each named mount once.
The helper registers its nested Workpool too. The example uses transaction limits in its test harness:

<!-- example: example/convex/orders.test.ts -->

```ts
function setup() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  register(t, "productEvents");
  register(t, "auditEvents");
  return t;
}
```

Stub the component's `TINYBIRD_TOKEN` and HTTP transport in tests. `convex-test` does not evaluate
mount-time host environment mappings; `vi.stubEnv` is process-wide, so that harness cannot prove
per-mount credential values. The example tests cover delivery, rollback, identity conflicts,
replay, mount isolation, and bounded maintenance. Real mount configuration is also checked by codegen.

## Design and conventions

See [architecture.md](./docs/architecture.md) for the state machine, scheduling ownership,
transaction boundaries, and recovery behavior. Source-linked excerpts above are checked against
the example files; the README gate also verifies client methods, generated host references, and mount names.

## Checking it locally

One command runs the whole portability battery — typecheck, tests, the boundary scan, the
secrets scan, codegen freshness, every gate self-test, and the example app's own typecheck and
tests:

```bash
pnpm --filter @fantastic-dev/convex-tinybird run check
```

CI runs the same gates through `pnpm run check:scripts`, and needs no Tinybird credentials to do
it: the suites refuse network access outright (`vitest.setup.ts` installs a `fetch` that rejects
until a test stubs it), so there is nothing to authenticate against.

Three things it will fail on, each verified by deliberately breaking it:

| Break                                               | What fails                                          |
| --------------------------------------------------- | --------------------------------------------------- |
| Any difference in component or example `_generated` | `check-codegen-fresh.mjs`                           |
| An import outside `convex` and this component       | `check-boundary.mjs`, in `src` and `example/convex` |
| A test that calls `fetch` without stubbing it       | the suite, on `network disabled in tests`           |

Codegen freshness runs `CONVEX_AGENT_MODE=anonymous convex dev --once` in a temporary copy
of the example, then compares every generated file in the component and example. It detects
changed validators, missing files, and obsolete output without rewriting your checkout or using
your deployment credentials. Convex may download its local backend binary on the first run;
the delivery test suites themselves use stubbed HTTP transport. No Tinybird credentials are needed.
The temporary local deployment is removed when the check finishes.

## Package artifact

Workspace installation builds the package through `prepare`, so lint, tests and development commands can resolve exports on a fresh checkout. Run `pnpm --filter @fantastic-dev/convex-tinybird build` to rebuild ESM and TypeScript declarations in `dist` after source changes. Client, browser and component configuration exports use the compiled files. The `test` export retains its TypeScript source for Vitest's `import.meta.glob` transform, matching the Workpool test helper. Component source and installation documentation are included in the archive.

Run `pnpm --filter @fantastic-dev/convex-tinybird check:pack` to check npm's dry-run file list, reject unexpected files and host references, and resolve runtime exports from an extracted tarball. This maintainer gate requires Node, pnpm, npm, `tar` and a symlink-capable filesystem; run it on macOS or Linux, matching CI. It also runs in the repository's `check:scripts`. `npm pack` builds through `prepack`; this package remains private until its separately verified release. Test suites, fixtures, example apps and environment files are excluded.

The package is licensed under Apache-2.0. See [LICENSE](LICENSE) and [CHANGELOG.md](CHANGELOG.md).

## Adoption and upgrades

Follow [Adoption from a tarball](docs/adoption.md) to install in a separate app, mount the component, configure its environment and enqueue the first event. The package is still private; the guide uses a locally built archive until a release is published. Provision Tinybird separately for each app and environment using [Install in another app](docs/installing-in-another-app.md).

Run `pnpm run check:tinybird-consumer` from the repository root with its Node 24.19 toolchain, or run `bash scripts/clean-consumer.sh` from this package. It installs the archive and Convex as the only direct runtime dependencies of a temporary app outside the workspace. Development tools are installed separately. It runs anonymous local Convex setup, explicit codegen, typechecking and a test with stubbed delivery. The fixture uses a `tickets` table and its own `workspaceKey` tenancy field. It rejects unauthorized reads, uses no workspace aliases, and deletes the temporary app when finished. It needs registry and Convex binary-download access; no cloud credentials or Tinybird workspace are needed. CI runs this as a required job for package and installation changes.

After publication, releases follow semantic versioning: patch releases fix compatible behavior, minor releases add compatible capabilities, and major releases may change the API or event contract. During `0.x`, treat minor upgrades as potentially breaking and review the changelog. Pin the version adopted by your app, upgrade first in staging, and rerun its delivery/read tests. Regenerate the consumer's `_generated` bindings with `convex dev` after mounting or upgrading; do not copy another app's generated bindings or manually edit the package internals. Source checkout users rebuild after changes; archive users receive the compiled artifacts.
