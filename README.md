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
  refuses the credential, with `pause` and `resume` for operators, and replay of dead letters
  with an operator audit trail.
- **Not implemented yet:** retention cleanup, requeueing events stuck in delivery, and
  datasource-scoped operator controls.

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

## Replaying dead letters

An event that Tinybird refused, or that ran out of attempts, is kept rather than dropped. Once the
cause is fixed, replay puts it back in the queue:

```ts
// Bounded on purpose — see below. Ten passes at the default limit is 1000 events.
for (let pass = 0; pass < 10; pass += 1) {
  const { remaining } = await tinybird.replayFailed(ctx, { actor: userId });
  if (!remaining) break;
}

await tinybird.replayEvent(ctx, { datasource: "orders", eventId, actor: userId });
```

**`remaining` means "there are dead letters right now", not "there are ones you have not seen
yet".** If the cause is genuinely fixed the loop drains and stops. If it is not, replayed events
fail again, return to `failed`, and `remaining` stays true — so an unbounded `while (remaining)`
loop would hammer a broken destination forever. Bound the loop and check `health` before running
it again.

Replay walks the dead letters by when they last changed, not by when they were created, so an
event that is replayed and fails again goes to the back of the queue. Every dead letter is tried
once before any is tried twice. Without that, a still-broken destination means the oldest few
events are replayed over and over while everything behind them is never reached at all.

**The operator controls are mount-wide.** `enqueue` and `getStatus` take a datasource, but
`pause`, `resume`, `health` and `replayFailed` do not, so a mount carrying more than one
datasource cannot act on them independently — replaying to fix one datasource resends the
other's dead letters too. Mount the component once per datasource.

**The default batch is 20, and it is sized from bytes.** Convex returns whole documents and caps
a call near 8 MiB, and an event row carries its payload. A batch of `n` costs `3n + 1` passes over
a row: replay reads `n + 1`, scheduling re-reads `n` to confirm each is still pending, and the
patch writes `n`. So budget `4 x (maxPayloadBytes + 2 KB)` per row — three passes plus margin,
because the 2 KB of per-row overhead is an estimate and `previousErrors` grows with every replay
cycle:

| your `maxPayloadBytes` | recommended `limit`           |
| ---------------------- | ----------------------------- |
| 1 KiB                  | the ceiling of 30 binds first |
| 64 KiB (the default)   | 30                            |
| 512 KiB (the maximum)  | 3                             |

The default of 20 uses 49% of the budget at the default bound, and the ceiling of 30 uses 73%.
The ceiling protects a host that has not thought about bytes; it is not a promise for a host that
raised `maxPayloadBytes`. If you did, pass your own `limit` from the table. Exceeding the real
limit does not degrade: the call throws.

**Replay is not re-enqueue.** The identity and the payload are the ones the host committed, so a
later matching enqueue is still a duplicate and a mismatched one is still a conflict. The attempt
count resets because the budget is being granted again; the failure history does not, because "why
did this die" is the question you have after a replay.

Replay takes the least recently changed dead letters first and has no category filter. Replaying is what moves the
scan forward, so a filter would leave the rows it skipped parked at the front of the window and
make every dead letter behind them unreachable while the call still reported that nothing remained.
To replay a specific event, use `replayEvent`.

Replaying while paused stores the events without sending them, which is usually what you want: fix
the credential, then resume.

`pause`, `resume` and both replays record who acted. The component authenticates nobody, so wrap them in host
mutations that authorize the caller.
