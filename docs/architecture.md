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

The payload lives in a separate `payloads` table, so it does not contribute to health reads.
`eventId` is limited to **256 UTF-8 bytes** and an oversized ID is rejected with
`invalid_event_id`. Each stored error message is limited to **200 UTF-8 bytes**, including
any truncation ellipsis. Truncation preserves complete Unicode code points. Datasource names
remain limited to 128 ASCII characters by their validation pattern.

`healthcost.test.ts` measures a maximally populated event with the largest ID, six error
messages, the indexed category, and all optional fields. The row now measures **2587 bytes**, whether the bounded
strings contain ASCII or multibyte text. Previously, UTF-16 length checks admitted a 5459-byte
row with CJK text. The measurement uses JSON as a conservative proxy for Convex storage for
this fixture, and pins the row size with a four-byte allowance for creation-time formatting.

Three state counts each read one row past `COUNT_CAP`. Scoped health also reads global settings,
datasource settings, and the oldest waiting event. The worst-case calculation is
`(3 * (cap + 1) + 3) * 2587` bytes against an 8 MiB budget. Targeting roughly 30% of the budget
and rounding down gives **320 rows per state**, or **2.38 MiB, 29.8%**. The test pins this
published percentage separately from the unchanged **35% safety ceiling**.

The fixture includes every optional field, even combinations the state machine cannot produce,
to keep the estimate conservative. A sustained outage can fill the error history on many rows,
so health needs this headroom when the backlog grows. Indexed capped counts also avoid updating
a shared counter on every ingest transition.

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

`replayFailed` accepts an optional failure `category`. With it, the component reads
`by_state_lastErrorCategory_updatedAt`; without it, it reads `by_state_updatedAt`.
Both take one row beyond the batch to answer `remaining` exactly for the selected range.
No category predicate is applied after paging, so unrelated failures cannot hide matching
rows. Every error transition maintains `lastErrorCategory` alongside `lastError`, including
clearing both on replay and setting the recovery category on stuck events.

Existing mounts must run the bounded `migrations:backfillErrorCategories` internal mutation
before filtered replay. It scans bounded identity ranges and mirrors the current error category without
replaying or deleting anything. A filtered call encountering an unindexed failed row throws
`category_index_not_ready`; it does not claim there are no matching failures. Unfiltered
replay remains available during the upgrade. The README gives the cursor loop.

Replay updates event metadata, scoped settings and Workpool records, never `payloads`. Its work
scales with event count, independently of payload size. A host that raises `maxPayloadBytes` no longer has to lower `limit`:
payload size and batch size are now independent, which is the point of the split.

Replay defaults to **50 events** and caps a transaction at **100 Workpool enqueues**, the same
operator work ceiling as `resume`. The default is half that ceiling because replay also resets
attempts and updates error history for each event. This is a practical transaction-work constraint,
not a claim that a hard document or byte limit binds at 100.

A configured anonymous Convex deployment measured 100 replays at 705 document reads, 403 writes,
151 index-range reads and about 143 KB read with small metadata rows. A 200-event batch also
completed within the database limits. Payloads were separate and were not read. The current
[platform limits](https://docs.convex.dev/production/state/limits) are 32,000 documents scanned,
16,000 written, 4,096 index ranges and 16 MiB read per transaction; none justifies the former
20/30 values. The historical claim that document scanning now binds first was unproven.

Contention is the practical concern: in a sequential 50/100/150/200/100/50 local probe with active
Workpool workers, one 100-event call exhausted conflict retries while another succeeded; 150 and
200 also succeeded after longer calls. A separate 200-event call failed on Workpool's workers table.
These observations do not establish a deterministic cutoff or latency guarantee. Keeping the
existing resume work ceiling avoids expanding one operator transaction beyond 100 enqueues, while
50 is the smaller replay default. Hosts should back off and retry transaction conflicts, and may
lower `limit` under load. The ceiling regression queues and delivers 100 events with separate
64 KiB payloads, retaining error history and leaving a sentinel dead letter for the next call.

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

The payload split was introduced during pre-release development without an inline-payload data
migration. The absence of host producers was the rationale recorded at that time, not a statement
about current adoption. Fantastic.dev now has host-owned lifecycle, usage and backfill producers
that call the public client through a feature-gated adapter. Enabling those producers and verifying
delivery are host rollout steps; their presence in the repository does not prove that a deployment
is enabled or drained.

The current schema stores canonical bodies in `payloads`; it does not accept the former inline
`events.payload` field or move old bodies automatically. An installation with pre-split rows needs
a separately designed migration, verified with representative existing rows in an isolated preview
deployment before upgrading. That verification must cover preservation of event identities,
payloads and delivery state. Do not rely on a schema push, receipt cleanup or domain-event backfill
to migrate the component's stored rows. No such migration is supplied or claimed here.

For fresh installs and ordinary version upgrades, follow [Verify and upgrade](adoption.md#verify-and-upgrade).
The component remains independent of the host's domain tables and producers.

The `payload_missing` dead letter detects an event whose separate payload row is absent. It is
a consistency guard, not a migration mechanism. Retention deletes the event and its payload
together; dropping events is not an upgrade procedure.

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

## Datasource-scoped operator controls

`pause`, `resume`, `health`, and `replayFailed` accept an optional `datasource`. Reads use
datasource-prefixed indexes, including the combined category index, before limiting a batch.
Omitting the argument retains mount-wide controls.

`datasourceSettings` indexes each stream's pause, delivery and operator state. `settings` keeps
mount-wide state. Scheduling and delivery check both. Global pauses override scoped resumes;
credential failures remain global.

Global resume clears all pauses by incrementing a generation on the singleton. Scoped pause
records that generation; scoped resume clears only its own flag. This avoids an unbounded
settings update or paused rows blocking a resume batch. Use scoped resume to preserve other pauses.

Scoped health reports counts, lag, delivery metadata and effective pause state. Metadata costs
three reads; heartbeat costs two. No settings migration is needed. Scoped delivery metadata
starts with new activity; backlog is available immediately. Credentials and retention remain per mount.

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

`scripts/check-boundary.mjs` rejects any host workspace import, `packages/backend`, Better Auth or
package-escaping import under `src/` and any runtime dependency outside `convex` and
`@convex-dev/workpool`. The package was built inside the Fantastic.dev monorepo as a workspace
package and moved to its own repository, `FantasticDevHQ/convex-tinybird`, once the first consumer
was verified; because it never depended on the host, that move was a packaging change, not a
migration.
