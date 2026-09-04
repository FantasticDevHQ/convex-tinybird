# The Tinybird side of the contract

Host-owned material, not component runtime code. The component sends a row **verbatim** and
requires exactly one thing of the schema: `event_id` must equal the envelope's `eventId`.
Everything else here is a choice a consumer can change.

## Why the engine is part of the contract

The component delivers **at least once**. An event Tinybird accepted whose acknowledgement never
reached the sender is indistinguishable from one never sent, so it is sent again — deliberately,
because the alternative loses events rather than duplicating them.

That makes duplicate handling Tinybird's job. `ReplacingMergeTree` sorted by `event_id` collapses
repeats, and `version` decides which copy wins when the same id arrives with different contents,
so a corrected re-send supersedes the original rather than racing it.

## Dedupe happens at merge and read time, never on ingest

This is the part that surprises people, so it is worth being blunt: **ingest does not
deduplicate.** Three identical deliveries write three rows. They collapse when background merges
run, on ClickHouse's schedule, which is why `events_by_type.pipe` says `FROM events FINAL` —
`FINAL` resolves duplicates at query time instead of waiting.

Measured on Tinybird Local via `smoke.sh`, one event sent three times:

```
sent 3, raw rows 2, pipe counted 1
PASS: duplicates stored (2 raw rows) and counted once by the pipe
```

The raw count is the control. Two rows physically present while the pipe returns one is what
proves `FINAL` is doing the work; if merges had already collapsed everything, the pipe would
return 1 regardless and the run would prove nothing. The script reports that case as
INCONCLUSIVE rather than passing.

## Why additive materialized views are unsafe here

A materialized view on the raw table sees **every insert**, including the duplicates, and it sees
them once — at insert time, before any merge. So a view doing `sumState` or `count` over
at-least-once data over-counts permanently, and no later merge repairs it: the duplicate was
already folded into the aggregate.

This is not a tuning problem. It is the reason the pipe reads with `FINAL` instead of being
backed by a view.

**The upgrade path**, when `FINAL` becomes too expensive:

1. A **copy pipe** on a schedule reads `events FINAL` for a window and writes into a
   deduplicated table.
2. Materialized views hang off _that_ table, where every row is already unique.
3. Queries read the views. `FINAL` is then paid once per window rather than once per query.

The cost is freshness: the deduplicated table lags by the copy interval.

## Using the TypeScript SDK

Consumers who prefer to define these in code rather than as files can use
[`@tinybirdco/sdk`](https://www.tinybird.co/docs). **Server-side only** — it holds an admin-scoped
token and must never reach a browser.

```ts
import { defineDatasource, defineEndpoint } from "@tinybirdco/sdk";

export const events = defineDatasource({
  name: "events",
  schema: {
    event_id: "String",
    event_type: "LowCardinality(String)",
    occurred_at: "DateTime64(3, 'UTC')",
    received_at: "DateTime64(3, 'UTC')",
    version: "UInt32",
    payload: "String",
  },
  engine: {
    type: "ReplacingMergeTree",
    ver: "version",
    sortingKey: "event_id",
    partitionKey: "toYYYYMM(occurred_at)",
  },
});

export const eventsByType = defineEndpoint({
  name: "events_by_type",
  // `FINAL` for the same reason as the .pipe file — the SDK changes the authoring surface,
  // not the semantics.
  sql: `SELECT event_type, count() AS events FROM events FINAL
        WHERE occurred_at >= {{DateTime64(start)}} AND occurred_at < {{DateTime64(end)}}
        GROUP BY event_type ORDER BY events DESC LIMIT {{Int32(limit, 100)}}`,
});
```

## Running the smoke test

Needs Docker; not run in CI.

```bash
./tinybird/smoke.sh
```

It starts Tinybird Local, deploys, sends one event three times and asserts the pipe counts it
once **and** that duplicates were physically stored. Use `tb deploy`, not `tb build` — a build is
ephemeral and the workspace's endpoints cannot see it, which presents as a 404 on ingest rather
than as the wrong verb.
