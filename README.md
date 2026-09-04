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
  with an operator audit trail, and bounded retention cleanup.
- **Not implemented yet:** requeueing events stuck in delivery, and datasource-scoped
  operator controls.

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

Identity is `(datasource, eventId)`. `enqueue` returns one of three outcomes, and a fourth
possibility is a throw:

| outcome     | meaning                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `enqueued`  | a new event, now queued                                                                     |
| `duplicate` | the same identity with an equivalent payload (any key order); nothing changed               |
| `repaired`  | the event existed but its payload row did not, and this call restored it                    |
| _throws_    | `ConvexError` with `code: "identity_conflict"` — the same identity with a different payload |

`repaired` is rare and worth surfacing rather than folding into `enqueued`: seeing it means
something had previously deleted one of the two rows without the other. With the payload itself
gone there is nothing to compare it against, so the check falls back to the byte length and
content fingerprint kept on the event row — enough to catch an accidental substitution, not a
deliberate one. See "Replaying dead letters" below.

Payloads must be JSON objects under 64 KiB (configurable up to 512 KiB).

## Monitoring

`health` is the operator view. Each state is counted through an index and stops at a cap, so the
query reads at most 151 rows per state — the cap plus one, which is how it knows there are more — and never scans the table. A capped count reports
`capped: true` rather than an exact number, because "more than 150 waiting" is the answer
an operator acts on.

**Know the real cost before you rely on it.** Convex reads whole documents and allows about 8 MiB
per function call, so what matters is rows multiplied by row size. The cap bounds the rows, and
since the payload moved to its own table an event row no longer depends on your event size at all —
so **event size no longer affects `health` at all**. Before that split it did: a call failed at
roughly 130 unfinished events at the default 64 KiB payload bound, which is the query whose whole
purpose was to stay cheap failing on exactly the backlog it exists to report.

What is left is the cap itself, and it is sized from a measured row rather than an estimated one.
The largest event the contract permits is about 5.4 KB — every string at its maximum, a full
failure history, and those strings filled with the costliest characters the caps admit, because
the caps count UTF-16 units while storage counts UTF-8 bytes. `health` counts three states and
reads one row past the cap in each, plus two more for the heartbeat it embeds, so a full call is `(3 x 151 + 2) x 5.4 KB`, roughly 2.3 MiB of the 8. A cap of 1000 would have been 15.5 MiB — nearly twice the budget — on exactly the day you need the
query.

**Alert on `heartbeat`, not on `health`.** It reads exactly two documents however much is queued,
returns `paused` and `oldestPendingAgeMs`, and costs the same on your worst day as on your best.
`health` is for a person asking a question, not for a monitor asking every minute — and you no
longer have to know your events are small to reach for it.

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

## Retention

Finished events are kept for a while and then removed. `cleanup` deletes `delivered` rows past
seven days and `failed` rows past thirty, in bounded batches, and never touches an event that is
still `pending` or `delivering` however old it is — age is not a reason to discard work nobody
has finished.

The component owns no cron. Schedule it from yours:

```ts
// convex/crons.ts
crons.daily("tinybird retention", { hourUTC: 4, minuteUTC: 0 }, internal.tinybird.sweep);

// convex/tinybird.ts
export const sweep = internalMutation({
  handler: async (ctx) => {
    // Bounded, like every loop against this component. The limit is spent ONCE across both
    // states, so ten passes is at most 2000 rows in total — not per state. Large payloads
    // reach the sweep's byte budget first and each pass returns fewer.
    for (let pass = 0; pass < 10; pass += 1) {
      const { remaining } = await tinybird.cleanup(ctx, { actor: "nightly cron" });
      if (!remaining) break;
    }
  },
});
```

**The dedupe window IS the delivered retention.** Identity is `(datasource, eventId)`, and a
delivered row is what makes a repeat enqueue a `duplicate`. Once retention removes that row the
same identity is a new event again and will be sent a second time. Seven days is the default
because that is a long time to be retrying something; if your producer can re-emit an event
older than that, either raise `deliveredRetentionMs` or rely on Tinybird-side dedupe by
`event_id`, which is what the example datasource's `ReplacingMergeTree` is for.

`failed` rows are kept longer, at thirty days, for a different reason: a delivered row only
answers "have I sent this", while a dead letter is something an operator may still act on, and
the window to notice one is measured in weeks.

Deleting an event deletes its payload row in the same transaction, so the two cannot part
company. Retention measures age from when an event **finished**, not from when it was created —
an event that sat pending through a long pause and was delivered a moment ago keeps its full
window, which matters because those are exactly the events a producer is most likely to re-emit.

A retention that is negative, `NaN` or infinite is refused with `code: "invalid_retention"`
rather than clamped. `NaN` is the reason: Convex orders it above every finite number, so a sweep
given one would match every row of that state and delete events seconds old.

Each sweep records itself in `lastOperatorAction` with the `actor` you pass and how many rows
it removed, so a sweep that stops running is visible rather than showing up only as tables that
quietly grow.

One budget is spent across both states, delivered first. A large delivered backlog therefore
delays the failed sweep by a few passes rather than starving it — the loop above drains both, but
if you care about dead letters promptly, call `cleanup` with a `failedRetentionMs` of your own on
its own schedule.

`reclaimOrphanedPayloads` is a separate, rarer call for payload rows whose event has gone.
Nothing here produces one — but finding them means reading payloads, and a payload is the one
thing whose size you control, so folding that scan into the frequent sweep would make retention's
cost depend on your event size again.

Carry `cursor` forward until `isDone`. It is a number rather than an opaque token, because `.paginate()` is only supported in the app and never inside a component; treat it as opaque anyway and pass back exactly what you were given. Without that it would rescan the same
first page forever, because healthy rows are never deleted and so occupy it permanently. The
The default `limit` is 2, sized for the largest payload the component allows, and you may raise
it to at most **20** — anything higher is clamped to 20 rather than honoured.

Twenty is what the default 64 KiB payload bound affords. If your payloads are much smaller the
read budget would allow far more — around 440 at 1 KiB — but the ceiling does not, and that is
deliberate rather than an oversight: unlike `cleanup`, this scan cannot budget by bytes, because
it learns a payload's size by reading it and has therefore already paid. A row count is the only
bound available, and one fixed number cannot be both safe at 512 KiB and generous at 1 KiB.

So if a reclaim pass is too slow for your table, the ceiling is the thing to revisit — not the
`limit` you pass, which cannot go above it.

The scan is eventually consistent per **pass**, not per call: a row inserted behind a scan that
has already gone past it is found on the next pass, because `isDone` resets the cursor. At the
default limit that pass can be long — 100 000 payload rows at a limit of 2 is 50 000 calls — so
size `limit` for how quickly you want a leak found, not only for what one call can afford.

The numbers are low because reclaiming an orphan pays for its payload **twice** — once to page
it in, and again when `ctx.db.delete` re-reads the document it deletes. If you raise
`maxPayloadBytes`, lower this limit to match: nothing can do it for you, since the scan never
sees that option.

## Replaying dead letters

An event that Tinybird refused, or that ran out of attempts, is kept rather than dropped. Once the
cause is fixed, replay puts it back in the queue:

```ts
// Bounded on purpose — see below. Ten passes at the default limit of 20 is 200 events.
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

**One dead letter cannot be replayed away.** `payload_missing` means the event has no stored
payload, so there is nothing to send and delivery will find nothing again however many times you
replay it. Enqueue the same event a second time instead: `enqueue` restores the missing row and
returns `repaired`. Anything else with that identity is a conflict, checked against the byte
length and content fingerprint the event row kept — enough to catch an accidental substitution,
not a deliberate one.

**The operator controls are mount-wide.** `enqueue` and `getStatus` take a datasource, but
`pause`, `resume`, `health` and `replayFailed` do not, so a mount carrying more than one
datasource cannot act on them independently — replaying to fix one datasource resends the
other's dead letters too. Mount the component once per datasource.

**The default batch is 20, and the ceiling is 30.** Both were sized from bytes when the payload
still lived on the event row, where a batch of 100 cost roughly 19 MiB against Convex's ~8 MiB
per-call limit. The payload now lives in its own table, so an event row costs the same whatever
your events carry and the same batch costs well under a megabyte.

So payload size and batch size are independent: raising `maxPayloadBytes` no longer means
lowering `limit`. The values above are now conservative rather than binding, and they are left
alone on purpose — raising them is a behaviour change that deserves its own tests.

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
