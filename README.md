# @fantastic-dev/convex-tinybird

## What it does

A Convex component that ships analytics events to [Tinybird](https://www.tinybird.co). A host
mutation enqueues an event **in the same transaction as its own writes**, so the event commits or
rolls back with them and there is no window in which the row exists and the event does not.

Delivery is **at least once**, one event per request, deduplicated by the event's identity. An
event Tinybird accepted whose acknowledgement never reached us is indistinguishable from one
never sent, so it is sent again; deduplication is Tinybird's, on `event_id`. The alternative is
at-most-once, which loses events rather than duplicating them.

Project-agnostic by construction: it depends on `convex` and `@convex-dev/workpool`, and never on
the host's schema, auth or packages. `node scripts/check-boundary.mjs` enforces that.

## Install and mount

Today it is a workspace package; it will be published to npm (FTD-2491).

```ts
// convex/convex.config.ts
import tinybird from "@fantastic-dev/convex-tinybird/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();

app.use(tinybird, {
  name: "productEvents",
  env: {
    TINYBIRD_TOKEN: process.env.PRODUCT_TINYBIRD_TOKEN,
    TINYBIRD_HOST: process.env.PRODUCT_TINYBIRD_HOST,
  },
});

export default app;
```

Mount it more than once if you have more than one stream. Each mount gets its own tables, its own
settings row, its own Workpool and its own credentials — pausing one does not pause another. The
[example app](./example) mounts two and tests exactly that.

## Environment

Both variables are declared by the component and supplied by the host at mount time. Component
code reads them only through the generated `env` export; they are never stored in a table,
returned by a function, or logged.

| Variable         | Scope                                                          | Absent                                                                                                          |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `TINYBIRD_TOKEN` | `DATASOURCE:APPEND`                                            | The component is **inert**: enqueue still stores events, nothing is scheduled, no request leaves the deployment |
| `TINYBIRD_HOST`  | Regional API base, e.g. `https://api.eu-central-1.tinybird.co` | The default host                                                                                                |

`TINYBIRD_HOST` is validated before any request: a bare `https` origin with no path, query,
fragment or embedded credentials. The one exception is a loopback address, so Tinybird Local
works. A host that fails validation **pauses the destination** rather than failing events — the
rows are fine and the configuration is not.

## Enqueue from a host mutation

Lifted from [`example/convex/orders.ts`](./example/convex/orders.ts), which is compiled and
tested — a sample that only lives in a README rots.

```ts
import { TinybirdDelivery } from "@fantastic-dev/convex-tinybird";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

const productEvents = new TinybirdDelivery(components.productEvents);

export const place = mutation({
  args: { sku: v.string(), quantity: v.number() },
  returns: v.null(),
  handler: async (ctx, { sku, quantity }) => {
    const orderId = await ctx.db.insert("orders", { sku, quantity, placedAt: Date.now() });

    await productEvents.enqueue(ctx, {
      datasource: "orders",
      // The identity you choose is what makes delivery idempotent end to end: the same
      // `eventId` must map to the same Tinybird row, so the row's own id is the natural key.
      eventId: orderId,
      payload: { order_id: orderId, sku, quantity },
    });

    return null;
  },
});
```

**Identity.** `datasource` plus `eventId` is the identity. Re-enqueuing the same identity with an
identical payload is accepted and does not send twice; with a _different_ payload it is rejected
as `identity_conflict` rather than silently overwriting.

**Bounds and errors.** The payload is canonicalised (sorted keys, no whitespace) and bounded —
64 KiB by default, 512 KiB hard maximum. Invalid input throws a `ConvexError` with a documented
`code` **before any write**: `invalid_datasource`, `invalid_event_id`, `payload_too_large`,
`identity_conflict`.

## The Tinybird side

The component sends the row verbatim and requires exactly one thing of your schema: `event_id`
must equal the envelope's `eventId`. Everything else is yours.

Because delivery is at least once, the engine is part of the contract:
[`tinybird/README.md`](./tinybird/README.md) explains why the datasource is a
`ReplacingMergeTree`, why the pipe reads with `FINAL`, why additive materialized views over
at-least-once data over-count permanently, and the copy-pipe upgrade path when `FINAL` gets
expensive. A ready-to-deploy [datasource](./tinybird/datasources/events.datasource) and
[pipe](./tinybird/pipes/events_by_type.pipe) are there, with a Docker smoke test that proves
three identical deliveries count once.

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

**The operator controls are mount-wide.** `enqueue` and `status` take a datasource, but
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
    // Rescue first, sweep second. A row that has stopped moving is returned to `pending`
    // and is outside retention either way, so the ordering costs nothing — but the reverse
    // leaves a stuck row unexamined for a whole interval.
    // `cursor` must be carried, not discarded. Every call without it restarts at the head of
    // the scan, and a page of work that is old but still healthy sits there permanently —
    // those rows are skipped rather than patched, so their age never moves. A loop that drops
    // the cursor makes no progress at all in the condition this function exists for.
    let cursor;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await tinybird.requeueStuck(ctx, { actor: "nightly cron", cursor });
      cursor = result.cursor;
      if (!result.remaining) break;
    }

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

## Host responsibilities

The component deliberately does not do these, and will not start.

**Authorization.** It authenticates nobody. `pause`, `resume`, `replayFailed`, `replayEvent`,
`requeueStuck` and `cleanup` are destructive or operationally significant, and every one of them
takes an opaque `actor` string that is recorded and never checked. Authorize the caller yourself
before invoking any of them — a `getUserIdentity` inside the component would be it making a
policy decision on your behalf, which is why the boundary script forbids it outright.

**Privacy of payload fields.** The payload is sent verbatim and stored until retention removes
it. Nothing redacts, hashes or classifies it. If a field must not reach Tinybird, do not enqueue
it.

**Tenant scoping.** The component has no notion of a tenant. Events from every tenant land in one
stream unless you mount an instance per tenant or put the tenant in the payload and filter at
read time. Neither is done for you, and an analytics dashboard that forgets it will show one
customer another's data.

**Scheduling.** The component owns no cron. Without the maintenance job above, a delivery whose
process died is never retried and delivered rows are never removed.

## Limitations

- **No batching.** One event is one request. That is what keeps identity and retry per-event; it
  also means a burst is a burst of requests, bounded by the pool's parallelism of 4.
- **No `Retry-After` scheduling.** A rate-limited response is retried on the configured backoff,
  not on the server's hint.
- **Not usable from a browser.** The append token is server-side only, and the component runs
  inside Convex.
- **No schema enforcement.** The component never inspects your payload beyond size and canonical
  form; a column mismatch surfaces as Tinybird quarantining rows.

## Testing against it

Register each mounted instance once in `convex-test`. The helper also registers that instance's
nested Workpool, without which the first enqueue fails the moment it schedules work.

```ts
import { register } from "@fantastic-dev/convex-tinybird/test";
import { convexTest } from "convex-test";

const t = convexTest(schema, modules);
register(t, "productEvents");
register(t, "auditEvents");
```

Two things that will otherwise cost you an afternoon, both learned building the example:

- `convex-test` never evaluates the mount-time `env` mapping, so stub the component's own
  `TINYBIRD_TOKEN`, not your host-side variable names. Stubbing the host names configures
  nothing and every delivery silently does not happen.
- `vi.stubEnv` is process-wide, so per-instance credentials are not expressible in that harness.

The [example app](./example) is a complete worked case: two mounts, transactional rollback,
identity conflict, replay, and the maintenance job.

## Design and conventions

[`docs/architecture.md`](./docs/architecture.md) — the state machine, transaction boundaries, the
dedupe window, scheduling ownership, what the test suite cannot tell you, and the crash paths
`requeueStuck` recovers.

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

