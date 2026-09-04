# Architecture

The design in prose. The Linear project document "Architecture and conventions" is the planning
source; this file is what ships with the package and must stay true to the code next to it.

## What the component does

A host mutation calls `enqueue` with a datasource name, an event identity and a JSON payload. The
event row is written in the same Convex transaction as the host's own writes, so the two commit
or roll back together. Delivery to the Tinybird Events API happens afterwards, asynchronously,
through a nested Workpool, at least once. Tinybird is expected to dedupe by `event_id`
(a `ReplacingMergeTree` keyed on it); the component never claims exactly-once delivery.

## Rows that stop moving, and why at-least-once follows from it

The state machine has **no timer of its own**. Every transition out of `delivering` is driven by
the Workpool item running that delivery, so a process that dies mid-flight leaves the row
`delivering` with nothing watching it. It counts as unfinished in `health` for ever, and the
backlog it contributes to never drains. `requeueStuck` is the only thing that looks.

There are two ways a row strands, and only one of them is visible to the surfaces that already
existed:

**`delivering`, older than the threshold.** A crash between `markDelivering` and acknowledgement.
Found by `by_state_updatedAt`, the same index retention uses.

**`pending`, older than the threshold, still carrying a `workId`.** The row was released for
retry and its Workpool item was then cancelled, or completed without calling back. `resume`
cannot see it: that query is `by_state_workId_createdAt` filtered to `workId === undefined`,
because an index lookup is the only shape that cannot be crowded out by rows it should skip. So
the row looks healthy in `getStatus`, counts as unfinished in `health`, and drains never.
`requeueStuck` finds it with the mirror of that query — `gt("workId", undefined)` — and clears
the pointer so `resume` can reach it too.

**What separates a stranded row from a slow one is the Workpool item, not the clock.**
`statusBatch` reports `finished` for an item that completed, was cancelled, or died with its
process; anything else means the work is still coming and the row must be left alone. Age only
decides which rows are worth asking about.

Using age as the criterion is the obvious design and it is wrong twice over. `markAttemptFailed`
sets `pending` and keeps `workId` without refreshing `updatedAt`, so a row waiting out retry
backoff looks identical to a stranded one — and a legal retry policy waits 64 minutes before its
fourth attempt, six times any sensible threshold. Separately, `maxParallelism` is 4, so a backlog
of a few hundred events puts the tail past any threshold while every item is queued and healthy.
In both cases requeueing hands the event a second work item and therefore a second retry budget,
sends it twice, and — in the backlog case — lengthens the queue it was trying to drain.

**This is where at-least-once is paid for.** An event Tinybird accepted whose acknowledgement
never reached us is _indistinguishable_ from one that was never sent — the row looks identical
in both cases. So it is sent again, and deduplication is Tinybird's, on `event_id`. The
alternative is to assume an unacknowledged send succeeded, which is at-most-once and loses
events rather than duplicating them. Losing analytics events silently is worse than counting one
twice, so the choice is deliberate; it is stated here because it is the kind of thing a reader
otherwise discovers from a duplicate row in production.

## What the test suite cannot tell you

`convex-test` runs the component's code as plain JavaScript. It does not know the code is a
component, so it cannot enforce anything the backend restricts to non-root components — and it
has now certified two things the real backend refuses.

`.paginate()` is the sharp one. It is only supported in the app; inside a component the backend
bails with `PaginationUnsupportedInComponents`
(`crates/isolate/src/environment/udf/async_syscall.rs:1773`). A revision of
`reclaimOrphanedPayloads` used it and was dead on every call in production while 228 tests
passed, because the harness implements `paginate` in plain JavaScript with no component check.
The orphan scan pages with a manual cursor over `_creationTime` instead; `by_creation_time` is
built in on every table, so this costs no schema change.

The same shape caught the stale-payload guard, which matched an error message the harness
produces and the backend does not.

**The dangerous class is RUNTIME restrictions, because push-time ones report themselves.**
Components have at least two restrictions beyond ordinary Convex code. "Node actions are not
supported in components" (`crates/application/src/deploy_config.rs:1183`) is a _deploy-time_
bail: `convex dev --once` refuses the push and you find out in seconds. `paginate` pushes
cleanly and throws on the call — which is precisely why it survived four heads of review. When
auditing for this class, the question is not "what do components forbid" but "what do they
forbid _at call time_".

A related trap, from the same review and worth the same prominence: **a test whose comment
explains why it is weak is more dangerous than one that is obviously weak.** A guard was added
with a note reasoning that a discriminating fixture would cost 24 MB and was therefore not worth
building. The reasoning was wrong — the discriminating variable was free — but the comment
converted an unexamined assumption into what read as a considered decision, so the next reader
audited the argument instead of the assertion. If you catch yourself explaining in a comment why
a test cannot check something, that is the moment to check whether it actually cannot.

The rule that follows: **for anything touching a Convex API surface, a green suite is not
evidence that the code runs.** Push the component to a real deployment and call the function.
From a provisioned worktree that is about a minute:

```bash
cd packages/backend && CONVEX_AGENT_MODE=anonymous npx convex dev --once
CONVEX_AGENT_MODE=anonymous npx convex run <probe>
```

And make the probe discriminating before trusting it — an empty table returns a clean result
from almost any implementation. The control that settled this one was restoring `.paginate()`
and watching the same call throw.

## State machine

```
enqueue ──▶ pending ──(Workpool action)──▶ delivering ──▶ delivered
                ▲                              │
                │ transient failure (Workpool retry)   │ terminal failure / retries exhausted
                └──────────────────────────────┴──▶ failed ──(replayFailed)──▶ pending
paused destination: actions defer and events stay pending; 401/403 or an invalid host pauses it
  stuck: work item finished, row did not advance ──(requeueStuck)──▶ pending
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

One dead letter is not a delivery failure at all: `payload_missing` means the event has no stored
payload, so no request was ever made and no attempt was spent. It is a storage fault rather than a
destination fault, and replaying it cannot help — delivery will find nothing again.

The remedy is to enqueue the event again. `enqueue` is the only surface that writes `payloads`,
and a component's tables are unreachable from the host, so a re-enqueue rejected as a conflict
would leave the row stuck permanently: selected by replay, never deliverable, never countable
down. Re-enqueueing the same identity when the payload row is absent therefore **restores** it and
returns `repaired`. Whether it also puts the event back to work depends on what the event was
doing: a dead letter is requeued, and so is a `pending` row that nothing had scheduled, but an
event already `delivering` is left alone — it is mid-attempt, and restoring its payload is enough
for that attempt to finish. Requeueing it would give it a second worker, which is the failure the
guard on that branch exists to prevent. The payload cannot be compared, because it is gone;
`payloadBytes` and a
fingerprint of the canonical text survive on the event row and are checked instead, so a repair
with different content is a conflict. The fingerprint is FNV-1a and not cryptographic: it detects
an accidental substitution, such as a host bug that flips a status or swaps an id, and does not
pretend to stop a deliberate one. Byte length alone could not do even that much, because the field
shapes that dominate real payloads are fixed width. An event already `delivered` is a duplicate,
not a repair — there is
nothing to resend.

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
comparing a duplicate, so an event row costs the same whatever the event carries — bounded at
about 5.4 KB by the contract's own caps, and typically far less — and the row
cap is once again the thing that binds.

That made the cap reachable for the first time, and FTD-2530 then sized it from a measured row
rather than an estimated one. `healthcost.test.ts` builds the largest event the contract permits —
`eventId` at 256, `datasource` at 128, `lastError` and a full `previousErrors` of 200-character
messages, every optional field present — and it comes to about 5.4 KB, not the 2.1 KB the estimate
had assumed.

Most of that gap is one thing. Every length cap here counts UTF-16 code units while Convex sizes a
string by its UTF-8 bytes, so the most expensive string a cap admits is not ASCII: a BMP character
outside Latin-1 is one unit and three bytes, the worst ratio available. Filled with ASCII the same
row measures 2458 bytes; filled truthfully it measures 5459. Bounding those strings in bytes would
let the cap rise again, which is FTD-2600.

`health` counts three states and reads one row past the cap in each, so the worst call is
`(3 x (cap + 1) + 2) x 5.4 KB` — the two being `readHeartbeat`'s settings row and oldest waiting
event. At the old cap of 1000 that was 15.5 MiB, **nearly twice the ~8 MiB budget**; at 150 it is
2.37 MiB, 29.6%.

That shape is not hypothetical: a sustained outage produces exactly that many failed rows each
carrying a full history, so the worst case and the case an operator reaches for `health` in are
the same case — which is why the margin is large rather than merely sufficient. `heartbeat` reads
two documents whatever the backlog and is unaffected, which is why it is what a monitor should
poll.

The cap was lowered rather than the mechanism changed. Counting one state per call would make the
host ask three times, moving the cost instead of removing it. Maintained counters would make a
count one document, but every transition would then write to a single row, trading a read bound
for write contention on the ingest path. Lowering the cap costs only precision in an answer that
is already deliberately imprecise.

That failure was a property of the schema, and moving the payload out of the row is what fixed
it. Doing so exposed the cap underneath, which needed a smaller number as well — the two are
successive constraints, not competing explanations.

`heartbeat` predates that fix and stays. It returns the same fields minus the counts and reads
exactly two documents — the settings row and the oldest waiting event — so `paused` and
`oldestPendingAgeMs`, the two signals worth alerting on, cost one row each whatever else is
true. It was added so those signals stayed reachable on precisely the day the counts failed;
now that they cannot fail that way, it remains the cheapest thing to poll on a schedule, and it
is what a monitor should call rather than `health`.

## Replay

A dead letter keeps its identity and its payload — the payload row is never touched by replay —
except for a `payload_missing` dead letter, which by definition has no payload row; repairing that
one is `enqueue`'s job, not replay's —
so replaying one is not the same as enqueueing
it again: `(datasource, eventId)` is unchanged, which means a later enqueue with matching content
is still a `duplicate` and one with different content is still an `identity_conflict`. Replay
therefore cannot be used to smuggle a changed payload past the identity check. Repair is the one
place that check is weaker: with the payload gone there is nothing to compare, so it falls back to
the byte length and fingerprint on the event row, which catch an accidental substitution rather
than a deliberate one.

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
independent of the payload. A host that raises `maxPayloadBytes` no longer has to lower `limit`:
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

**There is no migration for existing data, and that is a decision rather than an omission.** The
component is pre-release and unpublished. Its only host is this repository, and no host code calls
`enqueue` at all — `grep -riIl tinybird packages/backend/convex` returns the mount and generated
types and nothing else — so there is no producer and no deployment that holds an event a backfill
would have to move.

A deployment that somehow did hold events written before the split would most likely fail the
schema push rather than reach delivery: Convex validates existing documents on the first push
after a schema changes, and a document carrying a `payload` field the table no longer declares
does not match. That is the better failure — loud, at deploy time, before anything is lost. It is
stated as a likelihood rather than a measurement: verifying it needs a deployment holding
pre-split rows, and the local one is shared with every other worktree, so probing it there would
disrupt work that has nothing to do with this.

Either way the answer for such a deployment is to drop its events before upgrading. If this
component is ever published with existing installs, that changes, and a migration becomes a
prerequisite rather than a note.

The `payload_missing` dead letter is therefore not justified by migration. It exists because
something can delete one of the two rows without the other, and retention — FTD-2502 — is the
first thing that will delete anything at all.

## Retention

`cleanup` walks `by_state_updatedAt` for `delivered` and then for `failed`, each with its own
cutoff, and deletes a bounded batch spending ONE budget across both — a limit that applied per
state would let `limit: 3` delete six rows, which is not what a caller bounding a transaction
asked for.

The index is on `updatedAt` rather than `createdAt` because retention measures age from when an
event finished. Both `markDelivered` and `markFailed` set it as they move a row into its terminal
state. Creation time would be wrong in the case that matters most: an event that sat `pending`
through a long pause and was delivered a moment ago already has a `createdAt` older than any
retention, so it would be swept on the very next pass — a dedupe window of zero for exactly the
events a producer is most likely to re-emit after noticing the outage. `pending` and `delivering`
are never queried at all, rather than queried and then filtered — which is the difference
between a rule and a comment. A row exactly at the cutoff
is kept: the comparison is `lt`, because deleting on equality would quietly shorten every
retention by one tick.

Each deletion removes the event and its payload row together. The event carries `payloadId` so
the payload can be deleted by id instead of being searched for through `by_event`. That saves
the index lookup and nothing else: `ctx.db.delete(id)` reads the document it deletes and charges
its full size against the call's read limit, which Convex does in `delete_inner` by way of
`get_inner` and `record_read_document(..., doc.size(), ...)`. Earlier revisions of this note
claimed the delete was free and sized the sweep on that, which was wrong by roughly the size of
every payload in the batch.

So the sweep is bounded by **bytes**, not only by rows. Each event records its own
`payloadBytes` at enqueue time, and `sweepExpired` spends a read budget against those real
sizes, stopping early and reporting `remaining: true` when the next row would exceed it. This is
what makes the bound true for any configuration: the payload ceiling is a per-call host option
that `cleanup` never sees, so no fixed row count could be safe at every setting. At the default
64 KiB bound a 200-row batch would read about 13 MiB against a limit near 8, and the byte budget
stops it at roughly 38.

The row limit still applies, and binds first when payloads are small. The first row of a batch
is always deleted whatever it costs, because a sweep that declines to make progress never runs
again; a single row cannot approach the limit.

The index lookup survives only as a fallback for a row whose pointer was never recorded, and it
costs **two** payload reads rather than one: `by_event` returns the document, and the delete then
re-reads it. Every row written before this component gained `payloadId` takes that path, so the
first sweep after deploying it pays double on every row — the run with the largest bill is the
one nobody has rehearsed. The byte budget charges accordingly, per row, from the pointer's
presence rather than from an assumption about which era the data comes from.

**The dedupe window equals the delivered retention.** The delivered row IS the dedupe record, so
removing it makes the same identity a new event. That is a deliberate trade rather than an
oversight: keeping every delivered row forever would make the table grow without bound, and
Tinybird-side dedupe on `event_id` is what covers a producer that re-emits something older than
the window.

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
