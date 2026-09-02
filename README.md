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
  `getStatus`, and the `health` query.
- **Not implemented yet:** delivery to the Events API, retries, pausing, replay and retention.
  Nothing is sent to Tinybird yet; enqueued events accumulate as `pending`.

Until delivery exists the component is inert by design: it schedules nothing and makes no
outbound request, and with no `TINYBIRD_TOKEN` it reports itself unconfigured.

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
