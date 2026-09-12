# Generic Tinybird example

For a new consuming app, follow [Tinybird setup](../docs/tinybird-setup.md)
first. It covers workspace provisioning, schema deployment, append and deployment tokens, and
per-environment Convex configuration. This directory provides reference resources to copy into
the host's infrastructure project; it does not configure a cloud workspace when the package is installed.

These resources belong to the host application. The component sends the host's payload as
canonical NDJSON and does not inspect its column names. For this reference schema, the host
sets `event_id` equal to the enqueue envelope's `eventId`. Other consumers can choose a different
schema; the orders app in `../example` uses an `orders` datasource and different columns.

## Duplicate-safe reads

Delivery is at least once: an accepted request can be retried when its acknowledgement is lost.
Tinybird initially stores each delivery. `ReplacingMergeTree`, ordered by `event_id`, removes
repeated identities during background merges. The pipe reads `events FINAL` so each identity
contributes once even before those merges run.

Keep `occurred_at` stable for an identity so repeats stay in the same monthly partition. `version`
selects the newest stored revision; equal-version retries must contain the same fact. The
component rejects a changed payload for a retained `(datasource, eventId)` with `identity_conflict`,
so setting a higher Tinybird version does not bypass the component's identity checks.

The pipe accepts `start` and `end` with default bounds of 2000–2100. Its default result limit is
100 event types, clamped to 1–1000. Hosts should select a narrower time window for their workload.

## Materialized views

An additive materialized view over the raw table sees every insert, including retries. A later
replacement merge cannot subtract duplicates already included in `count` or `sumState`.
Do not use those raw additive aggregates for totals from this stream.

For larger workloads, a host can use a scheduled copy pipe to populate a deduplicated table,
then build materialized views from that table. The copy must replace its covered partitions or
otherwise guarantee that each fact enters the aggregate once. Appending overlapping copy
windows would reintroduce double counting. Corrections require an explicit rebuild or retraction
strategy. Validate that pipeline separately; this example implements read-time deduplication only.

## TypeScript SDK equivalent

The following resource definitions match the datafiles and compile against
`@tinybirdco/sdk@0.0.82`. Pin that exact version when using this example. The SDK is server-side
infrastructure tooling and is not a dependency of the Convex component. Keep deployment tokens
out of browser bundles. See the [SDK resource reference](https://www.tinybird.co/docs/forward/dev-reference/typescript-sdk-resources).

```ts
import { defineDatasource, defineEndpoint, defineToken, engine, node, t, p } from "@tinybirdco/sdk";

export const events = defineDatasource("events", {
  schema: {
    event_id: t.string(),
    event_type: t.string().lowCardinality(),
    occurred_at: t.dateTime64(3, "UTC"),
    received_at: t.dateTime64(3, "UTC").defaultExpr("now64(3)"),
    version: t.uint32().default(1),
    payload: t.string(),
  },
  engine: engine.replacingMergeTree({
    ver: "version",
    sortingKey: ["event_id"],
    partitionKey: "toYYYYMM(occurred_at)",
  }),
});

export const eventsRead = defineToken("events_read");

export const eventsByType = defineEndpoint("events_by_type", {
  tokens: [{ token: eventsRead, scope: "READ" }],
  params: {
    start: p.dateTime64().optional("2000-01-01 00:00:00.000"),
    end: p.dateTime64().optional("2100-01-01 00:00:00.000"),
    limit: p.int32().optional(100),
  },
  nodes: [
    node({
      name: "counts",
      sql: `SELECT event_type, count() AS events FROM events FINAL
            WHERE occurred_at >= {{DateTime64(start, '2000-01-01 00:00:00.000')}}
              AND occurred_at < {{DateTime64(end, '2100-01-01 00:00:00.000')}}
            GROUP BY event_type ORDER BY events DESC, event_type ASC
            LIMIT least(greatest({{Int32(limit, 100)}}, 1), 1000)`,
    }),
  ],
  output: { event_type: t.string(), events: t.uint64() },
});
```

TypeScript checks the SDK definitions; Tinybird checks the SQL when deploying. Revalidate both
when changing this snippet or the datafiles.

## Local smoke test

Install Docker and the `tb` CLI, then run from the component directory:

```bash
./tinybird/smoke.sh
```

The script creates a disposable Tinybird Local container on port 7181 and runs `tb deploy`.
It sends `fixtures/event.ndjson` three times and requires both three raw rows and a pipe count of
one. If background merges win the race, the test reports INCONCLUSIVE and fails so it cannot
claim to have exercised `FINAL` without physical duplicates. It then inserts 1001 more event
types and checks default, excessive, zero, negative, and single-row limits. The container is
removed on exit. No cloud credentials are needed.

The Vitest datasource test enqueues the same fixture through the component, captures delivery,
and checks its canonical NDJSON against the datasource columns. This links the serialization
check to the sample ingested by the smoke test.
