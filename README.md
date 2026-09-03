# @fantastic-dev/convex-tinybird

A Convex component for shipping analytics events to [Tinybird](https://www.tinybird.co). The
intended shape: a host mutation enqueues an event in the same transaction as its own writes, and
the component delivers it at least once, deduped by the event's identity. Project-agnostic by
construction: it depends on `convex` only (and `@convex-dev/workpool` once delivery lands), never
on the host's schema or auth.

## Status

This package is being built in layers, and this README describes only what is actually present.

- **Implemented:** component mount and declared configuration, the `events`/`settings` schema, the
  public contract types and validators, transactional `enqueue` with canonical payload identity,
  `getStatus`, the `health` query, delivery of one event per request to the Events API, retrying
  a transient failure until the budget is spent, and pausing the destination when Tinybird
  refuses the credential, with `pause` and `resume` for operators.
- **Not implemented yet:** operator replay of dead letters and retention cleanup.

`TINYBIRD_HOST` is validated before any request: it must be a bare `https` origin with no path,
query, fragment or embedded credentials, the one exception being a loopback address for Tinybird
Local. A host that fails validation pauses the destination rather than failing events, because the
rows are fine and the configuration is not.

With no `TINYBIRD_TOKEN` the component is inert by design: enqueue still stores events, nothing
is scheduled, and no request leaves the deployment.

Design and conventions: [`docs/architecture.md`](./docs/architecture.md) — state machine, transaction
boundaries, dedupe window, scheduling ownership. `node scripts/check-boundary.mjs` proves the package
imports nothing from the host. The full consumer guide lands with the example app.

## Enqueue from a host mutation

```ts
import { TinybirdDelivery } from "@fantastic-dev/convex-tinybird";
import { components } from "./_generated/api";

const tinybird = new TinybirdDelivery(components.tinybird);

export const createOrder = mutation({
  args: { total: v.number() },
  returns: v.id("orders"),
  handler: async (ctx, { total }) => {
    const orderId = await ctx.db.insert("orders", { total });
    // Same transaction as the insert: if this mutation throws, neither write survives.
    await tinybird.enqueue(ctx, {
      datasource: "orders",
      eventId: `order_created:${orderId}`,
      payload: { event_id: `order_created:${orderId}`, total },
    });
    return orderId;
  },
});
```

Identity is `(datasource, eventId)`. Re-enqueueing the same identity with an equivalent payload
(any key order) returns `outcome: "duplicate"`; a different payload throws `ConvexError` with
`code: "identity_conflict"`. Payloads must be JSON objects under 64 KiB (configurable up to 512 KiB).

## Monitoring

`health` is the operator view. Each state is counted through an index and stops at a cap, so the
query reads at most a thousand rows per state and never scans the table. A capped count reports
`capped: true` rather than an exact number, because "more than a thousand waiting" is the answer
an operator acts on.

**Know the real cost before you rely on it.** The cap bounds _rows_, and Convex reads whole
documents, so the bytes read are the row count multiplied by your event size. Convex allows about
8 MiB per function call. With small events, a few hundred bytes each, the full cap is well inside
that. With events near this component's default 64 KiB bound, the limit is reached at roughly a
hundred unfinished events and `health` fails rather than reporting a large number, which is
exactly when you need it.

**So alert on `heartbeat`, not on `health`.** It returns everything below except the counts, and
reads exactly two documents no matter how much is queued or how large your events are, which is
what keeps it working on the day `health` cannot. Reach for `health` when you want the numbers and
know your events are small.

```ts
const beat = await tinybird.heartbeat(ctx); // cheap, always available
const health = await tinybird.health(ctx); // adds counts, costs more
```

What to alert on:

- **`paused`**, in both — nothing is being delivered. `pausedReason` says whether the credential was
  refused or the host is misconfigured, both of which need a person.
- **`counts.failed.count > 0`**, `health` only — events Tinybird will not accept as they stand. They are kept,
  and each one records why in `lastError` and its failure history.
- **`oldestPendingAgeMs`**, in both, above whatever your latency budget is — a backlog that is growing shows
  up in the counts, but a backlog that is _stuck_ shows up here and nowhere else.

Delivered events are not counted. Retention bounds them rather than this query, and
`lastDeliveredAt` answers "is anything getting through" without paying for the count.

Neither query ever returns a payload, a host or a credential, and every error it surfaces is
truncated and redacted.

## Pausing and resuming

A `401` or `403` means the token is wrong, and no number of retries fixes that. Instead of
spending an event's retry budget the component pauses the destination: the event stays `pending`,
nothing further is sent, and `health` reports `paused: true` with the reason. Events enqueued
while paused are stored and left alone.

Once the token is fixed, `resume` clears the pause and puts waiting events back to work a bounded
batch at a time, because a paused destination can accumulate an arbitrary backlog and one
transaction cannot re-enqueue all of it. Call it until it reports nothing left:

```ts
let requeued = 0;
do {
  ({ requeued } = await tinybird.resume(ctx, { actor: userId }));
} while (requeued > 0);
```

`resume` only picks up events the delivery pool is not already working on. An event that is
`pending` between two retry attempts needs no operator, and queueing a second work item for it
would give it a second retry budget and let it be sent more times than its policy allows. That is
also what makes the loop above terminate: each call schedules what it picks up, so the next call
finds nothing left to do.

`pause` and `resume` record who acted. The component authenticates nobody, so wrap them in host
mutations that authorize the caller.
