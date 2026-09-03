# Architecture

The design in prose. The Linear project document "Architecture and conventions" is the planning
source; this file is what ships with the package and must stay true to the code next to it.

## What the component does

A host mutation calls `enqueue` with a datasource name, an event identity and a JSON payload. The
event row is written in the same Convex transaction as the host's own writes, so the two commit
or roll back together. Delivery to the Tinybird Events API happens afterwards, asynchronously,
through a nested Workpool, at least once. Tinybird is expected to dedupe by `event_id`
(a `ReplacingMergeTree` keyed on it); the component never claims exactly-once delivery.

## State machine

```
enqueue ──▶ pending ──(Workpool action)──▶ delivering ──▶ delivered
                ▲                              │
                │ transient failure (Workpool retry)   │ terminal failure / retries exhausted
                └──────────────────────────────┴──▶ failed ──(replayFailed)──▶ pending
paused destination: actions defer and events stay pending; 401/403 or an invalid host pauses it
stuck: delivering older than a threshold ──(requeueStuck)──▶ pending
```

States live on the `events` row (`pending | delivering | delivered | failed`); destination-wide
state (`paused`, last error, last operator action) lives on the single `settings` row.

## Transaction boundaries

| Boundary                                                              | Runs in                                                                   | Commits with                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `enqueue`                                                             | the host's mutation (component mutation called through `ctx.runMutation`) | the host's writes                      |
| `deliverEvent`                                                        | a Workpool action (default runtime, raw `fetch`)                          | nothing: actions are not transactional |
| `markDelivering` / `markDelivered` / `markFailed`                     | component mutations called by the action                                  | themselves only                        |
| operator mutations (`pause`, `resume`, `replayFailed`, `replayEvent`) | host-authorized wrappers                                                  | themselves only                        |

A crash between `markDelivering` and the acknowledgement leaves a `delivering` row, and **nothing
recovers it today**. The row is stranded: it is not `pending`, so `resume` will not see it, and it
is not `failed`, so replay will not either. Recovering it is the job of `requeueStuck`, which does
not exist yet — until it does, the component is at-most-once for that specific window rather than
at-least-once. `cleanup` does not exist yet either. Neither is referenced anywhere in `src/`.

## Identity, duplicates and the replay horizon

Identity is `(datasource, eventId)`, unique per mounted instance through the `by_identity`
index. The payload is canonicalised (sorted keys, no whitespace) before it is stored or compared.
Same identity and equal canonical payload → `duplicate`, the existing row is returned; different
payload → `identity_conflict`. There is no separate receipt table: the event row is the receipt.

`cleanup` deletes `delivered` rows after their retention (default 7 days) and `failed` rows after
a longer one (default 30 days); it never deletes `pending` or `delivering` rows. After a delivered
row is gone the same identity is accepted again, so **the dedupe window equals the delivered
retention window**. Replaying dead letters keeps the original identity and payload.

## Configuration and credentials

`TINYBIRD_TOKEN` and `TINYBIRD_HOST` are declared on `defineComponent` and supplied by the host in
`app.use(tinybird, { env })`. Component code reads them only through the generated `env` export.
They are never stored, returned or logged. Without a token the component is _unconfigured_:
enqueue still stores events, nothing is scheduled and no request leaves the deployment.
Per-instance behaviour (payload bound, request timeout, retry policy) is configured on the
`TinybirdDelivery` client and validated eagerly; unknown option keys are rejected.

Named instances are separate mounts (`app.use(tinybird, { name })`), each with its own tables, so
instance isolation needs no code.

## Retries and dead letters

A response is one of three things: delivered, terminally failed, or worth another attempt.
Terminal means the row will never be accepted as it stands (`400`, `404`, `413`, `422`, or rows
Tinybird quarantined); those never retry. Everything else retries, including an accepted status
whose row counts cannot be read, because that is the only reading that neither loses the event
nor dead-letters one that actually arrived.

Each failed attempt is recorded and the event returns to `pending`, so the next attempt can claim
it. When the budget runs out the pool reports the failure and the event becomes a dead letter with
category `exhausted`. Because `exhausted` says only that the attempts finished, each event keeps a
bounded history of its earlier failures; that is where the actual reason lives.

Defaults are eight attempts with exponential backoff from one second, roughly four minutes before
an event dead-letters. A host can override them per instance on the client or per call at enqueue,
and both are validated against the same bounds.

**`Retry-After` is deliberately not implemented.** Tinybird sends it on `429`, and honouring it
would mean scheduling the next attempt ourselves, which is exactly the ownership the nested pool
holds. The pool's backoff is used instead. This is a real limitation: under a sustained rate limit
the backoff may be shorter than the server asked for. Revisit it if rate limiting is observed in
practice rather than in theory.

## Health, and what "bounded" means

`health` counts unfinished work per state through `by_state_createdAt`, stopping at `COUNT_CAP`,
and reads one further row for the oldest waiting event. That bounds the number of **documents**.

It bounds the **bytes** as well, but only since FTD-2525. Convex returns whole documents, so
while the payload lived on the event row the cost of a capped read was `rows x event size`
rather than `rows`: at the component's default 64 KiB payload bound a `health` call failed at
roughly 130 unfinished events, and at the 512 KiB hard cap at about 16 — the query whose whole
purpose was to stay cheap, failing outright on exactly the backlog it exists to report. The
payload now lives in `payloads`, keyed by event and read only when delivering and when
comparing a duplicate, so an event row is about 2 KB whatever the event carries and the row
cap is once again the thing that binds.

That makes the cap reachable for the first time, and it is now the next thing to bind. `health`
counts three states, so a full cap is 3003 documents; a fully decorated row — `eventId` up to
256, `datasource` up to 128, `lastError`, and `previousErrors` holding up to `MAX_ERROR_HISTORY`
more messages of 200 — is about 2.1 KB, which comes to roughly 6.1 MiB of the ~8 MiB budget.
That is not a hypothetical shape: a sustained outage produces exactly a thousand failed rows
each carrying a full history, so the worst case and the alerting case are the same case.
Tracked as FTD-2530. `heartbeat` reads two documents and is unaffected, which is why it is what
a monitor should poll.

That failure was a property of the schema rather than of the query, which is why the fix was a
schema change and not a smaller cap.

`heartbeat` predates that fix and stays. It returns the same fields minus the counts and reads
exactly two documents — the settings row and the oldest waiting event — so `paused` and
`oldestPendingAgeMs`, the two signals worth alerting on, cost one row each whatever else is
true. It was added so those signals stayed reachable on precisely the day the counts failed;
now that they cannot fail that way, it remains the cheapest thing to poll on a schedule, and it
is what a monitor should call rather than `health`.

## Replay

A dead letter keeps its identity and its payload — the payload row is never touched by replay —
so replaying one is not the same as enqueueing
it again: `(datasource, eventId)` is unchanged, which means a later enqueue with matching content
is still a `duplicate` and one with different content is still an `identity_conflict`. Replay
therefore cannot be used to smuggle a changed payload past the identity check.

Attempts reset to zero because the retry budget is being granted afresh. The failure history does
not reset, and the failure that caused the dead letter is pushed onto it, because after a replay
the useful question is why the event died in the first place.

Replay is bounded for the same reason `resume` is, and reports whether more remain. While the
destination is paused, replayed events are stored and not scheduled: the operator ordering is fix
the credential, then resume.

`remaining` answers "are there dead letters right now", not "are there dead letters you have not
seen". The distinction only appears when the cause was not actually fixed: a replayed event that
fails again returns to `failed`, so `remaining` stays true and an unbounded caller loop never
ends. The documented loop is therefore bounded by a pass count rather than by `remaining` alone.

Ordering carries the other half of that. Dead letters are walked by `updatedAt`, so a re-failed
event goes to the back of the range and every dead letter is tried once before any is tried
twice. Ordered by `createdAt` a still-broken destination starves the tail completely: measured at
five dead letters over three replay-and-drain cycles at `limit: 2`, two events had been replayed
three times each and the other three had never been replayed at all. `resume` avoids the same trap
a different way, by using an index that excludes rows which already have work.

Replay walks the `failed` rows oldest first and takes no category filter. Requeuing is what moves
that scan forward — a replayed row leaves the `failed` range, so the next call reads the rows
behind it. A filter applied to the page after the read breaks that: rows that do not match stay
`failed` at the front of the window, everything behind them becomes unreachable, and the call
still reports that nothing remains. Filtering by category correctly means indexing it rather than
filtering a page, which is tracked separately. To replay one specific event, use `replayEvent`.

Replay reads and writes only `events` rows, never `payloads`, so its cost is the row count times
about 2 KB. A host that raises `maxPayloadBytes` no longer has to lower `limit` to compensate:
payload size and batch size are now independent, which is the point of the split.

Ordering by `updatedAt` has millisecond granularity, so rows patched inside one mutation tie and
ties fall back to insertion order. A whole replay-and-drain cycle completing inside a single
millisecond therefore degenerates to the old creation order. That needs a destination failing
faster than the clock ticks, so it is a property worth knowing rather than a defect.

## Storage layout, and the one migration this component does not do

`events` holds identity, state, attempts, timestamps and errors. `payloads` holds the canonical
JSON, one row per event, keyed by it. Enqueue writes both in a single mutation, so they are one
transaction: every validation that can reject an event happens before either insert, and a
rejection therefore leaves neither row.

Only two places read `payloads`: the duplicate comparison in `enqueue`, which needs the canonical
text to tell a duplicate from a conflict, and `loadForDelivery`, which needs it to send. Nothing
else — not `getStatus`, not `health`, not `heartbeat`, not any recorded error — so the payload,
the one field here that can carry customer data, never reaches an operator surface.

**There is no migration for existing data, and that is a decision rather than an omission.** A
deployment that already holds events written before this change has them with the payload on the
`events` row, where nothing now reads it: those events would be stored, counted and reported, and
would fail to deliver, because `loadForDelivery` returns null when the payload row is missing.

The component is pre-release and unpublished — it has no external consumers and its only host is
this repository, whose local deployment carries no events worth keeping. Writing and testing a
backfill for data that does not exist would be work with no way to verify it against a real case.
A deployment that does hold events should drop them before upgrading. If this component is ever
published with existing installs, that changes, and the migration becomes a prerequisite rather
than a note.

## Operator controls are mount-wide

`enqueue` and `getStatus` take a datasource, but `pause`, `resume`, `health` and `replayFailed`
do not. A mount that carries more than one datasource therefore cannot pause, resume, replay or
report on them independently: every operator action applies to all of them.

The shape of the API invites the mistake, because `enqueue` accepts the datasource as a free
parameter and nothing rejects a second one. A host that writes `orders` and `clicks` into one
mount, then fixes a schema break in `clicks` and replays, will also resend every unfixed `orders`
dead letter against its unfixed cause. Mount the component once per datasource until the operator
surface is datasource-scoped, which is FTD-2528.

## Instance isolation

Two mounts of this component in one deployment do not share rows. That is a guarantee of Convex's
component model — each mount gets its own tables — and not something this package implements, so
there is no code here that could break it and no test here that could prove it.

This is written down rather than tested on purpose. `convex-test` registers a single component
instance and cannot model two mounts at all; a test that called the harness twice would be
comparing two unrelated in-memory databases and would pass no matter what this package did. Such a
test would report a green tick for a property it never examined, which is worse than recording the
guarantee here and being explicit about where it comes from.

## Scheduling ownership

- The nested `@convex-dev/workpool` owns delivery retries, backoff and attempt budgets. Nothing
  else in the component calls `ctx.scheduler`.
- The host owns the maintenance cron (`requeueStuck`, then `cleanup`, both bounded) with its own
  cron mechanism. The component ships no cron.
- Tinybird owns aggregation. There are no Convex-side rollups.

## Boundary and the standalone package path

`scripts/check-boundary.mjs` rejects any `@fantastic-dev/*`, `packages/backend`, Better Auth or
package-escaping import under `src/` and any runtime dependency outside `convex` and
`@convex-dev/workpool`. The package is built inside the Fantastic.dev monorepo as a workspace
package and is meant to move to its own repository and npm once the first consumer is verified;
because it never depended on the host, that move is a packaging change, not a migration.
