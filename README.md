# @fantastic-dev/convex-tinybird

A reusable Convex component for delivering analytics events to Tinybird. Enqueue runs in the
host mutation's transaction, so domain writes and the event commit or roll back together.
Delivery uses Workpool with bounded retries and one event per request.

Delivery is **at least once**. A lost acknowledgement can cause a repeated request; Tinybird
queries must handle those repeats. The component's enqueue identity checks do not provide
exactly-once ingestion or make raw additive aggregates safe.

## Install and mount

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
Component code reads the generated `env` export. Credentials are not stored in component tables,
returned by public functions, or logged.

| Variable         | Use                                      | When absent                                  |
| ---------------- | ---------------------------------------- | -------------------------------------------- |
| `TINYBIRD_TOKEN` | Server-side datasource append credential | Enqueue stores events, but delivery is inert |
| `TINYBIRD_HOST`  | Regional API origin                      | Uses the component's default Tinybird origin |

Use a bare HTTPS origin without a path, query, fragment, or embedded credentials. Loopback HTTP
is supported for Tinybird Local. Invalid destinations and authentication failures pause the
mount and appear in its health result.

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
  args: {},
  returns: v.object({ heartbeat: v.any(), health: v.any() }),
  handler: async (ctx) => ({
    heartbeat: await productEvents.heartbeat(ctx),
    health: await productEvents.health(ctx),
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
  args: { actor: v.string() },
  returns: v.any(),
  // A real host authorizes `actor` before this line.
  handler: async (ctx, { actor }) => productEvents.pause(ctx, { actor }),
});
```

After correcting a token or destination, resume the mount. This example processes at most ten
bounded batches per request and reports how much it scheduled. Repeat operator requests if a
larger backlog remains; do not remove the bound.

<!-- example: example/convex/operations.ts -->

```ts
export const operatorResume = mutation({
  args: { actor: v.string() },
  returns: v.object({ requeued: v.number() }),
  handler: async (ctx, { actor }) => {
    let requeued = 0;
    let pass = 0;
    do {
      const result = await productEvents.resume(ctx, { actor });
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
  args: { actor: v.string() },
  returns: v.object({ replayed: v.number() }),
  handler: async (ctx, { actor }) => {
    let replayed = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await productEvents.replayFailed(ctx, { actor });
      replayed += result.replayed;
      if (!result.remaining) break;
    }
    return { replayed };
  },
});
```

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

Operator controls are mount-wide. `enqueue` and `status` accept a datasource, but pause, resume,
health, and bulk replay affect the whole mount. Use separate mounts when streams need separate controls.

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
